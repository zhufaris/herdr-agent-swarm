import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { StartupViewConverger, type StartupViewConvergerOptions } from "../src/coordinator/startup-view-converger.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import type { OutboundIntentPort } from "../src/domain/ports.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { primaryPresentation } from "./helpers/presentation.js";

const config = {
  projects: [{ id: "bridge", displayName: "Bridge", spaceName: "herdr-lark-bridge", description: "Bridge", workspaceId: "wH", cwd: "/work/bridge" }]
} as const satisfies Pick<BridgeConfig, "projects">;

function createConverger(store: SqliteBindingStore, overrides: Partial<StartupViewConvergerOptions> = {}): StartupViewConverger {
  return new StartupViewConverger({
    config,
    stores: { startupViews: store, answerPages: store, mainCards: store },
    outbound: { enqueueCardUpdate: vi.fn() } as unknown as OutboundIntentPort,
    outboundWork: { wake: () => {}, subscribe: () => () => {} },
    presentation: primaryPresentation,
    ...overrides
  });
}

describe("StartupViewConverger", () => {
  it("recovers stale outbox quarantines before projecting views and wakes delivery", async () => {
    const store = new SqliteBindingStore(":memory:");
    const recover = vi.spyOn(store, "recoverStaleOutboxQuarantines").mockReturnValue({ retriedAnswerPromptIds: ["p1"], rolledBackAnswerPromptIds: [], dismissedNotices: 1, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
    const wake = vi.fn();

    await createConverger(store, { outboundWork: { wake, subscribe: () => () => {} } }).converge();

    expect(recover).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("reports terminalized quarantines without waking an empty outbox", async () => {
    const store = new SqliteBindingStore(":memory:");
    vi.spyOn(store, "recoverStaleOutboxQuarantines").mockReturnValue({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 2
    });
    const wake = vi.fn();
    const logger = { warn: vi.fn() };

    await createConverger(store, { outboundWork: { wake, subscribe: () => () => {} }, logger }).converge();

    expect(wake).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "startup-outbox-quarantines-recovered", terminalizedQuarantines: 2 }),
      expect.any(String)
    );
    store.close();
  });

  it("reports a superseded Answer target and wakes its released snapshot lane", async () => {
    const store = new SqliteBindingStore(":memory:");
    vi.spyOn(store, "recoverStaleOutboxQuarantines").mockReturnValue({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 1, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0
    });
    const wake = vi.fn();
    const logger = { warn: vi.fn() };

    await createConverger(store, { outboundWork: { wake, subscribe: () => () => {} }, logger }).converge();

    expect(wake).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "startup-outbox-quarantines-recovered", resolvedSupersededAnswerTargets: 1 }),
      expect.any(String)
    );
    store.close();
  });

  it("wakes a superseded Worker Main snapshot lane", async () => {
    const store = new SqliteBindingStore(":memory:");
    vi.spyOn(store, "recoverStaleOutboxQuarantines").mockReturnValue({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 1, terminalizedQuarantines: 0
    });
    const wake = vi.fn();
    const logger = { warn: vi.fn() };

    await createConverger(store, { outboundWork: { wake, subscribe: () => () => {} }, logger }).converge();

    expect(wake).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "startup-outbox-quarantines-recovered", releasedSupersededWorkerMainUpdates: 1 }),
      expect.any(String)
    );
    store.close();
  });

  it("reports rejected immutable cleanup without waking an empty outbox", async () => {
    const store = new SqliteBindingStore(":memory:");
    vi.spyOn(store, "recoverStaleOutboxQuarantines").mockReturnValue({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 2, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0
    });
    const wake = vi.fn();
    const logger = { warn: vi.fn() };

    await createConverger(store, { outboundWork: { wake, subscribe: () => () => {} }, logger }).converge();

    expect(wake).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "startup-outbox-quarantines-recovered", dismissedRejectedImmutableEffects: 2 }),
      expect.any(String)
    );
    store.close();
  });

  it("continues with later bindings when one binding view cannot converge", async () => {
    const store = new SqliteBindingStore(":memory:");
    for (const id of ["bad", "good"]) {
      store.createPendingBinding({ id, projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: id, rootMessageId: `root-${id}`, title: id });
      store.updateBinding(id, { paneId: `wH:${id}`, statusMessageId: `root-${id}`, state: "active" });
    }
    const mainCards = { project: vi.fn(async (view: { bindingId: string }) => { if (view.bindingId === "bad") throw new Error("bad view"); }) };
    const logger = { warn: vi.fn() };
    const converger = createConverger(store, { mainCardWorkflow: mainCards, logger });

    await expect(converger.converge()).resolves.toEqual(["bad"]);
    expect(mainCards.project).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "startup-view-binding-failed", bindingId: "bad" }), expect.any(String));
    store.close();
  });

  it("reprojects an existing root card using the durable binding title", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({
      id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "herdr-lark-bridge / task-ab12"
    });
    store.updateBinding("b1", { paneId: "wH:p2H", statusMessageId: "root-card", state: "active" });
    store.saveTopicView({
      ...initialTopicView("b1"), title: "HerderSwarm: 已就绪", workspaceId: "wH", spaceName: "old-space", paneId: "wH:p2H", phase: "ready"
    });
    const enqueueCardUpdate = vi.fn<OutboundIntentPort["enqueueCardUpdate"]>().mockResolvedValue(undefined);
    const outbound = { enqueueCardUpdate } as Pick<OutboundIntentPort, "enqueueCardUpdate">;
    await createConverger(store, { outbound: outbound as OutboundIntentPort }).converge();

    expect(store.loadTopicView("b1")).toMatchObject({
      title: "herdr-lark-bridge / task-ab12", spaceName: "herdr-lark-bridge", paneId: "wH:p2H"
    });
    expect(enqueueCardUpdate).not.toHaveBeenCalled();
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      kind: "card_update", bindingId: "b1", viewVersion: 1, targetRole: "session_status", workClass: "history"
    })]);
    store.close();
  });

  it("preserves unresolved legacy workspace naming when that workspace has multiple projects", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "legacy", projectId: null, workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "legacy task" });
    store.updateBinding("legacy", { paneId: "w1:p1", statusMessageId: "root-card", state: "active" });
    const enqueueCardUpdate = vi.fn<OutboundIntentPort["enqueueCardUpdate"]>().mockResolvedValue(undefined);
    const multiProjectConfig = { projects: [
      { id: "one", displayName: "One", spaceName: "one", description: "One", workspaceId: "w1", cwd: "/one" },
      { id: "two", displayName: "Two", spaceName: "two", description: "Two", workspaceId: "w1", cwd: "/two" }
    ] } as const satisfies Pick<BridgeConfig, "projects">;

    await createConverger(store, { config: multiProjectConfig, outbound: { enqueueCardUpdate } as OutboundIntentPort }).converge();

    expect(store.loadTopicView("legacy")?.spaceName).toBe("legacy/unresolved");
    store.close();
  });

  it("does not enqueue a Main Card update when its durable version is already delivered", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "task", workspaceId: "wH", spaceName: "herdr-lark-bridge", paneId: "wH:p1", phase: "ready", viewVersion: 1, deliveredVersion: 1 });

    await createConverger(store).converge();

    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.loadTopicView("b1")).toMatchObject({ viewVersion: 1, deliveredVersion: 1 });
    store.close();
  });

  it("does not replay fully delivered historical Answer cards during startup", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "renamed task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    for (let index = 0; index < 100; index += 1) {
      const promptId = `history-${index}`;
      const queued = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, sessionTitle: "old title", workspaceId: "wH", spaceName: "old-space", paneId: "wH:p1", requestText: promptId, queuePosition: 0, occurredAt: `2026-08-01T00:00:${String(index % 60).padStart(2, "0")}.000Z` });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view: queued, rootMessageId: "root", answerCard: {} });
      const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === promptId)!;
      store.markOutboundReplyDelivered(create.id, `answer-${index}`, `card-${index}`);
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase: "completed", answer: "done", answerSegments: ["done"], workerContextFrozenAt: "2026-08-01T00:01:00.000Z", viewVersion: 1, answerDeliveredVersion: 1 });
      store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = ?").run(promptId);
    }
    const enqueueCardUpdate = vi.fn<OutboundIntentPort["enqueueCardUpdate"]>();

    await createConverger(store, { outbound: { enqueueCardUpdate } as unknown as OutboundIntentPort }).converge();

    expect(enqueueCardUpdate).not.toHaveBeenCalled();
    expect(store.listPendingOutboundReplies().filter((reply) => reply.cardRole === "answer")).toEqual([]);
    expect(store.loadRunCard("history-0")).toMatchObject({ sessionTitle: "old title", spaceName: "old-space", viewVersion: 1 });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "done", activePromptId: null });
    store.close();
  });

  it("does not visit a terminal binding whose Main and Answer views are fully delivered", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "historical", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "history" });
    store.updateBinding("historical", { paneId: "wH:p1", statusMessageId: "root", state: "archived", lifecycle: "archived", attachment: "unattached" });
    store.saveTopicView({ ...initialTopicView("historical"), title: "history", workspaceId: "wH", spaceName: "herdr-lark-bridge", paneId: "wH:p1", phase: "done", viewVersion: 1, deliveredVersion: 1 });
    const queued = createQueuedRunCard({ promptId: "done", bindingId: "historical", title: "done", workspaceId: "wH", paneId: "wH:p1", requestText: "done", queuePosition: 0, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "done", bindingId: "historical", larkMessageId: "message-done", actorOpenId: "u1", body: "done" }, view: queued, rootMessageId: "root", answerCard: {} });
    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "answer", "card");
    store.saveRunCard({ ...store.loadRunCard("done")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 1, answerDeliveredVersion: 1 });
    store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'done'").run();
    const mainCards = { project: vi.fn(async () => undefined) };

    await createConverger(store, { mainCardWorkflow: mainCards }).converge();

    expect(mainCards.project).not.toHaveBeenCalled();
    store.close();
  });

  it("keeps a terminal binding in the startup read model while durable delivery is pending", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "pending-view", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "pending" });
    store.updateBinding("pending-view", { statusMessageId: "root", state: "archived", lifecycle: "archived", attachment: "unattached" });
    store.saveTopicView({ ...initialTopicView("pending-view"), title: "pending", workspaceId: "wH", spaceName: "herdr-lark-bridge", phase: "done", viewVersion: 2, deliveredVersion: 1 });
    const mainCards = { project: vi.fn(async () => undefined) };

    await createConverger(store, { mainCardWorkflow: mainCards }).convergeBindings(["absent", "pending-view"]);

    expect(mainCards.project).toHaveBeenCalledOnce();
    expect(mainCards.project).toHaveBeenCalledWith(expect.objectContaining({ bindingId: "pending-view" }), "history");
    store.close();
  });

  it("restores the running prompt instead of a newer completed card", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "task", workspaceId: "wH", paneId: "wH:p1", phase: "done", agentState: "done", activePromptId: null });
    const parent = createQueuedRunCard({ promptId: "parent", bindingId: "b1", title: "parent", workspaceId: "wH", paneId: "wH:p1", requestText: "work", queuePosition: 0, occurredAt: "2026-08-28T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "parent-message", actorOpenId: "u1", body: "work" }, view: { ...parent, phase: "running" }, rootMessageId: "root", answerCard: {} });
    const completed = createQueuedRunCard({ promptId: "completed", bindingId: "b1", title: "completed", workspaceId: "wH", paneId: "wH:p1", requestText: "more", queuePosition: 0, occurredAt: "2026-08-28T00:01:00Z" });
    store.acceptPrompt({ prompt: { id: "completed", bindingId: "b1", larkMessageId: "completed-message", actorOpenId: "u1", body: "more" }, view: { ...completed, phase: "completed" }, rootMessageId: "root", answerCard: {} });

    await createConverger(store).converge();

    expect(store.loadTopicView("b1")).toMatchObject({ phase: "running", agentState: "working", activePromptId: "parent" });
    store.close();
  });

  it("rebuilds missing terminal stream intents from a durable completed run card", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "work", workspaceId: "wH", paneId: "wH:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "request", actorOpenId: "u1", body: "go" }, view: queued, rootMessageId: "root", answerCard: {} });
    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "answer-message", "answer-card");
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "durable answer", answerSegments: ["durable answer"], viewVersion: 3, answerDeliveredVersion: 1 });
    const outbound = { enqueueCardUpdate: vi.fn() } as unknown as OutboundIntentPort;

    await createConverger(store, { outbound }).converge();

    const pending = store.listPendingOutboundReplies();
    const answer = pending.find((reply) => reply.promptId === "p1");
    expect(answer).toMatchObject({ kind: "stream_content", promptId: "p1", rootMessageId: "answer-card", viewVersion: 1, workClass: "history" });
    expect(JSON.parse(answer!.payload)).toMatchObject({ content: expect.stringContaining("durable answer"), sequence: 1, pageIndex: 0 });
    expect(pending).toContainEqual(expect.objectContaining({ kind: "card_update", bindingId: "b1", targetRole: "session_status", workClass: "history" }));
    store.close();
  });

  it("backfills the binding title on legacy Run Cards", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "herdr-lark-bridge / task-ab12" });
    store.updateBinding("b1", { paneId: "wH:p1", statusMessageId: "root", state: "active" });
    const legacy = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "work", workspaceId: "wH", spaceName: "herdr-lark-bridge", paneId: "wH:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "request", actorOpenId: "u1", body: "go" }, view: legacy, rootMessageId: "root", answerCard: {} });

    await createConverger(store).converge();

    expect(store.loadRunCard("p1")).toMatchObject({ sessionTitle: "herdr-lark-bridge / task-ab12", viewVersion: 2 });
    const answerCreate = store.listPendingOutboundReplies().find((reply) => reply.promptId === "p1" && reply.kind === "stream_card_create");
    expect(JSON.parse(answerCreate!.payload)).toMatchObject({ header: { subtitle: { content: "herdr-lark-bridge / task-ab12 · work" } } });
    store.close();
  });
});
