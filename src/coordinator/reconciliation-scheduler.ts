import type { Logger } from "pino";
import type { ReconciliationDiagnostics } from "../domain/types.js";
import { ReconciliationRunMetrics } from "../runtime/reconciliation-run-metrics.js";
import { safeLogError } from "../runtime/safe-error.js";
import { mergeReconciliationScope, reconciliationCooldownCovers, reconciliationScopeCovers, type ReconciliationScope } from "./reconciliation-scope-policy.js";

const EVENT_RECONCILIATION_COOLDOWN_MS = 1_000;

export class ReconciliationScheduler {
  private reconciliation: Promise<void> | null = null;
  private pending: ReconciliationScope | undefined;
  private active: ReconciliationScope | undefined;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly lastReconciledAt = new Map<string, number>();
  private readonly metrics = new ReconciliationRunMetrics();

  constructor(private readonly options: { configuredWorkspaceIds: ReadonlySet<string>; execute(scope?: ReadonlySet<string>): Promise<ReadonlySet<string>>; logger: Logger }) {}

  async reconcile(workspaceIds?: readonly string[]): Promise<void> {
    if (this.stopping) return;
    if (this.reconciliation) { this.metrics.markCoalesced(); return this.reconciliation; }
    this.enqueue(workspaceIds);
    return this.startDrain();
  }

  async request(workspaceIds?: readonly string[]): Promise<void> {
    if (this.stopping) return;
    if (this.reconciliation && reconciliationScopeCovers(this.active, workspaceIds)) { this.metrics.markCoalesced(); return this.reconciliation; }
    if (!this.reconciliation && reconciliationCooldownCovers({ ...(workspaceIds ? { requestedWorkspaceIds: workspaceIds } : {}), configuredWorkspaceIds: this.options.configuredWorkspaceIds, lastReconciledAt: this.lastReconciledAt, now: performance.now(), cooldownMs: EVENT_RECONCILIATION_COOLDOWN_MS })) { this.metrics.markCoalesced(); return; }
    this.enqueue(workspaceIds);
    if (this.reconciliation) { this.metrics.markCoalesced(); return this.reconciliation; }
    return this.startDrain();
  }

  async waitForIdle(): Promise<void> { if (this.reconciliation) await this.reconciliation; }
  isStopping(): boolean { return this.stopping; }
  snapshot(): ReconciliationDiagnostics { return this.metrics.snapshot(this.stopping ? "stopping" : this.reconciliation ? "running" : "idle"); }

  start(intervalMs: number): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => { void this.reconcile().catch((error) => this.options.logger.error({ event: "reconciliation-failed", err: safeLogError(error), outcome: "failed" }, "reconciliation failed")); }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.waitForIdle();
  }

  private enqueue(workspaceIds?: readonly string[]): void { this.pending = mergeReconciliationScope(this.pending, workspaceIds); }
  private async startDrain(): Promise<void> {
    const work = this.drain();
    this.reconciliation = work;
    try { await work; } finally { if (this.reconciliation === work) this.reconciliation = null; }
  }
  private async drain(): Promise<void> {
    while (this.pending !== undefined && !this.stopping) {
      const requested = this.pending;
      this.pending = undefined;
      this.active = requested;
      try {
        await this.metrics.measure(async () => {
          const reconciled = await this.options.execute(requested === null ? undefined : requested);
          const completedAt = performance.now();
          for (const workspaceId of reconciled) this.lastReconciledAt.set(workspaceId, completedAt);
        });
      } finally { this.active = undefined; }
    }
  }
}
