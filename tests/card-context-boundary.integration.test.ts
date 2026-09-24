import { afterEach, describe, expect, it, vi } from "vitest";
import { renderProjectEntryCard, renderRequestAnswerCard } from "../src/cards/run-card.js";
import { renderWorkerMainCard } from "../src/cards/worker-main-card.js";
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
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "card-context-rebuild-failed", outcome: "retry" }), expect.any(String));
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

  it("converges the three visible card aggregates, freezes Answer context, and keeps late Worker state in its owning boundary", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding", projectId: "project", workspaceId: "herdr", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary:pane", lastAgentState: "working" });
    store.saveTopicView({ ...initialTopicView("binding"), title: "Primary", workspaceId: "herdr", paneId: "primary:pane", phase: "running", viewVersion: 1 });
    const answer = createQueuedRunCard({ promptId: "primary-prompt", bindingId: "binding", bindingGeneration: 1, title: "Coordinate", workspaceId: "herdr", paneId: "primary:pane", requestText: "delegate", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: answer.promptId, bindingId: "binding", larkMessageId: "request-message", actorOpenId: "operator", body: "delegate" }, view: answer, rootMessageId: "root", answerCard: renderRequestAnswerCard(answer) });
    const answerCreate = store.listPendingOutboundReplies().find(({ promptId }) => promptId === answer.promptId)!;
    store.markOutboundReplyDelivered(answerCreate.id, "answer-message", "answer-card");

    const created = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "project", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary:pane", nativeSessionId: "primary-session" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "herdr", paneId: "worker:pane", nativeSessionId: "worker-session" })!;
    const task = createQueuedWorkerTurnCard({
      turnId: "worker-turn", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "Review durable boundary\nsecret body", queuePosition: 1,
      primaryAnswer: { aggregateKind: "primary-turn", aggregateId: answer.promptId, generation: 1, messageId: null }, occurredAt: "2026-09-05T00:00:01.000Z"
    });
    store.acceptInstanceTurnWithCard({ id: task.turnId, idempotencyKey: "delegate-1", actor: { kind: "thread-primary", projectId: "project", bindingId: "binding", bindingGeneration: 1, parentPromptId: answer.promptId }, projectId: "project", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: task.requestText, parentTurnId: null, sourceMessageId: "source", view: task, render: renderWorkerTurnCard });
    const wakeOutbound: string[] = [];
    const rebuilder = new CardContextRebuilder(store, () => wakeOutbound.push("wake"), { debug() {}, error() {} } as never, applicationPresentation);
    await rebuilder.requestScan();
    expect(store.loadTopicView("binding")).toMatchObject({ currentAnswer: { aggregateKind: "primary-turn", aggregateId: answer.promptId, generation: 1, messageId: "answer-message" } });
    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ currentTask: { turnId: task.turnId, title: "Review durable boundary", requestText: task.requestText, taskCard: { messageId: null } }, queueCount: 1, frozenAt: null });
    expect(store.loadTopicView("binding")).toMatchObject({ workers: [{ workerId: worker.id, currentTaskTitle: "Review durable boundary" }] });
    expect(store.loadRunCard(answer.promptId)).toMatchObject({ workerActivity: [{ workerId: worker.id, taskCount: 1, latestTaskCard: { messageId: null } }], workerContextFrozenAt: null });
    const workerMainCreate = store.listPendingOutboundReplies().find(({ workerId }) => workerId === worker.id)!;
    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(workerMainCreate.id)).toEqual({ lane_key: "gateway:feishu:primary:worker-thread:reviewer:1" });
    store.markOutboundReplyDelivered(workerMainCreate.id, "worker-main-message", "worker-main-card", "worker-topic");
    await rebuilder.requestScan();
    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ messageId: "worker-main-message", cardId: "worker-main-card" });
    expect(store.loadTopicView("binding")).toMatchObject({ workers: [{ workerMain: { messageId: "worker-main-message" } }] });
    expect(store.loadWorkerTurnCard(task.turnId)).toMatchObject({ workerMain: { messageId: null }, primaryAnswer: { messageId: null } });
    expect(store.listPendingOutboundReplies().some(({ workerTurnId, kind }) => workerTurnId === task.turnId && kind === "stream_card_create")).toBe(true);
    const taskCreate = store.listPendingOutboundReplies().find(({ workerTurnId, kind }) => workerTurnId === task.turnId && kind === "stream_card_create")!;
    store.markOutboundReplyDelivered(taskCreate.id, "worker-task-page-1", "worker-task-card-1");
    await rebuilder.requestScan();
    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ currentTask: { taskCard: { messageId: "worker-task-page-1" } } });
    const workerMainUpdate = store.listPendingOutboundReplies().find(({ workerId, kind }) => workerId === worker.id && kind === "card_update")!;
    expect(workerMainUpdate.laneKey).toBe("gateway:feishu:primary:worker-main:reviewer:1");
    expect(workerMainUpdate.rootMessageId).toBe("worker-main-message");
    expect(workerMainUpdate.payload).toContain("worker_new_task_form");
    expect(workerMainUpdate.payload).toContain("worker-main-message");

    store.completeTurn({ promptId: answer.promptId, bindingId: "binding", answer: "Primary synthesis", occurredAt: "2026-09-05T00:00:02.000Z", outputFingerprint: "fp" });
    const frozen = store.loadRunCard(answer.promptId)!;
    expect(frozen.workerContextFrozenAt).toBe("2026-09-05T00:00:02.000Z");
    store.transitionInstanceTurnWithProjection({ turnId: task.turnId, expectedGeneration: worker.generation, state: "completed", result: "private Worker result", eventKind: "turn.completed", change: { type: "completed", occurredAt: "2026-09-05T00:00:03.000Z", answer: "private Worker result" }, render: renderWorkerTurnCard });
    await rebuilder.requestScan();
    expect(store.loadRunCard(answer.promptId)?.workerActivity).toEqual(frozen.workerActivity);
    expect(JSON.stringify(renderProjectEntryCard(store.loadTopicView("binding")!))).not.toContain("private Worker result");
    expect(JSON.stringify(renderWorkerMainCard(store.loadWorkerMainView(worker.id, 1)!))).toContain("private Worker result");

    store.terminateWorkerSession({ instanceId: worker.id, expectedGeneration: worker.generation, reason: "done" });
    await rebuilder.requestScan();
    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ runtimeState: "terminated", frozenAt: expect.any(String) });
    expect(store.loadTopicView("binding")?.workers).toEqual([]);
    expect(wakeOutbound.length).toBeGreaterThan(0);
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
    const taskCreate = store.listPendingOutboundReplies().find(({ workerTurnId, kind }) => workerTurnId === task.turnId && kind === "stream_card_create")!;
    store.markOutboundReplyDelivered(taskCreate.id, "worker-task-page-1", "worker-task-card-1");
    await rebuilder.requestScan();

    const completed = store.transitionInstanceTurnWithProjection({
      turnId: task.turnId, expectedGeneration: worker.generation, state: "completed", result: "long result", eventKind: "turn.completed",
      change: { type: "completed", occurredAt: "2026-09-05T00:01:00.000Z", answer: "long result" }, render: renderWorkerTurnCard
    })!;
    expect(store.reserveWorkerTurnContinuation({
      turnId: task.turnId, pageIndex: 0, cardId: "worker-task-card-1", summary: "回答将在第 2 页继续", nextPageIndex: 1, nextPageStart: 1_234, nextElementId: workerTurnElementId(task.turnId, 1), rootMessageId: task.rootMessageId, viewVersion: completed.view.viewVersion, card: { page: 2 }
    })).toBe("reserved");

    const continuationIntents = store.listPendingOutboundReplies().filter(({ workerTurnId }) => workerTurnId === task.turnId);
    const finish = continuationIntents.find(({ kind }) => kind === "stream_finish")!;
    const continuation = continuationIntents.find(({ kind }) => kind === "stream_card_create")!;
    store.markOutboundReplyDelivered(finish.id, "worker-task-card-1");
    expect(store.listWorkerTurnCardPages(task.turnId)).toEqual(expect.arrayContaining([expect.objectContaining({ pageIndex: 0, pageStart: 0, state: "frozen" })]));

    store.markOutboundReplyDelivered(continuation.id, "worker-task-page-2", "worker-task-card-2");
    expect(store.listWorkerTurnCardPages(task.turnId)).toEqual([
      expect.objectContaining({ pageIndex: 0, pageStart: 0, messageId: "worker-task-page-1", state: "frozen" }),
      expect.objectContaining({ pageIndex: 1, pageStart: 1_234, messageId: "worker-task-page-2", state: "active" })
    ]);
    await rebuilder.requestScan();
    expect(store.loadWorkerMainView(worker.id, worker.workerSessionGeneration)).toMatchObject({
      currentTask: { turnId: task.turnId, taskCard: { aggregateKind: "worker-turn", aggregateId: task.turnId, generation: worker.generation, messageId: "worker-task-page-2" } }
    });
  });
});
