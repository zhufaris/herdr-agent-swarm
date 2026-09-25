import type { SqliteContext } from "../context.js";
import type { SqliteOutboxQueueStore } from "../outbox-queue-store.js";

export interface ReplaceableCardRecoveryResult {
  resolvedSupersededAnswerTargets: number;
  releasedSupersededWorkerMainUpdates: number;
}

export class ReplaceableCardRecovery {
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
  ) {}

  recover(timestamp: string): ReplaceableCardRecoveryResult {
    const supersededAnswerRows = this.context.database.prepare(`
      SELECT q.lane_key, failed.id AS failed_reply_id, failed.prompt_id,
        replacement.id AS replacement_reply_id, replacement.delivered_message_id,
        pending.id AS latest_reply_id, pending.projection_key
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
      JOIN outbound_replies pending ON pending.lane_key = q.lane_key
        AND pending.state = 'pending' AND pending.kind = 'card_update'
        AND pending.card_role = 'answer' AND pending.prompt_id = failed.prompt_id
        AND pending.root_message_id = page.message_id
        AND pending.projection_key = 'answer-static:' || failed.prompt_id || ':' || page.page_index || ':' || page.message_id
        AND pending.delivery_order > failed.delivery_order
        AND pending.id = (
          SELECT candidate.id FROM outbound_replies candidate
          WHERE candidate.lane_key = q.lane_key AND candidate.state = 'pending'
          ORDER BY candidate.snapshot_revision DESC, candidate.delivery_order DESC LIMIT 1
        )
      WHERE q.state = 'active' AND q.lane_class IN ('replaceable_card', 'immutable')
        AND failed.state = 'dead_letter' AND failed.kind = 'card_update'
        AND failed.card_role = 'answer' AND failed.prompt_id IS NOT NULL
        AND failed.root_message_id IS NOT NULL AND failed.effect_certainty = 'uncertain'
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies unsafe
          WHERE unsafe.lane_key = q.lane_key AND unsafe.state = 'pending'
            AND (unsafe.claim_attempt_id IS NOT NULL OR unsafe.first_claimed_at IS NOT NULL
              OR unsafe.kind != 'card_update' OR unsafe.card_role IS NOT 'answer'
              OR unsafe.prompt_id IS NOT failed.prompt_id OR unsafe.root_message_id IS NOT page.message_id
              OR unsafe.projection_key IS NOT pending.projection_key
              OR unsafe.delivery_order <= failed.delivery_order)
        )
      ORDER BY q.created_at, failed.delivery_order
    `).all() as Array<{ lane_key: string; failed_reply_id: string; prompt_id: string; replacement_reply_id: string; delivered_message_id: string; latest_reply_id: string; projection_key: string }>;
    let resolvedSupersededAnswerTargets = 0;
    for (const row of supersededAnswerRows) {
      this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'dismissed', error = 'Superseded by a durably delivered Answer target', updated_at = ?
        WHERE lane_key = ? AND projection_key = ? AND state = 'pending' AND id != ?
          AND claim_attempt_id IS NULL AND first_claimed_at IS NULL`).run(timestamp, row.lane_key, row.projection_key, row.latest_reply_id);
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
      this.queue.refreshLaneHead(row.lane_key);
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
      WHERE q.state = 'active' AND q.lane_class = 'replaceable_card'
        AND failed.state = 'dead_letter' AND failed.kind = 'card_update'
        AND failed.effect_certainty = 'uncertain'
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
      this.queue.refreshLaneHead(row.lane_key);
      releasedSupersededWorkerMainUpdates += 1;
    }
    return { resolvedSupersededAnswerTargets, releasedSupersededWorkerMainUpdates };
  }
}
