import { randomUUID } from "node:crypto";
import type { WorkerSessionThread, WorkerSessionThreadMode } from "../../domain/worker-session-thread.js";
import { mapWorkerSessionThread, type WorkerSessionThreadRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteOutboxQueueStore } from "./outbox-queue-store.js";

export interface ReserveWorkerSessionThreadInput {
  publicationKey: string;
  workerId: string;
  workerSessionGeneration: number;
  parentBindingId: string;
  parentBindingGeneration: number;
  parentPaneId: string;
  targetChatId: string;
  mode: WorkerSessionThreadMode;
  sourceMainMessageId?: string | null;
  actionMessageId?: string | null;
  viewVersion?: number | null;
  card: object;
}

export type WorkerSessionThreadReservation = "reserved" | "duplicate" | "stale";

export class SqliteWorkerSessionThreadStore {
  constructor(private readonly context: SqliteContext) {}

  reserve(input: ReserveWorkerSessionThreadInput, queue: SqliteOutboxQueueStore): WorkerSessionThreadReservation {
    return this.context.transaction(() => {
      const existing = this.loadBySession(input.workerId, input.workerSessionGeneration);
      if (existing && existing.state !== "legacy-unpublished") return existing.state === "stale" ? "stale" : "duplicate";
      if (existing && input.mode !== "legacy-entry") return "stale";
      const worker = this.context.database.prepare(`
        SELECT role, worker_session_lifecycle, worker_session_generation, parent_binding_id, parent_binding_generation, parent_pane_id
        FROM agent_instances WHERE id = ?
      `).get(input.workerId) as { role: string; worker_session_lifecycle: string | null; worker_session_generation: number; parent_binding_id: string | null; parent_binding_generation: number | null; parent_pane_id: string | null } | undefined;
      const binding = this.context.database.prepare("SELECT chat_id, generation, pane_id, state, lifecycle, attachment FROM bindings WHERE id = ?").get(input.parentBindingId) as { chat_id: string; generation: number; pane_id: string | null; state: string; lifecycle: string; attachment: string } | undefined;
      const main = this.context.database.prepare("SELECT message_id FROM worker_main_views WHERE worker_id = ? AND worker_session_generation = ?").get(input.workerId, input.workerSessionGeneration) as { message_id: string | null } | undefined;
      if (!worker || worker.role !== "worker" || worker.worker_session_lifecycle !== "active" || Number(worker.worker_session_generation) !== input.workerSessionGeneration
        || worker.parent_binding_id !== input.parentBindingId || Number(worker.parent_binding_generation) !== input.parentBindingGeneration || worker.parent_pane_id !== input.parentPaneId
        || !binding || binding.chat_id !== input.targetChatId || Number(binding.generation) !== input.parentBindingGeneration || binding.pane_id !== input.parentPaneId
        || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return "stale";
      const sourceMainMessageId = input.sourceMainMessageId ?? null;
      if (input.mode === "legacy-entry" && (!sourceMainMessageId || main?.message_id !== sourceMainMessageId)) return "stale";
      if (input.mode === "canonical-main" && (sourceMainMessageId !== null || main?.message_id)) return "stale";
      const timestamp = now();
      const threadId = existing?.id ?? randomUUID();
      if (existing) {
        this.context.database.prepare("UPDATE worker_session_threads SET publication_key = ?, source_main_message_id = ?, action_message_id = ?, state = 'reserving', updated_at = ? WHERE id = ? AND state = 'legacy-unpublished'").run(input.publicationKey, sourceMainMessageId, input.actionMessageId ?? null, timestamp, threadId);
      } else {
        this.context.database.prepare(`
          INSERT INTO worker_session_threads(
            id, publication_key, worker_id, worker_session_generation, parent_binding_id, parent_binding_generation, parent_pane_id, chat_id, mode, source_main_message_id, action_message_id, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserving', ?, ?)
        `).run(threadId, input.publicationKey, input.workerId, input.workerSessionGeneration, input.parentBindingId, input.parentBindingGeneration, input.parentPaneId, input.targetChatId, input.mode, sourceMainMessageId, input.actionMessageId ?? null, timestamp, timestamp);
      }
      queue.enqueue({
        id: randomUUID(), idempotencyKey: input.publicationKey, bindingId: input.parentBindingId, workerId: input.workerId, workerSessionGeneration: input.workerSessionGeneration,
        workerThreadId: threadId, viewVersion: input.viewVersion ?? null, targetChatId: input.targetChatId, rootMessageId: null, kind: "group_card_create", payload: JSON.stringify(input.card),
        laneKeyOverride: `worker-thread:${input.workerId}:${input.workerSessionGeneration}`
      });
      return "reserved";
    });
  }

  loadBySession(workerId: string, workerSessionGeneration: number): WorkerSessionThread | null {
    const row = this.context.database.prepare("SELECT * FROM worker_session_threads WHERE worker_id = ? AND worker_session_generation = ?").get(workerId, workerSessionGeneration) as WorkerSessionThreadRow | undefined;
    return row ? mapWorkerSessionThread(row) : null;
  }

  findActiveByScope(chatId: string, topicId: string | null, rootMessageId: string | null): WorkerSessionThread | null {
    const thread = this.findByScope(chatId, topicId, rootMessageId);
    if (!thread || thread.state !== "active") return null;
    const valid = this.context.database.prepare(`SELECT 1 FROM agent_instances worker JOIN bindings binding ON binding.id = ? WHERE worker.id = ? AND worker.role = 'worker' AND worker.worker_session_lifecycle = 'active' AND worker.worker_session_generation = ? AND worker.parent_binding_id = ? AND worker.parent_binding_generation = ? AND worker.parent_pane_id = ? AND binding.chat_id = ? AND binding.generation = ? AND binding.pane_id = ? AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'`).get(thread.parentBindingId, thread.workerId, thread.workerSessionGeneration, thread.parentBindingId, thread.parentBindingGeneration, thread.parentPaneId, thread.chatId, thread.parentBindingGeneration, thread.parentPaneId);
    return valid ? thread : null;
  }

  findByScope(chatId: string, topicId: string | null, rootMessageId: string | null): WorkerSessionThread | null {
    if (!topicId && !rootMessageId) return null;
    const row = this.context.database.prepare(`
      SELECT thread.* FROM worker_session_threads thread
      WHERE thread.chat_id = ?
        AND ((? IS NOT NULL AND thread.topic_id = ?) OR (? IS NOT NULL AND thread.root_message_id = ?))
      ORDER BY thread.created_at DESC LIMIT 1
    `).get(chatId, topicId, topicId, rootMessageId, rootMessageId) as WorkerSessionThreadRow | undefined;
    return row ? mapWorkerSessionThread(row) : null;
  }
}

function now(): string { return new Date().toISOString(); }
