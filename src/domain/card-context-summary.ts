import type { ObservedInstanceState } from "./agent-instance.js";
import type { CardTargetRef } from "./card-target-ref.js";
import type { WorkerTurnCardPhase } from "./worker-turn-card-view.js";

export type PrimaryWorkerState = ObservedInstanceState | "queued";

export interface PrimaryWorkerSummary {
  workerId: string; workerSessionGeneration: number; name: string; state: PrimaryWorkerState; currentTaskTitle: string | null; queueCount: number; workerMain: CardTargetRef; createdAt: string;
}

export interface PrimaryWorkerActivitySummary {
  workerId: string; workerSessionGeneration: number; name: string; latestPhase: WorkerTurnCardPhase; taskCount: number; latestTaskTitle: string; latestTaskCard: CardTargetRef; updatedAt: string;
}

export const PRIMARY_MAIN_WORKER_LIMIT = 8;

export function selectPrimaryWorkerSummaries(candidates: readonly PrimaryWorkerSummary[]): { workers: PrimaryWorkerSummary[]; overflowCount: number } {
  const rank: Record<PrimaryWorkerState, number> = { blocked: 0, working: 1, queued: 2, starting: 3, idle: 4, unprovisioned: 5, detached: 6, stopped: 7, failed: 8 };
  const active = candidates.filter(({ state }) => state !== "stopped").slice().sort((left, right) => rank[left.state] - rank[right.state] || left.createdAt.localeCompare(right.createdAt) || left.workerId.localeCompare(right.workerId));
  return { workers: active.slice(0, PRIMARY_MAIN_WORKER_LIMIT), overflowCount: Math.max(0, active.length - PRIMARY_MAIN_WORKER_LIMIT) };
}

export function selectPrimaryWorkerActivity(candidates: readonly PrimaryWorkerActivitySummary[]): PrimaryWorkerActivitySummary[] {
  return candidates.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.workerId.localeCompare(right.workerId)).slice(0, PRIMARY_MAIN_WORKER_LIMIT);
}
