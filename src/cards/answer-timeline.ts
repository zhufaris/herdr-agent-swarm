import { assertCanonicalTimelineOrder, type AnswerTimelineItem, type AnswerTimelineToolState } from "../domain/answer-timeline.js";
import { normalizeLarkPreview, truncateLarkMarkdown, truncateLarkMarkdownMiddle } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { projectAnswerToolRenderGroupAt, projectAnswerToolRenderModel, type AnswerToolRenderGroup, type AnswerToolRenderModel } from "./answer-tool-render-ports.js";
import { appendWithinCardLimit, MAX_CARD_SERIALIZED_LENGTH } from "./card-payload.js";
import type { FinalAnswerElement } from "./final-answer-content.js";
import { normalizeFinalTraceEnvelope } from "../domain/final-trace-envelope.js";

const TOOL_DETAIL_LIMIT = 4_000;
const TOOL_COMMAND_LIMIT = 1_200;
const TOOL_LABEL_LIMIT = 160;
const TOOL_RESULT_LINE_LIMIT = 3;
const PREVIEW_LINE_CHAR_LIMIT = 500;
const THINKING_SOURCE_LIMIT = 6_000;
const THINKING_HEAD_LIMIT = 3_000;
const THINKING_TAIL_LIMIT = 3_000;
const TIMELINE_OMISSION = "… 后续活动将在下一张 Answer Card 显示。";
const RUNNING_TOOL_FRAMES = ["🔄", "⏳", "⌛"] as const;
const ANSI = /[\u001B\u009B][[\]\(\)#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const TOOL_STATE: Record<AnswerTimelineToolState, { border: string; label: string; empty: string }> = {
  running: { border: "blue", label: "… 运行中", empty: "工具仍在运行，暂无可展示结果。" },
  succeeded: { border: "grey", label: "✓ 完成", empty: "工具已完成，无可展示输出。" },
  failed: { border: "red", label: "✗ 失败", empty: "工具执行失败，无可展示详情。" }
};

const TIMEOUT_TOOL_STATE = { border: "orange", label: "⏱ 超时", empty: "工具执行超时，无可展示详情。" };

/** Renders a canonical Answer timeline without knowing its Primary or Worker card shell. */
export function renderAnswerTimeline(items: readonly AnswerTimelineItem[], payloadLimit = MAX_CARD_SERIALIZED_LENGTH, animationFrame?: number): FinalAnswerElement[] {
  const elements: FinalAnswerElement[] = [];
  const ordered = prepareAnswerTimelineItems(items);
  for (let index = 0; index < ordered.length; index += 1) {
    const item = ordered[index]!;
    if (item.kind === "human_message") continue;
    const group = projectAnswerToolRenderGroupAt(ordered, index);
    const rendered = group ? [renderAnswerToolGroup(group.model, payloadLimit, animationFrame)] : renderAnswerTimelineItem(item, payloadLimit, false, animationFrame);
    if (appendWithinCardLimit(elements, rendered, 800, payloadLimit)) {
      elements.push(...rendered);
      if (group) index += group.childCount;
      continue;
    }
    const omission = { tag: "markdown", content: TIMELINE_OMISSION };
    if (appendWithinCardLimit(elements, [omission], 800, payloadLimit)) elements.push(omission);
    break;
  }
  return elements;
}

/** Renders one indivisible timeline item for item-aware page planning. */
export function renderAnswerTimelineItem(item: AnswerTimelineItem, payloadLimit = MAX_CARD_SERIALIZED_LENGTH, preserveToolDetail = false, animationFrame?: number): FinalAnswerElement[] {
  if (item.kind === "human_message") return [];
  if (item.kind === "agent_message" || item.kind === "final_answer") {
    const content = safeMarkdown(item.markdown, Math.max(1, payloadLimit - 100));
    return content ? [{ tag: "markdown", content }] : [];
  }
  if (item.kind === "thinking") {
    const label = safeInline(item.label, TOOL_LABEL_LIMIT);
    const markdown = thinkingDisplayMarkdown(item.markdown ?? item.label);
    return label && markdown ? [{
      tag: "collapsible_panel", expanded: false, border: { color: "grey", corner_radius: "6px" },
      header: { title: { tag: "plain_text", content: `💭 思考 · ${label}` } },
      elements: [{ tag: "markdown", content: markdown }]
    }] : [];
  }
  if (item.kind === "tool") {
    const model = projectAnswerToolRenderModel(item);
    return model ? [renderTool(model, payloadLimit, preserveToolDetail, animationFrame)] : [];
  }
  const view = statusView(item);
  const detail = item.detail
    ? `${item.detail}${item.detailTruncated ? "\n\n… source event truncated" : ""}`
    : item.label;
  return [{
    tag: "collapsible_panel", expanded: false, border: { color: view.color, corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: `${view.icon} ${view.label} · ${safeInline(item.label, TOOL_LABEL_LIMIT)}` } },
    elements: [{ tag: "markdown", content: safeMarkdown(detail, Math.max(1, payloadLimit - 800)) || view.label }]
  }];
}

function statusView(item: Extract<AnswerTimelineItem, { kind: "status" }>): { icon: string; label: string; color: string } {
  if (item.id.startsWith("agent:")) {
    if (item.state === "completed") return { icon: "✅", label: "Agent completed", color: "green" };
    if (item.state === "blocked") return { icon: "⚠️", label: "Agent waiting", color: "orange" };
    if (item.state === "interrupted") return { icon: "⏹️", label: "Agent interrupted", color: "grey" };
    if (item.state === "failed") return { icon: "❌", label: "Agent failed", color: "red" };
    return { icon: "⏳", label: "Agent running", color: "blue" };
  }
  if (item.state === "blocked") return { icon: "⚠️", label: "等待用户处理", color: "orange" };
  if (item.state === "failed") return { icon: "❌", label: "执行失败", color: "red" };
  if (item.state === "cancelled") return { icon: "⏹️", label: "已取消", color: "grey" };
  if (item.state === "warning") return { icon: "⚠️", label: "数据完整性提示", color: "orange" };
  if (item.state === "completed") return { icon: "✅", label: "已完成", color: "green" };
  if (item.state === "interrupted") return { icon: "⏹️", label: "已中断", color: "grey" };
  return { icon: "⏳", label: "处理中", color: "blue" };
}

function renderTool(model: AnswerToolRenderModel, payloadLimit: number, preserveDetail: boolean, animationFrame?: number): FinalAnswerElement {
  const icon = animatedToolIcon(model.icon, model.state, animationFrame);
  const state = toolState(model.state, model.outcome);
  if (model.semantic && (model.state === "running" || model.state === "succeeded")) {
    return { tag: "markdown", content: `${icon} ${safeInline(model.label, TOOL_LABEL_LIMIT)} · ${safeInline(model.target, TOOL_LABEL_LIMIT)} · ${state.label}` };
  }
  if (model.summary && !model.command && !model.result && !model.diff && !model.outcome) {
    return { tag: "markdown", content: `${icon} ${safeInline(model.summary, TOOL_LABEL_LIMIT * 2)}` };
  }
  const group = model.groupChildCount ? ` · ${model.groupChildCount} operations` : "";
  const nested = model.nested ? "↳ " : "";
  const context = model.context ? ` · ${safeInline(model.context, TOOL_LABEL_LIMIT)}` : "";
  const title = model.semantic
    ? `${icon} ${safeInline(model.label, TOOL_LABEL_LIMIT)} · ${safeInline(model.target, TOOL_LABEL_LIMIT)} · ${state.label}`
    : model.summary
    ? `${icon} ${safeInline(model.summary, TOOL_LABEL_LIMIT * 2)}`
    : `${icon} ${model.label} · ${nested}${safeInline(model.target, TOOL_LABEL_LIMIT)}${context}${group} · ${state.label}`;
  const panel = (resultLimit: number): FinalAnswerElement => ({
    tag: "collapsible_panel", expanded: model.outcome === "failure" || model.outcome === "timeout", border: { color: state.border, corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: title } },
    elements: [{ tag: "markdown", content: toolDetail(model, state.empty, resultLimit) }]
  });
  let rendered = panel(preserveDetail ? payloadLimit : TOOL_DETAIL_LIMIT);
  if (JSON.stringify(rendered).length <= payloadLimit) return rendered;
  let low = 0;
  let high = preserveDetail ? payloadLimit : TOOL_DETAIL_LIMIT;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = panel(middle);
    if (JSON.stringify(candidate).length <= payloadLimit) { rendered = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return rendered;
}

export function renderAnswerToolGroup(model: AnswerToolRenderGroup, payloadLimit: number, animationFrame?: number): FinalAnswerElement {
  const state = toolState(model.state, model.outcome);
  const icon = animatedToolIcon(model.members[0]?.icon ?? "🔧", model.state, animationFrame);
  const title = `${icon} ${safeInline(model.summary, TOOL_LABEL_LIMIT * 2)}${model.outcome === "timeout" ? " · ⏱ 超时" : ""}`;
  const panel = (detailLimit: number): FinalAnswerElement => ({
    tag: "collapsible_panel", expanded: model.outcome === "failure" || model.outcome === "timeout", border: { color: state.border, corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: title } },
    elements: [{ tag: "markdown", content: toolGroupDetail(model, detailLimit) }]
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

function toolState(state: AnswerTimelineToolState, outcome?: "failure" | "timeout"): { border: string; label: string; empty: string } {
  return outcome === "timeout" ? TIMEOUT_TOOL_STATE : TOOL_STATE[state];
}

function animatedToolIcon(icon: string, state: AnswerTimelineToolState, animationFrame?: number): string {
  if (state !== "running" || animationFrame === undefined) return icon;
  const frame = RUNNING_TOOL_FRAMES[Math.abs(Math.trunc(animationFrame)) % RUNNING_TOOL_FRAMES.length]!;
  return `${frame} ${icon}`;
}

function toolGroupDetail(model: AnswerToolRenderGroup, detailLimit: number): string {
  const members = model.outcome
    ? model.members.filter((member) => member.state === "failed" || member.outcome === "timeout")
    : model.members;
  const memberLimit = Math.max(1, Math.floor(detailLimit / members.length));
  return members.map((member) => {
    const heading = `${member.label} ${safeInline(member.target, TOOL_LABEL_LIMIT * 2)}`;
    const command = member.command ? safeCommandMarkdown(member.command, Math.min(memberLimit, TOOL_COMMAND_LIMIT)) : "";
    const result = member.result ? safeFence(member.result, memberLimit) : "";
    const diff = member.diff ? safeFence(member.diff, memberLimit) : "";
    const sections = model.outcome && member.resultSummaryText ? [`**Summary**\n\n${safeFence(member.resultSummaryText, memberLimit)}`, heading] : [heading];
    if (command) sections.push(`**Command**\n\n\`\`\`bash\n${command}\n\`\`\``);
    if (result) sections.push(`**Result**\n\n\`\`\`text\n${result}\n\`\`\``);
    if (diff) sections.push(`**Diff**\n\n\`\`\`diff\n${diff}\n\`\`\``);
    return sections.join("\n\n");
  }).join("\n\n");
}

function toolDetail(model: AnswerToolRenderModel, empty: string, resultLimit: number): string {
  const command = model.command ? safeCommandMarkdown(model.command, Math.min(resultLimit, TOOL_COMMAND_LIMIT)) : "";
  const result = model.result ? safeFence(model.result, resultLimit) : "";
  const diff = model.diff ? safeFence(model.diff, resultLimit) : "";
  const sections: string[] = [];
  if (model.outcome && model.resultSummaryText) sections.push(`**Summary**\n\n${safeFence(model.resultSummaryText, resultLimit)}`);
  if (command) sections.push(`**Command**\n\n\`\`\`bash\n${command}\n\`\`\``);
  if (result) sections.push(`**Result**\n\n\`\`\`text\n${result}\n\`\`\``);
  if (diff) sections.push(`**Diff**\n\n\`\`\`diff\n${diff}\n\`\`\``);
  const detail = sections.join("\n\n") || empty;
  return model.continuation ? `**续**\n\n${detail}` : detail;
}

function safeMarkdown(value: string, limit: number): string {
  return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(stripAnsi(value))), limit);
}

function thinkingDisplayMarkdown(value: string): string {
  const normalized = normalizeLarkPreview(redactSecrets(stripAnsi(value)));
  if (normalized.length <= THINKING_SOURCE_LIMIT) return normalized;
  const omitted = normalized.slice(THINKING_HEAD_LIMIT, normalized.length - THINKING_TAIL_LIMIT);
  const omittedLines = omitted ? omitted.split("\n").length : 0;
  const marker = `… 已省略中间 ${omittedLines} 行 / ${omitted.length} 个字符 …`;
  return `${normalized.slice(0, THINKING_HEAD_LIMIT)}\n\n${marker}\n\n${normalized.slice(-THINKING_TAIL_LIMIT)}`;
}

function safeCommandMarkdown(value: string, limit: number): string {
  return truncateLarkMarkdownMiddle(redactSecrets(stripAnsi(value)).replace(/```/g, "'''"), limit);
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

/** Adds render-only nesting and removes only child detail proven byte-identical inside its parent. */
export function prepareAnswerTimelineItems(items: readonly AnswerTimelineItem[]): AnswerTimelineItem[] {
  assertCanonicalTimelineOrder(items);
  const ordered = [...items];
  const finalMarkdown = new Set(ordered.filter((item) => item.kind === "final_answer").map((item) => visibleAssistantMarkdown(item.markdown)));
  const children = new Map<string, Array<Extract<AnswerTimelineItem, { kind: "tool" }>>>();
  for (const item of ordered) {
    if (item.kind !== "tool" || !item.parentToolId) continue;
    const group = children.get(item.parentToolId) ?? []; group.push(item); children.set(item.parentToolId, group);
  }
  return ordered.map((item) => {
    if (item.kind === "agent_message") {
      const markdown = visibleAssistantMarkdown(item.markdown);
      return { ...item, markdown: finalMarkdown.has(markdown) ? "" : progressMessage(markdown) };
    }
    if (item.kind === "final_answer") return { ...item, markdown: visibleAssistantMarkdown(item.markdown) };
    if (item.kind !== "tool") return item;
    if (item.parentToolId) return compactToolResult({ ...item, nested: true });
    const nested = children.get(item.id) ?? [];
    if (nested.length === 0) return compactToolResult(item);
    let result = item.result ?? item.resultPreview;
    if (result) for (const child of nested) {
      const duplicate = child.result ?? child.resultPreview;
      if (duplicate && result.includes(duplicate)) result = result.replace(duplicate, "").replace(/^\s+|\s+$/g, "");
    }
    const groupState = nested.some((child) => child.state === "failed")
      ? "failed"
      : nested.some((child) => child.state === "running") ? "running" : item.state;
    const base = { ...item, state: groupState, groupChildCount: nested.length };
    delete base.result; delete base.resultPreview;
    return compactToolResult(result ? { ...base, result } : base);
  });
}

function compactToolResult(item: Extract<AnswerTimelineItem, { kind: "tool" }>): Extract<AnswerTimelineItem, { kind: "tool" }> {
  const result = item.result ?? item.resultPreview;
  const command = item.command ? safeCommandMarkdown(item.command, TOOL_COMMAND_LIMIT) : undefined;
  if (!result && !command) return item;
  const compact = result ? compactToolPreview(result) : undefined;
  const copy = { ...item, ...(command ? { command } : {}), ...(compact !== undefined ? { result: compact } : {}) };
  delete copy.resultPreview;
  return copy;
}

function compactToolPreview(value: string, stripExecutionWrapper = true): string {
  const normalized = normalizePreviewText(value);
  const output = trimBlankPreviewLines(stripExecutionWrapper ? stripCommandExecutionWrapper(normalized) : normalized);
  if (!output) return "";
  if (/^… \+\d+ lines omitted$/m.test(output)) return output;
  const lines = output.split("\n");
  const visible = lines.length <= TOOL_RESULT_LINE_LIMIT * 2
    ? lines
    : [
        ...lines.slice(0, TOOL_RESULT_LINE_LIMIT),
        `… +${lines.length - TOOL_RESULT_LINE_LIMIT * 2} lines omitted`,
        ...lines.slice(-TOOL_RESULT_LINE_LIMIT)
      ];
  return visible.map(compactPreviewLine).join("\n");
}

function stripCommandExecutionWrapper(value: string): string {
  const lines = value.split("\n");
  if (lines[0] !== "Script completed" || !lines[1]?.startsWith("Wall time ") || lines[2] !== "Output:") return value;
  return lines.slice(3).join("\n");
}

function progressMessage(markdown: string): string {
  if (!markdown) return "";
  if (markdown.startsWith("🤖")) return markdown;
  return `🤖${markdown}`;
}

function normalizedAssistantMarkdown(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

function visibleAssistantMarkdown(value: string): string {
  return normalizedAssistantMarkdown(normalizeFinalTraceEnvelope({ finalMarkdown: value }).presentationMarkdown);
}

function normalizePreviewText(value: string): string {
  const safe = redactSecrets(stripAnsi(value)).replace(/\r\n?/g, "\n");
  return safe.endsWith("\n") ? safe.slice(0, -1) : safe;
}

function trimBlankPreviewLines(value: string): string {
  const lines = value.split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return lines.join("\n");
}

function compactPreviewLine(line: string): string {
  if (line.length <= PREVIEW_LINE_CHAR_LIMIT) return line;
  return `${line.slice(0, PREVIEW_LINE_CHAR_LIMIT)}… +${line.length - PREVIEW_LINE_CHAR_LIMIT} chars omitted`;
}
