import type { ReconciliationDiagnostics } from "../domain/types.js";
import { ReconciliationRunMetrics } from "./reconciliation-run-metrics.js";

export type PriorityReconciliationScope =
  | { kind: "panes"; ids: readonly string[] }
  | { kind: "workspaces"; ids: readonly string[] }
  | { kind: "all" };

type ScopeDelays = Record<PriorityReconciliationScope["kind"], number | null>;

export interface PriorityReconciliationRunnerSnapshot extends ReconciliationDiagnostics {
  activeScopeKind: PriorityReconciliationScope["kind"] | null;
  pendingPaneCount: number;
  pendingWorkspaceCount: number;
  fullPending: boolean;
  priorityPromotionCount: number;
  lastAcceptedToStartMs: ScopeDelays;
  maxAcceptedToStartMs: ScopeDelays;
}

interface Waiter { resolve(): void; reject(error: unknown): void }
interface PendingIds { ids: Set<string>; waiters: Waiter[]; acceptedAt: number | null }
interface PendingAll { requested: boolean; waiters: Waiter[]; acceptedAt: number | null }

export class PriorityReconciliationRunner {
  private readonly panes: PendingIds = { ids: new Set(), waiters: [], acceptedAt: null };
  private readonly workspaces: PendingIds = { ids: new Set(), waiters: [], acceptedAt: null };
  private readonly all: PendingAll = { requested: false, waiters: [], acceptedAt: null };
  private active: Promise<void> | null = null;
  private activeScope: PriorityReconciliationScope | null = null;
  private activeScopeKind: PriorityReconciliationScope["kind"] | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private priorityPromotionCount = 0;
  private readonly metrics = new ReconciliationRunMetrics();
  private readonly lastAcceptedToStartMs: ScopeDelays = { panes: null, workspaces: null, all: null };
  private readonly maxAcceptedToStartMs: ScopeDelays = { panes: null, workspaces: null, all: null };

  constructor(private readonly options: { execute(scope: PriorityReconciliationScope): Promise<unknown>; clock?: () => number }) {}

  request(scope: PriorityReconciliationScope, options: { allowActiveCoverage?: boolean } = {}): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (options.allowActiveCoverage && this.active && this.activeScope && activeScopeCovers(this.activeScope, scope)) {
      this.metrics.markCoalesced();
      return this.active;
    }
    const acceptedAt = this.clock();
    if (this.active) this.metrics.markCoalesced();
    const promise = new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (scope.kind === "panes") { for (const id of scope.ids) this.panes.ids.add(id); this.panes.waiters.push(waiter); this.panes.acceptedAt ??= acceptedAt; }
      else if (scope.kind === "workspaces") { for (const id of scope.ids) this.workspaces.ids.add(id); this.workspaces.waiters.push(waiter); this.workspaces.acceptedAt ??= acceptedAt; }
      else { this.all.requested = true; this.all.waiters.push(waiter); this.all.acceptedAt ??= acceptedAt; }
    });
    if (!this.active) this.startDrain();
    return promise;
  }

  markCoalesced(): void { this.metrics.markCoalesced(); }

  start(intervalMs: number): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => { void this.request({ kind: "all" }, { allowActiveCoverage: true }).catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.discard(this.panes);
    this.discard(this.workspaces);
    this.all.requested = false;
    this.all.acceptedAt = null;
    for (const waiter of this.all.waiters.splice(0)) waiter.resolve();
    if (this.active) await this.active;
  }

  snapshot(): PriorityReconciliationRunnerSnapshot {
    const state = this.stopping ? "stopping" : this.active ? "running" : "idle";
    return { ...this.metrics.snapshot(state),
      activeScopeKind: this.activeScopeKind,
      pendingPaneCount: this.panes.ids.size, pendingWorkspaceCount: this.workspaces.ids.size,
      fullPending: this.all.requested, priorityPromotionCount: this.priorityPromotionCount,
      lastAcceptedToStartMs: { ...this.lastAcceptedToStartMs }, maxAcceptedToStartMs: { ...this.maxAcceptedToStartMs }
    };
  }

  private startDrain(): void {
    const active = this.drain();
    this.active = active;
    void active.finally(() => { if (this.active === active) this.active = null; }).catch(() => {});
  }

  private async drain(): Promise<void> {
    let firstError: unknown;
    while (!this.stopping) {
      const next = this.takeNext();
      if (!next) break;
      this.activeScopeKind = next.scope.kind;
      this.activeScope = next.scope;
      this.recordStartDelay(next.scope.kind, next.acceptedAt);
      try { await this.metrics.measure(() => this.options.execute(next.scope)); for (const waiter of next.waiters) waiter.resolve(); }
      catch (error) { firstError ??= error; for (const waiter of next.waiters) waiter.reject(error); }
      finally { this.activeScopeKind = null; this.activeScope = null; }
    }
    if (firstError !== undefined) throw firstError;
  }

  private takeNext(): { scope: PriorityReconciliationScope; waiters: Waiter[]; acceptedAt: number } | null {
    if (this.panes.waiters.length > 0) {
      if (this.workspaces.waiters.length > 0 || this.all.requested) this.priorityPromotionCount += 1;
      const result = { scope: { kind: "panes", ids: [...this.panes.ids] } as const, waiters: this.panes.waiters.splice(0), acceptedAt: this.panes.acceptedAt ?? this.clock() };
      this.panes.ids.clear();
      this.panes.acceptedAt = null;
      return result;
    }
    if (this.workspaces.waiters.length > 0) {
      if (this.all.requested) this.priorityPromotionCount += 1;
      const result = { scope: { kind: "workspaces", ids: [...this.workspaces.ids] } as const, waiters: this.workspaces.waiters.splice(0), acceptedAt: this.workspaces.acceptedAt ?? this.clock() };
      this.workspaces.ids.clear();
      this.workspaces.acceptedAt = null;
      return result;
    }
    if (this.all.requested) {
      this.all.requested = false;
      const result = { scope: { kind: "all" } as const, waiters: this.all.waiters.splice(0), acceptedAt: this.all.acceptedAt ?? this.clock() };
      this.all.acceptedAt = null;
      return result;
    }
    return null;
  }

  private clock(): number { return this.options.clock?.() ?? performance.now(); }
  private recordStartDelay(kind: PriorityReconciliationScope["kind"], acceptedAt: number): void {
    const delay = Math.max(0, Math.round(this.clock() - acceptedAt));
    this.lastAcceptedToStartMs[kind] = delay;
    this.maxAcceptedToStartMs[kind] = Math.max(this.maxAcceptedToStartMs[kind] ?? 0, delay);
  }
  private discard(pending: PendingIds): void {
    pending.ids.clear();
    pending.acceptedAt = null;
    for (const waiter of pending.waiters.splice(0)) waiter.resolve();
  }
}

function activeScopeCovers(active: PriorityReconciliationScope, requested: PriorityReconciliationScope): boolean {
  if (active.kind === "all") return requested.kind === "all";
  if (active.kind !== requested.kind || active.kind === "panes") return false;
  const activeIds = new Set(active.ids);
  return requested.ids.every((id) => activeIds.has(id));
}
