import { randomUUID } from "node:crypto";
import type { WorkerCardDisplayReceipt, WorkerCardDisplayStore } from "../../domain/ports/worker-card-display.js";
import { selectWorkerMainView } from "../../domain/worker-main-selector.js";
import type { SqliteContext } from "./context.js";
import { mapWorkerTurnCard } from "./worker-turn-store.js";

export class SqliteWorkerCardDisplayStore implements WorkerCardDisplayStore {
  constructor(private readonly context: SqliteContext, private readonly dependencies: {
    loadWorkerMainProjectionSource(workerId: string, workerSessionGeneration: number): import("../../domain/worker-main-selector.js").WorkerMainProjectionSource | null;
    loadWorkerMainView(workerId: string, workerSessionGeneration: number): import("../../domain/worker-main-view.js").WorkerMainView | null;
    enqueueOutboundReply(input: Parameters<import("../../domain/ports/outbox.js").OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): unknown;
  }) {}

  reserveWorkerCardDisplay(input: Parameters<WorkerCardDisplayStore["reserveWorkerCardDisplay"]>[0]): WorkerCardDisplayReceipt {
    const workerName = input.workerName.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!workerName || workerName.length > 128) throw new Error("Worker name must contain 1 to 128 characters");
    if (!idempotencyKey || idempotencyKey.length > 256) throw new Error("Idempotency key must contain 1 to 256 characters");
    return this.context.transaction(() => {
      const binding = this.context.database.prepare("SELECT project_id, pane_id, root_message_id, generation FROM bindings WHERE id = ?").get(input.bindingId) as { project_id: string | null; pane_id: string | null; root_message_id: string | null; generation: number } | undefined;
      const prompt = this.context.database.prepare("SELECT id FROM prompt_jobs WHERE id = ? AND binding_id = ? AND state = 'running'").get(input.parentPromptId, input.bindingId);
      if (!binding || binding.project_id !== input.projectId || binding.generation !== input.bindingGeneration || binding.root_message_id !== input.rootMessageId || !binding.pane_id || !prompt) throw new Error("Caller is not the authorized current thread Primary");
      const existing = this.context.database.prepare("SELECT worker_name, receipt_json FROM worker_card_display_requests WHERE binding_id = ? AND binding_generation = ? AND idempotency_key = ?").get(input.bindingId, input.bindingGeneration, idempotencyKey) as { worker_name: string; receipt_json: string } | undefined;
      if (existing) {
        if (existing.worker_name !== workerName) throw new Error("Idempotency key was already used for a different Worker");
        return JSON.parse(existing.receipt_json) as WorkerCardDisplayReceipt;
      }
      const workers = this.context.database.prepare(`SELECT id, name, worker_session_generation FROM agent_instances WHERE project_id = ? AND role = 'worker' AND worker_session_lifecycle = 'active' AND parent_binding_id = ? AND parent_binding_generation = ? AND parent_pane_id = ? AND name = ? ORDER BY id`).all(input.projectId, input.bindingId, input.bindingGeneration, binding.pane_id, workerName) as Array<{ id: string; name: string; worker_session_generation: number }>;
      if (workers.length === 0) throw new Error(`Worker not found by exact name: ${workerName}`);
      if (workers.length > 1) throw new Error(`Worker name is ambiguous: ${workerName}`);
      const worker = workers[0]!;
      const source = this.dependencies.loadWorkerMainProjectionSource(worker.id, worker.worker_session_generation);
      if (!source) throw new Error(`Worker has no displayable state: ${workerName}`);
      const previous = this.dependencies.loadWorkerMainView(worker.id, worker.worker_session_generation);
      const main = selectWorkerMainView(source, previous, previous?.dependencyRevision ?? 0, now());
      const taskRow = this.context.database.prepare("SELECT * FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? ORDER BY created_at DESC, turn_id DESC LIMIT 1").get(worker.id, worker.worker_session_generation) as Record<string, unknown> | undefined;
      const task = taskRow ? mapWorkerTurnCard(taskRow) : null;
      const requestId = randomUUID();
      const receipt: WorkerCardDisplayReceipt = { accepted: true, delivery: "queued", worker: { id: worker.id, name: worker.name, workerSessionGeneration: worker.worker_session_generation }, cards: ["worker-main", "worker-task"], taskTurnId: task?.turnId ?? null };
      this.context.database.prepare("INSERT INTO worker_card_display_requests(id, binding_id, binding_generation, parent_prompt_id, idempotency_key, worker_id, worker_session_generation, worker_name, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(requestId, input.bindingId, input.bindingGeneration, input.parentPromptId, idempotencyKey, worker.id, worker.worker_session_generation, worker.name, JSON.stringify(receipt), now());
      const laneKey = `worker-display:${requestId}`;
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-display:${requestId}:main`, bindingId: input.bindingId, rootMessageId: input.rootMessageId, kind: "card_reply", payload: JSON.stringify(input.renderMain(main)), laneKeyOverride: laneKey });
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-display:${requestId}:task`, bindingId: input.bindingId, rootMessageId: input.rootMessageId, kind: "card_reply", payload: JSON.stringify(input.renderTask(task, worker.name)), laneKeyOverride: laneKey });
      return receipt;
    });
  }
}

function now(): string { return new Date().toISOString(); }
