import { afterEach, describe, expect, it } from "vitest";
import { WorkerCardDisplayWorkflow } from "../src/coordinator/worker-card-display-workflow.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

function setup(withTask = true) {
  store = new SqliteBindingStore(":memory:");
  store.createPendingBinding({ id: "binding", projectId: "p1", workspaceId: "w", chatId: "c", topicId: "t", rootMessageId: "root", title: "Primary" });
  store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane" });
  const run = createQueuedRunCard({ promptId: "parent", bindingId: "binding", title: "parent", workspaceId: "w", paneId: "primary:pane", requestText: "show reviewer", queuePosition: 1, occurredAt: "2026-09-06T00:00:00.000Z" });
  store.acceptPrompt({ prompt: { id: "parent", bindingId: "binding", larkMessageId: "message", actorOpenId: "u", body: "show reviewer" }, view: run, rootMessageId: "root", answerCard: {} });
  store.updatePrompt("parent", "running");
  const worker = store.createAgentInstance({ id: "worker", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary:pane", nativeSessionId: null }, workerSessionLifecycle: "active", desiredState: "running", workspace: { id: "worker-ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
  if (withTask) {
    store.acceptInstanceTurn({ id: "turn", idempotencyKey: "task", actor: { kind: "human", userId: "u" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review" });
    const view = createQueuedWorkerTurnCard({ turnId: "turn", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "review", queuePosition: 1, occurredAt: "2026-09-06T00:00:01.000Z" });
    store.database.prepare(`INSERT INTO worker_turn_cards(turn_id, instance_id, instance_generation, worker_session_generation, worker_name, parent_turn_id, root_message_id, message_id, card_id, element_id, phase, request_text, answer, status_title, progress_json, queue_position, started_at, finished_at, notice, result_capture, page_index, page_start, sequence, view_version, delivered_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, NULL, '[]', ?, NULL, NULL, NULL, ?, 0, 0, 0, 1, 0, ?, ?)`).run(view.turnId, view.instanceId, view.instanceGeneration, view.workerSessionGeneration, view.workerName, view.rootMessageId, view.elementId, view.phase, view.requestText, view.answer, view.queuePosition, view.resultCapture, view.createdAt, view.updatedAt);
  }
  const workflow = new WorkerCardDisplayWorkflow(store, () => undefined);
  const input = { bindingId: "binding", bindingGeneration: 1, parentPromptId: "parent", projectId: "p1", workerName: "reviewer", rootMessageId: "root", idempotencyKey: "display" };
  return { workflow, input };
}

describe("WorkerCardDisplayWorkflow", () => {
  it("atomically reserves Main then latest Task snapshots without creating a turn", () => {
    const { workflow, input } = setup(); const before = store!.database.prepare("SELECT COUNT(*) AS count FROM instance_turns").get() as { count: number };
    expect(workflow.show(input)).toMatchObject({ accepted: true, delivery: "queued", worker: { name: "reviewer" }, cards: ["worker-main", "worker-task"], taskTurnId: "turn" });
    const rows = store!.database.prepare("SELECT idempotency_key, lane_key, kind, payload FROM outbound_replies WHERE idempotency_key LIKE 'worker-display:%' ORDER BY delivery_order").all() as Array<{ idempotency_key: string; lane_key: string; kind: string; payload: string }>;
    expect(rows).toHaveLength(2); expect(rows[0]!.idempotency_key).toMatch(/:main$/); expect(rows[1]!.idempotency_key).toMatch(/:task$/); expect(rows[0]!.lane_key).toBe(rows[1]!.lane_key); expect(rows.every(({ kind }) => kind === "card_reply")).toBe(true);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ header: { title: { content: "🤖 Worker · reviewer" } } });
    expect(rows[1]!.payload).toContain("只读状态快照"); expect(rows[1]!.payload).not.toContain("worker_task_instruction_form");
    expect((store!.database.prepare("SELECT COUNT(*) AS count FROM instance_turns").get() as { count: number }).count).toBe(before.count);
  });

  it("is idempotent and renders a no-task snapshot", () => {
    const { workflow, input } = setup(false); const first = workflow.show(input); const second = workflow.show(input);
    expect(second).toEqual(first);
    const rows = store!.database.prepare("SELECT payload FROM outbound_replies WHERE idempotency_key LIKE 'worker-display:%' ORDER BY delivery_order").all() as Array<{ payload: string }>;
    expect(rows).toHaveLength(2); expect(JSON.stringify(JSON.parse(rows[1]!.payload))).toContain("暂无 Task");
  });

  it("rejects mismatched names and conflicting key reuse without reserving cards", () => {
    const { workflow, input } = setup(false);
    expect(() => workflow.show({ ...input, workerName: "Reviewer" })).toThrow(/not found/);
    expect(store!.database.prepare("SELECT COUNT(*) AS count FROM worker_card_display_requests").get()).toMatchObject({ count: 0 });
    workflow.show(input);
    expect(() => workflow.show({ ...input, workerName: "other" })).toThrow(/different Worker/);
  });

  it("rolls back the request and both cards when rendering fails", () => {
    const { input } = setup(false);
    expect(() => store!.reserveWorkerCardDisplay({ ...input, renderMain: () => { throw new Error("render failed"); }, renderTask: () => ({}) })).toThrow(/render failed/);
    expect(store!.database.prepare("SELECT COUNT(*) AS count FROM worker_card_display_requests").get()).toEqual({ count: 0 });
    expect(store!.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE idempotency_key LIKE 'worker-display:%'").get()).toEqual({ count: 0 });
  });

  it("revalidates the active Primary before returning an idempotent receipt", () => {
    const { workflow, input } = setup(false); workflow.show(input); store!.updatePrompt("parent", "delivered");
    expect(() => workflow.show(input)).toThrow(/authorized current thread Primary/);
  });
});
