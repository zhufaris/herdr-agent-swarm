import type { AnswerTimelineItem } from "../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../domain/delivery.js";
import type { ConversationSegmentState } from "../domain/conversation-segment.js";
import type { CompletionActionSetRenderState } from "../domain/completion-action-set.js";
import { summarizeProgress, type RunProgressEvent } from "../domain/run-card-view.js";
import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { completionActionElements } from "./completion-actions.js";
import { planAnswerTimelinePage } from "./answer-timeline-page.js";
import { renderProgressTimeline } from "./progress-timeline.js";
import type { SessionActivityView } from "../domain/session-activity.js";
import type { TurnSessionStateView } from "../domain/turn-session-state.js";
import type { SegmentCompletionReason } from "../domain/ports/conversation-segment.js";
import { renderSessionActivity, renderTurnSessionState } from "./session-activity.js";

export interface ConversationSegmentCardView {
  segmentId: string;
  ownerKind: "primary" | "worker";
  ownerLabel: string;
  spaceName: string;
  projectLabel: string;
  tabLabel: string | null;
  paneToken: string | null;
  model?: string | null;
  requestText: string;
  state: ConversationSegmentState;
  timelineItems: readonly AnswerTimelineItem[];
  gapWarning: string | null;
  viewVersion: number;
  currentGoal?: { objective: string; status?: string } | null;
  taskList?: readonly { label: string; state?: string }[];
}

export interface ConversationSegmentCardPage {
  pageIndex: number;
  elementId?: string;
  /** Cursor returned by the preceding page planner; page zero starts at null. */
  startCursor?: AnswerTimelineCursor | null;
  /** Alias accepted for callers that name the durable page cursor simply `cursor`. */
  cursor?: AnswerTimelineCursor | null;
}

export interface TurnCardRenderOptions {
  timelineItems?: readonly AnswerTimelineItem[];
  continuation?: boolean;
  completionActions?: CompletionActionSetRenderState | null;
  completionActionsBudget?: CompletionActionSetRenderState | null;
  completionNotice?: { mentionOpenId: string; reason: SegmentCompletionReason } | null;
  completionNoticeBudget?: { mentionOpenId: string; reason: SegmentCompletionReason } | null;
  sessionActivity?: SessionActivityView | null;
  sessionState?: TurnSessionStateView | null;
  runtimeIdentity?: { branch: string | null; gitCommit: string | null } | null;
}

export class TurnCardPayloadOverflowError extends Error {
  readonly code = "TURN_CARD_PAYLOAD_OVERFLOW";
  constructor(readonly payloadLimit: number, readonly serializedLength: number) {
    super(`Turn Card payload exceeds configured limit (${serializedLength} > ${payloadLimit})`);
    this.name = "TurnCardPayloadOverflowError";
  }
}

export class TurnCardPresentationBudgetError extends Error {
  readonly code = "TURN_CARD_PRESENTATION_BUDGET_EXCEEDED";
  constructor(readonly dimension: "elementCount" | "actionCount", readonly limit: number, readonly actual: number) {
    super(`Turn Card ${dimension} exceeds configured limit (${actual} > ${limit})`);
    this.name = "TurnCardPresentationBudgetError";
  }
}

const ANSI = /[\u001B\u009B][[\]\(\)#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const STATE: Record<ConversationSegmentState, { label: string; color: string }> = {
  pending: { label: "Pending", color: "orange" },
  working: { label: "Working", color: "blue" },
  completed: { label: "Completed", color: "green" },
  failed: { label: "Failed", color: "red" },
  cancelled: { label: "Cancelled", color: "grey" },
  needs_human: { label: "Needs attention", color: "orange" },
  closed: { label: "已转交后续输入", color: "blue" }
};

/** The source-neutral Answer-style shell for one canonical Human turn. */
export function renderTurnCard(view: ConversationSegmentCardView, page: ConversationSegmentCardPage = { pageIndex: 0 }, options: TurnCardRenderOptions = {}, payloadLimit = 12_000): object {
  return planAndRenderTurnCard(view, page, options, payloadLimit).card;
}

/** Plans and renders one Turn Card page from the same canonical cursor exactly once. */
export function planAndRenderTurnCard(view: ConversationSegmentCardView, page: ConversationSegmentCardPage = { pageIndex: 0 }, options: TurnCardRenderOptions = {}, payloadLimit = 12_000): { card: object; items: AnswerTimelineItem[]; nextCursor: AnswerTimelineCursor | null } {
  const status = STATE[view.state];
  const pageIndex = Math.max(0, page.pageIndex);
  const requestTitle = safeInline(view.requestText, 67) || "—";
  const replyTitle = `reply to 👤: ${requestTitle}`;
  const sessionIdentity = options.sessionState?.paneIdentity;
  const paneIdentityParts = sessionIdentity
    ? [view.projectLabel, sessionIdentity.worktreeName]
    : [view.projectLabel, view.tabLabel, view.paneToken];
  const paneIdentity = paneIdentityParts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => safeInline(part, 160))
    .join(" / ");
  const titleModel = options.sessionState?.modelUsage.model ?? view.model;
  const stableIdentity = titleModel?.trim()
    ? `${paneIdentity || "HERDR HUMAN TURN"} · Model: ${safeInline(titleModel, 96)}`
    : paneIdentity;
  const identity = pageIndex > 0
    ? `${stableIdentity || "HERDR HUMAN TURN"}  ·  第 ${pageIndex + 1} 页`
    : stableIdentity;
  const titleIdentity = identity || "HERDR HUMAN TURN";
  const title = `${status.label} · ${titleIdentity}`;
  const items = options.timelineItems ?? view.timelineItems;
  const elements: object[] = [
    ...(view.gapWarning ? [{ tag: "column_set", background_style: "orange-50", columns: [{ tag: "column", width: "weighted", weight: 1, elements: [{ tag: "markdown", content: safeInline(view.gapWarning, 1_500) }] }] }] : []),
    ...(view.state === "closed" ? [{
      tag: "markdown",
      content: "**已转交后续输入**\n本次请求未单独生成最终回复，后续输入已在新的 Turn Card 中继续处理。"
    }] : [])
  ];
  const trailing: object[] = [];
  if (view.currentGoal?.objective) trailing.push({ tag: "markdown", content: `**🎯 Goal · ${safeInline(view.currentGoal.status ?? "In progress", 80)}**\n${safeMarkdown(view.currentGoal.objective, 2_000)}` });
  trailing.push(...taskListElements(view));
  if (options.sessionState) trailing.push(...renderTurnSessionState(options.sessionState));
  else if (options.sessionActivity) trailing.push(...renderSessionActivity(options.sessionActivity));
  const completionActions = completionActionElements(options.completionActions);
  const completion = [...completionActions, ...completionNoticeElements(options.completionNotice)];
  const prominentCompletion = completionActions.length > 0 ? completion : [];
  const trailingCompletion = completionActions.length > 0 ? [] : completion;
  const budgetTrailing = [
    ...completion,
    ...trailing,
    ...(!options.completionActions && options.completionActionsBudget ? completionActionElements(options.completionActionsBudget) : []),
    ...(!options.completionNotice && options.completionNoticeBudget ? completionNoticeElements(options.completionNoticeBudget) : [])
  ];
  // Planner accounting includes the timeline element array but not the outer
  // CardKit envelope/headers. Keep a conservative envelope reserve so the
  // final serialized card remains within the configured limit.
  const timelineBudget = Math.max(1, payloadLimit - JSON.stringify({ header: { replyTitle }, elements: [...elements, ...budgetTrailing] }).length - 1_024);
  const planned = planTurnCardTimeline(items, page, timelineBudget);
  const timeline = planned.elements;
  if (planned.nextCursor !== null) appendContinuationMarker(timeline);
  if (page.elementId && timeline.length > 0) attachElementId(timeline, page.elementId);
  elements.push(...prominentCompletion, ...timeline, ...trailingCompletion, ...trailing);
  const card = {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, streaming_mode: ["pending", "working"].includes(view.state), summary: { content: `${status.label} · ${safeInline(view.requestText, 80)}` } },
    header: {
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: replyTitle },
      template: status.color
    },
    body: { elements }
  };
  boundCardPayload(card, payloadLimit);
  return { card, items: planned.items, nextCursor: planned.nextCursor };
}

function completionNoticeElements(notice: { mentionOpenId: string; reason: SegmentCompletionReason } | null | undefined): object[] {
  if (!notice) return [];
  const text = notice.reason === "final_request" ? "请查看本卡片。" : "需要你的选择。";
  return [{ tag: "markdown", content: `<at id=${notice.mentionOpenId}></at> ${text}` }];
}

function appendContinuationMarker(elements: object[]): void {
  const marker = "\n\n… 内容已截断；后续内容将在下一张 Turn Card 显示。";
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index] as Record<string, unknown>;
    if (element.tag === "markdown" && typeof element.content === "string") {
      element.content = `${element.content}${marker}`;
      return;
    }
    if (Array.isArray(element.elements)) { appendContinuationMarker(element.elements.filter((item): item is object => typeof item === "object" && item !== null)); return; }
  }
}

/** Exposes the deterministic page/cursor calculation for durable page reservation tests. */
export function planTurnCardTimeline(items: readonly AnswerTimelineItem[], page: ConversationSegmentCardPage = { pageIndex: 0 }, payloadLimit = 9_000) {
  return planAnswerTimelinePage(items, page.startCursor ?? page.cursor ?? null, payloadLimit);
}

/**
 * Last-resort CardKit boundary. Planner slices remain authoritative; this only
 * bounds rendered text when fixed sections leave too little room for one
 * indivisible timeline element. The marker makes truncation explicit.
 */
function boundCardPayload(card: { body: { elements: object[] } }, payloadLimit: number): void {
  const envelopeLength = JSON.stringify({ ...card, body: { elements: [] } }).length;
  const target = Math.max(1, payloadLimit - envelopeLength);
  if (JSON.stringify(card.body.elements).length <= target) return;
  const marker = "\n\n… 内容已截断；后续内容将在下一张 Turn Card 显示。";
  const candidates: Array<{ owner: { content: string }; prefix: string; suffix: string }> = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string" && (record.tag === "markdown" || record.tag === "plain_text")) {
      const content = record.content;
      candidates.push({ owner: record as { content: string }, prefix: "", suffix: "" });
      if (content.length > marker.length) return;
    }
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit); else visit(child);
    }
  };
  visit(card.body.elements);
  while (JSON.stringify(card.body.elements).length > target) {
    const candidate = candidates.sort((left, right) => right.owner.content.length - left.owner.content.length)[0];
    if (!candidate || candidate.owner.content.length <= marker.length + 1) break;
    const keep = Math.max(1, candidate.owner.content.length - Math.max(32, Math.ceil((JSON.stringify(card.body.elements).length - target) * 1.2)));
    candidate.owner.content = `${candidate.owner.content.slice(0, Math.max(1, keep - marker.length))}${marker}`;
  }
  if (JSON.stringify(card).length <= payloadLimit) return;

  // Fixed/action-only content can leave no shrinkable text. Preserve the
  // identity-bearing shell and replace the body with a deterministic marker.
  card.body.elements = [{ tag: "markdown", content: "⚠️ Turn Card 内容超出配置上限；请继续查看后续页面。" }];
  const overflow = JSON.stringify(card).length;
  if (overflow > payloadLimit) throw new TurnCardPayloadOverflowError(payloadLimit, overflow);
}

function safeMarkdown(value: string, limit: number): string {
  return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value).replace(ANSI, "")), limit) || "—";
}

function safeInline(value: string, limit: number): string {
  const normalized = redactSecrets(value).replace(/[\u001B\u009B][[\]\(\)#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  const budget = Math.max(0, limit - 1);
  let prefix = "";
  for (const character of normalized) {
    if (prefix.length + character.length > budget) break;
    prefix += character;
  }
  return `${prefix}…`;
}

function taskListElements(view: ConversationSegmentCardView): object[] {
  if (!view.taskList?.length) return [];
  const events: RunProgressEvent[] = view.taskList.map((task, index) => ({
    key: `turn-task:${index}`,
    kind: "step",
    label: safeInline(task.label, 400),
    state: taskProgressState(task.state),
    occurredAt: ""
  }));
  return renderProgressTimeline(events, taskListPhase(view.state), {
    title: "📋 Task List",
    summary: summarizeProgress(events),
    visibleCount: events.length,
    expanded: true
  });
}

function taskProgressState(state: string | undefined): RunProgressEvent["state"] {
  if (["done", "completed", "succeeded"].includes(state ?? "")) return "done";
  if (["active", "in_progress", "running"].includes(state ?? "")) return "active";
  if (["failed", "error", "blocked"].includes(state ?? "")) return "failed";
  return "pending";
}

function taskListPhase(state: ConversationSegmentState): string {
  if (state === "working") return "running";
  if (state === "completed") return "completed";
  if (state === "needs_human") return "blocked";
  return state;
}

function attachElementId(elements: object[], elementId: string): boolean {
  for (const element of elements) {
    if ((element as { tag?: string }).tag === "markdown") { (element as Record<string, unknown>).element_id = elementId; return true; }
    const nested = (element as { elements?: unknown }).elements;
    if (Array.isArray(nested) && attachElementId(nested.filter((item): item is object => typeof item === "object" && item !== null), elementId)) return true;
  }
  return false;
}
