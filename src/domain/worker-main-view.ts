import type { ObservedInstanceState } from "./agent-instance.js";
import { sameCardTargetRef, type CardTargetRef } from "./card-target-ref.js";
import type { WorkerTurnCardPhase } from "./worker-turn-card-view.js";

export const WORKER_MAIN_RECENT_TASK_LIMIT = 5;
export type WorkerMainRuntimeState = ObservedInstanceState | "terminated";

export interface WorkerMainTaskSummary {
  turnId: string;
  title: string;
  phase: WorkerTurnCardPhase;
  durationSeconds: number | null;
  taskCard: CardTargetRef;
  updatedAt: string;
}

export interface WorkerMainView {
  workerId: string;
  workerSessionGeneration: number;
  parentBindingId: string;
  parentBindingGeneration: number;
  parentPaneId: string;
  workerName: string;
  ownerName: string;
  runtimeGeneration: number;
  runtimeState: WorkerMainRuntimeState;
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

export type WorkerMainChange =
  | { type: "runtime"; runtimeGeneration: number; runtimeState: ObservedInstanceState; paneId: string | null; occurredAt: string }
  | { type: "tasks"; currentTask: WorkerMainTaskSummary | null; queueCount: number; nextTaskTitle: string | null; recentTasks: readonly WorkerMainTaskSummary[]; occurredAt: string; dependencyRevision?: number }
  | { type: "terminated"; occurredAt: string };

export function createWorkerMainView(input: {
  workerId: string; workerSessionGeneration: number; parentBindingId: string; parentBindingGeneration: number; parentPaneId: string;
  workerName: string; ownerName: string; runtimeGeneration: number; runtimeState: ObservedInstanceState; paneId?: string | null;
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
    if (state.runtimeGeneration === change.runtimeGeneration && state.runtimeState === change.runtimeState && state.paneId === change.paneId) return state;
    patch = { runtimeGeneration: change.runtimeGeneration, runtimeState: change.runtimeState, paneId: change.paneId };
  } else if (change.type === "terminated") {
    patch = { runtimeState: "terminated", paneId: null, frozenAt: change.occurredAt };
  } else {
    const recentTasks = boundedTerminalTasks(change.recentTasks);
    const revision = change.dependencyRevision ?? state.dependencyRevision;
    if (sameTask(state.currentTask, change.currentTask) && state.queueCount === change.queueCount && state.nextTaskTitle === change.nextTaskTitle
      && sameTasks(state.recentTasks, recentTasks) && state.dependencyRevision === revision) return state;
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
    && left.updatedAt === right.updatedAt && sameCardTargetRef(left.taskCard, right.taskCard);
}
