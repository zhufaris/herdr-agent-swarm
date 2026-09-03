import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnControlWorkflow } from "../src/coordinator/turn-control-workflow.js";
import type { HerdrPane } from "../src/domain/types.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

function setupWorker(overrides: Partial<HerdrPane> = {}, steer = vi.fn(async () => ({ status: "delivered" as const, operationId: "native-1", turnId: "runtime-1" }))) {
  store = new SqliteBindingStore(":memory:");
  store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
  const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
  store.acceptInstanceTurn({ id: "logical-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
  store.claimNextInstanceTurn(worker.id, worker.generation);
  store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching" });
  store.claimInstanceTurnTranscript({ turnId: "logical-1", expectedGeneration: worker.generation, runtimeTurnId: "runtime-1", startedAt: "2026-09-03T00:00:00.000Z" });
  const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "working", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: "runtime-1", ...overrides };
  const getPane = vi.fn(async () => pane);
  const workflow = new TurnControlWorkflow({ store, herdr: { getPane, steerAgent: steer }, idFactory: () => "control-1" });
  return { workflow, getPane, steer, worker, pane };
}

describe("TurnControlWorkflow", () => {
  it("resolves a Primary binding through the same exact-turn dispatch path", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3, agentSessionSource: "herdr-traex-shim", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const view = createQueuedRunCard({ promptId: "prompt-1", bindingId: "b1", bindingGeneration: 3, title: "Primary", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-09-03T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "prompt-1", bindingId: "b1", larkMessageId: "message-1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("prompt-1", "running");
    store.markPromptDispatched("prompt-1", "2026-09-03T00:00:00.000Z");
    store.claimPromptTranscriptTurn({ promptId: "prompt-1", bindingId: "b1", turnId: "runtime-1", startedAt: "2026-09-03T00:00:00.100Z" });
    const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "working", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: "runtime-1" };
    const steerAgent = vi.fn(async () => ({ status: "delivered" as const, operationId: "native-1", turnId: "runtime-1" }));
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane, steerAgent }, idFactory: () => "control-primary" });

    await expect(workflow.steer({ owner: { kind: "binding", id: "b1" }, actor: { kind: "human", userId: "u1" }, text: "focus", idempotencyKey: "primary-steer-1" })).resolves.toMatchObject({ operation: { state: "delivered", target: { owner: { kind: "binding", id: "b1" }, logicalTurnId: "prompt-1", runtimeTurnId: "runtime-1" } } });
    expect(steerAgent).toHaveBeenCalledOnce();
  });

  it("dispatches one exact Worker steer and returns its durable terminal operation", async () => {
    const { workflow, getPane, steer, worker } = setupWorker();
    const command = { owner: { kind: "instance" as const, id: worker.id }, actor: { kind: "human" as const, userId: "u1" }, text: "change direction", idempotencyKey: "message-1:steer", sourceMessageId: "message-1" };

    await expect(workflow.steer(command)).resolves.toMatchObject({ duplicate: false, operation: { state: "delivered", result: { status: "delivered" } } });
    expect(getPane).toHaveBeenCalledTimes(2);
    expect(steer).toHaveBeenCalledWith({ paneId: "w1:p1", agentSession: expect.objectContaining({ value: "session-1" }), runtimeTurnId: "runtime-1", text: "change direction", idempotencyKey: "control-1" });
    await expect(workflow.steer(command)).resolves.toMatchObject({ duplicate: true, operation: { state: "delivered" } });
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it("returns the stored result without resolving or replaying a completed target", async () => {
    const { workflow, getPane, steer, worker } = setupWorker();
    const command = { owner: { kind: "instance" as const, id: worker.id }, actor: { kind: "human" as const, userId: "u1" }, text: "change direction", idempotencyKey: "message-1:steer", sourceMessageId: "message-1" };
    await workflow.steer(command);
    store!.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, expectedRuntimeTurnId: "runtime-1", state: "completed", eventKind: "turn.completed" });
    getPane.mockRejectedValue(new Error("must not observe a duplicate"));

    await expect(workflow.steer(command)).resolves.toMatchObject({ duplicate: true, operation: { state: "delivered" } });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(getPane).toHaveBeenCalledTimes(2);
  });

  it("persists a payload-free durable result card for a Feishu steering request", async () => {
    const { workflow, worker } = setupWorker();
    await workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "do not expose this payload", idempotencyKey: "steer-visible", sourceMessageId: "message-1", resultTargetMessageId: "root-1" });

    const replies = store!.listPendingOutboundReplies();
    expect(replies).toEqual([expect.objectContaining({ targetRole: "operation_result", rootMessageId: "root-1" })]);
    expect(replies[0]!.payload).toContain("Steering 已送达");
    expect(replies[0]!.payload).not.toContain("do not expose this payload");
  });

  it("fails closed before claim while a local approval is blocking the turn", async () => {
    const { workflow, steer, worker } = setupWorker({ agentState: "blocked" });
    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "change", idempotencyKey: "steer-1" })).rejects.toThrow(/blocked/);
    expect(steer).not.toHaveBeenCalled();
  });

  it("marks a thrown native dispatch uncertain and never retries it", async () => {
    const steer = vi.fn(async () => { throw new Error("socket response lost"); });
    const { workflow, worker } = setupWorker({}, steer);
    const command = { owner: { kind: "instance" as const, id: worker.id }, actor: { kind: "human" as const, userId: "u1" }, text: "change", idempotencyKey: "steer-1" };

    await expect(workflow.steer(command)).resolves.toMatchObject({ operation: { state: "uncertain", result: { status: "delivery-uncertain" } } });
    await expect(workflow.steer(command)).resolves.toMatchObject({ duplicate: true, operation: { state: "uncertain" } });
    expect(steer).toHaveBeenCalledTimes(1);
  });

  it("rejects a changed runtime turn during the fresh pre-claim observation", async () => {
    const { workflow, getPane, steer, worker, pane } = setupWorker();
    getPane.mockResolvedValueOnce(pane).mockResolvedValueOnce({ ...pane, activeTurnId: "runtime-2" });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "change", idempotencyKey: "steer-1" })).resolves.toMatchObject({ operation: { state: "rejected", result: { reason: expect.stringContaining("identity changed") } } });
    expect(steer).not.toHaveBeenCalled();
  });
});
