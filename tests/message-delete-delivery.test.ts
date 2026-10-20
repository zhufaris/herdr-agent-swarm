import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LarkPort } from "../src/domain/ports.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { createTestPublisher, type TestOutbound } from "./helpers/create-test-outbound.js";

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable message deletion", () => {
  it.each(["deleted", "already_absent"] as const)("settles %s as delivered against the exact target", async (outcome) => {
    const store = new SqliteBindingStore(":memory:");
    const deleteMessage = vi.fn(async () => outcome);
    const dispatcher = createDispatcher(store, fakeLark({ deleteMessage }));
    await dispatcher.enqueueMessageDelete(null, "answer-message-1", `delete:${outcome}`);

    await dispatcher.requestScan(true);

    expect(deleteMessage).toHaveBeenCalledWith("answer-message-1");
    expect(deliveryByKey(store, `delete:${outcome}`)).toMatchObject({
      state: "delivered",
      deliveredMessageId: "answer-message-1",
      attemptCount: 1
    });
    store.close();
  });

  it("retries a confirmed transient rejection and then delivers the same durable intent", async () => {
    const store = new SqliteBindingStore(":memory:");
    const deleteMessage = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { response: { status: 429 } }))
      .mockResolvedValueOnce("deleted");
    const dispatcher = createDispatcher(store, fakeLark({ deleteMessage }));
    await dispatcher.enqueueMessageDelete(null, "answer-message-1", "delete:retry");

    await dispatcher.requestScan(true);
    expect(deliveryByKey(store, "delete:retry")).toMatchObject({ state: "pending", attemptCount: 1, failureClass: "transient", effectCertainty: "rejected" });
    await dispatcher.requestScan(true);

    expect(deleteMessage).toHaveBeenNthCalledWith(1, "answer-message-1");
    expect(deleteMessage).toHaveBeenNthCalledWith(2, "answer-message-1");
    expect(deliveryByKey(store, "delete:retry")).toMatchObject({ state: "delivered", deliveredMessageId: "answer-message-1" });
    store.close();
  });

  it.each([
    ["permanent rejection", Object.assign(new Error("forbidden"), { response: { status: 400, data: { code: 230099 } } }), "permanent", "rejected"],
    ["uncertain remote effect", Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), "unknown", "uncertain"]
  ] as const)("dead-letters a %s without automatic replay", async (_label, failure, failureClass, effectCertainty) => {
    const store = new SqliteBindingStore(":memory:");
    const deleteMessage = vi.fn().mockRejectedValue(failure);
    const dispatcher = createDispatcher(store, fakeLark({ deleteMessage }));
    await dispatcher.enqueueMessageDelete(null, "answer-message-1", `delete:${failureClass}`);

    await dispatcher.requestScan(true);
    await dispatcher.requestScan(true);

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deliveryByKey(store, `delete:${failureClass}`)).toMatchObject({ state: "dead_letter", attemptCount: 1, failureClass, effectCertainty });
    store.close();
  });

  it("dead-letters a transient deletion after the bounded original-target attempts", async () => {
    const store = new SqliteBindingStore(":memory:");
    const deleteMessage = vi.fn().mockRejectedValue(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
    const dispatcher = createDispatcher(store, fakeLark({ deleteMessage }));
    await dispatcher.enqueueMessageDelete(null, "answer-message-1", "delete:exhausted");

    for (let attempt = 0; attempt < 3; attempt += 1) await dispatcher.requestScan(true);

    expect(deleteMessage).toHaveBeenCalledTimes(3);
    expect(deliveryByKey(store, "delete:exhausted")).toMatchObject({ state: "dismissed", attemptCount: 3, failureClass: "transient", effectCertainty: "not-started" });
    store.close();
  });

  it("recovers an unclaimed deletion after reopening the durable store", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-message-delete-"));
    directories.push(directory);
    const path = join(directory, "bridge.db");
    let store = new SqliteBindingStore(path);
    let dispatcher = createDispatcher(store, fakeLark({}));
    await dispatcher.enqueueMessageDelete(null, "answer-message-1", "delete:restart");
    await dispatcher.stop();
    store.close();

    store = new SqliteBindingStore(path);
    const deleteMessage = vi.fn(async () => "deleted" as const);
    dispatcher = createDispatcher(store, fakeLark({ deleteMessage }));
    await dispatcher.requestScan();

    expect(deleteMessage).toHaveBeenCalledWith("answer-message-1");
    expect(deliveryByKey(store, "delete:restart")).toMatchObject({ state: "delivered" });
    store.close();
  });

  it("serializes all Global deletions through the single Global Ring", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started: string[] = [];
    let firstTargetCall = true;
    const deleteMessage = vi.fn(async (messageId: string) => {
      started.push(messageId);
      if (messageId === "answer-message-1" && firstTargetCall) {
        firstTargetCall = false;
        await blocked;
      }
      return "deleted" as const;
    });
    const store = new SqliteBindingStore(":memory:");
    const dispatcher = createDispatcher(store, fakeLark({ deleteMessage }));
    const outbound = dispatcher;
    await outbound.enqueueMessageDelete(null, "answer-message-1", "delete:same:1");
    await outbound.enqueueMessageDelete(null, "answer-message-1", "delete:same:2");
    await outbound.enqueueMessageDelete(null, "answer-message-2", "delete:independent");

    const draining = dispatcher.requestScan();
    await vi.waitFor(() => expect(started).toEqual(["answer-message-1"]));
    expect(started.filter((target) => target === "answer-message-1")).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(started).toEqual(["answer-message-1", "answer-message-1", "answer-message-2"]));
    await draining;

    expect(started).toEqual(["answer-message-1", "answer-message-1", "answer-message-2"]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    store.close();
  });
});

function deliveryByKey(store: SqliteBindingStore, idempotencyKey: string) {
  const row = store.database.prepare("SELECT id FROM outbound_replies WHERE idempotency_key = ?").get(idempotencyKey) as { id: string } | undefined;
  return row ? store.getOutboundReply(row.id) : null;
}

function createDispatcher(store: SqliteBindingStore, lark: LarkPort): TestOutbound {
  return createTestPublisher(store, lark, pino({ enabled: false }));
}

function fakeLark(overrides: Partial<LarkPort>): LarkPort {
  return {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "thread-1", rootMessageId: "root-1" }; },
    async replyText() { return { messageId: "text-1" }; },
    async replyCard() { return { messageId: "card-1" }; },
    async updateCard() {},
    ...overrides
  };
}
