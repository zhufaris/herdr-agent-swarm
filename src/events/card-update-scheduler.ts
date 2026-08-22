interface PendingCardUpdate { desiredVersion: number; timer: NodeJS.Timeout | null; inFlight: boolean; immediate: boolean }

export class CardUpdateScheduler {
  private readonly pending = new Map<string, PendingCardUpdate>();
  private stopped = false;

  constructor(private readonly deliver: (promptId: string, version: number) => Promise<void>, private readonly intervalMs = 2_000) {}

  schedule(promptId: string, version: number, immediate: boolean): void {
    if (this.stopped) return;
    const item = this.pending.get(promptId) ?? { desiredVersion: version, timer: null, inFlight: false, immediate: false };
    item.desiredVersion = Math.max(item.desiredVersion, version);
    item.immediate ||= immediate;
    this.pending.set(promptId, item);
    if (item.inFlight) return;
    if (item.immediate) {
      if (item.timer) clearTimeout(item.timer);
      item.timer = null;
      void this.flush(promptId);
    } else if (!item.timer) {
      item.timer = setTimeout(() => { item.timer = null; void this.flush(promptId); }, this.intervalMs);
      item.timer.unref?.();
    }
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
    try { await this.deliver(promptId, version); } finally {
      item.inFlight = false;
      if (this.stopped) return;
      if (item.desiredVersion > version) {
        if (item.immediate) void this.flush(promptId);
        else {
          item.timer = setTimeout(() => { item.timer = null; void this.flush(promptId); }, this.intervalMs);
          item.timer.unref?.();
        }
      } else this.pending.delete(promptId);
    }
  }
}
