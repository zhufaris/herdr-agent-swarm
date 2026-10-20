export type RecoveryStage =
  | "observing_execution"
  | "rebuilding_projection"
  | "delivering"
  | "awaiting_ack"
  | "recovered"
  | "needs_human";

export type RecoveryBindingResult = {
  selectedStage: RecoveryStage;
  stage: RecoveryStage;
  recoveredTurns: number;
  promptCount: number;
  workerTurnCount: number;
  executionReason?: string;
  redelivery?:
    | { outcome: "scheduled" | "duplicate"; answerScheduled: boolean }
    | { outcome: "unavailable"; reason: string };
} & (
  | { outcome: "recovered" | "requested" }
  | { outcome: "none" | "busy" | "needs_human"; reason: string }
);

export interface RecoveryDurableEvidence {
  observedAt: string;
  observingExecution: number;
  uncertainExecution: number;
  rebuildingProjection: number;
  delivering: number;
  awaitingAck: number;
  recovered: number;
  needsHumanDelivery: number;
  oldestPendingAt: string | null;
  oldestPendingAgeSeconds: number | null;
  items: RecoveryDiagnosticItem[];
}

export interface RecoveryDiagnosticItem {
  kind: "detached_prompt" | "uncertain_prompt" | "primary_answer" | "worker_task";
  stage: RecoveryStage;
  bindingId: string;
  promptId: string | null;
  workerId: string | null;
  workerTurnId: string | null;
  updatedAt: string;
}

export interface RecoverySupervisorDiagnostics {
  version: number;
  state: "idle" | "running" | "stopping";
  lastPassAt: string | null;
  lastPassOutcome: "succeeded" | "failed" | null;
  stageCounts: Record<RecoveryStage, number>;
  oldestPendingAt: string | null;
  oldestPendingAgeSeconds: number | null;
  lastFailure: string | null;
  items: RecoveryDiagnosticItem[];
  historical: {
    runCount: number;
    lastSliceAt: string | null;
    lastResult: import("./historical-recovery.js").HistoricalRecoverySliceResult | null;
  };
}
