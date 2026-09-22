import type { SqliteContext } from "./context.js";

export const outboundRetentionCandidateSelectionSql = `
  SELECT id FROM outbound_replies
  WHERE state IN ('delivered', 'dismissed')
    AND claim_attempt_id IS NULL
    AND (
      projection_key IS NULL
      OR snapshot_revision < (
        SELECT MAX(newer.snapshot_revision)
        FROM outbound_replies newer
        WHERE newer.projection_key = outbound_replies.projection_key
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM delivery_recoveries recovery
      WHERE recovery.failed_reply_id = outbound_replies.id
        AND recovery.state IN ('unresolved','replacement_pending')
    )
    AND NOT EXISTS (
      SELECT 1 FROM delivery_recoveries recovery
      WHERE recovery.replacement_reply_id = outbound_replies.id
        AND recovery.state IN ('unresolved','replacement_pending')
    )
    AND updated_at < ?
  ORDER BY updated_at, delivery_order
  LIMIT ?
`;

export class SqliteOutboxRetentionStore {
  constructor(private readonly context: SqliteContext) {}

  pruneDelivered(cutoff: string, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    return Number(this.context.database.prepare(`DELETE FROM outbound_replies WHERE id IN (${outboundRetentionCandidateSelectionSql})`).run(cutoff, limit).changes);
  }

  compactDeliveryIntents(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    return Number(this.context.database.prepare(`
      UPDATE outbound_replies
      SET intent_json = json_object('schemaVersion', 2, 'kind', intent_kind)
      WHERE id IN (
        SELECT id FROM outbound_replies
        WHERE claim_attempt_id IS NULL AND (first_claimed_at IS NULL OR state IN ('delivered','dismissed')) AND renderer_revision = 1
          AND json_valid(intent_json)
          AND json_extract(intent_json, '$.schemaVersion') = 1
          AND json_extract(intent_json, '$.kind') = intent_kind
          AND json_extract(intent_json, '$.materializedPayload') = payload
        ORDER BY delivery_order LIMIT ?
      )
    `).run(limit).changes);
  }
}
