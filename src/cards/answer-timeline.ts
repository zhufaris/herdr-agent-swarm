import type { AnswerTimelineItem, AnswerTimelineToolCategory, AnswerTimelineToolState } from "../domain/answer-timeline.js";
import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { answerToolPresentation } from "../runtime/answer-presentation.js";
import { appendWithinCardLimit, MAX_CARD_SERIALIZED_LENGTH } from "./card-payload.js";
import type { FinalAnswerElement } from "./final-answer-content.js";

const TIMELINE_OMISSION = "… 后续活动将在下一张 Answer Card 显示。";
const ANSI = /[\u001B\u009B][[\]\(\)#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** Renders a canonical Answer timeline without knowing its Primary or Worker card shell. */
export function renderAnswerTimeline(items: readonly AnswerTimelineItem[], payloadLimit = MAX_CARD_SERIALIZED_LENGTH): FinalAnswerElement[] {
  const elements: FinalAnswerElement[] = [];
  const ordered = [...items].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  for (const item of ordered) {
    if (item.kind === "status") continue;
    const rendered = renderAnswerTimelineItem(item, payloadLimit);
    if (appendWithinCardLimit(elements, rendered, 0, payloadLimit)) {
      elements.push(...rendered);
      continue;
    }
    const omission = { tag: "markdown", content: TIMELINE_OMISSION };
    if (appendWithinCardLimit(elements, [omission], 0, payloadLimit)) elements.push(omission);
    break;
  }
  return elements;
}

/** Renders one indivisible timeline item for item-aware page planning. */
export function renderAnswerTimelineItem(item: AnswerTimelineItem, payloadLimit = MAX_CARD_SERIALIZED_LENGTH): FinalAnswerElement[] {
  if (item.kind === "agent_message" || item.kind === "final_answer") {
    const content = safeMarkdown(item.markdown, Math.max(1, payloadLimit - 100));
    if (!content) return [];
    return [{ tag: "markdown", content: item.kind === "final_answer" ? `✅ **最终回答**\n\n${content}` : content }];
  }
  if (item.kind === "tool") return [renderTool(item, payloadLimit)];
  return [];
}

function renderTool(item: Extract<AnswerTimelineItem, { kind: "tool" }>, payloadLimit: number): FinalAnswerElement {
  const view = answerToolPresentation(item);
  const panel = (resultLimit: number): FinalAnswerElement => ({
    tag: "collapsible_panel", expanded: false, border: { color: view.border, corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: view.title } },
    elements: [{ tag: "markdown", content: toolDetail(view, resultLimit) }]
  });
  const resultLength = [...view.result].length;
  let rendered = panel(resultLength);
  if (JSON.stringify(rendered).length <= payloadLimit) return rendered;
  let low = 0;
  let high = resultLength;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = panel(middle);
    if (JSON.stringify(candidate).length <= payloadLimit) { rendered = candidate; low = middle + 1; }
    else high = middle - 1;
  }
  return rendered;
}

function toolDetail(view: ReturnType<typeof answerToolPresentation>, resultLimit: number): string {
  const result = truncateToolResult(view.result, resultLimit);
  const sections: string[] = [];
  if (view.command) sections.push(fencedBlock("bash", view.command));
  if (result) sections.push(fencedBlock("text", result));
  return sections.join("\n\n") || view.empty;
}

function truncateToolResult(value: string, limit: number): string {
  const characters = [...value];
  if (characters.length <= limit) return value;
  const suffix = "\n… 内容已截断，请在对应 Herdr Pane 查看完整内容。";
  if (limit <= [...suffix].length) return [...suffix].slice(0, limit).join("");
  return `${characters.slice(0, limit - [...suffix].length).join("").trimEnd()}${suffix}`;
}

function fencedBlock(language: string, value: string): string {
  const longestBacktickRun = [...value.matchAll(/`+/gu)].reduce((longest, match) => Math.max(longest, match[0].length), 0);
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function safeMarkdown(value: string, limit: number): string {
  return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(stripAnsi(value))), limit);
}

function stripAnsi(value: string): string { return value.replace(ANSI, ""); }
