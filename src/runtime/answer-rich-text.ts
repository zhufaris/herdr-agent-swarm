import type { AnswerTimelineItem } from "../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../domain/delivery.js";
import type { RichTextDocument } from "../domain/rich-text.js";
import { planAnswerTimelinePage } from "../cards/answer-timeline-page.js";
import type { FinalAnswerElement } from "../cards/final-answer-content.js";

export const ANSWER_RICH_TEXT_PAGE_LIMIT = 9_000;
export const ANSWER_TYPEWRITER_CURSOR = "▌";
export const ANSWER_PLACEHOLDER = `正在生成… ${ANSWER_TYPEWRITER_CURSOR}`;
export const ANSWER_RICH_TEXT_MIN_INTERVAL_MS = 1_000;
export const ANSWER_RICH_TEXT_MIN_DELTA = 48;

export interface RichTextAnswerPage {
  document: RichTextDocument;
  items: AnswerTimelineItem[];
  nextCursor: AnswerTimelineCursor | null;
}

export function planRichTextAnswerPage(
  items: readonly AnswerTimelineItem[],
  cursor: AnswerTimelineCursor | null,
  options: { active: boolean; pageIndex: number; limit?: number; prefixItems?: readonly AnswerTimelineItem[]; terminalNotice?: string | null }
): RichTextAnswerPage {
  const safeItems = options.active ? items.map(safeStreamingItem) : [...items];
  const safePrefix = options.active ? (options.prefixItems ?? []).map(safeStreamingItem) : options.prefixItems ?? [];
  const page = planAnswerTimelinePage(safeItems, cursor, options.limit ?? ANSWER_RICH_TEXT_PAGE_LIMIT, safePrefix);
  const body = markdownFromAnswerElements(page.elements);
  const notice = !options.active && options.terminalNotice ? `\n\n⚠️ ${options.terminalNotice}` : "";
  const markdown = options.active
    ? `${body || "正在生成…"}\n\n${ANSWER_TYPEWRITER_CURSOR}`
    : `${body}${notice}`.trim() || "任务已结束，未生成可展示内容。";
  return {
    document: { ...(options.pageIndex > 0 ? { title: `回答（续 ${options.pageIndex + 1}）` } : {}), markdown },
    items: page.items,
    nextCursor: page.nextCursor
  };
}

export function safeStreamingMarkdown(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let offset = 0;
  let openFenceStart: number | null = null;
  let fenceLength = 0;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,})/.exec(line)?.[1];
    if (marker) {
      if (openFenceStart === null) { openFenceStart = offset; fenceLength = marker.length; }
      else if (new RegExp(`^ {0,3}\`{${fenceLength},}\\s*$`).test(line)) { openFenceStart = null; fenceLength = 0; }
    }
    offset += line.length + 1;
  }
  let end = openFenceStart ?? normalized.length;
  const prefix = normalized.slice(0, end);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  const tail = prefix.slice(lineStart);
  const ticks = [...tail.matchAll(/(?<!\\)`/g)];
  if (ticks.length % 2 === 1) end = Math.min(end, lineStart + ticks.at(-1)!.index!);
  const candidate = normalized.slice(0, end);
  const openLink = candidate.lastIndexOf("[");
  const closedLink = candidate.lastIndexOf("]");
  if (openLink > closedLink) end = openLink;
  else {
    const linkTarget = candidate.lastIndexOf("](");
    if (linkTarget >= 0 && candidate.indexOf(")", linkTarget + 2) < 0) end = candidate.lastIndexOf("[", linkTarget);
  }
  return normalized.slice(0, Math.max(0, end)).trimEnd();
}

export function shouldRefreshRichText(previousPayload: string, next: RichTextDocument, previousUpdatedAt: string, nowMs = Date.now()): boolean {
  if (nowMs - Date.parse(previousUpdatedAt) < ANSWER_RICH_TEXT_MIN_INTERVAL_MS) return false;
  let previous = "";
  try {
    const decoded = JSON.parse(previousPayload) as { document?: { markdown?: unknown } };
    if (typeof decoded.document?.markdown === "string") previous = withoutCursor(decoded.document.markdown);
  } catch { return true; }
  const current = withoutCursor(next.markdown);
  const delta = current.startsWith(previous) ? current.slice(previous.length) : current;
  return delta.length >= ANSWER_RICH_TEXT_MIN_DELTA || /\n\s*$/.test(delta);
}

function withoutCursor(markdown: string): string {
  return markdown.replace(/\s*▌\s*$/, "");
}

function safeStreamingItem(item: AnswerTimelineItem): AnswerTimelineItem {
  return item.kind === "agent_message" || item.kind === "final_answer"
    ? { ...item, markdown: safeStreamingMarkdown(item.markdown) }
    : item;
}

function markdownFromAnswerElements(elements: readonly FinalAnswerElement[]): string {
  return elements.flatMap(markdownFromElement).filter(Boolean).join("\n\n").trim();
}

function markdownFromElement(element: FinalAnswerElement): string[] {
  if (element.tag === "markdown" && typeof element.content === "string") return [element.content];
  if (element.tag === "hr") return ["---"];
  if (element.tag !== "collapsible_panel") return [];
  const header = record(element.header);
  const title = record(header?.title)?.content;
  const nested = Array.isArray(element.elements) ? element.elements.flatMap((value) => {
    const item = record(value);
    return item && typeof item.tag === "string" ? markdownFromElement(item as FinalAnswerElement) : [];
  }) : [];
  const heading = typeof title === "string" ? `> **${title}**` : "> **工具活动**";
  const detail = nested.join("\n\n");
  return [detail ? `${heading}\n\n${detail}` : heading];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
