import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnControlWorkflow } from "../src/coordinator/turn-control-workflow.js";
import { TurnControlDispatcher } from "../src/coordinator/turn-control-dispatcher.js";
import { BindingPromptWorkflow } from "../src/coordinator/binding-prompt-workflow.js";
import type { HerdrPane } from "../src/domain/types.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { applicationPresentation } from "./helpers/presentation.js";
import { connectPreparedDeliveryProducers } from "../src/composition/create-outbound-runtime.js";
import type { GatewayDeliveryIntent } from "../src/gateways/contract/plugin.js";

const PROJECTS = [{ id: "project-a", displayName: "Project A", spaceName: "primary-space", description: "Project", workspaceId: "w1", cwd: "/repo" }];

let store: SqliteBindingStore | undefined;
let dispatchers: TurnControlDispatcher[] = [];
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.stop()));
  store?.close();
  store = undefined;
});

function createStore(): SqliteBindingStore {
  const target = new SqliteBindingStore(":memory:");
  const modules = target.capabilityModules();
  connectPreparedDeliveryProducers(modules.outbox, modules.preparedDeliveryProducers, {
    prepare: (intent: GatewayDeliveryIntent) => ({
      protocolVersion: 1,
      gatewayId: "feishu:primary",
      profileId: "feishu-cardkit-v1",
      rendererRevision: 1,
      operation: intent.kind,
      intent
    })
  }, { enqueuePreparedDelivery() {} });
  return target;
}

function createWorkerParent(target: SqliteBindingStore, id = "worker-parent"): void {
  target.createPendingBinding({ id, projectId: "project-a", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "primary-root", title: "Primary" });
  target.updateBinding(id, { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane", statusMessageId: "primary-root" });
}

function setupWorker(
  overrides: Partial<HerdrPane> = {},
  steer = vi.fn(async () => ({ status: "delivered" as const, operationId: "native-1", turnId: "runtime-1" })),
  interrupt = vi.fn(async () => ({ status: "interrupted" as const })),
  maxQueueDepth = 20
) {
  store = createStore();
  createWorkerParent(store);
  store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null,
    parent: { bindingId: "worker-parent", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
    workerSessionLifecycle: "active", desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
  const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
  store.acceptInstanceTurn({ id: "logical-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
  store.claimNextInstanceTurn(worker.id, worker.generation);
  store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching" });
  store.claimInstanceTurnTranscript({ turnId: "logical-1", expectedGeneration: worker.generation, runtimeTurnId: "runtime-1", startedAt: "2026-09-03T00:00:00.000Z" });
  const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "working", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: "runtime-1", ...overrides };
  const getPane = vi.fn(async () => pane);
  const dispatcher = new TurnControlDispatcher({ store, herdr: { getPane, interruptAgent: interrupt }, presentation: applicationPresentation, wakeOutbound: () => undefined });
  dispatchers.push(dispatcher);
  const workflow = new TurnControlWorkflow({ store, herdr: { getPane }, projects: PROJECTS, idFactory: () => "control-1", maxQueueDepth, presentation: applicationPresentation, bindingPrompts: bindingPromptsFor(store), wakeTurnControl: (owner) => dispatcher.wake(owner) });
  return { workflow, dispatcher, getPane, steer, interrupt, worker, pane };
}

function bindingPromptsFor(
  target: SqliteBindingStore,
  overrides: { schedulerWake?: ReturnType<typeof vi.fn>; outboundWake?: ReturnType<typeof vi.fn>; lifecyclePublish?: ReturnType<typeof vi.fn> } = {}
): BindingPromptWorkflow {
  return new BindingPromptWorkflow({
    config: { projects: PROJECTS, maxQueueDepth: 20 },
    store: target,
    lifecycleEvents: { publish: overrides.lifecyclePublish ?? vi.fn(async () => undefined) },
    outboundWork: { wake: overrides.outboundWake ?? vi.fn(), subscribe: vi.fn() },
    scheduler: { wake: overrides.schedulerWake ?? vi.fn(), subscribe: vi.fn() },
    presentation: applicationPresentation
  });
}

describe("TurnControlWorkflow", () => {
  it("accepts exact Primary control from Herdr identity without Prompt ownership", async () => {
    store = createStore();
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "working", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: "runtime-1" };
    const dispatcher = new TurnControlDispatcher({ store, herdr: { getPane: async () => pane }, presentation: applicationPresentation, wakeOutbound: () => undefined });
    dispatchers.push(dispatcher);
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, projects: PROJECTS, idFactory: () => "control-primary", presentation: applicationPresentation, agentInput: { submit: vi.fn() }, wakeTurnControl: (owner) => dispatcher.wake(owner) });

    await expect(workflow.steer({ owner: { kind: "binding", id: "b1" }, actor: { kind: "human", userId: "u1" }, text: "focus", idempotencyKey: "primary-steer-1" })).resolves.toMatchObject({ operation: { state: "accepted", result: null, target: { owner: { kind: "binding", id: "b1" }, logicalTurnId: "runtime-1", runtimeTurnId: "runtime-1" } } });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-primary")).toMatchObject({ state: "rejected", result: { status: "unsupported" } }));
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
  });

  it("recovers an exact Primary active turn from Herdr events when the pane snapshot omits active_turn_id", async () => {
    store = createStore();
    store.createPendingBinding({ id: "b-events", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t-events", rootMessageId: "root-events", title: "Primary" });
    store.updateBinding("b-events", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p-events", generation: 1, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-events" });
    const pane: HerdrPane = { paneId: "w1:p-events", workspaceId: "w1", cwd: "/repo", label: null, agentState: "working", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-events" }, steeringCapability: "unsupported", activeTurnId: null };
    const getPane = vi.fn(async () => pane);
    const getActiveTurn = vi.fn(async () => ({ turnId: "runtime-events", startedAt: "2026-10-12T11:55:58.827Z" }));
    const interrupt = vi.fn(async () => ({ status: "interrupted" as const }));
    const dispatcher = new TurnControlDispatcher({ store, herdr: { getPane, getActiveTurn, interruptAgent: interrupt }, presentation: applicationPresentation, wakeOutbound: () => undefined });
    dispatchers.push(dispatcher);
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane, getActiveTurn }, projects: PROJECTS, idFactory: () => "control-events", presentation: applicationPresentation, wakeTurnControl: (owner) => dispatcher.wake(owner) });

    await expect(workflow.interrupt({ owner: { kind: "binding", id: "b-events" }, actor: { kind: "human", userId: "u1" }, idempotencyKey: "stop-events" }))
      .resolves.toMatchObject({ operation: { state: "accepted", target: { runtimeTurnId: "runtime-events" } } });
    await vi.waitFor(() => expect(store.getTurnControlOperation("control-events")).toMatchObject({ state: "delivered", result: { status: "interrupted" } }));
    expect(getActiveTurn).toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledWith(expect.objectContaining({ runtimeTurnId: "runtime-events" }));
  });

  it("accepts an idle Primary steer as independent Agent Input exactly once", async () => {
    store = createStore();
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3, lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    for (const id of ["ordinary-1", "ordinary-2"]) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", bindingGeneration: 3, title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: "2026-09-03T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `message-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "root", answerCard: {} });
    }
    const pane: HerdrPane = { paneId: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    let submitted = false;
    const agentInput = { submit: vi.fn(async () => ({ outcome: submitted ? "duplicate" as const : (submitted = true, "accepted" as const), submissionId: "submission-1", state: "prepared" as const })) };
    const workflow = new TurnControlWorkflow({
      store, herdr: { getPane: async () => pane }, projects: PROJECTS, idFactory: () => "priority-1", presentation: applicationPresentation,
      agentInput
    });
    const command = { owner: { kind: "binding" as const, id: "b1" }, actor: { kind: "human" as const, userId: "u1" }, text: "urgent", idempotencyKey: "steer-idle-1" };

    const firstResult = await workflow.steer(command);
    expect(firstResult).toEqual({ mode: "input", submissionId: "submission-1", duplicate: false });
    const restarted = new TurnControlWorkflow({
      store, herdr: { getPane: async () => pane }, projects: PROJECTS, idFactory: () => "must-not-insert", presentation: applicationPresentation,
      agentInput
    });
    await expect(restarted.steer(command)).resolves.toEqual({ mode: "input", submissionId: "submission-1", duplicate: true });
    expect(agentInput.submit).toHaveBeenCalledTimes(2);
    expect(agentInput.submit).toHaveBeenCalledWith(expect.objectContaining({ ingressSource: "swarm-control", sourceMessageKey: "idle-steer:v1:steer-idle-1", text: "urgent", terminalId: "terminal-1" }));
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE ingress_source = 'internal' AND source_message_key = 'idle-steer:v1:steer-idle-1'").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'prompt.queue' AND target = 'b1'").get()).toEqual({ count: 0 });
  });

  it("routes an idle Primary steer through Agent Input without Prompt admission", async () => {
    store = createStore();
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3, lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const pane: HerdrPane = { paneId: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    const wakePrimary = vi.fn();
    const agentInput = { submit: vi.fn(async () => ({ outcome: "accepted" as const, submissionId: "submission-managed", state: "prepared" as const })) };
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, projects: PROJECTS, idFactory: () => "priority-ignored", wakePrimary, presentation: applicationPresentation, agentInput });
    const command = { owner: { kind: "binding" as const, id: "b1" }, actor: { kind: "human" as const, userId: "u1" }, text: "urgent", idempotencyKey: "steer-managed-idle", sourceMessageId: "message-1" };

    await expect(workflow.steer(command)).resolves.toEqual({ mode: "input", submissionId: "submission-managed", duplicate: false });

    expect(agentInput.submit).toHaveBeenCalledOnce();
    expect(agentInput.submit).toHaveBeenCalledWith(expect.objectContaining({
      owner: { kind: "primary", id: "b1", generation: 3 },
      text: "urgent",
      ingressSource: "swarm-control",
      sourceMessageKey: "idle-steer:v1:steer-managed-idle",
      terminalId: "terminal-1"
    }));
    expect(wakePrimary).not.toHaveBeenCalled();
  });

  it("does not let a local busy predecessor block independent Agent Input", async () => {
    store = createStore();
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3, lastAgentState: "working", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const pane: HerdrPane = { paneId: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "working", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    const wakePrimary = vi.fn();
    const agentInput = { submit: vi.fn(async () => ({ outcome: "accepted" as const, submissionId: "submission-local", state: "prepared" as const })) };
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, projects: PROJECTS, idFactory: () => "priority-local", wakePrimary, presentation: applicationPresentation, agentInput });

    await expect(workflow.steer({ owner: { kind: "binding", id: "b1" }, actor: { kind: "human", userId: "u1" }, text: "please handle this after the local turn", idempotencyKey: "steer-local-busy" }))
      .resolves.toEqual({ mode: "input", submissionId: "submission-local", duplicate: false });

    expect(store.getPrompt("priority-local")).toBeNull();
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
    expect(wakePrimary).not.toHaveBeenCalled();
  });

  it("does not apply Prompt queue capacity to independent Primary Agent Input", async () => {
    store = createStore();
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3, lastAgentState: "idle", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const pane: HerdrPane = { paneId: "w1:p1", terminalId: "terminal-1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    let id = 0;
    const agentInput = { submit: vi.fn(async () => ({ outcome: "accepted" as const, submissionId: `submission-${++id}`, state: "prepared" as const })) };
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, projects: PROJECTS, idFactory: () => `priority-${++id}`, maxQueueDepth: 2, presentation: applicationPresentation, agentInput });
    const command = (key: string) => ({ owner: { kind: "binding" as const, id: "b1" }, actor: { kind: "human" as const, userId: "u1" }, text: key, idempotencyKey: key });

    await workflow.steer(command("first"));
    await expect(workflow.steer(command("second"))).resolves.toMatchObject({ mode: "input", duplicate: false });
    expect(agentInput.submit).toHaveBeenCalledTimes(2);
  });

  it("rejects active steering even when coarse pane state is stale", async () => {
    const { workflow, steer, worker } = setupWorker({ agentState: "idle" });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "focus", idempotencyKey: "stale-idle" }))
      .resolves.toMatchObject({ mode: "native", operation: { state: "accepted", result: null } });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")).toMatchObject({ state: "rejected", result: { status: "unsupported" } }));
    expect(steer).not.toHaveBeenCalled();
  });

  it("records one durable unsupported result for an exact Worker steer", async () => {
    const { workflow, getPane, steer, worker } = setupWorker();
    const command = { owner: { kind: "instance" as const, id: worker.id }, actor: { kind: "human" as const, userId: "u1" }, text: "change direction", idempotencyKey: "message-1:steer", sourceMessageId: "message-1" };

    await expect(workflow.steer(command)).resolves.toMatchObject({ duplicate: false, operation: { state: "accepted", result: null } });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")).toMatchObject({ state: "rejected", result: { status: "unsupported" } }));
    expect(getPane).toHaveBeenCalledTimes(2);
    expect(steer).not.toHaveBeenCalled();
    await expect(workflow.steer(command)).resolves.toMatchObject({ duplicate: true, operation: { state: "rejected" } });
  });

  it("accepts an idle Worker steer as a durable priority turn", async () => {
    store = createStore();
    createWorkerParent(store);
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null,
      parent: { bindingId: "worker-parent", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workerSessionLifecycle: "active", desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    const wakeInstance = vi.fn();
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, projects: PROJECTS, idFactory: () => "priority-worker", wakeInstance, presentation: applicationPresentation, bindingPrompts: bindingPromptsFor(store) });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "urgent", idempotencyKey: "worker-steer-idle" }))
      .resolves.toEqual({ mode: "priority", logicalTurnId: "priority-worker", duplicate: false });
    expect(store.getInstanceTurn("priority-worker")).toMatchObject({ priority: "priority", state: "queued" });
    expect(store.listPendingOutboundReplies().filter(({ workerTurnId }) => workerTurnId)).toEqual([]);
    expect(wakeInstance).toHaveBeenCalledWith(worker.id);
  });

  it("creates an idle Worker steer Turn Card only from its canonical Human Message", async () => {
    store = createStore();
    createWorkerParent(store, "worker-steer-parent");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null,
      parent: { bindingId: "worker-steer-parent", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workerSessionLifecycle: "active", desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, projects: PROJECTS, idFactory: () => "priority-worker", wakeInstance: vi.fn(), presentation: applicationPresentation, bindingPrompts: bindingPromptsFor(store) });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "urgent", idempotencyKey: "worker-steer-idle", sourceMessageId: "message-1", resultTargetMessageId: "root-1" }))
      .resolves.toEqual({ mode: "priority", logicalTurnId: "priority-worker", duplicate: false });

    expect(store.capabilityModules().conversationSegments.getConversationSegment("worker-turn:priority-worker")).toBeNull();
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'turn-card:%'").get()).toEqual({ count: 0 });

    expect(store.capabilityModules().conversationSegments.projectCanonicalEvent({
      laneId: "worker-priority-lane",
      laneSequence: 1,
      observedAt: "2026-10-04T12:00:01.000Z",
      event: {
        schemaVersion: 1,
        eventId: "worker-priority-human",
        cursor: "worker-priority:1",
        sourceId: "worker-priority",
        agentKind: "traex",
        sessionId: "session-1",
        turnId: "runtime-priority-worker",
        occurredAt: "2026-10-04T12:00:01.000Z",
        payload: { type: "human_message", message_id: "worker-priority-message", text: "urgent", truncated: false, submission_id: "priority-worker" }
      }
    })).toEqual({ outcome: "created", segmentId: "worker-turn:priority-worker" });

    expect(store.capabilityModules().conversationSegments.getConversationSegment("worker-turn:priority-worker")).toMatchObject({
      submissionId: "priority-worker",
      state: "working",
      startAt: { laneSequence: 1, itemOrdinal: 0 }
    });
    expect(store.capabilityModules().conversationSegments.listConversationSegmentItems("worker-turn:priority-worker")).toHaveLength(1);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM worker_turn_cards").get()).toEqual({ count: 0 });
    expect(store.database.prepare(`SELECT scope_kind,scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,
      gateway_plan_hash IS NOT NULL AS prepared FROM outbound_replies WHERE projection_key LIKE 'turn-card:%'`).get()).toEqual({
      scope_kind: "pane", scope_workspace_id: "w1", scope_pane_id: "w1:p1",
      delivery_owner_kind: "worker", delivery_owner_id: worker.id, prepared: 1
    });
  });

  it("enforces Worker queue capacity for an idle priority steer", async () => {
    store = createStore();
    createWorkerParent(store);
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null,
      parent: { bindingId: "worker-parent", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workerSessionLifecycle: "active", desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    store.acceptInstanceTurn({ id: "queued", idempotencyKey: "queued", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "queued" });
    const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"], agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, steeringCapability: "native", activeTurnId: null };
    const workflow = new TurnControlWorkflow({ store, herdr: { getPane: async () => pane }, projects: PROJECTS, idFactory: () => "priority-worker", maxQueueDepth: 1, presentation: applicationPresentation, bindingPrompts: bindingPromptsFor(store) });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "urgent", idempotencyKey: "priority" })).rejects.toThrow(/queue is full/);
  });

  it("dispatches one exact Worker interrupt without settling the active turn", async () => {
    const { workflow, getPane, interrupt, worker } = setupWorker();
    const command = { owner: { kind: "instance" as const, id: worker.id }, actor: { kind: "human" as const, userId: "u1" }, idempotencyKey: "message-1:stop", sourceMessageId: "message-1" };
    const stateBeforeInterrupt = store!.getInstanceTurn("logical-1")!.state;

    await expect(workflow.interrupt(command)).resolves.toMatchObject({ duplicate: false, operation: { kind: "interrupt", state: "accepted", result: null } });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")).toMatchObject({ state: "delivered", result: { status: "interrupted" } }));
    expect(getPane).toHaveBeenCalledTimes(2);
    expect(interrupt).toHaveBeenCalledWith({ paneId: "w1:p1", agentSession: expect.objectContaining({ value: "session-1" }), runtimeTurnId: "runtime-1", idempotencyKey: "control-1" });
    expect(store!.getInstanceTurn("logical-1")).toMatchObject({ state: stateBeforeInterrupt, runtimeTurnId: "runtime-1" });

    await expect(workflow.interrupt(command)).resolves.toMatchObject({ duplicate: true, operation: { state: "delivered" } });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("persists a stop result that does not claim the turn already terminated", async () => {
    const { workflow, worker } = setupWorker();
    await workflow.interrupt({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, idempotencyKey: "stop-visible", sourceMessageId: "message-1" });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")?.state).toBe("delivered"));

    const operation = store!.getTurnControlOperation("control-1")!;
    expect(operation.result).toMatchObject({ status: "interrupted" });
    const payload = JSON.stringify(applicationPresentation.turnControlResult(operation));
    expect(payload).toContain("中断已发送");
    expect(payload).toContain("等待 Herdr");
    expect(payload).not.toContain("Steering 已送达");
  });

  it("allows exact-turn stop when native text steering is unsupported", async () => {
    const { workflow, interrupt, worker } = setupWorker({ steeringCapability: "unsupported" });
    await expect(workflow.interrupt({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, idempotencyKey: "stop-no-steer" }))
      .resolves.toMatchObject({ operation: { state: "accepted" } });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")?.state).toBe("delivered"));
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("guides an unsupported exact-turn steer to projection catch-up without queueing", async () => {
    const unsupported = vi.fn(async () => ({ status: "unsupported" as const, reason: "native steering unavailable" }));
    const { workflow, worker } = setupWorker({}, unsupported);
    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "change", idempotencyKey: "unsupported-visible", sourceMessageId: "message-1" }))
      .resolves.toMatchObject({ mode: "native", operation: { state: "accepted", result: null } });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")?.state).toBe("rejected"));
    const payload = JSON.stringify(applicationPresentation.turnControlResult(store!.getTurnControlOperation("control-1")!));
    expect(payload).toContain("/swarm awake");
    expect(payload).not.toContain("/swarm skip");
    expect(payload).toContain("不会转为普通任务");
    expect(store!.database.prepare("SELECT COUNT(*) AS count FROM instance_turns").get()).toEqual({ count: 1 });
  });

  it("returns the stored unsupported result without resolving or replaying a completed target", async () => {
    const { workflow, getPane, steer, worker } = setupWorker();
    const command = { owner: { kind: "instance" as const, id: worker.id }, actor: { kind: "human" as const, userId: "u1" }, text: "change direction", idempotencyKey: "message-1:steer", sourceMessageId: "message-1" };
    await workflow.steer(command);
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")?.state).toBe("rejected"));
    store!.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, expectedRuntimeTurnId: "runtime-1", state: "completed", eventKind: "turn.completed" });
    getPane.mockRejectedValue(new Error("must not observe a duplicate"));

    await expect(workflow.steer(command)).resolves.toMatchObject({ duplicate: true, operation: { state: "rejected" } });
    expect(steer).not.toHaveBeenCalled();
    expect(getPane).toHaveBeenCalledTimes(2);
  });

  it("renders a payload-free result from a durable Feishu steering operation", async () => {
    const { workflow, worker } = setupWorker();
    await workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "do not expose this payload", idempotencyKey: "steer-visible", sourceMessageId: "message-1" });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")?.state).toBe("rejected"));

    const operation = store!.getTurnControlOperation("control-1")!;
    expect(operation).toMatchObject({ state: "rejected", result: { status: "unsupported" } });
    const payload = JSON.stringify(applicationPresentation.turnControlResult(operation));
    expect(payload).toContain("Steering 不受支持");
    expect(payload).not.toContain("do not expose this payload");
  });

  it("fails closed before claim while a local approval is blocking the turn", async () => {
    const { workflow, steer, worker } = setupWorker({ agentState: "blocked" });
    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "change", idempotencyKey: "steer-1" })).rejects.toThrow(/blocked/);
    expect(steer).not.toHaveBeenCalled();
  });

  it("exposes expected runtime absence through a stable request error code", async () => {
    const { workflow, getPane, worker } = setupWorker();
    getPane.mockResolvedValueOnce(null);
    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "change", idempotencyKey: "missing-pane" }))
      .rejects.toMatchObject({ name: "TurnControlRequestError", code: "not-active", message: "Herdr pane is no longer active" });
  });

  it("rejects a changed runtime turn during the fresh pre-claim observation", async () => {
    const { workflow, getPane, steer, worker, pane } = setupWorker();
    getPane.mockResolvedValueOnce(pane).mockResolvedValueOnce({ ...pane, activeTurnId: "runtime-2" });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "change", idempotencyKey: "steer-1" })).resolves.toMatchObject({ operation: { state: "accepted" } });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")).toMatchObject({ state: "rejected", result: { reason: expect.stringContaining("identity changed") } }));
    expect(steer).not.toHaveBeenCalled();
  });

  it("rejects when the fresh observation has no exact active turn identity", async () => {
    const { workflow, getPane, steer, worker, pane } = setupWorker();
    getPane.mockResolvedValueOnce(pane).mockResolvedValueOnce({ ...pane, activeTurnId: null });

    await expect(workflow.steer({ owner: { kind: "instance", id: worker.id }, actor: { kind: "human", userId: "u1" }, text: "change", idempotencyKey: "steer-null-turn" }))
      .resolves.toMatchObject({ operation: { state: "accepted" } });
    await vi.waitFor(() => expect(store!.getTurnControlOperation("control-1")).toMatchObject({ state: "rejected", result: { reason: expect.stringContaining("identity changed") } }));
    expect(steer).not.toHaveBeenCalled();
  });
});
