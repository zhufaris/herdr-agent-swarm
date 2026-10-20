import { randomUUID } from "node:crypto";
import type { OutboundDeliveryClaim } from "../../../domain/delivery.js";
import type { DeliveryFailureMetadata, OutboundFailureTransition as OutboundFailureTransitionResult, OutboxLaneClass } from "../../../domain/types.js";
import type { SqliteContext } from "../context.js";
import type { SqliteOutboxQueueStore } from "../outbox-queue-store.js";
import { boundedOutboxError, type SqliteOutboxDeliveryStore } from "../outbox-delivery-store.js";
import type { OutboxRecoveryDependencies } from "./dependencies.js";
import { normalizedEffectCertainty, outboundLaneClass, streamContentPageIndex } from "./policies.js";
import { SqliteProjectionGapStore } from "../projection-gap-store.js";
import { PRIMARY_ANSWER_EXPIRED_TARGET_PLAN_PROOF, deriveExactWorkerExpiredTargetProof, matchesPersistedPrimaryAnswerExpiredTargetPlan } from "./semantic-recovery-proof.js";
import { SqliteBindingThreadAliasStore } from "../binding-thread-alias-store.js";
import { SqliteHumanReviewSurfaceStore } from "../human-review-surface-store.js";
import { exactReplaceableCardTargetSql } from "../replaceable-card-policy.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../../domain/ports/outbox.js";
import type { EnqueueOutboundReplyInput } from "../outbox-queue-store.js";
import { deliveryDegradationBudget } from "../../../domain/delivery-conflict.js";
import { isReplaySafeSupersession } from "../../../domain/delivery-replay-safety.js";
import { transferDeliveryPrerequisites } from "../delivery-prerequisites.js";

/**
 * Handles failures for the CardKit-only outbox protocol. Historical rich-text
 * replies are intentionally not repaired here: startup handoff turns them into
 * immutable history followed by a new CardKit page.
 */
export class OutboundFailureTransitionProtocol {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
    private readonly delivery: SqliteOutboxDeliveryStore,
    private readonly dependencies: Pick<OutboxRecoveryDependencies, "getBinding">,
    private readonly threadAliases: SqliteBindingThreadAliasStore,
  ) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  apply(id: string, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number, claim?: OutboundDeliveryClaim): OutboundFailureTransitionResult | null {
    if (!this.queue.matchesClaim(id, claim)) return null;
    const before = this.queue.get(id);
    if (!before) return null;
    if (claim && before.state !== "pending") {
      this.queue.releaseClaim(id);
      return null;
    }
    if (before.state === "dead_letter") {
      const existing = this.context.database.prepare("SELECT lane_class, action FROM outbox_lane_quarantines WHERE lane_key = ? AND failed_reply_id = ?").get(before.laneKey, id) as { lane_class: OutboxLaneClass; action: OutboundFailureTransitionResult["action"] } | undefined;
      if (existing) return { state: before.state, action: existing.action, laneClass: existing.lane_class, promptId: before.promptId, reply: before };
    }
    if (before.state !== "pending") return null;

    const staleMainCard = before.kind === "card_update" && before.targetRole === "session_status" && metadata.recoveryKind === "stale_main_card";
    const closedAnswerStream = before.cardRole === "answer" && before.kind === "stream_content" && metadata.recoveryKind === "closed_answer_stream";
    const projection = this.context.database.prepare("SELECT projection_key, stream_page_index FROM outbound_replies WHERE id = ?").get(id) as { projection_key: string | null; stream_page_index: number | null } | undefined;
    const persistedExpiredAnswerTarget = before.cardRole === "answer" && before.kind === "card_update" && before.rootMessageId !== null
      && metadata.recoveryKind === "expired_view_target"
      && matchesPersistedPrimaryAnswerExpiredTargetPlan(before.gatewayPlanJson, {
        gatewayId: before.gatewayId,
        gatewayProfileId: before.gatewayProfileId,
        messageId: before.rootMessageId,
      });
    const expiredViewTarget = before.cardRole === "answer" && before.kind === "card_update"
      && (projection?.projection_key !== null && projection?.projection_key !== undefined || persistedExpiredAnswerTarget)
      && metadata.recoveryKind === "expired_view_target";
    const defunctTarget = metadata.recoveryKind === "defunct_target" && metadata.failureClass === "permanent" && (metadata.larkErrorCode === "230011" || metadata.larkErrorCode === "230019");
    const defunctAnswerStream = defunctTarget && before.cardRole === "answer" && before.kind === "stream_content" && before.promptId !== null;
    const effectCertainty = normalizedEffectCertainty(metadata);
    const uncertainEffect = effectCertainty === "uncertain";
    const uncertainPrimaryAnswer = uncertainEffect && before.cardRole === "answer" && before.promptId !== null
      && (before.kind === "stream_content" || before.kind === "stream_finish");
    const workerTaskStream = before.workerTurnId !== null && (before.kind === "stream_content" || before.kind === "stream_finish");
    const uncertainWorkerTask = uncertainEffect && workerTaskStream;
    const defunctWorkerTask = defunctTarget && workerTaskStream;
    const failedRecoveryCreate = defunctTarget && before.kind === "stream_card_create"
      ? this.context.database.prepare("SELECT failed_reply_id, action FROM delivery_recoveries WHERE replacement_reply_id = ? AND state = 'replacement_pending' AND action IN ('rebuild_answer','rebuild_worker_task') ORDER BY updated_at LIMIT 1").get(before.id) as { failed_reply_id: string; action: "rebuild_answer" | "rebuild_worker_task" } | undefined
      : undefined;
    const settledMetadata = { ...metadata, effectCertainty, ...(uncertainEffect ? { failureClass: "unknown" as const } : {}) };
    const expiredWorkerViewTargetProof = deriveExactWorkerExpiredTargetProof(before, settledMetadata);
    const semanticRecoveryProof = expiredWorkerViewTargetProof
      ?? (persistedExpiredAnswerTarget ? PRIMARY_ANSWER_EXPIRED_TARGET_PLAN_PROOF : null);
    const settledError = uncertainEffect ? `Delivery outcome uncertain; the external effect may have completed. Inspect before manual retry: ${error}` : error;
    const immediateDeadLetter = uncertainEffect
      ? !uncertainPrimaryAnswer && !uncertainWorkerTask
      : settledMetadata.failureClass === "permanent" && effectCertainty === "rejected"
        || staleMainCard || closedAnswerStream;
    const failed = immediateDeadLetter
      ? this.delivery.markDeadLetter(id, settledError, settledMetadata, claim)
      : this.delivery.markFailed(id, uncertainEffect ? settledError : error, retryDelayMs, settledMetadata, claim);
    if (!failed) return null;
    const laneClass = outboundLaneClass(failed);
    if (failed.attemptCount >= 3 && settledMetadata.failureClass !== "unknown") {
      const timestamp = now();
      const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',
          error='Dismissed after bounded retry attempt budget',updated_at=?
        WHERE id=? AND state='dead_letter' AND attempt_count>=3 AND delivered_message_id IS NULL
          AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL`).run(timestamp, id);
      if (dismissed.changes === 1) {
        this.context.database.prepare(`UPDATE delivery_recoveries SET state='dismissed',action='dismiss_attempt_budget',resolved_at=?,updated_at=?
          WHERE failed_reply_id=? AND state IN ('unresolved','replacement_pending')`).run(timestamp, timestamp, id);
        this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state='released',action='dismiss_attempt_budget',released_at=?,updated_at=?
          WHERE failed_reply_id=? AND state='active'`).run(timestamp, timestamp, id);
        this.queue.notifyScopeMutation(failed.laneKey);
        return { state: "dismissed", action: "dismiss_attempt_budget", laneClass, promptId: failed.promptId, reply: this.queue.get(id) ?? failed };
      }
    }
    if (failed.state !== "dead_letter" || (settledMetadata.failureClass === "transient" && failed.autoRecoveryCount === 0)) return { state: failed.state, action: "retry", laneClass, promptId: failed.promptId, reply: failed };

    const timestamp = now();
    let action: OutboundFailureTransitionResult["action"] = "blocked";
    let quarantineState: "active" | "released" = "active";
    let replacementReplyId: string | null = null;
    const hasPendingSuccessor = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE lane_key = ? AND state = 'pending' LIMIT 1").get(failed.laneKey) !== undefined;
    const workerHumanReviewFailure = !uncertainEffect && settledMetadata.failureClass === "permanent"
      && failed.kind === "card_update" && failed.rootMessageId !== null
      && projection?.projection_key?.startsWith("human-review:worker:")
      && (settledMetadata.recoveryKind === "expired_worker_view_target" || settledMetadata.recoveryKind === "defunct_target");
    if (workerHumanReviewFailure) {
      const surfaces = new SqliteHumanReviewSurfaceStore(this.context);
      if (this.preparedDeliveryReservation && this.preparedDeliveryConsumer) {
        surfaces.setPreparedDeliveryReservation(this.preparedDeliveryReservation, this.preparedDeliveryConsumer);
      }
      const replacement = surfaces.replaceWorkerTarget({
        projectionKey: projection!.projection_key!, targetMessageId: failed.rootMessageId!, occurredAt: timestamp
      });
      if (replacement.outcome === "replaced") {
        replacementReplyId = replacement.replyId;
        action = "replace_human_review_target";
        quarantineState = "released";
      } else if (replacement.outcome === "resolved") {
        this.context.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'Dismissed after resolved Human Review target became unavailable', updated_at = ? WHERE id = ? AND state = 'dead_letter'").run(timestamp, id);
        action = "dismiss_human_review_target";
        quarantineState = "released";
      }
    } else if (expiredWorkerViewTargetProof) {
      this.dismissMatchingPendingWorkerTargetUpdates(failed, timestamp);
      replacementReplyId = this.enqueueExpiredWorkerTargetReplacement(failed);
      if (replacementReplyId) {
        action = "replace_expired_worker_target";
        quarantineState = "released";
      }
    } else if (failedRecoveryCreate) {
      replacementReplyId = this.reserveRecoveryConversation(failed, failedRecoveryCreate);
      if (replacementReplyId) {
        action = "create_recovery_conversation";
        quarantineState = "released";
      } else {
        action = "refuse_recovery_conversation";
        this.context.database.prepare("UPDATE delivery_recoveries SET action = 'refuse_recovery_conversation', replacement_reply_id = NULL, state = 'unresolved', updated_at = ? WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')").run(timestamp, failedRecoveryCreate.failed_reply_id);
      }
    } else if ((uncertainWorkerTask || defunctWorkerTask) && failed.workerTurnId) {
      const pageIndex = projection?.stream_page_index ?? streamContentPageIndex(failed.payload);
      if (pageIndex === null) throw new Error(`Worker Task stream ${failed.id} has invalid page metadata`);
      const frozen = this.context.database.prepare(`UPDATE worker_turn_card_pages SET state = 'frozen', updated_at = ?
        WHERE turn_id = ? AND page_index = ? AND state = 'active' AND card_id = ?
          AND EXISTS (SELECT 1 FROM worker_turn_cards card
            JOIN instance_turns turn ON turn.id = card.turn_id
              AND turn.instance_id = card.instance_id AND turn.instance_generation = card.instance_generation
            JOIN agent_instances worker ON worker.id = card.instance_id
              AND worker.role = 'worker' AND worker.generation = card.instance_generation
              AND worker.worker_session_generation = card.worker_session_generation
            WHERE card.turn_id = worker_turn_card_pages.turn_id)`).run(timestamp, failed.workerTurnId, pageIndex, failed.rootMessageId);
      if (frozen.changes === 1) {
        this.context.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'Dismissed after Worker Task stream recovery started', updated_at = ? WHERE lane_key = ? AND state = 'pending' AND delivery_order > ? AND kind IN ('stream_content','stream_finish')").run(timestamp, failed.laneKey, this.outboundDeliveryOrder(id));
        action = "rebuild_worker_task";
        quarantineState = "released";
      }
    } else if (!uncertainEffect && defunctTarget && !defunctAnswerStream && !defunctWorkerTask && !expiredViewTarget && !closedAnswerStream && !staleMainCard && !hasPendingSuccessor) {
      const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed', error = 'Dismissed after provider confirmed the delivery target no longer exists', updated_at = ? WHERE id = ? AND state = 'dead_letter' AND failure_class = 'permanent' AND effect_certainty = 'rejected' AND lark_error_code IN ('230011', '230019')`).run(timestamp, id);
      if (dismissed.changes === 1) { action = "dismiss_defunct_target"; quarantineState = "released"; }
    } else if (!uncertainEffect && expiredViewTarget && projection?.projection_key) {
      this.context.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'Dismissed after Gateway rejected the expired view target', updated_at = ? WHERE projection_key = ? AND state = 'pending' AND first_claimed_at IS NULL AND claim_attempt_id IS NULL").run(timestamp, projection.projection_key);
      if (failed.promptId && projection.stream_page_index !== null) this.context.database.prepare(`UPDATE answer_pages
        SET state='frozen', delivery_mode='static', updated_at=?
        WHERE prompt_id=? AND page_index=? AND message_id=? AND state IN ('active','finished')`).run(
        timestamp, failed.promptId, projection.stream_page_index, failed.rootMessageId
      );
      action = "expired_view_target";
      quarantineState = "released";
    } else if (!uncertainEffect && expiredViewTarget) {
      this.dismissMatchingPendingAnswerTargetUpdates(failed, timestamp);
      if (failed.promptId && projection?.stream_page_index !== null && projection?.stream_page_index !== undefined) this.context.database.prepare(`UPDATE answer_pages
        SET state='frozen', delivery_mode='static', updated_at=?
        WHERE prompt_id=? AND page_index=? AND message_id=? AND state IN ('active','finished','frozen')`).run(
        timestamp, failed.promptId, projection.stream_page_index, failed.rootMessageId
      );
      action = "expired_view_target";
      quarantineState = "released";
    } else if ((!uncertainEffect && (closedAnswerStream || defunctAnswerStream) || uncertainPrimaryAnswer) && failed.promptId) {
      const pageIndex = projection?.stream_page_index ?? streamContentPageIndex(failed.payload);
      if (pageIndex === null) throw new Error(`Closed Answer stream ${failed.id} has invalid page metadata`);
      this.context.database.prepare(`UPDATE answer_pages SET state = 'frozen', delivery_mode = 'static', updated_at = ?
        WHERE prompt_id = ? AND page_index = ? AND state = 'active'
          AND (card_id = ? OR message_id = ?)`).run(timestamp, failed.promptId, pageIndex, failed.rootMessageId, failed.rootMessageId);
      this.context.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'Dismissed after Lark closed the Answer stream', updated_at = ? WHERE lane_key = ? AND state = 'pending' AND delivery_order > ? AND kind IN ('stream_content','stream_finish')").run(timestamp, failed.laneKey, this.outboundDeliveryOrder(id));
      action = "rebuild_answer";
      quarantineState = "released";
    } else if (!uncertainEffect && laneClass === "answer_stream" && failed.promptId) {
      this.context.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'Isolated after an earlier Answer stream failure', updated_at = ? WHERE lane_key = ? AND state = 'pending' AND delivery_order > ? AND kind IN ('stream_content','stream_finish')").run(timestamp, failed.laneKey, this.outboundDeliveryOrder(id));
    } else if (!uncertainEffect && laneClass === "main_card" && staleMainCard && failed.bindingId) {
      const replacement = this.context.database.prepare("SELECT payload, COALESCE(view_version, 0) AS view_version FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND (id = ? OR state = 'pending') ORDER BY COALESCE(view_version, 0) DESC, delivery_order DESC LIMIT 1").get(failed.bindingId, id) as { payload: string; view_version: number } | undefined;
      const binding = this.dependencies.getBinding(failed.bindingId);
      if (!binding) throw new Error(`Binding not found: ${failed.bindingId}`);
      if (replacement && binding.rootMessageId) {
        this.context.database.prepare(`UPDATE outbound_replies
          SET state = 'dismissed',
            error = 'Coalesced unclaimed stale-main snapshot before rebuild',
            updated_at = ?
          WHERE binding_id = ? AND target_role = 'session_status' AND kind = 'card_update'
            AND state = 'pending' AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
            AND attempt_count = 0 AND card_id_checkpoint IS NULL`).run(timestamp, failed.bindingId);
        replacementReplyId = this.reservePrimary({ id: randomUUID(), idempotencyKey: `main-card:rebuild:${failed.bindingId}:${replacement.view_version}`, workClass: "history", bindingId: failed.bindingId, bindingGeneration: binding.generation, viewVersion: replacement.view_version, targetRole: "session_status", rootMessageId: binding.rootMessageId, kind: "card_reply", payload: replacement.payload, projectionKey: `primary-main:${failed.bindingId}:${binding.generation}`, snapshotRevision: replacement.view_version }).id;
        action = "rebuild_main";
        quarantineState = "released";
      }
    } else if (!uncertainEffect && (laneClass === "main_card" || laneClass === "replaceable_card")) {
      const candidateReplyId = this.findExactPendingReplaceableSuccessor(id);
      if (candidateReplyId && isReplaySafeSupersession({
        effectCertainty: failed.effectCertainty,
        autoRecoveryCount: failed.autoRecoveryCount,
        kind: failed.kind,
        idempotencyKey: failed.idempotencyKey,
        projectionKey: failed.projectionKey ?? null,
        reconstructible: true,
        targetFrozen: this.isFrozenTarget(failed),
        providerOperationSafe: failed.kind === "card_update",
        ownerCurrent: this.isCurrentOwner(failed),
        hasExternalEffectEvidence: failed.deliveredMessageId !== null || failed.cardIdCheckpoint !== null || failed.gatewayCheckpointJson !== null,
      })) {
        const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',
          auto_recovery_count=auto_recovery_count+1,
          error='Superseded by a newer authoritative snapshot after confirmed non-application',updated_at=?
          WHERE id=? AND state='dead_letter' AND effect_certainty IN ('not-started','rejected')
            AND auto_recovery_count=0 AND kind='card_update'
            AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL`
        ).run(timestamp, id);
        if (dismissed.changes === 1) {
          transferDeliveryPrerequisites(this.context, id, candidateReplyId);
          replacementReplyId = candidateReplyId;
          action = "released_newer_snapshot";
          quarantineState = "released";
        }
      }
    }

    this.context.database.prepare("UPDATE delivery_recoveries SET action = ?, semantic_recovery_proof = ?, replacement_reply_id = ?, state = ?, updated_at = ? WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')").run(action, semanticRecoveryProof, replacementReplyId, replacementReplyId ? "replacement_pending" : "unresolved", timestamp, id);
    if (action === "dismiss_defunct_target" || action === "dismiss_human_review_target") {
      this.context.database.prepare("UPDATE delivery_recoveries SET state = 'dismissed', resolved_at = ?, updated_at = ? WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')").run(timestamp, timestamp, id);
    }
    const budget = deliveryDegradationBudget({
      failureClass: metadata.failureClass,
      effectCertainty: settledMetadata.effectCertainty ?? "uncertain",
      firstFailedAt: timestamp
    });
    this.context.database.prepare(`INSERT INTO outbox_lane_quarantines(
      lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at,released_at,
      conflict_key,phase,first_failed_at,grace_deadline_at,degraded_at,budget_attempt_limit,budget_duration_ms
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(lane_key) DO UPDATE SET failed_reply_id=excluded.failed_reply_id,lane_class=excluded.lane_class,
      failure_class=excluded.failure_class,state=excluded.state,action=excluded.action,reason=excluded.reason,
      updated_at=excluded.updated_at,released_at=excluded.released_at,conflict_key=excluded.conflict_key,
      phase=excluded.phase,first_failed_at=excluded.first_failed_at,grace_deadline_at=excluded.grace_deadline_at,
      degraded_at=NULL,budget_attempt_limit=excluded.budget_attempt_limit,budget_duration_ms=excluded.budget_duration_ms`).run(
      failed.laneKey, id, laneClass, metadata.failureClass, quarantineState, action, boundedOutboxError(error), timestamp, timestamp,
      quarantineState === "released" ? timestamp : null, failed.conflictKey, "grace_blocking", timestamp, budget.deadlineAt, null,
      budget.attemptLimit, budget.durationMs
    );
    if (quarantineState === "released") this.queue.notifyScopeMutation(failed.laneKey);
    if (action !== "dismiss_defunct_target" && action !== "dismiss_human_review_target") {
      new SqliteProjectionGapStore(this.context).openDeliveryForReply(
        failed.id,
        settledMetadata.failureClass,
        settledMetadata.larkErrorCode ?? settledMetadata.recoveryKind ?? `delivery_${settledMetadata.failureClass}`,
        timestamp
      );
    }
    const settled = this.queue.get(id) ?? failed;
    return { state: settled.state, action, laneClass, promptId: settled.promptId, reply: settled };
  }

  private outboundDeliveryOrder(id: string): number {
    const row = this.context.database.prepare("SELECT delivery_order FROM outbound_replies WHERE id = ?").get(id) as { delivery_order: number } | undefined;
    if (!row) throw new Error(`Outbound reply not found: ${id}`);
    return Number(row.delivery_order);
  }

  private reserveRecoveryConversation(failed: ReturnType<SqliteOutboxQueueStore["get"]> & {}, recovery: { failed_reply_id: string; action: "rebuild_answer" | "rebuild_worker_task" }): string | null {
    if (!failed || failed.streamPageIndex === null) return null;
    const card = recoveryCard(failed.payload);
    if (!card) return null;
    const route = recovery.action === "rebuild_answer" && failed.promptId
      ? this.context.database.prepare(`SELECT binding.id, binding.generation, binding.chat_id, binding.pane_id, binding.status_message_id
          FROM run_cards card JOIN bindings binding ON binding.id = card.binding_id AND binding.generation = card.binding_generation
          WHERE card.prompt_id = ? AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'`).get(failed.promptId)
      : recovery.action === "rebuild_worker_task" && failed.workerTurnId
        ? this.context.database.prepare(`SELECT binding.id, binding.generation, binding.chat_id, binding.pane_id, binding.status_message_id
            FROM worker_turn_cards card
            JOIN instance_turns turn ON turn.id = card.turn_id AND turn.instance_id = card.instance_id AND turn.instance_generation = card.instance_generation
            JOIN agent_instances worker ON worker.id = card.instance_id AND worker.role = 'worker' AND worker.generation = card.instance_generation AND worker.worker_session_generation = card.worker_session_generation
            JOIN bindings binding ON binding.id = worker.parent_binding_id AND binding.generation = worker.parent_binding_generation AND binding.pane_id = worker.parent_pane_id
            WHERE card.turn_id = ? AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'`).get(failed.workerTurnId)
        : undefined;
    const target = route as { id: string; generation: number; chat_id: string; pane_id: string | null; status_message_id: string | null } | undefined;
    if (!target?.pane_id || !target.status_message_id) return null;
    const projectionKind = recovery.action === "rebuild_answer" ? "primary-answer" : "worker-task";
    const projectionId = failed.promptId ?? failed.workerTurnId!;
    const publicationKey = `projection-recovery-thread:${projectionKind}:${projectionId}:${failed.streamPageIndex}`;
    const decision = this.threadAliases.reserve({
      publicationKey,
      actionMessageId: failed.id,
      bindingId: target.id,
      bindingGeneration: Number(target.generation),
      paneId: target.pane_id,
      sourceMainMessageId: target.status_message_id,
      targetChatId: target.chat_id,
      viewVersion: failed.viewVersion ?? 0,
      card,
      recovery: recovery.action === "rebuild_answer"
        ? { kind: "primary-answer", promptId: failed.promptId!, pageIndex: failed.streamPageIndex }
        : { kind: "worker-task", workerTurnId: failed.workerTurnId!, pageIndex: failed.streamPageIndex }
    }, this.queue);
    if (decision === "stale") return null;
    const replacement = this.context.database.prepare("SELECT id FROM outbound_replies WHERE idempotency_key = ? AND kind = 'group_card_create'").get(publicationKey) as { id: string } | undefined;
    if (!replacement) return null;
    const timestamp = now();
    this.context.database.prepare("UPDATE delivery_recoveries SET action = 'create_recovery_conversation', replacement_reply_id = ?, state = 'replacement_pending', updated_at = ? WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')").run(replacement.id, timestamp, recovery.failed_reply_id);
    return replacement.id;
  }

  private reservePrimary(input: EnqueueOutboundReplyInput & { bindingGeneration: number }) {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Failure Transition prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private reserveWorkerRecovery(input: EnqueueOutboundReplyInput) {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Failure Transition prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

  private findExactPendingReplaceableSuccessor(id: string): string | null {
    const row = this.context.database.prepare(`
      SELECT candidate.id
      FROM outbound_replies failed
      JOIN outbound_replies candidate ON candidate.lane_key = failed.lane_key
      WHERE failed.id = ?
        AND candidate.state = 'pending'
        AND ${exactReplaceableCardTargetSql("failed", "candidate")}
        AND candidate.delivery_order > failed.delivery_order
        AND (
          failed.view_version IS NULL
          OR candidate.view_version > failed.view_version
          OR (failed.projection_key IS NOT NULL
            AND candidate.projection_key = failed.projection_key
            AND candidate.snapshot_revision > failed.snapshot_revision)
        )
        AND (
          failed.projection_key IS NULL
          OR (candidate.projection_key = failed.projection_key
            AND candidate.snapshot_revision > failed.snapshot_revision)
        )
      ORDER BY COALESCE(candidate.view_version, 0) DESC, candidate.delivery_order DESC
      LIMIT 1
    `).get(id) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private isFrozenTarget(reply: NonNullable<ReturnType<SqliteOutboxQueueStore["get"]>>): boolean {
    if (reply.cardRole === "answer" && reply.promptId !== null && reply.streamPageIndex !== null) {
      return this.context.database.prepare(`SELECT 1 FROM answer_pages
        WHERE prompt_id=? AND page_index=? AND message_id=? AND state='frozen' LIMIT 1`
      ).get(reply.promptId, reply.streamPageIndex, reply.rootMessageId) !== undefined;
    }
    if (reply.workerTurnId !== null && reply.streamPageIndex !== null) {
      return this.context.database.prepare(`SELECT 1 FROM worker_turn_card_pages
        WHERE turn_id=? AND page_index=? AND message_id=? AND state='frozen' LIMIT 1`
      ).get(reply.workerTurnId, reply.streamPageIndex, reply.rootMessageId) !== undefined;
    }
    return false;
  }

  private isCurrentOwner(reply: NonNullable<ReturnType<SqliteOutboxQueueStore["get"]>>): boolean {
    const scope = reply.deliveryScope;
    const owner = reply.deliveryOwnerFence;
    if (scope?.kind === "global") return owner === null;
    if (scope?.kind !== "pane" || owner === null) return false;
    if (owner.kind === "primary") {
      return this.context.database.prepare(`SELECT 1 FROM bindings
        WHERE id=? AND generation=? AND session_epoch=? AND workspace_id=? AND pane_id=?
          AND state='active' AND lifecycle='active' AND attachment='attached' LIMIT 1`
      ).get(owner.id, owner.generation, owner.sessionGeneration, scope.workspaceId, scope.paneId) !== undefined;
    }
    if (!owner.parent) return false;
    return this.context.database.prepare(`SELECT 1 FROM agent_instances worker
      JOIN bindings parent ON parent.id=worker.parent_binding_id
      WHERE worker.id=? AND worker.generation=? AND worker.worker_session_generation=?
        AND worker.role='worker' AND worker.desired_state='running'
        AND worker.worker_session_lifecycle='active'
        AND worker.parent_binding_id=? AND worker.parent_binding_generation=? AND worker.parent_pane_id=?
        AND parent.generation=? AND parent.session_epoch=? AND parent.workspace_id=? AND parent.pane_id=?
        AND parent.state='active' AND parent.lifecycle='active' AND parent.attachment='attached'
        AND (?=? OR (worker.herdr_workspace_id=? AND worker.pane_id=?)) LIMIT 1`
    ).get(
      owner.id, owner.generation, owner.sessionGeneration,
      owner.parent.id, owner.parent.generation, reply.deliveryParentPaneId,
      owner.parent.generation, owner.parent.sessionGeneration, scope.workspaceId, reply.deliveryParentPaneId,
      scope.paneId, reply.deliveryParentPaneId, scope.workspaceId, scope.paneId
    ) !== undefined;
  }

  private isExactWorkerExpiredTarget(reply: import("../../../domain/types.js").OutboundReply): boolean {
    if (reply.kind !== "card_update") return false;
    const workerMain = reply.workerId !== null
      && reply.workerSessionGeneration !== null
      && reply.workerTurnId === null
      && reply.promptId === null
      && reply.rootMessageId !== null;
    const workerTurn = reply.workerId === null
      && reply.workerSessionGeneration === null
      && reply.workerTurnId !== null
      && reply.promptId === null
      && reply.streamPageIndex !== null
      && reply.rootMessageId !== null;
    return workerMain !== workerTurn;
  }

  private dismissMatchingPendingWorkerTargetUpdates(failed: import("../../../domain/types.js").OutboundReply, timestamp: string): void {
    this.context.database.prepare(`UPDATE outbound_replies
      SET state = 'dismissed', error = 'Dismissed after Gateway rejected the expired Worker target', updated_at = ?
      WHERE lane_key = ? AND state = 'pending' AND kind = 'card_update'
        AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
        AND COALESCE(effect_certainty, 'rejected') != 'uncertain'
        AND id != ? AND gateway_id = ?
        AND binding_id IS ? AND prompt_id IS ? AND worker_id IS ? AND worker_session_generation IS ?
        AND worker_turn_id IS ? AND stream_page_index IS ?
        AND root_message_id IS ? AND card_role IS ? AND target_role IS ? AND selection_id IS ?`
    ).run(
      timestamp,
      failed.laneKey,
      failed.id,
      failed.gatewayId,
      failed.bindingId,
      failed.promptId,
      failed.workerId,
      failed.workerSessionGeneration,
      failed.workerTurnId,
      failed.streamPageIndex,
      failed.rootMessageId,
      failed.cardRole,
      failed.targetRole,
      failed.selectionId,
    );
  }

  private dismissMatchingPendingAnswerTargetUpdates(failed: import("../../../domain/types.js").OutboundReply, timestamp: string): void {
    this.context.database.prepare(`UPDATE outbound_replies
      SET state = 'dismissed', error = 'Dismissed after Gateway rejected the expired Answer target', updated_at = ?
      WHERE lane_key = ? AND state = 'pending' AND kind = 'card_update'
        AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
        AND gateway_id = ? AND binding_id IS ? AND prompt_id IS ?
        AND worker_id IS NULL AND worker_turn_id IS NULL
        AND stream_page_index IS ? AND root_message_id IS ?
        AND card_role = 'answer' AND target_role IS NULL
        AND delivery_order > ?`
    ).run(timestamp, failed.laneKey, failed.gatewayId, failed.bindingId, failed.promptId,
      failed.streamPageIndex, failed.rootMessageId, this.outboundDeliveryOrder(failed.id));
  }

  private enqueueExpiredWorkerTargetReplacement(failed: import("../../../domain/types.js").OutboundReply): string | null {
    if (failed.kind !== "card_update" || failed.gatewayId !== "feishu:primary") return null;
    if (failed.workerId !== null && failed.workerSessionGeneration !== null && failed.workerTurnId === null) {
      const main = this.context.database.prepare(`
        SELECT main.parent_binding_id, main.view_version, thread.id AS worker_thread_id, thread.chat_id
        FROM worker_main_views main
        JOIN agent_instances worker ON worker.id = main.worker_id
          AND worker.role = 'worker' AND worker.worker_session_lifecycle = 'active'
          AND worker.worker_session_generation = main.worker_session_generation
          AND worker.parent_binding_id = main.parent_binding_id
        JOIN worker_session_threads thread ON thread.worker_id = main.worker_id
          AND thread.worker_session_generation = main.worker_session_generation
          AND thread.parent_binding_id = main.parent_binding_id
          AND thread.parent_binding_generation = worker.parent_binding_generation
          AND thread.parent_pane_id = worker.parent_pane_id
          AND thread.state = 'active'
          AND thread.root_message_id IS NOT NULL
        JOIN bindings binding ON binding.id = thread.parent_binding_id
          AND binding.generation = thread.parent_binding_generation
          AND binding.pane_id = thread.parent_pane_id
          AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
        WHERE main.worker_id = ? AND main.worker_session_generation = ?
          AND thread.root_message_id = ?
          AND (? IS NULL OR main.parent_binding_id = ?)
      `).get(failed.workerId, failed.workerSessionGeneration, failed.rootMessageId, failed.bindingId, failed.bindingId) as {
        parent_binding_id: string;
        view_version: number;
        worker_thread_id: string;
        chat_id: string;
      } | undefined;
      if (!main) return null;
      return this.reserveWorkerRecovery({
        id: randomUUID(),
        idempotencyKey: `worker-main:recovery-create:${failed.id}`,
        workClass: "history",
        bindingId: main.parent_binding_id,
        workerId: failed.workerId,
        workerSessionGeneration: failed.workerSessionGeneration,
        workerThreadId: main.worker_thread_id,
        targetChatId: main.chat_id,
        viewVersion: failed.viewVersion ?? main.view_version,
        rootMessageId: null,
        kind: "group_card_create",
        payload: markRecoveryPayload(failed.payload),
        projectionKey: `worker-main-recovery:${failed.id}`,
        snapshotRevision: failed.viewVersion ?? main.view_version
      }).id;
    }
    if (failed.workerId === null && failed.workerSessionGeneration === null && failed.workerTurnId !== null && failed.streamPageIndex !== null) {
      const turn = this.context.database.prepare(`
        SELECT turn.view_version, thread.id AS worker_thread_id, thread.chat_id, turn.instance_id, turn.worker_session_generation
        FROM worker_turn_cards turn
        JOIN agent_instances worker ON worker.id = turn.instance_id
          AND worker.role = 'worker' AND worker.worker_session_lifecycle = 'active'
          AND worker.worker_session_generation = turn.worker_session_generation
        JOIN worker_session_threads thread ON thread.worker_id = turn.instance_id
          AND thread.worker_session_generation = turn.worker_session_generation
          AND thread.parent_binding_id = worker.parent_binding_id
          AND thread.parent_binding_generation = worker.parent_binding_generation
          AND thread.parent_pane_id = worker.parent_pane_id
          AND thread.state = 'active'
          AND thread.root_message_id IS NOT NULL
        JOIN bindings binding ON binding.id = thread.parent_binding_id
          AND binding.generation = thread.parent_binding_generation
          AND binding.pane_id = thread.parent_pane_id
          AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
        WHERE turn.turn_id = ?
      `).get(failed.workerTurnId) as {
        view_version: number;
        worker_thread_id: string;
        chat_id: string;
        instance_id: string;
        worker_session_generation: number;
      } | undefined;
      if (!turn) return null;
      return this.reserveWorkerRecovery({
        id: randomUUID(),
        idempotencyKey: `worker-turn:recovery-create:${failed.id}`,
        workClass: "history",
        bindingId: null,
        workerTurnId: failed.workerTurnId,
        streamPageIndex: failed.streamPageIndex,
        workerId: turn.instance_id,
        workerSessionGeneration: turn.worker_session_generation,
        workerThreadId: turn.worker_thread_id,
        targetChatId: turn.chat_id,
        viewVersion: failed.viewVersion ?? turn.view_version,
        rootMessageId: null,
        kind: "group_card_create",
        payload: JSON.stringify(parseMarkedCardPayload(failed.payload)),
        projectionKey: `worker-turn-recovery:${failed.id}`,
        snapshotRevision: failed.viewVersion ?? turn.view_version
      }).id;
    }
    return null;
  }
}

function now(): string { return new Date().toISOString(); }

function recoveryCard(payload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(payload) as { card?: unknown };
    return parsed?.card && typeof parsed.card === "object" && !Array.isArray(parsed.card)
      ? parsed.card as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

const EXPIRED_WORKER_TARGET_MARKER = "🕰️ 原卡片已过期 · 已恢复到此卡";

function markRecoveryPayload(payload: string): string {
  return JSON.stringify(parseMarkedCardPayload(payload));
}

function parseMarkedCardPayload(payload: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { recoveryBanner: EXPIRED_WORKER_TARGET_MARKER };
  }
  return { ...(parsed as Record<string, unknown>), recoveryBanner: EXPIRED_WORKER_TARGET_MARKER };
}
