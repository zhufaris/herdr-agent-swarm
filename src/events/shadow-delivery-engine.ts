import type { DeliveryCacheSource, DeliveryEngine, DeliveryEngineEvent, DeliveryEngineLimits, DeliveryEngineObserver, DeliveryEngineRefillPort, DeliveryEngineState, DeliverySnapshot } from "../domain/delivery-engine.js";
import type { PreparedDelivery } from "../domain/delivery.js";
import type { DeliveryScope } from "../domain/delivery-scope.js";
import { deliveryScopeKey } from "../domain/delivery-scope.js";
import { DeliveryReadyScheduler } from "./delivery-ready-scheduler.js";
import { PreparedDeliveryRing } from "./prepared-delivery-ring.js";

const DEFAULT_LIMITS: DeliveryEngineLimits = {
  paneItems: 32, paneBytes: 1024 * 1024, globalItems: 64, globalBytes: 2 * 1024 * 1024, processBytes: 32 * 1024 * 1024
};
const NOOP_OBSERVER: DeliveryEngineObserver = { record() {} };

export interface ShadowDeliveryEngineOptions {
  refill?: DeliveryEngineRefillPort;
  observer?: DeliveryEngineObserver;
  limits?: Partial<DeliveryEngineLimits>;
  now?: () => number;
  idleEvictionMs?: number;
  maintenanceIntervalMs?: number;
  refillLimit?: number;
  scheduleMaintenance?: (callback: () => void, delayMs: number) => unknown;
  cancelMaintenance?: (handle: unknown) => void;
}

/** Read-only scheduling shadow. This type deliberately has no claim or Gateway executor dependency. */
export class ShadowDeliveryEngine implements DeliveryEngine {
  private readonly rings = new Map<string, PreparedDeliveryRing>();
  private readonly scheduler = new DeliveryReadyScheduler(4);
  private readonly observer: DeliveryEngineObserver;
  private readonly limits: DeliveryEngineLimits;
  private readonly now: () => number;
  private readonly pendingRefills = new Set<string>();
  private readonly activeRefills = new Set<Promise<void>>();
  private state: DeliveryEngineState = "stopped";
  private cachedBytes = 0;
  private maintenanceHandle: unknown = null;
  private grantQueued = false;
  private lastRefillAt: string | null = null;
  private lastFailureAt: string | null = null;
  private nextRetryAt: string | null = null;

  constructor(private readonly options: ShadowDeliveryEngineOptions = {}) {
    this.observer = options.observer ?? NOOP_OBSERVER;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.state === "running" || this.state === "starting") return;
    if (this.state === "stopping") return;
    this.state = "starting";
    this.state = "running";
    this.requestRefill(null, "startup");
    this.armMaintenance();
  }

  enqueue(delivery: PreparedDelivery): void { this.offer(delivery, "commit"); }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    if (this.maintenanceHandle !== null) this.cancelMaintenance(this.maintenanceHandle);
    this.maintenanceHandle = null;
    this.scheduler.clear();
    await Promise.all([...this.activeRefills]);
    this.rings.clear();
    this.pendingRefills.clear();
    this.cachedBytes = 0;
    this.state = "stopped";
  }

  snapshot(): DeliverySnapshot {
    const entries = [...this.rings.values()].map((ring) => ({ ring, head: ring.head(), entry: ring.headEntry(), snapshot: ring.snapshot() }));
    const snapshotNow = this.now();
    const ready = entries.filter(({ ring }) => ring.isRunnable(snapshotNow));
    const cachedNextRetryAt = entries.map(({ head }) => head?.nextAttemptAt ?? null)
      .filter((value): value is string => value !== null && Date.parse(value) > snapshotNow)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
    const oldest = (workClass?: "live" | "history") => {
      const values = ready.filter(({ head }) => !workClass || head?.workClass === workClass).map(({ entry }) => entry!.enqueuedAt);
      return values.length > 0 ? new Date(Math.min(...values)).toISOString() : null;
    };
    return {
      state: this.state, ringCount: entries.length, runnableRings: ready.length, activeDeliveries: 0,
      cachedItems: entries.reduce((sum, item) => sum + item.snapshot.itemCount, 0), cachedBytes: this.cachedBytes,
      processByteLimit: this.limits.processBytes, overflowedScopes: entries.filter((item) => item.snapshot.overflowed).length,
      quarantinedScopes: 0, oldestReadyAt: oldest(), oldestLiveReadyAt: oldest("live"), oldestHistoryReadyAt: oldest("history"),
      nextRetryAt: earlier(this.nextRetryAt, cachedNextRetryAt), lastRefillAt: this.lastRefillAt,
      safetyScanRuns: 0, safetyScanDiscoveries: 0, lastSafetyScanAt: null, lastSafetyScanDiscoveryAt: null,
      lastDeliveryAt: null, lastFailureAt: this.lastFailureAt
      , recoveryReady: this.state === "running"
    };
  }

  whenRecoveryReady(): Promise<void> { return Promise.resolve(); }

  private offer(delivery: PreparedDelivery, source: DeliveryCacheSource): void {
    const key = deliveryScopeKey(delivery.scope);
    if (this.state !== "running" && this.state !== "degraded") {
      this.record({ kind: "enqueue-rejected", replyId: delivery.replyId, scopeKey: key, reason: "stopped", source });
      return;
    }
    const now = this.now();
    const ring = this.ensureRing(delivery.scope, now);
    const existing = ring.hasReplyId(delivery.replyId);
    if (!existing && this.cachedBytes + delivery.estimatedBytes > this.limits.processBytes) {
      ring.markOverflow(now);
      this.record({ kind: "enqueue-rejected", replyId: delivery.replyId, scopeKey: key, reason: "overflow", source });
      this.requestRefill(delivery.scope, "overflow");
      return;
    }
    const result = ring.offer(delivery, source, now);
    if (result.outcome === "accepted") {
      this.cachedBytes += result.retainedBytes;
      this.record({ kind: "enqueue-accepted", replyId: delivery.replyId, scopeKey: key, source, workClass: delivery.workClass, deliveryOrder: delivery.deliveryOrder });
      this.makeReady(ring, now);
      return;
    }
    if (result.outcome === "duplicate") {
      this.record({ kind: "enqueue-duplicate", replyId: delivery.replyId, scopeKey: key, source, workClass: delivery.workClass, deliveryOrder: delivery.deliveryOrder });
      return;
    }
    const reason = result.outcome === "stale" ? "stale" : result.outcome;
    this.record({ kind: "enqueue-rejected", replyId: delivery.replyId, scopeKey: key, reason, source });
    this.requestRefill(delivery.scope, result.outcome === "stale" ? "stale" : "overflow");
  }

  private ensureRing(scope: DeliveryScope, now: number): PreparedDeliveryRing {
    const key = deliveryScopeKey(scope);
    const existing = this.rings.get(key);
    if (existing) return existing;
    const limits = scope.kind === "global"
      ? { itemLimit: this.limits.globalItems, byteLimit: this.limits.globalBytes }
      : { itemLimit: this.limits.paneItems, byteLimit: this.limits.paneBytes };
    const ring = new PreparedDeliveryRing(scope, limits, now);
    this.rings.set(key, ring);
    return ring;
  }

  private makeReady(ring: PreparedDeliveryRing, now: number): void {
    const head = ring.head();
    if (!head || !ring.markReadyToken(now)) return;
    this.scheduler.offer(ring.key, head.workClass, now);
    if (this.grantQueued) return;
    this.grantQueued = true;
    queueMicrotask(() => { this.grantQueued = false; this.drainShadowGrants(); });
  }

  private drainShadowGrants(): void {
    if (this.state !== "running" && this.state !== "degraded") return;
    let grant = this.scheduler.claim();
    while (grant) {
      const ring = this.rings.get(grant.ringKey);
      const entry = ring?.headEntry();
      if (ring && entry) {
        const now = this.now();
        ring.beginGrant(now);
        this.record({ kind: "shadow-grant", replyId: entry.delivery.replyId, scopeKey: ring.key, workClass: entry.delivery.workClass, deliveryOrder: entry.delivery.deliveryOrder, source: entry.source, waitMs: Math.max(0, now - grant.readyAt) });
        ring.finishShadowGrant(now);
      }
      this.scheduler.release(grant.ringKey);
      grant = this.scheduler.claim();
    }
  }

  private requestRefill(scope: DeliveryScope | null, reason: "startup" | "overflow" | "stale" | "safety"): void {
    const key = scope ? deliveryScopeKey(scope) : "*";
    if (this.pendingRefills.has(key)) return;
    this.pendingRefills.add(key);
    this.record({ kind: "refill-requested", scopeKey: scope ? key : null, reason });
    if (!this.options.refill) return;
    const now = new Date(this.now()).toISOString();
    const refill = this.options.refill.load({ scope, limit: this.options.refillLimit ?? 64, now }).then((result) => {
      if (this.state !== "running" && this.state !== "degraded") return;
      this.pendingRefills.delete(key);
      this.lastRefillAt = new Date(this.now()).toISOString();
      this.nextRetryAt = scope === null ? result.nextRetryAt : earlier(this.nextRetryAt, result.nextRetryAt);
      for (const delivery of result.deliveries) this.offer(delivery, "cold");
      if (this.state === "degraded") this.state = "running";
      this.record({ kind: "refill-completed", scopeKey: scope ? key : null, count: result.deliveries.length });
    }, () => {
      this.pendingRefills.delete(key);
      this.lastFailureAt = new Date(this.now()).toISOString();
      this.state = "degraded";
      this.record({ kind: "refill-failed", scopeKey: scope ? key : null });
    });
    const settled = refill.catch(() => undefined).finally(() => this.activeRefills.delete(settled));
    this.activeRefills.add(settled);
  }

  private armMaintenance(): void {
    if (this.state !== "running" && this.state !== "degraded") return;
    this.maintenanceHandle = this.scheduleMaintenance(() => {
      this.maintenanceHandle = null;
      if (this.state !== "running" && this.state !== "degraded") return;
      this.requestRefill(null, "safety");
      const now = this.now();
      for (const ring of this.rings.values()) this.makeReady(ring, now);
      void this.evictIdle().finally(() => this.armMaintenance());
    }, this.options.maintenanceIntervalMs ?? 30_000);
  }

  private async evictIdle(): Promise<void> {
    if (!this.options.refill) return;
    const now = this.now();
    const cutoff = now - (this.options.idleEvictionMs ?? 300_000);
    for (const [key, ring] of this.rings) {
      if (!ring.isEmpty || ring.hasReadyToken || ring.hasActiveGrant || ring.touchedAt > cutoff) continue;
      const revision = ring.revision;
      if (!await this.options.refill.isDurablyEmpty(ring.scope, new Date(now).toISOString())) continue;
      if (this.rings.get(key) !== ring || ring.revision !== revision || !ring.isEmpty || ring.hasReadyToken || ring.hasActiveGrant) continue;
      this.rings.delete(key);
      this.scheduler.remove(key);
      this.record({ kind: "ring-evicted", scopeKey: key });
    }
  }

  private scheduleMaintenance(callback: () => void, delayMs: number): unknown {
    if (this.options.scheduleMaintenance) return this.options.scheduleMaintenance(callback, delayMs);
    const timer = setTimeout(callback, delayMs); timer.unref?.(); return timer;
  }
  private cancelMaintenance(handle: unknown): void {
    if (this.options.cancelMaintenance) this.options.cancelMaintenance(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
  private record(event: DeliveryEngineEvent): void {
    try { this.observer.record(event); } catch { /* diagnostics must not destabilize scheduling */ }
  }
}

function earlier(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}
