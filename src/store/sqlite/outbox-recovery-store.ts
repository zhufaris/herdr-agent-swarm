import { randomUUID } from "node:crypto";
import type { AnswerPage, Binding, DeadLetterActionOutcome, DeliveryFailureMetadata, OutboundFailureTransition, OutboundReply, OutboxLaneClass, StaleOutboxQuarantineRecovery } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import type { WorkerMainView } from "../../domain/worker-main-view.js";
import type { CardContextTarget } from "../../domain/card-context-invalidation.js";
import { ANSWER_RECOVERY_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage } from "../../runtime/answer-stream.js";
import type { SqliteContext } from "./context.js";
import type { SqliteOutboxQueueStore } from "./outbox-queue-store.js";
import { boundedOutboxError, SqliteOutboxDeliveryStore } from "./outbox-delivery-store.js";

export class SqliteOutboxRecoveryStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
    private readonly delivery: SqliteOutboxDeliveryStore,
    private readonly dependencies: {
      getBinding(id: string): Binding | null;
      loadRunCard(promptId: string): RunCardView | null;
      getActiveAnswerPage(promptId: string): AnswerPage | null;
      loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
      listWorkerTurnCardPages(turnId: string): import("../../domain/worker-turn-card-view.js").WorkerTurnCardPage[];
      loadWorkerMainView(workerId: string, workerSessionGeneration: number): WorkerMainView | null;
      saveRunCard(view: RunCardView): RunCardView;
      persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
      invalidateCardContexts(targets: readonly (CardContextTarget & { reason: string })[]): unknown;
    }
  ) {}

  markOutboundReplyFailedWithQuarantine(id: string, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number): OutboundFailureTransition | null {
    return this.context.transaction(() => {
      const before = this.queue.get(id);
      if (!before) return null;
      if (before.state === "dead_letter") {
        const existing = this.context.database.prepare("SELECT lane_class, action FROM outbox_lane_quarantines WHERE lane_key = ? AND failed_reply_id = ?").get(before.laneKey, id) as { lane_class: OutboxLaneClass; action: OutboundFailureTransition["action"] } | undefined;
        if (existing) return { state: before.state, action: existing.action, laneClass: existing.lane_class, promptId: before.promptId, reply: before };
      }
      if (before.state !== "pending") return null;
      const staleMainCard = before.kind === "card_update" && before.targetRole === "session_status" && (metadata.larkErrorCode === "230099" || metadata.larkErrorCode === "300317");
      const closedAnswerStream = before.cardRole === "answer" && before.kind === "stream_content" && metadata.larkErrorCode === "300309";
      const failed = metadata.failureClass === "permanent" || staleMainCard || closedAnswerStream
        ? this.delivery.markDeadLetter(id, error, metadata)
        : this.delivery.markFailed(id, error, retryDelayMs, metadata);
      if (!failed) return null;
      const laneClass = outboundLaneClass(failed);
      if (failed.state !== "dead_letter" || (metadata.failureClass === "transient" && failed.autoRecoveryCount === 0)) return { state: failed.state, action: "retry", laneClass, promptId: failed.promptId, reply: failed };
      const timestamp = now();
      let action: OutboundFailureTransition["action"] = "blocked";
      let quarantineState: "active" | "released" = "active";
      if (closedAnswerStream && failed.promptId) {
        const pageIndex = streamContentPageIndex(failed.payload);
        if (pageIndex === null) throw new Error(`Closed Answer stream ${failed.id} has invalid page metadata`);
        this.context.database.prepare(`UPDATE answer_pages SET state = 'frozen', delivery_mode = 'static', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND card_id = ?`).run(timestamp, failed.promptId, pageIndex, failed.rootMessageId);
        this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed', error = 'Dismissed after Lark closed the Answer stream', updated_at = ? WHERE lane_key = ? AND state = 'pending' AND delivery_order > ? AND kind IN ('stream_content','stream_finish')`).run(timestamp, failed.laneKey, this.outboundDeliveryOrder(id));
        action = "rebuild_answer"; quarantineState = "released";
      } else if (laneClass === "answer_stream" && failed.promptId) {
        this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed', error = 'Isolated after an earlier Answer stream failure', updated_at = ? WHERE lane_key = ? AND state = 'pending' AND delivery_order > ? AND kind IN ('stream_content','stream_finish')`).run(timestamp, failed.laneKey, this.outboundDeliveryOrder(id));
      } else if (laneClass === "main_card" && staleMainCard && failed.bindingId) {
        const replacement = this.context.database.prepare(`SELECT payload, COALESCE(view_version, 0) AS view_version FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND (id = ? OR state = 'pending') ORDER BY COALESCE(view_version, 0) DESC, delivery_order DESC LIMIT 1`).get(failed.bindingId, id) as { payload: string; view_version: number } | undefined;
        const binding = this.dependencies.getBinding(failed.bindingId);
        if (!binding) throw new Error(`Binding not found: ${failed.bindingId}`);
        if (replacement && binding.rootMessageId) {
          this.context.database.prepare(`DELETE FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND kind = 'card_update' AND state = 'pending'`).run(failed.bindingId);
          this.queue.enqueue({ id: randomUUID(), idempotencyKey: `main-card:rebuild:${failed.bindingId}:${replacement.view_version}`, bindingId: failed.bindingId, viewVersion: replacement.view_version, targetRole: "session_status", rootMessageId: binding.rootMessageId, kind: "card_reply", payload: replacement.payload });
          action = "rebuild_main"; quarantineState = "released";
        }
      } else if (laneClass === "main_card" || laneClass === "replaceable_card") {
        action = "released_newer_snapshot"; quarantineState = "released";
      }
      const laneKey = failed.laneKey;
      this.context.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key, failed_reply_id, lane_class, failure_class, state, action, reason, created_at, updated_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(lane_key) DO UPDATE SET failed_reply_id = excluded.failed_reply_id, lane_class = excluded.lane_class, failure_class = excluded.failure_class, state = excluded.state, action = excluded.action, reason = excluded.reason, updated_at = excluded.updated_at, released_at = excluded.released_at`).run(laneKey, id, laneClass, metadata.failureClass, quarantineState, action, boundedOutboxError(error), timestamp, timestamp, quarantineState === "released" ? timestamp : null);
      if (quarantineState === "released") this.queue.refreshLaneHead(laneKey);
      else this.context.database.prepare("DELETE FROM outbox_lane_heads WHERE lane_key = ?").run(laneKey);
      return { state: failed.state, action, laneClass, promptId: failed.promptId, reply: failed };
    });
  }

  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    return this.context.transaction(() => {
      const rows = this.context.database.prepare(`SELECT o.id FROM outbound_replies o WHERE o.state = 'dead_letter' AND o.failure_class = 'transient' AND o.auto_recovery_count = 0 AND o.dead_lettered_at IS NOT NULL AND o.dead_lettered_at <= ? AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = o.lane_key AND q.state = 'active') ORDER BY o.dead_lettered_at, o.delivery_order LIMIT ?`).all(cutoff, limit) as Array<{ id: string }>;
      const recovered: OutboundReply[] = [];
      for (const row of rows) {
        const timestamp = now();
        const updated = this.context.database.prepare(`UPDATE outbound_replies SET state = 'pending', attempt_count = 0, error = NULL, next_attempt_at = ?, auto_recovery_count = 1, updated_at = ? WHERE id = ? AND state = 'dead_letter' AND failure_class = 'transient' AND auto_recovery_count = 0 AND dead_lettered_at <= ?`).run(timestamp, timestamp, row.id, cutoff);
        if (updated.changes === 1) { const reply = this.queue.get(row.id); if (reply) recovered.push(reply); }
      }
      return recovered;
    });
  }

  retireUndeliveredWorkerTaskCardIntents(): number {
    return this.context.transaction(() => {
      const timestamp = now();
      const rows = this.context.database.prepare(`
        SELECT id, worker_turn_id, lane_key
        FROM outbound_replies
        WHERE worker_turn_id IS NOT NULL
          AND kind = 'stream_card_create'
          AND idempotency_key = 'worker-turn:create:' || worker_turn_id || ':0'
          AND state = 'pending'
          AND attempt_count = 0
          AND delivered_message_id IS NULL
          AND card_id_checkpoint IS NULL
      `).all() as Array<{ id: string; worker_turn_id: string; lane_key: string }>;
      let retired = 0;
      for (const row of rows) {
        const updated = this.context.database.prepare(`
          UPDATE outbound_replies
          SET state = 'dismissed', error = 'Retired by Worker Session single-card migration', updated_at = ?
          WHERE id = ? AND kind = 'stream_card_create'
            AND idempotency_key = 'worker-turn:create:' || worker_turn_id || ':0'
            AND state = 'pending' AND attempt_count = 0
            AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL
        `).run(timestamp, row.id);
        retired += Number(updated.changes);
        this.queue.refreshLaneHead(row.lane_key);
      }
      return retired;
    });
  }

  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery {
    return this.context.transaction(() => {
      const timestamp = now();
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
          id: randomUUID(), idempotencyKey: `startup-lite:${row.id}`, bindingId: failed.bindingId, promptId: failed.promptId,
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
          id: randomUUID(), idempotencyKey: `startup-lite-content:${failedContent.id}`, bindingId: view.bindingId, promptId, viewVersion: sequence, cardRole: "answer",
          rootMessageId: page.cardId, kind: "stream_content", payload: JSON.stringify({ pageIndex: page.pageIndex, elementId: page.elementId, content: rendered.page, sequence, sourceEnd })
        });
        this.context.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 2, updated_at = ? WHERE id = ? AND state = 'pending'").run(timestamp, replacement.id);
        this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_rebuild', released_at = ?, updated_at = ?
          WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, failedContent.lane_key, failedContent.id);
        this.queue.refreshLaneHead(failedContent.lane_key);
        if (!retriedAnswerPromptIdSet.has(promptId)) { retriedAnswerPromptIdSet.add(promptId); retriedAnswerPromptIds.push(promptId); }
      }
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
      return { retriedAnswerPromptIds, rolledBackAnswerPromptIds, dismissedNotices, terminalizedQuarantines };
    });
  }


  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome { return this.changeDeadLetter(id, chatId, actorOpenId, "retry"); }
  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome { return this.changeDeadLetter(id, chatId, actorOpenId, "dismiss"); }

  private changeDeadLetter(id: string, chatId: string, actorOpenId: string, action: "retry" | "dismiss"): DeadLetterActionOutcome {
    return this.context.transaction(() => {
      const row = this.context.database.prepare(`SELECT o.state, COALESCE(b.chat_id, s.chat_id) AS chat_id FROM outbound_replies o LEFT JOIN bindings b ON b.id = o.binding_id LEFT JOIN project_selections s ON s.id = o.selection_id WHERE o.id = ?`).get(id) as { state: OutboundReply["state"]; chat_id: string | null } | undefined;
      let outcome: DeadLetterActionOutcome;
      if (!row) outcome = "missing"; else if (row.chat_id !== chatId) outcome = "unauthorized"; else if (row.state !== "dead_letter") outcome = "stale"; else {
        const lane = this.context.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(id) as { lane_key: string } | undefined;
        const nextState = action === "retry" ? "pending" : "dismissed";
        this.context.database.prepare("UPDATE outbound_replies SET state = ?, error = NULL, failure_class = NULL, http_status = NULL, lark_error_code = NULL, attempt_count = CASE WHEN ? = 'pending' THEN 0 ELSE attempt_count END, next_attempt_at = ?, updated_at = ? WHERE id = ? AND state = 'dead_letter'").run(nextState, nextState, now(), now(), id);
        if (lane) { this.context.database.prepare("UPDATE outbox_lane_quarantines SET state = 'released', action = ?, released_at = ?, updated_at = ? WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'").run(action === "retry" ? "manual_retry" : "manual_dismiss", now(), now(), lane.lane_key, id); this.queue.refreshLaneHead(lane.lane_key); }
        outcome = action === "retry" ? "retried" : "dismissed";
      }
      this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, ?, ?, ?, ?)").run(actorOpenId, `outbound.${action}`, id, outcome, now());
      return outcome;
    });
  }

  private outboundDeliveryOrder(id: string): number {
    const row = this.context.database.prepare("SELECT delivery_order FROM outbound_replies WHERE id = ?").get(id) as { delivery_order: number } | undefined;
    if (!row) throw new Error(`Outbound reply not found: ${id}`);
    return Number(row.delivery_order);
  }

}

function now(): string { return new Date().toISOString(); }
function outboundLaneClass(reply: OutboundReply): OutboxLaneClass {
  if (reply.cardRole === "answer" && reply.promptId && (reply.kind === "stream_content" || reply.kind === "stream_finish")) return "answer_stream";
  if (reply.targetRole === "session_status" && reply.kind === "card_update") return "main_card";
  if (reply.kind === "card_update") return "replaceable_card";
  return "immutable";
}
function streamContentPageIndex(payload: string): number | null {
  try { const decoded = JSON.parse(payload) as { pageIndex?: unknown }; return Number.isInteger(decoded.pageIndex) ? Number(decoded.pageIndex) : null; } catch { return null; }
}

function lightweightAnswerCardPayload(payload: string): string {
  const decoded = JSON.parse(payload) as { card?: { body?: { elements?: Array<Record<string, unknown>> } }; stream?: { elementId?: unknown } };
  if (!decoded.card || !decoded.stream || typeof decoded.stream.elementId !== "string") throw new Error("Answer continuation metadata missing for lightweight recovery");
  const elements = decoded.card.body?.elements;
  if (!Array.isArray(elements)) throw new Error("Answer card body missing for lightweight recovery");
  let replaced = false;
  decoded.card.body!.elements = elements.map((element) => {
    if (element.element_id !== decoded.stream!.elementId) return element;
    replaced = true;
    return { ...element, content: "正在恢复本页内容…" };
  });
  if (!replaced) throw new Error("Answer card streaming element missing for lightweight recovery");
  return JSON.stringify(decoded);
}
