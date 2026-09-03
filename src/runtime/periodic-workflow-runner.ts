/**
 * Owns only periodic scheduling and single-flight execution. Domain workflows
 * retain their own work queues and safety decisions. Starting schedules future
 * runs; it intentionally does not trigger an eager pass.
 */
export class PeriodicWorkflowRunner {
  private active: Promise<void> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(private readonly options: { run(): Promise<void>; onError(error: unknown): void }) {}

  start(intervalMs: number): void {
    if (this.stopping || this.interval) return;
    this.interval = setInterval(() => { void this.request().catch((error) => this.options.onError(error)); }, intervalMs);
    this.interval.unref?.();
  }

  request(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (!this.active) {
      const active = this.options.run();
      this.active = active;
      void active.then(
        () => { if (this.active === active) this.active = null; },
        () => { if (this.active === active) this.active = null; }
      );
    }
    return this.active;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.active) await this.active;
  }

  get isStopping(): boolean { return this.stopping; }
}
