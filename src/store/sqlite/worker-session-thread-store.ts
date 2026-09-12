import { randomUUID } from "node:crypto";
import type { WorkerSessionThread, WorkerSessionThreadMode } from "../../domain/worker-session-thread.js";
import type { WorkerSessionThreadApplicationStore, WorkerThreadPublicationDecision, WorkerThreadResolution, WorkerThreadScope } from "../../domain/ports/worker-session-thread.js";
import type { WorkerMainView } from "../../domain/worker-main-view.js";
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
  private enqueueOutboundReply: ((input: Parameters<SqliteOutboxQueueStore["enqueue"]>[0]) => unknown) | null = null;
  constructor(private readonly context: SqliteContext) {}

  connectOutbox(enqueue: (input: Parameters<SqliteOutboxQueueStore["enqueue"]>[0]) => unknown): void {
    if (this.enqueueOutboundReply) throw new Error("Worker Session Thread outbox is already connected");
    this.enqueueOutboundReply = enqueue;
  }

  resolveScope(scope: WorkerThreadScope): WorkerThreadResolution {
    const thread = this.findByScope(scope.chatId, scope.topicId, scope.rootMessageId);
    if (!thread) return { kind: "none" };
    if (thread.state !== "active" || !thread.rootMessageId) return { kind: "stale", threadId: thread.id };
    const row = this.context.database.prepare(`
      SELECT worker.name AS worker_name, worker.project_id, worker.generation AS runtime_generation, main.state_json, turn.id AS active_turn_id, turn.state AS active_turn_state
      FROM worker_session_threads thread
      JOIN agent_instances worker ON worker.id = thread.worker_id
      JOIN bindings binding ON binding.id = thread.parent_binding_id
      JOIN worker_main_views main ON main.worker_id = thread.worker_id AND main.worker_session_generation = thread.worker_session_generation
      LEFT JOIN instance_turns turn ON turn.instance_id = worker.id AND turn.instance_generation = worker.generation AND turn.state IN ('claimed','dispatching','running','blocked')
      WHERE thread.id = ? AND thread.state = 'active' AND worker.role = 'worker' AND worker.worker_session_lifecycle = 'active'
        AND worker.worker_session_generation = thread.worker_session_generation AND worker.parent_binding_id = thread.parent_binding_id
        AND worker.parent_binding_generation = thread.parent_binding_generation AND worker.parent_pane_id = thread.parent_pane_id
        AND binding.chat_id = thread.chat_id AND binding.generation = thread.parent_binding_generation AND binding.pane_id = thread.parent_pane_id
        AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
      ORDER BY turn.created_at LIMIT 1
    `).get(thread.id) as { worker_name: string; project_id: string; runtime_generation: number; state_json: string; active_turn_id: string | null; active_turn_state: string | null } | undefined;
    if (!row) return { kind: "stale", threadId: thread.id };
    return { kind: "active", target: {
      threadId: thread.id, workerId: thread.workerId, workerName: row.worker_name, workerSessionGeneration: thread.workerSessionGeneration, projectId: row.project_id, runtimeGeneration: Number(row.runtime_generation),
      parentBindingId: thread.parentBindingId, parentBindingGeneration: thread.parentBindingGeneration, parentPaneId: thread.parentPaneId, rootMessageId: thread.rootMessageId, mode: thread.mode,
      view: JSON.parse(row.state_json) as WorkerMainView, activeTurn: row.active_turn_id ? { id: row.active_turn_id, state: row.active_turn_state! } : null
    } };
  }

  reserveLegacyEntry(input: Parameters<WorkerSessionThreadApplicationStore["reserveLegacyEntry"]>[0]): WorkerThreadPublicationDecision {
    return this.context.transaction(() => {
      const worker = this.context.database.prepare("SELECT generation, worker_session_generation, parent_binding_id, parent_binding_generation, parent_pane_id FROM agent_instances WHERE id = ? AND role = 'worker' AND worker_session_lifecycle = 'active'").get(input.target.instanceId) as { generation: number; worker_session_generation: number; parent_binding_id: string | null; parent_binding_generation: number | null; parent_pane_id: string | null } | undefined;
      if (!worker || Number(worker.generation) !== input.target.runtimeGeneration || Number(worker.worker_session_generation) !== input.target.workerSessionGeneration || worker.parent_binding_id !== input.target.bindingId || Number(worker.parent_binding_generation) !== input.target.bindingGeneration) return { kind: "stale" };
      const mainRow = this.context.database.prepare("SELECT state_json, message_id FROM worker_main_views WHERE worker_id = ? AND worker_session_generation = ?").get(input.target.instanceId, input.target.workerSessionGeneration) as { state_json: string; message_id: string | null } | undefined;
      if (!mainRow?.message_id || !worker.parent_pane_id) return { kind: "stale" };
      const existing = this.loadBySession(input.target.instanceId, input.target.workerSessionGeneration);
      if (existing?.state === "active" && existing.rootMessageId) return { kind: "existing", rootMessageId: existing.rootMessageId };
      if (existing?.state === "reserving") return { kind: "pending" };
      if (existing?.state === "stale") return { kind: "stale" };
      const publicationKey = `worker-thread:${input.target.instanceId}:${input.target.workerSessionGeneration}`;
      const decision = this.reserve({ publicationKey, workerId: input.target.instanceId, workerSessionGeneration: input.target.workerSessionGeneration, parentBindingId: input.target.bindingId!, parentBindingGeneration: input.target.bindingGeneration!, parentPaneId: worker.parent_pane_id, targetChatId: input.chatId, mode: "legacy-entry", sourceMainMessageId: mainRow.message_id, actionMessageId: input.actionMessageId, card: input.render(JSON.parse(mainRow.state_json) as WorkerMainView, now()) });
      return decision === "reserved" ? { kind: "reserved" } : decision === "duplicate" ? { kind: "pending" } : { kind: "stale" };
    });
  }

  private reserve(input: ReserveWorkerSessionThreadInput): WorkerSessionThreadReservation {
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
      this.requireOutbox()({
        id: randomUUID(), idempotencyKey: input.publicationKey, bindingId: input.parentBindingId, workerId: input.workerId, workerSessionGeneration: input.workerSessionGeneration,
        workerThreadId: threadId, viewVersion: input.viewVersion ?? null, targetChatId: input.targetChatId, rootMessageId: null, kind: "group_card_create", payload: JSON.stringify(input.card),
        laneKeyOverride: `worker-thread:${input.workerId}:${input.workerSessionGeneration}`
      });
      return "reserved";
    });
  }

  settlePublication(input: { threadId: string; workerId: string; workerSessionGeneration: number; viewVersion: number | null; messageId: string; cardId: string | null; topicId: string; occurredAt: string }): { kind: "canonical" | "legacy" | "stale"; invalidations: Array<{ targetKind: "worker-session" | "primary-session"; targetId: string; targetGeneration: number; reason: string }> } {
    return this.context.transaction(() => {
      const thread = this.context.database.prepare("SELECT mode, parent_binding_id, parent_binding_generation FROM worker_session_threads WHERE id = ? AND worker_id = ? AND worker_session_generation = ? AND state = 'reserving'").get(input.threadId, input.workerId, input.workerSessionGeneration) as { mode: "canonical-main" | "legacy-entry"; parent_binding_id: string; parent_binding_generation: number } | undefined;
      if (!thread) throw new Error("Worker Session thread is stale");
      const valid = this.context.database.prepare(`SELECT 1 FROM worker_session_threads thread JOIN agent_instances worker ON worker.id = thread.worker_id JOIN bindings binding ON binding.id = thread.parent_binding_id WHERE thread.id = ? AND thread.state = 'reserving' AND worker.role = 'worker' AND worker.worker_session_lifecycle = 'active' AND worker.worker_session_generation = thread.worker_session_generation AND worker.parent_binding_id = thread.parent_binding_id AND worker.parent_binding_generation = thread.parent_binding_generation AND worker.parent_pane_id = thread.parent_pane_id AND binding.chat_id = thread.chat_id AND binding.generation = thread.parent_binding_generation AND binding.pane_id = thread.parent_pane_id AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'`).get(input.threadId);
      const updated = valid
        ? this.context.database.prepare("UPDATE worker_session_threads SET topic_id = ?, root_message_id = ?, state = 'active', activated_at = ?, updated_at = ? WHERE id = ? AND state = 'reserving'").run(input.topicId, input.messageId, input.occurredAt, input.occurredAt, input.threadId)
        : this.context.database.prepare("UPDATE worker_session_threads SET topic_id = ?, root_message_id = ?, state = 'stale', activated_at = ?, stale_at = ?, updated_at = ? WHERE id = ? AND state = 'reserving'").run(input.topicId, input.messageId, input.occurredAt, input.occurredAt, input.occurredAt, input.threadId);
      if (updated.changes !== 1) throw new Error("Worker Session thread is stale");
      const canonical = thread.mode === "canonical-main" && Boolean(valid);
      if (canonical) {
        const mainUpdated = this.context.database.prepare(`UPDATE worker_main_views SET delivered_version = MAX(delivered_version, ?), message_id = ?, card_id = COALESCE(?, card_id), state_json = json_set(state_json, '$.deliveredVersion', MAX(COALESCE(json_extract(state_json, '$.deliveredVersion'), 0), ?), '$.messageId', ?, '$.cardId', COALESCE(?, json_extract(state_json, '$.cardId'))), updated_at = ? WHERE worker_id = ? AND worker_session_generation = ?`).run(input.viewVersion ?? 0, input.messageId, input.cardId, input.viewVersion ?? 0, input.messageId, input.cardId, input.occurredAt, input.workerId, input.workerSessionGeneration);
        if (mainUpdated.changes !== 1) throw new Error("Worker Main Card target is stale");
      }
      this.context.database.prepare("INSERT OR IGNORE INTO bridge_messages(message_id, created_at) VALUES (?, ?)").run(input.messageId, input.occurredAt);
      return { kind: !valid ? "stale" : canonical ? "canonical" : "legacy", invalidations: canonical ? [
        { targetKind: "worker-session", targetId: input.workerId, targetGeneration: input.workerSessionGeneration, reason: "worker-main.delivered" },
        { targetKind: "primary-session", targetId: thread.parent_binding_id, targetGeneration: Number(thread.parent_binding_generation), reason: "worker-main.delivered" }
      ] : [] };
    });
  }

  reserveCanonicalMain(view: WorkerMainView, card: object): "reserved" | "waiting" | "current" | "stale" {
    return this.context.transaction(() => {
      const binding = this.context.database.prepare("SELECT chat_id, root_message_id, generation, pane_id, state, lifecycle, attachment FROM bindings WHERE id = ?").get(view.parentBindingId) as { chat_id: string; root_message_id: string | null; generation: number; pane_id: string | null; state: string; lifecycle: string; attachment: string } | undefined;
      const instance = this.context.database.prepare("SELECT role, worker_session_generation, parent_binding_id, parent_binding_generation, parent_pane_id FROM agent_instances WHERE id = ?").get(view.workerId) as { role: string; worker_session_generation: number; parent_binding_id: string | null; parent_binding_generation: number | null; parent_pane_id: string | null } | undefined;
      if (!binding?.root_message_id || !instance || instance.role !== "worker" || Number(instance.worker_session_generation) !== view.workerSessionGeneration || instance.parent_binding_id !== view.parentBindingId || Number(instance.parent_binding_generation) !== view.parentBindingGeneration || instance.parent_pane_id !== view.parentPaneId || Number(binding.generation) !== view.parentBindingGeneration || binding.pane_id !== view.parentPaneId) return "stale";
      const previous = this.loadMainView(view.workerId, view.workerSessionGeneration);
      const saved = this.saveMainView(view);
      if (!saved) return "stale";
      const thread = this.loadBySession(view.workerId, view.workerSessionGeneration);
      if (thread?.mode === "canonical-main") {
        if (thread.state === "reserving") return "waiting";
        if (!thread.rootMessageId) return "stale";
        if (saved.viewVersion <= saved.deliveredVersion) return "current";
        this.enqueueWorkerMain(saved, thread.rootMessageId, card);
        return "reserved";
      }
      if (!thread && previous === null) {
        const decision = this.reserve({ publicationKey: `worker-thread:${view.workerId}:${view.workerSessionGeneration}`, workerId: view.workerId, workerSessionGeneration: view.workerSessionGeneration, parentBindingId: view.parentBindingId, parentBindingGeneration: view.parentBindingGeneration, parentPaneId: view.parentPaneId, targetChatId: binding.chat_id, mode: "canonical-main", viewVersion: view.viewVersion, card });
        return decision === "reserved" ? "reserved" : decision === "duplicate" ? "waiting" : "stale";
      }
      if (saved.viewVersion <= saved.deliveredVersion) return "current";
      this.enqueueWorkerMain(saved, binding.root_message_id, card);
      return "reserved";
    });
  }

  retireSession(workerId: string, workerSessionGeneration: number, occurredAt: string): void {
    this.context.database.prepare("UPDATE worker_session_threads SET state = 'stale', stale_at = COALESCE(stale_at, ?), updated_at = ? WHERE worker_id = ? AND worker_session_generation = ? AND state != 'stale'").run(occurredAt, occurredAt, workerId, workerSessionGeneration);
  }

  private loadMainView(workerId: string, generation: number): WorkerMainView | null {
    const row = this.context.database.prepare("SELECT state_json FROM worker_main_views WHERE worker_id = ? AND worker_session_generation = ?").get(workerId, generation) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as WorkerMainView : null;
  }

  private saveMainView(view: WorkerMainView): WorkerMainView | null {
    const result = this.context.database.prepare(`
      INSERT INTO worker_main_views(worker_id, worker_session_generation, parent_binding_id, parent_binding_generation, parent_pane_id, state_json, view_version, delivered_version, message_id, card_id, frozen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id, worker_session_generation) DO UPDATE SET state_json=excluded.state_json, view_version=excluded.view_version, delivered_version=excluded.delivered_version, message_id=excluded.message_id, card_id=excluded.card_id, frozen_at=excluded.frozen_at, updated_at=excluded.updated_at
      WHERE worker_main_views.frozen_at IS NULL AND excluded.view_version >= worker_main_views.view_version
    `).run(view.workerId, view.workerSessionGeneration, view.parentBindingId, view.parentBindingGeneration, view.parentPaneId, JSON.stringify(view), view.viewVersion, view.deliveredVersion, view.messageId, view.cardId, view.frozenAt, view.createdAt, view.updatedAt);
    return result.changes === 1 ? this.loadMainView(view.workerId, view.workerSessionGeneration) : null;
  }

  private enqueueWorkerMain(view: WorkerMainView, fallbackRootMessageId: string, card: object): void {
    const creating = view.messageId === null;
    const key = `worker-main:create:${view.workerId}:${view.workerSessionGeneration}`;
    if (creating && this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key = ? AND (first_claimed_at IS NOT NULL OR attempt_count > 0 OR card_id_checkpoint IS NOT NULL)").get(key)) return;
    this.requireOutbox()({ id: randomUUID(), idempotencyKey: creating ? key : `worker-main:update:${view.workerId}:${view.workerSessionGeneration}:${view.viewVersion}`, bindingId: view.parentBindingId, workerId: view.workerId, workerSessionGeneration: view.workerSessionGeneration, viewVersion: view.viewVersion, rootMessageId: creating ? fallbackRootMessageId : view.messageId!, kind: creating ? "card_reply" : "card_update", payload: JSON.stringify(card) });
  }

  private loadBySession(workerId: string, workerSessionGeneration: number): WorkerSessionThread | null {
    const row = this.context.database.prepare("SELECT * FROM worker_session_threads WHERE worker_id = ? AND worker_session_generation = ?").get(workerId, workerSessionGeneration) as WorkerSessionThreadRow | undefined;
    return row ? mapWorkerSessionThread(row) : null;
  }

  private findByScope(chatId: string, topicId: string | null, rootMessageId: string | null): WorkerSessionThread | null {
    if (!topicId && !rootMessageId) return null;
    const row = this.context.database.prepare(`
      SELECT thread.* FROM worker_session_threads thread
      WHERE thread.chat_id = ?
        AND ((? IS NOT NULL AND thread.topic_id = ?) OR (? IS NOT NULL AND thread.root_message_id = ?))
      ORDER BY thread.created_at DESC LIMIT 1
    `).get(chatId, topicId, topicId, rootMessageId, rootMessageId) as WorkerSessionThreadRow | undefined;
    return row ? mapWorkerSessionThread(row) : null;
  }

  private requireOutbox(): (input: Parameters<SqliteOutboxQueueStore["enqueue"]>[0]) => unknown {
    if (!this.enqueueOutboundReply) throw new Error("Worker Session Thread outbox is not connected");
    return this.enqueueOutboundReply;
  }
}

function now(): string { return new Date().toISOString(); }
