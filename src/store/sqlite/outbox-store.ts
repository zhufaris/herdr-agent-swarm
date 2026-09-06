import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { Binding, DeliveryFailureMetadata, OutboundReply } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import type { WorkerMainView } from "../../domain/worker-main-view.js";
import type { CardContextTarget } from "../../domain/card-context-invalidation.js";
import { freezeRunCardWorkerContext } from "../../domain/run-card-view.js";
import { outboundLaneKey } from "../outbox-lanes.js";
import { mapOutboundReply, type OutboundReplyRow, type SqlValue } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

type EnqueueInput = Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string };

export class SqliteOutboxStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getBinding(id: string): Binding | null;
      loadRunCard(promptId: string): RunCardView | null;
      loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
      loadWorkerMainView(workerId: string, workerSessionGeneration: number): WorkerMainView | null;
      saveRunCard(view: RunCardView): RunCardView;
      persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
      invalidateCardContexts(targets: readonly (CardContextTarget & { reason: string })[]): unknown;
    }
  ) {}

  enqueueOutboundReply(input: EnqueueInput): OutboundReply {
    const timestamp = now();
    const bindingGeneration = input.promptId ? this.dependencies.loadRunCard(input.promptId)?.bindingGeneration ?? null : input.bindingId ? this.dependencies.getBinding(input.bindingId)?.generation ?? null : null;
    const laneKey = input.laneKeyOverride ?? outboundLaneKey({ ...input, bindingGeneration });
    return this.context.transaction(() => {
      if (input.kind === "card_update" && input.bindingId && !input.promptId) {
        this.context.database.prepare(`
          DELETE FROM outbound_replies
          WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
            AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            AND delivery_order > (
              SELECT MIN(delivery_order) FROM outbound_replies
              WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
                AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            )
        `).run(input.bindingId, input.rootMessageId, laneKey, input.bindingId, input.rootMessageId, laneKey);
      }
      if (input.kind === "card_update" && input.workerId && input.workerSessionGeneration !== undefined && input.workerSessionGeneration !== null && input.viewVersion !== undefined && input.viewVersion !== null) {
        this.context.database.prepare("DELETE FROM outbound_replies WHERE worker_id = ? AND worker_session_generation = ? AND kind = 'card_update' AND state = 'pending' AND COALESCE(view_version, 0) < ?").run(input.workerId, input.workerSessionGeneration, input.viewVersion);
      }
      if (input.kind === "card_update" && input.promptId && input.viewVersion !== undefined && input.viewVersion !== null) {
        this.context.database.prepare("DELETE FROM outbound_replies WHERE prompt_id = ? AND root_message_id = ? AND kind = ? AND state = 'pending' AND card_role IS ? AND COALESCE(view_version, 0) < ?").run(input.promptId, input.rootMessageId, input.kind, input.cardRole ?? null, input.viewVersion);
      }
      this.context.database.prepare(`
        INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, card_role, target_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          payload = CASE WHEN outbound_replies.state = 'pending' THEN excluded.payload ELSE outbound_replies.payload END,
          view_version = CASE WHEN outbound_replies.state = 'pending' THEN excluded.view_version ELSE outbound_replies.view_version END,
          card_sequence = CASE WHEN outbound_replies.state = 'pending' THEN excluded.card_sequence ELSE outbound_replies.card_sequence END,
          updated_at = CASE WHEN outbound_replies.state = 'pending' THEN excluded.updated_at ELSE outbound_replies.updated_at END
      `).run(input.id, input.idempotencyKey, input.bindingId ?? null, input.promptId ?? null, input.workerTurnId ?? null, input.workerId ?? null, input.workerSessionGeneration ?? null, input.viewVersion ?? null, input.cardSequence ?? null, input.selectionId ?? null, input.cardRole ?? null, input.targetRole ?? null, input.rootMessageId, input.kind, input.payload, laneKey, timestamp, timestamp, timestamp);
      const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key = ?").get(input.idempotencyKey) as OutboundReplyRow | undefined;
      if (!row) throw new Error(`Outbound reply not found: ${input.idempotencyKey}`);
      if (input.kind === "stream_card_create" && input.promptId) {
        const stream = streamCardState(input.payload);
        const pageIndex = stream?.pageIndex ?? 0;
        const view = this.dependencies.loadRunCard(input.promptId);
        const elementId = stream?.elementId ?? view?.answerElementId;
        if (!view || !elementId) throw new Error(`Answer page metadata missing for prompt: ${input.promptId}`);
        this.context.database.prepare(`INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, 0, 'creating', 'streaming', ?, ?) ON CONFLICT(prompt_id, page_index) DO NOTHING`).run(input.promptId, pageIndex, elementId, stream?.pageStart ?? 0, timestamp, timestamp);
      }
      if (input.kind === "stream_card_create" && input.workerTurnId) {
        const stream = streamCardState(input.payload);
        const view = this.dependencies.loadWorkerTurnCard(input.workerTurnId);
        const pageIndex = stream?.pageIndex ?? 0;
        const elementId = stream?.elementId ?? view?.elementId;
        if (!view || !elementId) throw new Error(`Worker card page metadata missing for turn: ${input.workerTurnId}`);
        this.context.database.prepare(`INSERT INTO worker_turn_card_pages(id, turn_id, page_index, page_start, element_id, message_id, card_id, state, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'creating', 0, ?, ?) ON CONFLICT(turn_id, page_index) DO NOTHING`).run(`${input.workerTurnId}:${pageIndex}`, input.workerTurnId, pageIndex, stream?.pageStart ?? 0, elementId, timestamp, timestamp);
      }
      return mapOutboundReply(row);
    });
  }

  listPendingOutboundReplies(): OutboundReply[] {
    return (this.context.database.prepare("SELECT * FROM outbound_replies WHERE state = 'pending' ORDER BY delivery_order").all() as OutboundReplyRow[]).map(mapOutboundReply);
  }

  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean {
    return this.context.database.prepare(`SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' AND json_extract(payload, '$.stream.pageIndex') = ? LIMIT 1`).get(promptId, pageIndex) !== undefined;
  }

  dismissSupersededAnswerStream(replyId: string): boolean {
    const updated = this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed', error = 'Answer stream superseded by a continuation page', updated_at = ? WHERE id = ? AND state = 'pending' AND kind IN ('stream_content', 'stream_finish') AND prompt_id IS NOT NULL AND EXISTS (SELECT 1 FROM run_cards WHERE run_cards.prompt_id = outbound_replies.prompt_id AND run_cards.answer_page_index > 0 AND run_cards.answer_card_id IS NOT NULL AND run_cards.answer_card_id != outbound_replies.root_message_id)`).run(now(), replyId);
    return Number(updated.changes) === 1;
  }

  listOutboundLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys: readonly string[] = []): OutboundReply[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const exclusions = excludedLaneKeys.length > 0 ? `AND h.lane_key NOT IN (${excludedLaneKeys.map(() => "?").join(", " )})` : "";
    const due = dueAt === null ? "" : "AND h.next_attempt_at <= ?";
    const parameters: SqlValue[] = [...excludedLaneKeys];
    if (dueAt !== null) parameters.push(dueAt);
    parameters.push(limit);
    return (this.context.database.prepare(`SELECT o.* FROM outbox_lane_heads h JOIN outbound_replies o ON o.id = h.reply_id WHERE 1 = 1 ${exclusions} ${due} ORDER BY h.delivery_order LIMIT ?`).all(...parameters) as OutboundReplyRow[]).map(mapOutboundReply);
  }

  getNextOutboundLaneHeadAttemptAt(): string | null {
    const row = this.context.database.prepare("SELECT MIN(next_attempt_at) AS next_attempt_at FROM outbox_lane_heads").get() as { next_attempt_at: string | null };
    return row.next_attempt_at;
  }

  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string): void {
    this.context.transaction(() => {
      const row = this.context.database.prepare("SELECT idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, card_role, target_role, kind, payload, root_message_id FROM outbound_replies WHERE id = ?").get(id) as { idempotency_key: string; binding_id: string | null; prompt_id: string | null; worker_turn_id: string | null; worker_id: string | null; worker_session_generation: number | null; view_version: number | null; card_sequence: number | null; selection_id: string | null; card_role: string | null; target_role: string | null; kind: string; payload: string; root_message_id: string } | undefined;
      this.context.database.prepare("UPDATE outbound_replies SET state = 'delivered', delivered_message_id = ?, error = NULL, failure_class = NULL, http_status = NULL, lark_error_code = NULL, dead_lettered_at = NULL, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(messageId, now(), id);
      if (row?.prompt_id) {
        if (row.card_role === "answer") {
          if (row.kind === "card_reply" || row.kind === "stream_card_create") {
            const stream = row.kind === "stream_card_create" ? streamCardState(row.payload) : null;
            const expectedPageIndex = stream && stream.pageIndex > 0 ? stream.pageIndex - 1 : null;
            const pageIndex = stream?.pageIndex ?? 0;
            const updated = this.context.database.prepare("UPDATE run_cards SET answer_message_id = ?, answer_card_id = COALESCE(?, answer_card_id), answer_element_id = COALESCE(?, answer_element_id), answer_sequence = CASE WHEN ? IS NULL THEN answer_sequence ELSE 0 END, answer_page_index = COALESCE(?, answer_page_index), answer_page_start = COALESCE(?, answer_page_start), lark_message_id = CASE WHEN ? IS NULL THEN COALESCE(lark_message_id, ?) ELSE lark_message_id END, answer_delivered_version = MAX(answer_delivered_version, ?), updated_at = ? WHERE prompt_id = ? AND (? IS NULL OR answer_page_index = ?)").run(messageId, cardId ?? null, stream?.elementId ?? null, stream ? 1 : null, stream?.pageIndex ?? null, stream?.pageStart ?? null, cardId ?? null, messageId, row.view_version ?? 0, now(), row.prompt_id, expectedPageIndex, expectedPageIndex);
            if (updated.changes > 0) {
              if (pageIndex > 0) this.context.database.prepare("UPDATE answer_pages SET state = 'frozen', updated_at = ? WHERE prompt_id = ? AND state = 'active' AND page_index < ?").run(now(), row.prompt_id, pageIndex);
              this.context.database.prepare("UPDATE answer_pages SET message_id = ?, card_id = COALESCE(?, card_id), sequence = CASE WHEN ? IS NULL THEN sequence ELSE 0 END, state = 'active', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'creating'").run(messageId, cardId ?? null, cardId ?? null, now(), row.prompt_id, pageIndex);
            }
          } else {
            this.context.database.prepare("UPDATE run_cards SET answer_delivered_version = MAX(answer_delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(row.view_version ?? 0, now(), row.prompt_id);
            const payload = parseJsonRecord(row.payload);
            const pageIndex = Number.isInteger(payload.pageIndex) ? Number(payload.pageIndex) : null;
            if (row.kind === "stream_content") this.context.database.prepare("UPDATE answer_pages SET sequence = MAX(sequence, ?), updated_at = ? WHERE prompt_id = ? AND state = 'active' AND (? IS NULL OR page_index = ?)").run(row.view_version ?? 0, now(), row.prompt_id, pageIndex, pageIndex);
            if (row.kind === "stream_finish") {
              const pendingContinuation = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' LIMIT 1").get(row.prompt_id);
              const pendingFinalUpdate = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'card_update' AND state = 'pending' AND idempotency_key = ? LIMIT 1").get(row.prompt_id, `answer-final-fold:${row.prompt_id}:${pageIndex}:${row.root_message_id}`);
              this.context.database.prepare("UPDATE answer_pages SET sequence = MAX(sequence, ?), state = CASE WHEN ? THEN state ELSE ? END, updated_at = ? WHERE prompt_id = ? AND state = 'active' AND (? IS NULL OR page_index = ?)").run(row.view_version ?? 0, pendingFinalUpdate ? 1 : 0, pendingContinuation ? "frozen" : "finished", now(), row.prompt_id, pageIndex, pageIndex);
              if (!pendingContinuation && !pendingFinalUpdate) this.freezeRunCard(row.prompt_id);
            }
            if (row.kind === "card_update" && row.idempotency_key.startsWith("answer-final-fold:")) {
              const pendingContinuation = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' LIMIT 1").get(row.prompt_id);
              this.context.database.prepare("UPDATE answer_pages SET state = ?, updated_at = ? WHERE prompt_id = ? AND message_id = ? AND state = 'active'").run(pendingContinuation ? "frozen" : "finished", now(), row.prompt_id, row.root_message_id);
              if (!pendingContinuation) this.freezeRunCard(row.prompt_id);
            }
          }
        } else if (row.kind === "card_reply") this.context.database.prepare("UPDATE run_cards SET lark_message_id = ?, delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(messageId, row.view_version ?? 0, now(), row.prompt_id);
        else this.context.database.prepare("UPDATE run_cards SET delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(row.view_version ?? 0, now(), row.prompt_id);
      }
      if (row?.worker_turn_id) {
        const stream = streamCardState(row.payload);
        const pageIndex = stream?.pageIndex ?? 0;
        if (row.kind === "stream_card_create") {
          const expectedPageIndex = pageIndex > 0 ? pageIndex - 1 : pageIndex;
          const updated = this.context.database.prepare("UPDATE worker_turn_cards SET message_id = ?, card_id = COALESCE(?, card_id), element_id = COALESCE(?, element_id), page_index = ?, page_start = COALESCE(?, page_start), sequence = CASE WHEN ? IS NULL THEN sequence ELSE 0 END, delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE turn_id = ? AND page_index = ?").run(messageId, cardId ?? null, stream?.elementId ?? null, pageIndex, stream?.pageStart ?? null, cardId ?? null, row.view_version ?? 0, now(), row.worker_turn_id, expectedPageIndex);
          if (updated.changes > 0) {
            if (pageIndex > 0) this.context.database.prepare("UPDATE worker_turn_card_pages SET state = 'frozen', updated_at = ? WHERE turn_id = ? AND state = 'active' AND page_index < ?").run(now(), row.worker_turn_id, pageIndex);
            this.context.database.prepare("UPDATE worker_turn_card_pages SET message_id = ?, card_id = COALESCE(?, card_id), state = 'active', sequence = CASE WHEN ? IS NULL THEN sequence ELSE 0 END, updated_at = ? WHERE turn_id = ? AND page_index = ? AND state = 'creating'").run(messageId, cardId ?? null, cardId ?? null, now(), row.worker_turn_id, pageIndex);
            const task = this.dependencies.loadWorkerTurnCard(row.worker_turn_id);
            if (task) this.dependencies.invalidateCardContexts([{ targetKind: "worker-turn", targetId: task.turnId, targetGeneration: task.instanceGeneration, reason: "worker-task.delivered" }]);
          }
        } else {
          this.context.database.prepare("UPDATE worker_turn_cards SET delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE turn_id = ?").run(row.view_version ?? 0, now(), row.worker_turn_id);
          if (row.kind === "stream_content") this.context.database.prepare("UPDATE worker_turn_card_pages SET sequence = MAX(sequence, ?), updated_at = ? WHERE turn_id = ? AND page_index = ?").run(row.view_version ?? 0, now(), row.worker_turn_id, pageIndex);
          if (row.kind === "stream_finish") {
            const pendingContinuation = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_card_create' AND state = 'pending' LIMIT 1").get(row.worker_turn_id);
            this.context.database.prepare("UPDATE worker_turn_card_pages SET sequence = MAX(sequence, ?), state = ?, updated_at = ? WHERE turn_id = ? AND page_index = ? AND state = 'active'").run(row.view_version ?? 0, pendingContinuation ? "frozen" : "finished", now(), row.worker_turn_id, pageIndex);
          }
        }
      }
      if (row?.worker_id && row.worker_session_generation !== null) {
        const messageCheckpoint = row.kind === "card_reply" ? messageId : null;
        const cardCheckpoint = row.kind === "card_reply" ? cardId ?? null : null;
        this.context.database.prepare(`UPDATE worker_main_views SET delivered_version = MAX(delivered_version, ?), message_id = COALESCE(?, message_id), card_id = COALESCE(?, card_id), state_json = json_set(state_json, '$.deliveredVersion', MAX(COALESCE(json_extract(state_json, '$.deliveredVersion'), 0), ?), '$.messageId', COALESCE(?, json_extract(state_json, '$.messageId')), '$.cardId', COALESCE(?, json_extract(state_json, '$.cardId'))), updated_at = ? WHERE worker_id = ? AND worker_session_generation = ?`).run(row.view_version ?? 0, messageCheckpoint, cardCheckpoint, row.view_version ?? 0, messageCheckpoint, cardCheckpoint, now(), row.worker_id, row.worker_session_generation);
        if (messageCheckpoint) {
          const main = this.dependencies.loadWorkerMainView(row.worker_id, row.worker_session_generation);
          if (main) {
            const tasks = this.context.database.prepare("SELECT turn_id, instance_generation FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ?").all(row.worker_id, row.worker_session_generation) as Array<{ turn_id: string; instance_generation: number }>;
            this.dependencies.invalidateCardContexts([
              ...tasks.map((task) => ({ targetKind: "worker-turn" as const, targetId: task.turn_id, targetGeneration: Number(task.instance_generation), reason: "worker-main.delivered" })),
              { targetKind: "primary-session" as const, targetId: main.parentBindingId, targetGeneration: main.parentBindingGeneration, reason: "worker-main.delivered" }
            ]);
          }
        }
      }
      if (row?.prompt_id && row.card_role === "answer" && (row.kind === "card_reply" || row.kind === "stream_card_create")) {
        const tasks = this.context.database.prepare("SELECT c.turn_id, c.instance_generation FROM worker_turn_cards c JOIN instance_turns t ON t.id = c.turn_id WHERE json_extract(t.actor_json, '$.kind') = 'thread-primary' AND json_extract(t.actor_json, '$.parentPromptId') = ?").all(row.prompt_id) as Array<{ turn_id: string; instance_generation: number }>;
        this.dependencies.invalidateCardContexts(tasks.map((task) => ({ targetKind: "worker-turn" as const, targetId: task.turn_id, targetGeneration: Number(task.instance_generation), reason: "primary-answer.delivered" })));
      }
      if (row?.selection_id && row.kind === "card_reply") this.context.database.prepare("UPDATE project_selections SET selector_message_id = ?, updated_at = ? WHERE id = ?").run(messageId, now(), row.selection_id);
      if (row?.binding_id && row.target_role === "session_status") {
        const binding = this.dependencies.getBinding(row.binding_id);
        if (!binding) throw new Error(`Binding not found: ${row.binding_id}`);
        if (row.kind === "card_reply") this.dependencies.persistBindingPatch(row.binding_id, { statusMessageId: messageId, statusCardSequence: 0 });
        else if (row.kind === "card_update" && row.card_sequence !== null) this.dependencies.persistBindingPatch(row.binding_id, { statusCardSequence: Math.max(binding.statusCardSequence, row.card_sequence) });
        this.context.database.prepare(`UPDATE topic_views SET state_json = json_set(state_json, '$.deliveredVersion', MAX(COALESCE(json_extract(state_json, '$.deliveredVersion'), 0), ?)), updated_at = ? WHERE binding_id = ?`).run(row.view_version ?? 0, now(), row.binding_id);
      }
    });
  }

  checkpointOutboundReplyCard(id: string, cardId: string): OutboundReply | null {
    this.context.database.prepare("UPDATE outbound_replies SET card_id_checkpoint = COALESCE(card_id_checkpoint, ?), updated_at = ? WHERE id = ? AND state = 'pending'").run(cardId, now(), id);
    return this.getOutboundReply(id);
  }

  markOutboundReplyFailed(id: string, error: string, retryDelayMs?: number, metadata?: DeliveryFailureMetadata): OutboundReply | null {
    return this.context.transaction(() => {
      const row = this.context.database.prepare("SELECT attempt_count FROM outbound_replies WHERE id = ?").get(id) as { attempt_count: number } | undefined;
      if (!row) return null;
      const attempts = Number(row.attempt_count) + 1;
      const timestamp = now();
      const deadLetteredAt = attempts >= 5 ? timestamp : null;
      this.context.database.prepare(`UPDATE outbound_replies SET state = CASE WHEN ? >= 5 THEN 'dead_letter' ELSE state END, error = ?, attempt_count = ?, next_attempt_at = ?, failure_class = ?, http_status = ?, lark_error_code = ?, dead_lettered_at = ?, updated_at = ? WHERE id = ?`).run(attempts, boundedError(error), attempts, retryAt(attempts, retryDelayMs), metadata?.failureClass ?? "unknown", metadata?.httpStatus ?? null, metadata?.larkErrorCode ?? null, deadLetteredAt, timestamp, id);
      return this.getOutboundReply(id);
    });
  }

  markOutboundReplyDeadLetter(id: string, error: string, metadata?: DeliveryFailureMetadata): OutboundReply | null {
    const timestamp = now();
    this.context.database.prepare("UPDATE outbound_replies SET state = 'dead_letter', error = ?, failure_class = ?, http_status = ?, lark_error_code = ?, dead_lettered_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(boundedError(error), metadata?.failureClass ?? "permanent", metadata?.httpStatus ?? null, metadata?.larkErrorCode ?? null, timestamp, timestamp, id);
    return this.getOutboundReply(id);
  }

  getOutboundReply(id: string): OutboundReply | null {
    const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE id = ?").get(id) as OutboundReplyRow | undefined;
    return row ? mapOutboundReply(row) : null;
  }

  private freezeRunCard(promptId: string): void {
    const run = this.dependencies.loadRunCard(promptId);
    if (run) this.dependencies.saveRunCard(freezeRunCardWorkerContext(run, now()));
  }
}

function now(): string { return new Date().toISOString(); }
function boundedError(value: string | null): string { return (value ?? "Unknown failure").slice(0, 500); }
function retryAt(attempt: number, explicitDelayMs?: number): string {
  const exponential = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
  const jittered = Math.round(exponential * (0.8 + Math.random() * 0.4));
  const delay = explicitDelayMs === undefined ? jittered : Math.max(exponential, Math.min(3_600_000, explicitDelayMs));
  return new Date(Date.now() + delay).toISOString();
}
function streamCardState(payload: string): { pageIndex: number; pageStart: number; elementId: string } | null {
  try {
    const decoded = JSON.parse(payload) as { stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown } };
    const stream = decoded.stream;
    return stream && Number.isInteger(stream.pageIndex) && Number.isInteger(stream.pageStart) && typeof stream.elementId === "string"
      ? { pageIndex: Number(stream.pageIndex), pageStart: Number(stream.pageStart), elementId: stream.elementId } : null;
  } catch { return null; }
}
function parseJsonRecord(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value) as unknown; return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
