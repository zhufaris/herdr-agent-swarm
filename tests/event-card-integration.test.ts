import pino from "pino";
import { describe, expect, it } from "vitest";
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
    expect(JSON.stringify(latestPrimary.card)).not.toContain("更新主卡片");
    expect(updates.some((update) => update.messageId === "request-task-card" && JSON.stringify(update.card).includes("等待用户处理") && !JSON.stringify(update.card).includes("live answer"))).toBe(true);
    expect(updates.some((update) => update.messageId === "request-answer-card" && JSON.stringify(update.card).includes("live answer") && !JSON.stringify(update.card).includes("Do work"))).toBe(true);

    stopProjector(); stopPublisher(); store.close();
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
});
