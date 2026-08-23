import { normalizeLarkElementId } from "../runtime/lark-card-id.js";

export type RunCardPhase = "queued" | "running" | "blocked" | "completed" | "failed";
export type ProgressEventKind = "analyze" | "search" | "read" | "edit" | "test" | "step";
export type ProgressEventState = "pending" | "active" | "done" | "failed";

export interface RunProgressEvent {
  key: string;
  kind: ProgressEventKind;
  label: string;
  state: ProgressEventState;
  occurredAt: string;
}

export interface RunCardView {
  promptId: string;
  bindingId: string;
  larkMessageId: string | null;
  answerMessageId: string | null;
  answerCardId: string | null;
  answerElementId: string;
  answerSequence: number;
  answerPageIndex: number;
  answerPageStart: number;
  phase: RunCardPhase;
  title: string;
  requestText: string;
  workspaceId: string;
  spaceName: string;
  paneId: string | null;
  answer: string;
  answerSegments: string[];
  answerDraft: string;
  answerDraftTransient: boolean;
  progressEvents: RunProgressEvent[];
  queuePosition: number;
  startedAt: string | null;
  finishedAt: string | null;
  notice: string | null;
  viewVersion: number;
  deliveredVersion: number;
  answerDeliveredVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type RunCardChange =
  | { type: "queue-position"; occurredAt: string; queuePosition: number }
  | { type: "started"; occurredAt: string }
  | { type: "steering-delivered"; occurredAt: string; notice: string }
  | { type: "blocked"; occurredAt: string; notice: string }
  | { type: "output"; occurredAt: string; answerSnapshot: string; previousAnswerSnapshot?: string; answerUpdate?: "append" | "replace" | "replace-status" | "replace-all"; progressEvents: RunProgressEvent[]; hasProgressSnapshot?: boolean }
  | { type: "completed"; occurredAt: string; answer: string }
  | { type: "failed"; occurredAt: string; notice: string };

export function createQueuedRunCard(input: {
  promptId: string; bindingId: string; title: string; workspaceId: string; spaceName?: string; paneId: string | null; requestText: string;
  queuePosition: number; occurredAt: string;
}): RunCardView {
  return {
    promptId: input.promptId, bindingId: input.bindingId, larkMessageId: null, answerMessageId: null, answerCardId: null, answerElementId: answerElementId(input.promptId, 0), answerSequence: 0, answerPageIndex: 0, answerPageStart: 0, phase: "queued",
    title: input.title, requestText: input.requestText, workspaceId: input.workspaceId, spaceName: input.spaceName ?? "unknown", paneId: input.paneId, answer: "", answerSegments: [], answerDraft: "", answerDraftTransient: false,
    progressEvents: [], queuePosition: input.queuePosition, startedAt: null, finishedAt: null, notice: null,
    viewVersion: 1, deliveredVersion: 0, answerDeliveredVersion: 0, createdAt: input.occurredAt, updatedAt: input.occurredAt
  };
}

export function answerElementId(promptId: string, pageIndex: number): string {
  return normalizeLarkElementId(`answer-content-${promptId}-${pageIndex}`);
}

export function reduceRunCard(state: RunCardView, change: RunCardChange): RunCardView {
  let patch: Partial<RunCardView>;
  switch (change.type) {
    case "queue-position":
      if (state.queuePosition === change.queuePosition) return state;
      patch = { queuePosition: change.queuePosition };
      break;
    case "started":
      if (state.phase === "running" && state.notice === null) return state;
      patch = { phase: "running", startedAt: state.startedAt ?? change.occurredAt, notice: null };
      break;
    case "steering-delivered":
      patch = { phase: "completed", answer: "", answerSegments: [], answerDraft: "", answerDraftTransient: false, finishedAt: change.occurredAt, queuePosition: 0, notice: change.notice };
      break;
    case "blocked":
      if (state.phase === "blocked" && state.notice === change.notice) return state;
      patch = { phase: "blocked", notice: change.notice };
      break;
    case "output": {
      const answerState = reduceAnswerSnapshot(state, change.answerSnapshot, change.answerUpdate ?? "replace");
      const answer = renderAnswer(answerState.answerSegments, answerState.answerDraft);
      if (change.hasProgressSnapshot) {
        if (answer === state.answer && sameProgress(change.progressEvents, state.progressEvents)) return state;
        patch = { answer, ...answerState, progressEvents: change.progressEvents };
        break;
      }
      const events = [...state.progressEvents];
      const positions = new Map(events.map((event, index) => [event.key, index]));
      for (const event of change.progressEvents) {
        const position = positions.get(event.key);
        if (position === undefined) { positions.set(event.key, events.length); events.push(event); }
        else events[position] = event;
      }
      if (answer === state.answer && sameProgress(events, state.progressEvents)) return state;
      patch = { answer, ...answerState, progressEvents: events };
      break;
    }
    case "completed":
      patch = { phase: "completed", ...completeAnswer(state, change.answer), finishedAt: change.occurredAt, queuePosition: 0, notice: null };
      break;
    case "failed":
      patch = { phase: "failed", finishedAt: change.occurredAt, queuePosition: 0, notice: change.notice };
      break;
  }
  return { ...state, ...patch, viewVersion: state.viewVersion + 1, updatedAt: change.occurredAt };
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

function completeAnswer(state: RunCardView, finalAnswer: string): Pick<RunCardView, "answer" | "answerSegments" | "answerDraft" | "answerDraftTransient"> {
  const current = answerParts(state);
  const draft = current.answerDraft.trim();
  const finalValue = finalAnswer.trim();
  if (finalValue === state.answer.trim()) return { answer: state.answer, ...current };
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
