import { stableElementId } from "./stable-element-id.js";
import type { QueueWaitFeedback } from "./queue-wait-estimate.js";
import type { PrimaryWorkerActivitySummary } from "./card-context-summary.js";
import type { AgentKind } from "./agent-instance.js";
import { applyAnswerTimelineDeltas, sameAnswerTimeline, terminalizeAnswerTimelineTools, type AnswerTimelineDelta, type AnswerTimelineItem } from "./answer-timeline.js";
import type { RunProjectionContext } from "./run-projection-context.js";
import { sameCurrentGoal, type CurrentGoal } from "./current-goal.js";

export type RunCardPhase = "queued" | "submitted" | "running" | "recovering" | "uncertain" | "blocked" | "completed" | "failed";
export type ProgressEventKind = "analyze" | "search" | "read" | "edit" | "command" | "test" | "skill" | "tool" | "step";
export type ProgressEventState = "pending" | "active" | "done" | "failed";

export interface RunProgressEvent {
  key: string;
  kind: ProgressEventKind;
  label: string;
  state: ProgressEventState;
  occurredAt: string;
}
export interface RunProgressSummary { total: number; stepTotal: number; stepDone: number }
export const EMPTY_PROGRESS_SUMMARY: RunProgressSummary = { total: 0, stepTotal: 0, stepDone: 0 };
export const RECENT_PROGRESS_LIMIT = 8;

export interface MainCardLiveStatus {
  statusTitle: string | null;
  planSteps: RunProgressEvent[];
  elapsedSeconds: number | null;
  tokenCount: number | null;
}

export interface RunCardView {
  promptId: string;
  bindingId: string;
  bindingGeneration: number;
  conversionParentPromptId: string | null;
  larkMessageId: string | null;
  answerMessageId: string | null;
  answerCardId: string | null;
  answerElementId: string;
  answerSequence: number;
  answerPageIndex: number;
  answerPageStart: number;
  phase: RunCardPhase;
  title: string;
  agentKind: AgentKind;
  sessionTitle?: string;
  requestText: string;
  replyContext?: string | null;
  workspaceId: string;
  spaceName: string;
  paneId: string | null;
  paneToken?: string | null;
  answer: string;
  answerSegments: string[];
  answerDraft: string;
  answerDraftTransient: boolean;
  timelineItems: AnswerTimelineItem[];
  progressEvents: RunProgressEvent[];
  /** Native Core Agent plan steps, intentionally distinct from tool activity. */
  taskList: RunProgressEvent[];
  /** Latest structured Core status line used only as the Task List heading. */
  taskListTitle: string | null;
  /** Read-only snapshot of Primary Session Goal state for mutable Answer pages. */
  currentGoal: CurrentGoal | null;
  progressSummary: RunProgressSummary;
  queuePosition: number;
  queueFeedback: QueueWaitFeedback | null;
  startedAt: string | null;
  finishedAt: string | null;
  notice: string | null;
  workerActivity: PrimaryWorkerActivitySummary[];
  workerDependencyRevision: number;
  workerContextFrozenAt: string | null;
  activityAt: string;
  viewVersion: number;
  deliveredVersion: number;
  answerDeliveredVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type RunCardChange =
  | { type: "display-context-refreshed"; occurredAt: string; context: Pick<RunProjectionContext, "sessionTitle" | "agentKind" | "spaceName" | "paneToken"> }
  | { type: "pane-token-refreshed"; occurredAt: string; paneToken: string }
  | { type: "queue-position"; occurredAt: string; queuePosition: number }
  | { type: "queue-feedback"; occurredAt: string; feedback: QueueWaitFeedback | null }
  | { type: "submitted"; occurredAt: string }
  | { type: "started"; occurredAt: string }
  | { type: "recovering"; occurredAt: string; notice: string }
  | { type: "uncertain"; occurredAt: string; notice: string }
  | { type: "blocked"; occurredAt: string; notice: string }
  | { type: "goal-snapshot"; occurredAt: string; currentGoal: CurrentGoal | null }
  | { type: "output"; occurredAt: string; answerSnapshot: string; previousAnswerSnapshot?: string; answerUpdate?: "append" | "replace" | "replace-status" | "replace-all"; progressEvents: RunProgressEvent[]; taskList?: RunProgressEvent[]; taskListTitle?: string | null; timelineDeltas?: AnswerTimelineDelta[]; hasProgressSnapshot?: boolean }
  | { type: "completed"; occurredAt: string; answer: string; replaceAnswer?: boolean }
  | { type: "failed"; occurredAt: string; notice: string };

type CreateQueuedRunCardInput = RunProjectionContext & {
  promptId: string; title: string; requestText: string;
  replyContext?: string | null;
  queuePosition: number; occurredAt: string; conversionParentPromptId?: string | null;
  currentGoal?: CurrentGoal | null;
};

export function createQueuedRunCard(input: CreateQueuedRunCardInput): RunCardView {
  return {
    promptId: input.promptId, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration ?? 1, conversionParentPromptId: input.conversionParentPromptId ?? null, larkMessageId: null, answerMessageId: null, answerCardId: null, answerElementId: answerElementId(input.promptId, 0), answerSequence: 0, answerPageIndex: 0, answerPageStart: 0, phase: "queued",
    title: input.title, ...(input.sessionTitle !== undefined ? { sessionTitle: input.sessionTitle } : {}), agentKind: input.agentKind ?? "traex", requestText: input.requestText, replyContext: input.replyContext ?? null, workspaceId: input.workspaceId, spaceName: input.spaceName?.trim() || "legacy/unresolved", paneId: input.paneId, paneToken: input.paneToken ?? null, answer: "", answerSegments: [], answerDraft: "", answerDraftTransient: false, timelineItems: [],
    progressEvents: [], taskList: [], taskListTitle: null, currentGoal: input.currentGoal ?? null, progressSummary: { ...EMPTY_PROGRESS_SUMMARY }, queuePosition: input.queuePosition, queueFeedback: null, startedAt: null, finishedAt: null, notice: null, workerActivity: [], workerDependencyRevision: 0, workerContextFrozenAt: null, activityAt: input.occurredAt,
    viewVersion: 1, deliveredVersion: 0, answerDeliveredVersion: 0, createdAt: input.occurredAt, updatedAt: input.occurredAt
  };
}

export function updateRunCardWorkerContext(state: RunCardView, activity: PrimaryWorkerActivitySummary[], dependencyRevision: number, occurredAt: string): RunCardView {
  if (state.workerContextFrozenAt !== null) return state;
  const same = JSON.stringify(state.workerActivity) === JSON.stringify(activity);
  if (same) return state.workerDependencyRevision === dependencyRevision ? state : { ...state, workerDependencyRevision: dependencyRevision, updatedAt: occurredAt };
  return { ...state, workerActivity: activity, workerDependencyRevision: dependencyRevision, viewVersion: state.viewVersion + 1, updatedAt: occurredAt };
}

export function freezeRunCardWorkerContext(state: RunCardView, occurredAt: string): RunCardView {
  return state.workerContextFrozenAt === null ? { ...state, workerContextFrozenAt: occurredAt, updatedAt: occurredAt } : state;
}

export function answerElementId(promptId: string, pageIndex: number): string {
  return stableElementId(`answer-content-${promptId}-${pageIndex}`);
}

export function reduceRunCard(state: RunCardView, change: RunCardChange): RunCardView {
  let patch: Partial<RunCardView>;
  switch (change.type) {
    case "display-context-refreshed": {
      const { sessionTitle, agentKind, spaceName, paneToken } = change.context;
      if (state.sessionTitle === sessionTitle && state.agentKind === agentKind && state.spaceName === spaceName && state.paneToken === paneToken) return state;
      patch = { sessionTitle, agentKind, spaceName, paneToken };
      break;
    }
    case "pane-token-refreshed":
      if (state.paneToken === change.paneToken) return state;
      patch = { paneToken: change.paneToken };
      break;
    case "queue-position":
      if (state.queuePosition === change.queuePosition) return state;
      patch = { queuePosition: change.queuePosition };
      break;
    case "queue-feedback":
      if (sameQueueFeedback(state.queueFeedback, change.feedback)) return state;
      patch = { queueFeedback: change.feedback };
      break;
    case "submitted":
      if (state.phase === "submitted" && state.notice === null) return state;
      patch = { phase: "submitted", queuePosition: 0, notice: null };
      break;
    case "started":
      if (state.phase === "running" && state.notice === null) return state;
      patch = { phase: "running", startedAt: state.startedAt ?? change.occurredAt, notice: null };
      break;
    case "recovering":
      if (state.phase === "recovering" && state.notice === change.notice) return state;
      patch = { phase: "recovering", queuePosition: 0, finishedAt: null, notice: change.notice };
      break;
    case "uncertain":
      if (state.phase === "uncertain" && state.notice === change.notice) return state;
      patch = { phase: "uncertain", timelineItems: terminalizeAnswerTimelineTools(state.timelineItems ?? []), finishedAt: change.occurredAt, queuePosition: 0, notice: change.notice };
      break;
    case "blocked":
      if (state.phase === "blocked" && state.notice === change.notice) return state;
      patch = { phase: "blocked", notice: change.notice };
      break;
    case "goal-snapshot":
      if (sameCurrentGoal(state.currentGoal, change.currentGoal)) return state;
      patch = { currentGoal: change.currentGoal };
      break;
    case "output": {
      const answerState = reduceAnswerSnapshot(state, change.answerSnapshot, change.answerUpdate ?? "replace");
      const answer = renderAnswer(answerState.answerSegments, answerState.answerDraft);
      const timelineItems = applyAnswerTimelineDeltas(state.timelineItems ?? [], change.timelineDeltas ?? []);
      const taskList = change.taskList === undefined ? state.taskList : progressSnapshot(change.taskList).events;
      const taskListTitle = change.taskListTitle === undefined ? state.taskListTitle : change.taskListTitle;
      const taskListUnchanged = sameProgress(taskList, state.taskList);
      if (change.hasProgressSnapshot) {
        const progress = progressSnapshot(change.progressEvents);
        if (answer === state.answer && sameAnswerTimeline(timelineItems, state.timelineItems ?? []) && sameProgress(progress.events, state.progressEvents) && sameProgressSummary(progress.summary, state.progressSummary) && taskListUnchanged && taskListTitle === state.taskListTitle) return state;
        patch = { answer, ...answerState, timelineItems, progressEvents: progress.events, progressSummary: progress.summary, ...(change.taskList === undefined ? {} : { taskList }), ...(change.taskListTitle === undefined ? {} : { taskListTitle }) };
        break;
      }
      const progress = mergeRecentProgress(state.progressEvents, state.progressSummary, change.progressEvents);
      if (answer === state.answer && sameAnswerTimeline(timelineItems, state.timelineItems ?? []) && sameProgress(progress.events, state.progressEvents) && sameProgressSummary(progress.summary, state.progressSummary) && taskListUnchanged && taskListTitle === state.taskListTitle) return state;
      patch = { answer, ...answerState, timelineItems, progressEvents: progress.events, progressSummary: progress.summary, ...(change.taskList === undefined ? {} : { taskList }), ...(change.taskListTitle === undefined ? {} : { taskListTitle }) };
      break;
    }
    case "completed":
      {
        const timelineItems = terminalizeAnswerTimelineTools(state.timelineItems ?? []);
        if (state.phase === "completed" && state.answer.trim() === change.answer.trim() && sameAnswerTimeline(timelineItems, state.timelineItems ?? [])) return state;
        patch = { phase: "completed", ...completeAnswer(state, change.answer, change.replaceAnswer === true), timelineItems, finishedAt: change.occurredAt, queuePosition: 0, notice: null };
      }
      break;
    case "failed":
      if (state.phase === "failed" && state.notice === change.notice) return state;
      patch = { phase: "failed", timelineItems: terminalizeAnswerTimelineTools(state.timelineItems ?? []), finishedAt: change.occurredAt, queuePosition: 0, notice: change.notice };
      break;
  }
  const activityAt = change.type === "display-context-refreshed" || change.type === "pane-token-refreshed" || change.type === "queue-position" || change.type === "queue-feedback" || change.type === "goal-snapshot" ? state.activityAt : change.occurredAt;
  return { ...state, ...patch, activityAt, viewVersion: state.viewVersion + 1, updatedAt: change.occurredAt };
}

export function progressSnapshot(events: readonly RunProgressEvent[]): { events: RunProgressEvent[]; summary: RunProgressSummary } {
  const latest = new Map<string, RunProgressEvent>();
  for (const event of events) { latest.delete(event.key); latest.set(event.key, event); }
  const all = [...latest.values()];
  return { events: all.slice(-RECENT_PROGRESS_LIMIT), summary: summarizeProgress(all) };
}

export function mergeRecentProgress(current: readonly RunProgressEvent[], summary: RunProgressSummary, updates: readonly RunProgressEvent[]): { events: RunProgressEvent[]; summary: RunProgressSummary } {
  if (updates.length === 0) return { events: [...current], summary };
  const events = [...current];
  const next = { ...summary };
  for (const event of updates) {
    const position = events.findIndex((candidate) => candidate.key === event.key);
    if (position >= 0) {
      const previous = events[position]!;
      if (previous.kind === "step" && previous.state === "done" && event.state !== "done") next.stepDone -= 1;
      if (previous.kind === "step" && previous.state !== "done" && event.state === "done") next.stepDone += 1;
      events[position] = event;
    } else {
      events.push(event);
      next.total += 1;
      if (event.kind === "step") { next.stepTotal += 1; if (event.state === "done") next.stepDone += 1; }
    }
  }
  return { events: events.slice(-RECENT_PROGRESS_LIMIT), summary: next };
}

export function summarizeProgress(events: readonly RunProgressEvent[]): RunProgressSummary {
  let stepTotal = 0; let stepDone = 0;
  for (const event of events) if (event.kind === "step") { stepTotal += 1; if (event.state === "done") stepDone += 1; }
  return { total: events.length, stepTotal, stepDone };
}

function sameQueueFeedback(left: QueueWaitFeedback | null, right: QueueWaitFeedback | null): boolean {
  if (left === right) return true;
  return left !== null && right !== null && left.aheadCount === right.aheadCount && left.activeElapsedSeconds === right.activeElapsedSeconds
    && left.estimateLowerSeconds === right.estimateLowerSeconds && left.estimateUpperSeconds === right.estimateUpperSeconds
    && left.sampleCount === right.sampleCount && left.elapsedBucket === right.elapsedBucket;
}

type AnswerParts = Pick<RunCardView, "answerSegments" | "answerDraft" | "answerDraftTransient">;

function answerParts(state: RunCardView): AnswerParts {
  if (Array.isArray(state.answerSegments) && typeof state.answerDraft === "string") {
    return { answerSegments: state.answerSegments, answerDraft: state.answerDraft, answerDraftTransient: state.answerDraftTransient === true };
  }
  return { answerSegments: state.answer.trim() ? [state.answer.trim()] : [], answerDraft: "", answerDraftTransient: false };
}

function reduceAnswerSnapshot(state: RunCardView, snapshot: string, update: "append" | "replace" | "replace-status" | "replace-all"): AnswerParts {
  const current = answerParts(state);
  const next = snapshot.trim();
  if (!next) return current;
  if (update === "replace-all") return { answerSegments: [], answerDraft: next, answerDraftTransient: false };
  if (update === "replace-status") {
    const answerSegments = current.answerDraftTransient ? current.answerSegments : commitSegment(current.answerSegments, current.answerDraft);
    return { answerSegments, answerDraft: next, answerDraftTransient: true };
  }
  if (update === "replace") return { ...current, answerDraft: next, answerDraftTransient: false };
  const answerSegments = current.answerDraftTransient ? current.answerSegments : commitSegment(current.answerSegments, current.answerDraft);
  return { answerSegments, answerDraft: next, answerDraftTransient: false };
}

function completeAnswer(state: RunCardView, finalAnswer: string, replace: boolean): Pick<RunCardView, "answer" | "answerSegments" | "answerDraft" | "answerDraftTransient"> {
  const current = answerParts(state);
  const finalValue = finalAnswer.trim();
  if (finalValue === state.answer.trim()) return { answer: state.answer, ...current };
  if (replace) return { answerSegments: finalValue ? [finalValue] : [], answerDraft: "", answerDraftTransient: false, answer: finalValue };
  const draft = current.answerDraft.trim();
  let answerSegments = current.answerSegments;
  if (!current.answerDraftTransient && draft && !finalValue.startsWith(draft)) answerSegments = commitSegment(answerSegments, draft);
  answerSegments = commitSegment(answerSegments, finalValue || draft);
  return { answerSegments, answerDraft: "", answerDraftTransient: false, answer: renderAnswer(answerSegments, "") };
}

function commitSegment(segments: string[], segment: string): string[] {
  const value = segment.trim();
  if (!value || segments.at(-1) === value) return segments;
  return [...segments, value];
}

function renderAnswer(segments: string[], draft: string): string {
  return [...segments, draft.trim()].filter(Boolean).join("\n\n");
}

function sameProgress(left: RunProgressEvent[], right: RunProgressEvent[]): boolean {
  return left.length === right.length && left.every((event, index) => {
    const other = right[index];
    return other !== undefined && event.key === other.key && event.kind === other.kind && event.label === other.label && event.state === other.state;
  });
}
function sameProgressSummary(left: RunProgressSummary, right: RunProgressSummary): boolean {
  return left.total === right.total && left.stepTotal === right.stepTotal && left.stepDone === right.stepDone;
}
