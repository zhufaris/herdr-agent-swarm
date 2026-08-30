import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { AnswerPageWorkflow } from "../src/coordinator/answer-page-workflow.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { answerStreamContent } from "../src/runtime/answer-stream.js";
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

  it("finishes a delivered recovery chunk at canonical EOF without creating an empty page", async () => {
    const store = readyStore();
    const completed = store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 2 });
    const content = answerStreamContent(completed);
    store.enqueueOutboundReply({
      id: "recovery-content", idempotencyKey: "startup-lite-content:failed-content", bindingId: "b1", promptId: "p1", viewVersion: 1, cardRole: "answer",
      rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: store.getActiveAnswerPage("p1")!.elementId, content, sequence: 1, sourceEnd: content.length })
    });
    store.markOutboundReplyDelivered("recovery-content", "card-1");

    await new AnswerPageWorkflow(store, vi.fn()).converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "stream_finish", viewVersion: 2 })]);
    expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "active" })]);
    store.close();
  });

  it("continues exactly from a delivered recovery chunk source end", async () => {
    const store = readyStore();
    const answer = "x".repeat(12_000);
    const completed = store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const content = answerStreamContent(completed);
    const sourceEnd = 4_000;
    store.enqueueOutboundReply({
      id: "recovery-content", idempotencyKey: "startup-lite-content:failed-content", bindingId: "b1", promptId: "p1", viewVersion: 1, cardRole: "answer",
      rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: store.getActiveAnswerPage("p1")!.elementId, content: content.slice(0, sourceEnd), sequence: 1, sourceEnd })
    });
    store.markOutboundReplyDelivered("recovery-content", "card-1");

    await new AnswerPageWorkflow(store, vi.fn()).converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([
      expect.objectContaining({ kind: "stream_finish" }),
      expect.objectContaining({ kind: "stream_card_create", payload: expect.stringContaining(`\"pageStart\":${sourceEnd}`) })
    ]);
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, sourceStart: 0, state: "active" }),
      expect.objectContaining({ pageIndex: 1, sourceStart: sourceEnd, state: "creating" })
    ]);
    store.close();
  });

  it("updates a short frozen Answer Card to green exactly once after stream finish", async () => {
    const store = readyStore();
    const content = "⏳ 已接收请求\n\ndone";
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn());

    await workflow.converge("p1");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    await workflow.converge("p1");

    const [update] = store.listPendingOutboundReplies();
    expect(update).toMatchObject({ kind: "card_update", cardRole: "answer", rootMessageId: "answer-1" });
    expect(update?.payload).toContain('\"template\":\"green\"');
    await workflow.converge("p1");
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
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

  it("preserves the last delivered continuation when the completed answer shrinks below its page start", async () => {
    const store = readyStore();
    const visibleContinuation = "the last visible continuation";
    const elementId = "answer_content_p1_1";
    store.database.exec("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1' AND page_index = 0");
    store.database.prepare("INSERT INTO answer_pages VALUES ('p1', 1, 'answer-2', 'card-2', ?, 9351, 10, 'finished', 'now', 'now')").run(elementId);
    store.database.prepare("UPDATE run_cards SET answer_message_id = 'answer-2', answer_card_id = 'card-2', answer_element_id = ?, answer_page_index = 1, answer_page_start = 9351 WHERE prompt_id = 'p1'").run(elementId);
    store.enqueueOutboundReply({
      id: "visible-continuation", idempotencyKey: "visible-continuation", bindingId: "b1", promptId: "p1", viewVersion: 9, cardRole: "answer",
      rootMessageId: "card-2", kind: "stream_content", payload: JSON.stringify({ pageIndex: 1, elementId, content: visibleContinuation, sequence: 9 })
    });
    store.markOutboundReplyDelivered("visible-continuation", "card-2");
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "short final answer", answerSegments: ["short final answer"], viewVersion: 3 });
    const workflow = new AnswerPageWorkflow(store, vi.fn());

    await workflow.converge("p1");

    const finalUpdate = store.listPendingOutboundReplies().find((reply) => reply.kind === "card_update")!;
    expect(finalUpdate).toMatchObject({ rootMessageId: "answer-2", cardRole: "answer" });
    expect(finalUpdate.payload).toContain(visibleContinuation);
    expect(finalUpdate.payload).not.toContain('"elements":[]');
    store.close();
  });

  it("reopens a dead-lettered final folded-card update in place", async () => {
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
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    await workflow.converge("p1");
    const original = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDeadLetter(original.id, "invalid card", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "bad_card" });
    const latestAnswer = `${answer}\n\nlatest terminal state`;
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: latestAnswer, answerSegments: [answer, "latest terminal state"], viewVersion: 3 });

    await workflow.converge("p1");

    const [reopened] = store.listPendingOutboundReplies();
    expect(reopened).toMatchObject({
      id: original.id, state: "pending", attemptCount: 0, error: null, failureClass: null, httpStatus: null, larkErrorCode: null, deadLetteredAt: null, autoRecoveryCount: 0, viewVersion: 3
    });
    expect(reopened!.payload).not.toBe(original.payload);
    expect(reopened!.payload).toContain("latest terminal state");
    expect(store.listOutboundLaneHeads(10, null)).toEqual([expect.objectContaining({ id: original.id })]);
    store.close();
  });

  it("reopens a dismissed final folded-card update in place", async () => {
    const store = readyStore();
    const answer = `\`\`\`text\n${Array.from({ length: 81 }, (_, index) => `output line ${index}`).join("\n")}\n\`\`\``;
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer, answerSegments: [answer], viewVersion: 2 });
    const page = store.getActiveAnswerPage("p1")!;
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: page.elementId, content: `⏳ 已接收请求\n\n${answer}` })).toBe("reserved");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    const workflow = new AnswerPageWorkflow(store, vi.fn());
    await workflow.converge("p1");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");
    await workflow.converge("p1");
    const original = store.listPendingOutboundReplies()[0]!;
    store.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'superseded', attempt_count = 3 WHERE id = ?").run(original.id);

    await workflow.converge("p1");

    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ id: original.id, state: "pending", attemptCount: 0, error: null })]);
    store.close();
  });
});
