import pino from "pino";
import { describe, expect, it } from "vitest";
import type { LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardProjector } from "../src/events/card-projector.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

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
    expect(JSON.stringify(updates.at(-1))).toContain("Finished");
    stop(); stopPublisher(); store.close();
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
