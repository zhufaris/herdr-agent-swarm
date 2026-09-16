import type { ObservedInstanceState } from "./agent-instance.js";
import { sameCardTargetRef, type CardTargetRef } from "./card-target-ref.js";
import type { WorkerTurnCardPhase } from "./worker-turn-card-view.js";
import type { WorkerTurnResultCapture } from "./worker-turn-card-view.js";
import type { RunProgressEvent } from "./run-card-view.js";

export const WORKER_MAIN_RECENT_TASK_LIMIT = 5;
export type WorkerMainRuntimeState = ObservedInstanceState | "terminated";

export interface WorkerMainTaskSummary {
  turnId: string;
  title: string;
  phase: WorkerTurnCardPhase;
  durationSeconds: number | null;
  taskCard: CardTargetRef;
  updatedAt: string;
  requestText?: string;
  answer?: string;
  statusTitle?: string | null;
  tokenCount?: number | null;
  progressEvents?: RunProgressEvent[];
  notice?: string | null;
  resultCapture?: WorkerTurnResultCapture;
}

export interface WorkerMainView {
  workerId: string;
  workerSessionGeneration: number;
  parentBindingId: string;
  parentBindingGeneration: number;
  parentPaneId: string;
  primaryPaneName?: string;
  projectId?: string;
  workerName: string;
  ownerName: string;
  runtimeGeneration: number;
  runtimeState: WorkerMainRuntimeState;
  runtimeAttached: boolean;
  desiredState: "running" | "stopped";
  parentActive: boolean;
  paneId: string | null;
  workspace: string;
  branch: string | null;
  model: string | null;
  currentTask: WorkerMainTaskSummary | null;
  queueCount: number;
  nextTaskTitle: string | null;
  recentTasks: WorkerMainTaskSummary[];
  messageId: string | null;
  cardId: string | null;
  frozenAt: string | null;
  dependencyRevision: number;
  viewVersion: number;
  deliveredVersion: number;
  createdAt: string;
  updatedAt: string;
}

export function canSubmitWorkerMainTask(view: Pick<WorkerMainView, "frozenAt" | "runtimeState" | "runtimeAttached" | "desiredState" | "parentActive" | "messageId">): boolean {
  return view.frozenAt === null && view.messageId !== null && view.runtimeAttached && view.desiredState === "running" && view.parentActive
    && ["idle", "working", "blocked"].includes(view.runtimeState);
}

export type WorkerMainChange =
  | { type: "runtime"; runtimeGeneration: number; runtimeState: ObservedInstanceState; runtimeAttached: boolean; desiredState: "running" | "stopped"; parentActive: boolean; paneId: string | null; occurredAt: string }
  | { type: "tasks"; currentTask: WorkerMainTaskSummary | null; queueCount: number; nextTaskTitle: string | null; recentTasks: readonly WorkerMainTaskSummary[]; occurredAt: string; dependencyRevision?: number }
  | { type: "terminated"; occurredAt: string };

export function createWorkerMainView(input: {
  workerId: string; workerSessionGeneration: number; parentBindingId: string; parentBindingGeneration: number; parentPaneId: string;
    workerName: string; ownerName: string; runtimeGeneration: number; runtimeState: ObservedInstanceState; runtimeAttached: boolean; desiredState: "running" | "stopped"; parentActive: boolean; paneId?: string | null; primaryPaneName?: string; projectId?: string;
  workspace: string; branch: string | null; model: string | null; occurredAt: string;
}): WorkerMainView {
  return {
    ...input, paneId: input.paneId ?? null, currentTask: null, queueCount: 0, nextTaskTitle: null, recentTasks: [],
    messageId: null, cardId: null, frozenAt: null, dependencyRevision: 0, viewVersion: 1, deliveredVersion: 0, createdAt: input.occurredAt, updatedAt: input.occurredAt
  };
}

export function reduceWorkerMainView(state: WorkerMainView, change: WorkerMainChange): WorkerMainView {
  if (state.frozenAt !== null) return state;
  let patch: Partial<WorkerMainView>;
  if (change.type === "runtime") {
    if (state.runtimeGeneration === change.runtimeGeneration && state.runtimeState === change.runtimeState && state.runtimeAttached === change.runtimeAttached
      && state.desiredState === change.desiredState && state.parentActive === change.parentActive && state.paneId === change.paneId) return state;
    patch = { runtimeGeneration: change.runtimeGeneration, runtimeState: change.runtimeState, runtimeAttached: change.runtimeAttached, desiredState: change.desiredState, parentActive: change.parentActive, paneId: change.paneId };
  } else if (change.type === "terminated") {
    patch = { runtimeState: "terminated", paneId: null, frozenAt: change.occurredAt };
  } else {
    const recentTasks = boundedTerminalTasks(change.recentTasks);
    const revision = change.dependencyRevision ?? state.dependencyRevision;
    const samePresentation = sameTask(state.currentTask, change.currentTask) && state.queueCount === change.queueCount && state.nextTaskTitle === change.nextTaskTitle
      && sameTasks(state.recentTasks, recentTasks);
    if (samePresentation) return state.dependencyRevision === revision ? state : { ...state, dependencyRevision: revision, updatedAt: change.occurredAt };
    patch = { currentTask: change.currentTask, queueCount: change.queueCount, nextTaskTitle: change.nextTaskTitle, recentTasks, dependencyRevision: revision };
  }
  return { ...state, ...patch, viewVersion: state.viewVersion + 1, updatedAt: change.occurredAt };
}

function boundedTerminalTasks(tasks: readonly WorkerMainTaskSummary[]): WorkerMainTaskSummary[] {
  return tasks.filter(({ phase }) => isTerminal(phase)).slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.turnId.localeCompare(right.turnId)).slice(0, WORKER_MAIN_RECENT_TASK_LIMIT);
}

function isTerminal(phase: WorkerTurnCardPhase): boolean {
  return phase === "completed" || phase === "failed" || phase === "cancelled" || phase === "dispatch-uncertain";
}

function sameTasks(left: readonly WorkerMainTaskSummary[], right: readonly WorkerMainTaskSummary[]): boolean {
  return left.length === right.length && left.every((task, index) => sameTask(task, right[index] ?? null));
}

function sameTask(left: WorkerMainTaskSummary | null, right: WorkerMainTaskSummary | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.turnId === right.turnId && left.title === right.title && left.phase === right.phase && left.durationSeconds === right.durationSeconds
    && left.updatedAt === right.updatedAt && left.requestText === right.requestText && left.answer === right.answer && left.statusTitle === right.statusTitle && left.tokenCount === right.tokenCount
    && left.notice === right.notice && left.resultCapture === right.resultCapture && sameProgress(left.progressEvents, right.progressEvents)
    && sameCardTargetRef(left.taskCard, right.taskCard);
}

function sameProgress(left: readonly RunProgressEvent[] | undefined, right: readonly RunProgressEvent[] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((event, index) => {
    const other = right[index];
    return other !== undefined && event.key === other.key && event.kind === other.kind && event.label === other.label && event.state === other.state && event.occurredAt === other.occurredAt;
  });
}
