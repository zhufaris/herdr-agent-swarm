import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { TestConversationViewProjector as ConversationViewProjector } from "./helpers/create-test-conversation-view-projector.js";
import { QueueFeedbackProjector } from "../src/events/queue-feedback-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { ANSWER_STREAM_PAGE_LIMIT } from "../src/runtime/answer-stream.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { CardContextRebuilder } from "../src/events/card-context-rebuilder.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { applicationPresentation } from "./helpers/presentation.js";
import { RuntimeEventIntegration } from "../src/composition/runtime-event-integration.js";

function activatePrimary(store: SqliteBindingStore): void {
  store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
}

describe("event-driven card projection", () => {
  it("commits a Core output projection and its inbox settlement in one transaction", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    const coreEvents = store.capabilityModules().coreEvents;
    coreEvents.ingestBatch({
      laneId: "lane-1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", afterCursor: "", nextCursor: "source-1:1", latestCursor: "source-1:1", ingestedAt: "2026-09-30T00:00:00.000Z",
      events: [{ schemaVersion: 1, eventId: "core-1", cursor: "source-1:1", sourceId: "source-1", agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-09-30T00:00:00.000Z", payload: { type: "message", message_id: "message-1", channel: "assistant", text: "hello", truncated: false } }]
    });
    const events = new RuntimeEventIntegration(pino({ enabled: false }));
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(events.lifecycle, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: async () => undefined });
    projector.start();
    const event = { eventId: "output-1", bindingId: "b1", type: "TurnOutputObserved" as const, origin: "herdr" as const, occurredAt: "2026-09-30T00:00:01.000Z", payload: {
      promptId: "p1", observation: {
        coreEventSettlement: { laneId: "lane-1", eventIds: ["core-1"], occurredAt: "2026-09-30T00:00:01.000Z", owner: { kind: "binding" as const, id: "b1" } },
        answer: { snapshot: "atomic answer", update: "append" as const, toolActivities: [] }, main: {}
      }
    } };
    const originalSave = store.saveRunCard.bind(store);
    vi.spyOn(store, "saveRunCard").mockImplementationOnce((next) => {
      originalSave(next);
      throw new Error("simulated projection failure");
    });

    await expect(events.lifecycle.publish(event)).rejects.toThrow("simulated projection failure");
    expect(store.loadRunCard("p1")?.answer).toBe("");
    expect(coreEvents.loadPending("lane-1").eventIds).toEqual(["core-1"]);

    await events.lifecycle.publish(event);
    expect(store.loadRunCard("p1")?.answer).toBe("atomic answer");
    expect(coreEvents.loadPending("lane-1").eventIds).toEqual([]);

    await projector.stop();
    await events.stop();
    store.close();
  });

  it("persists structured Core status as the Answer Task List title without changing plan identity", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: async () => undefined });
    projector.start();

    await bus.publish({ eventId: "status", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-10-01T00:00:01.000Z", payload: {
      promptId: "p1", observation: {
        answer: { snapshot: "", toolActivities: [] },
        main: { status: { statusTitle: "Running focused verification", planSteps: [{ key: "plan:verify", kind: "step", label: "Run tests", state: "active" }] } }
      }
    } });

    expect(store.loadRunCard("p1")).toMatchObject({
      taskListTitle: "Running focused verification",
      taskList: [{ key: "plan:verify", kind: "step", label: "Run tests", state: "active", occurredAt: "2026-10-01T00:00:01.000Z" }]
    });
    await bus.publish({ eventId: "identity", bindingId: "b1", type: "PaneOutputObserved", origin: "herdr", occurredAt: "2026-10-01T00:00:02.000Z", payload: { workspace: "/repo/.worktree/feature", worktreeName: "feature", branch: "swarm/feature", paneToken: "p1-token" } });
    expect(store.loadTopicView("b1")).toMatchObject({ paneIdentity: { workspace: "/repo/.worktree/feature", worktreeName: "feature", branch: "swarm/feature" } });
    expect(JSON.stringify(primaryPresentation.mainCard(store.loadTopicView("b1")!))).toContain("swarm/feature");
    await projector.stop();
    store.close();
  });

  it("persists a session-owned Goal and mirrors it only into mutable Answer cards", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: async () => undefined });
    projector.start();
    await bus.publish({ eventId: "start", bindingId: "b1", type: "TurnStarted", origin: "herdr", occurredAt: "2026-09-30T00:00:00Z", payload: { promptId: "p1", queueDepth: 1 } });
    const activeGoal = {
      goalId: "goal-1", objective: "Ship native Goal support", status: "active" as const, sourceUpdatedAt: 1,
      occurredAt: "2026-09-30T00:00:01Z", sourceId: "source-1", sourceSequence: 1, sourceEventId: "goal-event-1", nativeSessionId: "session-1"
    };
    await bus.publish({ eventId: "goal-1", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: activeGoal.occurredAt, payload: {
      promptId: "p1", observation: { goalChanges: [activeGoal], answer: { snapshot: "", toolActivities: [] }, main: {} }
    } });

    expect(store.loadTopicView("b1")?.currentGoal).toMatchObject({ goalId: "goal-1", status: "active" });
    expect(store.loadRunCard("p1")?.currentGoal).toMatchObject({ goalId: "goal-1", status: "active" });

    await bus.publish({ eventId: "complete-turn", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-09-30T00:00:02Z", payload: { promptId: "p1", answer: "done", queueDepth: 0 } });
    await bus.publish({ eventId: "goal-2", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-09-30T00:00:03Z", payload: {
      promptId: "p1", observation: { goalChanges: [{ ...activeGoal, status: "paused", sourceUpdatedAt: 2, sourceSequence: 2, sourceEventId: "goal-event-2" }], answer: { snapshot: "", toolActivities: [] }, main: {} }
    } });

    expect(store.loadTopicView("b1")?.currentGoal).toMatchObject({ status: "paused" });
    expect(store.loadRunCard("p1")?.currentGoal).toMatchObject({ status: "active" });

    await bus.publish({ eventId: "goal-3", bindingId: "b1", type: "PaneOutputObserved", origin: "herdr", occurredAt: "2026-09-30T00:00:04Z", payload: {
      observation: { goalChanges: [{ ...activeGoal, status: "blocked", sourceUpdatedAt: 3, sourceSequence: 3, sourceEventId: "goal-event-3" }], answer: { snapshot: "", toolActivities: [] }, main: {} }
    } });
    expect(store.loadTopicView("b1")?.currentGoal).toMatchObject({ status: "blocked", blockKind: "explicit" });

    await projector.stop();
    store.close();
  });

  it("persists the newest Main view immediately and coalesces delivery within the Main budget", async () => {
    vi.useFakeTimers();
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const bus = new BridgeEventBus();
    const mainConverge = vi.fn(async () => undefined);
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: mainConverge }, { cardUpdateDebounceMs: 1_500, mainCardUpdateDebounceMs: 2_500 });
    projector.start();

    await bus.publish({ eventId: "rename-1", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-30T00:00:00.000Z", payload: { title: "First" } });
    await bus.publish({ eventId: "rename-2", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-30T00:00:01.000Z", payload: { title: "Newest" } });

    expect(store.loadTopicView("b1")).toMatchObject({ title: "Newest", viewVersion: 2 });
    expect(mainConverge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_499);
    expect(mainConverge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mainConverge).toHaveBeenCalledOnce();
    expect(mainConverge).toHaveBeenCalledWith("b1");

    await projector.stop(); store.close(); vi.useRealTimers();
  });

  it("flushes a terminal Main view immediately", async () => {
    vi.useFakeTimers();
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const bus = new BridgeEventBus();
    const mainConverge = vi.fn(async () => undefined);
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: mainConverge }, { mainCardUpdateDebounceMs: 2_500 });
    projector.start();

    await bus.publish({ eventId: "degraded", bindingId: "b1", type: "BindingDegraded", origin: "bridge", occurredAt: "2026-08-30T00:00:00.000Z", payload: { reason: "pane unavailable" } });
    await Promise.resolve();

    expect(store.loadTopicView("b1")).toMatchObject({ phase: "degraded", notice: "pane unavailable" });
    expect(mainConverge).toHaveBeenCalledOnce();
    await projector.stop(); store.close(); vi.useRealTimers();
  });

  it("uses the configured Answer visibility budget for ordinary Main updates", async () => {
    vi.useFakeTimers();
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const bus = new BridgeEventBus();
    const mainConverge = vi.fn(async () => undefined);
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: mainConverge }, { cardUpdateDebounceMs: 500 });
    projector.start();

    await bus.publish({ eventId: "rename", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-09-26T00:00:00.000Z", payload: { title: "Fresh" } });
    await vi.advanceTimersByTimeAsync(499);
    expect(mainConverge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mainConverge).toHaveBeenCalledOnce();

    await projector.stop(); store.close(); vi.useRealTimers();
  });

  it("keeps Topic Views out of process memory through active and terminal projection", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const bus = new BridgeEventBus();
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: async () => undefined });
    projector.start();

    await bus.publish({ eventId: "active", bindingId: "b1", type: "BindingActivated", origin: "bridge", occurredAt: "2026-08-30T00:00:00.000Z", payload: { paneId: "w1:p1", tabId: null, topicId: "t1" } });
    expect(projector.cacheDiagnostics().topicViews).toBe(0);
    await bus.publish({ eventId: "archived", bindingId: "b1", type: "BindingArchived", origin: "bridge", occurredAt: "2026-08-30T00:00:01.000Z", payload: { reason: "done" } });

    expect(store.loadTopicView("b1")?.phase).toBe("archived");
    expect(projector.cacheDiagnostics().topicViews).toBe(0);
    await projector.stop();
    expect(projector.cacheDiagnostics()).toEqual({ topicViews: 0, answerLengths: 0 });
    store.close();
  });

  it("reduces lifecycle events over newer durable Worker context instead of a stale process cache", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "p1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const bus = new BridgeEventBus();
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: async () => undefined });
    projector.start();
    await bus.publish({ eventId: "created", bindingId: "b1", type: "BindingCreated", origin: "bridge", occurredAt: "2026-09-11T00:00:00.000Z", payload: { title: "Task", workspaceId: "w1", paneId: "w1:p1" } });

    const created = store.createWorkerAgentInstance({ id: "worker", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: null }, workspace: { id: "worker-ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "w1:worker", nativeSessionId: "worker-session" })!;
    const task = createQueuedWorkerTurnCard({ turnId: "worker-turn", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "Review durable state", queuePosition: 1, occurredAt: "2026-09-11T00:00:01.000Z" });
    store.acceptInstanceTurnWithCard({ id: task.turnId, idempotencyKey: task.turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: task.requestText, parentTurnId: null, sourceMessageId: "source", view: task, render: renderWorkerTurnCard });
    const rebuilder = new CardContextRebuilder(store, () => undefined, { debug() {}, error() {} } as never, applicationPresentation);
    await rebuilder.requestScan();
    const enriched = store.loadTopicView("b1")!;
    expect(enriched.workers).toEqual([expect.objectContaining({ workerId: worker.id })]);
    expect(enriched.workerDependencyRevision).toBeGreaterThan(0);

    await bus.publish({ eventId: "renamed", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-09-11T00:00:02.000Z", payload: { title: "Renamed" } });

    expect(store.loadTopicView("b1")).toMatchObject({ title: "Renamed", workers: [{ workerId: worker.id }], workerDependencyRevision: enriched.workerDependencyRevision, viewVersion: enriched.viewVersion + 1 });
    await projector.stop(); store.close();
  });

  it("routes Answer and Main delivery checkpoints through immediate unified convergence", async () => {
    let answerCheckpoint: ((promptId: string, version: number) => void) | undefined;
    let mainCheckpoint: ((bindingId: string, version: number) => void) | undefined;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const answerConverge = vi.fn(async () => undefined);
    const mainConverge = vi.fn(async () => undefined);
    const checkpoints = {
      onAnswerCheckpoint(listener: (promptId: string, version: number) => void) { answerCheckpoint = listener; return () => {}; },
      onMainCardCheckpoint(listener: (bindingId: string, version: number) => void) { mainCheckpoint = listener; return () => {}; },
      requestScan: async () => {}
    };
    const publisher = { async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, checkpoints, pino({ enabled: false }), primaryPresentation, { converge: answerConverge }, { project: async () => undefined, converge: mainConverge });
    projector.start();

    answerCheckpoint?.("p1", 7);
    mainCheckpoint?.("b1", 9);
    await vi.waitFor(() => expect(answerConverge).toHaveBeenCalledWith("p1"));
    expect(mainConverge).toHaveBeenCalledWith("b1");

    await projector.stop(); store.close();
  });

  it("flushes the first answer immediately and batches later small deltas", async () => {
    vi.useFakeTimers();
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    const bus = new BridgeEventBus();
    const converge = vi.fn(async () => undefined);
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge }, { project: async () => undefined, converge: async () => undefined }, { cardUpdateDebounceMs: 500 });
    projector.start();

    await bus.publish({ eventId: "first", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "now", payload: { promptId: "p1", answerSnapshot: "短首段", answerUpdate: "replace", progressEvents: [] } });
    await Promise.resolve();
    expect(converge).toHaveBeenCalledTimes(1);

    await bus.publish({ eventId: "small", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "later", payload: { promptId: "p1", answerSnapshot: "小增量", answerUpdate: "append", progressEvents: [] } });
    await vi.advanceTimersByTimeAsync(499);
    expect(converge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(converge).toHaveBeenCalledTimes(2));

    await projector.stop(); store.close(); vi.useRealTimers();
  });

  it("caps a configured Answer debounce at the 1.5-second visibility budget", async () => {
    vi.useFakeTimers();
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    const bus = new BridgeEventBus();
    const converge = vi.fn(async () => undefined);
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge }, { project: async () => undefined, converge: async () => undefined }, { cardUpdateDebounceMs: 10_000 });
    projector.start();

    await bus.publish({ eventId: "first", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "now", payload: { promptId: "p1", answerSnapshot: "first", answerUpdate: "replace", progressEvents: [] } });
    await Promise.resolve();
    converge.mockClear();
    await bus.publish({ eventId: "small", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "later", payload: { promptId: "p1", answerSnapshot: "delta", answerUpdate: "append", progressEvents: [] } });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(converge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(converge).toHaveBeenCalledOnce();

    await projector.stop(); store.close(); vi.useRealTimers();
  });

  it("coalesces an eighty-character nonterminal answer increment on the interactive timer", async () => {
    vi.useFakeTimers();
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    const bus = new BridgeEventBus();
    const converge = vi.fn(async () => undefined);
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge }, { project: async () => undefined, converge: async () => undefined }, { cardUpdateDebounceMs: 500 });
    projector.start();

    await bus.publish({ eventId: "first", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "now", payload: { promptId: "p1", answerSnapshot: "a", answerUpdate: "replace", progressEvents: [] } });
    await Promise.resolve();
    expect(converge).toHaveBeenCalledTimes(1);
    await bus.publish({ eventId: "large", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "later", payload: { promptId: "p1", answerSnapshot: "b".repeat(80), answerUpdate: "append", progressEvents: [] } });
    await vi.advanceTimersByTimeAsync(119);
    expect(converge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(converge).toHaveBeenCalledTimes(2);

    await projector.stop(); store.close(); vi.useRealTimers();
  });

  it("keeps the interactive deadline when a large answer increment arrives during first paint", async () => {
    vi.useFakeTimers();
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    const bus = new BridgeEventBus();
    let releaseFirstPaint!: () => void;
    const firstPaint = new Promise<void>((resolve) => { releaseFirstPaint = resolve; });
    const converge = vi.fn().mockImplementationOnce(() => firstPaint).mockResolvedValue(undefined);
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge }, { project: async () => undefined, converge: async () => undefined }, { cardUpdateDebounceMs: 500 });
    projector.start();

    await bus.publish({ eventId: "first", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "now", payload: { promptId: "p1", answerSnapshot: "a", answerUpdate: "replace", progressEvents: [] } });
    await Promise.resolve();
    expect(converge).toHaveBeenCalledOnce();
    await bus.publish({ eventId: "large", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "later", payload: { promptId: "p1", answerSnapshot: "b".repeat(80), answerUpdate: "append", progressEvents: [] } });
    await vi.advanceTimersByTimeAsync(119);
    releaseFirstPaint();
    await vi.advanceTimersByTimeAsync(0);
    expect(converge).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(converge).toHaveBeenCalledTimes(2);

    await projector.stop(); store.close(); vi.useRealTimers();
  });

  it("keeps an atomically terminal cancellation version and still converges delivery", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    activatePrimary(store);
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Queued", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view: queued, rootMessageId: "root", answerCard: {} });
    store.cancelQueuedPromptsWithProjection({ bindingId: "b1", reason: "cancelled", occurredAt: "later", rootMessageId: null, renderRunCard: () => ({}) });
    const version = store.loadRunCard("p1")!.viewVersion; const converge = vi.fn(async () => undefined);
    const bus = new BridgeEventBus(); const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge }, { project: async () => undefined, converge: async () => undefined });
    projector.start();

    await bus.publish({ eventId: "cancel", bindingId: "b1", type: "PromptCancelled", origin: "bridge", occurredAt: "later", payload: { promptId: "p1", reason: "cancelled" } });
    await vi.waitFor(() => expect(converge).toHaveBeenCalledWith("p1"));

    expect(store.loadRunCard("p1")?.viewVersion).toBe(version);
    await projector.stop(); store.close();
  });

  it("preserves the FIFO position assigned during acceptance when pending depth includes an active turn", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Queued", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "root" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard() { return { messageId: "card" }; },
      async updateCard() {}
    }, pino({ enabled: false }), primaryPresentation);
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation);
    projector.start();

    await bus.publish({ eventId: "queued", bindingId: "b1", type: "PromptQueued", origin: "bridge", occurredAt: "later", payload: { promptId: "p1", queueDepth: 2, actorOpenId: "u1" } });

    expect(store.loadRunCard("p1")).toMatchObject({ queuePosition: 1, viewVersion: 1 });
    await projector.stop();
    await publisher.stop();
    store.close();
  });

  it("persists repeated queue-feedback ticks and patches the mutable CardKit Answer", async () => {
    let clock = "2026-08-29T12:00:20.000Z";
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const active = createQueuedRunCard({ promptId: "active", bindingId: "b1", title: "Active", workspaceId: "w1", paneId: "w1:p1", requestText: "active", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "active", bindingId: "b1", larkMessageId: "m-active", actorOpenId: "u1", body: "active" }, view: active, rootMessageId: "m1", answerCard: {} });
    store.updatePrompt("active", "running"); store.markPromptDispatched("active");
    store.database.prepare("UPDATE run_cards SET phase = 'running', started_at = '2026-08-29T12:00:00.000Z' WHERE prompt_id = 'active'").run();
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m-p1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "m1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, reply.promptId === "p1" ? "answer-1" : "active-answer", reply.promptId === "p1" ? "card-1" : "active-card");
    const outboundWork = { subscribe: () => () => {}, wake: vi.fn() };
    const projector = new QueueFeedbackProjector({ store, outboundWork, logger: pino({ enabled: false }), presentation: primaryPresentation, now: () => clock });

    await projector.refresh("b1");
    clock = "2026-08-29T12:00:31.000Z";
    await projector.refresh("b1");

    const updates = store.listPendingOutboundReplies().filter((reply) => reply.promptId === "p1" && reply.kind === "card_update");
    expect(updates).toEqual([expect.objectContaining({ kind: "card_update", intentKind: "card", rootMessageId: "answer-1", viewVersion: 3 })]);
    expect(store.loadRunCard("p1")).toMatchObject({ viewVersion: 3, queueFeedback: { aheadCount: 0, elapsedBucket: 1 } });
    await projector.stop(); store.close();
  });

  it("reduces an event, persists the view, then updates the same card", async () => {
    const updates: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; },
      async replyCard() { return { messageId: "card1" }; },
      async updateCard(_messageId, card) { updates.push(card); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p2", state: "active", statusMessageId: "card1" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation);
    const stopPublisher = publisher.start();
    const stop = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation).start();

    await bus.publish({ eventId: "e1", bindingId: "b1", type: "BindingCreated", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Task", workspaceId: "w1", paneId: "w1:p2" } });
    await bus.publish({ eventId: "e2", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer: "Finished", queueDepth: 0 } });

    expect(store.loadTopicView("b1")).toMatchObject({ phase: "done", answer: "Finished" });
    await publisher.drain();
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates.at(-1))).toContain("已完成");
    expect(JSON.stringify(updates.at(-1))).toContain("Finished");
    stop(); stopPublisher(); store.close();
  });

  it("previews live output on the primary card and prioritizes a blocked notice", async () => {
    const updates: Array<{ messageId: string; card: object }> = [];
    const streamed: Array<{ cardId: string; content: string }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; },
      async replyCard() { return { messageId: "request-card" }; },
      async streamCardContent(cardId, _elementId, content) { streamed.push({ cardId, content }); },
      async finishStreamingCard() {},
      async updateCard(messageId, card) { updates.push({ messageId, card }); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "primary-card", title: "repo / task" });
    activatePrimary(store);
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", statusMessageId: "primary-card" });
    const request = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Do work", workspaceId: "w1", paneId: "w1:p1", requestText: "Do work", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-message", actorOpenId: "u1", body: "Do work" }, view: request, rootMessageId: "primary-card", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) {
      store.markOutboundReplyDelivered(reply.id, reply.cardRole === "task" ? "request-task-card" : "request-answer-card", reply.cardRole === "answer" ? "request-answer-surface" : undefined);
    }
    store.saveTopicView({ ...initialTopicView("b1"), title: "repo / task", workspaceId: "w1", paneId: "w1:p1", phase: "done" });
    store.listBindings = () => { throw new Error("ConversationViewProjector must use point binding lookup"); };
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation);
    const stopPublisher = publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation);
    const stopProjector = projector.start();

    await bus.publish({ eventId: "start", bindingId: "b1", type: "TurnStarted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", queueDepth: 1 } });
    await bus.publish({ eventId: "output", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:01Z", payload: { promptId: "p1", answerSnapshot: "live answer", progressEvents: [{ key: "edit:card", kind: "edit", label: "更新主卡片", state: "active" }] } });
    await bus.publish({ eventId: "blocked", bindingId: "b1", type: "AgentStateChanged", origin: "herdr", occurredAt: "2026-08-22T00:01:02Z", payload: { promptId: "p1", state: "blocked", queueDepth: 1 } });
    await publisher.drain();

    expect(store.loadTopicView("b1")).toMatchObject({ phase: "blocked", answer: "live answer", recentProgress: [expect.objectContaining({ key: "edit:card" })] });
    const latestPrimary = updates.filter((update) => update.messageId === "primary-card").at(-1)!;
    expect(JSON.stringify(latestPrimary.card)).toContain("等待用户处理");
    expect(JSON.stringify(latestPrimary.card)).toContain("TraeX 需要人工审批");
    expect(JSON.stringify(latestPrimary.card)).not.toContain("live answer");
    expect(JSON.stringify(latestPrimary.card)).toContain("🛠️ 更新主卡片");
    expect(updates.some((update) => update.messageId === "request-task-card")).toBe(false);
    expect(streamed.some((update) => update.cardId === "request-answer-surface" && update.content.includes("live answer"))).toBe(true);

    stopProjector(); stopPublisher(); store.close();
  });

  it("updates the same answer card with the accumulated live message window", async () => {
    vi.useFakeTimers();
    const updates: Array<{ messageId: string; card: object }> = [];
    const streamed: Array<{ cardId: string; content: string }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; },
      async replyCard() { return { messageId: "request-card" }; },
      async streamCardContent(cardId, _elementId, content) { streamed.push({ cardId, content }); },
      async finishStreamingCard() {},
      async updateCard(messageId, card) { updates.push({ messageId, card }); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "primary-card", title: "repo / task" });
    activatePrimary(store);
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", statusMessageId: "primary-card" });
    const request = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Do work", workspaceId: "w1", paneId: "w1:p1", requestText: "Do work", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-message", actorOpenId: "u1", body: "Do work" }, view: request, rootMessageId: "primary-card", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, reply.cardRole === "task" ? "request-task-card" : "request-answer-card", reply.cardRole === "answer" ? "request-answer-surface" : undefined);
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation);
    const stopPublisher = publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, undefined, undefined, { cardUpdateDebounceMs: 1_500 });
    const stopProjector = projector.start();

    await bus.publish({ eventId: "start", bindingId: "b1", type: "TurnStarted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", queueDepth: 1 } });
    await bus.publish({ eventId: "first", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:01Z", payload: { promptId: "p1", answerSnapshot: "第一条", answerUpdate: "replace", progressEvents: [] } });
    await vi.waitFor(() => expect(streamed).toHaveLength(1));
    await bus.publish({ eventId: "first-grown", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:02Z", payload: { promptId: "p1", answerSnapshot: "第一条中间消息。", answerUpdate: "replace", progressEvents: [] } });
    await bus.publish({ eventId: "second", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:03Z", payload: { promptId: "p1", answerSnapshot: "第二条", answerUpdate: "append", progressEvents: [] } });
    await bus.publish({ eventId: "second-grown", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:04Z", payload: { promptId: "p1", answer: "第一条中间消息。\n\n第二条中间消息。", queueDepth: 0 } });
    await vi.advanceTimersByTimeAsync(1_500);
    await publisher.drain();
    await vi.waitFor(() => expect(streamed.length).toBeGreaterThanOrEqual(2));

    const latest = streamed.at(-1)!.content;
    expect(latest).toContain("第一条中间消息。");
    expect(latest).toContain("第二条中间消息。");
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "completed" });
    expect(store.loadRunCard("p1")?.answer).toContain("第一条中间消息。");
    expect(store.loadRunCard("p1")?.answer).toContain("第二条中间消息。");
    expect(new Set(streamed.map((update) => update.cardId))).toEqual(new Set(["request-answer-surface"]));

    stopProjector(); stopPublisher(); store.close(); vi.useRealTimers();
  });

  it("freezes a bounded CardKit answer and continues on a persisted new card", async () => {
    const created: object[] = [];
    const streamed: Array<{ cardId: string; elementId: string; content: string; sequence: number }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async replyStreamingCard(_rootMessageId, card) { created.push(card); const number = created.length; return { messageId: `answer-${number}`, cardId: `answer-card-${number}` }; },
      async streamCardContent(cardId, elementId, content, sequence) { streamed.push({ cardId, elementId, content, sequence }); },
      async finishStreamingCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    activatePrimary(store);
    store.updateBinding("b1", { paneId: "w1:p1", paneToken: "abcd" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", spaceName: "bridge", paneId: "w1:p1", paneToken: "abcd", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.listBindings = () => { throw new Error("ConversationViewProjector must use point binding lookup"); };
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    await publisher.drain();

    const pageHalf = Math.ceil(ANSWER_STREAM_PAGE_LIMIT / 2);
    const answer = [
      "<b>Result</b> [unsafe](javascript:alert(1))",
      "| Key | Value |",
      "| --- | --- |",
      "| mode | fast |",
      "```ts",
      "const preserved = '[literal](javascript:alert(1))';",
      "```",
      "a".repeat(pageHalf),
      "b".repeat(pageHalf)
    ].join("\n");
    await bus.publish({ eventId: "done", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer, queueDepth: 0 } });
    await vi.waitFor(() => expect(store.listAnswerPages("p1").at(-1)?.state).toBe("finished"));

    expect(answer.length).toBeLessThan(28_000);
    expect(created).toHaveLength(2);
    expect(new Set(streamed.map(({ cardId }) => cardId))).toEqual(new Set(["answer-card-1", "answer-card-2"]));
    const firstPageContent = streamed.filter(({ cardId }) => cardId === "answer-card-1").at(-1)!.content;
    expect(firstPageContent).toContain("Result unsafe");
    expect(firstPageContent).toContain("| Key | Value |");
    expect(firstPageContent).toContain("[literal](javascript:alert(1))");
    expect(firstPageContent).not.toContain("<b>Result</b>");
    expect(JSON.stringify(created[1])).toContain("bridge / abcd · 第 2 页");
    expect(store.loadRunCard("p1")).toMatchObject({ answerCardId: "answer-card-2", answerMessageId: "answer-2", answerPageIndex: 1, answerElementId: "answer_content_p1_1" });

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("streams a render-safe Bash fence while preserving the canonical answer", async () => {
    const streamed: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async replyStreamingCard() { return { messageId: "answer-1", cardId: "answer-card-1" }; },
      async streamCardContent(_cardId, _elementId, content) { streamed.push(content); },
      async finishStreamingCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Bash answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    await publisher.drain();

    const answer = ["Run this:", "```bash", "echo hello"].join("\n");
    await bus.publish({ eventId: "bash", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer, queueDepth: 0 } });
    await vi.waitFor(() => expect(streamed.length).toBeGreaterThan(0));

    expect(streamed.at(-1)).toContain("Run this:");
    expect(streamed.at(-1)).toContain("```bash\necho hello\n```");
    expect(store.loadRunCard("p1")?.answer).toBe(answer);

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("keeps Bash fences valid when streaming rolls over to a continuation card", async () => {
    const created: object[] = [];
    const streamed: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async replyStreamingCard(_rootMessageId, card) { created.push(card); return { messageId: `answer-${created.length}`, cardId: `answer-card-${created.length}` }; },
      async streamCardContent(_cardId, _elementId, content) { streamed.push(content); },
      async finishStreamingCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long Bash answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    await publisher.drain();

    const answer = ["```bash", ...Array.from({ length: 3_500 }, (_, index) => `echo line-${index}`), "```"].join("\n");
    await bus.publish({ eventId: "bash-rollover", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer, queueDepth: 0 } });
    await publisher.drain();
    await vi.waitFor(() => expect(streamed.length).toBeGreaterThanOrEqual(2));

    const bashPages = streamed.filter((page) => page.includes("```bash"));
    expect(bashPages.length).toBeGreaterThanOrEqual(1);
    for (const [index, page] of bashPages.entries()) {
      expect(page).toMatch(/```bash/);
      expect(page.length).toBeLessThanOrEqual(ANSWER_STREAM_PAGE_LIMIT + 200);
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(store.listAnswerPages("p1").length).toBeGreaterThan(1);
    expect(store.loadRunCard("p1")?.answer).toBe(answer);

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("keeps the newest output on the last continuation card without rewriting frozen cards", async () => {
    const created: Array<{ cardId: string; card: object }> = [];
    const updates = new Map<string, string[]>();
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async replyStreamingCard(_rootMessageId, content) {
        const cardId = `answer-card-${created.length + 1}`;
        created.push({ cardId, card: content });
        return { messageId: `answer-${created.length}`, cardId };
      },
      async streamCardContent(cardId, _elementId, content) { updates.set(cardId, [...(updates.get(cardId) ?? []), content]); },
      async finishStreamingCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    await publisher.drain();

    const latestMarker = "LATEST_MESSAGE_MUST_REMAIN_VISIBLE";
    const answer = `${Array.from({ length: 4_500 }, (_, index) => `unique-line-${String(index).padStart(4, "0")}`).join("\n")}\n${latestMarker}`;
    await bus.publish({ eventId: "long-answer", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer, queueDepth: 0 } });
    await vi.waitFor(() => expect(created.length).toBeGreaterThanOrEqual(3));

    const lastCardId = created.at(-1)!.cardId;
    expect(updates.get(lastCardId)?.at(-1)).toContain(latestMarker);
    expect([...updates.entries()].filter(([cardId]) => cardId !== lastCardId).every(([, contents]) => contents.every((content) => !content.includes(latestMarker)))).toBe(true);
    expect(store.listAnswerPages("p1").slice(0, -1).every((page) => page.state === "frozen")).toBe(true);
    expect(store.loadRunCard("p1")?.answer).toBe(answer);

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("edits the same continuation post through active and terminal snapshots", async () => {
    const streamed: Array<{ cardId: string; content: string; sequence: number }> = [];
    const cardUpdates: Array<{ messageId: string; card: object }> = [];
    const created: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard(messageId, card) { cardUpdates.push({ messageId, card }); },
      async replyStreamingCard(_rootMessageId, card) {
        created.push(card);
        return { messageId: `answer-${created.length}`, cardId: `answer-card-${created.length}` };
      },
      async streamCardContent(cardId, _elementId, content, sequence) { streamed.push({ cardId, content, sequence }); },
      async finishStreamingCard() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    activatePrimary(store);
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    await publisher.drain();

    const latestMarker = "LATEST_CONTINUATION_CONTENT";
    const firstAnswer = `${"a".repeat(ANSWER_STREAM_PAGE_LIMIT - 100)}\n${"b".repeat(600)}\n${latestMarker}`;
    await bus.publish({ eventId: "first-page", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answerSnapshot: firstAnswer, answerUpdate: "replace", progressEvents: [], timelineDeltas: [{ id: "final:p1", sequence: 1, kind: "final_answer", markdown: firstAnswer }] } });
    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(JSON.stringify(created[1])).toContain(latestMarker);

    await bus.publish({ eventId: "second-page", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:01Z", payload: { promptId: "p1", answer: firstAnswer, queueDepth: 0 } });
    await vi.waitFor(() => expect(cardUpdates.filter((update) => update.messageId === "answer-2").length).toBeGreaterThanOrEqual(1));

    const continuationUpdates = cardUpdates.filter((update) => update.messageId === "answer-2");
    expect(JSON.stringify(continuationUpdates.at(-1)?.card)).toContain(latestMarker);
    expect(new Set(continuationUpdates.map((update) => update.messageId))).toEqual(new Set(["answer-2"]));

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("stops projection without waiting for background card delivery", async () => {
    let releaseUpdate!: () => void;
    const updateBlocked = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    let updated = false;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; },
      async replyCard() { return { messageId: "card1" }; },
      async updateCard() { await updateBlocked; updated = true; }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p2", state: "active", statusMessageId: "card1" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation);
    publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation);
    projector.start();

    const publishing = bus.publish({ eventId: "e-stop", bindingId: "b1", type: "BindingCreated", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Task", workspaceId: "w1", paneId: "w1:p2" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let stopped = false;
    const stopping = projector.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(true);

    releaseUpdate();
    await Promise.all([publishing, stopping]);

    expect(updated).toBe(true);
    await expect(projector.stop()).resolves.toBeUndefined();
    await publisher.stop();
    store.close();
  });

  it("waits for active card convergence before projection stops", async () => {
    let releaseConverge!: () => void;
    const convergeBlocked = new Promise<void>((resolve) => { releaseConverge = resolve; });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const bus = new BridgeEventBus();
    const mainConverge = vi.fn(async () => convergeBlocked);
    const publisher = { onAnswerCheckpoint: () => () => {}, requestScan: async () => {}, async enqueueCard() {}, async enqueueCardUpdate() {}, async enqueueRunCardUpdate() {}, async enqueueStreamCardCreate() {}, async enqueueStreamFinish() {}, async enqueueStreamContent() {} };
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, { converge: async () => undefined }, { project: async () => undefined, converge: mainConverge });
    projector.start();

    await bus.publish({ eventId: "degraded-stop", bindingId: "b1", type: "BindingDegraded", origin: "bridge", occurredAt: "2026-08-30T00:00:00.000Z", payload: { reason: "pane unavailable" } });
    await vi.waitFor(() => expect(mainConverge).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = projector.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseConverge();
    await stopping;
    expect(stopped).toBe(true);
    store.close();
  });

  it("coalesces concurrent Main events for one binding to the newest durable view", async () => {
    vi.useFakeTimers();
    const updates: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "card1" }; },
      async updateCard(_messageId, card) {
        const value = JSON.stringify(card);
        updates.push(value);
      }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p2", state: "active", statusMessageId: "card1" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation, undefined, undefined, { mainCardUpdateDebounceMs: 2_500 }); projector.start();

    const first = bus.publish({ eventId: "first", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "First" } });
    const second = bus.publish({ eventId: "second", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:01Z", payload: { title: "Second" } });
    await Promise.all([first, second]);
    expect(store.loadTopicView("b1")?.title).toBe("Second");
    expect(updates).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_500);
    await publisher.drain();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("Second");
    expect(updates[0]).not.toContain("First");
    await projector.stop(); await publisher.stop(); store.close(); vi.useRealTimers();
  });

  it("continues a binding projection tail after one event fails", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p2", state: "active" });
    const originalSave = store.saveTopicView.bind(store);
    let failOnce = true;
    store.saveTopicView = (view) => { if (failOnce) { failOnce = false; throw new Error("projection failed"); } originalSave(view); };
    const bus = new BridgeEventBus();
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; }, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();

    await expect(bus.publish({ eventId: "failed", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Failed" } })).resolves.toBeUndefined();
    expect(store.loadTopicView("b1")).toBeNull();
    expect(bus.snapshot()).toMatchObject({ subscriberFailures: 1, lastFailedSubscriber: "conversation-view-projector" });
    await expect(bus.publish({ eventId: "recovered", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:01Z", payload: { title: "Recovered" } })).resolves.toBeUndefined();
    expect(store.loadTopicView("b1")?.title).toBe("Recovered");
    await projector.stop(); await publisher.stop(); store.close();
  });

  it("projects different bindings independently", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const store = new SqliteBindingStore(":memory:");
    for (const id of ["b1", "b2"]) {
      store.createPendingBinding({ id, workspaceId: "w1", chatId: "c1", topicId: `t-${id}`, rootMessageId: `m-${id}`, title: id });
      store.updateBinding(id, { paneId: `w1:p-${id}`, state: "active", statusMessageId: `card-${id}` });
    }
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; },
      async updateCard(messageId) { if (messageId === "card-b1") await firstBlocked; }
    };
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }), primaryPresentation); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();

    const first = bus.publish({ eventId: "first", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Blocked" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = bus.publish({ eventId: "second", bindingId: "b2", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:01Z", payload: { title: "Independent" } });
    await vi.waitFor(() => expect(store.loadTopicView("b2")?.title).toBe("Independent"));
    releaseFirst();
    await Promise.all([first, second]);
    await projector.stop(); await publisher.stop(); store.close();
  });
});
