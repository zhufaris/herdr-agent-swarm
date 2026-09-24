export interface StartupViewRecoveryDiagnostics {
  state: "idle" | "retry_wait" | "running" | "stopping";
  pendingCount: number;
  fullRescanPending: boolean;
  retryCount: number;
  recoveredCount: number;
  lastFailureAt: string | null;
  lastFailure: string | null;
}
