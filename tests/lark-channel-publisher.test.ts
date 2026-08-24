import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { answerElementId, createQueuedRunCard } from "../src/domain/run-card-view.js";

describe("Lark channel publisher", () => {
  it("creates one CardKit answer and streams cumulative content without patching the message", async () => {
    const create = vi.fn(async () => ({ messageId: "answer-1", cardId: "cardkit-1" }));
    const stream = vi.fn(async () => {});
    const updateCard = vi.fn(async () => {});
    const lark = fakeLark({ replyStreamingCard: create, streamCardContent: stream, updateCard });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, lark, pino({ enabled: false }));
    await publisher.drain();
    await publisher.enqueueStreamContent("b1", "p1", "cardkit-1", answerElementId("p1", 0), "Working\nDone", 2);

    expect(create).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledWith("cardkit-1", answerElementId("p1", 0), "Working\nDone", 2);
    expect(updateCard).not.toHaveBeenCalled();
    store.close();
  });

  it("rejects a stream target belonging to another prompt", async () => {
    const stream = vi.fn(async () => {});
    const lark = fakeLark({ streamCardContent: stream });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const first = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "First", workspaceId: "w1", paneId: "w1:p1", requestText: "first", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "first" }, view: first, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    const second = createQueuedRunCard({ promptId: "p2", bindingId: "b1", title: "Second", workspaceId: "w1", paneId: "w1:p1", requestText: "second", queuePosition: 1, occurredAt: "later" });
    store.acceptPrompt({ prompt: { id: "p2", bindingId: "b1", larkMessageId: "user-2", actorOpenId: "u1", body: "second" }, view: second, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) { if (reply.promptId === "p2") store.markOutboundReplyDelivered(reply.id, "answer-2", "cardkit-2"); }
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, lark, pino({ enabled: false }));

    await expect(publisher.enqueueStreamContent("b1", "p2", "cardkit-1", "answer-content-p1-0", "wrong target", 2)).rejects.toThrow(/target mismatch/);
    expect(stream).not.toHaveBeenCalled();
    store.close();
  });

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

  it("signals the projector after a continuation card succeeds on retry", async () => {
    let fail = true;
    const created = vi.fn(async () => {
      if (fail) throw new Error("temporary");
      return { messageId: "answer-2", cardId: "cardkit-2" };
    });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, fakeLark({ replyStreamingCard: created }), pino({ enabled: false }));
    const resumed = vi.fn();
    publisher.onStreamCardCreated(resumed);
    store.enqueueOutboundReply({
      id: "page-2", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 7, cardRole: "answer",
      rootMessageId: "root-1", kind: "stream_card_create",
      payload: JSON.stringify({ card: { schema: "2.0" }, stream: { pageIndex: 1, pageStart: 28_000, elementId: "answer_content_p1_1" } })
    });

    await publisher.drain();
    expect(resumed).not.toHaveBeenCalled();
    fail = false;
    await publisher.drain(true);

    expect(created).toHaveBeenCalledTimes(2);
    expect(resumed).toHaveBeenCalledWith("p1", 8);
    store.close();
  });

  it("dead-letters a stale continuation create without calling Lark or retrying", async () => {
    const create = vi.fn(async () => ({ messageId: "answer-2", cardId: "cardkit-2" }));
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    store.enqueueOutboundReply({ id: "stale-page", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "root-1", kind: "stream_card_create", payload: JSON.stringify({ card: {}, stream: { pageIndex: 2, pageStart: 20_000, elementId: answerElementId("p1", 2) } }) });
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, fakeLark({ replyStreamingCard: create }), pino({ enabled: false }));

    await publisher.drain();

    expect(create).not.toHaveBeenCalled();
    expect(store.getOperationalSummary().deadLetters).toBe(1);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.loadRunCard("p1")).toMatchObject({ answerCardId: "cardkit-1", answerPageIndex: 0 });
    store.close();
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

  it("does not serialize Axios request details into delivery failure logs", async () => {
    const warn = vi.fn();
    const logger = { warn, error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const failure = Object.assign(new Error("Request failed with status code 400"), {
      code: "ERR_BAD_REQUEST",
      config: { headers: { Authorization: "Bearer top-secret" }, data: "private card payload" },
      request: { _header: "Authorization: Bearer top-secret" },
      response: { status: 400, data: { code: 230099, msg: "card action is lock", private: "response body" } }
    });
    const lark = fakeLark({ async updateCard() { throw failure; } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, lark, logger);

    await publisher.enqueueCardUpdate(null, "card-1", "failure:safe-error", { secret: "private card payload" });

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "lark-outbox-retry-scheduled",
      err: { name: "Error", message: "Request failed with status code 400", code: "ERR_BAD_REQUEST", status: 400, larkCode: 230099 }
    }), expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/top-secret|private card payload|response body|Authorization|config|request|response/);
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
    await publisher.enqueueRunCardUpdate("b1", "p1", "card-1", 2, "task", { version: 2 });
    await publisher.enqueueRunCardUpdate("b1", "p1", "card-1", 3, "task", { version: 3 });
    expect(versions).toEqual([JSON.stringify({ version: 2 }), JSON.stringify({ version: 3 })]);
    store.close();
  });

  it("delivers independent targets concurrently", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const delivered: string[] = [];
    const lark = fakeLark({
      async updateCard(messageId) {
        if (messageId === "slow-card") await slowGate;
        delivered.push(messageId);
      }
    });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, lark, pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "slow", idempotencyKey: "card-update:slow", rootMessageId: "slow-card", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "fast", idempotencyKey: "card-update:fast", rootMessageId: "fast-card", kind: "card_update", payload: "{}" });

    const draining = publisher.drain();
    await vi.waitFor(() => expect(delivered).toEqual(["fast-card"]));
    releaseSlow();
    await draining;

    expect(delivered).toEqual(["fast-card", "slow-card"]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    store.close();
  });

  it("keeps updates for the same target ordered while other targets progress", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const delivered: string[] = [];
    const lark = fakeLark({
      async updateCard(messageId, card) {
        const marker = `${messageId}:${(card as { version: number }).version}`;
        if (marker === "same-card:1") await firstGate;
        delivered.push(marker);
      }
    });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkChannelPublisher(new BridgeEventBus(), store, lark, pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "same-1", idempotencyKey: "card-update:same:1", rootMessageId: "same-card", kind: "card_update", payload: JSON.stringify({ version: 1 }) });
    store.enqueueOutboundReply({ id: "same-2", idempotencyKey: "card-update:same:2", rootMessageId: "same-card", kind: "card_update", payload: JSON.stringify({ version: 2 }) });
    store.enqueueOutboundReply({ id: "other", idempotencyKey: "card-update:other", rootMessageId: "other-card", kind: "card_update", payload: JSON.stringify({ version: 1 }) });

    const draining = publisher.drain();
    await vi.waitFor(() => expect(delivered).toEqual(["other-card:1"]));
    releaseFirst();
    await draining;

    expect(delivered).toEqual(["other-card:1", "same-card:1", "same-card:2"]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    store.close();
  });

  it("supersedes an older failed pending version with the latest view", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.enqueueOutboundReply({ id: "old", idempotencyKey: "run-card:update:p1:task:2", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "task", rootMessageId: "card-1", kind: "card_update", payload: "old" });
    store.markOutboundReplyFailed("old", "temporary");
    store.enqueueOutboundReply({ id: "new", idempotencyKey: "run-card:update:p1:task:3", bindingId: "b1", promptId: "p1", viewVersion: 3, cardRole: "task", rootMessageId: "card-1", kind: "card_update", payload: "new" });
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
