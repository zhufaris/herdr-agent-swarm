import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { MainCardWorkflow } from "../src/coordinator/main-card-workflow.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

function setupStore() {
  const stores = createTestStoreBundle();
  return { stores, store: stores.driver };
}

describe("MainCardWorkflow", () => {
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
    store.saveTopicView({ ...initialTopicView("b1"), title: "Visible", viewVersion: 1 });
    const wake = vi.fn();
    const workflow = new MainCardWorkflow(stores.mainCards, wake, primaryPresentation, pino({ enabled: false }));

    await Promise.all([workflow.converge("b1"), workflow.converge("b1"), workflow.converge("b1")]);

    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "card_reply", viewVersion: 1, targetRole: "session_status" })]);
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("atomically projects a newer view and reserves its update", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1" });
    const wake = vi.fn();
    const workflow = new MainCardWorkflow(stores.mainCards, wake, primaryPresentation);

    await workflow.project({ ...initialTopicView("b1"), title: "Newest", viewVersion: 2, deliveredVersion: 1 });

    expect(store.loadTopicView("b1")).toMatchObject({ title: "Newest", viewVersion: 2, deliveredVersion: 1 });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      kind: "card_update", rootMessageId: "main-1", viewVersion: 2, targetRole: "session_status", workClass: "live"
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
    store.updateBinding("b1", { statusMessageId: "main-1" });
    const wake = vi.fn();
    const workflow = new MainCardWorkflow(stores.mainCards, wake, primaryPresentation);

    await workflow.project({ ...initialTopicView("b1"), title: "Startup", viewVersion: 1 }, "history");
    await workflow.project({ ...initialTopicView("b1"), title: "Live", viewVersion: 2 }, "live");

    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      kind: "card_update", targetRole: "session_status", workClass: "live", viewVersion: 2, cardSequence: 1
    })]);
    expect(wake).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("hydrates the durable model preference before reserving the Main Card", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
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
      kind: "card_update", rootMessageId: "alias-root", viewVersion: 2, laneKey: expect.stringContaining("pane-entry:")
    }));
    expect(pending.find((reply) => reply.rootMessageId === "alias-root")?.payload).toContain("HERDR PANE ENTRY");
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("coalesces a burst of unclaimed Pane Entry snapshots to the newest version", async () => {
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
    expect(paneEntries).toEqual([expect.objectContaining({ viewVersion: 4 })]);
    expect(paneEntries[0]!.payload).toContain("Version 4");
    store.close();
  });

  it("preserves a claimed Pane Entry snapshot while coalescing newer unclaimed versions", async () => {
    const { stores, store } = setupStore();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "main-1", state: "active", lifecycle: "active", attachment: "attached" });
    store.reservePaneThreadAlias({ publicationKey: "pane-entry-1", actionMessageId: "directory", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "main-1", targetChatId: "c1", card: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "alias-root", undefined, "alias-topic");
    const workflow = new MainCardWorkflow(stores.mainCards, vi.fn(), primaryPresentation);
    await workflow.project({ ...initialTopicView("b1"), title: "Claimed", viewVersion: 2 });
    const claimed = store.listPendingOutboundReplies().find((reply) => reply.laneKey.includes("pane-entry:"))!;
    expect(store.claimOutboundReply(claimed.id, null)).not.toBeNull();

    await workflow.project({ ...initialTopicView("b1"), title: "Intermediate", viewVersion: 3 });
    await workflow.project({ ...initialTopicView("b1"), title: "Newest", viewVersion: 4 });

    const paneEntries = store.listPendingOutboundReplies().filter((reply) => reply.laneKey.includes("pane-entry:"));
    expect(paneEntries.map((reply) => reply.viewVersion)).toEqual([2, 4]);
    expect(paneEntries[0]).toMatchObject({ id: claimed.id });
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
