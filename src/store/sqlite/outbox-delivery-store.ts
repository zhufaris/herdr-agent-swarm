import type { OutboundDeliveryClaim } from "../../domain/delivery.js";
import type { Binding, DeliveryFailureMetadata, OutboundReply } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import type { WorkerMainView } from "../../domain/worker-main-view.js";
import type { CardContextTarget } from "../../domain/card-context-invalidation.js";
import { freezeRunCardWorkerContext } from "../../domain/run-card-view.js";
import type { SqliteContext } from "./context.js";
import type { SqliteOutboxQueueStore } from "./outbox-queue-store.js";
import { confirmAnswerRecoveries, confirmDeliveryRecoveries } from "./delivery-recovery-evidence.js";

export class SqliteOutboxDeliveryStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
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

  markDelivered(id: string, messageId: string, cardId?: string, claim?: OutboundDeliveryClaim, topicId?: string): boolean {
    return this.context.transaction(() => {
      if (!this.queue.matchesClaim(id, claim)) return false;
      const row = this.context.database.prepare("SELECT idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, card_role, target_role, thread_alias_id, worker_thread_id, kind, payload, root_message_id, state FROM outbound_replies WHERE id = ?").get(id) as { idempotency_key: string; binding_id: string | null; prompt_id: string | null; worker_turn_id: string | null; worker_id: string | null; worker_session_generation: number | null; view_version: number | null; card_sequence: number | null; selection_id: string | null; card_role: string | null; target_role: string | null; thread_alias_id: string | null; worker_thread_id: string | null; kind: string; payload: string; root_message_id: string | null; state: OutboundReply["state"] } | undefined;
      if (!row || row.state !== "pending") {
        if (claim) this.queue.releaseClaim(id);
        return false;
      }
      const delivered = this.context.database.prepare("UPDATE outbound_replies SET state = 'delivered', delivered_message_id = ?, error = NULL, failure_class = NULL, http_status = NULL, lark_error_code = NULL, dead_lettered_at = NULL, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'pending'").run(messageId, now(), id);
      if (delivered.changes !== 1) return false;
      this.queue.releaseClaim(id);
      if (row.kind === "group_card_create" && row.thread_alias_id) {
        if (!topicId) throw new Error("Group card delivery returned no thread identity");
        const activated = this.context.database.prepare(`UPDATE binding_thread_aliases AS alias SET topic_id = ?, root_message_id = ?, state = CASE WHEN EXISTS (SELECT 1 FROM bindings b WHERE b.id = alias.binding_id AND b.chat_id = alias.chat_id AND b.generation = alias.binding_generation AND b.pane_id = alias.pane_id AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached') THEN 'active' ELSE 'stale' END, updated_at = ? WHERE id = ? AND state = 'reserving'`).run(topicId, messageId, now(), row.thread_alias_id);
        if (activated.changes !== 1) throw new Error("Group card thread alias is stale");
        this.context.database.prepare("INSERT OR IGNORE INTO bridge_messages(message_id, created_at) VALUES (?, ?)").run(messageId, now());
      }
      let canonicalWorkerGroupCreate = false;
      if (row.kind === "group_card_create" && row.worker_thread_id) {
        if (!topicId || !row.worker_id || row.worker_session_generation === null) throw new Error("Worker group card delivery returned incomplete identity");
        const thread = this.context.database.prepare("SELECT mode FROM worker_session_threads WHERE id = ? AND state = 'reserving'").get(row.worker_thread_id) as { mode: "canonical-main" | "legacy-entry" } | undefined;
        if (!thread) throw new Error("Worker Session thread is stale");
        const valid = this.context.database.prepare(`SELECT 1 FROM worker_session_threads thread JOIN agent_instances worker ON worker.id = thread.worker_id JOIN bindings binding ON binding.id = thread.parent_binding_id WHERE thread.id = ? AND thread.state = 'reserving' AND worker.role = 'worker' AND worker.worker_session_lifecycle = 'active' AND worker.worker_session_generation = thread.worker_session_generation AND worker.parent_binding_id = thread.parent_binding_id AND worker.parent_binding_generation = thread.parent_binding_generation AND worker.parent_pane_id = thread.parent_pane_id AND binding.chat_id = thread.chat_id AND binding.generation = thread.parent_binding_generation AND binding.pane_id = thread.parent_pane_id AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'`).get(row.worker_thread_id);
        const timestamp = now();
        const activated = valid
          ? this.context.database.prepare("UPDATE worker_session_threads SET topic_id = ?, root_message_id = ?, state = 'active', activated_at = ?, updated_at = ? WHERE id = ? AND state = 'reserving'").run(topicId, messageId, timestamp, timestamp, row.worker_thread_id)
          : this.context.database.prepare("UPDATE worker_session_threads SET topic_id = ?, root_message_id = ?, state = 'stale', activated_at = ?, stale_at = ?, updated_at = ? WHERE id = ? AND state = 'reserving'").run(topicId, messageId, timestamp, timestamp, timestamp, row.worker_thread_id);
        if (activated.changes !== 1) throw new Error("Worker Session thread is stale");
        canonicalWorkerGroupCreate = thread.mode === "canonical-main" && Boolean(valid);
        this.context.database.prepare("INSERT OR IGNORE INTO bridge_messages(message_id, created_at) VALUES (?, ?)").run(messageId, timestamp);
      }
      if (row.prompt_id) {
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
              const pendingFinalUpdate = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'card_update' AND state = 'pending' AND (idempotency_key = ? OR projection_key = ?) LIMIT 1").get(row.prompt_id, `answer-final-fold:${row.prompt_id}:${pageIndex}:${row.root_message_id}`, `answer-final-fold:${row.prompt_id}:${pageIndex}:${row.root_message_id}`);
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
      if (row.worker_turn_id) {
        const stream = streamCardState(row.payload);
        const pageIndex = stream?.pageIndex ?? 0;
        if (row.kind === "stream_card_create") {
          const expectedPageIndex = pageIndex > 0 ? pageIndex - 1 : pageIndex;
          const updated = this.context.database.prepare("UPDATE worker_turn_cards SET message_id = ?, card_id = COALESCE(?, card_id), element_id = COALESCE(?, element_id), page_index = ?, page_start = COALESCE(?, page_start), sequence = CASE WHEN ? IS NULL THEN sequence ELSE 0 END, delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE turn_id = ? AND page_index = ?").run(messageId, cardId ?? null, stream?.elementId ?? null, pageIndex, stream?.pageStart ?? null, cardId ?? null, row.view_version ?? 0, now(), row.worker_turn_id, expectedPageIndex);
          if (updated.changes > 0) {
            if (pageIndex > 0) this.context.database.prepare("UPDATE worker_turn_card_pages SET state = 'frozen', updated_at = ? WHERE turn_id = ? AND state = 'active' AND page_index < ?").run(now(), row.worker_turn_id, pageIndex);
            this.context.database.prepare("UPDATE worker_turn_card_pages SET message_id = ?, card_id = COALESCE(?, card_id), state = 'active', sequence = CASE WHEN ? IS NULL THEN sequence ELSE 0 END, updated_at = ? WHERE turn_id = ? AND page_index = ? AND state = 'creating'").run(messageId, cardId ?? null, cardId ?? null, now(), row.worker_turn_id, pageIndex);
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
      if (row.worker_id && row.worker_session_generation !== null && (row.kind !== "group_card_create" || canonicalWorkerGroupCreate)) {
        const messageCheckpoint = row.kind === "card_reply" || canonicalWorkerGroupCreate ? messageId : null;
        const cardCheckpoint = row.kind === "card_reply" || canonicalWorkerGroupCreate ? cardId ?? null : null;
        this.context.database.prepare(`UPDATE worker_main_views SET delivered_version = MAX(delivered_version, ?), message_id = COALESCE(?, message_id), card_id = COALESCE(?, card_id), state_json = json_set(state_json, '$.deliveredVersion', MAX(COALESCE(json_extract(state_json, '$.deliveredVersion'), 0), ?), '$.messageId', COALESCE(?, json_extract(state_json, '$.messageId')), '$.cardId', COALESCE(?, json_extract(state_json, '$.cardId'))), updated_at = ? WHERE worker_id = ? AND worker_session_generation = ?`).run(row.view_version ?? 0, messageCheckpoint, cardCheckpoint, row.view_version ?? 0, messageCheckpoint, cardCheckpoint, now(), row.worker_id, row.worker_session_generation);
        if (messageCheckpoint) {
          const main = this.dependencies.loadWorkerMainView(row.worker_id, row.worker_session_generation);
          if (main) this.dependencies.invalidateCardContexts([
            { targetKind: "worker-session", targetId: main.workerId, targetGeneration: main.workerSessionGeneration, reason: "worker-main.delivered" },
            { targetKind: "primary-session", targetId: main.parentBindingId, targetGeneration: main.parentBindingGeneration, reason: "worker-main.delivered" }
          ]);
        }
      }
      if (row.prompt_id && row.card_role === "answer" && (row.kind === "card_reply" || row.kind === "stream_card_create")) {
        // Historical Worker Task Cards no longer mirror Primary Answer delivery.
      }
      if (row.selection_id && row.kind === "card_reply") this.context.database.prepare("UPDATE project_selections SET selector_message_id = ?, updated_at = ? WHERE id = ?").run(messageId, now(), row.selection_id);
      if (row.binding_id && row.target_role === "session_status") {
        const binding = this.dependencies.getBinding(row.binding_id);
        if (!binding) throw new Error(`Binding not found: ${row.binding_id}`);
        if (row.kind === "card_reply") this.dependencies.persistBindingPatch(row.binding_id, { statusMessageId: messageId, statusCardSequence: 0 });
        else if (row.kind === "card_update" && row.card_sequence !== null) this.dependencies.persistBindingPatch(row.binding_id, { statusCardSequence: Math.max(binding.statusCardSequence, row.card_sequence) });
        this.context.database.prepare(`UPDATE topic_views SET state_json = json_set(state_json, '$.deliveredVersion', MAX(COALESCE(json_extract(state_json, '$.deliveredVersion'), 0), ?)), updated_at = ? WHERE binding_id = ?`).run(row.view_version ?? 0, now(), row.binding_id);
      }
      confirmDeliveryRecoveries(this.context, id);
      confirmAnswerRecoveries(this.context, id);
      return true;
    });
  }

  checkpointCard(id: string, cardId: string, claim?: OutboundDeliveryClaim): OutboundReply | null {
    return this.context.transaction(() => {
      if (!this.queue.matchesClaim(id, claim)) return null;
      const updated = this.context.database.prepare("UPDATE outbound_replies SET card_id_checkpoint = COALESCE(card_id_checkpoint, ?), updated_at = ? WHERE id = ? AND state = 'pending' AND (card_id_checkpoint IS NULL OR card_id_checkpoint = ?)").run(cardId, now(), id, cardId);
      return updated.changes === 1 ? this.queue.get(id) : null;
    });
  }

  markFailed(id: string, error: string, retryDelayMs?: number, metadata?: DeliveryFailureMetadata, claim?: OutboundDeliveryClaim): OutboundReply | null {
    return this.context.transaction(() => {
      if (!this.queue.matchesClaim(id, claim)) return null;
      const row = this.context.database.prepare("SELECT attempt_count, state FROM outbound_replies WHERE id = ?").get(id) as { attempt_count: number; state: OutboundReply["state"] } | undefined;
      if (!row || row.state !== "pending") return null;
      const attempts = Number(row.attempt_count) + 1;
      const timestamp = now();
      const deadLetteredAt = attempts >= 5 ? timestamp : null;
      const updated = this.context.database.prepare(`UPDATE outbound_replies SET state = CASE WHEN ? >= 5 THEN 'dead_letter' ELSE state END, error = ?, attempt_count = ?, claim_attempt_id = NULL, claimed_fence = NULL, claimed_at = NULL, next_attempt_at = ?, failure_class = ?, http_status = ?, lark_error_code = ?, dead_lettered_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'`).run(attempts, boundedError(error), attempts, retryAt(attempts, retryDelayMs), metadata?.failureClass ?? "unknown", metadata?.httpStatus ?? null, metadata?.larkErrorCode ?? null, deadLetteredAt, timestamp, id);
      return updated.changes === 1 ? this.queue.get(id) : null;
    });
  }

  markDeadLetter(id: string, error: string, metadata?: DeliveryFailureMetadata, claim?: OutboundDeliveryClaim): OutboundReply | null {
    return this.context.transaction(() => {
      if (!this.queue.matchesClaim(id, claim)) return null;
      const timestamp = now();
      const updated = this.context.database.prepare("UPDATE outbound_replies SET state = 'dead_letter', claim_attempt_id = NULL, claimed_fence = NULL, claimed_at = NULL, error = ?, failure_class = ?, http_status = ?, lark_error_code = ?, dead_lettered_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'pending'").run(boundedError(error), metadata?.failureClass ?? "permanent", metadata?.httpStatus ?? null, metadata?.larkErrorCode ?? null, timestamp, timestamp, id);
      return updated.changes === 1 ? this.queue.get(id) : null;
    });
  }

  private freezeRunCard(promptId: string): void {
    const run = this.dependencies.loadRunCard(promptId);
    if (run) this.dependencies.saveRunCard(freezeRunCardWorkerContext(run, now()));
  }
}

export function boundedOutboxError(value: string | null): string { return (value ?? "Unknown failure").slice(0, 500); }
function boundedError(value: string | null): string { return boundedOutboxError(value); }
function retryAt(attempt: number, explicitDelayMs?: number): string {
  const exponential = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
  const jittered = Math.round(exponential * (0.8 + Math.random() * 0.4));
  const delay = explicitDelayMs === undefined ? jittered : Math.max(exponential, Math.min(3_600_000, explicitDelayMs));
  return new Date(Date.now() + delay).toISOString();
}
function now(): string { return new Date().toISOString(); }
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
