export type FailureLogDecision =
  | { kind: "first"; count: 1; firstFailureAt: string }
  | { kind: "summary"; count: number; firstFailureAt: string }
  | { kind: "suppressed" };

interface FailureState { key: string; count: number; firstAt: number; lastSummaryAt: number }

export class FailureLogGate {
  private readonly failures = new Map<string, FailureState>();

  constructor(private readonly summaryIntervalMs = 60_000, private readonly now = Date.now) {}

  fail(scope: string, key: string): FailureLogDecision {
    const timestamp = this.now();
    const current = this.failures.get(scope);
    if (!current || current.key !== key) {
      this.failures.set(scope, { key, count: 1, firstAt: timestamp, lastSummaryAt: timestamp });
      return { kind: "first", count: 1, firstFailureAt: new Date(timestamp).toISOString() };
    }
    current.count += 1;
    if (timestamp - current.lastSummaryAt < this.summaryIntervalMs) return { kind: "suppressed" };
    current.lastSummaryAt = timestamp;
    return { kind: "summary", count: current.count, firstFailureAt: new Date(current.firstAt).toISOString() };
  }

  recover(scope: string): { count: number; firstFailureAt: string; durationMs: number } | null {
    const current = this.failures.get(scope);
    if (!current) return null;
    this.failures.delete(scope);
    const timestamp = this.now();
    return { count: current.count, firstFailureAt: new Date(current.firstAt).toISOString(), durationMs: Math.max(0, timestamp - current.firstAt) };
  }

  clear(): void { this.failures.clear(); }
}
