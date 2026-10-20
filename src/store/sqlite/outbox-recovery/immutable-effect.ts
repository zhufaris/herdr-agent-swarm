import { randomUUID } from "node:crypto";
import type { SqliteContext } from "../context.js";
import type { SqliteOutboxQueueStore } from "../outbox-queue-store.js";
import type { EnqueueOutboundReplyInput } from "../outbox-queue-store.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../../domain/ports/outbox.js";
import { resolvedPromptReferenceSql } from "../prompt-identity-corrections.js";
import { WORKER_EXPIRED_TARGET_PROOF_LIST, matchesPersistedWorkerExpiredTargetProof } from "./semantic-recovery-proof.js";

export interface ImmutableEffectDismissalResult {
  dismissedNotices: number;
  dismissedRejectedImmutableEffects: number;
  dismissedExpiredWorkerTargets?: number;
  dismissedDefunctTargets?: number;
  retiredExpiredMessageDeletes?: number;
  releasedRejectedWorkerTurnFinalizers?: number;
  releasedAuthoritativeWorkerTurnSnapshots?: number;
}

export class ImmutableEffectRecovery {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
  ) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  private reserveWorkerRecovery(input: EnqueueOutboundReplyInput) {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Immutable Effect Recovery prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

  dismissRecoverableEffects(timestamp: string): ImmutableEffectDismissalResult {
    const notices = this.context.database.prepare(`
      SELECT o.id, o.lane_key
      FROM outbox_lane_quarantines q JOIN outbound_replies o ON o.id = q.failed_reply_id
      WHERE q.state = 'active' AND q.lane_class = 'immutable' AND q.failure_class = 'transient'
        AND o.state = 'dead_letter' AND o.kind = 'card_reply' AND o.binding_id IS NULL AND o.prompt_id IS NULL AND o.selection_id IS NULL
        AND o.idempotency_key LIKE 'disconnected-topic:%'
    `).all() as Array<{ id: string; lane_key: string }>;
    let dismissedNotices = 0;
    for (const row of notices) {
      const updated = this.context.database.prepare("UPDATE outbound_replies SET state = 'dismissed', updated_at = ? WHERE id = ? AND state = 'dead_letter'").run(timestamp, row.id);
      if (updated.changes !== 1) continue;
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_dismiss', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.id);
      this.queue.notifyScopeMutation(row.lane_key);
      dismissedNotices += 1;
    }
    const expiredWorkerTargetRows = this.context.database.prepare(`
      SELECT failed.id AS failed_reply_id, failed.kind, failed.lane_key, failed.gateway_id, failed.binding_id, failed.prompt_id,
        failed.worker_id, failed.worker_session_generation, failed.worker_turn_id, failed.stream_page_index,
        failed.root_message_id, failed.card_role, failed.target_role, failed.selection_id, failed.payload, failed.view_version, recovery.semantic_recovery_proof
      FROM outbound_replies failed
      JOIN delivery_recoveries recovery ON recovery.failed_reply_id = failed.id
      WHERE failed.state = 'dead_letter' AND failed.kind = 'card_update'
        AND failed.gateway_id = 'feishu:primary'
        AND failed.failure_class = 'permanent' AND failed.effect_certainty = 'rejected'
        AND failed.lark_error_code = '230031'
        AND recovery.state IN ('unresolved','replacement_pending')
        AND recovery.semantic_recovery_proof IN (${WORKER_EXPIRED_TARGET_PROOF_LIST.map(() => "?").join(", ")})
      ORDER BY failed.delivery_order
    `).all(...WORKER_EXPIRED_TARGET_PROOF_LIST) as Array<{
      failed_reply_id: string;
      kind: string;
      lane_key: string;
      gateway_id: string;
      binding_id: string | null;
      prompt_id: string | null;
      worker_id: string | null;
      worker_session_generation: number | null;
      worker_turn_id: string | null;
      stream_page_index: number | null;
      root_message_id: string | null;
      card_role: string | null;
      target_role: string | null;
      selection_id: string | null;
      payload: string;
      view_version: number | null;
      semantic_recovery_proof: string | null;
    }>;
    const exactExpiredWorkerTargetRows = expiredWorkerTargetRows.filter((row) => matchesPersistedWorkerExpiredTargetProof(row.semantic_recovery_proof, row));
    let dismissedExpiredWorkerTargets = 0;
    for (const row of exactExpiredWorkerTargetRows) {
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
        row.lane_key,
        row.failed_reply_id,
        row.gateway_id,
        row.binding_id,
        row.prompt_id,
        row.worker_id,
        row.worker_session_generation,
        row.worker_turn_id,
        row.stream_page_index,
        row.root_message_id,
        row.card_role,
        row.target_role,
        row.selection_id,
      );
      const replacementReplyId = enqueueExpiredWorkerTargetReplacement(this.context, this.queue, row, (input) => this.reserveWorkerRecovery(input));
      if (!replacementReplyId) continue;
      const recovery = this.context.database.prepare(`UPDATE delivery_recoveries
        SET state = 'replacement_pending', action = 'startup_replace_expired_worker_target', replacement_reply_id = ?, updated_at = ?
        WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')`).run(replacementReplyId, timestamp, row.failed_reply_id);
      if (recovery.changes !== 1) continue;
      const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'startup_replace_expired_worker_target', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      this.queue.notifyScopeMutation(row.lane_key);
      dismissedExpiredWorkerTargets += 1;
    }
    const defunctTargetRows = this.context.database.prepare(`
      SELECT q.lane_key, q.failed_reply_id
      FROM outbox_lane_quarantines q
      JOIN outbound_replies failed ON failed.id = q.failed_reply_id
      WHERE q.state = 'active' AND q.lane_class = 'immutable'
        AND failed.state = 'dead_letter' AND failed.kind = 'card_reply'
        AND failed.failure_class = 'permanent' AND failed.effect_certainty = 'rejected'
        AND failed.lark_error_code IN ('230011', '230019')
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies pending
          WHERE pending.lane_key = q.lane_key AND pending.state = 'pending'
        )
      ORDER BY q.created_at, failed.delivery_order
    `).all() as Array<{ lane_key: string; failed_reply_id: string }>;
    let dismissedDefunctTargets = 0;
    for (const row of defunctTargetRows) {
      const dismissed = this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'dismissed', error = 'Dismissed after provider confirmed the delivery target no longer exists', updated_at = ?
        WHERE id = ? AND state = 'dead_letter' AND failure_class = 'permanent'
          AND effect_certainty = 'rejected' AND lark_error_code IN ('230011', '230019')`).run(timestamp, row.failed_reply_id);
      if (dismissed.changes !== 1) continue;
      this.context.database.prepare(`UPDATE delivery_recoveries
        SET state = 'dismissed', action = 'startup_dismiss_defunct_target', resolved_at = ?, updated_at = ?
        WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')`).run(timestamp, timestamp, row.failed_reply_id);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'startup_dismiss_defunct_target', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      this.queue.notifyScopeMutation(row.lane_key);
      dismissedDefunctTargets += 1;
    }
    const deliveredWorkerFinalizers = this.context.database.prepare(`
      SELECT q.lane_key, q.failed_reply_id
      FROM outbox_lane_quarantines q
      JOIN outbound_replies failed ON failed.id = q.failed_reply_id
      JOIN worker_turn_cards card ON card.turn_id = failed.worker_turn_id
      JOIN worker_turn_card_pages page ON page.turn_id = failed.worker_turn_id
        AND page.page_index = failed.stream_page_index
        AND page.state = 'active'
      WHERE q.state = 'active' AND q.lane_class = 'immutable'
        AND failed.state = 'dead_letter' AND failed.kind = 'stream_finish'
        AND failed.effect_certainty = 'rejected' AND failed.lark_error_code = '300307'
        AND failed.worker_turn_id IS NOT NULL AND failed.stream_page_index IS NOT NULL
        AND card.card_id = failed.root_message_id
        AND card.delivered_version >= card.view_version
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies unsafe
          WHERE unsafe.lane_key = q.lane_key AND unsafe.state = 'pending'
            AND (unsafe.claim_attempt_id IS NOT NULL OR unsafe.first_claimed_at IS NOT NULL
              OR unsafe.worker_turn_id IS NOT failed.worker_turn_id
              OR unsafe.stream_page_index IS NOT failed.stream_page_index
              OR unsafe.kind != 'stream_finish')
        )
      ORDER BY q.created_at, failed.delivery_order
    `).all() as Array<{ lane_key: string; failed_reply_id: string }>;
    let dismissedRejectedImmutableEffects = 0;
    for (const row of deliveredWorkerFinalizers) {
      this.context.database.prepare(`UPDATE worker_turn_card_pages
        SET state = 'finished', updated_at = ?
        WHERE turn_id = (SELECT worker_turn_id FROM outbound_replies WHERE id = ?)
          AND page_index = (SELECT stream_page_index FROM outbound_replies WHERE id = ?)
          AND state = 'active'`).run(timestamp, row.failed_reply_id, row.failed_reply_id);
      this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'dismissed', error = 'Obsolete after the authoritative Worker card snapshot was delivered', updated_at = ?
        WHERE lane_key = ? AND state = 'pending' AND kind = 'stream_finish'
          AND claim_attempt_id IS NULL AND first_claimed_at IS NULL`).run(timestamp, row.lane_key);
      const recovery = this.context.database.prepare(`UPDATE delivery_recoveries
        SET state = 'dismissed', action = 'startup_terminalized', resolved_at = ?, updated_at = ?
        WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')`).run(timestamp, timestamp, row.failed_reply_id);
      if (recovery.changes !== 1) throw new Error(`Failed to dismiss rejected Worker finalizer ${row.failed_reply_id}`);
      const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'startup_terminalized', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      if (released.changes !== 1) throw new Error(`Failed to release delivered Worker finalizer ${row.failed_reply_id}`);
      this.queue.notifyScopeMutation(row.lane_key);
      dismissedRejectedImmutableEffects += 1;
    }
    const workerContentRows = this.context.database.prepare(`
      SELECT q.lane_key, q.failed_reply_id, current.id AS replacement_reply_id
      FROM outbox_lane_quarantines q
      JOIN outbound_replies failed ON failed.id = q.failed_reply_id
      JOIN worker_turn_cards card ON card.turn_id = failed.worker_turn_id
        AND card.phase IN ('completed','failed','cancelled','dispatch-uncertain')
      JOIN worker_turn_card_pages page ON page.turn_id = card.turn_id
        AND page.page_index = failed.stream_page_index
        AND page.state IN ('active','finished')
        AND page.message_id IS NOT NULL AND page.card_id IS NOT NULL
      JOIN outbound_replies current ON current.gateway_id = failed.gateway_id
        AND current.state = 'pending' AND current.kind = 'card_update'
        AND current.worker_turn_id = failed.worker_turn_id
        AND current.stream_page_index IS failed.stream_page_index
        AND current.view_version = card.view_version
        AND current.root_message_id = page.message_id
        AND current.first_claimed_at IS NULL AND current.claim_attempt_id IS NULL
        AND current.idempotency_key = 'worker-turn:hydrate:' || failed.worker_turn_id || ':' || failed.stream_page_index || ':' || page.card_id || ':' || card.view_version || ':' || card.phase || ':' || page.state
        AND current.id = (
          SELECT candidate.id FROM outbound_replies candidate
          WHERE candidate.gateway_id = failed.gateway_id
            AND candidate.worker_turn_id = failed.worker_turn_id
            AND candidate.stream_page_index IS failed.stream_page_index
            AND candidate.state = 'pending' AND candidate.kind = 'card_update'
          ORDER BY candidate.view_version DESC, candidate.delivery_order DESC LIMIT 1
        )
      WHERE q.state = 'active' AND q.lane_class = 'immutable'
        AND failed.state = 'dead_letter' AND failed.kind = 'stream_content'
        AND failed.worker_turn_id IS NOT NULL AND failed.stream_page_index IS NOT NULL
        AND failed.view_version IS NOT NULL AND current.view_version >= failed.view_version
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies unsafe
          WHERE unsafe.lane_key = q.lane_key AND unsafe.state = 'pending'
            AND (unsafe.claim_attempt_id IS NOT NULL OR unsafe.first_claimed_at IS NOT NULL
              OR unsafe.worker_turn_id IS NOT failed.worker_turn_id
              OR unsafe.stream_page_index IS NOT failed.stream_page_index
              OR unsafe.kind NOT IN ('card_update','stream_content','stream_finish')
              OR (unsafe.kind = 'card_update' AND unsafe.id != current.id))
        )
      ORDER BY q.created_at, failed.delivery_order
    `).all() as Array<{ lane_key: string; failed_reply_id: string; replacement_reply_id: string }>;
    let releasedAuthoritativeWorkerTurnSnapshots = 0;
    for (const row of workerContentRows) {
      this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'dismissed', error = 'Superseded by the authoritative terminal Worker card snapshot', updated_at = ?
        WHERE lane_key = ? AND state = 'pending' AND kind IN ('stream_content','stream_finish')
          AND claim_attempt_id IS NULL AND first_claimed_at IS NULL`).run(timestamp, row.lane_key);
      const recovery = this.context.database.prepare(`UPDATE delivery_recoveries
        SET state = 'replacement_pending', action = 'released_worker_turn_snapshot', replacement_reply_id = ?, updated_at = ?
        WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')`).run(row.replacement_reply_id, timestamp, row.failed_reply_id);
      if (recovery.changes !== 1) throw new Error(`Failed to supersede Worker content ${row.failed_reply_id}`);
      const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'released_worker_turn_snapshot', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      if (released.changes !== 1) throw new Error(`Failed to release Worker content lane ${row.failed_reply_id}`);
      this.queue.notifyScopeMutation(row.lane_key);
      releasedAuthoritativeWorkerTurnSnapshots += 1;
    }
    const rejectedWorkerFinalizers = this.context.database.prepare(`
      SELECT q.lane_key, q.failed_reply_id, current.id AS replacement_reply_id
      FROM outbox_lane_quarantines q
      JOIN outbound_replies failed ON failed.id = q.failed_reply_id
      JOIN worker_turn_cards card ON card.turn_id = failed.worker_turn_id
      JOIN outbound_replies current ON current.lane_key = q.lane_key
        AND current.state = 'pending' AND current.kind = 'card_update'
        AND current.worker_turn_id = failed.worker_turn_id
        AND current.stream_page_index IS failed.stream_page_index
        AND current.view_version = card.view_version
        AND current.root_message_id = card.message_id
        AND current.first_claimed_at IS NULL AND current.claim_attempt_id IS NULL
        AND current.idempotency_key LIKE 'worker-turn:hydrate:' || failed.worker_turn_id || ':%'
        AND current.id = (
          SELECT candidate.id FROM outbound_replies candidate
          WHERE candidate.lane_key = q.lane_key AND candidate.state = 'pending' AND candidate.kind = 'card_update'
          ORDER BY candidate.view_version DESC, candidate.delivery_order DESC LIMIT 1
        )
      WHERE q.state = 'active' AND q.lane_class = 'immutable'
        AND failed.state = 'dead_letter' AND failed.kind = 'stream_finish'
        AND failed.effect_certainty = 'rejected' AND failed.lark_error_code = '300307'
        AND failed.worker_turn_id IS NOT NULL AND failed.stream_page_index IS NOT NULL
        AND failed.view_version IS NOT NULL AND current.view_version > failed.view_version
        AND card.message_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies unsafe
          WHERE unsafe.lane_key = q.lane_key AND unsafe.state = 'pending'
            AND (unsafe.claim_attempt_id IS NOT NULL OR unsafe.first_claimed_at IS NOT NULL
              OR unsafe.worker_turn_id IS NOT failed.worker_turn_id
              OR unsafe.stream_page_index IS NOT failed.stream_page_index
              OR unsafe.kind NOT IN ('card_update','stream_finish'))
        )
      ORDER BY q.created_at, failed.delivery_order
    `).all() as Array<{ lane_key: string; failed_reply_id: string; replacement_reply_id: string }>;
    let releasedRejectedWorkerTurnFinalizers = 0;
    for (const row of rejectedWorkerFinalizers) {
      this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'dismissed', error = 'Superseded by the current authoritative Worker card snapshot', updated_at = ?
        WHERE lane_key = ? AND state = 'pending' AND kind = 'stream_finish'
          AND claim_attempt_id IS NULL AND first_claimed_at IS NULL`).run(timestamp, row.lane_key);
      const recovery = this.context.database.prepare(`UPDATE delivery_recoveries
        SET state = 'replacement_pending', action = 'released_worker_turn_snapshot', replacement_reply_id = ?, updated_at = ?
        WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')`).run(row.replacement_reply_id, timestamp, row.failed_reply_id);
      if (recovery.changes !== 1) throw new Error(`Failed to supersede rejected Worker finalizer ${row.failed_reply_id}`);
      const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'released_worker_turn_snapshot', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      if (released.changes !== 1) throw new Error(`Failed to release rejected Worker finalizer ${row.failed_reply_id}`);
      this.queue.notifyScopeMutation(row.lane_key);
      releasedRejectedWorkerTurnFinalizers += 1;
    }
    return {
      dismissedNotices,
      dismissedRejectedImmutableEffects,
      ...(dismissedExpiredWorkerTargets > 0 ? { dismissedExpiredWorkerTargets } : {}),
      ...(dismissedDefunctTargets > 0 ? { dismissedDefunctTargets } : {}),
      ...(releasedRejectedWorkerTurnFinalizers > 0 ? { releasedRejectedWorkerTurnFinalizers } : {}),
      ...(releasedAuthoritativeWorkerTurnSnapshots > 0 ? { releasedAuthoritativeWorkerTurnSnapshots } : {})
    };
  }

  terminalizeQuarantines(timestamp: string): number {
    const terminalRows = this.context.database.prepare(`
      SELECT q.lane_key, q.failed_reply_id
      FROM outbox_lane_quarantines q
      JOIN outbound_replies failed ON failed.id = q.failed_reply_id
      JOIN prompt_jobs prompt ON prompt.id = ${resolvedPromptReferenceSql("failed.prompt_id", { bindingIdColumn: "failed.binding_id" })}
      JOIN run_cards card ON card.prompt_id = prompt.id
      WHERE q.state = 'active' AND q.lane_class IN ('answer_stream', 'immutable')
        AND failed.state = 'dead_letter' AND failed.card_role = 'answer'
        AND prompt.state IN ('delivered', 'failed', 'cancelled') AND prompt.observation_state = 'completed'
        AND card.phase IN ('completed', 'failed')
        AND NOT EXISTS (SELECT 1 FROM outbound_replies pending WHERE pending.lane_key = q.lane_key AND pending.state = 'pending')
      ORDER BY q.created_at
    `).all() as Array<{ lane_key: string; failed_reply_id: string }>;
    let terminalizedQuarantines = 0;
    for (const row of terminalRows) {
      const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'startup_terminalized', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      if (released.changes !== 1) continue;
      this.queue.notifyScopeMutation(row.lane_key);
      terminalizedQuarantines += 1;
    }
    return terminalizedQuarantines;
  }
}

const EXPIRED_WORKER_TARGET_MARKER = "🕰️ 原卡片已过期 · 已恢复到此卡";

function enqueueExpiredWorkerTargetReplacement(
  context: SqliteContext,
  queue: SqliteOutboxQueueStore,
  row: {
    failed_reply_id: string;
    worker_id: string | null;
    worker_session_generation: number | null;
    worker_turn_id: string | null;
    stream_page_index: number | null;
    binding_id: string | null;
    root_message_id: string | null;
    payload: string;
    view_version: number | null;
  },
  reserve: (input: EnqueueOutboundReplyInput) => { id: string } = (input) => queue.enqueue(input)
): string | null {
  if (row.worker_id !== null && row.worker_session_generation !== null && row.worker_turn_id === null) {
    const main = context.database.prepare(`
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
    `).get(row.worker_id, row.worker_session_generation, row.root_message_id, row.binding_id, row.binding_id) as {
      parent_binding_id: string;
      view_version: number;
      worker_thread_id: string;
      chat_id: string;
    } | undefined;
    if (!main) return null;
    return reserve({
      id: randomUUID(),
      idempotencyKey: `worker-main:recovery-create:${row.failed_reply_id}`,
      workClass: "history",
      bindingId: main.parent_binding_id,
      workerId: row.worker_id,
      workerSessionGeneration: row.worker_session_generation,
      workerThreadId: main.worker_thread_id,
      targetChatId: main.chat_id,
      viewVersion: row.view_version ?? main.view_version,
      rootMessageId: null,
      kind: "group_card_create",
      payload: JSON.stringify(markedCardPayload(row.payload)),
      projectionKey: `worker-main-recovery:${row.failed_reply_id}`,
      snapshotRevision: row.view_version ?? main.view_version
    }).id;
  }
  if (row.worker_id === null && row.worker_session_generation === null && row.worker_turn_id !== null && row.stream_page_index !== null) {
    const turn = context.database.prepare(`
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
    `).get(row.worker_turn_id) as {
      view_version: number;
      worker_thread_id: string;
      chat_id: string;
      instance_id: string;
      worker_session_generation: number;
    } | undefined;
    if (!turn) return null;
    return reserve({
      id: randomUUID(),
      idempotencyKey: `worker-turn:recovery-create:${row.failed_reply_id}`,
      workClass: "history",
      bindingId: null,
      workerTurnId: row.worker_turn_id,
      streamPageIndex: row.stream_page_index,
      workerId: turn.instance_id,
      workerSessionGeneration: turn.worker_session_generation,
      workerThreadId: turn.worker_thread_id,
      targetChatId: turn.chat_id,
      viewVersion: row.view_version ?? turn.view_version,
      rootMessageId: null,
      kind: "group_card_create",
      payload: JSON.stringify(markedCardPayload(row.payload)),
      projectionKey: `worker-turn-recovery:${row.failed_reply_id}`,
      snapshotRevision: row.view_version ?? turn.view_version
    }).id;
  }
  return null;
}

function markedCardPayload(payload: string): Record<string, unknown> {
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
