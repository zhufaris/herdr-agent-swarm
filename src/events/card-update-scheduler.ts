export type CardUpdatePriority = "normal" | "interactive" | "terminal";

interface PendingCardUpdate { desiredVersion: number; timer: NodeJS.Timeout | null; dueAt: number; requestedAt: number; inFlight: boolean; requestedWhileInFlight: boolean; priority: CardUpdatePriority; consecutiveFailures: number }

export interface CardUpdateSchedulerDiagnostics {
  pending: number;
  pendingByFamily: { answer: number; main: number; unknown: number };
  inFlight: number;
  coalesced: number;
  failures: number;
  oldestPendingAgeMs: number | null;
  lastSuccessfulFlushAt: string | null;
}

export interface CardUpdateFlushResult { cardKey: string; desiredVersion: number; priority: CardUpdatePriority; latencyMs: number; outcome: "succeeded" | "failed" }

export class CardUpdateScheduler {
  private readonly pending = new Map<string, PendingCardUpdate>();
  private stopped = false;

  constructor(
    private readonly deliver: (cardKey: string, version: number) => Promise<void>,
    private readonly intervalMs = 500,
    private readonly onError?: (error: unknown, cardKey: string, version: number) => void,
    private readonly onFlush?: (result: CardUpdateFlushResult) => void
  ) {}

  schedule(cardKey: string, version: number, options: boolean | { priority?: CardUpdatePriority; delayMs?: number } = false): void {
    if (this.stopped) return;
    const now = Date.now();
    const priority = typeof options === "boolean" ? (options ? "terminal" : "normal") : options.priority ?? "normal";
    const delayMs = priority === "terminal" ? 0 : typeof options === "object" && options.delayMs !== undefined ? Math.max(0, options.delayMs) : this.intervalMs;
    const existing = this.pending.get(cardKey);
    const item = existing ?? { desiredVersion: version, timer: null, dueAt: now + delayMs, requestedAt: now, inFlight: false, requestedWhileInFlight: false, priority, consecutiveFailures: 0 };
    if (existing) this.coalesced += 1;
    if (item.inFlight) item.requestedWhileInFlight = true;
    item.desiredVersion = Math.max(item.desiredVersion, version);
    if (priorityRank(priority) > priorityRank(item.priority)) item.priority = priority;
    item.dueAt = Math.min(item.dueAt, now + delayMs);
    this.pending.set(cardKey, item);
    if (item.inFlight) return;
    this.arm(cardKey, item);
  }

  private coalesced = 0;
  private failures = 0;
  private lastSuccessfulFlushAt: string | null = null;

  diagnostics(now = Date.now()): CardUpdateSchedulerDiagnostics {
    const entries = [...this.pending.entries()];
    const pending = entries.map(([, item]) => item);
    const pendingByFamily = { answer: 0, main: 0, unknown: 0 };
    for (const [cardKey] of entries) {
      if (cardKey.startsWith("answer:")) pendingByFamily.answer += 1;
      else if (cardKey.startsWith("main:")) pendingByFamily.main += 1;
      else pendingByFamily.unknown += 1;
    }
    return { pending: pending.length, pendingByFamily, inFlight: pending.filter((item) => item.inFlight).length, coalesced: this.coalesced, failures: this.failures, oldestPendingAgeMs: pending.length ? Math.max(...pending.map((item) => Math.max(0, now - item.requestedAt))) : null, lastSuccessfulFlushAt: this.lastSuccessfulFlushAt };
  }

  private arm(cardKey: string, item: PendingCardUpdate): void {
    if (item.timer) clearTimeout(item.timer);
    const delayMs = Math.max(0, item.dueAt - Date.now());
    if (delayMs === 0) { item.timer = null; this.launchFlush(cardKey); return; }
    item.timer = setTimeout(() => { item.timer = null; this.launchFlush(cardKey); }, delayMs);
    item.timer.unref?.();
  }

  private launchFlush(cardKey: string): void {
    void this.flush(cardKey).catch((error) => this.reportError(error, cardKey, this.pending.get(cardKey)?.desiredVersion ?? 0));
  }

  stop(): void {
    this.stopped = true;
    for (const item of this.pending.values()) if (item.timer) clearTimeout(item.timer);
    this.pending.clear();
  }

  private async flush(cardKey: string): Promise<void> {
    const item = this.pending.get(cardKey);
    if (!item || item.inFlight || this.stopped) return;
    item.inFlight = true;
    item.requestedWhileInFlight = false;
    const version = item.desiredVersion;
    const priority = item.priority;
    const startedAt = Date.now();
    let failed = false;
    try {
      await this.deliver(cardKey, version);
      item.consecutiveFailures = 0;
      this.lastSuccessfulFlushAt = new Date().toISOString();
      this.reportFlush({ cardKey, desiredVersion: version, priority, latencyMs: Math.max(0, Date.now() - startedAt), outcome: "succeeded" });
    } catch (error) {
      failed = true;
      this.failures += 1;
      item.consecutiveFailures += 1;
      this.reportError(error, cardKey, version);
      this.reportFlush({ cardKey, desiredVersion: version, priority, latencyMs: Math.max(0, Date.now() - startedAt), outcome: "failed" });
    } finally {
      item.inFlight = false;
      if (this.stopped) return;
      if (failed || item.desiredVersion > version || item.requestedWhileInFlight) {
        if (!failed && (item.priority === "terminal" || item.requestedWhileInFlight)) this.launchFlush(cardKey);
        else {
          const retryDelayMs = failed
            ? Math.min(Math.max(1, this.intervalMs) * (2 ** (item.consecutiveFailures - 1)), 30_000)
            : this.intervalMs;
          item.dueAt = Date.now() + retryDelayMs;
          this.arm(cardKey, item);
        }
      } else this.pending.delete(cardKey);
    }
  }

  private reportError(error: unknown, cardKey: string, version: number): void {
    try { this.onError?.(error, cardKey, version); } catch { /* Error boundaries must not reject background work. */ }
  }

  private reportFlush(result: CardUpdateFlushResult): void {
    try { this.onFlush?.(result); } catch { /* Diagnostics must not reject background work. */ }
  }
}

function priorityRank(priority: CardUpdatePriority): number { return priority === "terminal" ? 2 : priority === "interactive" ? 1 : 0; }
