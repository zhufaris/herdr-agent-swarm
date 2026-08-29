interface PendingCardUpdate { desiredVersion: number; timer: NodeJS.Timeout | null; inFlight: boolean; immediate: boolean; consecutiveFailures: number }

export class CardUpdateScheduler {
  private readonly pending = new Map<string, PendingCardUpdate>();
  private stopped = false;

  constructor(
    private readonly deliver: (promptId: string, version: number) => Promise<void>,
    private readonly intervalMs = 750,
    private readonly onError?: (error: unknown, promptId: string, version: number) => void
  ) {}

  schedule(promptId: string, version: number, immediate: boolean): void {
    if (this.stopped) return;
    const item = this.pending.get(promptId) ?? { desiredVersion: version, timer: null, inFlight: false, immediate: false, consecutiveFailures: 0 };
    item.desiredVersion = Math.max(item.desiredVersion, version);
    item.immediate ||= immediate;
    this.pending.set(promptId, item);
    if (item.inFlight) return;
    if (item.immediate) {
      if (item.timer) clearTimeout(item.timer);
      item.timer = null;
      this.launchFlush(promptId);
    } else if (!item.timer) {
      item.timer = setTimeout(() => { item.timer = null; this.launchFlush(promptId); }, this.intervalMs);
      item.timer.unref?.();
    }
  }

  private launchFlush(promptId: string): void {
    void this.flush(promptId).catch((error) => this.reportError(error, promptId, this.pending.get(promptId)?.desiredVersion ?? 0));
  }

  stop(): void {
    this.stopped = true;
    for (const item of this.pending.values()) if (item.timer) clearTimeout(item.timer);
    this.pending.clear();
  }

  private async flush(promptId: string): Promise<void> {
    const item = this.pending.get(promptId);
    if (!item || item.inFlight || this.stopped) return;
    item.inFlight = true;
    const version = item.desiredVersion;
    item.immediate = false;
    let failed = false;
    try {
      await this.deliver(promptId, version);
      item.consecutiveFailures = 0;
    } catch (error) {
      failed = true;
      item.consecutiveFailures += 1;
      this.reportError(error, promptId, version);
    } finally {
      item.inFlight = false;
      if (this.stopped) return;
      if (failed || item.desiredVersion > version) {
        if (!failed && item.immediate) this.launchFlush(promptId);
        else {
          const retryDelayMs = failed
            ? Math.min(Math.max(1, this.intervalMs) * (2 ** (item.consecutiveFailures - 1)), 30_000)
            : this.intervalMs;
          item.timer = setTimeout(() => { item.timer = null; this.launchFlush(promptId); }, retryDelayMs);
          item.timer.unref?.();
        }
      } else this.pending.delete(promptId);
    }
  }

  private reportError(error: unknown, promptId: string, version: number): void {
    try { this.onError?.(error, promptId, version); } catch { /* Error boundaries must not reject background work. */ }
  }
}
