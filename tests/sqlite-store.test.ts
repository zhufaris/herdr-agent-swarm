import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initialTopicView } from "../src/domain/topic-view.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

let store: SqliteBindingStore | undefined;
let temporaryDirectory: string | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("SQLite store", () => {
  it("persists bindings, FIFO jobs, deduplication, and view snapshots", () => {
    store = new SqliteBindingStore(":memory:");
    const binding = store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding(binding.id, { paneId: "w1:p2", state: "active" });
    expect(store.findBindingByLarkScope("unknown-thread", "m1")?.id).toBe("b1");
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "first" });
    store.enqueuePrompt({ id: "p2", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "second" });
    expect(store.claimNextPrompt("b1")?.id).toBe("p1");
    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.claimNextPrompt("b1")?.id).toBe("p2");
    const inbound = { eventId: "e1", messageId: "m2", chatId: "c1", topicId: "t1", rootMessageId: "m1", actorOpenId: "u1", text: "first", mentionsBot: false, isRootMessage: false };
    expect(store.recordInboundMessage(inbound)).toBe(true);
    expect(store.recordInboundMessage(inbound)).toBe(false);
    expect(store.claimNextInboundMessage()).toEqual(inbound);
    expect(store.recoverProcessingInboundMessages()).toBe(1);
    expect(store.claimNextInboundMessage()).toEqual(inbound);
    store.markInboundMessageAccepted(inbound.eventId);
    expect(store.claimNextInboundMessage()).toBeNull();
    const outbound = store.enqueueOutboundReply({ id: "o1", idempotencyKey: "event:e1:thread-text", bindingId: null, rootMessageId: "m1", kind: "text", payload: "received" });
    const duplicate = store.enqueueOutboundReply({ id: "o2", idempotencyKey: "event:e1:thread-text", bindingId: null, rootMessageId: "m1", kind: "text", payload: "duplicate" });
    expect(duplicate.id).toBe(outbound.id);
    store.markOutboundReplyFailed(outbound.id, "temporary");
    expect(store.listPendingOutboundReplies()).toMatchObject([{ id: "o1", error: "temporary", attemptCount: 1 }]);
    store.markOutboundReplyDelivered(outbound.id, "sent-1");
    expect(store.listPendingOutboundReplies()).toEqual([]);
    const view = { ...initialTopicView("b1"), title: "Task" };
    store.saveTopicView(view);
    expect(store.loadTopicView("b1")).toEqual(view);
  });

  it("atomically accepts one prompt card and only claims it after card delivery", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "First", workspaceId: "w1", paneId: "w1:p1", requestText: "first **request**", queuePosition: 1, occurredAt: "2026-08-22T10:00:00.000Z" });
    const accepted = store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-m1", actorOpenId: "u1", body: "first" }, view, rootMessageId: "m1", card: { schema: "2.0" } });
    const duplicate = store.acceptPrompt({ prompt: { id: "other", bindingId: "b1", larkMessageId: "user-m1", actorOpenId: "u1", body: "first" }, view: { ...view, promptId: "other" }, rootMessageId: "m1", card: { schema: "2.0" } });

    expect(accepted.inserted).toBe(true);
    expect(duplicate).toMatchObject({ inserted: false, prompt: { id: "p1" }, view: { promptId: "p1" } });
    expect(store.listPendingOutboundReplies()).toMatchObject([{ promptId: "p1", viewVersion: 1, kind: "card_reply" }]);
    expect(store.claimNextReadyPrompt("b1")).toBeNull();
    expect(store.listQueuedTurnPromptIds("b1")).toEqual(["p1"]);

    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "card-m1");
    expect(store.loadRunCard("p1")).toMatchObject({ larkMessageId: "card-m1", requestText: "first **request**", deliveredVersion: 1 });
    expect(store.claimNextReadyPrompt("b1")?.id).toBe("p1");
    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "failed", notice: "Bridge 重启导致本次执行中断", queuePosition: 0, viewVersion: 2 });
  });

  it("backfills original request text when migrating an existing run-card database", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-lark-bridge-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: null, requestText: "legacy **request**", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "legacy **request**" }, view, rootMessageId: "m1", card: {} });
    store.close();
    store = undefined;

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP VIEW run_cards_view;
      ALTER TABLE run_cards DROP COLUMN request_text;
    `);
    legacy.close();

    store = new SqliteBindingStore(path);
    expect(store.loadRunCard("p1")).toMatchObject({ requestText: "legacy **request**" });
  });

  it("classifies, claims, falls back, and recovers steering jobs without replay", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const makeView = (promptId: string) => createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 0, occurredAt: new Date().toISOString() });
    for (const [id, messageId] of [["s1", "m2"], ["s2", "m3"]] as const) {
      store.acceptPrompt({
        prompt: { id, bindingId: "b1", larkMessageId: messageId, actorOpenId: "u1", body: id, dispatchKind: "steering", parentPromptId: "parent" },
        view: makeView(id), rootMessageId: "m1", card: {}
      });
    }
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, `card-${reply.promptId}`);

    expect(store.claimNextReadyPrompt("b1")).toBeNull();
    expect(store.listQueuedTurnPromptIds("b1")).toEqual([]);
    expect(store.claimNextReadySteering("b1", "parent")?.id).toBe("s1");
    store.updatePrompt("s1", "delivered");
    expect(store.claimNextReadySteering("b1", "parent")?.id).toBe("s2");
    store.requeueSteeringAsTurn("s2");
    expect(store.claimNextReadyPrompt("b1")).toMatchObject({ id: "s2", dispatchKind: "turn", parentPromptId: null });

    store.updatePrompt("s2", "queued");
    store.database.prepare("UPDATE prompt_jobs SET dispatch_kind = 'steering', parent_prompt_id = 'parent' WHERE id = 's2'").run();
    expect(store.recoverRunningPrompts()).toBe(0);
    expect(store.claimNextReadyPrompt("b1")).toMatchObject({ id: "s2", dispatchKind: "turn" });
  });

  it("marks interrupted steering as uncertain instead of replaying it", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "s1", bindingId: "b1", title: "Steer", workspaceId: "w1", paneId: "w1:p1", requestText: "steer", queuePosition: 0, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "s1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "steer", dispatchKind: "steering", parentPromptId: "parent" }, view, rootMessageId: "m1", card: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-s1");
    expect(store.claimNextReadySteering("b1", "parent")?.id).toBe("s1");

    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.loadRunCard("s1")).toMatchObject({ phase: "failed", notice: "Steering 投递结果无法确认，请检查 Herdr pane 后按需重试" });
    expect(store.claimNextReadyPrompt("b1")).toBeNull();
  });
});
