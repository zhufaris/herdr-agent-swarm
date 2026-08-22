export type RunCardPhase = "queued" | "running" | "blocked" | "completed" | "failed";
export type ProgressEventKind = "analyze" | "search" | "read" | "edit" | "test";
export type ProgressEventState = "active" | "done" | "failed";

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
  phase: RunCardPhase;
  title: string;
  requestText: string;
  workspaceId: string;
  paneId: string | null;
  answer: string;
  progressEvents: RunProgressEvent[];
  queuePosition: number;
  startedAt: string | null;
  finishedAt: string | null;
  notice: string | null;
  viewVersion: number;
  deliveredVersion: number;
  createdAt: string;
  updatedAt: string;
}

export type RunCardChange =
  | { type: "queue-position"; occurredAt: string; queuePosition: number }
  | { type: "started"; occurredAt: string }
  | { type: "blocked"; occurredAt: string; notice: string }
  | { type: "output"; occurredAt: string; answerDelta: string; progressEvents: RunProgressEvent[] }
  | { type: "completed"; occurredAt: string; answer: string }
  | { type: "failed"; occurredAt: string; notice: string };

export function createQueuedRunCard(input: {
  promptId: string; bindingId: string; title: string; workspaceId: string; paneId: string | null; requestText: string;
  queuePosition: number; occurredAt: string;
}): RunCardView {
  return {
    promptId: input.promptId, bindingId: input.bindingId, larkMessageId: null, phase: "queued",
    title: input.title, requestText: input.requestText, workspaceId: input.workspaceId, paneId: input.paneId, answer: "",
    progressEvents: [], queuePosition: input.queuePosition, startedAt: null, finishedAt: null, notice: null,
    viewVersion: 1, deliveredVersion: 0, createdAt: input.occurredAt, updatedAt: input.occurredAt
  };
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
    case "blocked":
      if (state.phase === "blocked" && state.notice === change.notice) return state;
      patch = { phase: "blocked", notice: change.notice };
      break;
    case "output": {
      const events = [...state.progressEvents];
      const positions = new Map(events.map((event, index) => [event.key, index]));
      for (const event of change.progressEvents) {
        const position = positions.get(event.key);
        if (position === undefined) { positions.set(event.key, events.length); events.push(event); }
        else events[position] = event;
      }
      const answer = state.answer + change.answerDelta;
      if (answer === state.answer && sameProgress(events, state.progressEvents)) return state;
      patch = { answer, progressEvents: events };
      break;
    }
    case "completed":
      patch = { phase: "completed", answer: change.answer, finishedAt: change.occurredAt, queuePosition: 0, notice: null };
      break;
    case "failed":
      patch = { phase: "failed", finishedAt: change.occurredAt, queuePosition: 0, notice: change.notice };
      break;
  }
  return { ...state, ...patch, viewVersion: state.viewVersion + 1, updatedAt: change.occurredAt };
}

function sameProgress(left: RunProgressEvent[], right: RunProgressEvent[]): boolean {
  return left.length === right.length && left.every((event, index) => JSON.stringify(event) === JSON.stringify(right[index]));
}
