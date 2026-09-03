import { stableElementId } from "./stable-element-id.js";
import type { QueueWaitFeedback } from "./queue-wait-estimate.js";

export type RunCardPhase = "queued" | "running" | "blocked" | "completed" | "failed";
export type SteeringFailureKind = "rejected" | "uncertain";
export type RunCardSteeringOrigin = "explicit" | "automatic" | "converted";
export type ProgressEventKind = "analyze" | "search" | "read" | "edit" | "test" | "step";
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
  steeringOrigin: RunCardSteeringOrigin | null;
  steeringFailureKind: SteeringFailureKind | null;
  larkMessageId: string | null;
  answerMessageId: string | null;
  answerCardId: string | null;
  answerElementId: string;
  answerSequence: number;
  answerPageIndex: number;
  answerPageStart: number;
  phase: RunCardPhase;
  title: string;
  sessionTitle?: string;
  requestText: string;
  workspaceId: string;
  spaceName: string;
  paneId: string | null;
  answer: string;
  answerSegments: string[];
  answerDraft: string;
  answerDraftTransient: boolean;
  progressEvents: RunProgressEvent[];
  progressSummary: RunProgressSummary;
  queuePosition: number;
  queueFeedback: QueueWaitFeedback | null;
  startedAt: string | null;
  finishedAt: string | null;
  notice: string | null;
  activityAt: string;
  viewVersion: number;
  deliveredVersion: number;
  answerDeliveredVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type RunCardChange =
  | { type: "queue-position"; occurredAt: string; queuePosition: number }
  | { type: "queue-feedback"; occurredAt: string; feedback: QueueWaitFeedback | null }
  | { type: "started"; occurredAt: string }
  | { type: "steering-delivered"; occurredAt: string; notice: string }
  | { type: "steering-failed"; occurredAt: string; notice: string; failureKind: SteeringFailureKind }
  | { type: "blocked"; occurredAt: string; notice: string }
  | { type: "output"; occurredAt: string; answerSnapshot: string; previousAnswerSnapshot?: string; answerUpdate?: "append" | "replace" | "replace-status" | "replace-all"; progressEvents: RunProgressEvent[]; hasProgressSnapshot?: boolean }
  | { type: "completed"; occurredAt: string; answer: string; replaceAnswer?: boolean }
  | { type: "failed"; occurredAt: string; notice: string };

export function createQueuedRunCard(input: {
  promptId: string; bindingId: string; title: string; sessionTitle?: string; workspaceId: string; spaceName?: string; paneId: string | null; requestText: string;
  queuePosition: number; occurredAt: string; bindingGeneration?: number; conversionParentPromptId?: string | null; steeringOrigin?: RunCardSteeringOrigin | null;
}): RunCardView {
  return {
    promptId: input.promptId, bindingId: input.bindingId, bindingGeneration: input.bindingGeneration ?? 1, conversionParentPromptId: input.conversionParentPromptId ?? null, steeringOrigin: input.steeringOrigin ?? null, steeringFailureKind: null, larkMessageId: null, answerMessageId: null, answerCardId: null, answerElementId: answerElementId(input.promptId, 0), answerSequence: 0, answerPageIndex: 0, answerPageStart: 0, phase: "queued",
    title: input.title, ...(input.sessionTitle !== undefined ? { sessionTitle: input.sessionTitle } : {}), requestText: input.requestText, workspaceId: input.workspaceId, spaceName: input.spaceName ?? "unknown", paneId: input.paneId, answer: "", answerSegments: [], answerDraft: "", answerDraftTransient: false,
    progressEvents: [], progressSummary: { ...EMPTY_PROGRESS_SUMMARY }, queuePosition: input.queuePosition, queueFeedback: null, startedAt: null, finishedAt: null, notice: null, activityAt: input.occurredAt,
    viewVersion: 1, deliveredVersion: 0, answerDeliveredVersion: 0, createdAt: input.occurredAt, updatedAt: input.occurredAt
  };
}

export function answerElementId(promptId: string, pageIndex: number): string {
  return stableElementId(`answer-content-${promptId}-${pageIndex}`);
}

export function reduceRunCard(state: RunCardView, change: RunCardChange): RunCardView {
  let patch: Partial<RunCardView>;
  switch (change.type) {
    case "queue-position":
      if (state.queuePosition === change.queuePosition) return state;
      patch = { queuePosition: change.queuePosition };
      break;
    case "queue-feedback":
      if (sameQueueFeedback(state.queueFeedback, change.feedback)) return state;
      patch = { queueFeedback: change.feedback };
      break;
    case "started":
      if (state.phase === "running" && state.notice === null) return state;
      patch = { phase: "running", startedAt: state.startedAt ?? change.occurredAt, notice: null };
      break;
    case "steering-delivered":
      if (state.phase === "completed" && state.notice === change.notice) return state;
      patch = { phase: "completed", answer: "", answerSegments: [], answerDraft: "", answerDraftTransient: false, finishedAt: change.occurredAt, queuePosition: 0, notice: change.notice, steeringFailureKind: null };
      break;
    case "steering-failed":
      if (state.phase === "failed" && state.notice === change.notice && state.steeringFailureKind === change.failureKind) return state;
      patch = { phase: "failed", finishedAt: change.occurredAt, queuePosition: 0, notice: change.notice, steeringFailureKind: change.failureKind };
      break;
    case "blocked":
      if (state.phase === "blocked" && state.notice === change.notice) return state;
      patch = { phase: "blocked", notice: change.notice };
      break;
    case "output": {
      const answerState = reduceAnswerSnapshot(state, change.answerSnapshot, change.answerUpdate ?? "replace");
      const answer = renderAnswer(answerState.answerSegments, answerState.answerDraft);
      if (change.hasProgressSnapshot) {
        const progress = progressSnapshot(change.progressEvents);
        if (answer === state.answer && sameProgress(progress.events, state.progressEvents) && sameProgressSummary(progress.summary, state.progressSummary)) return state;
        patch = { answer, ...answerState, progressEvents: progress.events, progressSummary: progress.summary };
        break;
      }
      const progress = mergeRecentProgress(state.progressEvents, state.progressSummary, change.progressEvents);
      if (answer === state.answer && sameProgress(progress.events, state.progressEvents) && sameProgressSummary(progress.summary, state.progressSummary)) return state;
      patch = { answer, ...answerState, progressEvents: progress.events, progressSummary: progress.summary };
      break;
    }
    case "completed":
      if (state.phase === "completed" && state.answer.trim() === change.answer.trim()) return state;
      patch = { phase: "completed", ...completeAnswer(state, change.answer, change.replaceAnswer === true), finishedAt: change.occurredAt, queuePosition: 0, notice: null };
      break;
    case "failed":
      if (state.phase === "failed" && state.notice === change.notice) return state;
      patch = { phase: "failed", finishedAt: change.occurredAt, queuePosition: 0, notice: change.notice };
      break;
  }
  const activityAt = change.type === "queue-position" || change.type === "queue-feedback" || change.type === "steering-delivered" ? state.activityAt : change.occurredAt;
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
