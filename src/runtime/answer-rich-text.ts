import type { AnswerTimelineItem } from "../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../domain/delivery.js";
import type { RunProgressEvent } from "../domain/run-card-view.js";
import type { RichTextDocument } from "../domain/rich-text.js";
import { displayPaneIdentity } from "../domain/pane-display-identity.js";
import { planAnswerTimelinePage } from "../cards/answer-timeline-page.js";
import { redactSecrets } from "./redact-secrets.js";

export const ANSWER_RICH_TEXT_PAGE_LIMIT = 9_000;
export const ANSWER_TYPEWRITER_CURSOR = "▌";
export const ANSWER_PLACEHOLDER = `正在生成… ${ANSWER_TYPEWRITER_CURSOR}`;
export const ANSWER_RICH_TEXT_MIN_INTERVAL_MS = 1_000;
export const ANSWER_RICH_TEXT_MIN_DELTA = 48;

const TOOL_LABEL_LIMIT = 160;
const TOOL_PREVIEW_LIMIT = 240;
const TASK_STEP_LIMIT = 240;
const TASK_LIST_VISIBLE_STEPS = 5;
const ANSWER_TITLE_LIMIT = 200;
const ANSI = /[\u001B\u009B][[\]\(\)#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const TOOL_CATEGORY = {
  read: { icon: "📖", label: "Read" },
  search: { icon: "🔍", label: "Search" },
  edit: { icon: "✏️", label: "Edit" },
  command: { icon: "⚙️", label: "Ran" },
  test: { icon: "🧪", label: "Test" },
  step: { icon: "🛠️", label: "Step" }
} as const;

const TOOL_STATE = { running: "…", succeeded: "✓", failed: "✗" } as const;
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
}

export function richTextAnswerTitle(metadata: RichTextAnswerMetadata, pageIndex: number): string {
  const project = safeTitleSegment(metadata.projectId, 72, "未知项目");
  const pane = safeTitleSegment(displayPaneIdentity(metadata, "未知 Pane"), 64, "未知 Pane");
  const worker = metadata.workerName ? safeTitleSegment(metadata.workerName, 48, "Worker") : "";
  const parts = [`🤖 ${project}`, pane, worker, pageIndex > 0 ? `续 ${pageIndex + 1}` : ""].filter(Boolean);
  return truncateInline(parts.join(" · "), ANSWER_TITLE_LIMIT);
}

export function planRichTextAnswerPage(
  items: readonly AnswerTimelineItem[],
  cursor: AnswerTimelineCursor | null,
  options: { active: boolean; pageIndex: number; limit?: number; prefixItems?: readonly AnswerTimelineItem[]; terminalNotice?: string | null; progressEvents?: readonly RunProgressEvent[]; metadata?: RichTextAnswerMetadata }
): RichTextAnswerPage {
  const safeItems = options.active ? items.map(safeStreamingItem) : [...items];
  const safePrefix = options.active ? (options.prefixItems ?? []).map(safeStreamingItem) : options.prefixItems ?? [];
  const footer = taskListMarkdown(options.progressEvents ?? []);
  const suffixBudget = footer.length + (options.active ? ANSWER_TYPEWRITER_CURSOR.length + 4 : 0) + (options.terminalNotice?.length ?? 0) + 8;
  const pageLimit = Math.max(1, (options.limit ?? ANSWER_RICH_TEXT_PAGE_LIMIT) - suffixBudget);
  const page = planAnswerTimelinePage(safeItems, cursor, pageLimit, safePrefix);
  const body = markdownFromTimelineItems(page.items);
  const sections: string[] = [];
  if (body) sections.push(body);
  else if (options.active) sections.push("正在生成…");
  if (!options.active && options.terminalNotice) sections.push(`⚠️ ${safeInline(options.terminalNotice, TOOL_PREVIEW_LIMIT)}`);
  if (footer) sections.push(footer);
  if (options.active) sections.push(ANSWER_TYPEWRITER_CURSOR);
  const markdown = sections.join("\n\n").trim() || "任务已结束，未生成可展示内容。";
  return {
    document: { ...(options.metadata ? { title: richTextAnswerTitle(options.metadata, options.pageIndex) } : options.pageIndex > 0 ? { title: `回答（续 ${options.pageIndex + 1}）` } : {}), markdown },
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

function markdownFromTimelineItems(items: readonly AnswerTimelineItem[]): string {
  return items.map(markdownFromTimelineItem).filter(Boolean).join("\n\n").trim();
}

function markdownFromTimelineItem(item: AnswerTimelineItem): string {
  if (item.kind === "agent_message" || item.kind === "final_answer") return item.markdown.trim();
  if (item.kind === "status") {
    const status = item.state === "blocked"
      ? "⚠️ 等待用户处理"
      : item.state === "failed" ? "❌ 执行失败" : "⏳ 处理中";
    return `${status} · ${safeInline(item.label, TOOL_LABEL_LIMIT)}`;
  }
  const category = TOOL_CATEGORY[item.category] ?? TOOL_CATEGORY.step;
  const source = item.category === "command" && item.command ? inlineCode(item.command) : safeInline(item.label, TOOL_LABEL_LIMIT);
  const summary = `${category.icon} ${category.label} · ${source} · ${TOOL_STATE[item.state]}`;
  const preview = compactPreview(item.resultPreview);
  return preview ? `${summary}\n> └ ${preview}` : summary;
}

function compactPreview(value: string | undefined): string {
  if (!value) return "";
  const lines = redactSecrets(stripAnsi(value)).replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (lines.length === 0) return "";
  const suffix = lines.length > 1 ? ` …（省略 ${lines.length - 1} 行）` : "";
  return truncateInline(`${lines[0]}${suffix}`, TOOL_PREVIEW_LIMIT);
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
  const visible = steps.slice(-TASK_LIST_VISIBLE_STEPS);
  const hidden = steps.length - visible.length;
  const lines = [`---`, `📋 **任务 ${completed}/${steps.length}**`];
  if (hidden > 0) lines.push(`- … ${hidden} 个较早步骤`);
  for (const step of visible) lines.push(`- ${TASK_STATE[step.state]} ${safeInline(step.label, TASK_STEP_LIMIT)}`);
  return lines.join("\n");
}

function inlineCode(value: string): string {
  return `\`${safeInline(value, TOOL_LABEL_LIMIT).replace(/`/g, "'")}\``;
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

function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}
