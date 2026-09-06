import { randomUUID } from "node:crypto";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { AnswerPage, Binding, DeadLetterActionOutcome, DeliveryFailureMetadata, OutboundFailureTransition, OutboundReply, OutboxLaneClass, StaleOutboxQuarantineRecovery } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import type { WorkerMainView } from "../../domain/worker-main-view.js";
import type { CardContextTarget } from "../../domain/card-context-invalidation.js";
import { freezeRunCardWorkerContext } from "../../domain/run-card-view.js";
import { ANSWER_RECOVERY_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage } from "../../runtime/answer-stream.js";
import { outboundLaneKey } from "../outbox-lanes.js";
import { mapOutboundReply, type OutboundReplyRow, type SqlValue } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import { encodeDeliveryIntent } from "../../domain/delivery-intent.js";

type EnqueueInput = Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string };

export class SqliteOutboxStore {
  constructor(
    private readonly context: SqliteContext,
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

  enqueueOutboundReply(input: EnqueueInput): OutboundReply {
    const timestamp = now();
    const bindingGeneration = input.promptId ? this.dependencies.loadRunCard(input.promptId)?.bindingGeneration ?? null : input.bindingId ? this.dependencies.getBinding(input.bindingId)?.generation ?? null : null;
    const laneKey = input.laneKeyOverride ?? outboundLaneKey({ ...input, bindingGeneration });
    const streamMetadata = outboundStreamMetadata(input.kind, input.payload);
    const encoded = encodeDeliveryIntent(input.kind, input.payload);
    const intentKind = input.intentKind ?? encoded.intentKind;
    const intentJson = input.intentJson ?? encoded.intentJson;
    const rendererRevision = input.rendererRevision ?? encoded.rendererRevision;
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
        INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, stream_page_index, stream_element_id, card_role, target_role, root_message_id, kind, payload, intent_kind, intent_json, renderer_revision, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          payload = CASE WHEN outbound_replies.state = 'pending' THEN excluded.payload ELSE outbound_replies.payload END,
          view_version = CASE WHEN outbound_replies.state = 'pending' THEN excluded.view_version ELSE outbound_replies.view_version END,
          card_sequence = CASE WHEN outbound_replies.state = 'pending' THEN excluded.card_sequence ELSE outbound_replies.card_sequence END,
          stream_page_index = CASE WHEN outbound_replies.state = 'pending' THEN excluded.stream_page_index ELSE outbound_replies.stream_page_index END,
          stream_element_id = CASE WHEN outbound_replies.state = 'pending' THEN excluded.stream_element_id ELSE outbound_replies.stream_element_id END,
          intent_kind = CASE WHEN outbound_replies.state = 'pending' THEN excluded.intent_kind ELSE outbound_replies.intent_kind END,
          intent_json = CASE WHEN outbound_replies.state = 'pending' THEN excluded.intent_json ELSE outbound_replies.intent_json END,
          renderer_revision = CASE WHEN outbound_replies.state = 'pending' THEN excluded.renderer_revision ELSE outbound_replies.renderer_revision END,
          updated_at = CASE WHEN outbound_replies.state = 'pending' THEN excluded.updated_at ELSE outbound_replies.updated_at END
      `).run(input.id, input.idempotencyKey, input.bindingId ?? null, input.promptId ?? null, input.workerTurnId ?? null, input.workerId ?? null, input.workerSessionGeneration ?? null, input.viewVersion ?? null, input.cardSequence ?? null, input.selectionId ?? null, streamMetadata.pageIndex, streamMetadata.elementId, input.cardRole ?? null, input.targetRole ?? null, input.rootMessageId, input.kind, input.payload, intentKind, intentJson, rendererRevision, laneKey, timestamp, timestamp, timestamp);
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

  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean {
    return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND state = 'pending' LIMIT 1").get(turnId) !== undefined;
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
        const tasks = this.context.database.prepare("SELECT c.turn_id, c.instance_generation FROM instance_turns t INDEXED BY instance_turns_primary_source JOIN worker_turn_cards c ON c.turn_id = t.id WHERE t.actor_kind = 'thread-primary' AND t.source_parent_prompt_id = ?").all(row.prompt_id) as Array<{ turn_id: string; instance_generation: number }>;
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

  markOutboundReplyFailedWithQuarantine(id: string, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number): OutboundFailureTransition | null {
    return this.context.transaction(() => {
      const before = this.getOutboundReply(id);
      if (!before) return null;
      if (before.state === "dead_letter") {
        const existing = this.context.database.prepare("SELECT lane_class, action FROM outbox_lane_quarantines WHERE lane_key = ? AND failed_reply_id = ?").get(before.laneKey, id) as { lane_class: OutboxLaneClass; action: OutboundFailureTransition["action"] } | undefined;
        if (existing) return { state: before.state, action: existing.action, laneClass: existing.lane_class, promptId: before.promptId, reply: before };
      }
      const staleMainCard = before.kind === "card_update" && before.targetRole === "session_status" && (metadata.larkErrorCode === "230099" || metadata.larkErrorCode === "300317");
      const closedAnswerStream = before.cardRole === "answer" && before.kind === "stream_content" && metadata.larkErrorCode === "300309";
      const failed = metadata.failureClass === "permanent" || staleMainCard || closedAnswerStream
        ? this.markOutboundReplyDeadLetter(id, error, metadata)
        : this.markOutboundReplyFailed(id, error, retryDelayMs, metadata);
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
          this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `main-card:rebuild:${failed.bindingId}:${replacement.view_version}`, bindingId: failed.bindingId, viewVersion: replacement.view_version, targetRole: "session_status", rootMessageId: binding.rootMessageId, kind: "card_reply", payload: replacement.payload });
          action = "rebuild_main"; quarantineState = "released";
        }
      } else if (laneClass === "main_card" || laneClass === "replaceable_card") {
        action = "released_newer_snapshot"; quarantineState = "released";
      }
      const laneKey = failed.laneKey;
      this.context.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key, failed_reply_id, lane_class, failure_class, state, action, reason, created_at, updated_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(lane_key) DO UPDATE SET failed_reply_id = excluded.failed_reply_id, lane_class = excluded.lane_class, failure_class = excluded.failure_class, state = excluded.state, action = excluded.action, reason = excluded.reason, updated_at = excluded.updated_at, released_at = excluded.released_at`).run(laneKey, id, laneClass, metadata.failureClass, quarantineState, action, boundedError(error), timestamp, timestamp, quarantineState === "released" ? timestamp : null);
      if (quarantineState === "released") this.refreshOutboxLaneHead(laneKey);
      else this.context.database.prepare("DELETE FROM outbox_lane_heads WHERE lane_key = ?").run(laneKey);
      return { state: failed.state, action, laneClass, promptId: failed.promptId, reply: failed };
    });
  }

  refreshOutboxLaneHead(laneKey: string): void {
    this.context.database.prepare("DELETE FROM outbox_lane_heads WHERE lane_key = ?").run(laneKey);
    this.context.database.prepare(`INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at) SELECT lane_key, id, delivery_order, next_attempt_at, created_at FROM outbound_replies WHERE lane_key = ? AND state = 'pending' AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = ? AND q.state = 'active') ORDER BY delivery_order LIMIT 1`).run(laneKey, laneKey);
  }

  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    return this.context.transaction(() => {
      const rows = this.context.database.prepare(`SELECT o.id FROM outbound_replies o WHERE o.state = 'dead_letter' AND o.failure_class = 'transient' AND o.auto_recovery_count = 0 AND o.dead_lettered_at IS NOT NULL AND o.dead_lettered_at <= ? AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = o.lane_key AND q.state = 'active') ORDER BY o.dead_lettered_at, o.delivery_order LIMIT ?`).all(cutoff, limit) as Array<{ id: string }>;
      const recovered: OutboundReply[] = [];
      for (const row of rows) {
        const timestamp = now();
        const updated = this.context.database.prepare(`UPDATE outbound_replies SET state = 'pending', attempt_count = 0, error = NULL, next_attempt_at = ?, auto_recovery_count = 1, updated_at = ? WHERE id = ? AND state = 'dead_letter' AND failure_class = 'transient' AND auto_recovery_count = 0 AND dead_lettered_at <= ?`).run(timestamp, timestamp, row.id, cutoff);
        if (updated.changes === 1) { const reply = this.getOutboundReply(row.id); if (reply) recovered.push(reply); }
      }
      return recovered;
    });
  }

  recoverUnsupportedWorkerCardCreates(render: (view: WorkerTurnCardView) => object): string[] {
    return this.context.transaction(() => {
      const rows = this.context.database.prepare(`SELECT o.id, o.worker_turn_id, o.lane_key FROM outbound_replies o JOIN worker_turn_cards card ON card.turn_id = o.worker_turn_id WHERE o.state = 'dead_letter' AND o.kind = 'stream_card_create' AND o.idempotency_key = 'worker-turn:create:' || o.worker_turn_id || ':0' AND card.message_id IS NULL AND card.card_id IS NULL AND o.lark_error_code IN ('200861', '230099') AND instr(o.payload, '"tag":"note"') > 0 ORDER BY o.delivery_order`).all() as Array<{ id: string; worker_turn_id: string; lane_key: string }>;
      const timestamp = now();
      const recovered: string[] = [];
      for (const row of rows) {
        const view = this.dependencies.loadWorkerTurnCard(row.worker_turn_id);
        if (!view) continue;
        const payload = JSON.stringify({ card: render(view), stream: { pageIndex: 0, pageStart: 0, elementId: view.elementId } });
        const updated = this.context.database.prepare(`UPDATE outbound_replies SET state = 'pending', payload = ?, view_version = ?, attempt_count = 0, error = NULL, delivered_message_id = NULL, card_id_checkpoint = NULL, failure_class = NULL, http_status = NULL, lark_error_code = NULL, auto_recovery_count = 0, dead_lettered_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND state = 'dead_letter'`).run(payload, view.viewVersion, timestamp, timestamp, row.id);
        if (updated.changes !== 1) continue;
        this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_rebuild', released_at = ?, updated_at = ? WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.id);
        this.refreshOutboxLaneHead(row.lane_key); recovered.push(row.worker_turn_id);
      }
      return recovered;
    });
  }

  convergeWorkerTaskCardRenderer(revision: string, render: (view: WorkerTurnCardView, page?: import("../../domain/worker-turn-card-view.js").WorkerTurnCardPage) => object): string[] {
    return this.context.transaction(() => {
      const rows = this.context.database.prepare(`SELECT card.turn_id FROM worker_turn_cards card WHERE card.message_id IS NOT NULL AND card.card_id IS NOT NULL AND card.phase IN ('running', 'blocked', 'completed', 'failed', 'cancelled') AND NOT EXISTS (SELECT 1 FROM outbound_replies reply WHERE reply.idempotency_key = 'worker-turn:renderer:' || ? || ':' || card.turn_id) ORDER BY card.created_at, card.turn_id`).all(revision) as Array<{ turn_id: string }>;
      const refreshed: string[] = [];
      for (const row of rows) {
        const view = this.dependencies.loadWorkerTurnCard(row.turn_id);
        if (!view?.messageId || !view.cardId) continue;
        const page = this.dependencies.listWorkerTurnCardPages(row.turn_id).find(({ pageIndex }) => pageIndex === view.pageIndex);
        this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-turn:renderer:${revision}:${view.turnId}`, bindingId: null, workerTurnId: view.turnId, viewVersion: view.viewVersion, rootMessageId: view.messageId, kind: "card_update", payload: JSON.stringify(render(view, page)), laneKeyOverride: `worker-turn:${view.turnId}` });
        refreshed.push(view.turnId);
      }
      return refreshed;
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
        const failed = this.getOutboundReply(row.id);
        if (!failed) continue;
        const replacement = this.enqueueOutboundReply({
          id: randomUUID(), idempotencyKey: `startup-lite:${row.id}`, bindingId: failed.bindingId, promptId: failed.promptId,
          viewVersion: failed.viewVersion, cardRole: failed.cardRole, rootMessageId: failed.rootMessageId, kind: "stream_card_create",
          payload: lightweightAnswerCardPayload(failed.payload)
        });
        this.context.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 2, updated_at = ? WHERE id = ? AND state = 'pending'").run(timestamp, replacement.id);
        this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_rebuild', released_at = ?, updated_at = ?
          WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.id);
        this.refreshOutboxLaneHead(row.lane_key);
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
        this.refreshOutboxLaneHead(row.lane_key);
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
        const replacement = this.enqueueOutboundReply({
          id: randomUUID(), idempotencyKey: `startup-lite-content:${failedContent.id}`, bindingId: view.bindingId, promptId, viewVersion: sequence, cardRole: "answer",
          rootMessageId: page.cardId, kind: "stream_content", payload: JSON.stringify({ pageIndex: page.pageIndex, elementId: page.elementId, content: rendered.page, sequence, sourceEnd })
        });
        this.context.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 2, updated_at = ? WHERE id = ? AND state = 'pending'").run(timestamp, replacement.id);
        this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_rebuild', released_at = ?, updated_at = ?
          WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, failedContent.lane_key, failedContent.id);
        this.refreshOutboxLaneHead(failedContent.lane_key);
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
        this.refreshOutboxLaneHead(row.lane_key);
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
        this.refreshOutboxLaneHead(row.lane_key);
        terminalizedQuarantines += 1;
      }
      return { retriedAnswerPromptIds, rolledBackAnswerPromptIds, dismissedNotices, terminalizedQuarantines };
    });
  }


  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome { return this.changeDeadLetter(id, chatId, actorOpenId, "retry"); }
  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome { return this.changeDeadLetter(id, chatId, actorOpenId, "dismiss"); }

  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    return Number(this.context.database.prepare(`DELETE FROM outbound_replies WHERE id IN (SELECT id FROM outbound_replies WHERE state IN ('delivered', 'dismissed') AND updated_at < ? ORDER BY updated_at, delivery_order LIMIT ?)`).run(cutoff, limit).changes);
  }

  private changeDeadLetter(id: string, chatId: string, actorOpenId: string, action: "retry" | "dismiss"): DeadLetterActionOutcome {
    return this.context.transaction(() => {
      const row = this.context.database.prepare(`SELECT o.state, COALESCE(b.chat_id, s.chat_id) AS chat_id FROM outbound_replies o LEFT JOIN bindings b ON b.id = o.binding_id LEFT JOIN project_selections s ON s.id = o.selection_id WHERE o.id = ?`).get(id) as { state: OutboundReply["state"]; chat_id: string | null } | undefined;
      let outcome: DeadLetterActionOutcome;
      if (!row) outcome = "missing"; else if (row.chat_id !== chatId) outcome = "unauthorized"; else if (row.state !== "dead_letter") outcome = "stale"; else {
        const lane = this.context.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(id) as { lane_key: string } | undefined;
        const nextState = action === "retry" ? "pending" : "dismissed";
        this.context.database.prepare("UPDATE outbound_replies SET state = ?, error = NULL, failure_class = NULL, http_status = NULL, lark_error_code = NULL, attempt_count = CASE WHEN ? = 'pending' THEN 0 ELSE attempt_count END, next_attempt_at = ?, updated_at = ? WHERE id = ? AND state = 'dead_letter'").run(nextState, nextState, now(), now(), id);
        if (lane) { this.context.database.prepare("UPDATE outbox_lane_quarantines SET state = 'released', action = ?, released_at = ?, updated_at = ? WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'").run(action === "retry" ? "manual_retry" : "manual_dismiss", now(), now(), lane.lane_key, id); this.refreshOutboxLaneHead(lane.lane_key); }
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
function streamCardState(payload: string): { pageIndex: number; pageStart: number; elementId: string } | null {
  try {
    const decoded = JSON.parse(payload) as { stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown } };
    const stream = decoded.stream;
    return stream && Number.isInteger(stream.pageIndex) && Number.isInteger(stream.pageStart) && typeof stream.elementId === "string"
      ? { pageIndex: Number(stream.pageIndex), pageStart: Number(stream.pageStart), elementId: stream.elementId } : null;
  } catch { return null; }
}
function outboundStreamMetadata(kind: OutboundReply["kind"], payload: string): { pageIndex: number | null; elementId: string | null } {
  if (kind !== "stream_card_create" && kind !== "stream_content" && kind !== "stream_finish") return { pageIndex: null, elementId: null };
  const decoded = parseJsonRecord(payload);
  const stream = kind === "stream_card_create" && typeof decoded.stream === "object" && decoded.stream !== null && !Array.isArray(decoded.stream)
    ? decoded.stream as Record<string, unknown> : decoded;
  return {
    pageIndex: Number.isInteger(stream.pageIndex) ? Number(stream.pageIndex) : null,
    elementId: typeof stream.elementId === "string" ? stream.elementId : null
  };
}
function parseJsonRecord(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value) as unknown; return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
