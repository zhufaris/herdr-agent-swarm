import type { RunCardView } from "../domain/run-card-view.js";
import { renderLarkMarkdownPage } from "./lark-markdown.js";

/**
 * A Lark streaming element is visually rendered as a whole-card refresh. Keep
 * the mutable portion intentionally short, then freeze it and continue in a
 * new card. This makes completed pages stable while preserving the durable
 * continuation/recovery protocol.
 */
export const ANSWER_STREAM_PAGE_LIMIT = 9_000;

interface RenderedAnswerStreamPage {
  page: string;
  nextPageStart: number | null;
}

export function answerStreamContent(view: RunCardView): string {
  const base = ["⏳ 已接收请求", view.answer].filter(Boolean).join("\n\n");
  return view.phase === "blocked" ? `${base}\n\n⚠️ ${view.notice ?? "等待用户处理"}`
    : view.phase === "failed" ? `${base}\n\n❌ ${view.notice ?? "执行失败"}` : base;
}

/** Builds a render-safe page without changing the canonical Answer stream. */
export function renderAnswerStreamPage(content: string, pageStart: number, limit = ANSWER_STREAM_PAGE_LIMIT): RenderedAnswerStreamPage {
  return renderLarkMarkdownPage(content, pageStart, limit);
}

export function splitAnswerStreamPage(content: string, limit = ANSWER_STREAM_PAGE_LIMIT): { page: string; remainder: string } {
  if (content.length <= limit) return { page: content, remainder: "" };
  const newline = content.lastIndexOf("\n", limit);
  const boundary = newline > Math.floor(limit * 0.6) ? newline : limit;
  const separator = content[boundary] === "\n" ? 1 : 0;
  return { page: content.slice(0, boundary), remainder: content.slice(boundary + separator) };
}
