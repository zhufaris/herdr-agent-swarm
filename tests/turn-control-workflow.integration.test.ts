import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnControlWorkflow } from "../src/coordinator/turn-control-workflow.js";
import type { HerdrPane } from "../src/domain/types.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

function setupWorker(
  overrides: Partial<HerdrPane> = {},
  steer = vi.fn(async () => ({ status: "delivered" as const, operationId: "native-1", turnId: "runtime-1" })),
  interrupt = vi.fn(async () => ({ status: "interrupted" as const })),
  maxQueueDepth = 20
) {
  store = new SqliteBindingStore(":memory:");
  store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
  const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
  store.acceptInstanceTurn({ id: "logical-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
  store.claimNextInstanceTurn(worker.id, worker.generation);
  store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching" });
  store.claimInstanceTurnTranscript({ turnId: "logical-1", expectedGeneration: worker.generation, runtimeTurnId: "runtime-1", startedAt: "2026-09-03T00:00:00.000Z" });
  const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "working", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: "runtime-1", ...overrides };
  const getPane = vi.fn(async () => pane);
  const workflow = new TurnControlWorkflow({ store, herdr: { getPane, steerAgent: steer, interruptAgent: interrupt }, idFactory: () => "control-1", maxQueueDepth });
  return { workflow, getPane, steer, interrupt, worker, pane };
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

  it("accepts an idle Primary steer as a durable priority turn ahead of ordinary FIFO", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3, lastAgentState: "idle", agentSessionSource: "herdr-traex-shim", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    for (const id of ["ordinary-1", "ordinary-2"]) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", bindingGeneration: 3, title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: "2026-09-03T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `message-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "root", answerCard: {} });
    }
    const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    const wakePrimary = vi.fn();
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, idFactory: () => "priority-1", wakePrimary });
    const command = { owner: { kind: "binding" as const, id: "b1" }, actor: { kind: "human" as const, userId: "u1" }, text: "urgent", idempotencyKey: "steer-idle-1" };

    await expect(workflow.steer(command)).resolves.toEqual({ mode: "priority", logicalTurnId: "priority-1", duplicate: false });
    await expect(workflow.steer(command)).resolves.toEqual({ mode: "priority", logicalTurnId: "priority-1", duplicate: true });
    expect(wakePrimary).toHaveBeenCalledOnce();
    expect(store.claimNextDispatchablePrompt("b1")?.prompt).toMatchObject({ id: "priority-1", priority: "priority" });
  });

  it("rejects a second live Primary priority steer and enforces queue capacity", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3, lastAgentState: "idle", agentSessionSource: "herdr-traex-shim", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    let id = 0;
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, idFactory: () => `priority-${++id}`, maxQueueDepth: 2 });
    const command = (key: string) => ({ owner: { kind: "binding" as const, id: "b1" }, actor: { kind: "human" as const, userId: "u1" }, text: key, idempotencyKey: key });

    await workflow.steer(command("first"));
    await expect(workflow.steer(command("second"))).rejects.toThrow(/live priority turn/);
  });

  it("uses exact native steer despite stale coarse idle state when a durable active turn exists", async () => {
    const { workflow, steer, worker } = setupWorker({ agentState: "idle" });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "focus", idempotencyKey: "stale-idle" }))
      .resolves.toMatchObject({ mode: "native", operation: { state: "delivered" } });
    expect(steer).toHaveBeenCalledOnce();
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

  it("accepts an idle Worker steer as a durable priority turn", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    const wakeInstance = vi.fn();
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, idFactory: () => "priority-worker", wakeInstance });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "urgent", idempotencyKey: "worker-steer-idle" }))
      .resolves.toEqual({ mode: "priority", logicalTurnId: "priority-worker", duplicate: false });
    expect(store.getInstanceTurn("priority-worker")).toMatchObject({ priority: "priority", state: "queued" });
    expect(wakeInstance).toHaveBeenCalledWith(worker.id);
  });

  it("enforces Worker queue capacity for an idle priority steer", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    store.acceptInstanceTurn({ id: "queued", idempotencyKey: "queued", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "queued" });
    const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, idFactory: () => "priority-worker", maxQueueDepth: 1 });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "urgent", idempotencyKey: "priority" })).rejects.toThrow(/queue is full/);
  });

  it("dispatches one exact Worker interrupt without settling the active turn", async () => {
    const { workflow, getPane, interrupt, worker } = setupWorker();
    const command = { owner: { kind: "instance" as const, id: worker.id }, actor: { kind: "human" as const, userId: "u1" }, idempotencyKey: "message-1:stop", sourceMessageId: "message-1" };
    const stateBeforeInterrupt = store!.getInstanceTurn("logical-1")!.state;

    await expect(workflow.interrupt(command)).resolves.toMatchObject({ duplicate: false, operation: { kind: "interrupt", state: "delivered", result: { status: "interrupted" } } });
    expect(getPane).toHaveBeenCalledTimes(2);
    expect(interrupt).toHaveBeenCalledWith({ paneId: "w1:p1", agentSession: expect.objectContaining({ value: "session-1" }), runtimeTurnId: "runtime-1", idempotencyKey: "control-1" });
    expect(store!.getInstanceTurn("logical-1")).toMatchObject({ state: stateBeforeInterrupt, runtimeTurnId: "runtime-1" });

    await expect(workflow.interrupt(command)).resolves.toMatchObject({ duplicate: true, operation: { state: "delivered" } });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("persists a stop result that does not claim the turn already terminated", async () => {
    const { workflow, worker } = setupWorker();
    await workflow.interrupt({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, idempotencyKey: "stop-visible", sourceMessageId: "message-1", resultTargetMessageId: "root-1" });

    const payload = store!.listPendingOutboundReplies()[0]!.payload;
    expect(payload).toContain("中断已发送");
    expect(payload).toContain("等待 Herdr");
    expect(payload).not.toContain("Steering 已送达");
  });

  it("allows exact-turn stop when native text steering is unsupported", async () => {
    const { workflow, interrupt, worker } = setupWorker({ steeringCapability: "unsupported" });
    await expect(workflow.interrupt({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, idempotencyKey: "stop-no-steer" }))
      .resolves.toMatchObject({ operation: { state: "delivered" } });
    expect(interrupt).toHaveBeenCalledOnce();
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

  it("converts a proven not-active Worker steer into one durable priority turn after a fresh idle observation", async () => {
    const steer = vi.fn(async () => ({ status: "not-active" as const, reason: "expected turn is no longer active" }));
    const { workflow, getPane, worker, pane } = setupWorker({}, steer);
    getPane.mockResolvedValueOnce(pane).mockResolvedValueOnce(pane).mockResolvedValueOnce({ ...pane, agentState: "idle", activeTurnId: null });
    const command = { owner: { kind: "instance" as const, id: worker.id }, actor: { kind: "human" as const, userId: "u1" }, text: "continue safely", idempotencyKey: "steer-fallback", sourceMessageId: "message-1", resultTargetMessageId: "root-1" };

    const first = await workflow.steer(command);
    expect(first).toMatchObject({ mode: "priority", duplicate: false });
    if (first.mode !== "priority") throw new Error("expected priority fallback");
    expect(store!.getInstanceTurn(first.logicalTurnId)).toMatchObject({ priority: "priority", state: "queued", text: "continue safely" });
    expect(store!.claimNextInstanceTurn(worker.id, worker.generation)).toBeNull();
    await expect(workflow.steer(command)).resolves.toEqual({ ...first, duplicate: true });
    expect(steer).toHaveBeenCalledOnce();
  });

  it("converts a proven not-active Worker steer without a result card", async () => {
    const steer = vi.fn(async () => ({ status: "not-active" as const, reason: "turn completed" }));
    const { workflow, getPane, worker, pane } = setupWorker({}, steer);
    getPane.mockResolvedValueOnce(pane).mockResolvedValueOnce(pane).mockResolvedValueOnce({ ...pane, agentState: "done", activeTurnId: null });

    const outcome = await workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "primary", bindingId: "b1" }, text: "continue safely", idempotencyKey: "tool-fallback" });
    expect(outcome).toMatchObject({ mode: "priority" });
    if (outcome.mode !== "priority") throw new Error("expected priority fallback");
    expect(store!.getInstanceTurn(outcome.logicalTurnId)).toMatchObject({ priority: "priority", state: "queued" });
    expect(store!.loadWorkerTurnCard(outcome.logicalTurnId)).toBeNull();
  });

  it("converts a proven not-active Primary steer into one durable priority prompt", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3, agentSessionSource: "herdr-traex-shim", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const view = createQueuedRunCard({ promptId: "prompt-1", bindingId: "b1", bindingGeneration: 3, title: "Primary", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-09-03T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "prompt-1", bindingId: "b1", larkMessageId: "message-1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("prompt-1", "running");
    store.markPromptDispatched("prompt-1", "2026-09-03T00:00:00.000Z");
    store.claimPromptTranscriptTurn({ promptId: "prompt-1", bindingId: "b1", turnId: "runtime-1", startedAt: "2026-09-03T00:00:00.100Z" });
    const working: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "working", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: "runtime-1" };
    const getPane = vi.fn().mockResolvedValueOnce(working).mockResolvedValueOnce(working).mockResolvedValueOnce({ ...working, agentState: "idle", activeTurnId: null });
    const steerAgent = vi.fn(async () => ({ status: "not-active" as const, reason: "turn completed" }));
    let id = 0;
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane, steerAgent }, idFactory: () => `generated-${++id}`, maxQueueDepth: 20 });

    const outcome = await workflow.steer({ owner: { kind: "binding", id: "b1" }, actor: { kind: "human", userId: "u1" }, text: "continue safely", idempotencyKey: "primary-fallback" });
    expect(outcome).toMatchObject({ mode: "priority" });
    if (outcome.mode !== "priority") throw new Error("expected priority fallback");
    expect(store.getPrompt(outcome.logicalTurnId)).toMatchObject({ priority: "priority", state: "queued" });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
  });

  it("records a proven not-active fallback admission failure as rejected", async () => {
    const steer = vi.fn(async () => ({ status: "not-active" as const, reason: "turn completed" }));
    const { workflow, getPane, worker, pane } = setupWorker({}, steer, undefined, 1);
    getPane.mockResolvedValueOnce(pane).mockResolvedValueOnce(pane).mockResolvedValueOnce({ ...pane, agentState: "idle", activeTurnId: null });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "continue", idempotencyKey: "full-fallback", resultTargetMessageId: "root-1" }))
      .resolves.toMatchObject({ mode: "native", operation: { state: "rejected", result: { status: "rejected", reason: expect.stringContaining("queue is full") } } });
  });

  it("never converts an uncertain Worker steer into priority work", async () => {
    const steer = vi.fn(async () => ({ status: "delivery-uncertain" as const, operationId: "native-1", reason: "receipt lost" }));
    const { workflow, getPane, worker } = setupWorker({}, steer);

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "do not replay", idempotencyKey: "steer-uncertain", resultTargetMessageId: "root-1" }))
      .resolves.toMatchObject({ mode: "native", operation: { state: "uncertain" } });
    expect(getPane).toHaveBeenCalledTimes(2);
    expect(store!.listInstanceTurns(worker.id).items.filter((turn) => turn.priority === "priority")).toHaveLength(0);
  });

  it("rejects a changed runtime turn during the fresh pre-claim observation", async () => {
    const { workflow, getPane, steer, worker, pane } = setupWorker();
    getPane.mockResolvedValueOnce(pane).mockResolvedValueOnce({ ...pane, activeTurnId: "runtime-2" });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "change", idempotencyKey: "steer-1" })).resolves.toMatchObject({ operation: { state: "rejected", result: { reason: expect.stringContaining("identity changed") } } });
    expect(steer).not.toHaveBeenCalled();
  });

  it("rejects when the fresh observation has no exact active turn identity", async () => {
    const { workflow, getPane, steer, worker, pane } = setupWorker();
    getPane.mockResolvedValueOnce(pane).mockResolvedValueOnce({ ...pane, activeTurnId: null });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "change", idempotencyKey: "steer-null-turn" }))
      .resolves.toMatchObject({ operation: { state: "rejected", result: { reason: expect.stringContaining("identity changed") } } });
    expect(steer).not.toHaveBeenCalled();
  });
});
