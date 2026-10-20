import { afterEach, describe, expect, it, vi } from "vitest";
import { renderRequestAnswerCard } from "../src/cards/run-card.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { createQueuedWorkerTurnCard, workerTurnElementId } from "../src/domain/worker-turn-card-view.js";
import { CardContextRebuilder } from "../src/events/card-context-rebuilder.js";
import { InProcessOutboundWorkNotifier } from "../src/events/outbound-work-notifier.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { applicationPresentation } from "./helpers/presentation.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe("card context boundaries", () => {
  it("reports a rebuild failure to an explicit scan caller", async () => {
    const projectionError = new Error("projection unavailable");
    const error = vi.fn();
    const rebuilder = new CardContextRebuilder(
      {
        listPendingCardContextInvalidations: () => [{
          targetKind: "worker-session", targetId: "reviewer", targetGeneration: 1,
          requestedDependencyRevision: 1, projectedDependencyRevision: 0, reason: "turn.accepted",
          createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z"
        }],
        projectCardContext: () => { throw projectionError; }
      },
      () => {}, { debug() {}, error } as never, applicationPresentation
    );

    await expect(rebuilder.requestScan()).rejects.toBe(projectionError);

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "card-context-rebuild-failed", outcome: "retry", targetKind: "worker-session", targetId: "reviewer", targetGeneration: 1, dependencyRevision: 1 }), expect.any(String));
  });

  it("drains more than one bounded invalidation batch in a single scan", async () => {
    const pending = Array.from({ length: 205 }, (_, index) => ({
      targetKind: "worker-session" as const, targetId: `worker-${index}`, targetGeneration: 1,
      requestedDependencyRevision: 1, projectedDependencyRevision: 0, reason: "turn.accepted",
      createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z"
    }));
    const listPendingCardContextInvalidations = vi.fn((limit: number) => pending.slice(0, limit));
    const projectCardContext = vi.fn((invalidation: (typeof pending)[number]) => {
      pending.splice(pending.indexOf(invalidation), 1);
      return "current" as const;
    });
    const rebuilder = new CardContextRebuilder(
      { listPendingCardContextInvalidations, projectCardContext },
      () => {}, { debug() {}, error() {} } as never, applicationPresentation
    );

    await rebuilder.requestScan();

    expect(projectCardContext).toHaveBeenCalledTimes(205);
    expect(listPendingCardContextInvalidations).toHaveBeenCalledTimes(3);
    expect(pending).toEqual([]);
  });

  it("stops draining when a full batch makes no durable progress", async () => {
    const pending = Array.from({ length: 100 }, (_, index) => ({
      targetKind: "worker-session" as const, targetId: `worker-${index}`, targetGeneration: 1,
      requestedDependencyRevision: 1, projectedDependencyRevision: 0, reason: "turn.accepted",
      createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z"
    }));
    const listPendingCardContextInvalidations = vi.fn(() => pending);
    const projectCardContext = vi.fn(() => "current" as const);
    const rebuilder = new CardContextRebuilder(
      { listPendingCardContextInvalidations, projectCardContext },
      () => {}, { debug() {}, error() {} } as never, applicationPresentation
    );

    await rebuilder.requestScan();

    expect(projectCardContext).toHaveBeenCalledTimes(100);
    expect(listPendingCardContextInvalidations).toHaveBeenCalledTimes(2);
  });

  it("isolates a background rebuild failure and retries on a later wake", async () => {
    const invalidation = {
      targetKind: "worker-session" as const, targetId: "reviewer", targetGeneration: 1,
      requestedDependencyRevision: 1, projectedDependencyRevision: 0, reason: "turn.accepted",
      createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z"
    };
    const projectCardContext = vi.fn()
      .mockImplementationOnce(() => { throw new Error("projection unavailable"); })
      .mockReturnValueOnce("reserved");
    const error = vi.fn();
    const wakeOutbound = vi.fn();
    const work = new InProcessOutboundWorkNotifier();
    const rebuilder = new CardContextRebuilder(
      { listPendingCardContextInvalidations: () => [invalidation], projectCardContext },
      wakeOutbound, { debug() {}, error } as never, applicationPresentation, work
    );

    rebuilder.start(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    work.wake();
    await new Promise((resolve) => setImmediate(resolve));
    await rebuilder.stop();

    expect(projectCardContext).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "card-context-rebuild-failed", outcome: "retry" }), expect.any(String));
    expect(wakeOutbound).toHaveBeenCalledTimes(1);
  });

  it("runs one follow-up pass when durable work wakes an active scan", async () => {
    const first = {
      targetKind: "worker-session" as const, targetId: "first", targetGeneration: 1,
      requestedDependencyRevision: 1, projectedDependencyRevision: 0, reason: "turn.accepted",
      createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z"
    };
    const second = { ...first, targetId: "second" };
    let pending = [first];
    const work = new InProcessOutboundWorkNotifier();
    const projectCardContext = vi.fn((invalidation: typeof first) => {
      pending = [];
      if (invalidation.targetId === "first") { pending = [second]; work.wake(); }
      return "current" as const;
    });
    const listPendingCardContextInvalidations = vi.fn(() => pending);
    const rebuilder = new CardContextRebuilder(
      { listPendingCardContextInvalidations, projectCardContext },
      () => {}, { debug() {}, error() {} } as never, applicationPresentation, work
    );

    rebuilder.start(60_000);
    await vi.waitFor(() => expect(projectCardContext).toHaveBeenCalledTimes(2));
    await rebuilder.stop();

    expect(projectCardContext.mock.calls.map(([invalidation]) => invalidation.targetId)).toEqual(["first", "second"]);
    expect(listPendingCardContextInvalidations).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an orphaned owner", { state: "orphaned", attachment: "orphaned" }],
    ["a detached owner", { attachment: "degraded" }],
    ["a superseded owner", { state: "archived", lifecycle: "archived" }],
    ["a newer Binding generation", { generation: 2 }],
    ["a newer session epoch", { sessionEpoch: 2 }],
    ["a different native session", { agentSessionValue: "native-2" }],
    ["a different Pane", { paneId: "primary:replacement" }],
    ["a different root message", { rootMessageId: "replacement-root" }]
  ] as const)("settles stale Primary Session projection without Topic or outbox mutation for %s", async (_name, patch) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane", traexSessionId: "terminal-1",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "native-1",
      sessionEpoch: 1, lastAgentState: "working"
    });
    store.saveTopicView({
      ...initialTopicView("binding"), title: "Primary", workspaceId: "herdr", paneId: "primary:pane", phase: "running", viewVersion: 1,
      sessionIdentity: { bindingGeneration: 1, sessionEpoch: 1, nativeSessionId: "native-1", paneId: "primary:pane", rootMessageId: "root" }
    });
    store.invalidateCardContexts([{ targetKind: "primary-session", targetId: "binding", targetGeneration: 1, reason: "worker-context.changed" }]);
    store.updateBinding("binding", patch);
    const beforeTopic = store.database.prepare("SELECT state_json FROM topic_views WHERE binding_id = ?").get("binding");
    const beforeOutbox = store.listPendingOutboundReplies().length;

    const rebuilder = new CardContextRebuilder(store, () => {}, { debug() {}, error() {} } as never, applicationPresentation);
    await rebuilder.requestScan();

    expect(store.listPendingCardContextInvalidations()).toEqual([]);
    expect(store.database.prepare("SELECT state_json FROM topic_views WHERE binding_id = ?").get("binding")).toEqual(beforeTopic);
    expect(store.listPendingOutboundReplies()).toHaveLength(beforeOutbox);
  });

  it("admits an exact active Primary Session owner and reserves its Main Card", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "native-1", sessionEpoch: 1
    });
    store.saveTopicView({
      ...initialTopicView("binding"), workspaceId: "herdr", paneId: "primary:pane", phase: "running", viewVersion: 1,
      sessionIdentity: { bindingGeneration: 1, sessionEpoch: 1, nativeSessionId: "native-1", paneId: "primary:pane", rootMessageId: "root" }
    });
    store.invalidateCardContexts([{ targetKind: "primary-session", targetId: "binding", targetGeneration: 1, reason: "worker-context.changed" }]);

    await new CardContextRebuilder(store, () => {}, { debug() {}, error() {} } as never, applicationPresentation).requestScan();

    expect(store.loadTopicView("binding")).toMatchObject({ workerDependencyRevision: 1 });
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([expect.objectContaining({ bindingId: "binding", targetRole: "session_status" })]));
  });

  it("does not treat a newer legacy Topic write as current Primary Session proof", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "native-1", sessionEpoch: 1
    });
    const legacy = { ...initialTopicView("binding"), workspaceId: "herdr", paneId: "primary:pane", phase: "running" as const, viewVersion: 1 };
    store.saveTopicView(legacy);
    store.updateBinding("binding", { agentSessionValue: "native-2", sessionEpoch: 2, rootMessageId: "replacement-root" });
    store.saveTopicView({ ...legacy, sessionActivityRevision: 1, activityAt: "2026-10-18T00:00:01.000Z", viewVersion: 2 });
    store.invalidateCardContexts([{ targetKind: "primary-session", targetId: "binding", targetGeneration: 1, reason: "worker-context.changed" }]);
    const beforeTopic = store.database.prepare("SELECT state_json FROM topic_views WHERE binding_id = ?").get("binding");

    await new CardContextRebuilder(store, () => {}, { debug() {}, error() {} } as never, applicationPresentation).requestScan();

    expect(store.database.prepare("SELECT state_json FROM topic_views WHERE binding_id = ?").get("binding")).toEqual(beforeTopic);
    expect(store.loadTopicView("binding")?.sessionIdentity).toBeNull();
    expect(store.listPendingOutboundReplies()).toHaveLength(0);
  });

  it("settles an older legacy Primary Session view after Binding identity changes", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane", agentSessionKind: "id", agentSessionValue: "native-1", sessionEpoch: 1 });
    store.saveTopicView({ ...initialTopicView("binding"), workspaceId: "herdr", paneId: "primary:pane", phase: "running", viewVersion: 1 });
    store.database.prepare("UPDATE topic_views SET updated_at = ? WHERE binding_id = ?").run("2026-10-18T00:00:00.000Z", "binding");
    store.updateBinding("binding", { agentSessionValue: "native-2", sessionEpoch: 2, rootMessageId: "replacement-root" });
    store.database.prepare("UPDATE bindings SET updated_at = ? WHERE id = ?").run("2026-10-18T00:00:01.000Z", "binding");
    store.invalidateCardContexts([{ targetKind: "primary-session", targetId: "binding", targetGeneration: 1, reason: "worker-context.changed" }]);
    const beforeTopic = store.database.prepare("SELECT state_json FROM topic_views WHERE binding_id = ?").get("binding");

    await new CardContextRebuilder(store, () => {}, { debug() {}, error() {} } as never, applicationPresentation).requestScan();

    expect(store.database.prepare("SELECT state_json FROM topic_views WHERE binding_id = ?").get("binding")).toEqual(beforeTopic);
    expect(store.listPendingOutboundReplies()).toHaveLength(0);
  });

  it("fences a changed Answer snapshot behind the exact claimed card-context effect", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane", paneToken: "prim", lastAgentState: "working" });
    const answer = createQueuedRunCard({ promptId: "primary-prompt", bindingId: "binding", bindingGeneration: 1, title: "Coordinate", workspaceId: "herdr", paneId: "primary:pane", paneToken: "prim", requestText: "delegate", queuePosition: 1, occurredAt: "2026-09-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: answer.promptId, bindingId: "binding", larkMessageId: "request-message", actorOpenId: "operator", body: "delegate" }, view: answer, rootMessageId: "root", answerCard: renderRequestAnswerCard(answer) });
    const create = store.listPendingOutboundReplies().find(({ promptId }) => promptId === answer.promptId)!;
    store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
    const delivered = store.loadRunCard(answer.promptId)!;
    store.saveRunCard({ ...delivered, viewVersion: delivered.viewVersion + 1, workerDependencyRevision: 1, updatedAt: "2026-09-30T00:00:01.000Z" });
    store.invalidateCardContexts([{ targetKind: "primary-turn", targetId: answer.promptId, targetGeneration: 1, reason: "worker-context.changed" }]);
    const rebuilder = new CardContextRebuilder(store, () => {}, { debug() {}, error() {} } as never, applicationPresentation);
    await rebuilder.requestScan();

    const claimed = store.listPendingOutboundReplies().find(({ idempotencyKey }) => idempotencyKey === "run-card:update:primary-prompt:answer:2")!;
    const frozenPayload = claimed.payload;
    store.database.prepare("UPDATE outbound_replies SET attempt_count = 1, first_claimed_at = ? WHERE id = ?").run("2026-09-30T00:00:02.000Z", claimed.id);
    store.invalidateCardContexts([{ targetKind: "primary-turn", targetId: answer.promptId, targetGeneration: 1, reason: "renderer.changed" }]);

    await expect(rebuilder.requestScan()).resolves.toBeUndefined();

    expect(store.database.prepare("SELECT requested_dependency_revision, projected_dependency_revision FROM card_context_invalidations WHERE target_kind = 'primary-turn' AND target_id = ? AND target_generation = 1").get(answer.promptId)).toEqual({ requested_dependency_revision: 2, projected_dependency_revision: 2 });
    expect(store.loadRunCard(answer.promptId)).toMatchObject({ viewVersion: 3, workerDependencyRevision: 2 });
    expect(store.database.prepare("SELECT payload, attempt_count, first_claimed_at FROM outbound_replies WHERE id = ?").get(claimed.id)).toEqual({ payload: frozenPayload, attempt_count: 1, first_claimed_at: "2026-09-30T00:00:02.000Z" });
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([
      expect.objectContaining({ idempotencyKey: "run-card:update:primary-prompt:answer:3", promptId: answer.promptId, viewVersion: 3, cardRole: "answer", kind: "card_update" })
    ]));
    const successor = store.listPendingOutboundReplies().find(({ idempotencyKey }) => idempotencyKey === "run-card:update:primary-prompt:answer:3")!;
    expect(() => store.database.prepare("UPDATE outbound_replies SET root_message_id = 'other-answer-message' WHERE id = ?").run(successor.id)).toThrow("immutable_outbound_revision");
  });

  it("converges the three visible card aggregates through their parent Primary Pane PreparedDelivery scope", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "primary-workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane", paneToken: "prim", lastAgentState: "working",
      agentSessionKind: "id", agentSessionValue: "primary-session", sessionEpoch: 1
    });
    store.saveTopicView({
      ...initialTopicView("binding"), title: "Primary", workspaceId: "primary-workspace", paneId: "primary:pane", paneToken: "prim", phase: "running", viewVersion: 1,
      sessionIdentity: { bindingGeneration: 1, sessionEpoch: 1, nativeSessionId: "primary-session", paneId: "primary:pane", rootMessageId: "root" }
    });
    const answer = createQueuedRunCard({ promptId: "primary-prompt", bindingId: "binding", bindingGeneration: 1, title: "Coordinate", workspaceId: "primary-workspace", paneId: "primary:pane", paneToken: "prim", requestText: "delegate", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: answer.promptId, bindingId: "binding", larkMessageId: "request-message", actorOpenId: "operator", body: "delegate" }, view: answer, rootMessageId: "root", answerCard: renderRequestAnswerCard(answer) });
    const answerCreate = store.listPendingOutboundReplies().find(({ promptId }) => promptId === answer.promptId)!;
    store.markOutboundReplyDelivered(answerCreate.id, "answer-message", "answer-card");

    const created = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "project", name: "reviewer", role: "worker", agentKind: "traex", model: "GPT-5", desiredState: "running",
      parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary:pane", nativeSessionId: "primary-session" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "worker-workspace", paneId: "worker:pane", paneToken: "work", nativeSessionId: "worker-session" })!;
    const task = createQueuedWorkerTurnCard({
      turnId: "worker-turn", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "Review durable boundary\nsecret body", queuePosition: 1,
      primaryAnswer: { aggregateKind: "primary-turn", aggregateId: answer.promptId, generation: 1, messageId: null }, occurredAt: "2026-09-05T00:00:01.000Z"
    });
    store.acceptInstanceTurnWithCard({ id: task.turnId, idempotencyKey: "delegate-1", actor: { kind: "thread-primary", projectId: "project", bindingId: "binding", bindingGeneration: 1, parentPromptId: answer.promptId }, projectId: "project", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: task.requestText, parentTurnId: null, sourceMessageId: "source", view: task, render: renderWorkerTurnCard });
    const rebuilder = new CardContextRebuilder(store, () => {}, { debug() {}, error() {} } as never, applicationPresentation);
    await rebuilder.requestScan();
    expect(store.loadTopicView("binding")).toMatchObject({ currentAnswer: { aggregateKind: "primary-turn", aggregateId: answer.promptId, generation: 1, messageId: "answer-message" } });
    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ paneId: "worker:pane", paneToken: "work", parentPaneId: "primary:pane", parentPaneToken: "prim", modelUsage: { model: "GPT-5", queuedAt: expect.any(String), waitMs: null, completedAt: null }, currentTask: { turnId: task.turnId, title: "Review durable boundary", requestText: task.requestText, taskCard: { messageId: null } }, queueCount: 1, frozenAt: null });
    expect(store.loadTopicView("binding")).toMatchObject({ workers: [{ workerId: worker.id, currentTaskTitle: "Review durable boundary" }] });
    expect(store.loadRunCard(answer.promptId)).toMatchObject({ workerActivity: [{ workerId: worker.id, taskCount: 1, latestTaskCard: { messageId: null } }], workerContextFrozenAt: null });
    expect(store.listPendingOutboundReplies().some(({ promptId, cardRole, kind, intentKind }) => promptId === answer.promptId && cardRole === "answer" && kind === "card_update" && intentKind === "card")).toBe(true);
    const workerMainCreate = store.listPendingOutboundReplies().find(({ workerId }) => workerId === worker.id)!;
    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(workerMainCreate.id)).toEqual({ lane_key: "gateway:feishu:primary:worker-thread:reviewer:1" });
    store.markOutboundReplyDelivered(workerMainCreate.id, "worker-main-message", "worker-main-card", "worker-topic");
    await rebuilder.requestScan();
    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ messageId: "worker-main-message", cardId: "worker-main-card" });
    expect(store.loadTopicView("binding")).toMatchObject({ workers: [{ workerMain: { messageId: "worker-main-message" } }] });
    const beforeIdentity = store.loadWorkerMainView(worker.id, 1)!;
    const lease = store.getWorkspaceLease(worker.workspaceLeaseId)!;
    store.updateWorkspaceLease({ id: lease.id, expectedGeneration: lease.generation, state: lease.state, branch: "swarm/reviewer-v2" });
    store.invalidateCardContexts([{ targetKind: "worker-session", targetId: worker.id, targetGeneration: worker.workerSessionGeneration, reason: "workspace.identity.changed" }]);
    await rebuilder.requestScan();
    const identityView = store.loadWorkerMainView(worker.id, 1)!;
    expect(identityView).toMatchObject({ branch: "swarm/reviewer-v2", paneIdentity: { branch: "swarm/reviewer-v2" } });
    expect(identityView.viewVersion).toBeGreaterThan(beforeIdentity.viewVersion);
    expect(identityView.dependencyRevision).toBeGreaterThan(beforeIdentity.dependencyRevision);
    const identityUpdate = store.listPendingOutboundReplies().find(({ workerId, kind, payload }) => workerId === worker.id && kind === "card_update" && payload.includes("Branch  `swarm/reviewer-v2`"))!;
    expect(identityUpdate.payload).toContain("Branch  `swarm/reviewer-v2`");
    store.markOutboundReplyDelivered(identityUpdate.id, "worker-main-message", "worker-main-card", "worker-topic");
    await rebuilder.requestScan();
    expect(store.loadWorkerTurnCard(task.turnId)).toMatchObject({ workerMain: { messageId: null }, primaryAnswer: { messageId: null } });
    expect(store.listPendingOutboundReplies().some(({ workerTurnId, kind, intentKind }) => workerTurnId === task.turnId && kind === "stream_card_create" && intentKind === "stream-card")).toBe(true);
    const taskCreate = store.listPendingOutboundReplies().find(({ workerTurnId, kind, intentKind }) => workerTurnId === task.turnId && kind === "stream_card_create" && intentKind === "stream-card")!;
    store.markOutboundReplyDelivered(taskCreate.id, "worker-task-page-1", "worker-task-card-1");
    await rebuilder.requestScan();
    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ currentTask: { taskCard: { messageId: "worker-task-page-1" } } });
    const workerMainUpdate = store.listPendingOutboundReplies().find(({ workerId, kind }) => workerId === worker.id && kind === "card_update")!;
    expect(workerMainUpdate.laneKey).toBe("gateway:feishu:primary:worker-main:reviewer:1");
    expect(workerMainUpdate.rootMessageId).toBe("worker-main-message");
    expect(workerMainUpdate.payload).toContain("worker_new_task_form");
    expect(workerMainUpdate.payload).toContain("worker-main-message");
  });

  it("converges a terminated Worker invalidation without blocking later card-context scans", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane", lastAgentState: "working" });
    const created = store.createWorkerAgentInstance({
      id: "retired-worker", projectId: "project", name: "retired-worker", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary:pane", nativeSessionId: "primary-session" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "herdr", paneId: "worker:pane", nativeSessionId: "worker-session" })!;
    const activeRebuilder = new CardContextRebuilder(store, () => {}, { debug() {}, error() {} } as never, applicationPresentation);
    await activeRebuilder.requestScan();
    const workerMain = store.listPendingOutboundReplies().find(({ workerId, kind }) => workerId === worker.id && kind === "group_card_create")!;
    store.markOutboundReplyDelivered(workerMain.id, "worker-main-message", "worker-main-card", "worker-topic");
    const terminated = store.terminateWorkerSession({ instanceId: worker.id, expectedGeneration: worker.generation, reason: "done" })!.instance;
    store.invalidateCardContexts([{ targetKind: "worker-session", targetId: worker.id, targetGeneration: terminated.workerSessionGeneration, reason: "worker.terminated" }]);

    const rebuilder = new CardContextRebuilder(store, () => {}, { debug() {}, error() {} } as never, applicationPresentation);
    await expect(rebuilder.requestScan()).resolves.toBeUndefined();

    expect(store.listPendingCardContextInvalidations()).toEqual([]);
    expect(store.listPendingOutboundReplies().filter(({ workerId }) => workerId === worker.id)).toEqual([]);
  });

  it.each([
    { name: "an orphaned parent", prepare: (targetStore: SqliteBindingStore, worker: { id: string; generation: number }) => targetStore.updateBinding("binding", { state: "orphaned", attachment: "orphaned" }) },
    { name: "a runtime-less failed Worker", prepare: (targetStore: SqliteBindingStore, worker: { id: string; generation: number }) => targetStore.updateAgentInstanceLifecycle({ instanceId: worker.id, expectedGeneration: worker.generation, desiredState: "running", observedState: "failed", clearRuntime: true }) }
  ])("settles a Worker Main invalidation without reserving an invalid scope for $name", async ({ prepare }) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane", lastAgentState: "working" });
    const created = store.createWorkerAgentInstance({
      id: "undeliverable-worker", projectId: "project", name: "undeliverable-worker", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary:pane", nativeSessionId: "primary-session" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "herdr", paneId: "worker:pane", nativeSessionId: "worker-session" })!;
    prepare(store, worker);
    store.invalidateCardContexts([{ targetKind: "worker-session", targetId: worker.id, targetGeneration: worker.workerSessionGeneration, reason: "worker.runtime-observed" }]);

    const rebuilder = new CardContextRebuilder(store, () => {}, { debug() {}, error() {} } as never, applicationPresentation);
    await expect(rebuilder.requestScan()).resolves.toBeUndefined();

    expect(store.listPendingCardContextInvalidations()).toEqual([]);
    expect(store.listPendingOutboundReplies().filter(({ workerId }) => workerId === worker.id)).toEqual([]);
  });

  it("hides a dispatch-uncertain Worker when it has no current runnable task", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane", lastAgentState: "working" });
    const created = store.createWorkerAgentInstance({
      id: "uncertain-worker", projectId: "project", name: "uncertain-worker", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary:pane", nativeSessionId: "primary-session" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "herdr", paneId: "worker:pane", nativeSessionId: "worker-session" })!;
    const task = createQueuedWorkerTurnCard({ turnId: "uncertain-turn", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "uncertain", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptInstanceTurnWithCard({ id: task.turnId, idempotencyKey: task.turnId, actor: { kind: "human", userId: "operator" }, projectId: "project", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: task.requestText, parentTurnId: null, sourceMessageId: "source", view: task, render: renderWorkerTurnCard });
    store.database.prepare("UPDATE worker_turn_cards SET phase = 'dispatch-uncertain' WHERE turn_id = ?").run(task.turnId);

    expect(store.loadPrimaryWorkerSummaries("binding", 1)).toEqual([]);
  });

  it("keeps Worker page offsets canonical and retargets Worker Main after continuation delivery", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane", lastAgentState: "working" });
    store.saveTopicView({ ...initialTopicView("binding"), title: "Primary", workspaceId: "herdr", paneId: "primary:pane", phase: "running", viewVersion: 1 });
    const created = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "project", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary:pane", nativeSessionId: "primary-session" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "herdr", paneId: "worker:pane", nativeSessionId: "worker-session" })!;
    const task = createQueuedWorkerTurnCard({
      turnId: "worker-turn", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "Produce a long report", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z"
    });
    store.acceptInstanceTurnWithCard({ id: task.turnId, idempotencyKey: task.turnId, actor: { kind: "human", userId: "operator" }, projectId: "project", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: task.requestText, parentTurnId: null, sourceMessageId: "source", view: task, render: renderWorkerTurnCard });
    const rebuilder = new CardContextRebuilder(store, () => {}, { debug() {}, error() {} } as never, applicationPresentation);
    await rebuilder.requestScan();

    const workerMainCreate = store.listPendingOutboundReplies().find(({ workerId }) => workerId === worker.id)!;
    store.markOutboundReplyDelivered(workerMainCreate.id, "worker-main-message", "worker-main-card", "worker-topic");
    const taskCreate = store.listPendingOutboundReplies().find(({ workerTurnId, kind, intentKind }) => workerTurnId === task.turnId && kind === "stream_card_create" && intentKind === "stream-card")!;
    store.markOutboundReplyDelivered(taskCreate.id, "worker-task-page-1", "worker-task-card-1");
    await rebuilder.requestScan();

    const completed = store.transitionInstanceTurnWithProjection({
      turnId: task.turnId, expectedGeneration: worker.generation, state: "completed", result: "long result", eventKind: "turn.completed",
      change: { type: "completed", occurredAt: "2026-09-05T00:01:00.000Z", answer: "long result" }, render: renderWorkerTurnCard
    })!;
    expect(store.reserveWorkerTurnContent({
      turnId: task.turnId, pageIndex: 0, cardId: "worker-task-card-1", elementId: task.elementId, content: "long result", sourceEnd: 5
    })).toBe("reserved");
    const content = store.listPendingOutboundReplies().find(({ workerTurnId, kind }) => workerTurnId === task.turnId && kind === "stream_content")!;
    store.markOutboundReplyDelivered(content.id, "worker-task-page-1", "worker-task-card-1");
    expect(store.reserveWorkerTurnContinuation({
      turnId: task.turnId, pageIndex: 0, cardId: "worker-task-card-1", summary: "Continued on page 2",
      nextPageIndex: 1, nextPageStart: 5, nextElementId: workerTurnElementId(task.turnId, 1), rootMessageId: task.rootMessageId, viewVersion: completed.view.viewVersion,
      card: renderWorkerTurnCard(completed.view, {
        id: `${task.turnId}:1`, turnId: task.turnId, pageIndex: 1, pageStart: 5, elementId: workerTurnElementId(task.turnId, 1),
        messageId: null, cardId: null, state: "creating", sequence: 0, createdAt: completed.view.updatedAt, updatedAt: completed.view.updatedAt
      }, { initialContent: "result" })
    })).toBe("reserved");

    const continuationIntents = store.listPendingOutboundReplies().filter(({ workerTurnId }) => workerTurnId === task.turnId);
    const finish = continuationIntents.find(({ kind, intentKind }) => kind === "stream_finish" && intentKind === "stream-finish")!;
    const continuation = continuationIntents.find(({ kind, intentKind }) => kind === "stream_card_create" && intentKind === "stream-card")!;
    expect(JSON.parse(continuation.payload)).toMatchObject({ stream: { pageStart: 5, pageIndex: 1 } });
    store.markOutboundReplyDelivered(finish.id, "worker-task-page-1", "worker-task-card-1");
    expect(store.listWorkerTurnCardPages(task.turnId)).toEqual(expect.arrayContaining([expect.objectContaining({ pageIndex: 0, pageStart: 0, state: "frozen" })]));

    store.markOutboundReplyDelivered(continuation.id, "worker-task-page-2", "worker-task-card-2");
    expect(store.listWorkerTurnCardPages(task.turnId)).toEqual([
      expect.objectContaining({ pageIndex: 0, pageStart: 0, messageId: "worker-task-page-1", state: "frozen" }),
      expect.objectContaining({ pageIndex: 1, pageStart: 5, messageId: "worker-task-page-2", state: "active" })
    ]);
    await rebuilder.requestScan();
    expect(store.loadWorkerMainView(worker.id, worker.workerSessionGeneration)).toMatchObject({
      currentTask: { turnId: task.turnId, taskCard: { aggregateKind: "worker-turn", aggregateId: task.turnId, generation: worker.generation, messageId: "worker-task-page-2" } }
    });
  });
});
