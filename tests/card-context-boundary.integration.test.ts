import { afterEach, describe, expect, it, vi } from "vitest";
import { renderProjectEntryCard, renderRequestAnswerCard } from "../src/cards/run-card.js";
import { renderWorkerMainCard } from "../src/cards/worker-main-card.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
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

    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ currentTask: { turnId: task.turnId, title: "Review durable boundary", requestText: task.requestText, taskCard: { messageId: null } }, queueCount: 1, frozenAt: null });
    expect(store.loadTopicView("binding")).toMatchObject({ workers: [{ workerId: worker.id, currentTaskTitle: "Review durable boundary" }] });
    expect(store.loadRunCard(answer.promptId)).toMatchObject({ workerActivity: [{ workerId: worker.id, taskCount: 1, latestTaskCard: { messageId: null } }], workerContextFrozenAt: null });
    const workerMainCreate = store.listPendingOutboundReplies().find(({ workerId }) => workerId === worker.id)!;
    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(workerMainCreate.id)).toEqual({ lane_key: "worker-thread:reviewer:1" });
    store.markOutboundReplyDelivered(workerMainCreate.id, "worker-main-message", "worker-main-card", "worker-topic");
    await rebuilder.requestScan();
    expect(store.loadWorkerMainView(worker.id, 1)).toMatchObject({ messageId: "worker-main-message", cardId: "worker-main-card" });
    expect(store.loadTopicView("binding")).toMatchObject({ workers: [{ workerMain: { messageId: "worker-main-message" } }] });
    expect(store.loadWorkerTurnCard(task.turnId)).toMatchObject({ workerMain: { messageId: null }, primaryAnswer: { messageId: null } });
    expect(store.listPendingOutboundReplies().some(({ workerTurnId }) => workerTurnId === task.turnId)).toBe(false);
    const workerMainUpdate = store.listPendingOutboundReplies().find(({ workerId, kind }) => workerId === worker.id && kind === "card_update")!;
    expect(workerMainUpdate.laneKey).toBe("worker-main:reviewer:1");
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
});
