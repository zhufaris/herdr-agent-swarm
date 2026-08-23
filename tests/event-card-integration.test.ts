import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardProjector } from "../src/events/card-projector.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";

describe("event-driven card projection", () => {
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
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stop = new CardProjector(bus, store, publisher, pino({ enabled: false })).start();

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
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; },
      async replyCard() { return { messageId: "request-card" }; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "primary-card", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", statusMessageId: "primary-card" });
    const request = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Do work", workspaceId: "w1", paneId: "w1:p1", requestText: "Do work", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-message", actorOpenId: "u1", body: "Do work" }, view: request, rootMessageId: "primary-card", taskCard: {}, answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) {
      store.markOutboundReplyDelivered(reply.id, reply.cardRole === "task" ? "request-task-card" : "request-answer-card");
    }
    store.saveTopicView({ ...initialTopicView("b1"), title: "repo / task", workspaceId: "w1", paneId: "w1:p1", phase: "done" });
    store.listBindings = () => { throw new Error("CardProjector must use point binding lookup"); };
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false }));
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
    expect(updates.some((update) => {
      if (update.messageId !== "request-answer-card") return false;
      const serialized = JSON.stringify(update.card);
      return serialized.includes("live answer") && serialized.includes("TraeX 需要人工审批");
    })).toBe(true);

    stopProjector(); stopPublisher(); store.close();
  });

  it("updates the same answer card with the accumulated live message window", async () => {
    vi.useFakeTimers();
    const updates: Array<{ messageId: string; card: object }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; },
      async replyCard() { return { messageId: "request-card" }; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "primary-card", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", statusMessageId: "primary-card" });
    const request = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Do work", workspaceId: "w1", paneId: "w1:p1", requestText: "Do work", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-message", actorOpenId: "u1", body: "Do work" }, view: request, rootMessageId: "primary-card", taskCard: {}, answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, reply.cardRole === "task" ? "request-task-card" : "request-answer-card");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false }));
    const stopProjector = projector.start();

    await bus.publish({ eventId: "start", bindingId: "b1", type: "TurnStarted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", queueDepth: 1 } });
    await bus.publish({ eventId: "first", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:01Z", payload: { promptId: "p1", answerSnapshot: "第一条", answerUpdate: "replace", progressEvents: [] } });
    await bus.publish({ eventId: "first-grown", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:02Z", payload: { promptId: "p1", answerSnapshot: "第一条中间消息。", answerUpdate: "replace", progressEvents: [] } });
    await bus.publish({ eventId: "second", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:03Z", payload: { promptId: "p1", answerSnapshot: "第二条", answerUpdate: "append", progressEvents: [] } });
    await bus.publish({ eventId: "second-grown", bindingId: "b1", type: "TurnOutputObserved", origin: "herdr", occurredAt: "2026-08-22T00:01:04Z", payload: { promptId: "p1", answerSnapshot: "第二条中间消息。", answerUpdate: "replace", progressEvents: [] } });
    await vi.advanceTimersByTimeAsync(2_000);
    await publisher.drain();

    const answerUpdates = updates.filter((update) => update.messageId === "request-answer-card");
    expect(answerUpdates.length).toBeGreaterThan(0);
    const latest = JSON.stringify(answerUpdates.at(-1)!.card);
    expect(latest).toContain("第一条中间消息。");
    expect(latest).toContain("第二条中间消息。");
    expect(store.loadRunCard("p1")).toMatchObject({ answerSegments: ["第一条中间消息。"], answerDraft: "第二条中间消息。" });
    expect(new Set(answerUpdates.map((update) => update.messageId))).toEqual(new Set(["request-answer-card"]));

    stopProjector(); stopPublisher(); store.close(); vi.useRealTimers();
  });

  it("finalizes a full answer card and continues streaming on a persisted continuation card", async () => {
    const created: object[] = [];
    const streamed: Array<{ cardId: string; elementId: string; content: string; sequence: number }> = [];
    const finished: Array<{ cardId: string; sequence: number; summary: string }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "legacy" }; }, async updateCard() {},
      async replyStreamingCard(_rootMessageId, card) { created.push(card); const number = created.length; return { messageId: `answer-${number}`, cardId: `cardkit-${number}` }; },
      async streamCardContent(cardId, elementId, content, sequence) { streamed.push({ cardId, elementId, content, sequence }); },
      async finishStreamingCard(cardId, sequence, summary) { finished.push({ cardId, sequence, summary }); }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-22T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.listBindings = () => { throw new Error("CardProjector must use point binding lookup"); };
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
    await publisher.drain();

    const answer = `${"a".repeat(20_000)}\n${"b".repeat(12_000)}`;
    await bus.publish({ eventId: "done", bindingId: "b1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-08-22T00:01:00Z", payload: { promptId: "p1", answer, queueDepth: 0 } });
    await vi.waitFor(() => expect(finished).toHaveLength(2));

    expect(created).toHaveLength(2);
    expect(streamed.map(({ cardId, elementId, content }) => ({ cardId, elementId, content }))).toEqual([
      { cardId: "cardkit-1", elementId: "answer_content_p1_0", content: `⏳ 已接收请求\n\n${"a".repeat(20_000)}` },
      { cardId: "cardkit-2", elementId: "answer_content_p1_1", content: "b".repeat(12_000) }
    ]);
    expect(finished.map(({ cardId, summary }) => ({ cardId, summary }))).toEqual([
      { cardId: "cardkit-1", summary: "Continued on part 2" }, { cardId: "cardkit-2", summary: "Completed" }
    ]);
    expect(JSON.stringify(created[1])).toContain("HERDR ANSWER · 续 2");
    expect(store.loadRunCard("p1")).toMatchObject({ answerCardId: "cardkit-2", answerMessageId: "answer-2", answerPageIndex: 1, answerPageStart: 20_010, answerElementId: "answer_content_p1_1" });

    await projector.stop(); await publisher.stop(); store.close();
  });

  it("waits for an in-flight card update before stopping", async () => {
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
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false }));
    projector.start();

    const publishing = bus.publish({ eventId: "e-stop", bindingId: "b1", type: "BindingCreated", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Task", workspaceId: "w1", paneId: "w1:p2" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let stopped = false;
    const stopping = projector.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);

    releaseUpdate();
    await Promise.all([publishing, stopping]);

    expect(updated).toBe(true);
    await expect(projector.stop()).resolves.toBeUndefined();
    await publisher.stop();
    store.close();
  });

  it("projects concurrent events for one binding in publication order", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const updates: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text1" }; }, async replyCard() { return { messageId: "card1" }; },
      async updateCard(_messageId, card) {
        const value = JSON.stringify(card);
        if (value.includes("First")) await firstBlocked;
        updates.push(value);
      }
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p2", state: "active", statusMessageId: "card1" });
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();

    const first = bus.publish({ eventId: "first", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "First" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = bus.publish({ eventId: "second", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:01Z", payload: { title: "Second" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.loadTopicView("b1")?.title).toBe("First");

    releaseFirst();
    await Promise.all([first, second]);
    expect(store.loadTopicView("b1")?.title).toBe("Second");
    expect(updates.map((value) => value.includes("First") ? "First" : "Second")).toEqual(["First", "Second"]);
    await projector.stop(); await publisher.stop(); store.close();
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
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();

    await expect(bus.publish({ eventId: "failed", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Failed" } })).rejects.toThrow("projection failed");
    expect(store.loadTopicView("b1")).toBeNull();
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
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();

    const first = bus.publish({ eventId: "first", bindingId: "b1", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload: { title: "Blocked" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = bus.publish({ eventId: "second", bindingId: "b2", type: "BindingRenamed", origin: "bridge", occurredAt: "2026-08-22T00:00:01Z", payload: { title: "Independent" } });
    await vi.waitFor(() => expect(store.loadTopicView("b2")?.title).toBe("Independent"));
    releaseFirst();
    await Promise.all([first, second]);
    await projector.stop(); await publisher.stop(); store.close();
  });
});
