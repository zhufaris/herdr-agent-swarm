import type { SqliteContext } from "../context.js";
import type { SqliteOutboxQueueStore } from "../outbox-queue-store.js";
import { PRIMARY_ANSWER_EXPIRED_TARGET_PLAN_PROOF, matchesPersistedPrimaryAnswerExpiredTargetPlan } from "./semantic-recovery-proof.js";
import { isReplaySafeSupersession } from "../../../domain/delivery-replay-safety.js";
import { transferDeliveryPrerequisites } from "../delivery-prerequisites.js";

export interface ReplaceableCardRecoveryResult {
  resolvedSupersededAnswerTargets: number;
  releasedSupersededWorkerMainUpdates: number;
  releasedSupersededPrimaryMainUpdates?: number;
  releasedSupersededPaneEntryUpdates?: number;
}

export class ReplaceableCardRecovery {
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
  ) {}

  recover(timestamp: string): ReplaceableCardRecoveryResult {
    this.recoverLegacyExpiredAnswerTargets(timestamp);
    const supersededAnswerRows = this.context.database.prepare(`
      SELECT q.lane_key, failed.id AS failed_reply_id, failed.prompt_id,
        replacement.id AS replacement_reply_id, replacement.delivered_message_id,
        pending.id AS latest_reply_id, pending.projection_key, pending.lane_key AS latest_lane_key
      FROM outbox_lane_quarantines q
      JOIN outbound_replies failed ON failed.id = q.failed_reply_id
      JOIN delivery_recoveries recovery ON recovery.failed_reply_id = failed.id
        AND recovery.state IN ('unresolved','replacement_pending')
      JOIN run_cards card ON card.prompt_id = failed.prompt_id
        AND card.answer_message_id IS NOT NULL AND card.answer_card_id IS NOT NULL
        AND card.answer_message_id != failed.root_message_id
      JOIN answer_pages page ON page.prompt_id = card.prompt_id
        AND page.page_index = card.answer_page_index
        AND page.state = 'active' AND page.delivery_mode = 'static'
        AND page.message_id = card.answer_message_id AND page.card_id = card.answer_card_id
      JOIN outbound_replies replacement ON replacement.prompt_id = failed.prompt_id
        AND replacement.card_role = 'answer' AND replacement.kind = 'stream_card_create'
        AND replacement.state = 'delivered' AND replacement.stream_page_index = card.answer_page_index
        AND replacement.delivered_message_id = page.message_id
        AND replacement.card_id_checkpoint = page.card_id
        AND replacement.gateway_id = failed.gateway_id
        AND replacement.delivery_order > failed.delivery_order
        AND replacement.id = (
          SELECT candidate.id FROM outbound_replies candidate
          WHERE candidate.prompt_id = failed.prompt_id
            AND candidate.card_role = 'answer' AND candidate.kind = 'stream_card_create'
            AND candidate.state = 'delivered' AND candidate.stream_page_index = card.answer_page_index
            AND candidate.delivered_message_id = page.message_id
            AND candidate.card_id_checkpoint = page.card_id
            AND candidate.gateway_id = failed.gateway_id
            AND candidate.delivery_order > failed.delivery_order
          ORDER BY candidate.delivery_order DESC LIMIT 1
        )
      JOIN outbound_replies pending ON pending.state = 'pending' AND pending.kind = 'card_update'
        AND pending.card_role = 'answer' AND pending.prompt_id = failed.prompt_id
        AND pending.root_message_id = page.message_id
        AND pending.projection_key = 'answer-static:' || failed.prompt_id || ':' || page.page_index || ':' || page.message_id
        AND pending.delivery_order > failed.delivery_order
        AND pending.id = (
          SELECT candidate.id FROM outbound_replies candidate
          WHERE candidate.projection_key = pending.projection_key AND candidate.state = 'pending'
          ORDER BY candidate.snapshot_revision DESC, candidate.delivery_order DESC LIMIT 1
        )
      WHERE q.state = 'active' AND q.lane_class IN ('replaceable_card', 'immutable')
        AND failed.state = 'dead_letter' AND failed.kind = 'card_update'
        AND failed.card_role = 'answer' AND failed.prompt_id IS NOT NULL
        AND failed.root_message_id IS NOT NULL AND failed.effect_certainty IN ('not-started','rejected')
        AND failed.auto_recovery_count = 0
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies unsafe
          WHERE unsafe.projection_key = pending.projection_key AND unsafe.state = 'pending'
            AND (unsafe.claim_attempt_id IS NOT NULL OR unsafe.first_claimed_at IS NOT NULL
              OR unsafe.kind != 'card_update' OR unsafe.card_role IS NOT 'answer'
              OR unsafe.prompt_id IS NOT failed.prompt_id OR unsafe.root_message_id IS NOT page.message_id
              OR unsafe.projection_key IS NOT pending.projection_key
              OR unsafe.delivery_order <= failed.delivery_order)
        )
      ORDER BY q.created_at, failed.delivery_order
    `).all() as Array<{ lane_key: string; failed_reply_id: string; prompt_id: string; replacement_reply_id: string; delivered_message_id: string; latest_reply_id: string; projection_key: string; latest_lane_key: string }>;
    let resolvedSupersededAnswerTargets = 0;
    for (const row of supersededAnswerRows) {
      if (!this.consumeReplaySafeSupersession(row.failed_reply_id, row.replacement_reply_id, timestamp)) continue;
      this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'dismissed', error = 'Superseded by a durably delivered Answer target', updated_at = ?
        WHERE projection_key = ? AND state = 'pending' AND id != ?
          AND claim_attempt_id IS NULL AND first_claimed_at IS NULL`).run(timestamp, row.projection_key, row.latest_reply_id);
      const recovery = this.context.database.prepare(`UPDATE delivery_recoveries
        SET state = 'recovered', action = 'startup_superseded_answer', replacement_reply_id = ?,
          resolved_by_reply_id = ?, resolved_message_id = ?, resolved_at = ?, updated_at = ?
        WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')`).run(
          row.replacement_reply_id, row.replacement_reply_id, row.delivered_message_id, timestamp, timestamp, row.failed_reply_id
        );
      if (recovery.changes !== 1) throw new Error(`Failed to settle superseded Answer recovery ${row.failed_reply_id}`);
      const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'startup_superseded_answer', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      if (released.changes !== 1) throw new Error(`Failed to release superseded Answer quarantine ${row.failed_reply_id}`);
      this.queue.notifyScopeMutation(row.lane_key);
      if (row.latest_lane_key !== row.lane_key) this.queue.notifyScopeMutation(row.latest_lane_key);
      resolvedSupersededAnswerTargets += 1;
    }
    const supersededUpdates = this.context.database.prepare(`
      SELECT q.lane_key, failed.id AS failed_reply_id, pending.id AS latest_reply_id
      FROM outbox_lane_quarantines q
      JOIN outbound_replies failed ON failed.id = q.failed_reply_id
      JOIN worker_main_views main ON main.worker_id = failed.worker_id
        AND main.worker_session_generation = failed.worker_session_generation
        AND main.message_id = failed.root_message_id
      JOIN outbound_replies pending ON pending.lane_key = q.lane_key
        AND pending.state = 'pending' AND pending.kind = 'card_update'
        AND pending.gateway_id = failed.gateway_id
        AND pending.binding_id IS failed.binding_id
        AND pending.worker_id IS failed.worker_id
        AND pending.worker_session_generation IS failed.worker_session_generation
        AND pending.root_message_id IS failed.root_message_id
        AND pending.card_role IS failed.card_role AND pending.target_role IS failed.target_role
        AND pending.view_version = main.view_version
        AND pending.delivery_order > failed.delivery_order
        AND pending.id = (
          SELECT candidate.id FROM outbound_replies candidate
          WHERE candidate.lane_key = q.lane_key AND candidate.state = 'pending'
          ORDER BY candidate.view_version DESC, candidate.delivery_order DESC LIMIT 1
        )
      WHERE q.state = 'active' AND q.lane_class IN ('replaceable_card','main_card','immutable')
        AND failed.state = 'dead_letter' AND failed.kind = 'card_update'
        AND failed.effect_certainty IN ('not-started','rejected')
        AND failed.auto_recovery_count = 0
        AND failed.worker_id IS NOT NULL AND failed.worker_session_generation IS NOT NULL
        AND failed.prompt_id IS NULL AND failed.worker_turn_id IS NULL
        AND failed.root_message_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies unsafe
          WHERE unsafe.lane_key = q.lane_key AND unsafe.state = 'pending'
            AND (unsafe.claim_attempt_id IS NOT NULL OR unsafe.first_claimed_at IS NOT NULL
              OR unsafe.kind != 'card_update' OR unsafe.gateway_id != failed.gateway_id
              OR unsafe.binding_id IS NOT failed.binding_id
              OR unsafe.worker_id IS NOT failed.worker_id
              OR unsafe.worker_session_generation IS NOT failed.worker_session_generation
              OR unsafe.prompt_id IS NOT NULL OR unsafe.worker_turn_id IS NOT NULL
              OR unsafe.root_message_id IS NOT failed.root_message_id
              OR unsafe.card_role IS NOT failed.card_role OR unsafe.target_role IS NOT failed.target_role
              OR unsafe.delivery_order <= failed.delivery_order)
        )
      ORDER BY q.created_at, failed.delivery_order
    `).all() as Array<{ lane_key: string; failed_reply_id: string; latest_reply_id: string }>;
    let releasedSupersededWorkerMainUpdates = 0;
    for (const row of supersededUpdates) {
      if (!this.consumeReplaySafeSupersession(row.failed_reply_id, row.latest_reply_id, timestamp)) continue;
      this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'dismissed', error = 'Superseded by a newer authoritative snapshot', updated_at = ?
        WHERE lane_key = ? AND state = 'pending' AND id != ?
          AND claim_attempt_id IS NULL AND first_claimed_at IS NULL`).run(timestamp, row.lane_key, row.latest_reply_id);
      const recovery = this.context.database.prepare(`UPDATE delivery_recoveries
        SET state = 'replacement_pending', action = 'released_newer_snapshot', replacement_reply_id = ?, updated_at = ?
        WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')`).run(row.latest_reply_id, timestamp, row.failed_reply_id);
      if (recovery.changes !== 1) throw new Error(`Failed to supersede update recovery ${row.failed_reply_id}`);
      const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'released_newer_snapshot', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      if (released.changes !== 1) throw new Error(`Failed to release superseded update quarantine ${row.failed_reply_id}`);
      this.queue.notifyScopeMutation(row.lane_key);
      releasedSupersededWorkerMainUpdates += 1;
    }
    const topicUpdates = this.context.database.prepare(`
      WITH latest_pending_by_lane AS (
        SELECT id,lane_key FROM (
          SELECT id,lane_key,
            ROW_NUMBER() OVER(PARTITION BY lane_key ORDER BY view_version DESC,delivery_order DESC) AS lane_rank
          FROM outbound_replies WHERE state='pending'
        ) WHERE lane_rank=1
      )
      SELECT q.lane_key, failed.id AS failed_reply_id, pending.id AS latest_reply_id,
        CASE WHEN failed.target_role = 'session_status' THEN 'primary-main' ELSE 'pane-entry' END AS projection_kind
      FROM outbox_lane_quarantines q
      JOIN outbound_replies failed ON failed.id = q.failed_reply_id
      JOIN topic_views topic ON topic.binding_id = failed.binding_id
      JOIN latest_pending_by_lane latest ON latest.lane_key=q.lane_key
      JOIN outbound_replies pending ON pending.id=latest.id
        AND pending.kind = 'card_update'
        AND pending.gateway_id = failed.gateway_id
        AND pending.binding_id = failed.binding_id
        AND pending.prompt_id IS NULL AND pending.worker_turn_id IS NULL AND pending.worker_id IS NULL
        AND pending.root_message_id = failed.root_message_id
        AND pending.target_role IS failed.target_role
        AND pending.view_version = CAST(json_extract(topic.state_json, '$.viewVersion') AS INTEGER)
        AND pending.delivery_order > failed.delivery_order
        AND pending.claim_attempt_id IS NULL AND pending.first_claimed_at IS NULL
      WHERE q.state = 'active' AND q.lane_class IN ('replaceable_card','main_card','immutable')
        AND failed.state = 'dead_letter' AND failed.kind = 'card_update'
        AND failed.effect_certainty IN ('not-started','rejected')
        AND failed.auto_recovery_count = 0
        AND failed.binding_id IS NOT NULL AND failed.prompt_id IS NULL
        AND failed.worker_turn_id IS NULL AND failed.worker_id IS NULL
        AND failed.root_message_id IS NOT NULL
        AND failed.view_version IS NOT NULL AND pending.view_version > failed.view_version
        AND ((failed.target_role = 'session_status'
              AND failed.idempotency_key LIKE 'main-card:update:' || failed.binding_id || ':%'
              AND pending.idempotency_key LIKE 'main-card:update:' || failed.binding_id || ':%')
          OR (failed.target_role IS NULL
              AND failed.idempotency_key LIKE 'pane-entry:update:%'
              AND pending.idempotency_key LIKE 'pane-entry:update:%'))
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies unsafe
          WHERE unsafe.lane_key = q.lane_key AND unsafe.state = 'pending'
            AND (unsafe.claim_attempt_id IS NOT NULL OR unsafe.first_claimed_at IS NOT NULL
              OR unsafe.kind != 'card_update' OR unsafe.gateway_id != failed.gateway_id
              OR unsafe.binding_id IS NOT failed.binding_id OR unsafe.prompt_id IS NOT NULL
              OR unsafe.worker_turn_id IS NOT NULL OR unsafe.worker_id IS NOT NULL
              OR unsafe.root_message_id IS NOT failed.root_message_id
              OR unsafe.target_role IS NOT failed.target_role
              OR unsafe.view_version > pending.view_version
              OR unsafe.delivery_order <= failed.delivery_order)
        )
      ORDER BY q.created_at, failed.delivery_order
    `).all() as Array<{ lane_key: string; failed_reply_id: string; latest_reply_id: string; projection_kind: "primary-main" | "pane-entry" }>;
    let releasedSupersededPrimaryMainUpdates = 0;
    let releasedSupersededPaneEntryUpdates = 0;
    for (const row of topicUpdates) {
      if (!this.consumeReplaySafeSupersession(row.failed_reply_id, row.latest_reply_id, timestamp)) continue;
      this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'dismissed', error = 'Superseded by a newer authoritative snapshot', updated_at = ?
        WHERE lane_key = ? AND state = 'pending' AND id != ?
          AND claim_attempt_id IS NULL AND first_claimed_at IS NULL`).run(timestamp, row.lane_key, row.latest_reply_id);
      const recovery = this.context.database.prepare(`UPDATE delivery_recoveries
        SET state = 'replacement_pending', action = 'released_newer_snapshot', replacement_reply_id = ?, updated_at = ?
        WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')`).run(row.latest_reply_id, timestamp, row.failed_reply_id);
      if (recovery.changes !== 1) throw new Error(`Failed to supersede topic update recovery ${row.failed_reply_id}`);
      const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'released_newer_snapshot', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      if (released.changes !== 1) throw new Error(`Failed to release superseded topic update quarantine ${row.failed_reply_id}`);
      this.queue.notifyScopeMutation(row.lane_key);
      if (row.projection_kind === "primary-main") releasedSupersededPrimaryMainUpdates += 1;
      else releasedSupersededPaneEntryUpdates += 1;
    }
    this.repairInvalidReleasedSnapshotTuples(timestamp);
    return {
      resolvedSupersededAnswerTargets,
      releasedSupersededWorkerMainUpdates,
      ...(releasedSupersededPrimaryMainUpdates > 0 ? { releasedSupersededPrimaryMainUpdates } : {}),
      ...(releasedSupersededPaneEntryUpdates > 0 ? { releasedSupersededPaneEntryUpdates } : {}),
    };
  }

  private recoverLegacyExpiredAnswerTargets(timestamp: string): void {
    const rows = this.context.database.prepare(`
      SELECT failed.id AS failed_reply_id, failed.lane_key, failed.gateway_id,
        failed.binding_id, failed.prompt_id, failed.stream_page_index,
        failed.root_message_id, failed.view_version, failed.idempotency_key,
        failed.gateway_profile_id, failed.gateway_plan_json
      FROM outbox_lane_quarantines quarantine
      JOIN outbound_replies failed ON failed.id = quarantine.failed_reply_id
      JOIN delivery_recoveries recovery ON recovery.failed_reply_id = failed.id
      JOIN run_cards card ON card.prompt_id = failed.prompt_id
        AND card.binding_id = failed.binding_id
        AND card.answer_page_index = failed.stream_page_index
      JOIN answer_pages page ON page.prompt_id = failed.prompt_id
        AND page.page_index = failed.stream_page_index
        AND page.message_id = failed.root_message_id
        AND page.state IN ('active','finished','frozen')
      WHERE quarantine.state = 'active'
        AND quarantine.lane_class IN ('replaceable_card','immutable')
        AND failed.gateway_id = 'feishu:primary'
        AND failed.state = 'dead_letter' AND failed.kind = 'card_update'
        AND failed.card_role = 'answer' AND failed.target_role IS NULL
        AND failed.prompt_id IS NOT NULL AND failed.binding_id IS NOT NULL
        AND failed.worker_id IS NULL AND failed.worker_turn_id IS NULL
        AND failed.stream_page_index IS NOT NULL AND failed.root_message_id IS NOT NULL
        AND failed.view_version IS NOT NULL
        AND failed.failure_class = 'permanent' AND failed.effect_certainty = 'rejected'
        AND failed.lark_error_code IN ('230001','230031')
        AND failed.projection_key IS NULL
        AND recovery.state IN ('unresolved','replacement_pending')
        AND recovery.action = 'blocked'
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies unsafe
          WHERE unsafe.lane_key = failed.lane_key AND unsafe.state = 'pending'
            AND (unsafe.claim_attempt_id IS NOT NULL OR unsafe.first_claimed_at IS NOT NULL
              OR unsafe.kind != 'card_update' OR unsafe.gateway_id != failed.gateway_id
              OR unsafe.binding_id IS NOT failed.binding_id OR unsafe.prompt_id IS NOT failed.prompt_id
              OR unsafe.worker_id IS NOT NULL OR unsafe.worker_turn_id IS NOT NULL
              OR unsafe.stream_page_index IS NOT failed.stream_page_index
              OR unsafe.root_message_id IS NOT failed.root_message_id
              OR unsafe.card_role IS NOT 'answer' OR unsafe.target_role IS NOT NULL
              OR unsafe.delivery_order <= failed.delivery_order)
        )
      ORDER BY quarantine.created_at, failed.delivery_order
    `).all() as Array<{
      failed_reply_id: string;
      lane_key: string;
      gateway_id: string;
      gateway_profile_id: string;
      binding_id: string;
      prompt_id: string;
      stream_page_index: number;
      root_message_id: string;
      view_version: number;
      idempotency_key: string;
      gateway_plan_json: string | null;
    }>;
    for (const row of rows) {
      if (row.idempotency_key !== `run-card:update:${row.prompt_id}:answer:${row.view_version}`) continue;
      if (!matchesPersistedPrimaryAnswerExpiredTargetPlan(row.gateway_plan_json, {
        gatewayId: row.gateway_id,
        gatewayProfileId: row.gateway_profile_id,
        messageId: row.root_message_id,
      })) continue;
      this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'dismissed', error = 'Dismissed after Gateway rejected the expired Answer target', updated_at = ?
        WHERE lane_key = ? AND state = 'pending' AND kind = 'card_update'
          AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
          AND gateway_id = ? AND binding_id = ? AND prompt_id = ?
          AND worker_id IS NULL AND worker_turn_id IS NULL
          AND stream_page_index = ? AND root_message_id = ?
          AND card_role = 'answer' AND target_role IS NULL
          AND delivery_order > (SELECT delivery_order FROM outbound_replies WHERE id = ?)`
      ).run(timestamp, row.lane_key, row.gateway_id, row.binding_id, row.prompt_id, row.stream_page_index, row.root_message_id, row.failed_reply_id);
      this.context.database.prepare(`UPDATE answer_pages
        SET state = 'frozen', delivery_mode = 'static', updated_at = ?
        WHERE prompt_id = ? AND page_index = ? AND message_id = ?
          AND state IN ('active','finished','frozen')`
      ).run(timestamp, row.prompt_id, row.stream_page_index, row.root_message_id);
      const recovery = this.context.database.prepare(`UPDATE delivery_recoveries
        SET state = 'unresolved', action = 'expired_view_target',
          semantic_recovery_proof = ?,
          replacement_reply_id = NULL, updated_at = ?
        WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending') AND action = 'blocked'`
      ).run(PRIMARY_ANSWER_EXPIRED_TARGET_PLAN_PROOF, timestamp, row.failed_reply_id);
      if (recovery.changes !== 1) continue;
      const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'expired_view_target', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`
      ).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      if (released.changes !== 1) throw new Error(`Failed to release expired Answer quarantine ${row.failed_reply_id}`);
      this.queue.notifyScopeMutation(row.lane_key);
    }
  }

  private repairInvalidReleasedSnapshotTuples(timestamp: string): void {
    const compatibleWorkerMainRows = this.context.database.prepare(`
      SELECT failed.id AS failed_reply_id, failed.lane_key, pending.id AS replacement_reply_id
      FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      JOIN worker_main_views main ON main.worker_id = failed.worker_id
        AND main.worker_session_generation = failed.worker_session_generation
        AND main.message_id = failed.root_message_id
      JOIN outbound_replies pending ON pending.lane_key = failed.lane_key
        AND pending.state = 'pending' AND pending.kind = 'card_update'
        AND pending.gateway_id = failed.gateway_id
        AND pending.binding_id IS failed.binding_id
        AND pending.worker_id IS failed.worker_id
        AND pending.worker_session_generation IS failed.worker_session_generation
        AND pending.prompt_id IS NULL AND pending.worker_turn_id IS NULL
        AND pending.root_message_id IS failed.root_message_id
        AND pending.card_role IS failed.card_role AND pending.target_role IS failed.target_role
        AND pending.view_version = main.view_version
        AND pending.delivery_order > failed.delivery_order
        AND pending.id = (
          SELECT candidate.id FROM outbound_replies candidate
          WHERE candidate.lane_key = failed.lane_key AND candidate.state = 'pending'
          ORDER BY candidate.view_version DESC, candidate.delivery_order DESC LIMIT 1
        )
      WHERE recovery.action = 'released_newer_snapshot'
        AND recovery.replacement_reply_id IS NULL
        AND recovery.state IN ('unresolved','replacement_pending')
        AND failed.state = 'dead_letter' AND failed.kind = 'card_update'
        AND failed.worker_id IS NOT NULL AND failed.worker_session_generation IS NOT NULL
        AND failed.prompt_id IS NULL AND failed.worker_turn_id IS NULL
        AND failed.root_message_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies unsafe
          WHERE unsafe.lane_key = failed.lane_key AND unsafe.state = 'pending'
            AND (unsafe.claim_attempt_id IS NOT NULL OR unsafe.first_claimed_at IS NOT NULL
              OR unsafe.kind != 'card_update' OR unsafe.gateway_id != failed.gateway_id
              OR unsafe.binding_id IS NOT failed.binding_id
              OR unsafe.worker_id IS NOT failed.worker_id
              OR unsafe.worker_session_generation IS NOT failed.worker_session_generation
              OR unsafe.prompt_id IS NOT NULL OR unsafe.worker_turn_id IS NOT NULL
              OR unsafe.root_message_id IS NOT failed.root_message_id
              OR unsafe.card_role IS NOT failed.card_role OR unsafe.target_role IS NOT failed.target_role
              OR unsafe.delivery_order <= failed.delivery_order)
        )
    `).all() as Array<{ failed_reply_id: string; lane_key: string; replacement_reply_id: string }>;
    for (const row of compatibleWorkerMainRows) this.linkInvalidReleasedSnapshotTuple(row.failed_reply_id, row.lane_key, row.replacement_reply_id, timestamp);

    const compatibleTopicRows = this.context.database.prepare(`
      SELECT failed.id AS failed_reply_id, failed.lane_key, pending.id AS replacement_reply_id
      FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      JOIN topic_views topic ON topic.binding_id = failed.binding_id
      JOIN outbound_replies pending ON pending.lane_key = failed.lane_key
        AND pending.state = 'pending' AND pending.kind = 'card_update'
        AND pending.gateway_id = failed.gateway_id
        AND pending.binding_id = failed.binding_id
        AND pending.prompt_id IS NULL AND pending.worker_turn_id IS NULL AND pending.worker_id IS NULL
        AND pending.root_message_id = failed.root_message_id
        AND pending.target_role IS failed.target_role
        AND pending.view_version = CAST(json_extract(topic.state_json, '$.viewVersion') AS INTEGER)
        AND pending.delivery_order > failed.delivery_order
        AND pending.claim_attempt_id IS NULL AND pending.first_claimed_at IS NULL
        AND pending.id = (
          SELECT candidate.id FROM outbound_replies candidate
          WHERE candidate.lane_key = failed.lane_key AND candidate.state = 'pending'
          ORDER BY candidate.view_version DESC, candidate.delivery_order DESC LIMIT 1
        )
      WHERE recovery.action = 'released_newer_snapshot'
        AND recovery.replacement_reply_id IS NULL
        AND recovery.state IN ('unresolved','replacement_pending')
        AND failed.state = 'dead_letter' AND failed.kind = 'card_update'
        AND failed.binding_id IS NOT NULL AND failed.prompt_id IS NULL
        AND failed.worker_turn_id IS NULL AND failed.worker_id IS NULL
        AND failed.root_message_id IS NOT NULL
        AND failed.view_version IS NOT NULL AND pending.view_version > failed.view_version
        AND ((failed.target_role = 'session_status'
              AND failed.idempotency_key LIKE 'main-card:update:' || failed.binding_id || ':%'
              AND pending.idempotency_key LIKE 'main-card:update:' || failed.binding_id || ':%')
          OR (failed.target_role IS NULL
              AND failed.idempotency_key LIKE 'pane-entry:update:%'
              AND pending.idempotency_key LIKE 'pane-entry:update:%'))
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies unsafe
          WHERE unsafe.lane_key = failed.lane_key AND unsafe.state = 'pending'
            AND (unsafe.claim_attempt_id IS NOT NULL OR unsafe.first_claimed_at IS NOT NULL
              OR unsafe.kind != 'card_update' OR unsafe.gateway_id != failed.gateway_id
              OR unsafe.binding_id IS NOT failed.binding_id OR unsafe.prompt_id IS NOT NULL
              OR unsafe.worker_turn_id IS NOT NULL OR unsafe.worker_id IS NOT NULL
              OR unsafe.root_message_id IS NOT failed.root_message_id
              OR unsafe.target_role IS NOT failed.target_role
              OR unsafe.view_version > pending.view_version
              OR unsafe.delivery_order <= failed.delivery_order)
        )
    `).all() as Array<{ failed_reply_id: string; lane_key: string; replacement_reply_id: string }>;
    for (const row of compatibleTopicRows) this.linkInvalidReleasedSnapshotTuple(row.failed_reply_id, row.lane_key, row.replacement_reply_id, timestamp);

    const compatibleCurrentPointerRows = this.context.database.prepare(`
      SELECT failed.id AS failed_reply_id, failed.lane_key, pending.id AS replacement_reply_id
      FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      JOIN outbox_lane_quarantines quarantine ON quarantine.failed_reply_id = failed.id
        AND quarantine.lane_key = failed.lane_key
      JOIN outbound_replies pending ON pending.lane_key = failed.lane_key
      WHERE recovery.action = 'released_newer_snapshot'
        AND recovery.replacement_reply_id IS NULL
        AND recovery.state IN ('unresolved','replacement_pending')
        AND failed.state = 'dead_letter' AND failed.kind = 'card_update'
        AND pending.state = 'pending' AND pending.kind = 'card_update'
        AND pending.delivery_order > failed.delivery_order
        AND pending.gateway_id = failed.gateway_id
        AND pending.binding_id IS failed.binding_id
        AND pending.prompt_id IS failed.prompt_id
        AND pending.worker_id IS failed.worker_id
        AND pending.worker_session_generation IS failed.worker_session_generation
        AND pending.worker_turn_id IS failed.worker_turn_id
        AND pending.root_message_id IS failed.root_message_id
        AND pending.card_role IS failed.card_role
        AND pending.target_role IS failed.target_role
        AND pending.claim_attempt_id IS NULL AND pending.first_claimed_at IS NULL
        AND (
          failed.view_version IS NULL
          OR pending.view_version > failed.view_version
          OR (failed.projection_key IS NOT NULL
            AND pending.projection_key = failed.projection_key
            AND pending.snapshot_revision > failed.snapshot_revision)
        )
        AND (
          failed.projection_key IS NULL
          OR (pending.projection_key = failed.projection_key
            AND pending.snapshot_revision > failed.snapshot_revision)
        )
        AND pending.id = (
          SELECT candidate.id FROM outbound_replies candidate
          WHERE candidate.lane_key = failed.lane_key AND candidate.state = 'pending'
          ORDER BY COALESCE(candidate.view_version, 0) DESC, candidate.delivery_order DESC LIMIT 1
        )
    `).all() as Array<{ failed_reply_id: string; lane_key: string; replacement_reply_id: string }>;
    for (const row of compatibleCurrentPointerRows) this.linkInvalidReleasedSnapshotTuple(row.failed_reply_id, row.lane_key, row.replacement_reply_id, timestamp);

  }

  private consumeReplaySafeSupersession(failedReplyId: string, replacementReplyId: string, timestamp: string): boolean {
    const failed = this.queue.get(failedReplyId);
    if (!failed || !isReplaySafeSupersession({
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
    })) return false;
    const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',
      auto_recovery_count=auto_recovery_count+1,
      error='Superseded by a newer authoritative snapshot after confirmed non-application',updated_at=?
      WHERE id=? AND state='dead_letter' AND effect_certainty IN ('not-started','rejected')
        AND auto_recovery_count=0 AND kind='card_update'
        AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL`
    ).run(timestamp, failedReplyId);
    if (dismissed.changes !== 1) return false;
    transferDeliveryPrerequisites(this.context, failedReplyId, replacementReplyId);
    return true;
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

  private linkInvalidReleasedSnapshotTuple(failedReplyId: string, laneKey: string, replacementReplyId: string, timestamp: string): void {
    const updated = this.context.database.prepare(`UPDATE delivery_recoveries
      SET state = 'replacement_pending', action = 'released_newer_snapshot', replacement_reply_id = ?, updated_at = ?
      WHERE failed_reply_id = ? AND action = 'released_newer_snapshot' AND replacement_reply_id IS NULL
        AND state IN ('unresolved','replacement_pending')`).run(replacementReplyId, timestamp, failedReplyId);
    if (updated.changes !== 1) return;
    this.context.database.prepare(`UPDATE outbox_lane_quarantines
      SET state = 'released', action = 'released_newer_snapshot', released_at = COALESCE(released_at, ?), updated_at = ?
      WHERE failed_reply_id = ? AND lane_key = ?`).run(timestamp, timestamp, failedReplyId, laneKey);
    this.queue.notifyScopeMutation(laneKey);
  }
}
