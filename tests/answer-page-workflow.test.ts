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

  it("reserves one terminal finish across repeated convergence", async () => {
    const store = readyStore();
    const content = "⏳ 已接收请求\n\ndone";
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 2 });
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: store.getActiveAnswerPage("p1")!.elementId, content })).toBe("reserved");
    const [contentReply] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(contentReply!.id, "card-1");
    const wake = vi.fn();
    const workflow = new AnswerPageWorkflow(store, wake);

    await Promise.all([workflow.converge("p1"), workflow.converge("p1"), workflow.converge("p1")]);

    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "stream_finish", viewVersion: 2 })]);
    expect(store.getActiveAnswerPage("p1")?.sequence).toBe(2);
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("upgrades a finished terminal page with folded code exactly once", async () => {
    const store = readyStore();
    const code = Array.from({ length: 81 }, (_, index) => `output line ${index}`).join("\n");
    const answer = `\`\`\`text\n${code}\n\`\`\``;
    const content = `⏳ 已接收请求\n\n${answer}`;
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn());

    await workflow.converge("p1");
    const [finish] = store.listPendingOutboundReplies();
    expect(finish).toMatchObject({ kind: "stream_finish" });
    store.markOutboundReplyDelivered(finish!.id, "card-1");

    await workflow.converge("p1");
    const [upgrade] = store.listPendingOutboundReplies();
    expect(upgrade).toMatchObject({ kind: "card_update", cardRole: "answer", rootMessageId: "answer-1" });
    expect(upgrade?.payload).toContain("执行输出");
    expect(upgrade?.payload).toContain("81 行");
    await workflow.converge("p1");
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    expect(store.listAnswerPages("p1")[0]).toMatchObject({ state: "finished", sequence: 2 });
    store.close();
  });
});
