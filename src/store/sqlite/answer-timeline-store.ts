import type { AnswerTimelineItem } from "../../domain/answer-timeline.js";
import type { SqliteContext } from "./context.js";
import { assertCompactedPayloadCompatible } from "./retention-payload-compatibility.js";

export type AnswerTimelineAggregateKind = "primary-run" | "worker-turn";

export class SqliteAnswerTimelineStore {
  constructor(private readonly context: SqliteContext) {}

  load(kind: AnswerTimelineAggregateKind, aggregateId: string): AnswerTimelineItem[] {
    const rows = this.context.database.prepare(`SELECT item_json FROM answer_timeline_items
      WHERE aggregate_kind = ? AND aggregate_id = ? AND payload_compacted_at IS NULL ORDER BY sequence, item_id`).all(kind, aggregateId) as Array<{ item_json: string }>;
    return rows.flatMap(({ item_json }) => parseTimelineItem(item_json));
  }

  save(kind: AnswerTimelineAggregateKind, aggregateId: string, items: readonly AnswerTimelineItem[]): void {
    this.context.transaction("sqlite.answer-timeline-store.write", () => {
      const retained = new Set(items.map((item) => item.id));
      for (const item of items) {
        const itemJson = JSON.stringify(item);
        const compacted = this.context.database.prepare(`SELECT 1 FROM answer_timeline_items
          WHERE aggregate_kind=? AND aggregate_id=? AND item_id=? AND payload_compacted_at IS NOT NULL`).get(kind, aggregateId, item.id);
        if (compacted) {
          assertCompactedPayloadCompatible(this.context, "answer_timeline_item", JSON.stringify(["answer_timeline_item", kind, aggregateId, item.id]), itemJson);
          continue;
        }
        this.context.database.prepare(`INSERT INTO answer_timeline_items(aggregate_kind, aggregate_id, item_id, sequence, item_json)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT(aggregate_kind, aggregate_id, item_id) DO UPDATE SET
          sequence = excluded.sequence, item_json = excluded.item_json
          WHERE answer_timeline_items.payload_compacted_at IS NULL`).run(kind, aggregateId, item.id, item.sequence, itemJson);
      }
      const existing = this.context.database.prepare(`SELECT item_id FROM answer_timeline_items
        WHERE aggregate_kind = ? AND aggregate_id = ? AND payload_compacted_at IS NULL`).all(kind, aggregateId) as Array<{ item_id: string }>;
      for (const row of existing) if (!retained.has(row.item_id)) {
        this.context.database.prepare(`DELETE FROM answer_timeline_items
          WHERE aggregate_kind = ? AND aggregate_id = ? AND item_id = ?`).run(kind, aggregateId, row.item_id);
      }
    });
  }
}

function parseTimelineItem(value: string): AnswerTimelineItem[] {
  try {
    const item = JSON.parse(value) as Partial<AnswerTimelineItem>;
    return typeof item.id === "string" && Number.isInteger(item.sequence) && ["human_message", "agent_message", "thinking", "tool", "status", "final_answer"].includes(String(item.kind))
      ? [item as AnswerTimelineItem]
      : [];
  } catch { return []; }
}
