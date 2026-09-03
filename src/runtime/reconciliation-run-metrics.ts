import type { ReconciliationDiagnostics } from "../domain/types.js";

/** Records a reconciliation pass without owning its queue or recovery policy. */
export class ReconciliationRunMetrics {
  private runCount = 0;
  private successCount = 0;
  private failureCount = 0;
  private coalescedRequestCount = 0;
  private lastStartedAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastDurationMs: number | null = null;
  private maxDurationMs: number | null = null;
  private lastOutcome: ReconciliationDiagnostics["lastOutcome"] = null;

  markCoalesced(): void { this.coalescedRequestCount += 1; }

  async measure<T>(operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    this.runCount += 1;
    this.lastStartedAt = new Date().toISOString();
    try {
      const result = await operation();
      this.successCount += 1;
      this.lastOutcome = "succeeded";
      return result;
    } catch (error) {
      this.failureCount += 1;
      this.lastOutcome = "failed";
      throw error;
    } finally {
      const duration = Math.max(0, Math.round(performance.now() - started));
      this.lastDurationMs = duration;
      this.maxDurationMs = Math.max(this.maxDurationMs ?? 0, duration);
      this.lastCompletedAt = new Date().toISOString();
    }
  }

  snapshot(state: ReconciliationDiagnostics["state"]): ReconciliationDiagnostics {
    return {
      state, runCount: this.runCount, successCount: this.successCount, failureCount: this.failureCount, coalescedRequestCount: this.coalescedRequestCount,
      lastStartedAt: this.lastStartedAt, lastCompletedAt: this.lastCompletedAt, lastDurationMs: this.lastDurationMs, maxDurationMs: this.maxDurationMs, lastOutcome: this.lastOutcome
    };
  }
}
