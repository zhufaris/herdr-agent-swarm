import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { LarkPort, OutboundIntentPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { LarkOutboxDispatcher } from "../src/events/lark-outbox-dispatcher.js";
import { OutboundIntentWriter } from "../src/events/outbound-intent-writer.js";
import { InProcessOutboundWorkNotifier } from "../src/events/outbound-work-notifier.js";
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
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    await publisher.requestScan();
    await connectedWriter(store, publisher).enqueueStreamContent("b1", "p1", "cardkit-1", answerElementId("p1", 0), "Working\nDone", 2);

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
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));

    await expect(connectedWriter(store, publisher).enqueueStreamContent("b1", "p2", "cardkit-1", "answer-content-p1-0", "wrong target", 2)).rejects.toThrow(/target mismatch/);
    expect(stream).not.toHaveBeenCalled();
    store.close();
  });

  it("keeps a failed card pending and delivers it during a later drain", async () => {
    let fail = true;
    const cards: object[] = [];
    const lark = fakeLark({ async replyCard(_root, card) { if (fail) throw new Error("temporary"); cards.push(card); return { messageId: "card-1" }; } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    publisher.start();

    await connectedWriter(store, publisher).enqueueCard("root-1", "standalone:1", { schema: "2.0" });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    fail = false;
    await publisher.requestScan(true);
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
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyStreamingCard: created }), pino({ enabled: false }));
    const resumed = vi.fn();
    publisher.onStreamCardCreated(resumed);
    store.enqueueOutboundReply({
      id: "page-2", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 7, cardRole: "answer",
      rootMessageId: "root-1", kind: "stream_card_create",
      payload: JSON.stringify({ card: { schema: "2.0", body: { elements: [{ element_id: answerElementId("p1", 1) }] } }, stream: { pageIndex: 1, pageStart: 28_000, elementId: answerElementId("p1", 1) } })
    });

    await publisher.requestScan();
    expect(resumed).not.toHaveBeenCalled();
    fail = false;
    await publisher.requestScan(true);

    expect(created).toHaveBeenCalledTimes(2);
    expect(resumed).toHaveBeenCalledWith("p1", 8);
    store.close();
  });

  it("reuses a checkpointed CardKit entity when replying is retried", async () => {
    let failReply = true;
    const create = vi.fn(async () => ({ cardId: "cardkit-1" }));
    const reply = vi.fn(async (_root: string, cardId: string, idempotencyKey: string) => {
      if (failReply) throw new Error("temporary");
      return { messageId: `message-for-${cardId}-${idempotencyKey}` };
    });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ createStreamingCard: create, replyStreamingCardReference: reply }), pino({ enabled: false }));

    await publisher.requestScan();
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.listPendingOutboundReplies()[0]).toMatchObject({ cardIdCheckpoint: "cardkit-1" });
    failReply = false;
    await publisher.requestScan(true);

    expect(create).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenLastCalledWith("root-1", "cardkit-1", "run-card:create:p1:answer");
    expect(store.loadRunCard("p1")).toMatchObject({ answerMessageId: "message-for-cardkit-1-run-card:create:p1:answer", answerCardId: "cardkit-1" });
    store.close();
  });

  it("uses one logical message when the first idempotent reply times out after remote acceptance", async () => {
    const logicalMessages = new Map<string, string>();
    let firstAttempt = true;
    const reply = vi.fn(async (_root: string, _cardId: string, idempotencyKey: string) => {
      const messageId = logicalMessages.get(idempotencyKey) ?? `message-${logicalMessages.size + 1}`;
      logicalMessages.set(idempotencyKey, messageId);
      if (firstAttempt) { firstAttempt = false; throw new Error("timeout after acceptance"); }
      return { messageId };
    });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async createStreamingCard() { return { cardId: "cardkit-1" }; },
      replyStreamingCardReference: reply
    }), pino({ enabled: false }));

    await publisher.requestScan();
    await publisher.requestScan(true);

    expect(reply.mock.calls.map((call) => call[2])).toEqual(["run-card:create:p1:answer", "run-card:create:p1:answer"]);
    expect(logicalMessages).toEqual(new Map([["run-card:create:p1:answer", "message-1"]]));
    expect(store.loadRunCard("p1")).toMatchObject({ answerMessageId: "message-1", answerCardId: "cardkit-1" });
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
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyStreamingCard: create }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(create).not.toHaveBeenCalled();
    expect(store.getOperationalSummary().deadLetters).toBe(1);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.loadRunCard("p1")).toMatchObject({ answerCardId: "cardkit-1", answerPageIndex: 0 });
    store.close();
  });

  it.each([
    { name: "non-derived metadata id", metadataId: "element_wrong", cardId: "element_wrong" },
    { name: "card id differing from metadata", metadataId: answerElementId("p1", 1), cardId: "element_wrong" }
  ])("dead-letters a continuation with $name", async ({ metadataId, cardId }) => {
    const create = vi.fn(async () => ({ messageId: "answer-2", cardId: "cardkit-2" }));
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Long answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    store.enqueueOutboundReply({
      id: "invalid-page", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "root-1", kind: "stream_card_create",
      payload: JSON.stringify({ card: { body: { elements: [{ element_id: cardId }] } }, stream: { pageIndex: 1, pageStart: 20_000, elementId: metadataId } })
    });
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyStreamingCard: create }), pino({ enabled: false }));

    await publisher.requestScan();

    expect(create).not.toHaveBeenCalled();
    expect(store.getOperationalSummary().deadLetters).toBe(1);
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
    const publisher = new LarkOutboxDispatcher(store, lark, logger);

    await connectedWriter(store, publisher).enqueueCard("root-1", "failure:1", { secret: "private card payload" }, "b1");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "lark-outbox-retry-scheduled", replyKind: "card_reply", attempt: 1, outcome: "retry" }), expect.any(String));
    for (let attempt = 0; attempt < 4; attempt += 1) await publisher.requestScan(true);
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
    const publisher = new LarkOutboxDispatcher(store, lark, logger);

    await connectedWriter(store, publisher).enqueueCardUpdate(null, "card-1", "failure:safe-error", { secret: "private card payload" });

    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "lark-outbox-retry-scheduled",
      err: { name: "Error", message: "Request failed with status code 400", code: "ERR_BAD_REQUEST", status: 400, larkCode: 230099 }
    }), expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/top-secret|private card payload|response body|Authorization|config|request|response/);
    await publisher.stop();
    store.close();
  });

  it("waits for an in-flight card delivery before stopping", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => { started = resolve; });
    let delivered = false;
    const lark = fakeLark({ async replyCard() { started(); await gate; delivered = true; return { messageId: "card-1" }; } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    publisher.start();
    const publishing = connectedWriter(store, publisher).enqueueCard("root-1", "standalone:stop", { schema: "2.0" });
    await deliveryStarted;
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
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    await connectedWriter(store, publisher).enqueueRunCardUpdate("b1", "p1", "card-1", 2, "task", { version: 2 });
    await connectedWriter(store, publisher).enqueueRunCardUpdate("b1", "p1", "card-1", 3, "task", { version: 3 });
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
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "slow", idempotencyKey: "card-update:slow", rootMessageId: "slow-card", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "fast", idempotencyKey: "card-update:fast", rootMessageId: "fast-card", kind: "card_update", payload: "{}" });

    const draining = publisher.requestScan();
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
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    store.enqueueOutboundReply({ id: "same-1", idempotencyKey: "card-update:same:1", rootMessageId: "same-card", kind: "card_update", payload: JSON.stringify({ version: 1 }) });
    store.enqueueOutboundReply({ id: "same-2", idempotencyKey: "card-update:same:2", rootMessageId: "same-card", kind: "card_update", payload: JSON.stringify({ version: 2 }) });
    store.enqueueOutboundReply({ id: "other", idempotencyKey: "card-update:other", rootMessageId: "other-card", kind: "card_update", payload: JSON.stringify({ version: 1 }) });

    const draining = publisher.requestScan();
    await vi.waitFor(() => expect(delivered).toEqual(["other-card:1"]));
    releaseFirst();
    await draining;

    expect(delivered).toEqual(["other-card:1", "same-card:1", "same-card:2"]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    store.close();
  });

  it("keeps a backed-off Answer lane head ahead of later finish work", async () => {
    let failContent = true;
    const delivered: string[] = [];
    const lark = fakeLark({
      async streamCardContent() {
        if (failContent) throw new Error("temporary");
        delivered.push("content");
      },
      async finishStreamingCard() { delivered.push("finish"); }
    });
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueStreamContent("b1", "p1", "cardkit-1", answerElementId("p1", 0), "content", 2);
    await connectedWriter(store, publisher).enqueueStreamFinish("b1", "p1", "cardkit-1", "Completed", 3);

    expect(delivered).toEqual([]);
    failContent = false;
    await publisher.requestScan(true);
    expect(delivered).toEqual(["content", "finish"]);
    store.close();
  });

  it("preserves Answer lane ordering after the store is reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-answer-lane-restart-"));
    const path = join(directory, "bridge.db");
    let store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "cardkit-1");
    store.enqueueOutboundReply({ id: "content", idempotencyKey: "content", bindingId: "b1", promptId: "p1", cardRole: "answer", rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ elementId: answerElementId("p1", 0), content: "done", sequence: 2 }) });
    store.enqueueOutboundReply({ id: "finish", idempotencyKey: "finish", bindingId: "b1", promptId: "p1", cardRole: "answer", rootMessageId: "cardkit-1", kind: "stream_finish", payload: JSON.stringify({ summary: "Done", sequence: 3 }) });
    store.markOutboundReplyFailed("content", "temporary", 60_000);
    store.close();

    store = new SqliteBindingStore(path);
    const delivered: string[] = [];
    const publisher = new LarkOutboxDispatcher(store, fakeLark({
      async streamCardContent() { delivered.push("content"); },
      async finishStreamingCard() { delivered.push("finish"); }
    }), pino({ enabled: false }));
    await publisher.requestScan();
    expect(delivered).toEqual([]);
    await publisher.requestScan(true);
    expect(delivered).toEqual(["content", "finish"]);
    await publisher.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("bounds delivery concurrency across independent targets", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const lark = fakeLark({ async updateCard() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    for (let index = 0; index < 10; index += 1) {
      store.enqueueOutboundReply({ id: `reply-${index}`, idempotencyKey: `reply-${index}`, rootMessageId: `card-${index}`, kind: "card_update", payload: "{}" });
    }

    const draining = publisher.requestScan();
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(peak).toBe(4);
    while (store.listPendingOutboundReplies().length > 0 || active > 0) {
      const release = releases.shift();
      if (release) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await draining;

    expect(peak).toBe(4);
    store.close();
  });

  it("automatically wakes a backed-off delivery when it becomes due", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const lark = fakeLark({ async replyCard() {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary");
      return { messageId: "card-1" };
    } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueCard("root-1", "automatic-retry", {});
    expect(attempt).toBe(1);
    await vi.advanceTimersByTimeAsync(1_300);
    await vi.waitFor(() => expect(attempt).toBe(2));
    expect(store.listPendingOutboundReplies()).toEqual([]);

    await publisher.stop();
    store.close();
    vi.useRealTimers();
  });

  it.each([
    { header: "5", delay: 5_000 },
    { header: "Sun, 24 Aug 2026 00:00:09 GMT", delay: 9_000 },
    { header: { get: () => "7" }, delay: 7_000 }
  ])("honors HTTP 429 Retry-After $header", async ({ header, delay }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    const headers = typeof header === "object" ? header : { "retry-after": header };
    const error = Object.assign(new Error("rate limited"), { response: { status: 429, headers } });
    const lark = fakeLark({ async replyCard() { throw error; } });
    const store = new SqliteBindingStore(":memory:");
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));

    await connectedWriter(store, publisher).enqueueCard("root-1", `rate-limit-${header}`, {});

    expect(store.listPendingOutboundReplies()[0]?.nextAttemptAt).toBe(new Date(Date.now() + delay).toISOString());
    await publisher.stop();
    store.close();
    vi.useRealTimers();
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

  it("delivers durable work found during startup without a new wake-up", async () => {
    const delivered = vi.fn(async () => ({ messageId: "card-1" }));
    const store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "before-start", idempotencyKey: "before-start", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    const work = new InProcessOutboundWorkNotifier();
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard: delivered }), pino({ enabled: false }), work);

    publisher.start();
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));

    await publisher.stop();
    store.close();
  });

  it("discovers durable work on the safety scan after a lost wake-up", async () => {
    vi.useFakeTimers();
    const delivered = vi.fn(async () => ({ messageId: "card-1" }));
    const store = new SqliteBindingStore(":memory:");
    const work = new InProcessOutboundWorkNotifier();
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard: delivered }), pino({ enabled: false }), work, 100);
    publisher.start();
    await publisher.requestScan();
    store.enqueueOutboundReply({ id: "lost-wake", idempotencyKey: "lost-wake", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));

    await publisher.stop();
    store.close();
    vi.useRealTimers();
  });

  it("coalesces duplicate wake-ups and ignores wake-ups after stop", async () => {
    const delivered = vi.fn(async () => ({ messageId: "card-1" }));
    const store = new SqliteBindingStore(":memory:");
    const work = new InProcessOutboundWorkNotifier();
    const publisher = new LarkOutboxDispatcher(store, fakeLark({ replyCard: delivered }), pino({ enabled: false }), work);
    publisher.start();
    await publisher.requestScan();
    store.enqueueOutboundReply({ id: "duplicate-wake", idempotencyKey: "duplicate-wake", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });

    work.wake(); work.wake(); work.wake();
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
    await publisher.stop();
    store.enqueueOutboundReply({ id: "after-stop", idempotencyKey: "after-stop", rootMessageId: "root-2", kind: "card_reply", payload: "{}" });
    work.wake();
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(delivered).toHaveBeenCalledTimes(1);
    expect(store.listPendingOutboundReplies()).toMatchObject([{ id: "after-stop" }]);
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

function connectedWriter(store: SqliteBindingStore, dispatcher: LarkOutboxDispatcher): OutboundIntentPort {
  const writer = new OutboundIntentWriter(store, {
    subscribe: () => () => {},
    wake: () => {}
  });
  return new Proxy(writer, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await Reflect.apply(value, target, args);
        await dispatcher.requestScan();
      };
    }
  });
}
