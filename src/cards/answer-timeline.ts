import type { AnswerTimelineItem, AnswerTimelineToolCategory, AnswerTimelineToolState } from "../domain/answer-timeline.js";
import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { appendWithinCardLimit, MAX_CARD_SERIALIZED_LENGTH } from "./card-payload.js";
import type { FinalAnswerElement } from "./final-answer-content.js";

const TOOL_DETAIL_LIMIT = 4_000;
const TOOL_LABEL_LIMIT = 160;
const TIMELINE_OMISSION = "… 后续活动将在下一张 Answer Card 显示。";
const ANSI = /[\u001B\u009B][[\]\(\)#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const TOOL_CATEGORY: Record<AnswerTimelineToolCategory, { icon: string; label: string }> = {
  read: { icon: "📖", label: "Read" },
  search: { icon: "🔍", label: "Search" },
  edit: { icon: "✏️", label: "Edit" },
  command: { icon: "⚙️", label: "Command" },
  test: { icon: "🧪", label: "Test" },
  step: { icon: "🛠️", label: "Step" }
};

const TOOL_STATE: Record<AnswerTimelineToolState, { border: string; label: string; empty: string }> = {
  running: { border: "blue", label: "… 运行中", empty: "工具仍在运行，暂无可展示结果。" },
  succeeded: { border: "grey", label: "✓ 完成", empty: "工具已完成，无可展示输出。" },
  failed: { border: "red", label: "✗ 失败", empty: "工具执行失败，无可展示详情。" }
};

/** Renders a canonical Answer timeline without knowing its Primary or Worker card shell. */
export function renderAnswerTimeline(items: readonly AnswerTimelineItem[], payloadLimit = MAX_CARD_SERIALIZED_LENGTH): FinalAnswerElement[] {
  const elements: FinalAnswerElement[] = [];
  const ordered = [...items].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  for (const item of ordered) {
    const rendered = renderAnswerTimelineItem(item, payloadLimit);
    if (appendWithinCardLimit(elements, rendered, 800, payloadLimit)) {
      elements.push(...rendered);
      continue;
    }
    const omission = { tag: "markdown", content: TIMELINE_OMISSION };
    if (appendWithinCardLimit(elements, [omission], 800, payloadLimit)) elements.push(omission);
    break;
  }
  return elements;
}

/** Renders one indivisible timeline item for item-aware page planning. */
export function renderAnswerTimelineItem(item: AnswerTimelineItem, payloadLimit = MAX_CARD_SERIALIZED_LENGTH): FinalAnswerElement[] {
  if (item.kind === "agent_message" || item.kind === "final_answer") {
    const content = safeMarkdown(item.markdown, Math.max(1, payloadLimit - 100));
    return content ? [{ tag: "markdown", content }] : [];
  }
  if (item.kind === "tool") return [renderTool(item, payloadLimit)];
  const view = item.state === "blocked"
    ? { icon: "⚠️", label: "等待用户处理", color: "orange" }
    : item.state === "failed"
      ? { icon: "❌", label: "执行失败", color: "red" }
      : { icon: "⏳", label: "处理中", color: "blue" };
  return [{
    tag: "collapsible_panel", expanded: false, border: { color: view.color, corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: `${view.icon} ${view.label} · ${safeInline(item.label, TOOL_LABEL_LIMIT)}` } },
    elements: [{ tag: "markdown", content: safeMarkdown(item.label, TOOL_DETAIL_LIMIT) || view.label }]
  }];
}

function renderTool(item: Extract<AnswerTimelineItem, { kind: "tool" }>, payloadLimit: number): FinalAnswerElement {
  const category = TOOL_CATEGORY[item.category] ?? TOOL_CATEGORY.step;
  const state = TOOL_STATE[item.state];
  const title = `${category.icon} ${category.label} · ${safeInline(item.label, TOOL_LABEL_LIMIT)} · ${state.label}`;
  const panel = (resultLimit: number): FinalAnswerElement => ({
    tag: "collapsible_panel", expanded: false, border: { color: state.border, corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: title } },
    elements: [{ tag: "markdown", content: toolDetail(item, state.empty, resultLimit) }]
  });
  let rendered = panel(TOOL_DETAIL_LIMIT);
  if (JSON.stringify(rendered).length <= payloadLimit) return rendered;
  let low = 0;
  let high = TOOL_DETAIL_LIMIT;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = panel(middle);
    if (JSON.stringify(candidate).length <= payloadLimit) { rendered = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return rendered;
}

function toolDetail(item: Extract<AnswerTimelineItem, { kind: "tool" }>, empty: string, resultLimit: number): string {
  const command = item.command ? safeFence(item.command, 1_000) : "";
  const result = item.resultPreview ? safeFence(item.resultPreview, resultLimit) : "";
  const sections: string[] = [];
  if (command) sections.push(`\`\`\`bash\n${command}\n\`\`\``);
  if (result) sections.push(`\`\`\`text\n${result}\n\`\`\``);
  return sections.join("\n\n") || empty;
}

function safeMarkdown(value: string, limit: number): string {
  return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(stripAnsi(value))), limit);
}

function safeFence(value: string, limit: number): string {
  const safe = redactSecrets(stripAnsi(value)).replace(/```/g, "'''");
  if (safe.length <= limit) return safe;
  const suffix = "\n… 内容已截断，请在对应 Herdr Pane 查看完整内容。";
  return `${safe.slice(0, Math.max(0, limit - suffix.length)).trimEnd()}${suffix}`;
}

function safeInline(value: string, limit: number): string {
  const safe = redactSecrets(stripAnsi(value)).replace(/[\r\n]+/g, " " ).replace(/\s+/g, " " ).trim();
  return safe.length <= limit ? safe : `${safe.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function stripAnsi(value: string): string { return value.replace(ANSI, ""); }
