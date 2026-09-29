import type { AnswerTimelineItem } from "../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../domain/delivery.js";
import type { RunProgressEvent } from "../domain/run-card-view.js";
import type { RichTextDocument } from "../domain/rich-text.js";
import { displayPaneIdentity } from "../domain/pane-display-identity.js";
import { answerStatusPresentation, answerToolPresentation } from "./answer-presentation.js";
import { renderLarkMarkdownPage } from "./lark-markdown.js";
import { redactSecrets } from "./redact-secrets.js";

export const ANSWER_RICH_TEXT_PAGE_LIMIT = 12_000;
export const ANSWER_TYPEWRITER_CURSOR = "💭";
export const ANSWER_PLACEHOLDER = `正在生成… ${ANSWER_TYPEWRITER_CURSOR}`;
export const ANSWER_RICH_TEXT_MIN_INTERVAL_MS = 500;
export const ANSWER_RICH_TEXT_MIN_DELTA = 8;
export const ANSWER_RICH_TEXT_MAX_LATENCY_MS = 1_200;

const TOOL_LABEL_LIMIT = 160;
const TOOL_COMMAND_LIMIT = 1_000;
const TOOL_PREVIEW_LIMIT = 240;
const TASK_STEP_LIMIT = 240;
const TASK_LIST_VISIBLE_STEPS = 5;
const ANSWER_TITLE_LIMIT = 200;
const ANSI = /[\u001B\u009B][[\]\(\)#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const TASK_STATE = { pending: "◻", active: "■", done: "✔", failed: "✕" } as const;

export interface RichTextAnswerPage {
  document: RichTextDocument;
  items: AnswerTimelineItem[];
  nextCursor: AnswerTimelineCursor | null;
}

export interface RichTextAnswerMetadata {
  projectId?: string | null | undefined;
  paneId?: string | null | undefined;
  paneToken?: string | null | undefined;
  workerName?: string | null | undefined;
  taskTitle?: string | null | undefined;
}

export interface RichTextAnswerTerminalSummary {
  state: "completed" | "failed" | "cancelled" | "dispatch-uncertain";
  startedAt?: string | null;
  finishedAt?: string | null;
}

export function richTextAnswerTitle(metadata: RichTextAnswerMetadata, pageIndex: number): string {
  const project = safeTitleSegment(metadata.projectId, 72, "未知项目");
  const pane = safeTitleSegment(displayPaneIdentity(metadata, "未知 Pane"), 64, "未知 Pane");
  const worker = metadata.workerName ? safeTitleSegment(metadata.workerName, 48, "Worker") : "";
  const task = metadata.taskTitle ? safeTitleSegment(metadata.taskTitle, 80, "") : "";
  const parts = [`🤖 ${project}`, pane, worker, task, pageIndex > 0 ? `第 ${pageIndex + 1} 页` : ""].filter(Boolean);
  return truncateInline(parts.join(" · "), ANSWER_TITLE_LIMIT);
}

export function planRichTextAnswerPage(
  items: readonly AnswerTimelineItem[],
  cursor: AnswerTimelineCursor | null,
  options: { active: boolean; pageIndex: number; limit?: number; prefixItems?: readonly AnswerTimelineItem[]; terminalNotice?: string | null; progressEvents?: readonly RunProgressEvent[]; metadata?: RichTextAnswerMetadata; activityFrame?: number; terminalSummary?: RichTextAnswerTerminalSummary }
): RichTextAnswerPage {
  const safeItems = options.active ? items.map(safeStreamingItem) : [...items];
  const safePrefix = options.active ? (options.prefixItems ?? []).map(safeStreamingItem) : options.prefixItems ?? [];
  const footer = taskListMarkdown(options.progressEvents ?? []);
  const activityMarker = answerActivityMarker(options.activityFrame ?? 0);
  const terminalSummary = options.active ? "" : terminalSummaryMarkdown(options.terminalSummary);
  const suffixBudget = footer.length + terminalSummary.length + (options.active ? activityMarker.length + 4 : 0) + (options.terminalNotice?.length ?? 0) + 12;
  const pageLimit = Math.max(1, (options.limit ?? ANSWER_RICH_TEXT_PAGE_LIMIT) - suffixBudget);
  const page = planRichTextTimelinePage(safeItems, cursor, pageLimit, safePrefix);
  const body = markdownFromTimelineItems(page.items);
  const sections: string[] = [];
  if (body) sections.push(body);
  else if (options.active) sections.push("正在生成…");
  if (terminalSummary) sections.push(terminalSummary);
  if (!options.active && options.terminalNotice) sections.push(`⚠️ ${safeInline(options.terminalNotice, TOOL_PREVIEW_LIMIT)}`);
  if (footer) sections.push(footer);
  if (options.active) sections.push(activityMarker);
  const markdown = sections.join("\n\n").trim() || "任务已结束，未生成可展示内容。";
  return {
    document: { ...(options.metadata ? { title: richTextAnswerTitle(options.metadata, options.pageIndex) } : options.pageIndex > 0 ? { title: `回答（第 ${options.pageIndex + 1} 页）` } : {}), markdown },
    items: page.items,
    nextCursor: page.nextCursor
  };
}

function planRichTextTimelinePage(
  items: readonly AnswerTimelineItem[],
  cursor: AnswerTimelineCursor | null,
  limit: number,
  prefixItems: readonly AnswerTimelineItem[]
): { items: AnswerTimelineItem[]; nextCursor: AnswerTimelineCursor | null } {
  const ordered = [...items].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  const pageItems: AnswerTimelineItem[] = [];
  let renderedLength = 0;
  const append = (item: AnswerTimelineItem, markdown: string): boolean => {
    const addition = markdown.length + (renderedLength > 0 && markdown ? 2 : 0);
    if (renderedLength > 0 && renderedLength + addition > limit) return false;
    pageItems.push(item);
    renderedLength += addition;
    return true;
  };
  for (const item of prefixItems) {
    const markdown = markdownFromTimelineItem(item);
    if (!append(item, markdown)) break;
  }

  let itemIndex = Math.max(0, cursor?.itemIndex ?? 0);
  let markdownOffset = Math.max(0, cursor?.markdownOffset ?? 0);
  while (itemIndex < ordered.length) {
    const item = ordered[itemIndex]!;
    if (item.kind === "agent_message" || item.kind === "final_answer") {
      const separatorLength = renderedLength > 0 ? 2 : 0;
      const available = Math.max(1, limit - renderedLength - separatorLength);
      const rendered = renderLarkMarkdownPage(item.markdown, markdownOffset, available);
      if (rendered.page) {
        if (!append({ ...item, markdown: rendered.page }, rendered.page)) return { items: pageItems, nextCursor: { itemIndex, markdownOffset } };
      }
      if (rendered.nextPageStart !== null) return { items: pageItems, nextCursor: { itemIndex, markdownOffset: rendered.nextPageStart } };
      itemIndex += 1;
      markdownOffset = 0;
      continue;
    }

    const markdown = markdownFromTimelineItem(item);
    if (!append(item, markdown)) return { items: pageItems, nextCursor: { itemIndex, markdownOffset: 0 } };
    itemIndex += 1;
  }
  return { items: pageItems, nextCursor: null };
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
  const elapsedMs = nowMs - Date.parse(previousUpdatedAt);
  if (Number.isFinite(elapsedMs) && elapsedMs < ANSWER_RICH_TEXT_MIN_INTERVAL_MS) return false;
  let previous = "";
  try {
    const decoded = JSON.parse(previousPayload) as { document?: { markdown?: unknown } };
    if (typeof decoded.document?.markdown === "string") previous = withoutCursor(decoded.document.markdown);
  } catch { return true; }
  const current = withoutCursor(next.markdown);
  if (current === previous) return false;
  if (!Number.isFinite(elapsedMs)) return true;
  if (!current.startsWith(previous)) return true;
  const delta = current.slice(previous.length);
  return delta.length >= ANSWER_RICH_TEXT_MIN_DELTA
    || hasSemanticBoundary(delta)
    || (Number.isFinite(elapsedMs) && elapsedMs >= ANSWER_RICH_TEXT_MAX_LATENCY_MS && delta.length > 0);
}

function withoutCursor(markdown: string): string {
  return markdown.replace(/\s*💭·{0,3}\s*$/u, "");
}

function hasSemanticBoundary(delta: string): boolean {
  return delta.includes("\n") || /[.!?。！？；;：:]\s*$/u.test(delta);
}

function answerActivityMarker(frame: number): string {
  return `${ANSWER_TYPEWRITER_CURSOR}${"·".repeat(Math.abs(Math.trunc(frame)) % 4)}`;
}

function safeStreamingItem(item: AnswerTimelineItem): AnswerTimelineItem {
  return item.kind === "agent_message" || item.kind === "final_answer"
    ? { ...item, markdown: safeStreamingMarkdown(item.markdown) }
    : item;
}

function markdownFromTimelineItems(items: readonly AnswerTimelineItem[]): string {
  return items.map(markdownFromTimelineItem).filter(Boolean).join("\n\n").trim();
}

function markdownFromTimelineItem(item: AnswerTimelineItem): string {
  if (item.kind === "agent_message") return item.markdown.trim();
  if (item.kind === "final_answer") {
    const markdown = item.markdown.trim();
    return markdown ? `✅ **最终回答**\n\n${markdown}` : "";
  }
  if (item.kind === "status") {
    return answerStatusPresentation(item).title;
  }
  const view = answerToolPresentation(item);
  const command = view.command ? bashCommandBlock(view.command) : "";
  const preview = compactPreview(view.result, item.state);
  return [view.title, command, preview ? `> └ ${preview}` : ""].filter(Boolean).join(command ? "\n\n" : "\n");
}

function bashCommandBlock(value: string): string {
  const command = truncateInline(redactSecrets(stripAnsi(value)).replace(/\r\n?/g, "\n").trim(), TOOL_COMMAND_LIMIT);
  if (!command) return "";
  const longestBacktickRun = [...command.matchAll(/`+/g)].reduce((longest, match) => Math.max(longest, match[0].length), 0);
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}bash\n${command}\n${fence}`;
}

function compactPreview(value: string | undefined, state: "running" | "succeeded" | "failed"): string {
  if (!value) return "";
  const lines = redactSecrets(stripAnsi(value)).replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (lines.length === 0) return "";
  if (state === "failed" && lines.length > 1) {
    const omitted = Math.max(0, lines.length - 2);
    return truncateMiddleInline(`${lines[0]}${omitted ? ` …（省略 ${omitted} 行）… ` : " … "}${lines.at(-1)!}`, TOOL_PREVIEW_LIMIT);
  }
  const omitted = lines.length - 1;
  return truncateInline(`${lines.at(-1)!}${omitted ? ` （前 ${omitted} 行已省略）` : ""}`, TOOL_PREVIEW_LIMIT);
}

function taskListMarkdown(events: readonly RunProgressEvent[]): string {
  const latest = new Map<string, RunProgressEvent>();
  for (const event of events) {
    if (!event.key.startsWith("plan:")) continue;
    latest.delete(event.key);
    latest.set(event.key, event);
  }
  const steps = [...latest.values()];
  if (steps.length === 0) return "";
  const completed = steps.filter((step) => step.state === "done").length;
  const important = steps.filter((step) => step.state === "active" || step.state === "failed");
  const visible = steps.length <= TASK_LIST_VISIBLE_STEPS ? steps : important.length ? important : steps.slice(-1);
  const hidden = steps.length - visible.length;
  const lines = [`---`, `📋 **任务 ${completed}/${steps.length}**`];
  if (hidden > 0) lines.push(`- … ${hidden} 个其他步骤`);
  for (const step of visible) lines.push(`- ${TASK_STATE[step.state]} ${safeInline(step.label, TASK_STEP_LIMIT)}`);
  return lines.join("\n");
}

function terminalSummaryMarkdown(summary: RichTextAnswerTerminalSummary | undefined): string {
  if (!summary) return "";
  const label = {
    completed: "✅ 已完成",
    failed: "❌ 执行失败",
    cancelled: "⏹️ 已取消",
    "dispatch-uncertain": "⚠️ 状态不确定"
  }[summary.state];
  const duration = elapsedDuration(summary.startedAt, summary.finishedAt);
  return ["---", [label, duration ? `用时 ${duration}` : null].filter(Boolean).join(" · ")].join("\n");
}

function elapsedDuration(startedAt: string | null | undefined, finishedAt: string | null | undefined): string | null {
  if (!startedAt || !finishedAt) return null;
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const seconds = Math.floor(elapsed / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : null, minutes ? `${minutes}m` : null, `${remainder}s`].filter(Boolean).join(" ");
}

function safeInline(value: string, limit: number): string {
  return truncateInline(redactSecrets(stripAnsi(value)).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim(), limit);
}

function safeTitleSegment(value: string | null | undefined, limit: number, fallback: string): string {
  const safe = value ? safeInline(value, limit) : "";
  return safe || fallback;
}

function truncateInline(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function truncateMiddleInline(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const headLength = Math.ceil((limit - 1) / 2);
  const tailLength = Math.floor((limit - 1) / 2);
  return `${value.slice(0, headLength).trimEnd()}…${value.slice(-tailLength).trimStart()}`;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}
