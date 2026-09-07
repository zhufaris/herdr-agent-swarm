import type { SqliteContext } from "./context.js";

export class SqliteOutboxRetentionStore {
  constructor(private readonly context: SqliteContext) {}

  pruneDelivered(cutoff: string, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    return Number(this.context.database.prepare(`DELETE FROM outbound_replies WHERE id IN (SELECT id FROM outbound_replies WHERE state IN ('delivered', 'dismissed') AND updated_at < ? ORDER BY updated_at, delivery_order LIMIT ?)`).run(cutoff, limit).changes);
  }
}
