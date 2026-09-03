import { describe, expect, it } from "vitest";
import { planAnswerPage as planAnswerPageWithPlanning } from "../src/domain/answer-page-plan.js";
import { answerElementId, createQueuedRunCard } from "../src/domain/run-card-view.js";
import type { AnswerPage } from "../src/domain/types.js";
import { ANSWER_STREAM_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage } from "../src/runtime/answer-stream.js";
const planning = { pageLimit: ANSWER_STREAM_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage };
const planAnswerPage = (...args: Parameters<typeof planAnswerPageWithPlanning> extends infer P ? P extends readonly unknown[] ? P : never : never) => planAnswerPageWithPlanning(args[0] as never, args[1] as never, args[2] as never, planning);

function fixture(answer: string, phase: "running" | "completed" = "running") {
  const view = { ...createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" }), answer, phase, answerCardId: "card-1", answerMessageId: "message-1" };
  const page: AnswerPage = { promptId: "p1", pageIndex: 0, messageId: "message-1", cardId: "card-1", elementId: "answer_content_p1_0", sourceStart: 0, sequence: 0, state: "active", createdAt: "now", updatedAt: "now" };
  return { view, page };
}

describe("answer page planner", () => {
  it("streams content before finishing a terminal page", () => {
    const { view, page } = fixture("done", "completed");
    expect(planAnswerPage(view, page, { latestContent: null, finishPending: false, continuationPending: false })).toEqual({ type: "stream-content", content: answerStreamContent(view) });
    const content = answerStreamContent(view);
    expect(planAnswerPage(view, page, { latestContent: { content, sequence: 1, state: "delivered" }, finishPending: false, continuationPending: false })).toEqual({ type: "finish-terminal", summary: "Completed" });
  });

  it("finishes an empty terminal answer after its status content is delivered", () => {
    const { view, page } = fixture("", "completed");
    const content = answerStreamContent(view);
    expect(planAnswerPage(view, page, { latestContent: { content, sequence: 1, state: "delivered" }, finishPending: false, continuationPending: false }))
      .toEqual({ type: "finish-terminal", summary: "Completed" });
  });

  it("waits while content delivery is pending", () => {
    const { view, page } = fixture("new");
    expect(planAnswerPage(view, page, { latestContent: { content: "old", sequence: 1, state: "pending" }, finishPending: false, continuationPending: false })).toEqual({ type: "wait" });
  });

  it("waits at a dead-lettered content boundary instead of rebuilding on a new card", () => {
    const { view, page } = fixture("canonical answer");

    expect(planAnswerPage(view, page, { latestContent: { content: "partial", sequence: 2, state: "dead_letter" }, finishPending: false, continuationPending: false })).toEqual({ type: "wait" });
  });

  it("continues from the persisted source end of a delivered recovery chunk", () => {
    const { view, page } = fixture("canonical answer continues");
    expect(planAnswerPage(view, page, { latestContent: { content: "canonical", sequence: 2, state: "delivered", sourceEnd: 9 }, finishPending: false, continuationPending: false })).toMatchObject({
      type: "continue", nextPageIndex: 1, nextPageStart: 9, nextElementId: answerElementId("p1", 1)
    });
  });

  it("finishes in place when a delivered recovery chunk reaches canonical EOF", () => {
    const { view, page } = fixture("canonical answer", "completed");
    const content = answerStreamContent(view);

    expect(planAnswerPage(view, page, { latestContent: { content, sequence: 2, state: "delivered", sourceEnd: content.length }, finishPending: false, continuationPending: false }))
      .toEqual({ type: "finish-terminal", summary: "Completed" });
  });

  it("does not enqueue empty content when a running answer shrinks before a continuation offset", () => {
    const { view, page } = fixture("short transient redraw");
    const continuation = { ...page, pageIndex: 2, sourceStart: answerStreamContent(view).length + 20, elementId: answerElementId("p1", 2) };

    expect(planAnswerPage(view, continuation, { latestContent: { content: "previous visible content", sequence: 9, state: "delivered" }, finishPending: false, continuationPending: false }))
      .toEqual({ type: "wait" });
  });

  it("finishes a terminal continuation without sending empty content", () => {
    const { view, page } = fixture("short final answer", "completed");
    const continuation = { ...page, pageIndex: 2, sourceStart: answerStreamContent(view).length + 20, elementId: answerElementId("p1", 2) };

    expect(planAnswerPage(view, continuation, { latestContent: { content: "previous visible content", sequence: 9, state: "delivered" }, finishPending: false, continuationPending: false }))
      .toEqual({ type: "finish-terminal", summary: "Completed" });
  });

  it("plans deterministic continuation pages", () => {
    const { view, page } = fixture(`${"a".repeat(ANSWER_STREAM_PAGE_LIMIT)}\n${"b".repeat(ANSWER_STREAM_PAGE_LIMIT)}\n${"c".repeat(500)}`, "completed");
    const first = renderAnswerStreamPage(answerStreamContent(view), 0);
    const plan = planAnswerPage(view, page, { latestContent: { content: first.page, sequence: 1, state: "delivered" }, finishPending: false, continuationPending: false });
    expect(plan).toMatchObject({ type: "continue", nextPageIndex: 1, nextPageStart: first.nextPageStart, nextElementId: "answer_content_p1_1" });
  });

  it("never plans writes for creating or frozen pages", () => {
    const { view, page } = fixture("done", "completed");
    for (const state of ["creating", "frozen", "finished"] as const) {
      expect(planAnswerPage(view, { ...page, state }, { latestContent: null, finishPending: false, continuationPending: false })).toEqual({ type: "wait" });
    }
  });
});
