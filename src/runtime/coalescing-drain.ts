export interface CoalescingDrainSnapshot {
  state: "idle" | "running" | "stopping";
  requested: boolean;
}

interface Options {
  drain(): Promise<void>;
  onError(error: unknown): void;
}

export class CoalescingDrain {
  private active: Promise<void> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private requested = false;
  private stopping = true;

  constructor(private readonly options: Options) {}

  start(intervalMs?: number): void {
    this.stopping = false;
    if (intervalMs && intervalMs > 0 && !this.interval) {
      this.interval = setInterval(() => this.wake(), intervalMs);
      this.interval.unref?.();
    }
    this.wake();
  }

  request(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.requested = true;
    if (!this.active) this.activate();
    return this.active ?? Promise.resolve();
  }

  wake(): void {
    void this.request();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.active) await this.active;
  }

  snapshot(): CoalescingDrainSnapshot {
    return { state: this.stopping ? "stopping" : this.active ? "running" : "idle", requested: this.requested };
  }

  private activate(): void {
    const active = this.run().catch((error) => this.options.onError(error));
    this.active = active;
    void active.finally(() => {
      if (this.active === active) this.active = null;
      if (this.requested && !this.stopping) this.activate();
    });
  }

  private async run(): Promise<void> {
    while (this.requested && !this.stopping) {
      this.requested = false;
      await this.options.drain();
    }
  }
}
