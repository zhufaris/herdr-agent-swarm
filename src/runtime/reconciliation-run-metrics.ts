import type { ReconciliationDiagnostics, ReconciliationFailure } from "../domain/types.js";

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
  private lastFailures: ReconciliationFailure[] = [];

  markCoalesced(): void { this.coalescedRequestCount += 1; }

  async measure<T>(operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    this.runCount += 1;
    this.lastStartedAt = new Date().toISOString();
    try {
      const result = await operation();
      const failures = containedFailures(result);
      if (failures.length > 0) {
        this.failureCount += 1;
        this.lastOutcome = "failed";
        this.lastFailures = failures;
      } else {
        this.successCount += 1;
        this.lastOutcome = "succeeded";
        this.lastFailures = [];
      }
      return result;
    } catch (error) {
      this.failureCount += 1;
      this.lastOutcome = "failed";
      this.lastFailures = [{ message: boundedMessage(error) }];
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
      lastStartedAt: this.lastStartedAt, lastCompletedAt: this.lastCompletedAt, lastDurationMs: this.lastDurationMs, maxDurationMs: this.maxDurationMs, lastOutcome: this.lastOutcome, lastFailures: [...this.lastFailures]
    };
  }
}

function containedFailures(value: unknown): ReconciliationFailure[] {
  if (!value || typeof value !== "object" || !("failures" in value) || !Array.isArray(value.failures)) return [];
  return value.failures.slice(0, 20).map((failure: unknown) => {
    if (!failure || typeof failure !== "object") return { message: boundedMessage(failure) };
    const record = failure as { workspaceId?: unknown; message?: unknown };
    return { ...(typeof record.workspaceId === "string" ? { workspaceId: record.workspaceId.slice(0, 200) } : {}), message: boundedMessage(record.message) };
  });
}

function boundedMessage(value: unknown): string {
  return (value instanceof Error ? value.message : typeof value === "string" ? value : String(value)).slice(0, 500);
}
