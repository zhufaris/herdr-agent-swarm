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
  phase: RunCardPhase;
  title: string;
  requestText: string;
  workspaceId: string;
  spaceName: string;
  paneId: string | null;
  answer: string;
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
  | { type: "output"; occurredAt: string; answerSnapshot: string; previousAnswerSnapshot?: string; answerUpdate?: "append" | "replace"; progressEvents: RunProgressEvent[]; hasProgressSnapshot?: boolean }
  | { type: "completed"; occurredAt: string; answer: string }
  | { type: "failed"; occurredAt: string; notice: string };

export function createQueuedRunCard(input: {
  promptId: string; bindingId: string; title: string; workspaceId: string; spaceName?: string; paneId: string | null; requestText: string;
  queuePosition: number; occurredAt: string;
}): RunCardView {
  return {
    promptId: input.promptId, bindingId: input.bindingId, larkMessageId: null, answerMessageId: null, phase: "queued",
    title: input.title, requestText: input.requestText, workspaceId: input.workspaceId, spaceName: input.spaceName ?? "unknown", paneId: input.paneId, answer: "",
    progressEvents: [], queuePosition: input.queuePosition, startedAt: null, finishedAt: null, notice: null,
    viewVersion: 1, deliveredVersion: 0, answerDeliveredVersion: 0, createdAt: input.occurredAt, updatedAt: input.occurredAt
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
    case "steering-delivered":
      patch = { phase: "completed", answer: "", finishedAt: change.occurredAt, queuePosition: 0, notice: change.notice };
      break;
    case "blocked":
      if (state.phase === "blocked" && state.notice === change.notice) return state;
      patch = { phase: "blocked", notice: change.notice };
      break;
    case "output": {
      const answer = mergeAnswerSnapshot(state.answer, change.answerSnapshot, change.previousAnswerSnapshot ?? "", change.answerUpdate ?? "replace");
      if (change.hasProgressSnapshot) {
        if (answer === state.answer && sameProgress(change.progressEvents, state.progressEvents)) return state;
        patch = { answer, progressEvents: change.progressEvents };
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
      patch = { answer, progressEvents: events };
      break;
    }
    case "completed":
      patch = { phase: "completed", answer: mergeFinalAnswer(state.answer, change.answer), finishedAt: change.occurredAt, queuePosition: 0, notice: null };
      break;
    case "failed":
      patch = { phase: "failed", finishedAt: change.occurredAt, queuePosition: 0, notice: change.notice };
      break;
  }
  return { ...state, ...patch, viewVersion: state.viewVersion + 1, updatedAt: change.occurredAt };
}

function mergeAnswerSnapshot(current: string, next: string, previous: string, update: "append" | "replace"): string {
  if (update === "append") return [current.trimEnd(), next.trim()].filter(Boolean).join("\n\n");
  if (previous && current.endsWith(previous)) return `${current.slice(0, -previous.length)}${next}`;
  return next;
}

function mergeFinalAnswer(current: string, finalAnswer: string): string {
  const currentValue = current.trimEnd();
  const finalValue = finalAnswer.trim();
  if (!currentValue || currentValue.endsWith(finalValue)) return currentValue || finalValue;
  return `${currentValue}\n\n${finalValue}`;
}

function sameProgress(left: RunProgressEvent[], right: RunProgressEvent[]): boolean {
  return left.length === right.length && left.every((event, index) => {
    const other = right[index];
    return other !== undefined && event.key === other.key && event.kind === other.kind && event.label === other.label && event.state === other.state;
  });
}
