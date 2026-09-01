import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { WorkerTurnCardWorkflow } from "../src/coordinator/worker-turn-card-workflow.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

function setup(turnId = "turn-1") {
  const store = new SqliteBindingStore(":memory:");
  store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
  const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
  const view = createQueuedWorkerTurnCard({ turnId, instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: "review", queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
  store.acceptInstanceTurnWithCard({ id: turnId, idempotencyKey: `lark:${turnId}`, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review", parentTurnId: null, sourceMessageId: `message:${turnId}`, view, card: renderWorkerTurnCard(view) });
  return { store, worker, view };
}

describe("WorkerTurnCardWorkflow", () => {
  it("coalesces the latest state into an undelivered initial card", async () => {
    const { store, worker } = setup();
    store.applyInstanceTurnProjection({ turnId: "turn-1", expectedGeneration: worker.generation, change: { type: "running", occurredAt: "2026-09-01T00:00:01.000Z" }, render: renderWorkerTurnCard });
    const wake = vi.fn();
    await new WorkerTurnCardWorkflow(store, wake, pino({ enabled: false })).converge("turn-1");

    const pending = store.listPendingOutboundReplies();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ workerTurnId: "turn-1", kind: "stream_card_create", viewVersion: 2 });
    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(pending[0]!.id)).toEqual({ lane_key: "worker-turn:turn-1" });
    expect(pending[0]!.payload).toContain("Worker 正在处理");
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("streams owned output and freezes a terminal page", async () => {
    const { store, worker } = setup();
    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "worker-message-1", "worker-card-1");
    store.applyInstanceTurnProjection({ turnId: "turn-1", expectedGeneration: worker.generation, change: { type: "completed", occurredAt: "2026-09-01T00:01:00.000Z", answer: "finding" }, render: renderWorkerTurnCard });
    const wake = vi.fn();
    const workflow = new WorkerTurnCardWorkflow(store, wake, pino({ enabled: false }));

    await workflow.converge("turn-1");
    const content = store.listPendingOutboundReplies().find(({ kind }) => kind === "stream_content")!;
    expect(content).toMatchObject({ workerTurnId: "turn-1", rootMessageId: "worker-card-1" });
    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(content.id)).toEqual({ lane_key: "worker-turn:turn-1" });
    expect(JSON.parse(content.payload)).toMatchObject({ pageIndex: 0, content: "finding", sequence: 1 });
    store.markOutboundReplyDelivered(content.id, "worker-card-1");
    await workflow.converge("turn-1");

    const finish = store.listPendingOutboundReplies().find(({ kind }) => kind === "stream_finish")!;
    expect(finish).toMatchObject({ workerTurnId: "turn-1" });
    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(finish.id)).toEqual({ lane_key: "worker-turn:turn-1" });
    store.markOutboundReplyDelivered(finish.id, "worker-card-1");
    expect(store.listWorkerTurnCardPages("turn-1")).toEqual([expect.objectContaining({ state: "finished", sequence: 2 })]);
    store.close();
  });

  it("creates exactly one continuation for long Worker output", async () => {
    const { store, worker } = setup();
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "worker-message-1", "worker-card-1");
    const answer = Array.from({ length: 2_000 }, (_, index) => `finding-${index}`).join("\n");
    store.applyInstanceTurnProjection({ turnId: "turn-1", expectedGeneration: worker.generation, change: { type: "output", occurredAt: "2026-09-01T00:01:00.000Z", answer }, render: renderWorkerTurnCard });
    const workflow = new WorkerTurnCardWorkflow(store, () => {}, pino({ enabled: false }));

    await workflow.converge("turn-1");
    const content = store.listPendingOutboundReplies().find(({ kind }) => kind === "stream_content")!;
    store.markOutboundReplyDelivered(content.id, "worker-card-1");
    await workflow.converge("turn-1");
    await workflow.converge("turn-1");

    expect(store.listPendingOutboundReplies().filter(({ kind }) => kind === "stream_card_create")).toHaveLength(1);
    expect(store.database.prepare("SELECT DISTINCT lane_key FROM outbound_replies WHERE worker_turn_id = ?").all("turn-1")).toEqual([{ lane_key: "worker-turn:turn-1" }]);
    expect(store.listWorkerTurnCardPages("turn-1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "active" }),
      expect.objectContaining({ pageIndex: 1, state: "creating" })
    ]);

    const finish = store.listPendingOutboundReplies().find(({ kind }) => kind === "stream_finish")!;
    const continuation = store.listPendingOutboundReplies().find(({ kind }) => kind === "stream_card_create")!;
    store.markOutboundReplyDelivered(finish.id, "worker-card-1");
    expect(store.listWorkerTurnCardPages("turn-1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen" }),
      expect.objectContaining({ pageIndex: 1, state: "creating" })
    ]);
    expect(store.loadWorkerTurnCard("turn-1")).toMatchObject({
      pageIndex: 0, pageStart: 0, messageId: "worker-message-1", cardId: "worker-card-1"
    });

    store.markOutboundReplyDelivered(continuation.id, "worker-message-2", "worker-card-2");
    expect(store.listWorkerTurnCardPages("turn-1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen" }),
      expect.objectContaining({
        pageIndex: 1, state: "active", messageId: "worker-message-2", cardId: "worker-card-2"
      })
    ]);
    expect(store.loadWorkerTurnCard("turn-1")).toMatchObject({
      pageIndex: 1, messageId: "worker-message-2", cardId: "worker-card-2"
    });
    expect(store.loadWorkerTurnCard("turn-1")!.pageStart).toBeGreaterThan(0);
    store.close();
  });
});
