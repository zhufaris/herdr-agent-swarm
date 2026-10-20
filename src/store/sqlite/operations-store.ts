import type { DatabaseSync } from "node:sqlite";
import type { AttachmentState, SessionLifecycle } from "../../domain/pane-thread-lifecycle.js";
import type { ProjectionGapStage } from "../../domain/projection-gap.js";
import type { BindingState, DeliveryFailureClass, OperationalSummary, OutboundReply, OutboundReplyState, OutboxLaneClass, RetiredPaneCleanupState, SemanticDeliveryRolloutBlocker, SemanticDeliveryRolloutSummary, SessionOperationState, SqliteIntegrityInspection } from "../../domain/types.js";
import type { SubmissionIntentState } from "../../domain/submission-intent.js";
import { inspectSqliteIntegrity } from "../sqlite-integrity.js";
import { SqliteLarkDeliveryCooldownStore } from "./lark-delivery-cooldown-store.js";
import type { RecoveryDurableEvidence, RecoveryStage } from "../../domain/recovery.js";
import { unrepresentedPrimaryAnswerProjectionDebtSql } from "./primary-answer-recovery-sql.js";
import { nonterminalReplySql } from "./prepared-delivery-store.js";

export interface SqliteOperationsStoreContext {
  readonly database: DatabaseSync;
  transaction<T>(label: string, operation: () => T): T;
}

export const deliveryRingHeadEligibleSql = (row: string) => `${row}.scope_key IS NOT NULL
  AND ${row}.gateway_plan_json IS NOT NULL AND ${row}.gateway_plan_hash IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM outbound_replies older INDEXED BY outbound_replies_scope_nonterminal_order
    WHERE older.scope_key=${row}.scope_key AND older.state IN ('pending','dead_letter')
      AND older.delivery_order<${row}.delivery_order
      AND ${nonterminalReplySql("older")}
  )
  AND NOT EXISTS (
    SELECT 1 FROM outbox_lane_quarantines quarantine
    JOIN outbound_replies failed ON failed.id=quarantine.failed_reply_id
    WHERE quarantine.state='active' AND failed.scope_key=${row}.scope_key
  )
  AND NOT EXISTS (
    SELECT 1 FROM outbound_reply_prerequisites prerequisite
    LEFT JOIN outbound_replies required ON required.id=prerequisite.prerequisite_reply_id
    WHERE prerequisite.dependent_reply_id=${row}.id
      AND (required.id IS NULL OR required.state!=prerequisite.required_state)
  )`;

export class SqliteOperationsStore {
  constructor(private readonly context: SqliteOperationsStoreContext) {}

  probeReadiness(): void {
    this.context.database.prepare("SELECT 1").get();
  }

  inspectIntegrity(limit: number): SqliteIntegrityInspection {
    return inspectSqliteIntegrity(this.context.database, limit);
  }

  getRecoveryDurableEvidence(): RecoveryDurableEvidence {
    const observedAt = now();
    const execution = this.context.database.prepare(`SELECT
      SUM(CASE WHEN state = 'recovering' THEN 1 ELSE 0 END) AS observing_execution,
      SUM(CASE WHEN state = 'uncertain' THEN 1 ELSE 0 END) AS uncertain_execution,
      MIN(CASE WHEN state IN ('recovering','uncertain') THEN updated_at END) AS oldest_pending_at
      FROM prompt_jobs`).get() as { observing_execution: number | null; uncertain_execution: number | null; oldest_pending_at: string | null };
    const delivery = this.context.database.prepare(`SELECT
      SUM(CASE WHEN recovery.state = 'unresolved' AND recovery.action IN ('rebuild_answer','expired_view_target','rebuild_worker_task','create_recovery_conversation') THEN 1 ELSE 0 END) AS rebuilding_projection,
      SUM(CASE WHEN recovery.state = 'replacement_pending' AND replacement.state = 'pending' AND replacement.claim_attempt_id IS NULL THEN 1 ELSE 0 END) AS delivering,
      SUM(CASE WHEN recovery.state = 'replacement_pending' AND replacement.state = 'pending' AND replacement.claim_attempt_id IS NOT NULL THEN 1 ELSE 0 END) AS awaiting_ack,
      SUM(CASE WHEN recovery.state = 'recovered' THEN 1 ELSE 0 END) AS recovered,
      SUM(CASE WHEN recovery.state = 'unresolved' AND recovery.action IN ('blocked','refuse_recovery_conversation') THEN 1 ELSE 0 END) AS needs_human,
      MIN(CASE WHEN recovery.state IN ('unresolved','replacement_pending') THEN recovery.updated_at END) AS oldest_pending_at
      FROM delivery_recoveries recovery
      LEFT JOIN outbound_replies replacement ON replacement.id = recovery.replacement_reply_id`).get() as {
        rebuilding_projection: number | null; delivering: number | null; awaiting_ack: number | null;
        recovered: number | null; needs_human: number | null; oldest_pending_at: string | null;
      };
    const ordinaryDelivery = this.context.database.prepare(`SELECT
      SUM(CASE WHEN pending.claim_attempt_id IS NULL THEN 1 ELSE 0 END) AS delivering,
      SUM(CASE WHEN pending.claim_attempt_id IS NOT NULL THEN 1 ELSE 0 END) AS awaiting_ack,
      MIN(pending.updated_at) AS oldest_pending_at
      FROM outbound_replies pending
      WHERE pending.state = 'pending'
        AND (pending.card_role = 'answer' OR pending.worker_turn_id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM delivery_recoveries recovery
          WHERE recovery.replacement_reply_id = pending.id
            AND recovery.state IN ('unresolved','replacement_pending')
        )`).get() as { delivering: number | null; awaiting_ack: number | null; oldest_pending_at: string | null };
    const answerProjectionDebt = this.context.database.prepare(`SELECT
      COUNT(*) AS rebuilding_projection, MIN(candidate.updated_at) AS oldest_pending_at
      FROM (
        SELECT card.prompt_id, MIN(card.updated_at) AS updated_at
        ${unrepresentedPrimaryAnswerProjectionDebtSql}
        GROUP BY card.prompt_id
      ) candidate`).get() as { rebuilding_projection: number; oldest_pending_at: string | null };
    const oldestPendingAt = [execution.oldest_pending_at, delivery.oldest_pending_at, ordinaryDelivery.oldest_pending_at, answerProjectionDebt.oldest_pending_at]
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;
    const oldestAge = oldestPendingAt === null ? null : Date.parse(observedAt) - Date.parse(oldestPendingAt);
    const executionItems = this.context.database.prepare(`SELECT
      CASE state WHEN 'recovering' THEN 'detached_prompt' ELSE 'uncertain_prompt' END AS kind,
      CASE state WHEN 'recovering' THEN 'observing_execution' ELSE 'needs_human' END AS stage,
      binding_id, id AS prompt_id, NULL AS worker_id, NULL AS worker_turn_id, updated_at
      FROM prompt_jobs WHERE state IN ('recovering','uncertain')
      ORDER BY updated_at, rowid LIMIT 20`).all() as RecoveryItemRow[];
    const remaining = Math.max(0, 20 - executionItems.length);
    const deliveryItems = remaining === 0 ? [] : this.context.database.prepare(`SELECT
      CASE WHEN failed.worker_turn_id IS NOT NULL THEN 'worker_task' ELSE 'primary_answer' END AS kind,
      CASE
        WHEN recovery.state = 'replacement_pending' AND replacement.state = 'pending' AND replacement.claim_attempt_id IS NOT NULL THEN 'awaiting_ack'
        WHEN recovery.state = 'replacement_pending' THEN 'delivering'
        WHEN recovery.action IN ('blocked','refuse_recovery_conversation') THEN 'needs_human'
        ELSE 'rebuilding_projection'
      END AS stage,
      COALESCE(failed.binding_id, worker.parent_binding_id) AS binding_id,
      failed.prompt_id, COALESCE(failed.worker_id, turn.instance_id) AS worker_id,
      failed.worker_turn_id, recovery.updated_at
      FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      LEFT JOIN instance_turns turn ON turn.id = failed.worker_turn_id
      LEFT JOIN agent_instances worker ON worker.id = COALESCE(failed.worker_id, turn.instance_id)
      LEFT JOIN outbound_replies replacement ON replacement.id = recovery.replacement_reply_id
      WHERE recovery.state IN ('unresolved','replacement_pending')
        AND COALESCE(failed.binding_id, worker.parent_binding_id) IS NOT NULL
      ORDER BY recovery.updated_at, recovery.failed_reply_id LIMIT ?`).all(remaining) as RecoveryItemRow[];
    const answerProjectionRemaining = Math.max(0, remaining - deliveryItems.length);
    const answerProjectionItems = answerProjectionRemaining === 0 ? [] : this.context.database.prepare(`SELECT
      'primary_answer' AS kind, 'rebuilding_projection' AS stage,
      card.binding_id, card.prompt_id, NULL AS worker_id, NULL AS worker_turn_id,
      MIN(card.updated_at) AS updated_at
      ${unrepresentedPrimaryAnswerProjectionDebtSql}
      GROUP BY card.prompt_id, card.binding_id
      ORDER BY MIN(card.updated_at), card.prompt_id LIMIT ?`).all(answerProjectionRemaining) as RecoveryItemRow[];
    const ordinaryRemaining = Math.max(0, answerProjectionRemaining - answerProjectionItems.length);
    const ordinaryDeliveryItems = ordinaryRemaining === 0 ? [] : this.context.database.prepare(`SELECT
      CASE WHEN pending.worker_turn_id IS NOT NULL THEN 'worker_task' ELSE 'primary_answer' END AS kind,
      CASE WHEN pending.claim_attempt_id IS NULL THEN 'delivering' ELSE 'awaiting_ack' END AS stage,
      COALESCE(pending.binding_id, worker.parent_binding_id) AS binding_id,
      pending.prompt_id, COALESCE(pending.worker_id, turn.instance_id) AS worker_id,
      pending.worker_turn_id, pending.updated_at
      FROM outbound_replies pending
      LEFT JOIN instance_turns turn ON turn.id = pending.worker_turn_id
      LEFT JOIN agent_instances worker ON worker.id = COALESCE(pending.worker_id, turn.instance_id)
      WHERE pending.state = 'pending'
        AND (pending.card_role = 'answer' OR pending.worker_turn_id IS NOT NULL)
        AND COALESCE(pending.binding_id, worker.parent_binding_id) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM delivery_recoveries recovery
          WHERE recovery.replacement_reply_id = pending.id
            AND recovery.state IN ('unresolved','replacement_pending')
        )
      ORDER BY pending.updated_at, pending.delivery_order LIMIT ?`).all(ordinaryRemaining) as RecoveryItemRow[];
    return {
      observedAt,
      observingExecution: Number(execution.observing_execution ?? 0),
      uncertainExecution: Number(execution.uncertain_execution ?? 0),
      rebuildingProjection: Number(delivery.rebuilding_projection ?? 0) + Number(answerProjectionDebt.rebuilding_projection ?? 0),
      delivering: Number(delivery.delivering ?? 0) + Number(ordinaryDelivery.delivering ?? 0),
      awaitingAck: Number(delivery.awaiting_ack ?? 0) + Number(ordinaryDelivery.awaiting_ack ?? 0),
      recovered: Number(delivery.recovered ?? 0),
      needsHumanDelivery: Number(delivery.needs_human ?? 0),
      oldestPendingAt,
      oldestPendingAgeSeconds: oldestAge !== null && Number.isFinite(oldestAge) ? Math.max(0, Math.floor(oldestAge / 1_000)) : null,
      items: [...executionItems, ...deliveryItems, ...answerProjectionItems, ...ordinaryDeliveryItems].map((item) => ({
        kind: item.kind, stage: item.stage, bindingId: item.binding_id, promptId: item.prompt_id,
        workerId: item.worker_id, workerTurnId: item.worker_turn_id, updatedAt: item.updated_at
      }))
    };
  }

  getRecoveryStageForBinding(bindingId: string): RecoveryStage | null {
    const row = this.context.database.prepare(`SELECT stage FROM (
      SELECT CASE state WHEN 'recovering' THEN 'observing_execution' ELSE 'needs_human' END AS stage
      FROM prompt_jobs WHERE binding_id = ? AND state IN ('recovering','uncertain')
      UNION ALL
      SELECT CASE
        WHEN recovery.state = 'replacement_pending' AND replacement.state = 'pending' AND replacement.claim_attempt_id IS NOT NULL THEN 'awaiting_ack'
        WHEN recovery.state = 'replacement_pending' THEN 'delivering'
        WHEN recovery.action IN ('blocked','refuse_recovery_conversation') THEN 'needs_human'
        ELSE 'rebuilding_projection'
      END AS stage
      FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      LEFT JOIN instance_turns turn ON turn.id = failed.worker_turn_id
      LEFT JOIN agent_instances worker ON worker.id = COALESCE(failed.worker_id, turn.instance_id)
      LEFT JOIN outbound_replies replacement ON replacement.id = recovery.replacement_reply_id
      WHERE recovery.state IN ('unresolved','replacement_pending')
        AND COALESCE(failed.binding_id, worker.parent_binding_id) = ?
      UNION ALL
      SELECT CASE WHEN pending.claim_attempt_id IS NULL THEN 'delivering' ELSE 'awaiting_ack' END AS stage
      FROM outbound_replies pending
      LEFT JOIN instance_turns pending_turn ON pending_turn.id = pending.worker_turn_id
      LEFT JOIN agent_instances pending_worker ON pending_worker.id = COALESCE(pending.worker_id, pending_turn.instance_id)
      WHERE pending.state = 'pending'
        AND (pending.card_role = 'answer' OR pending.worker_turn_id IS NOT NULL)
        AND COALESCE(pending.binding_id, pending_worker.parent_binding_id) = ?
    ) ORDER BY CASE stage
      WHEN 'observing_execution' THEN 1 WHEN 'needs_human' THEN 2
      WHEN 'rebuilding_projection' THEN 3 WHEN 'delivering' THEN 4
      WHEN 'awaiting_ack' THEN 5 ELSE 6 END
    LIMIT 1`).get(bindingId, bindingId, bindingId) as { stage: RecoveryStage } | undefined;
    return row?.stage ?? null;
  }

  getOperationalSummary(): OperationalSummary {
    const observedAt = now();
    const larkDeliveryCooldown = new SqliteLarkDeliveryCooldownStore(this.context).snapshot(observedAt);
    const groupedCounts = <T extends string>(table: string, column: string, values: readonly T[]): Record<T, number> => {
      const result = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
      const rows = this.context.database.prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all() as Array<{ value: T; count: number }>;
      for (const row of rows) result[row.value] = Number(row.count);
      return result;
    };
    const submissionIntentStates = groupedCounts<SubmissionIntentState>("submission_intents", "state", ["recorded", "attempting", "prepared", "observed", "terminal", "cancelled", "uncertain"]);
    const coreProjection = this.context.database.prepare(`SELECT
      (SELECT COUNT(*) FROM core_event_lane_checkpoints) AS lanes,
      (SELECT COUNT(*) FROM core_event_lane_checkpoints WHERE read_cursor != latest_cursor) AS lagging_lanes,
      SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending_events,
      SUM(CASE WHEN state = 'quarantined' THEN 1 ELSE 0 END) AS quarantined_events,
      MIN(CASE WHEN state = 'pending' THEN created_at END) AS oldest_pending_at
      FROM core_event_lane_items`).get() as { lanes: number; lagging_lanes: number; pending_events: number | null; quarantined_events: number | null; oldest_pending_at: string | null };
    const oldestCorePendingAge = coreProjection.oldest_pending_at === null ? null : Date.parse(observedAt) - Date.parse(coreProjection.oldest_pending_at);
    const inboundStates = groupedCounts<"received" | "processing" | "accepted">("inbound_messages", "state", ["received", "processing", "accepted"]);
    const inboundPending = this.context.database.prepare("SELECT MIN(created_at) AS oldest_pending_at, SUM(CASE WHEN state = 'received' AND error IS NOT NULL THEN 1 ELSE 0 END) AS retryable FROM inbound_messages WHERE state IN ('received', 'processing')").get() as { oldest_pending_at: string | null; retryable: number | null };
    const recentInboundFailure = this.context.database.prepare("SELECT event_id, updated_at, error FROM inbound_messages WHERE error IS NOT NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as { event_id: string; updated_at: string; error: string } | undefined;
    const sessionOperationStates = groupedCounts<SessionOperationState>("session_operations", "state", ["accepted", "running", "succeeded", "rejected", "failed", "uncertain"]);
    const completionReviewStates = groupedCounts<"available" | "provisional" | "presenting" | "active" | "consumed" | "superseded" | "unavailable">(
      "completion_action_sets", "state", ["available", "provisional", "presenting", "active", "consumed", "superseded", "unavailable"]
    );
    const completionReviewPresentations = this.context.database.prepare(`SELECT
      SUM(CASE WHEN reply.state='delivered' THEN 1 ELSE 0 END) AS delivered_awaiting_adoption,
      SUM(CASE WHEN reply.state='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN reply.state='dead_letter' AND reply.effect_certainty='uncertain' THEN 1 ELSE 0 END) AS uncertain
      FROM completion_action_sets action
      LEFT JOIN outbound_replies reply ON reply.id=action.presentation_reply_id
      WHERE action.presentation_kind='fresh-card' AND action.state='presenting'`).get() as {
        delivered_awaiting_adoption: number | null; pending: number | null; uncertain: number | null;
      };
    const oldestAcceptedSessionOperation = this.context.database.prepare("SELECT MIN(created_at) AS value FROM session_operations WHERE state = 'accepted'").get() as { value: string | null };
    const unresolvedDeadLetter = "o.state = 'dead_letter' AND NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery WHERE recovery.failed_reply_id = o.id AND recovery.state IN ('recovered', 'dismissed'))";
    const recentDeadLetter = this.context.database.prepare(`SELECT o.id, o.binding_id, o.prompt_id, o.attempt_count, o.updated_at, o.error FROM outbound_replies o WHERE ${unresolvedDeadLetter} ORDER BY o.updated_at DESC, o.rowid DESC LIMIT 1`).get() as { id: string; binding_id: string | null; prompt_id: string | null; attempt_count: number; updated_at: string; error: string | null } | undefined;
    const oldestPending = this.context.database.prepare("SELECT MIN(created_at) AS value FROM outbound_replies WHERE state = 'pending'").get() as { value: string | null };
    const ringHeadEligible = deliveryRingHeadEligibleSql("candidate");
    const deliveryRingRow = this.context.database.prepare(`SELECT
      COUNT(*) AS pending,
      SUM(CASE WHEN candidate.scope_kind='pane' THEN 1 ELSE 0 END) AS pane_pending,
      SUM(CASE WHEN candidate.scope_kind='global' THEN 1 ELSE 0 END) AS global_pending,
      SUM(length(COALESCE(candidate.gateway_plan_json,''))+length(candidate.idempotency_key)+length(COALESCE(candidate.gateway_plan_hash,''))) AS durable_bytes,
      COUNT(DISTINCT candidate.scope_key) AS scopes,
      COUNT(DISTINCT CASE WHEN candidate.delivery_owner_kind='primary' THEN candidate.scope_key END) AS primary_pane_scopes,
      COUNT(DISTINCT CASE WHEN candidate.delivery_owner_kind='worker' AND candidate.scope_pane_id IS NOT candidate.delivery_parent_pane_id THEN candidate.scope_key END) AS worker_pane_scopes,
      SUM(CASE WHEN candidate.claim_attempt_id IS NULL
        AND candidate.next_attempt_at<=? AND ?=0 AND ${ringHeadEligible} THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN candidate.claim_attempt_id IS NULL AND candidate.next_attempt_at>? THEN 1 ELSE 0 END) AS retry_wait,
      SUM(CASE WHEN candidate.claim_attempt_id IS NOT NULL THEN 1 ELSE 0 END) AS active_claims,
      SUM(CASE WHEN candidate.claim_attempt_id IS NULL
        AND candidate.next_attempt_at<=? THEN 1 ELSE 0 END) AS due_unclaimed,
      MIN(candidate.created_at) AS oldest_pending_at
      FROM outbound_replies candidate
      WHERE candidate.state='pending'`).get(
        observedAt, larkDeliveryCooldown.active ? 1 : 0, observedAt, observedAt
      ) as {
        pending: number | null; pane_pending: number | null; global_pending: number | null; durable_bytes: number | null;
        scopes: number; primary_pane_scopes: number; worker_pane_scopes: number;
        ready: number | null; retry_wait: number | null; active_claims: number | null; due_unclaimed: number | null;
        oldest_pending_at: string | null;
      };
    const legacyWorkerScopeDebt = this.context.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies reply
      WHERE reply.delivery_owner_kind='worker' AND reply.scope_kind='pane'
        AND reply.scope_pane_id=reply.delivery_parent_pane_id
        AND reply.state IN ('pending','dead_letter') AND ${nonterminalReplySql("reply")}`).get() as { count: number };
    const paneTopologyRow = this.context.database.prepare(`SELECT
      SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state='executing' THEN 1 ELSE 0 END) AS executing,
      SUM(CASE WHEN state='uncertain' THEN 1 ELSE 0 END) AS uncertain,
      MIN(CASE WHEN state IN ('pending','executing','uncertain') THEN created_at END) AS oldest_open_at
      FROM pane_topology_intents`).get() as { pending: number | null; executing: number | null; uncertain: number | null; oldest_open_at: string | null };
    const ringOldestAge = deliveryRingRow.oldest_pending_at === null ? null : Date.parse(observedAt) - Date.parse(deliveryRingRow.oldest_pending_at);
    const checkpointDiagnostics = this.context.database.prepare(`SELECT
      (SELECT COUNT(*) FROM delivery_ring_checkpoints) AS initialized_scopes,
      MIN(reply.delivery_order) AS lowest_blocking_order,
      MIN(reply.created_at) AS lowest_blocking_at,
      SUM(CASE WHEN reply.state='dead_letter' AND reply.effect_certainty='uncertain' THEN 1 ELSE 0 END) AS uncertain_blocked,
      SUM(CASE WHEN quarantine.state='active' THEN 1 ELSE 0 END) AS active_quarantine_blocked
      FROM outbound_replies reply
      LEFT JOIN outbox_lane_quarantines quarantine ON quarantine.failed_reply_id=reply.id AND quarantine.state='active'
      WHERE reply.state IN ('pending','dead_letter') AND ${nonterminalReplySql("reply")}`).get() as {
        initialized_scopes: number; lowest_blocking_order: number | null; lowest_blocking_at: string | null;
        uncertain_blocked: number | null; active_quarantine_blocked: number | null;
      };
    const blockingAge = checkpointDiagnostics.lowest_blocking_at === null ? null : Date.parse(observedAt) - Date.parse(checkpointDiagnostics.lowest_blocking_at);
    const boundedDegradation = this.context.database.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN quarantine.state='active' AND quarantine.phase='grace_blocking' THEN failed.scope_key END) AS grace_blocked_scopes,
      SUM(CASE WHEN quarantine.state='active' AND quarantine.phase='conflict_isolated' THEN 1 ELSE 0 END) AS isolated_conflicts,
      SUM(CASE WHEN quarantine.state='active' AND quarantine.phase='conflict_isolated' AND failed.effect_certainty='uncertain' THEN 1 ELSE 0 END) AS isolated_uncertain,
      SUM(CASE WHEN quarantine.state='active' AND quarantine.phase='conflict_isolated'
        AND quarantine.review_requested_at IS NOT NULL AND review.id IS NOT NULL THEN 1 ELSE 0 END) AS pending_human_reviews,
      MIN(CASE WHEN quarantine.state='active' AND quarantine.phase='conflict_isolated'
        AND quarantine.review_requested_at IS NOT NULL AND review.id IS NOT NULL THEN quarantine.review_requested_at END) AS oldest_review_at
      FROM outbox_lane_quarantines quarantine
      JOIN outbound_replies failed ON failed.id=quarantine.failed_reply_id
      LEFT JOIN outbound_replies review ON review.id=quarantine.review_reply_id`).get() as {
        grace_blocked_scopes:number; isolated_conflicts:number|null; isolated_uncertain:number|null;
        pending_human_reviews:number|null; oldest_review_at:string|null;
      };
    const bypassedDeliveries = this.context.database.prepare(`SELECT COUNT(DISTINCT later.id) AS count
      FROM outbox_lane_quarantines quarantine
      JOIN outbound_replies failed ON failed.id=quarantine.failed_reply_id
      JOIN outbound_replies later INDEXED BY outbound_replies_scope_delivery_order
        ON later.scope_key=failed.scope_key AND later.delivery_order>failed.delivery_order
      WHERE quarantine.state='active' AND quarantine.phase='conflict_isolated'
        AND later.state IN ('delivered','dismissed')
        AND NOT EXISTS (
          SELECT 1 FROM outbox_lane_quarantines review_link
          WHERE review_link.review_reply_id=later.id
        )`).get() as { count:number };
    const oldestReviewAge = boundedDegradation.oldest_review_at === null
      ? null : Date.parse(observedAt) - Date.parse(boundedDegradation.oldest_review_at);
    const deliveryRings = {
      pending: Number(deliveryRingRow.pending ?? 0), panePending: Number(deliveryRingRow.pane_pending ?? 0), globalPending: Number(deliveryRingRow.global_pending ?? 0),
      durableBytes: Number(deliveryRingRow.durable_bytes ?? 0), scopes: Number(deliveryRingRow.scopes ?? 0), ready: Number(deliveryRingRow.ready ?? 0),
      primaryPaneScopes: Number(deliveryRingRow.primary_pane_scopes ?? 0), workerPaneScopes: Number(deliveryRingRow.worker_pane_scopes ?? 0),
      legacyWorkerScopeDebt: Number(legacyWorkerScopeDebt.count ?? 0),
      retryWait: Number(deliveryRingRow.retry_wait ?? 0), activeClaims: Number(deliveryRingRow.active_claims ?? 0),
      waitingBehindScope: Math.max(0, Number(deliveryRingRow.due_unclaimed ?? 0) - Number(deliveryRingRow.ready ?? 0)),
      oldestPendingAt: deliveryRingRow.oldest_pending_at,
      oldestPendingAgeSeconds: ringOldestAge !== null && Number.isFinite(ringOldestAge) ? Math.max(0, Math.floor(ringOldestAge / 1_000)) : null,
      initializedCheckpointScopes: Number(checkpointDiagnostics.initialized_scopes),
      lowestBlockingDeliveryOrder: checkpointDiagnostics.lowest_blocking_order === null ? null : Number(checkpointDiagnostics.lowest_blocking_order),
      lowestBlockingAgeSeconds: blockingAge !== null && Number.isFinite(blockingAge) ? Math.max(0, Math.floor(blockingAge / 1_000)) : null,
      uncertainBlocked: Number(checkpointDiagnostics.uncertain_blocked ?? 0),
      activeQuarantineBlocked: Number(checkpointDiagnostics.active_quarantine_blocked ?? 0),
      graceBlockedScopes: Number(boundedDegradation.grace_blocked_scopes ?? 0),
      isolatedConflicts: Number(boundedDegradation.isolated_conflicts ?? 0),
      isolatedUncertain: Number(boundedDegradation.isolated_uncertain ?? 0),
      bypassedDeliveries: Number(bypassedDeliveries.count ?? 0),
      pendingHumanReviews: Number(boundedDegradation.pending_human_reviews ?? 0),
      oldestHumanReviewAgeSeconds: oldestReviewAge !== null && Number.isFinite(oldestReviewAge)
        ? Math.max(0, Math.floor(oldestReviewAge / 1_000)) : null
    };
    const outbound = groupedCounts<OutboundReplyState>("outbound_replies", "state", ["pending", "delivered", "dead_letter", "dismissed"]);
    const deadLettersByClass = { transient: 0, permanent: 0, unknown: 0, legacy: 0 };
    const failureRows = this.context.database.prepare("SELECT failure_class, COUNT(*) AS count FROM outbound_replies WHERE state = 'dead_letter' GROUP BY failure_class").all() as Array<{ failure_class: DeliveryFailureClass | null; count: number }>;
    for (const row of failureRows) deadLettersByClass[row.failure_class ?? "legacy"] = Number(row.count);
    const unresolvedDeadLettersByClass = { transient: 0, permanent: 0, unknown: 0, legacy: 0 };
    const unresolvedFailureRows = this.context.database.prepare(`SELECT o.failure_class, COUNT(*) AS count FROM outbound_replies o WHERE ${unresolvedDeadLetter} GROUP BY o.failure_class`).all() as Array<{ failure_class: DeliveryFailureClass | null; count: number }>;
    for (const row of unresolvedFailureRows) unresolvedDeadLettersByClass[row.failure_class ?? "legacy"] = Number(row.count);
    const unresolvedDeadLetters = unresolvedFailureRows.reduce((total, row) => total + Number(row.count), 0);
    const eligibleRecoveries = this.context.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies reply
      WHERE state = 'dead_letter' AND failure_class = 'transient' AND COALESCE(effect_certainty, 'uncertain') != 'uncertain'
        AND auto_recovery_count = 0 AND dead_lettered_at IS NOT NULL AND dead_lettered_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM delivery_debt_classifications classified
          JOIN delivery_recoveries recovery ON recovery.failed_reply_id = reply.id
          WHERE classified.debt_kind = 'delivery_recovery' AND classified.debt_id = reply.id
            AND classified.scope = 'historical' AND classified.source_updated_at >= recovery.updated_at
        )`).get(new Date(Date.parse(observedAt) - 300_000).toISOString()) as { count: number };
    const uncertainDeliveryEffects = this.context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE state = 'dead_letter' AND effect_certainty = 'uncertain'").get() as { count: number };
    const projectionRecovery = this.context.database.prepare(`
      SELECT
        SUM(CASE WHEN recovery.state IN ('unresolved','replacement_pending') THEN 1 ELSE 0 END) AS backlog,
        SUM(CASE WHEN recovery.state = 'unresolved' AND recovery.action IN ('rebuild_answer','expired_view_target','rebuild_worker_task') THEN 1 ELSE 0 END) AS eligible,
        SUM(CASE WHEN recovery.state = 'replacement_pending' THEN 1 ELSE 0 END) AS awaiting_ack,
        SUM(CASE WHEN recovery.state = 'recovered' THEN 1 ELSE 0 END) AS recovered,
        SUM(CASE WHEN recovery.action = 'refuse_recovery_conversation' THEN 1 ELSE 0 END) AS exhausted,
        SUM(CASE WHEN recovery.state IN ('unresolved','replacement_pending') AND failed.prompt_id IS NOT NULL AND failed.card_role = 'answer' THEN 1 ELSE 0 END) AS primary_answer,
        SUM(CASE WHEN recovery.state IN ('unresolved','replacement_pending') AND failed.worker_turn_id IS NOT NULL THEN 1 ELSE 0 END) AS worker_task,
        MIN(CASE WHEN recovery.state = 'unresolved' AND recovery.action IN ('rebuild_answer','expired_view_target','rebuild_worker_task') THEN recovery.updated_at END) AS oldest_eligible_at
      FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      WHERE (failed.prompt_id IS NOT NULL AND failed.card_role = 'answer' OR failed.worker_turn_id IS NOT NULL)
        AND recovery.action IN ('rebuild_answer','expired_view_target','rebuild_worker_task','create_recovery_conversation','refuse_recovery_conversation')
    `).get() as { backlog: number | null; eligible: number | null; awaiting_ack: number | null; recovered: number | null; exhausted: number | null; primary_answer: number | null; worker_task: number | null; oldest_eligible_at: string | null };
    const oldestProjectionRecoveryAge = projectionRecovery.oldest_eligible_at === null ? null : Date.parse(observedAt) - Date.parse(projectionRecovery.oldest_eligible_at);
    const unifiedTurnCardRecovery = this.context.database.prepare(`WITH latest AS (
      SELECT s.id AS segment_id, s.state AS segment_state, s.view_version, p.page_index, p.state AS page_state,
        p.pending_reply_id, p.sequence, p.delivered_cursor_json,
        ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY
          CASE WHEN p.state IN ('creating','active') THEN 1 ELSE 0 END DESC, p.page_index DESC) AS rank
      FROM conversation_segments s JOIN conversation_segment_pages p ON p.segment_id = s.id
    ) SELECT COUNT(*) AS count FROM latest l WHERE l.rank = 1 AND (
      l.pending_reply_id IS NOT NULL OR l.page_state = 'creating' OR
      (l.page_state = 'active' AND (
        l.view_version > l.sequence OR
        (SELECT COUNT(*) FROM conversation_segment_items i WHERE i.segment_id = l.segment_id) > COALESCE(json_extract(l.delivered_cursor_json, '$.itemIndex'), 0) OR
        l.segment_state IN ('completed','failed','cancelled','needs_human','closed')
      )) OR
      (l.page_state = 'frozen' AND (l.view_version > l.sequence OR
        (SELECT COUNT(*) FROM conversation_segment_items i WHERE i.segment_id = l.segment_id) > COALESCE(json_extract(l.delivered_cursor_json, '$.itemIndex'), 0)))
    )`).get() as { count: number };
    const turnCardLifecycle = this.context.database.prepare(`SELECT
      SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state = 'working' THEN 1 ELSE 0 END) AS working,
      SUM(CASE WHEN state IN ('completed','failed','cancelled','closed') THEN 1 ELSE 0 END) AS terminal,
      SUM(CASE WHEN state = 'needs_human' THEN 1 ELSE 0 END) AS needs_human
      FROM conversation_segments`).get() as { pending: number|null; working: number|null; terminal: number|null; needs_human: number|null };
    const turnCardPages = this.context.database.prepare(`SELECT
      SUM(CASE WHEN p.state = 'creating' THEN 1 ELSE 0 END) AS awaiting_create,
      SUM(CASE WHEN p.state = 'active' AND NOT EXISTS (SELECT 1 FROM conversation_segment_pages newer WHERE newer.segment_id=p.segment_id AND newer.state IN ('creating','active') AND newer.page_index > p.page_index) AND (
        p.pending_reply_id IS NOT NULL OR s.view_version > p.sequence OR
        (SELECT COUNT(*) FROM conversation_segment_items i WHERE i.segment_id=p.segment_id) > COALESCE(json_extract(p.delivered_cursor_json, '$.itemIndex'), 0)
      ) THEN 1 ELSE 0 END) AS awaiting_update,
      0 AS quarantined
      FROM conversation_segment_pages p JOIN conversation_segments s ON s.id = p.segment_id
      LEFT JOIN outbound_replies o ON o.id = p.pending_reply_id`).get() as { awaiting_create: number|null; awaiting_update: number|null; quarantined: number|null };
    const quarantinedTurnCards = this.context.database.prepare(`SELECT COUNT(DISTINCT q.lane_key) AS count FROM outbox_lane_quarantines q JOIN conversation_segment_pages p ON q.lane_key = 'turn-card:' || p.segment_id || ':page:' || p.page_index WHERE q.state='active'`).get() as { count: number };
    const quarantineStates = groupedCounts<"active" | "released">("outbox_lane_quarantines", "state", ["active", "released"]);
    const quarantineScope = this.context.database.prepare(`SELECT
      SUM(CASE WHEN classified.debt_id IS NULL THEN 1 ELSE 0 END) AS current,
      SUM(CASE WHEN classified.debt_id IS NOT NULL THEN 1 ELSE 0 END) AS historical
      FROM outbox_lane_quarantines quarantine
      JOIN delivery_recoveries recovery ON recovery.failed_reply_id = quarantine.failed_reply_id
      LEFT JOIN delivery_debt_classifications classified
        ON classified.debt_kind = 'delivery_recovery' AND classified.debt_id = recovery.failed_reply_id
          AND classified.scope = 'historical' AND classified.source_updated_at >= recovery.updated_at
          AND classified.source_updated_at >= quarantine.updated_at
      WHERE quarantine.state = 'active'`) .get() as { current: number | null; historical: number | null };
    const quarantinesByLaneClass = groupedCounts<OutboxLaneClass>("outbox_lane_quarantines", "lane_class", ["answer_stream", "main_card", "replaceable_card", "immutable"]);
    const quarantinesByFailureClass = groupedCounts<DeliveryFailureClass>("outbox_lane_quarantines", "failure_class", ["transient", "permanent", "unknown"]);
    const latestQuarantine = this.context.database.prepare(`SELECT q.failed_reply_id, o.kind AS reply_kind, q.lane_class, q.failure_class, q.action, q.reason, q.created_at, q.released_at
      FROM outbox_lane_quarantines q JOIN outbound_replies o ON o.id = q.failed_reply_id ORDER BY q.updated_at DESC LIMIT 1`).get() as { failed_reply_id: string; reply_kind: OutboundReply["kind"]; lane_class: OutboxLaneClass; failure_class: DeliveryFailureClass; action: string; reason: string; created_at: string; released_at: string | null } | undefined;
    const projectionGapStates = groupedCounts<"open" | "compensated">("projection_gaps", "state", ["open", "compensated"]);
    const projectionGapDebtScope = this.context.database.prepare(`SELECT
      SUM(CASE WHEN classified.debt_id IS NULL THEN 1 ELSE 0 END) AS current,
      SUM(CASE WHEN classified.debt_id IS NOT NULL THEN 1 ELSE 0 END) AS historical
      FROM projection_gaps gap LEFT JOIN delivery_debt_classifications classified
        ON classified.debt_kind = 'projection_gap' AND classified.debt_id = CAST(gap.id AS TEXT)
          AND classified.scope = 'historical' AND classified.source_updated_at >= gap.last_failed_at
      WHERE gap.state = 'open'`).get() as { current: number | null; historical: number | null };
    const projectionGapsByStage = { core_projection: 0, answer_delivery: 0, main_delivery: 0, worker_delivery: 0, turn_recovery: 0 } satisfies Record<ProjectionGapStage, number>;
    const projectionGapStageRows = this.context.database.prepare("SELECT stage, COUNT(*) AS count FROM projection_gaps WHERE state = 'open' GROUP BY stage").all() as Array<{ stage: ProjectionGapStage; count: number }>;
    for (const row of projectionGapStageRows) projectionGapsByStage[row.stage] = Number(row.count);
    const projectionGapScope = this.context.database.prepare("SELECT COUNT(DISTINCT owner_kind || ':' || owner_id) AS affected_owners, MIN(first_failed_at) AS oldest_open_at FROM projection_gaps WHERE state = 'open'").get() as { affected_owners: number; oldest_open_at: string | null };
    const turnRecoveryStates = groupedCounts<"waiting" | "indexing" | "not_found" | "ambiguous" | "transient">("external_turn_recovery_attempts", "recovery_state", ["waiting", "indexing", "not_found", "ambiguous", "transient"]);
    const turnRecoveryScope = this.context.database.prepare("SELECT COUNT(*) AS pending, SUM(CASE WHEN next_attempt_at <= ? THEN 1 ELSE 0 END) AS due, MIN(last_attempt_at) AS oldest_attempt_at FROM external_turn_recovery_attempts").get(observedAt) as { pending: number; due: number | null; oldest_attempt_at: string | null };
    const latestTurnRecovery = this.context.database.prepare("SELECT failure_code, attempt_count, last_attempt_at, next_attempt_at FROM external_turn_recovery_attempts ORDER BY last_attempt_at DESC, prompt_id LIMIT 1").get() as { failure_code: string; attempt_count: number; last_attempt_at: string; next_attempt_at: string } | undefined;
    const oldestInactive = this.context.database.prepare("SELECT MIN(last_activity_at) AS value FROM bindings WHERE lifecycle != 'active' OR attachment != 'attached'").get() as { value: string | null };
    const recoverableProvisioning = this.context.database.prepare("SELECT COUNT(*) AS count FROM project_selections WHERE state = 'processing' AND binding_id IS NOT NULL").get() as { count: number };
    const archivedPanesPresent = this.context.database.prepare("SELECT COUNT(*) AS count FROM bindings WHERE lifecycle = 'archived' AND pane_id IS NOT NULL").get() as { count: number };
    const cleanupCandidates = this.context.database.prepare("SELECT COUNT(*) AS count FROM bindings WHERE lifecycle = 'archived' AND pane_id IS NOT NULL AND archived_at <= datetime('now', '-30 days')").get() as { count: number };
    const oldestActiveCleanup = this.context.database.prepare("SELECT MIN(created_at) AS value FROM retired_pane_cleanup_operations WHERE state IN ('pending','waiting_busy','executing')").get() as { value: string | null };
    const latestCleanup = this.context.database.prepare("SELECT id, state, updated_at, detail FROM retired_pane_cleanup_operations ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as { id: string; state: RetiredPaneCleanupState; updated_at: string; detail: string | null } | undefined;
    const retentionCompactionSources = (this.context.database.prepare(`SELECT source_kind,cycle_state,high_water_key_json,
      after_key_json,compacted_count,refusal_counts_json,updated_at FROM retention_compaction_cursors ORDER BY source_kind`).all() as Array<{
        source_kind:"core_event"|"conversation_segment_item"|"answer_timeline_item"|"delivery";
        cycle_state:"scanning"|"complete"; high_water_key_json:string; after_key_json:string|null;
        compacted_count:number; refusal_counts_json:string; updated_at:string;
      }>).map((row) => ({
        source: row.source_kind, cycleState: row.cycle_state,
        highWater: JSON.parse(row.high_water_key_json) as Record<string, unknown>,
        after: row.after_key_json === null ? null : JSON.parse(row.after_key_json) as Record<string, unknown>,
        compacted: Number(row.compacted_count), refusals: JSON.parse(row.refusal_counts_json) as Record<string, number>,
        updatedAt: row.updated_at
      }));
    const coreEventSkeletons = this.context.database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state='verified' THEN 1 ELSE 0 END),0) AS verified,
      COALESCE(SUM(CASE WHEN state='compacted' THEN 1 ELSE 0 END),0) AS compacted,
      COALESCE(SUM(CASE WHEN state='verified' THEN payload_bytes ELSE 0 END),0) AS retained_payload_bytes
      FROM audit_skeletons WHERE source_kind='core_event'`).get() as { verified:number; compacted:number; retained_payload_bytes:number };
    const coreEventCursor = retentionCompactionSources.find((source) => source.source === "core_event");
    const coreEventCursorMode = coreEventCursor?.highWater.mode === "audit" ? "audit"
      : coreEventCursor?.highWater.mode === "compact" ? "compact" : null;
    return {
      semanticDeliveryRollout: this.getSemanticDeliveryRolloutSummary(),
      bindings: groupedCounts<BindingState>("bindings", "state", ["pending", "active", "archived", "orphaned", "failed"]),
      submissionIntents: {
        states: submissionIntentStates,
        awaitingReceipt: submissionIntentStates.recorded + submissionIntentStates.attempting + submissionIntentStates.uncertain,
        receiptKnown: submissionIntentStates.prepared + submissionIntentStates.observed + submissionIntentStates.terminal + submissionIntentStates.cancelled
      },
      coreProjection: {
        lanes: Number(coreProjection.lanes), laggingLanes: Number(coreProjection.lagging_lanes),
        pendingEvents: Number(coreProjection.pending_events ?? 0), quarantinedEvents: Number(coreProjection.quarantined_events ?? 0),
        oldestPendingAt: coreProjection.oldest_pending_at,
        oldestPendingAgeSeconds: oldestCorePendingAge !== null && Number.isFinite(oldestCorePendingAge) ? Math.max(0, Math.floor(oldestCorePendingAge / 1_000)) : null
      },
      retentionCompaction: {
        totalCompacted: retentionCompactionSources.reduce((total, source) => total + source.compacted, 0),
        coreEvent: {
          cursorMode: coreEventCursorMode,
          verified: Number(coreEventSkeletons.verified), compacted: Number(coreEventSkeletons.compacted),
          retainedBytes: Number(coreEventSkeletons.retained_payload_bytes)
        },
        sources: retentionCompactionSources
      },
      inbound: {
        states: inboundStates, retryable: Number(inboundPending.retryable ?? 0), oldestPendingAt: inboundPending.oldest_pending_at,
        oldestPendingAgeSeconds: inboundPending.oldest_pending_at === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(inboundPending.oldest_pending_at)) / 1_000)),
        recentFailure: recentInboundFailure ? { eventId: recentInboundFailure.event_id, updatedAt: recentInboundFailure.updated_at, error: boundedError(recentInboundFailure.error) } : null
      },
      sessionOperations: {
        states: sessionOperationStates, oldestAcceptedAt: oldestAcceptedSessionOperation.value,
        oldestAcceptedAgeSeconds: oldestAcceptedSessionOperation.value === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(oldestAcceptedSessionOperation.value)) / 1_000))
      },
      workerThreads: groupedCounts("worker_session_threads", "state", ["legacy-unpublished", "reserving", "active", "stale"]),
      completionReviews: {
        legacyInline: completionReviewStates.available,
        provisional: completionReviewStates.provisional,
        presenting: completionReviewStates.presenting,
        active: completionReviewStates.active,
        consumed: completionReviewStates.consumed,
        superseded: completionReviewStates.superseded,
        unavailable: completionReviewStates.unavailable,
        deliveredPresentationsAwaitingAdoption: Number(completionReviewPresentations.delivered_awaiting_adoption ?? 0),
        pendingPresentations: Number(completionReviewPresentations.pending ?? 0),
        uncertainPresentations: Number(completionReviewPresentations.uncertain ?? 0)
      },
      outbound, pendingOutbox: outbound.pending, deadLetters: outbound.dead_letter, deadLettersByClass, unresolvedDeadLetters, unresolvedDeadLettersByClass, uncertainDeliveryEffects: Number(uncertainDeliveryEffects.count), larkDeliveryCooldown, deliveryRings,
      paneTopology: {
        pending: Number(paneTopologyRow.pending ?? 0), executing: Number(paneTopologyRow.executing ?? 0), uncertain: Number(paneTopologyRow.uncertain ?? 0),
        recoverable: Number(paneTopologyRow.pending ?? 0) + Number(paneTopologyRow.executing ?? 0) + Number(paneTopologyRow.uncertain ?? 0),
        oldestOpenAt: paneTopologyRow.oldest_open_at
      },
      eligibleDeadLetterRecoveries: Number(eligibleRecoveries.count), oldestPendingAt: oldestPending.value,
      deliveryRecoveries: groupedCounts("delivery_recoveries", "state", ["unresolved", "replacement_pending", "recovered", "dismissed"]),
      projectionDeliveryRecovery: {
        backlog: Number(projectionRecovery.backlog ?? 0), eligible: Number(projectionRecovery.eligible ?? 0), awaitingAck: Number(projectionRecovery.awaiting_ack ?? 0),
        recovered: Number(projectionRecovery.recovered ?? 0), exhausted: Number(projectionRecovery.exhausted ?? 0),
        byProjection: { primaryAnswer: Number(projectionRecovery.primary_answer ?? 0), workerTask: Number(projectionRecovery.worker_task ?? 0), turnCard: Number(unifiedTurnCardRecovery.count ?? 0) },
        oldestEligibleAt: projectionRecovery.oldest_eligible_at,
        oldestEligibleAgeSeconds: oldestProjectionRecoveryAge !== null && Number.isFinite(oldestProjectionRecoveryAge) ? Math.max(0, Math.floor(oldestProjectionRecoveryAge / 1_000)) : null
      },
      turnCards: {
        pending: Number(turnCardLifecycle.pending ?? 0), working: Number(turnCardLifecycle.working ?? 0),
        terminal: Number(turnCardLifecycle.terminal ?? 0), needsHuman: Number(turnCardLifecycle.needs_human ?? 0),
        pagesAwaitingCreate: Number(turnCardPages.awaiting_create ?? 0), pagesAwaitingUpdate: Number(turnCardPages.awaiting_update ?? 0),
        quarantined: Number(quarantinedTurnCards.count ?? turnCardPages.quarantined ?? 0)
      },
      outboxQuarantines: {
        active: quarantineStates.active, current: Number(quarantineScope.current ?? 0), historical: Number(quarantineScope.historical ?? 0), released: quarantineStates.released, byLaneClass: quarantinesByLaneClass, byFailureClass: quarantinesByFailureClass,
        latest: latestQuarantine ? { replyId: latestQuarantine.failed_reply_id, replyKind: latestQuarantine.reply_kind, laneClass: latestQuarantine.lane_class, failureClass: latestQuarantine.failure_class, action: latestQuarantine.action, reason: boundedError(latestQuarantine.reason), createdAt: latestQuarantine.created_at, releasedAt: latestQuarantine.released_at } : null
      },
      projectionGaps: {
        open: projectionGapStates.open, current: Number(projectionGapDebtScope.current ?? 0), historical: Number(projectionGapDebtScope.historical ?? 0), compensated: projectionGapStates.compensated,
        affectedOwners: Number(projectionGapScope.affected_owners), oldestOpenAt: projectionGapScope.oldest_open_at,
        byStage: projectionGapsByStage
      },
      turnRecovery: {
        pending: Number(turnRecoveryScope.pending), due: Number(turnRecoveryScope.due ?? 0), oldestAttemptAt: turnRecoveryScope.oldest_attempt_at,
        oldestAgeSeconds: turnRecoveryScope.oldest_attempt_at === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(turnRecoveryScope.oldest_attempt_at)) / 1_000)),
        byState: turnRecoveryStates,
        latestFailure: latestTurnRecovery ? { failureCode: boundedError(latestTurnRecovery.failure_code), attemptCount: Number(latestTurnRecovery.attempt_count), lastAttemptAt: latestTurnRecovery.last_attempt_at, nextAttemptAt: latestTurnRecovery.next_attempt_at } : null
      },
      lifecycle: groupedCounts<SessionLifecycle>("bindings", "lifecycle", ["provisioning", "active", "draining", "archived", "closed", "failed"]),
      attachment: groupedCounts<AttachmentState>("bindings", "attachment", ["unattached", "attached", "degraded", "orphaned"]),
      recoverableProvisioning: Number(recoverableProvisioning.count), archivedPanesPresent: Number(archivedPanesPresent.count),
      cleanupCandidates: Number(cleanupCandidates.count), oldestInactiveAt: oldestInactive.value,
      retiredPaneCleanup: {
        states: groupedCounts<RetiredPaneCleanupState>("retired_pane_cleanup_operations", "state", ["pending", "waiting_busy", "executing", "succeeded", "retained"]),
        oldestActiveAt: oldestActiveCleanup.value,
        oldestActiveAgeSeconds: oldestActiveCleanup.value === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(oldestActiveCleanup.value)) / 1_000)),
        latestOutcome: latestCleanup ? { operationId: latestCleanup.id, state: latestCleanup.state, updatedAt: latestCleanup.updated_at, detail: latestCleanup.detail } : null
      },
      recentDeadLetter: recentDeadLetter ? { replyId: recentDeadLetter.id, bindingId: recentDeadLetter.binding_id, promptId: recentDeadLetter.prompt_id, attemptCount: Number(recentDeadLetter.attempt_count), updatedAt: recentDeadLetter.updated_at, error: boundedError(recentDeadLetter.error) } : null
    };
  }

  getSemanticDeliveryRolloutSummary(): SemanticDeliveryRolloutSummary {
    const rollout = this.context.database.prepare(`SELECT phase,cohort_enabled,shadow_epoch,shadow_started_at,
      preparation_cas_failure_count,checkpoint_backward_rebase_count FROM semantic_delivery_rollout WHERE singleton_id=1`).get() as {
      phase:SemanticDeliveryRolloutSummary["phase"]; cohort_enabled:number; shadow_epoch:number; shadow_started_at:string|null;
      preparation_cas_failure_count:number; checkpoint_backward_rebase_count:number;
    };
    const pageCounts = this.context.database.prepare(`SELECT
      SUM(CASE WHEN delivery_cohort='semantic' THEN 1 ELSE 0 END) AS semantic_rows,
      SUM(CASE WHEN COALESCE(delivery_cohort,'legacy')='legacy' THEN 1 ELSE 0 END) AS legacy_rows
      FROM conversation_segment_pages`).get() as { semantic_rows:number|null; legacy_rows:number|null };
    const shadow = this.context.database.prepare(`SELECT
      SUM(CASE WHEN matched=1 THEN 1 ELSE 0 END) AS matches,
      SUM(CASE WHEN matched=0 THEN 1 ELSE 0 END) AS mismatches,
      COUNT(*) AS total FROM semantic_delivery_shadow_evidence
      WHERE shadow_epoch=? AND observed_at>=COALESCE(?,observed_at)
        AND snapshot_schema_version=1 AND planner_policy_version=1 AND renderer_policy_version=1 AND gateway_profile_version=1`)
      .get(rollout.shadow_epoch,rollout.shadow_started_at) as { matches:number|null; mismatches:number|null; total:number };
    const ambiguous = this.context.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies ambiguous
      WHERE projection_key LIKE 'turn-card:%' AND ${nonterminalReplySql("ambiguous")}
        AND (delivery_input_kind IS NULL OR delivery_input_kind!='semantic-snapshot' OR subject_kind IS NULL OR presentation_snapshot_json IS NULL)`).get() as { count:number };
    const versionRows = this.context.database.prepare(`SELECT
      CASE WHEN presentation_snapshot_json IS NULL AND payload_compacted_at IS NOT NULL AND EXISTS(
        SELECT 1 FROM audit_skeletons compacted WHERE compacted.source_kind='delivery' AND compacted.source_id=outbound_replies.id AND compacted.state='compacted'
      ) THEN 1 ELSE json_extract(presentation_snapshot_json,'$.schemaVersion') END AS snapshot_schema_version,
      planner_policy_version,renderer_policy_version,gateway_profile_version,COUNT(*) AS rows
      FROM outbound_replies WHERE delivery_input_kind='semantic-snapshot'
      GROUP BY snapshot_schema_version,planner_policy_version,renderer_policy_version,gateway_profile_version
      ORDER BY snapshot_schema_version,planner_policy_version,renderer_policy_version,gateway_profile_version`).all() as Array<{
        snapshot_schema_version:number|null; planner_policy_version:number|null; renderer_policy_version:number|null; gateway_profile_version:number|null; rows:number;
      }>;
    const versions = versionRows.map((row) => ({
      snapshotSchemaVersion: row.snapshot_schema_version, plannerPolicyVersion: row.planner_policy_version,
      rendererPolicyVersion: row.renderer_policy_version, gatewayProfileVersion: row.gateway_profile_version,
      rows: Number(row.rows), supported: row.snapshot_schema_version===1 && row.planner_policy_version===1 && row.renderer_policy_version===1 && row.gateway_profile_version===1
    }));
    const unsupportedVersions = versions.filter(({ supported }) => !supported).reduce((total, version) => total + version.rows, 0);
    const gaps = this.context.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE state='open' AND failure_code='semantic_subject_settlement_mismatch'").get() as { count:number };
    const retention = this.context.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies retained
      WHERE delivery_input_kind='semantic-snapshot' AND ${nonterminalReplySql("retained")}`).get() as { count:number };
    const unprepared = this.context.database.prepare(`SELECT MIN(created_at) AS oldest_at FROM outbound_replies INDEXED BY outbound_replies_semantic_unprepared_age
      WHERE delivery_input_kind='semantic-snapshot' AND state IN ('pending','dead_letter')
        AND preparation_state IN ('reserved','preparing') AND ${nonterminalReplySql("outbound_replies")}`).get() as { oldest_at:string|null };
    const prerequisiteLag = this.context.database.prepare(`SELECT COUNT(*) AS count,MIN(prerequisite.created_at) AS oldest_at
      FROM outbound_reply_prerequisites prerequisite INDEXED BY outbound_reply_prerequisites_lag
      JOIN outbound_replies dependent ON dependent.id=prerequisite.dependent_reply_id
      LEFT JOIN outbound_replies required ON required.id=prerequisite.prerequisite_reply_id
      WHERE dependent.state IN ('pending','dead_letter') AND ${nonterminalReplySql("dependent")}
        AND (required.id IS NULL OR required.state!=prerequisite.required_state)`).get() as { count:number; oldest_at:string|null };
    const rehearsal = this.context.database.prepare("SELECT rehearsed_at FROM semantic_delivery_backup_rehearsals WHERE succeeded=1 ORDER BY rehearsed_at DESC,id DESC LIMIT 1").get() as { rehearsed_at:string }|undefined;
    const blockers: SemanticDeliveryRolloutBlocker[] = [];
    if (Number(shadow.total)===0) blockers.push("shadow_evidence_missing");
    if (Number(shadow.mismatches??0)>0) blockers.push("shadow_mismatch");
    if (Number(ambiguous.count)>0) blockers.push("ambiguous_actionable_rows");
    if (unsupportedVersions>0) blockers.push("unsupported_versions");
    if (Number(gaps.count)>0) blockers.push("unresolved_settlement_gaps");
    if (Number(retention.count)>0) blockers.push("retention_blockers");
    const cutoverAllowed = blockers.length===0;
    if (!rehearsal) blockers.push("backup_restore_rehearsal_missing");
    return {
      phase:rollout.phase, cohortEnabled:rollout.cohort_enabled===1, cutoverAllowed,
      contractionAllowed:cutoverAllowed && Boolean(rehearsal), legacyRows:Number(pageCounts.legacy_rows??0), semanticRows:Number(pageCounts.semantic_rows??0),
      shadowMatches:Number(shadow.matches??0), shadowMismatches:Number(shadow.mismatches??0), shadowEpoch:Number(rollout.shadow_epoch), shadowStartedAt:rollout.shadow_started_at,
      ambiguousActionableRows:Number(ambiguous.count),
      unsupportedVersions, unresolvedSettlementGaps:Number(gaps.count), retentionBlockers:Number(retention.count), versions,
      oldestUnpreparedSemanticAt:unprepared.oldest_at, oldestUnpreparedSemanticAgeSeconds:ageSeconds(unprepared.oldest_at),
      preparationCasFailures:Number(rollout.preparation_cas_failure_count), unmetPrerequisiteCount:Number(prerequisiteLag.count),
      oldestUnmetPrerequisiteAt:prerequisiteLag.oldest_at, oldestUnmetPrerequisiteAgeSeconds:ageSeconds(prerequisiteLag.oldest_at),
      checkpointBackwardRebases:Number(rollout.checkpoint_backward_rebase_count),
      backupRestoreRehearsedAt:rehearsal?.rehearsed_at??null, blockers
    };
  }

  assertSemanticDeliveryStartupSafe(): void {
    const rollout = this.getSemanticDeliveryRolloutSummary();
    const phaseEnablesCohort = rollout.phase==="cohort" || rollout.phase==="contraction_ready";
    if (phaseEnablesCohort !== rollout.cohortEnabled) throw new Error("semantic_delivery_startup_refused:cohort_phase_mismatch");
    if (!phaseEnablesCohort && rollout.semanticRows>0) throw new Error("semantic_delivery_startup_refused:semantic_rows_before_cohort");
  }

  recordSemanticDeliveryBackupRestoreRehearsal(input: { id:string; backupPathHash:string; backupSchemaFingerprint:string; restoreSchemaFingerprint:string; quickCheck:"ok"|"failed"; foreignKeyIssues:number; semanticIssues:number; schemaValid:boolean; rehearsedAt:string }): void {
    const succeeded = input.quickCheck==="ok" && input.foreignKeyIssues===0 && input.semanticIssues===0 && input.schemaValid
      && input.backupSchemaFingerprint===input.restoreSchemaFingerprint;
    this.context.transaction("sqlite.operations-store.semantic-delivery-backup-rehearsal", () => this.context.database.prepare(`INSERT INTO semantic_delivery_backup_rehearsals(
      id,backup_path_hash,backup_schema_fingerprint,restore_schema_fingerprint,quick_check,foreign_key_issues,semantic_issues,schema_valid,succeeded,rehearsed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.id,input.backupPathHash,input.backupSchemaFingerprint,input.restoreSchemaFingerprint,input.quickCheck,
      input.foreignKeyIssues,input.semanticIssues,input.schemaValid?1:0,succeeded?1:0,input.rehearsedAt));
  }

  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void {
    this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.actorOpenId, input.action, input.target, input.outcome, now());
  }

  recoverLegacyElementIdDeadLetters(canonicalize: (timestamp: string) => void): number {
    const timestamp = now();
    return this.context.transaction("sqlite.operations-store.write", () => {
      canonicalize(timestamp);
      const result = this.context.database.prepare(`UPDATE outbound_replies SET state = 'pending', attempt_count = 0, error = NULL, next_attempt_at = ?, updated_at = ? WHERE state = 'dead_letter' AND first_claimed_at IS NULL AND kind = 'stream_card_create' AND card_role = 'answer' AND error LIKE '%elementID format error%' AND prompt_id IN (SELECT p.id FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id WHERE p.state = 'queued' AND c.answer_message_id IS NULL AND c.answer_card_id IS NULL)` ).run(timestamp, timestamp);
      return Number(result.changes);
    });
  }
}

function ageSeconds(value: string | null): number | null {
  if (value === null) return null;
  const elapsed = Date.now() - Date.parse(value);
  return Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 1_000)) : null;
}

type RecoveryItemRow = {
  kind: "detached_prompt" | "uncertain_prompt" | "primary_answer" | "worker_task";
  stage: import("../../domain/recovery.js").RecoveryStage;
  binding_id: string;
  prompt_id: string | null;
  worker_id: string | null;
  worker_turn_id: string | null;
  updated_at: string;
};

function now(): string { return new Date().toISOString(); }
function boundedError(value: string | null): string { return (value ?? "Unknown failure").slice(0, 500); }
