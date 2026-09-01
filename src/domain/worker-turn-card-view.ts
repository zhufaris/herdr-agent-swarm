import { normalizeLarkElementId } from "../runtime/lark-card-id.js";

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
  workerName: string;
  parentTurnId: string | null;
  rootMessageId: string;
  messageId: string | null;
  cardId: string | null;
  elementId: string;
  phase: WorkerTurnCardPhase;
  requestText: string;
  answer: string;
  queuePosition: number;
  startedAt: string | null;
  finishedAt: string | null;
  notice: string | null;
  resultCapture: WorkerTurnResultCapture;
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
  state: "active" | "finished";
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export type WorkerTurnCardChange =
  | { type: "queue-position"; occurredAt: string; queuePosition: number }
  | { type: "preparing"; occurredAt: string }
  | { type: "running"; occurredAt: string }
  | { type: "blocked"; occurredAt: string; notice: string }
  | { type: "output"; occurredAt: string; answer: string }
  | { type: "completed"; occurredAt: string; answer: string }
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
  occurredAt: string;
}): WorkerTurnCardView {
  return {
    turnId: input.turnId, instanceId: input.instanceId, instanceGeneration: input.instanceGeneration,
    workerName: input.workerName, parentTurnId: input.parentTurnId, rootMessageId: input.rootMessageId,
    messageId: null, cardId: null, elementId: workerTurnElementId(input.turnId, 0), phase: "queued",
    requestText: input.requestText, answer: "", queuePosition: input.queuePosition, startedAt: null, finishedAt: null,
    notice: null, resultCapture: input.resultCapture ?? "pending", pageIndex: 0, pageStart: 0, sequence: 0,
    viewVersion: 1, deliveredVersion: 0, createdAt: input.occurredAt, updatedAt: input.occurredAt
  };
}

export function workerTurnElementId(turnId: string, pageIndex: number): string {
  return normalizeLarkElementId(`worker-turn-${turnId}-${pageIndex}`);
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
      if (state.answer === change.answer) return state;
      patch = { answer: change.answer };
      break;
    case "completed":
      if (state.phase === "completed" && state.answer === change.answer && state.resultCapture === "captured") return state;
      patch = { phase: "completed", answer: change.answer, resultCapture: "captured", queuePosition: 0, finishedAt: change.occurredAt, notice: null };
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
