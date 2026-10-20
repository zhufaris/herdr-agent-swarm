import type { ObservedInstanceState } from "./agent-instance.js";
import { sameCardTargetRef, type CardTargetRef } from "./card-target-ref.js";
import type { WorkerTurnCardPhase } from "./worker-turn-card-view.js";
import type { WorkerTurnResultCapture } from "./worker-turn-card-view.js";
import type { RunProgressEvent } from "./run-card-view.js";

export const WORKER_MAIN_RECENT_TASK_LIMIT = 5;
export interface ModelUsageSnapshot { model: string | null; contextRemainingPercent: number | null; inputTokens: number | null; outputTokens: number | null; queuedAt: string | null; firstVisibleAt: string | null; completedAt: string | null; waitMs: number | null; firstVisibleMs: number | null; }
export type WorkerMainRuntimeState = ObservedInstanceState | "terminated";

/**
 * Provider-neutral identity for the pane/session rendered by a card.
 *
 * `workspace` is the authoritative checkout path (not the Herdr workspace
 * id).  Git identity may be unavailable for a main checkout, so both
 * `worktreeName` and `branch` deliberately remain nullable.
 */
export interface PaneIdentitySnapshot {
  readonly workspace: string | null;
  readonly worktreeName: string | null;
  readonly branch: string | null;
  readonly paneId: string | null;
  readonly paneToken: string | null;
}

export type PaneIdentityInput = {
  workspace?: string | null | undefined;
  worktreeName?: string | null | undefined;
  branch?: string | null | undefined;
  paneId?: string | null | undefined;
  paneToken?: string | null | undefined;
};

export function createPaneIdentitySnapshot(input: PaneIdentityInput = {}): PaneIdentitySnapshot {
  return {
    workspace: input.workspace ?? null,
    worktreeName: input.worktreeName ?? null,
    branch: input.branch ?? null,
    paneId: input.paneId ?? null,
    paneToken: input.paneToken ?? null
  };
}

export function samePaneIdentity(left: PaneIdentitySnapshot | null | undefined, right: PaneIdentitySnapshot | null | undefined): boolean {
  return left?.workspace === right?.workspace && left?.worktreeName === right?.worktreeName && left?.branch === right?.branch
    && left?.paneId === right?.paneId && left?.paneToken === right?.paneToken;
}

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
  parentPaneToken: string | null;
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
  paneToken: string | null;
  /** Canonical identity; flat fields above are retained for persisted-card compatibility. */
  paneIdentity?: PaneIdentitySnapshot;
  worktreeName?: string | null;
  workspace: string;
  branch: string | null;
  model: string | null;
  modelUsage: ModelUsageSnapshot;
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
  | { type: "usage"; usage: ModelUsageSnapshot; occurredAt: string }
  | { type: "runtime"; runtimeGeneration: number; runtimeState: ObservedInstanceState; runtimeAttached: boolean; desiredState: "running" | "stopped"; parentActive: boolean; paneId?: string | null; paneToken?: string | null; workspace?: string | null; worktreeName?: string | null; branch?: string | null; paneIdentity?: PaneIdentitySnapshot; occurredAt: string }
  | { type: "tasks"; currentTask: WorkerMainTaskSummary | null; queueCount: number; nextTaskTitle: string | null; recentTasks: readonly WorkerMainTaskSummary[]; occurredAt: string; dependencyRevision?: number }
  | { type: "terminated"; occurredAt: string };

export function createWorkerMainView(input: {
  workerId: string; workerSessionGeneration: number; parentBindingId: string; parentBindingGeneration: number; parentPaneId: string; parentPaneToken?: string | null;
    workerName: string; ownerName: string; runtimeGeneration: number; runtimeState: ObservedInstanceState; runtimeAttached: boolean; desiredState: "running" | "stopped"; parentActive: boolean; paneId?: string | null; paneToken?: string | null; primaryPaneName?: string; projectId?: string;
  workspace: string; branch: string | null; worktreeName?: string | null | undefined; paneIdentity?: PaneIdentitySnapshot | undefined; model: string | null; modelUsage?: ModelUsageSnapshot | undefined; occurredAt: string;
}): WorkerMainView {
  const paneIdentity = createPaneIdentitySnapshot({
    ...input.paneIdentity,
    workspace: input.paneIdentity?.workspace ?? input.workspace,
    worktreeName: input.paneIdentity?.worktreeName ?? input.worktreeName,
    branch: input.paneIdentity?.branch ?? input.branch,
    paneId: input.paneIdentity?.paneId ?? input.paneId,
    paneToken: input.paneIdentity?.paneToken ?? input.paneToken
  });
  return {
    ...input, parentPaneToken: input.parentPaneToken ?? null, paneId: paneIdentity.paneId, paneToken: paneIdentity.paneToken, paneIdentity, workspace: paneIdentity.workspace ?? input.workspace, branch: paneIdentity.branch, worktreeName: paneIdentity.worktreeName, modelUsage: normalizeModelUsage(input.modelUsage ?? emptyModelUsage(input.model)), currentTask: null, queueCount: 0, nextTaskTitle: null, recentTasks: [],
    messageId: null, cardId: null, frozenAt: null, dependencyRevision: 0, viewVersion: 1, deliveredVersion: 0, createdAt: input.occurredAt, updatedAt: input.occurredAt
  };
}

export function reduceWorkerMainView(state: WorkerMainView, change: WorkerMainChange): WorkerMainView {
  if (!state.modelUsage) state = { ...state, modelUsage: emptyModelUsage() };
  if (state.frozenAt !== null) return state;
  let patch: Partial<WorkerMainView>;
  if (change.type === "usage") {
    if (JSON.stringify(state.modelUsage) === JSON.stringify(change.usage)) return state;
    return { ...state, modelUsage: change.usage, viewVersion: state.viewVersion + 1, updatedAt: change.occurredAt };
  } else if (change.type === "runtime") {
    const priorIdentity = state.paneIdentity ?? createPaneIdentitySnapshot({ workspace: state.workspace, branch: state.branch, worktreeName: state.worktreeName, paneId: state.paneId, paneToken: state.paneToken });
    const identity = createPaneIdentitySnapshot({
      ...priorIdentity,
      ...change.paneIdentity,
      workspace: change.workspace === undefined ? change.paneIdentity?.workspace ?? priorIdentity.workspace : change.workspace,
      worktreeName: change.worktreeName === undefined ? change.paneIdentity?.worktreeName ?? priorIdentity.worktreeName : change.worktreeName,
      branch: change.branch === undefined ? change.paneIdentity?.branch ?? priorIdentity.branch : change.branch,
      paneId: change.paneId === undefined ? change.paneIdentity?.paneId ?? priorIdentity.paneId : change.paneId,
      paneToken: change.paneToken === undefined ? change.paneIdentity?.paneToken ?? priorIdentity.paneToken : change.paneToken
    });
    if (state.runtimeGeneration === change.runtimeGeneration && state.runtimeState === change.runtimeState && state.runtimeAttached === change.runtimeAttached
      && state.desiredState === change.desiredState && state.parentActive === change.parentActive && samePaneIdentity(state.paneIdentity ?? priorIdentity, identity)) return state;
    patch = { runtimeGeneration: change.runtimeGeneration, runtimeState: change.runtimeState, runtimeAttached: change.runtimeAttached, desiredState: change.desiredState, parentActive: change.parentActive,
      paneId: identity.paneId, paneToken: identity.paneToken, paneIdentity: identity, workspace: identity.workspace ?? state.workspace, worktreeName: identity.worktreeName, branch: identity.branch };
  } else if (change.type === "terminated") {
    const paneIdentity = createPaneIdentitySnapshot({ ...(state.paneIdentity ?? {}), paneId: null, paneToken: null });
    patch = { runtimeState: "terminated", paneId: null, paneToken: null, paneIdentity, frozenAt: change.occurredAt };
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
export function emptyModelUsage(model: string | null = null): ModelUsageSnapshot { return { model, contextRemainingPercent: null, inputTokens: null, outputTokens: null, queuedAt: null, firstVisibleAt: null, completedAt: null, waitMs: null, firstVisibleMs: null }; }
export function normalizeModelUsage(value: ModelUsageSnapshot | null | undefined): ModelUsageSnapshot { return value ?? emptyModelUsage(); }
