import { randomUUID } from "node:crypto";
import { ANSWER_RECOVERY_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage } from "../../../runtime/answer-stream.js";
import type { SqliteContext } from "../context.js";
import type { SqliteOutboxQueueStore } from "../outbox-queue-store.js";
import type { OutboxRecoveryDependencies } from "./dependencies.js";
import { lightweightAnswerCardPayload } from "./policies.js";

export interface AnswerStreamRecoveryResult {
  retriedAnswerPromptIds: string[];
  rolledBackAnswerPromptIds: string[];
}

export class AnswerStreamRecovery {
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
    private readonly dependencies: Pick<OutboxRecoveryDependencies, "getActiveAnswerPage" | "loadRunCard">,
  ) {}

  recover(timestamp: string): AnswerStreamRecoveryResult {
    const answerRows = this.context.database.prepare(`
      SELECT o.id, o.prompt_id, o.lane_key
      FROM outbox_lane_quarantines q
      JOIN outbound_replies o ON o.id = q.failed_reply_id
      JOIN answer_pages p ON p.prompt_id = o.prompt_id
        AND p.page_index = json_extract(o.payload, '$.stream.pageIndex')
        AND p.state = 'creating' AND p.message_id IS NULL AND p.card_id IS NULL
      WHERE q.state = 'active' AND q.lane_class = 'immutable' AND q.failure_class = 'transient'
        AND o.state = 'dead_letter' AND o.kind = 'stream_card_create' AND o.auto_recovery_count BETWEEN 1 AND 2
        AND o.idempotency_key NOT LIKE 'startup-lite:%'
        AND NOT EXISTS (SELECT 1 FROM outbound_replies replacement WHERE replacement.idempotency_key = 'startup-lite:' || o.id)
      ORDER BY q.created_at, o.delivery_order
    `).all() as Array<{ id: string; prompt_id: string; lane_key: string }>;
    const retriedAnswerPromptIds: string[] = [];
    const retriedAnswerPromptIdSet = new Set<string>();
    for (const row of answerRows) {
      const failed = this.queue.get(row.id);
      if (!failed) continue;
      const replacement = this.queue.enqueue({
        id: randomUUID(), idempotencyKey: `startup-lite:${row.id}`, workClass: "history", bindingId: failed.bindingId, promptId: failed.promptId,
        viewVersion: failed.viewVersion, cardRole: failed.cardRole, rootMessageId: failed.rootMessageId, kind: "stream_card_create",
        payload: lightweightAnswerCardPayload(failed.payload)
      });
      this.context.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 2, updated_at = ? WHERE id = ? AND state = 'pending'").run(timestamp, replacement.id);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_rebuild', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.id);
      this.queue.refreshLaneHead(row.lane_key);
      if (!retriedAnswerPromptIdSet.has(row.prompt_id)) { retriedAnswerPromptIdSet.add(row.prompt_id); retriedAnswerPromptIds.push(row.prompt_id); }
    }
    const invalidRebuildRows = this.context.database.prepare(`
      SELECT rebuild.id, rebuild.prompt_id, rebuild.lane_key, current.page_index AS current_page_index, next.page_index AS next_page_index
      FROM outbox_lane_quarantines q
      JOIN outbound_replies rebuild ON rebuild.id = q.failed_reply_id
      JOIN answer_pages next ON next.prompt_id = rebuild.prompt_id
        AND next.page_index = json_extract(rebuild.payload, '$.stream.pageIndex')
        AND next.state = 'creating' AND next.message_id IS NULL AND next.card_id IS NULL
      JOIN answer_pages current ON current.prompt_id = next.prompt_id
        AND current.page_index = next.page_index - 1
        AND current.state = 'frozen' AND current.message_id IS NOT NULL AND current.card_id IS NOT NULL
        AND current.source_start = next.source_start
      JOIN run_cards card ON card.prompt_id = current.prompt_id AND card.answer_page_index = current.page_index
      WHERE q.state = 'active' AND q.lane_class = 'immutable'
        AND q.failure_class = 'permanent'
        AND rebuild.state = 'dead_letter' AND rebuild.kind = 'stream_card_create'
        AND rebuild.idempotency_key = 'stream-rebuild:' || rebuild.prompt_id || ':' || next.page_index
        AND json_extract(rebuild.payload, '$.stream.pageStart') = next.source_start
        AND json_extract(rebuild.payload, '$.stream.elementId') = next.element_id
        AND EXISTS (
          SELECT 1 FROM outbound_replies content
          WHERE content.prompt_id = current.prompt_id AND content.card_role = 'answer'
            AND content.kind = 'stream_content' AND content.state = 'dead_letter'
            AND json_extract(content.payload, '$.pageIndex') = current.page_index
            AND json_extract(content.payload, '$.elementId') = current.element_id
        )
      ORDER BY q.created_at, rebuild.delivery_order
    `).all() as Array<{ id: string; prompt_id: string; lane_key: string; current_page_index: number; next_page_index: number }>;
    const rolledBackAnswerPromptIds: string[] = [];
    const rolledBackAnswerPromptIdSet = new Set<string>();
    for (const row of invalidRebuildRows) {
      const removed = this.context.database.prepare(`DELETE FROM answer_pages
        WHERE prompt_id = ? AND page_index = ? AND state = 'creating' AND message_id IS NULL AND card_id IS NULL`).run(row.prompt_id, row.next_page_index);
      if (removed.changes !== 1) continue;
      const restored = this.context.database.prepare(`UPDATE answer_pages SET state = 'active', updated_at = ?
        WHERE prompt_id = ? AND page_index = ? AND state = 'frozen'`).run(timestamp, row.prompt_id, row.current_page_index);
      if (restored.changes !== 1) throw new Error(`Failed to restore Answer page ${row.prompt_id}:${row.current_page_index}`);
      this.context.database.prepare("UPDATE outbound_replies SET state = 'dismissed', updated_at = ? WHERE id = ? AND state = 'dead_letter'").run(timestamp, row.id);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_rollback', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.id);
      this.queue.refreshLaneHead(row.lane_key);
      if (!rolledBackAnswerPromptIdSet.has(row.prompt_id)) { rolledBackAnswerPromptIdSet.add(row.prompt_id); rolledBackAnswerPromptIds.push(row.prompt_id); }
    }
    const failedContentRows = this.context.database.prepare(`
      SELECT content.id, content.prompt_id, content.lane_key
      FROM outbound_replies content
      JOIN answer_pages page ON page.prompt_id = content.prompt_id
        AND page.page_index = json_extract(content.payload, '$.pageIndex')
        AND page.element_id = json_extract(content.payload, '$.elementId')
        AND page.state = 'active' AND page.card_id = content.root_message_id
      WHERE content.card_role = 'answer' AND content.kind = 'stream_content' AND content.state = 'dead_letter'
        AND content.failure_class = 'transient' AND content.auto_recovery_count BETWEEN 1 AND 2
        AND NOT EXISTS (SELECT 1 FROM outbound_replies replacement WHERE replacement.idempotency_key = 'startup-lite-content:' || content.id)
        AND (
          EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.failed_reply_id = content.id AND q.state = 'active' AND q.lane_class = 'answer_stream')
          OR EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.state = 'released' AND q.action = 'startup_rollback'
            AND q.failed_reply_id IN (SELECT rebuild.id FROM outbound_replies rebuild WHERE rebuild.prompt_id = content.prompt_id))
        )
      ORDER BY content.delivery_order
    `).all() as Array<{ id: string; prompt_id: string; lane_key: string }>;
    for (const failedContent of failedContentRows) {
      const promptId = failedContent.prompt_id;
      const page = this.dependencies.getActiveAnswerPage(promptId);
      const view = this.dependencies.loadRunCard(promptId);
      if (!page?.cardId || !view || (view.phase !== "completed" && view.phase !== "failed")) continue;
      const rendered = renderAnswerStreamPage(answerStreamContent(view), page.sourceStart, ANSWER_RECOVERY_PAGE_LIMIT);
      if (!rendered.page) continue;
      const sequence = page.sequence + 1;
      const sourceEnd = rendered.nextPageStart ?? answerStreamContent(view).length;
      this.context.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active'")
        .run(sequence, timestamp, promptId, page.pageIndex);
      this.context.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?")
        .run(sequence, timestamp, promptId, page.pageIndex);
      const replacement = this.queue.enqueue({
        id: randomUUID(), idempotencyKey: `startup-lite-content:${failedContent.id}`, workClass: "history", bindingId: view.bindingId, promptId, viewVersion: sequence, cardRole: "answer",
        rootMessageId: page.cardId, kind: "stream_content", payload: JSON.stringify({ pageIndex: page.pageIndex, elementId: page.elementId, content: rendered.page, sequence, sourceEnd })
      });
      this.context.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 2, updated_at = ? WHERE id = ? AND state = 'pending'").run(timestamp, replacement.id);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_rebuild', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, failedContent.lane_key, failedContent.id);
      this.queue.refreshLaneHead(failedContent.lane_key);
      if (!retriedAnswerPromptIdSet.has(promptId)) { retriedAnswerPromptIdSet.add(promptId); retriedAnswerPromptIds.push(promptId); }
    }
    return { retriedAnswerPromptIds, rolledBackAnswerPromptIds };
  }
}
