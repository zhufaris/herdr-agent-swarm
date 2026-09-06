import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { MainCardWorkflow } from "../src/coordinator/main-card-workflow.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { primaryPresentation } from "./helpers/presentation.js";

describe("MainCardWorkflow", () => {
  it("persists projection state before a root delivery target exists", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: null, rootMessageId: null, title: "Task" });
    const wake = vi.fn();

    await new MainCardWorkflow(store, wake, primaryPresentation).project({ ...initialTopicView("b1"), title: "Before root", viewVersion: 1 });

    expect(store.loadTopicView("b1")).toMatchObject({ title: "Before root", viewVersion: 1, deliveredVersion: 0 });
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    store.close();
  });

  it("reserves one delivery across repeated concurrent convergence", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Visible", viewVersion: 1 });
    const wake = vi.fn();
    const workflow = new MainCardWorkflow(store, wake, primaryPresentation, pino({ enabled: false }));

    await Promise.all([workflow.converge("b1"), workflow.converge("b1"), workflow.converge("b1")]);

    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "card_reply", viewVersion: 1, targetRole: "session_status" })]);
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("atomically projects a newer view and reserves its update", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1" });
    const wake = vi.fn();
    const workflow = new MainCardWorkflow(store, wake, primaryPresentation);

    await workflow.project({ ...initialTopicView("b1"), title: "Newest", viewVersion: 2, deliveredVersion: 1 });

    expect(store.loadTopicView("b1")).toMatchObject({ title: "Newest", viewVersion: 2, deliveredVersion: 1 });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "card_update", rootMessageId: "main-1", viewVersion: 2, targetRole: "session_status" })]);
    expect(wake).toHaveBeenCalledOnce();
    await Promise.all([workflow.converge("b1"), workflow.converge("b1")]);
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("hydrates the durable model preference before reserving the Main Card", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.saveTopicView({ ...initialTopicView("b1"), model: "GPT-5.4", viewVersion: 1 });
    store.acceptModelPreference({ bindingId: "b1", bindingGeneration: 1, model: "GPT-5.6-Sol" });

    await new MainCardWorkflow(store, vi.fn(), primaryPresentation).converge("b1");

    expect(store.loadTopicView("b1")).toMatchObject({
      model: "GPT-5.4", modelPreference: { model: "GPT-5.6-Sol", revision: 1, state: "pending" }, viewVersion: 2
    });
    const [reply] = store.listPendingOutboundReplies();
    expect(reply?.payload).toContain("next GPT-5.6-Sol");
    store.close();
  });

  it("delivers the newest version after initial card creation checkpoints", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const workflow = new MainCardWorkflow(store, vi.fn(), primaryPresentation);
    await workflow.project({ ...initialTopicView("b1"), title: "First", viewVersion: 1 });
    await workflow.project({ ...initialTopicView("b1"), title: "Newest", viewVersion: 2 });
    const [create] = store.listPendingOutboundReplies();

    store.markOutboundReplyDelivered(create!.id, "main-1");
    await workflow.converge("b1");

    expect(store.loadTopicView("b1")).toMatchObject({ title: "Newest", viewVersion: 2, deliveredVersion: 1 });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "card_update", rootMessageId: "main-1", viewVersion: 2 })]);
    store.close();
  });
});
