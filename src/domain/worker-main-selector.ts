import type { ObservedInstanceState } from "./agent-instance.js";
import type { WorkerMainTaskSummary, WorkerMainView } from "./worker-main-view.js";
import { createWorkerMainView, reduceWorkerMainView } from "./worker-main-view.js";

export interface WorkerMainProjectionSource {
  workerId: string; workerSessionGeneration: number; workerName: string; model: string | null; runtimeGeneration: number; runtimeState: ObservedInstanceState; paneId: string | null;
  runtimeAttached: boolean; desiredState: "running" | "stopped"; parentActive: boolean;
  lifecycle: "active" | "legacy" | "terminated"; parentBindingId: string; parentBindingGeneration: number; parentPaneId: string; primaryPaneName: string; projectId: string; ownerName: string;
  workspace: string; branch: string | null; currentTask: WorkerMainTaskSummary | null; queueCount: number; nextTaskTitle: string | null; recentTasks: WorkerMainTaskSummary[]; createdAt: string;
}

export function selectWorkerMainView(source: WorkerMainProjectionSource, previous: WorkerMainView | null, dependencyRevision: number, occurredAt: string): WorkerMainView {
  const base = previous ?? createWorkerMainView({
    workerId: source.workerId, workerSessionGeneration: source.workerSessionGeneration, parentBindingId: source.parentBindingId, parentBindingGeneration: source.parentBindingGeneration, parentPaneId: source.parentPaneId,
    workerName: source.workerName, ownerName: source.ownerName, runtimeGeneration: source.runtimeGeneration, runtimeState: source.runtimeState, runtimeAttached: source.runtimeAttached, desiredState: source.desiredState, parentActive: source.parentActive, paneId: source.paneId, primaryPaneName: source.primaryPaneName, projectId: source.projectId, workspace: source.workspace, branch: source.branch, model: source.model, occurredAt: source.createdAt
  });
  if (base.workerId !== source.workerId || base.workerSessionGeneration !== source.workerSessionGeneration || base.parentBindingId !== source.parentBindingId || base.parentPaneId !== source.parentPaneId) return base;
  const titled = base.primaryPaneName === source.primaryPaneName && base.projectId === source.projectId ? base : { ...base, primaryPaneName: source.primaryPaneName, projectId: source.projectId, viewVersion: base.viewVersion + 1, updatedAt: occurredAt };
  const runtime = reduceWorkerMainView(titled, { type: "runtime", runtimeGeneration: source.runtimeGeneration, runtimeState: source.runtimeState, runtimeAttached: source.runtimeAttached, desiredState: source.desiredState, parentActive: source.parentActive, paneId: source.paneId, occurredAt });
  const tasks = reduceWorkerMainView(runtime, { type: "tasks", currentTask: source.currentTask, queueCount: source.queueCount, nextTaskTitle: source.nextTaskTitle, recentTasks: source.recentTasks, dependencyRevision, occurredAt });
  return source.lifecycle === "terminated" ? reduceWorkerMainView(tasks, { type: "terminated", occurredAt }) : tasks;
}
