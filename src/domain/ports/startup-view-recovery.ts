export interface StartupViewRecoveryDiagnostics {
  state: "idle" | "retry_wait" | "running" | "stopping";
  pendingCount: number;
  fullRescanPending: boolean;
  continuationPending: boolean;
  retryCount: number;
  recoveredCount: number;
  lastFailureAt: string | null;
  lastFailure: string | null;
}
