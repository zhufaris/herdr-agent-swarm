import { stableElementId } from "./stable-element-id.js";
import { EMPTY_PROGRESS_SUMMARY, mergeRecentProgress, type RunProgressEvent, type RunProgressSummary } from "./run-card-view.js";
import type { CardTargetRef } from "./card-target-ref.js";

export type WorkerTurnCardPhase =
  | "queued"
  | "preparing"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "dispatch-uncertain";

export type WorkerTurnResultCapture = "pending" | "captured" | "unavailable";

export interface WorkerTurnCardView {
  turnId: string;
  instanceId: string;
  instanceGeneration: number;
  workerSessionGeneration: number;
  workerName: string;
  parentTurnId: string | null;
  rootMessageId: string;
  messageId: string | null;
  cardId: string | null;
  elementId: string;
  progressSequence: number;
  phase: WorkerTurnCardPhase;
  requestText: string;
  answer: string;
  statusTitle: string | null;
  tokenCount: number | null;
  progressEvents: RunProgressEvent[];
  progressSummary: RunProgressSummary;
  queuePosition: number;
  startedAt: string | null;
  finishedAt: string | null;
  notice: string | null;
  resultCapture: WorkerTurnResultCapture;
  workerMain: CardTargetRef;
  primaryAnswer: CardTargetRef | null;
  pageIndex: number;
  pageStart: number;
  sequence: number;
  viewVersion: number;
  deliveredVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerTurnCardPage {
  id: string;
  turnId: string;
  pageIndex: number;
  pageStart: number;
  elementId: string;
  messageId: string | null;
  cardId: string | null;
  state: "creating" | "active" | "frozen" | "finished";
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export type WorkerTurnCardChange =
  | { type: "queue-position"; occurredAt: string; queuePosition: number }
  | { type: "preparing"; occurredAt: string }
  | { type: "running"; occurredAt: string }
  | { type: "blocked"; occurredAt: string; notice: string }
  | { type: "output"; occurredAt: string; answer: string; statusTitle?: string | null; tokenCount?: number | null; progressEvents?: RunProgressEvent[] }
  | { type: "completed"; occurredAt: string; answer: string; tokenCount?: number | null }
  | { type: "completed-without-output"; occurredAt: string; notice: string }
  | { type: "failed" | "cancelled" | "dispatch-uncertain"; occurredAt: string; notice: string };

export function createQueuedWorkerTurnCard(input: {
  turnId: string;
  instanceId: string;
  instanceGeneration: number;
  workerName: string;
  parentTurnId: string | null;
  rootMessageId: string;
  requestText: string;
  queuePosition: number;
  resultCapture?: WorkerTurnResultCapture;
  workerSessionGeneration?: number;
  primaryAnswer?: CardTargetRef | null;
  occurredAt: string;
}): WorkerTurnCardView {
  return {
    turnId: input.turnId, instanceId: input.instanceId, instanceGeneration: input.instanceGeneration, workerSessionGeneration: input.workerSessionGeneration ?? 1,
    workerName: input.workerName, parentTurnId: input.parentTurnId, rootMessageId: input.rootMessageId,
    messageId: null, cardId: null, elementId: workerTurnElementId(input.turnId, 0), progressSequence: 0, phase: "queued",
    requestText: input.requestText, answer: "", statusTitle: null, tokenCount: null, progressEvents: [], progressSummary: { ...EMPTY_PROGRESS_SUMMARY }, queuePosition: input.queuePosition, startedAt: null, finishedAt: null,
    notice: null, resultCapture: input.resultCapture ?? "pending", workerMain: { aggregateKind: "worker-session", aggregateId: input.instanceId, generation: input.workerSessionGeneration ?? 1, messageId: null }, primaryAnswer: input.primaryAnswer ?? null, pageIndex: 0, pageStart: 0, sequence: 0,
    viewVersion: 1, deliveredVersion: 0, createdAt: input.occurredAt, updatedAt: input.occurredAt
  };
}

export function workerTurnElementId(turnId: string, pageIndex: number): string {
  return stableElementId(`worker-turn-${turnId}-${pageIndex}`);
}

/** A distinct, stable CardKit element for the live Worker progress snapshot. */
export function workerTurnProgressElementId(turnId: string, pageIndex: number): string {
  return stableElementId(`worker-progress-${turnId}-${pageIndex}`);
}

export function workerTurnStreamContent(view: WorkerTurnCardView): string {
  return view.resultCapture === "unavailable"
    ? "⚠️ 任务已结束，但无法获取可信的结构化输出。请前往对应 Herdr Pane 查看本地会话。"
    : view.answer;
}

export function reduceWorkerTurnCard(state: WorkerTurnCardView, change: WorkerTurnCardChange): WorkerTurnCardView {
  let patch: Partial<WorkerTurnCardView>;
  switch (change.type) {
    case "queue-position":
      if (state.queuePosition === change.queuePosition) return state;
      patch = { queuePosition: change.queuePosition };
      break;
    case "preparing":
      if (state.phase === "preparing" && state.notice === null) return state;
      patch = { phase: "preparing", notice: null };
      break;
    case "running":
      if (state.phase === "running" && state.notice === null) return state;
      patch = { phase: "running", startedAt: state.startedAt ?? change.occurredAt, notice: null };
      break;
    case "blocked":
      if (state.phase === "blocked" && state.notice === change.notice) return state;
      patch = { phase: "blocked", startedAt: state.startedAt ?? change.occurredAt, notice: change.notice };
      break;
    case "output":
      {
        const progress = mergeRecentProgress(state.progressEvents, state.progressSummary, change.progressEvents ?? []);
        const statusTitle = change.statusTitle === undefined ? state.statusTitle : change.statusTitle;
        const tokenCount = change.tokenCount === undefined ? state.tokenCount : change.tokenCount;
        if (state.answer === change.answer && state.statusTitle === statusTitle && state.tokenCount === tokenCount && sameProgress(state.progressEvents, progress.events)) return state;
        patch = { answer: change.answer, statusTitle, tokenCount, progressEvents: progress.events, progressSummary: progress.summary };
      }
      break;
    case "completed":
      {
        const tokenCount = change.tokenCount === undefined ? state.tokenCount : change.tokenCount;
        if (state.phase === "completed" && state.answer === change.answer && state.tokenCount === tokenCount && state.resultCapture === "captured") return state;
        patch = { phase: "completed", answer: change.answer, tokenCount, resultCapture: "captured", queuePosition: 0, finishedAt: change.occurredAt, notice: null };
      }
      break;
    case "completed-without-output":
      if (state.phase === "completed" && state.resultCapture === "unavailable" && state.notice === change.notice) return state;
      patch = { phase: "completed", answer: "", resultCapture: "unavailable", queuePosition: 0, finishedAt: change.occurredAt, notice: change.notice };
      break;
    case "failed":
    case "cancelled":
      if (state.phase === change.type && state.notice === change.notice) return state;
      patch = { phase: change.type, queuePosition: 0, finishedAt: change.occurredAt, notice: change.notice };
      break;
    case "dispatch-uncertain":
      if (state.phase === change.type && state.notice === change.notice) return state;
      patch = { phase: change.type, queuePosition: 0, notice: change.notice };
      break;
  }
  return { ...state, ...patch, viewVersion: state.viewVersion + 1, updatedAt: change.occurredAt };
}

function sameProgress(left: readonly RunProgressEvent[], right: readonly RunProgressEvent[]): boolean {
  return left.length === right.length && left.every((event, index) => {
    const other = right[index];
    return other !== undefined && event.key === other.key && event.kind === other.kind && event.label === other.label && event.state === other.state;
  });
}
