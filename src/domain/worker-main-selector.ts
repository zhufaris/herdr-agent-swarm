import type { ObservedInstanceState } from "./agent-instance.js";
import type { WorkerMainTaskSummary, WorkerMainView } from "./worker-main-view.js";
import { createPaneIdentitySnapshot, createWorkerMainView, emptyModelUsage, reduceWorkerMainView, samePaneIdentity, type ModelUsageSnapshot, type PaneIdentitySnapshot } from "./worker-main-view.js";

export interface WorkerMainProjectionSource {
  workerId: string; workerSessionGeneration: number; workerName: string; model: string | null; runtimeGeneration: number; runtimeState: ObservedInstanceState; paneId: string | null; paneToken: string | null;
  runtimeAttached: boolean; desiredState: "running" | "stopped"; parentActive: boolean;
  lifecycle: "active" | "legacy" | "terminated"; parentBindingId: string; parentBindingGeneration: number; parentPaneId: string; parentPaneToken: string | null; primaryPaneName: string; projectId: string; ownerName: string;
  workspace: string; branch: string | null; worktreeName?: string | null; paneIdentity?: PaneIdentitySnapshot; modelUsage?: ModelUsageSnapshot; currentTask: WorkerMainTaskSummary | null; queueCount: number; nextTaskTitle: string | null; recentTasks: WorkerMainTaskSummary[]; createdAt: string;
}

export function selectWorkerMainView(source: WorkerMainProjectionSource, previous: WorkerMainView | null, dependencyRevision: number, occurredAt: string): WorkerMainView {
  const paneIdentity = createPaneIdentitySnapshot({
    ...source.paneIdentity,
    workspace: source.paneIdentity?.workspace ?? source.workspace,
    worktreeName: source.paneIdentity?.worktreeName ?? source.worktreeName,
    branch: source.paneIdentity?.branch ?? source.branch,
    paneId: source.paneIdentity?.paneId ?? source.paneId,
    paneToken: source.paneIdentity?.paneToken ?? source.paneToken
  });
  const modelUsage = source.modelUsage ?? emptyModelUsage(source.model);
  const base = previous ?? createWorkerMainView({
    workerId: source.workerId, workerSessionGeneration: source.workerSessionGeneration, parentBindingId: source.parentBindingId, parentBindingGeneration: source.parentBindingGeneration, parentPaneId: source.parentPaneId, parentPaneToken: source.parentPaneToken,
    workerName: source.workerName, ownerName: source.ownerName, runtimeGeneration: source.runtimeGeneration, runtimeState: source.runtimeState, runtimeAttached: source.runtimeAttached, desiredState: source.desiredState, parentActive: source.parentActive, paneId: source.paneId, paneToken: source.paneToken, primaryPaneName: source.primaryPaneName, projectId: source.projectId, workspace: source.workspace, worktreeName: source.worktreeName, branch: source.branch, paneIdentity, model: source.model, modelUsage, occurredAt: source.createdAt
  });
  if (base.workerId !== source.workerId || base.workerSessionGeneration !== source.workerSessionGeneration || base.parentBindingId !== source.parentBindingId || base.parentPaneId !== source.parentPaneId) return base;
  const titled = base.primaryPaneName === source.primaryPaneName && base.parentPaneToken === source.parentPaneToken && base.projectId === source.projectId ? base : { ...base, primaryPaneName: source.primaryPaneName, parentPaneToken: source.parentPaneToken, projectId: source.projectId, viewVersion: base.viewVersion + 1, updatedAt: occurredAt };
  const runtime = reduceWorkerMainView(titled, { type: "runtime", runtimeGeneration: source.runtimeGeneration, runtimeState: source.runtimeState, runtimeAttached: source.runtimeAttached, desiredState: source.desiredState, parentActive: source.parentActive, paneIdentity, occurredAt });
  const usage = reduceWorkerMainView(runtime, { type: "usage", usage: modelUsage, occurredAt });
  const identityChanged = previous !== null && !samePaneIdentity(previous.paneIdentity ?? createPaneIdentitySnapshot({ workspace: previous.workspace, worktreeName: previous.worktreeName, branch: previous.branch, paneId: previous.paneId, paneToken: previous.paneToken }), paneIdentity);
  const projectedDependencyRevision = Math.max(dependencyRevision, (previous?.dependencyRevision ?? 0) + (identityChanged ? 1 : 0));
  const tasks = reduceWorkerMainView(usage, { type: "tasks", currentTask: source.currentTask, queueCount: source.queueCount, nextTaskTitle: source.nextTaskTitle, recentTasks: source.recentTasks, dependencyRevision: projectedDependencyRevision, occurredAt });
  return source.lifecycle === "terminated" ? reduceWorkerMainView(tasks, { type: "terminated", occurredAt }) : tasks;
}
