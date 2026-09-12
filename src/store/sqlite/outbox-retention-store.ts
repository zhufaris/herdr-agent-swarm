import type { SqliteContext } from "./context.js";

export class SqliteOutboxRetentionStore {
  constructor(private readonly context: SqliteContext) {}

  pruneDelivered(cutoff: string, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    return Number(this.context.database.prepare(`DELETE FROM outbound_replies WHERE id IN (SELECT id FROM outbound_replies WHERE state IN ('delivered', 'dismissed') AND claim_attempt_id IS NULL AND (projection_key IS NULL OR snapshot_revision < (SELECT MAX(newer.snapshot_revision) FROM outbound_replies newer WHERE newer.projection_key = outbound_replies.projection_key)) AND NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery WHERE (recovery.failed_reply_id = outbound_replies.id OR recovery.replacement_reply_id = outbound_replies.id) AND recovery.state IN ('unresolved','replacement_pending')) AND updated_at < ? ORDER BY updated_at, delivery_order LIMIT ?)`).run(cutoff, limit).changes);
  }
}
