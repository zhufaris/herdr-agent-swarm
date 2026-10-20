import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { MainCardWorkflow } from "../src/coordinator/main-card-workflow.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";
import type { PreparedDelivery, PreparedDeliveryPlan } from "../src/domain/delivery.js";
import type { OutboundReply } from "../src/domain/types.js";
import type { SqliteProjectionStore } from "../src/store/sqlite/projection-store.js";

function setupStore() {
  const stores = createTestStoreBundle();
  return { stores, store: stores.driver };
}

describe("MainCardWorkflow", () => {
  it("prepares the canonical Main Card and Pane Entry in their projection transaction", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "main-1", state: "active", lifecycle: "active", attachment: "attached" });
    store.reservePaneThreadAlias({ publicationKey: "pane-entry-1", actionMessageId: "directory", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "main-1", targetChatId: "c1", card: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "alias-root", undefined, "alias-topic");
    const handedOff: PreparedDelivery[] = [];
    stores.outbox.setGatewayPlanPreparer(preparedPlan);
    projectionModule(store).setPreparedMainCardDeliveryReservation(stores.outbox, { enqueuePreparedDelivery: (delivery) => handedOff.push(delivery) });

    await new MainCardWorkflow(stores.mainCards, vi.fn(), primaryPresentation).project({ ...initialTopicView("b1"), title: "Prepared", viewVersion: 2 });

    const pending = store.listPendingOutboundReplies();
    expect(pending).toHaveLength(2);
    expect(pending).toEqual(expect.arrayContaining([
      expect.objectContaining({ rootMessageId: "main-1", projectionKey: "primary-main:b1:1", gatewayPlanHash: expect.any(String) }),
      expect.objectContaining({ rootMessageId: "alias-root", threadAliasId: expect.any(String), projectionKey: expect.stringMatching(/^pane-entry:/), gatewayPlanHash: expect.any(String) })
    ]));
    await Promise.resolve();
    expect(handedOff.map(({ replyId }) => replyId).sort()).toEqual(pending.map(({ id }) => id).sort());
    expect(handedOff).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: expect.objectContaining({ kind: "pane", paneId: "w1:p1" }), ownerFence: { kind: "primary", id: "b1", generation: 1, sessionGeneration: 1 } }),
      expect.objectContaining({ scope: expect.objectContaining({ kind: "pane", paneId: "w1:p1" }), ownerFence: { kind: "primary", id: "b1", generation: 1, sessionGeneration: 1 } })
    ]));
    store.close();
  });

  it("hydrates durable Native Input backlog without inventing another active turn", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1", state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "working" });
    for (const [index, body] of ["first", "second"].entries()) {
      store.acceptCollectingNativeInput({
        input: { id: `input-${index + 1}`, bindingId: "b1", bindingGeneration: 1, ingressSource: "feishu", sourceMessageKey: `message-${index + 1}`, larkMessageId: `message-${index + 1}`, actorOpenId: "user-1", body, rootMessageId: "root-1", parentPromptId: null },
        batchId: "batch-1", occurredAt: `2026-10-02T01:00:0${index}.000Z`, windowMs: 2_000, maxQueueDepth: 20
      });
    }
    store.formDueNativeInputBatch({
      bindingId: "b1", occurredAt: "2026-10-02T01:00:02.000Z", nextBatchId: "batch-2", windowMs: 2_000,
      createProjection: ({ batchId, binding, combinedBody, titleSource, rootMessageId, queuePosition }) => ({
        view: createQueuedRunCard({ promptId: batchId, bindingId: binding.id, bindingGeneration: binding.generation, title: titleSource, workspaceId: binding.workspaceId, paneId: binding.paneId, requestText: combinedBody, queuePosition, occurredAt: "2026-10-02T01:00:02.000Z" }),
        rootMessageId, answerCard: {}
      })
    });
    store.acceptCollectingNativeInput({
      input: { id: "input-3", bindingId: "b1", bindingGeneration: 1, ingressSource: "feishu", sourceMessageKey: "message-3", larkMessageId: "message-3", actorOpenId: "user-1", body: "third", rootMessageId: "root-1", parentPromptId: null },
      batchId: "batch-2", occurredAt: "2026-10-02T01:00:03.000Z", windowMs: 2_000, maxQueueDepth: 20
    });
    store.saveTopicView({ ...initialTopicView("b1"), phase: "running", activePromptId: "active-prompt", viewVersion: 1 });

    await new MainCardWorkflow(stores.mainCards, vi.fn(), primaryPresentation).converge("b1");

    expect(store.loadTopicView("b1")).toMatchObject({
      activePromptId: "active-prompt",
      nativeInputBacklog: { unbatchedInputCount: 1, pendingBatchCount: 1 }
    });
    const main = store.listPendingOutboundReplies().find((reply) => reply.targetRole === "session_status");
    expect(main?.payload).toContain("待成批消息 `1`");
    expect(main?.payload).toContain("待执行批次 `1`");
    expect(main?.payload).toContain("活跃 turn `1`");
    store.close();
  });

  it("renders one aggregate owner-scoped gap warning on the mutable Main Card", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1", paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    store.database.prepare(`INSERT INTO projection_gaps(stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,first_failed_at,last_failed_at)
      VALUES ('main_delivery','binding','b1','reply-1','permanent','expired','2026-09-30T00:00:00.000Z','2026-09-30T00:00:00.000Z')`).run();

    await new MainCardWorkflow(stores.mainCards, vi.fn(), primaryPresentation).project({ ...initialTopicView("b1"), title: "Latest", viewVersion: 2 });

    const payload = store.listPendingOutboundReplies()[0]!.payload;
    expect(payload.match(/有 1 条更新未能实时展示/g)).toHaveLength(1);
    store.close();
  });

  it("persists projection state before a root delivery target exists", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: null, rootMessageId: null, title: "Task" });
    const wake = vi.fn();

    await new MainCardWorkflow(stores.mainCards, wake, primaryPresentation).project({ ...initialTopicView("b1"), title: "Before root", viewVersion: 1 });

    expect(store.loadTopicView("b1")).toMatchObject({ title: "Before root", viewVersion: 1, deliveredVersion: 0 });
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    store.close();
  });

  it("reserves one delivery across repeated concurrent convergence", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Visible", viewVersion: 1 });
    const wake = vi.fn();
    const workflow = new MainCardWorkflow(stores.mainCards, wake, primaryPresentation, pino({ enabled: false }));

    await Promise.all([workflow.converge("b1"), workflow.converge("b1"), workflow.converge("b1")]);

    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "card_reply", viewVersion: 1, targetRole: "session_status", gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", workspaceId: "w1", paneId: "w1:p1" } })]);
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("atomically projects a newer view and reserves its update", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1", paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const wake = vi.fn();
    const workflow = new MainCardWorkflow(stores.mainCards, wake, primaryPresentation);

    await workflow.project({ ...initialTopicView("b1"), title: "Newest", viewVersion: 2, deliveredVersion: 1 });

    expect(store.loadTopicView("b1")).toMatchObject({ title: "Newest", viewVersion: 2, deliveredVersion: 1 });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      kind: "card_update", rootMessageId: "main-1", viewVersion: 2, targetRole: "session_status", workClass: "live", gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", workspaceId: "w1", paneId: "w1:p1" }
    })]);
    expect(wake).toHaveBeenCalledOnce();
    await Promise.all([workflow.converge("b1"), workflow.converge("b1")]);
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("supersedes an unclaimed startup snapshot with the latest live projection", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1", paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const wake = vi.fn();
    const workflow = new MainCardWorkflow(stores.mainCards, wake, primaryPresentation);

    await workflow.project({ ...initialTopicView("b1"), title: "Startup", viewVersion: 1 }, "history");
    await workflow.project({ ...initialTopicView("b1"), title: "Live", viewVersion: 2 }, "live");

    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "card_update", targetRole: "session_status", workClass: "history", viewVersion: 1, cardSequence: 1, gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", workspaceId: "w1", paneId: "w1:p1" } }),
      expect.objectContaining({ kind: "card_update", targetRole: "session_status", workClass: "live", viewVersion: 2, cardSequence: 2, gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", workspaceId: "w1", paneId: "w1:p1" } })
    ]));
    expect(wake).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("hydrates the durable model preference before reserving the Main Card", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    store.saveTopicView({ ...initialTopicView("b1"), model: "GPT-5.4", viewVersion: 1 });
    store.acceptModelPreference({ bindingId: "b1", bindingGeneration: 1, model: "GPT-5.6-Sol" });

    await new MainCardWorkflow(stores.mainCards, vi.fn(), primaryPresentation).converge("b1");

    expect(store.loadTopicView("b1")).toMatchObject({
      model: "GPT-5.4", modelPreference: { model: "GPT-5.6-Sol", revision: 1, state: "pending" }, viewVersion: 2
    });
    const [reply] = store.listPendingOutboundReplies();
    expect(reply?.payload).toContain("next GPT-5.6-Sol");
    store.close();
  });

  it("delivers the newest version after initial card creation checkpoints", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const workflow = new MainCardWorkflow(stores.mainCards, vi.fn(), primaryPresentation);
    await workflow.project({ ...initialTopicView("b1"), title: "First", viewVersion: 1 });
    await workflow.project({ ...initialTopicView("b1"), title: "Newest", viewVersion: 2 });
    const [create] = store.listPendingOutboundReplies();

    store.markOutboundReplyDelivered(create!.id, "main-1");
    await workflow.converge("b1");

    expect(store.loadTopicView("b1")).toMatchObject({ title: "Newest", viewVersion: 2, deliveredVersion: 1 });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "card_update", rootMessageId: "main-1", viewVersion: 2 })]);
    store.close();
  });

  it("projects one TopicView version to the canonical Main Card and an active Pane Entry", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "main-1", state: "active", lifecycle: "active", attachment: "attached" });
    store.reservePaneThreadAlias({ publicationKey: "pane-entry-1", actionMessageId: "directory", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "main-1", targetChatId: "c1", card: {} });
    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "alias-root", undefined, "alias-topic");
    const wake = vi.fn();

    await new MainCardWorkflow(stores.mainCards, wake, primaryPresentation).project({ ...initialTopicView("b1"), title: "Newest", viewVersion: 2 });

    const pending = store.listPendingOutboundReplies();
    expect(pending).toHaveLength(2);
    expect(pending).toContainEqual(expect.objectContaining({ kind: "card_update", rootMessageId: "main-1", targetRole: "session_status", viewVersion: 2 }));
    expect(pending).toContainEqual(expect.objectContaining({
      kind: "card_update", rootMessageId: "alias-root", threadAliasId: expect.any(String), viewVersion: 2, laneKey: expect.stringContaining("pane-entry:")
    }));
    expect(pending.find((reply) => reply.rootMessageId === "alias-root")?.payload).toContain("HERDR PANE ENTRY");
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("keeps a burst of frozen Pane Entry snapshots ordered for the Pane Ring", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "main-1", state: "active", lifecycle: "active", attachment: "attached" });
    store.reservePaneThreadAlias({ publicationKey: "pane-entry-1", actionMessageId: "directory", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "main-1", targetChatId: "c1", card: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "alias-root", undefined, "alias-topic");
    const workflow = new MainCardWorkflow(stores.mainCards, vi.fn(), primaryPresentation);

    for (const viewVersion of [2, 3, 4]) {
      await workflow.project({ ...initialTopicView("b1"), title: `Version ${viewVersion}`, viewVersion });
    }

    const paneEntries = store.listPendingOutboundReplies().filter((reply) => reply.laneKey.includes("pane-entry:"));
    expect(paneEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ viewVersion: 2, gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", workspaceId: "w1", paneId: "w1:p1" } }),
      expect.objectContaining({ viewVersion: 3, gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", workspaceId: "w1", paneId: "w1:p1" } }),
      expect.objectContaining({ viewVersion: 4, gatewayPlanHash: expect.any(String), deliveryScope: { kind: "pane", workspaceId: "w1", paneId: "w1:p1" } })
    ]));
    expect(paneEntries.map((reply) => reply.viewVersion)).toEqual([2, 3, 4]);
    expect(paneEntries.at(-1)!.payload).toContain("Version 4");
    store.close();
  });

  it("repairs a missing Pane Entry version after the canonical Main Card is current", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "main-1", state: "active", lifecycle: "active", attachment: "attached" });
    const current = { ...initialTopicView("b1"), title: "Current", viewVersion: 4, deliveredVersion: 4 };
    store.saveTopicView(current);
    store.reservePaneThreadAlias({ publicationKey: "pane-entry-1", actionMessageId: "directory", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "main-1", targetChatId: "c1", card: {} });
    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "alias-root", undefined, "alias-topic");
    const wake = vi.fn();
    const workflow = new MainCardWorkflow(stores.mainCards, wake, primaryPresentation);

    await workflow.converge("b1", "history");
    await workflow.converge("b1", "history");

    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      kind: "card_update", rootMessageId: "alias-root", viewVersion: 4, workClass: "history", laneKey: expect.stringContaining("pane-entry:")
    })]);
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("does not project a Pane Entry after its binding generation changes", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "main-1", state: "active", lifecycle: "active", attachment: "attached" });
    store.reservePaneThreadAlias({ publicationKey: "pane-entry-1", actionMessageId: "directory", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "main-1", targetChatId: "c1", card: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "alias-root", undefined, "alias-topic");
    store.updateBinding("b1", { generation: 2 });

    await new MainCardWorkflow(stores.mainCards, vi.fn(), primaryPresentation).project({ ...initialTopicView("b1"), title: "New generation", viewVersion: 2 });

    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ rootMessageId: "main-1", targetRole: "session_status" })]);
    store.close();
  });
});

function projectionModule(store: ReturnType<typeof setupStore>["store"]): SqliteProjectionStore {
  return (store as unknown as { projections: SqliteProjectionStore }).projections;
}

function preparedPlan(reply: OutboundReply): PreparedDeliveryPlan {
  const intent = reply.kind === "card_reply"
    ? { kind: "message.reply.view", purpose: "session-status", rootMessageId: reply.rootMessageId, view: {}, idempotencyKey: reply.idempotencyKey }
    : { kind: "surface.replace", purpose: "session-status", messageId: reply.rootMessageId, view: {}, ...(reply.cardSequence === null ? {} : { sequence: reply.cardSequence }) };
  return {
    protocolVersion: 1,
    gatewayId: reply.gatewayId,
    profileId: reply.gatewayProfileId,
    rendererRevision: 1,
    operation: intent.kind,
    intent
  };
}
