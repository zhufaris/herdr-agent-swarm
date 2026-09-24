import type { StartupViewRecoveryDiagnostics } from "../domain/ports/startup-view-recovery.js";

export interface StartupRecoveryDiagnostics { state: "idle" | "running" | "completed" | "degraded"; startedAt: string | null; completedAt: string | null; stages: Array<{ name: string; state: "completed" | "failed"; durationMs: number; error?: string }>; startupViews?: StartupViewRecoveryDiagnostics }
export interface InboundDispatcherDiagnostics { state: "idle" | "running" | "retry_wait" | "stopping"; drainRequested: boolean; retryAttempt: number; nextRetryAt: string | null; lastAcceptedAt: string | null; lastFailureAt: string | null; lastFailure: string | null }
export interface SessionOperationDispatcherDiagnostics { state: "idle" | "running" | "stopping"; activeOperations: number; drainRequested: boolean; lastCompletedAt: string | null; lastFailureAt: string | null; lastFailure: string | null }
export interface ReconciliationFailure { workspaceId?: string; message: string }
export interface ReconciliationPassResult { reconciledWorkspaceIds: ReadonlySet<string>; failures: readonly ReconciliationFailure[] }
export interface ReconciliationDiagnostics {
  state: "idle" | "running" | "stopping"; runCount: number; successCount: number; failureCount: number; coalescedRequestCount: number;
  lastStartedAt: string | null; lastCompletedAt: string | null; lastDurationMs: number | null; maxDurationMs: number | null; lastOutcome: "succeeded" | "failed" | null; lastFailures: ReconciliationFailure[];
  activeScopeKind?: "panes" | "workspaces" | "all" | null; pendingPaneCount?: number; pendingWorkspaceCount?: number; fullPending?: boolean; priorityPromotionCount?: number;
  lastAcceptedToStartMs?: { panes: number | null; workspaces: number | null; all: number | null }; maxAcceptedToStartMs?: { panes: number | null; workspaces: number | null; all: number | null };
  snapshotDurationMs?: number | null; missingPaneDurationMs?: number | null; existingBindingDurationMs?: number | null; discoveryDurationMs?: number | null;
  existingBindingCount?: number | null; discoveryCandidateCount?: number | null;
}
export interface OutboxDispatcherDiagnostics { state: "idle" | "running" | "stopping"; activeDeliveries: number; scanPending: boolean; lastScanAt: string | null; lastScanOutcome: "idle" | "delivered" | "failed" | null; lastSuccessfulScanAt: string | null; lastScanFailureAt: string | null; consecutiveScanFailures: number; lastDeliveryAt: string | null; lastDeliveryFailureAt: string | null }
export interface PromptWorkerDiagnostics { state: "idle" | "running" | "stopping"; activeTurnWorkers: number; currentSafetyScanDelayMs: number | null; nextSafetyScanAt: string | null; lastScanAt: string | null; lastScanOutcome: "idle" | "work_found" | "failed" | null; lastDiscovered: { turns: number; detached: number; recoveredClaims: number; cancelled: number; failedDetached: number }; lastScanFailureAt: string | null }
export interface InstanceWorkerDiagnostics { state: "idle" | "running" | "stopping"; activeDispatchWorkers: number; activeObservers: number; queuedTurns: number; activeTurns: number; uncertainTurns: number; lastScanAt: string | null; lastFailureAt: string | null; lastFailure: string | null }
