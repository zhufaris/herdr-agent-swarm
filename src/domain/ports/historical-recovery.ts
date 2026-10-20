import type { HistoricalCoreRecoveryCandidate, HistoricalCoreRecoveryResult, HistoricalRecoveryBacklogSummary } from "../historical-recovery.js";

export interface HistoricalRecoveryStore {
  listHistoricalRecoveryCandidates(input: { limit?: number }): HistoricalCoreRecoveryCandidate[];
  reprojectHistoricalCandidate(candidate: HistoricalCoreRecoveryCandidate, observedAt?: string): HistoricalCoreRecoveryResult;
  summarizeHistoricalRecoveryBacklog?(): HistoricalRecoveryBacklogSummary;
}

export interface HistoricalMissingCardRecovery {
  recoverNextHistoricalMissingCard(): Promise<"reserved" | "stale" | "none">;
}
