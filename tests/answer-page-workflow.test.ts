import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

function readyStore(): SqliteBindingStore {
  const store = new SqliteBindingStore(":memory:");
  store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
  const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
  store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
  store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
  return store;
}

describe("AnswerPageWorkflow", () => {
  it("reserves one content intent and wakes delivery", async () => {
    const store = readyStore();
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "hello", answerSegments: ["hello"], viewVersion: 2 });
    const wake = vi.fn();
    await new AnswerPageWorkflow(store, wake, pino({ enabled: false })).converge("p1");
    expect(wake).toHaveBeenCalledOnce();
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    expect(store.getActiveAnswerPage("p1")?.sequence).toBe(1);
    await new AnswerPageWorkflow(store, wake).converge("p1");
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    store.close();
  });

  it("does nothing until the initial Answer card is delivered", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: null, requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const wake = vi.fn();
    await new AnswerPageWorkflow(store, wake).converge("p1");
    expect(wake).not.toHaveBeenCalled();
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    store.close();
  });
});
