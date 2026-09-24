import { createHash } from "node:crypto";
import type { AnswerTimelineItem } from "../../domain/answer-timeline.js";
import type { AnswerTimelineFrozenItem, AnswerTimelinePageCheckpoint } from "../../domain/delivery.js";
import type { AnswerTimelineCursor } from "../../domain/delivery.js";
import type { SqliteContext } from "./context.js";

type AggregateKind = "primary-run" | "worker-turn";

export class SqliteAnswerTimelinePageStore {
  constructor(private readonly context: SqliteContext) {}

  load(kind: AggregateKind, aggregateId: string, pageIndex: number): AnswerTimelinePageCheckpoint {
    const row = this.context.database.prepare(`SELECT start_cursor_json, delivered_cursor_json, delivered_items_json, pending_reply_id
      FROM answer_timeline_page_checkpoints WHERE aggregate_kind = ? AND aggregate_id = ? AND page_index = ?`).get(kind, aggregateId, pageIndex) as { start_cursor_json: string; delivered_cursor_json: string | null; delivered_items_json: string; pending_reply_id: string | null } | undefined;
    if (!row) return { startCursor: { itemIndex: 0, markdownOffset: 0 }, deliveredCursor: null, deliveredItems: [], pending: false };
    const pending = row.pending_reply_id !== null && this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE id = ? AND state = 'pending'").get(row.pending_reply_id) !== undefined;
    return { startCursor: JSON.parse(row.start_cursor_json) as AnswerTimelineCursor, deliveredCursor: row.delivered_cursor_json === null ? null : JSON.parse(row.delivered_cursor_json) as AnswerTimelineCursor, deliveredItems: JSON.parse(row.delivered_items_json) as AnswerTimelinePageCheckpoint["deliveredItems"], pending };
  }

  ensure(kind: AggregateKind, aggregateId: string, pageIndex: number, startCursor: AnswerTimelineCursor): void {
    const timestamp = now();
    this.context.database.prepare(`INSERT OR IGNORE INTO answer_timeline_page_checkpoints(aggregate_kind, aggregate_id, page_index, start_cursor_json, delivered_items_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, '[]', ?, ?)`).run(kind, aggregateId, pageIndex, JSON.stringify(startCursor), timestamp, timestamp);
  }

  reserve(kind: AggregateKind, aggregateId: string, pageIndex: number, replyId: string, cursor: AnswerTimelineCursor | null, items: readonly AnswerTimelineItem[]): void {
    this.context.database.prepare(`UPDATE answer_timeline_page_checkpoints SET pending_reply_id = ?, pending_cursor_json = ?, pending_items_json = ?, updated_at = ?
      WHERE aggregate_kind = ? AND aggregate_id = ? AND page_index = ?`).run(replyId, cursor === null ? null : JSON.stringify(cursor), JSON.stringify(itemFingerprints(items)), now(), kind, aggregateId, pageIndex);
  }

  isDelivered(kind: AggregateKind, aggregateId: string, pageIndex: number, cursor: AnswerTimelineCursor | null, items: readonly AnswerTimelineItem[]): boolean {
    const current = this.load(kind, aggregateId, pageIndex);
    return JSON.stringify(current.deliveredCursor) === JSON.stringify(cursor) && JSON.stringify(current.deliveredItems) === JSON.stringify(itemFingerprints(items));
  }

  frozenItems(kind: AggregateKind, aggregateId: string, beforePageIndex: number): AnswerTimelineFrozenItem[] {
    const rows = this.context.database.prepare(`SELECT page_index, delivered_items_json FROM answer_timeline_page_checkpoints
      WHERE aggregate_kind = ? AND aggregate_id = ? AND page_index < ? ORDER BY page_index`).all(kind, aggregateId, beforePageIndex) as Array<{ page_index: number; delivered_items_json: string }>;
    return rows.flatMap((row) => (JSON.parse(row.delivered_items_json) as AnswerTimelinePageCheckpoint["deliveredItems"]).map((item) => ({ pageIndex: Number(row.page_index), ...item })));
  }
}

export function settleAnswerTimelinePageCheckpoint(context: SqliteContext, replyId: string): void {
  context.database.prepare(`UPDATE answer_timeline_page_checkpoints SET delivered_cursor_json = pending_cursor_json, delivered_items_json = COALESCE(pending_items_json, delivered_items_json),
    pending_reply_id = NULL, pending_cursor_json = NULL, pending_items_json = NULL, updated_at = ? WHERE pending_reply_id = ?`).run(now(), replyId);
}

function itemFingerprints(items: readonly AnswerTimelineItem[]): AnswerTimelinePageCheckpoint["deliveredItems"] {
  return items.map((item) => ({ id: item.id, fingerprint: createHash("sha256").update(JSON.stringify(item)).digest("hex") }));
}

function now(): string { return new Date().toISOString(); }
