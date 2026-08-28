import type { RunCardView } from "./run-card-view.js";
import { answerElementId } from "./run-card-view.js";
import type { AnswerPage, AnswerPageDeliveryFacts } from "./types.js";
import { ANSWER_STREAM_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage } from "../runtime/answer-stream.js";

export type AnswerPagePlan =
  | { type: "wait" }
  | { type: "stream-content"; content: string }
  | { type: "finish-terminal"; summary: "Completed" | "Failed" }
  | { type: "rebuild"; currentSummary: string; nextPageIndex: number; nextPageStart: number; nextElementId: string; initialContent: string }
  | { type: "continue"; currentSummary: string; nextPageIndex: number; nextPageStart: number; nextElementId: string; initialContent: string };

export function planAnswerPage(view: RunCardView, page: AnswerPage, facts: AnswerPageDeliveryFacts): AnswerPagePlan {
  if (page.state !== "active") return { type: "wait" };
  const content = answerStreamContent(view);
  const rendered = renderAnswerStreamPage(content, page.sourceStart, ANSWER_STREAM_PAGE_LIMIT);
  if (facts.continuationPending) return { type: "wait" };
  if (facts.latestContent?.state === "pending") return { type: "wait" };
  if (facts.latestContent?.state === "dead_letter") return { type: "wait" };
  if (typeof facts.latestContent?.sourceEnd === "number" && facts.latestContent.sourceEnd > page.sourceStart) {
    if (facts.latestContent.sourceEnd >= content.length) {
      if (view.phase === "completed" || view.phase === "failed") {
        if (facts.finishPending) return { type: "wait" };
        return { type: "finish-terminal", summary: view.phase === "completed" ? "Completed" : "Failed" };
      }
      return { type: "wait" };
    }
    const nextPageIndex = page.pageIndex + 1;
    return {
      type: "continue", currentSummary: `回答将在第 ${nextPageIndex + 1} 页继续`, nextPageIndex,
      nextPageStart: facts.latestContent.sourceEnd, nextElementId: answerElementId(view.promptId, nextPageIndex),
      initialContent: renderAnswerStreamPage(content, facts.latestContent.sourceEnd, ANSWER_STREAM_PAGE_LIMIT).page
    };
  }
  if (!rendered.page) {
    if (view.phase === "completed" || view.phase === "failed") {
      if (facts.finishPending) return { type: "wait" };
      return { type: "finish-terminal", summary: view.phase === "completed" ? "Completed" : "Failed" };
    }
    return { type: "wait" };
  }
  if (facts.latestContent?.content !== rendered.page) return { type: "stream-content", content: rendered.page };
  if (rendered.nextPageStart !== null) {
    if (facts.finishPending) return { type: "wait" };
    const nextPageIndex = page.pageIndex + 1;
    return {
      type: "continue", currentSummary: `回答将在第 ${nextPageIndex + 1} 页继续`, nextPageIndex,
      nextPageStart: rendered.nextPageStart, nextElementId: answerElementId(view.promptId, nextPageIndex),
      initialContent: renderAnswerStreamPage(content, rendered.nextPageStart, ANSWER_STREAM_PAGE_LIMIT).page
    };
  }
  if (view.phase === "completed" || view.phase === "failed") {
    if (facts.finishPending) return { type: "wait" };
    return { type: "finish-terminal", summary: view.phase === "completed" ? "Completed" : "Failed" };
  }
  return { type: "wait" };
}
