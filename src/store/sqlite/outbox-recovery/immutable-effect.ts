import type { SqliteContext } from "../context.js";
import type { SqliteOutboxQueueStore } from "../outbox-queue-store.js";

export interface ImmutableEffectDismissalResult {
  dismissedNotices: number;
  dismissedRejectedImmutableEffects: number;
}

export class ImmutableEffectRecovery {
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
  ) {}

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
      this.queue.refreshLaneHead(row.lane_key);
      dismissedNotices += 1;
    }
    const rejectedImmutableRows = this.context.database.prepare(`
      SELECT q.lane_key, q.failed_reply_id
      FROM outbox_lane_quarantines q
      JOIN outbound_replies failed ON failed.id = q.failed_reply_id
      WHERE q.state = 'active' AND q.lane_class = 'immutable'
        AND failed.state = 'dead_letter' AND failed.kind = 'card_reply'
        AND failed.effect_certainty = 'rejected'
        AND NOT EXISTS (
          SELECT 1 FROM outbound_replies pending
          WHERE pending.lane_key = q.lane_key AND pending.state = 'pending'
        )
      ORDER BY q.created_at, failed.delivery_order
    `).all() as Array<{ lane_key: string; failed_reply_id: string }>;
    let dismissedRejectedImmutableEffects = 0;
    for (const row of rejectedImmutableRows) {
      const dismissed = this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'dismissed', error = 'Dismissed after durable Gateway rejection', updated_at = ?
        WHERE id = ? AND state = 'dead_letter' AND effect_certainty = 'rejected'`).run(timestamp, row.failed_reply_id);
      if (dismissed.changes !== 1) continue;
      this.context.database.prepare(`UPDATE delivery_recoveries
        SET state = 'dismissed', action = 'startup_dismiss_rejected', resolved_at = ?, updated_at = ?
        WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')`).run(timestamp, timestamp, row.failed_reply_id);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'startup_dismiss_rejected', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.failed_reply_id);
      this.queue.refreshLaneHead(row.lane_key);
      dismissedRejectedImmutableEffects += 1;
    }
    return { dismissedNotices, dismissedRejectedImmutableEffects };
  }

  terminalizeQuarantines(timestamp: string): number {
    const terminalRows = this.context.database.prepare(`
      SELECT q.lane_key, q.failed_reply_id
      FROM outbox_lane_quarantines q
      JOIN outbound_replies failed ON failed.id = q.failed_reply_id
      JOIN prompt_jobs prompt ON prompt.id = failed.prompt_id
      JOIN run_cards card ON card.prompt_id = failed.prompt_id
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
      this.queue.refreshLaneHead(row.lane_key);
      terminalizedQuarantines += 1;
    }
    return terminalizedQuarantines;
  }
}
