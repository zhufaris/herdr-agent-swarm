export interface StartupViewRecoveryDiagnostics {
  state: "idle" | "retry_wait" | "running" | "stopping";
  pendingCount: number;
  fullRescanPending: boolean;
  retryCount: number;
  recoveredCount: number;
  lastFailureAt: string | null;
  lastFailure: string | null;
}

export interface StartupViewRecoveryOptions {
  convergeAll(): Promise<readonly string[]>;
  convergeBindings(bindingIds: readonly string[]): Promise<readonly string[]>;
  maxPendingIds?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class StartupViewRecovery {
  private readonly pending = new Set<string>();
  private readonly maxPendingIds: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private fullRescanPending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private started = false;
  private stopping = false;
  private attempt = 0;
  private retryCount = 0;
  private recoveredCount = 0;
  private lastFailureAt: string | null = null;
  private lastFailure: string | null = null;

  constructor(private readonly options: StartupViewRecoveryOptions) {
    this.maxPendingIds = options.maxPendingIds ?? 256;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 60_000;
  }

  add(bindingIds: readonly string[]): void {
    for (const bindingId of bindingIds) {
      if (this.pending.size < this.maxPendingIds || this.pending.has(bindingId)) this.pending.add(bindingId);
      else this.fullRescanPending = true;
    }
    if (this.started) this.schedule();
  }

  requestFullRescan(): void {
    this.fullRescanPending = true;
    if (this.started) this.schedule();
  }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) await this.active;
  }

  snapshot(): StartupViewRecoveryDiagnostics {
    return {
      state: this.stopping ? "stopping" : this.active ? "running" : this.timer ? "retry_wait" : "idle",
      pendingCount: this.pending.size, fullRescanPending: this.fullRescanPending, retryCount: this.retryCount, recoveredCount: this.recoveredCount,
      lastFailureAt: this.lastFailureAt, lastFailure: this.lastFailure
    };
  }

  private schedule(): void {
    if (this.stopping || this.timer || this.active || !this.hasPending()) return;
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** this.attempt);
    this.timer = setTimeout(() => { this.timer = null; this.startRun(); }, delay);
    this.timer.unref?.();
  }

  private startRun(): void {
    if (this.stopping || this.active || !this.hasPending()) return;
    const run = this.run();
    this.active = run;
    void run.finally(() => {
      if (this.active !== run) return;
      this.active = null;
      this.schedule();
    }).catch(() => {});
  }

  private async run(): Promise<void> {
    const full = this.fullRescanPending;
    const captured = [...this.pending];
    this.fullRescanPending = false;
    this.pending.clear();
    this.retryCount += 1;
    try {
      const failed = full ? await this.options.convergeAll() : await this.options.convergeBindings(captured);
      const failedSet = new Set(failed);
      this.recoveredCount += captured.filter((bindingId) => !failedSet.has(bindingId)).length;
      this.attempt = failed.length > 0 ? this.attempt + 1 : 0;
      this.add(failed);
      this.lastFailure = failed.length > 0 ? `${failed.length} startup view bindings remain unconverged` : null;
      this.lastFailureAt = failed.length > 0 ? new Date().toISOString() : null;
    } catch (error) {
      this.attempt += 1;
      this.lastFailureAt = new Date().toISOString();
      this.lastFailure = error instanceof Error ? error.message : String(error);
      if (full) this.fullRescanPending = true;
      this.add(captured);
    }
  }

  private hasPending(): boolean { return this.fullRescanPending || this.pending.size > 0; }
}
