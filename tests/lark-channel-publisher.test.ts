import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("Lark channel publisher", () => {
  it("keeps a failed card pending and delivers it during a later drain", async () => {
    let fail = true;
    const cards: object[] = [];
    const lark = fakeLark({ async replyCard(_root, card) { if (fail) throw new Error("temporary"); cards.push(card); return { messageId: "card-1" }; } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, lark, pino({ enabled: false }));
    publisher.start();

    await publisher.enqueueCard("root-1", "standalone:1", { schema: "2.0" });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    fail = false;
    await publisher.drain(true);
    expect(cards).toEqual([{ schema: "2.0" }]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    await publisher.stop(); store.close();
  });

  it("logs retry and dead-letter decisions without card payloads", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const debug = vi.fn();
    const logger = { warn, error, debug } as unknown as Logger;
    const lark = fakeLark({ async replyCard() { throw new Error("network unavailable"); } });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, lark, logger);

    await publisher.enqueueCard("root-1", "failure:1", { secret: "private card payload" }, "b1");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "lark-outbox-retry-scheduled", replyKind: "card_reply", attempt: 1, outcome: "retry" }), expect.any(String));
    for (let attempt = 0; attempt < 4; attempt += 1) await publisher.drain(true);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "lark-outbox-dead-lettered", attempt: 5, outcome: "dead_letter" }), expect.any(String));
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain("private card payload");
    expect(store.getOperationalSummary()).toMatchObject({ deadLetters: 1, pendingOutbox: 0 });
    store.close();
  });

  it("waits for an in-flight card delivery before stopping", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let delivered = false;
    const lark = fakeLark({ async replyCard() { await gate; delivered = true; return { messageId: "card-1" }; } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, lark, pino({ enabled: false }));
    publisher.start();
    const publishing = publisher.enqueueCard("root-1", "standalone:stop", { schema: "2.0" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let stopped = false;
    const stopping = publisher.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
    release();
    await Promise.all([publishing, stopping]);
    expect(delivered).toBe(true);
    store.close();
  });

  it("delivers successive versions to the same request card", async () => {
    const versions: string[] = [];
    const lark = fakeLark({ async updateCard(_messageId, card) { versions.push(JSON.stringify(card)); } });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, lark, pino({ enabled: false }));
    await publisher.enqueueRunCardUpdate("b1", "p1", "card-1", 2, { version: 2 });
    await publisher.enqueueRunCardUpdate("b1", "p1", "card-1", 3, { version: 3 });
    expect(versions).toEqual([JSON.stringify({ version: 2 }), JSON.stringify({ version: 3 })]);
    store.close();
  });

  it("supersedes an older failed pending version with the latest view", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.enqueueOutboundReply({ id: "old", idempotencyKey: "run-card:update:p1:2", bindingId: "b1", promptId: "p1", viewVersion: 2, rootMessageId: "card-1", kind: "card_update", payload: "old" });
    store.markOutboundReplyFailed("old", "temporary");
    store.enqueueOutboundReply({ id: "new", idempotencyKey: "run-card:update:p1:3", bindingId: "b1", promptId: "p1", viewVersion: 3, rootMessageId: "card-1", kind: "card_update", payload: "new" });
    expect(store.listPendingOutboundReplies()).toMatchObject([{ id: "new", viewVersion: 3, payload: "new" }]);
    store.close();
  });
});

function fakeLark(overrides: Partial<LarkPort>): LarkPort {
  return {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
    async replyText() { return { messageId: "text-1" }; },
    async replyCard() { return { messageId: "card-1" }; },
    async updateCard() {}, ...overrides
  };
}
