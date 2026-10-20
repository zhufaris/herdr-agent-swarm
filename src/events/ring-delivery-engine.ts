import type { DeliveryCacheSource, DeliveryEngine, DeliveryEngineLimits, DeliveryEngineRefillPort, DeliveryEngineState, DeliveryEngineStopContext, DeliverySnapshot } from "../domain/delivery-engine.js";
import type { DeliveryFailureMetadata, DeliveryRingWork, PreparedDelivery, PreparedDeliveryAck } from "../domain/delivery.js";
import type { PreparedDeliveryProjectionRecoveryHint, PreparedDeliveryStore } from "../domain/ports/prepared-delivery.js";
import type { DeliveryScope } from "../domain/delivery-scope.js";
import { deliveryScopeKey } from "../domain/delivery-scope.js";
import { GatewayDeliveryError, GatewayPreparationError, type GatewayDeliveryPort, type GatewayDeliveryReceipt, type SemanticGatewayDeliveryPreparer } from "../gateways/contract/plugin.js";
import { DeliveryReadyScheduler } from "./delivery-ready-scheduler.js";
import { PreparedDeliveryRing } from "./prepared-delivery-ring.js";
import type { DeliveryLatencyTrace } from "../domain/delivery-trace.js";
import type { OutboundWorkHint } from "./outbound-work-notifier.js";
import { observeDetached } from "../runtime/work-lifecycle.js";

const DEFAULT_LIMITS: DeliveryEngineLimits = {
  paneItems: 32, paneBytes: 1024 * 1024, globalItems: 64, globalBytes: 2 * 1024 * 1024, processBytes: 32 * 1024 * 1024
};
const DEFAULT_REFILL_SCOPE_LIMIT = 4;
const DEFAULT_REFILL_MAINTENANCE_LIMIT = 64;
const DEFAULT_QUARANTINE_SCOPE_LIMIT = 4;
const DEFAULT_INTERACTIVE_BACKOFF_MS = 25;
const MAX_INTERACTIVE_BACKOFF_MS = 1_000;
const PROCESS_STARTED_AT = new Date().toISOString();
const yieldEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const waitForDelay = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

export interface RingDeliveryEngineOptions {
  store: PreparedDeliveryStore;
  gateway: GatewayDeliveryPort;
  prepareSemanticDelivery?: SemanticGatewayDeliveryPreparer;
  refill?: DeliveryEngineRefillPort;
  limits?: Partial<DeliveryEngineLimits>;
  now?: () => number;
  claimTtlMs?: number;
  /** T6 owns production cold recovery. T5 tests may opt into the hot cohort without enabling it. */
  coldRecoveryEnabled?: boolean;
  onAcknowledged?: (delivery: PreparedDelivery, ack: PreparedDeliveryAck) => void;
  onFailed?: (delivery: PreparedDelivery, outcome: "retry" | "dead_letter" | "stale") => void;
  onProjectionRecoveryHints?: (hints: readonly PreparedDeliveryProjectionRecoveryHint[]) => void | Promise<void>;
  safetyScanIntervalMs?: number;
  refillLimit?: number;
  yieldRefillPage?: () => Promise<void>;
  interactiveBackoffMs?: number;
  waitForInteractiveBackoff?: (delayMs: number) => Promise<void>;
  deliveryTrace?: DeliveryLatencyTrace;
  scheduleWake?: (callback: () => void, delayMs: number) => unknown;
  cancelWake?: (handle: unknown) => void;
  scheduleMaintenance?: (callback: () => void, delayMs: number) => unknown;
  cancelMaintenance?: (handle: unknown) => void;
  subscribeWork?: (listener: (hint?: OutboundWorkHint) => void) => () => void;
  processStartedAt?: string;
}

class RingCheckpointError extends Error {}
type RefillCause = "ordinary" | "safety";
type RefillOutcome = "complete" | "yielded";

/** Execution-enabled Ring protocol. Production composition remains on ShadowDeliveryEngine until T6. */
export class RingDeliveryEngine implements DeliveryEngine {
  private readonly rings = new Map<string, PreparedDeliveryRing<DeliveryRingWork>>();
  private readonly scheduler = new DeliveryReadyScheduler(4);
  private readonly active = new Set<Promise<void>>();
  private readonly activeRefills = new Set<Promise<RefillOutcome>>();
  private readonly pendingRefills = new Map<string, Promise<RefillOutcome>>();
  private readonly oversized = new Map<string, DeliveryRingWork>();
  private readonly limits: DeliveryEngineLimits;
  private readonly now: () => number;
  private state: DeliveryEngineState = "stopped";
  private cachedBytes = 0;
  private drainQueued = false;
  private lastDeliveryAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastRefillAt: string | null = null;
  private safetyScanRuns = 0;
  private safetyScanDiscoveries = 0;
  private pendingSafetyScanDiscoveries = 0;
  private lastSafetyScanAt: string | null = null;
  private lastSafetyScanDiscoveryAt: string | null = null;
  private nextRetryAt: string | null = null;
  private retryHandle: unknown = null;
  private maintenanceHandle: unknown = null;
  private recoveryReady = false;
  private recoveryPromise: Promise<void> = Promise.resolve();
  private unsubscribeWork: (() => void) | null = null;
  private interactiveWorkRevision = 0;
  private globalRefillLoop: Promise<void> | null = null;
  private globalRefillRequestRevision = 0;
  private pendingGlobalRefillCause: RefillCause | null = null;
  private readonly processStartedAt: string;
  private readonly backoffStopWaiters = new Set<() => void>();

  constructor(private readonly options: RingDeliveryEngineOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.processStartedAt = options.processStartedAt ?? PROCESS_STARTED_AT;
  }

  start(): void {
    if (this.state !== "stopped") return;
    this.state = this.options.coldRecoveryEnabled ? "starting" : "running";
    this.unsubscribeWork = this.options.subscribeWork?.((hint = { kind: "recovery" }) => {
      this.interactiveWorkRevision += 1;
      if (!this.recoveryReady) return;
      if (hint.kind === "scope") {
        const key = deliveryScopeKey(hint.scope);
        const ring = this.rings.get(key);
        if (ring?.head() || this.oversized.has(key)) {
          if (ring) this.makeReady(ring, this.now());
          return;
        }
        observeDetached(this.runRefillToCompletion(hint.scope, "ordinary"), () => undefined);
        return;
      }
      void this.runRefillToCompletion(null, "ordinary");
    }) ?? null;
    this.recoveryReady = !this.options.coldRecoveryEnabled;
    this.recoveryPromise = this.options.coldRecoveryEnabled ? this.recoverStartup() : Promise.resolve();
  }

  whenRecoveryReady(): Promise<void> { return this.recoveryPromise; }

  enqueue(delivery: DeliveryRingWork): void {
    this.offer(delivery, "commit");
  }

  private offer(delivery: DeliveryRingWork, source: DeliveryCacheSource): boolean {
    if (this.state !== "running" && this.state !== "degraded" && this.state !== "starting") return false;
    const now = this.now();
    const ring = this.ensureRing(delivery, now);
    const invalidated = ring.invalidateSupersededHistory(delivery, now);
    if (invalidated.releasedBytes > 0) {
      this.cachedBytes -= invalidated.releasedBytes;
      if (invalidated.readyTokenStale && !ring.hasActiveGrant) this.scheduler.remove(ring.key);
    }
    const existing = ring.hasReplyId(delivery.replyId);
    if (!existing && this.cachedBytes + delivery.estimatedBytes > this.limits.processBytes) {
      ring.markOverflow(now);
      if (invalidated.readyTokenStale) this.makeReady(ring, now);
      if (invalidated.removed.length > 0 && this.options.coldRecoveryEnabled) void this.refill(delivery.scope, true);
      if (source === "cold" && delivery.estimatedBytes > this.scopeByteLimit(delivery)) return this.offerOversized(delivery);
      else if (this.options.coldRecoveryEnabled) void this.refill(delivery.scope, true);
      return false;
    }
    const offered = ring.offer(delivery, source, now);
    if (offered.outcome !== "accepted") {
      if (invalidated.readyTokenStale) this.makeReady(ring, now);
      if (invalidated.removed.length > 0 && this.options.coldRecoveryEnabled) void this.refill(delivery.scope, true);
      if (offered.outcome === "oversized" && source === "cold") return this.offerOversized(delivery);
      else if (offered.outcome !== "duplicate" && this.options.coldRecoveryEnabled) void this.refill(delivery.scope, true);
      return false;
    }
    this.cachedBytes += offered.retainedBytes;
    this.makeReady(ring, now);
    if (invalidated.removed.length > 0 && this.options.coldRecoveryEnabled) void this.refill(delivery.scope, true);
    return true;
  }

  async stop(_context?: DeliveryEngineStopContext): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    this.unsubscribeWork?.();
    this.unsubscribeWork = null;
    this.cancelTimers();
    for (const stopWaiting of this.backoffStopWaiters) stopWaiting();
    this.backoffStopWaiters.clear();
    this.scheduler.clear();
    const refillResults = await Promise.allSettled([this.recoveryPromise, ...this.activeRefills]);
    const deliveryResults = await Promise.allSettled([...this.active]);
    this.scheduler.clear();
    this.rings.clear();
    this.oversized.clear();
    this.pendingRefills.clear();
    this.cachedBytes = 0;
    this.state = "stopped";
    const failures = [...refillResults, ...deliveryResults]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Ring delivery shutdown failed after cleanup");
  }

  snapshot(): DeliverySnapshot {
    const entries = [...this.rings.values()].map((ring) => ({ ring, head: ring.head(), entry: ring.headEntry(), snapshot: ring.snapshot() }));
    const now = this.now();
    const ready = entries.filter(({ ring }) => ring.isRunnable(now));
    const oldest = (workClass?: "live" | "history") => {
      const values = ready.filter(({ head }) => !workClass || head?.workClass === workClass).map(({ entry }) => entry!.enqueuedAt);
      return values.length ? new Date(Math.min(...values)).toISOString() : null;
    };
    return {
      ...(this.options.deliveryTrace ? { latency: this.options.deliveryTrace.snapshot() } : {}),
      state: this.state, ringCount: entries.length, runnableRings: ready.length, activeDeliveries: this.active.size,
      cachedItems: entries.reduce((sum, item) => sum + item.snapshot.itemCount, 0), cachedBytes: this.cachedBytes,
      processByteLimit: this.limits.processBytes, overflowedScopes: entries.filter((item) => item.snapshot.overflowed).length,
      quarantinedScopes: 0, oldestReadyAt: oldest(), oldestLiveReadyAt: oldest("live"), oldestHistoryReadyAt: oldest("history"),
      nextRetryAt: this.nextRetryAt, lastRefillAt: this.lastRefillAt, lastDeliveryAt: this.lastDeliveryAt, lastFailureAt: this.lastFailureAt,
      safetyScanRuns: this.safetyScanRuns, safetyScanDiscoveries: this.safetyScanDiscoveries,
      lastSafetyScanAt: this.lastSafetyScanAt, lastSafetyScanDiscoveryAt: this.lastSafetyScanDiscoveryAt,
      recoveryReady: this.recoveryReady
    };
  }

  private scopeByteLimit(delivery: DeliveryRingWork): number { return delivery.scope.kind === "global" ? this.limits.globalBytes : this.limits.paneBytes; }

  private offerOversized(delivery: DeliveryRingWork): boolean {
    const key = deliveryScopeKey(delivery.scope);
    const existing = this.oversized.get(key);
    if (existing && existing.replyId === delivery.replyId) return false;
    if (existing || this.rings.get(key)?.head()) return false;
    this.oversized.set(key, delivery);
    this.scheduler.offer(key, delivery.workClass, this.now());
    this.queueDrain();
    return true;
  }

  private ensureRing(delivery: DeliveryRingWork, now: number): PreparedDeliveryRing<DeliveryRingWork> {
    const key = deliveryScopeKey(delivery.scope);
    const existing = this.rings.get(key);
    if (existing) return existing;
    const limits = delivery.scope.kind === "global"
      ? { itemLimit: this.limits.globalItems, byteLimit: this.limits.globalBytes }
      : { itemLimit: this.limits.paneItems, byteLimit: this.limits.paneBytes };
    const ring = new PreparedDeliveryRing<DeliveryRingWork>(delivery.scope, limits, now);
    this.rings.set(key, ring);
    return ring;
  }

  private makeReady(ring: PreparedDeliveryRing<DeliveryRingWork>, now: number): void {
    if (this.state === "stopping" || this.state === "stopped") return;
    const head = ring.head();
    if (!head || ring.hasReadyToken || ring.hasActiveGrant || !ring.isRunnable(now)) return;
    if (!this.scheduler.offer(ring.key, head.workClass, now)) return;
    if (!ring.markReadyToken(now)) {
      this.scheduler.remove(ring.key);
      return;
    }
    this.queueDrain();
  }

  private queueDrain(): void {
    if (this.drainQueued) return;
    this.drainQueued = true;
    queueMicrotask(() => { this.drainQueued = false; this.drain(); });
  }

  private drain(): void {
    if (this.state !== "running" && this.state !== "degraded") return;
    let grant = this.scheduler.claim();
    while (grant) {
      const ringKey = grant.ringKey;
      const ring = this.rings.get(ringKey) ?? null;
      const direct = this.oversized.get(ringKey) ?? null;
      if (!ring?.head() && !direct) {
        this.scheduler.release(grant.ringKey);
      } else {
        ring?.beginGrant(this.now());
        const delivery = direct ?? ring!.head()!;
        const run = this.execute(delivery, ring).then(async (advance) => {
          this.scheduler.release(ringKey);
          if (typeof advance === "object") {
            await this.refill(advance, true);
          }
          const nextRing = this.rings.get(ringKey);
          if (nextRing) this.makeReady(nextRing, this.now());
        }, async () => {
          this.scheduler.release(ringKey);
          if (ring?.hasActiveGrant) this.discard(ring);
          else if (direct === delivery) this.oversized.delete(ringKey);
          this.lastFailureAt = new Date(this.now()).toISOString();
          if (this.options.coldRecoveryEnabled) await this.refill(delivery.scope, true);
        }).finally(() => {
          this.active.delete(run);
          this.queueDrain();
        });
        this.active.add(run);
      }
      grant = this.scheduler.claim();
    }
  }

  private async execute(work: DeliveryRingWork, ring: PreparedDeliveryRing<DeliveryRingWork> | null): Promise<boolean | PreparedDelivery["scope"]> {
    const prepared = this.prepareForExecution(work);
    if (!prepared) {
      if (ring) this.discard(ring); else this.oversized.delete(deliveryScopeKey(work.scope));
      if (this.options.coldRecoveryEnabled) return work.scope;
      return false;
    }
    const delivery = prepared;
    const advanced = this.options.store.advanceSupersededHead({ delivery, at: new Date(this.now()).toISOString() });
    if (advanced.outcome === "advanced") {
      if (ring) this.discardAll(ring); else this.oversized.delete(deliveryScopeKey(delivery.scope));
      return delivery.scope;
    }
    const claimedAt = this.now();
    const claimTtlMs = this.options.claimTtlMs ?? 60_000;
    const claimInput = { delivery, at: new Date(claimedAt).toISOString(), expiresAt: new Date(claimedAt + claimTtlMs).toISOString() };
    const conversationPage = delivery.projectionKey?.startsWith("turn-card:") === true;
    const claim = conversationPage
      ? this.options.store.claimConversationPageDelivery({
        ...claimInput, unclaimedCreateNotBefore: this.processStartedAt
      })
      : this.options.store.claimPreparedDelivery(claimInput);
    if (!claim) {
      this.options.deliveryTrace?.diagnose("stale_attempt", { replyId: delivery.replyId });
      if (ring) this.discard(ring); else this.oversized.delete(deliveryScopeKey(delivery.scope));
      if (this.options.coldRecoveryEnabled) await this.refill(delivery.scope, true, "ordinary", delivery.replyId);
      return false;
    }
    this.options.deliveryTrace?.mark({
      stage: "ring_granted",
      correlation: { replyId: delivery.replyId, attemptId: claim.attemptId }
    });
    let advance = false;
    let refillEmptyScope = false;
    let renewalLost = false;
    let renewalHandle: unknown | null = null;
    const renewClaim = () => {
      renewalHandle = null;
      if (renewalLost) return;
      const renewedAt = this.now();
      try {
        if (!this.options.store.renewPreparedDeliveryClaim({
          claim,
          at: new Date(renewedAt).toISOString(),
          expiresAt: new Date(renewedAt + claimTtlMs).toISOString()
        })) {
          renewalLost = true;
          return;
        }
      } catch {
        renewalLost = true;
        return;
      }
      renewalHandle = this.scheduleWake(renewClaim, Math.max(1, Math.floor(claimTtlMs / 2)));
    };
    renewalHandle = this.scheduleWake(renewClaim, Math.max(1, Math.floor(claimTtlMs / 2)));
    try {
      const receipt = await this.options.gateway.execute(delivery.preparedPlan as Parameters<GatewayDeliveryPort["execute"]>[0], {
        attemptId: claim.attemptId, leaseFencingToken: claim.fencingToken, idempotencyKey: delivery.idempotencyKey,
        priorCheckpoints: delivery.priorCheckpoints,
        checkpoint: async (checkpoint) => {
          const persisted = conversationPage
            ? this.options.store.checkpointConversationPageDelivery(claim, checkpoint)
            : this.options.store.checkpointPreparedDelivery(claim, checkpoint);
          if (!persisted) throw new RingCheckpointError("ring_checkpoint_uncertain");
        }
      });
      if (renewalLost) throw new RingCheckpointError("ring_claim_renewal_uncertain");
      const ack = acknowledgement(delivery, receipt);
      if (ack) this.options.deliveryTrace?.mark({
        stage: "gateway_acknowledged",
        correlation: { replyId: delivery.replyId, attemptId: claim.attemptId, receiptId: ack.surfaceId ?? ack.messageId }
      });
      const acknowledged = ack && (conversationPage
        ? this.options.store.acknowledgeConversationPageDelivery(claim, ack)
        : this.options.store.acknowledgePreparedDelivery(claim, ack));
      if (!acknowledged) throw new RingCheckpointError("ring_settlement_uncertain");
      this.options.onAcknowledged?.(delivery, ack);
      this.lastDeliveryAt = new Date(this.now()).toISOString();
      advance = true;
    } catch (error) {
      const failure = classify(error);
      const persistedFailure = { error: failure.safeMessage, metadata: failure.metadata, retryAt: retryAt(this.now(), failure.retryAfterMs) };
      const outcome = conversationPage
        ? this.options.store.failConversationPageDelivery(claim, persistedFailure)
        : this.options.store.failPreparedDelivery(claim, persistedFailure);
      if (outcome === "stale") this.options.deliveryTrace?.diagnose("stale_attempt", { replyId: delivery.replyId, attemptId: claim.attemptId });
      else this.options.deliveryTrace?.mark({
        stage: "settled",
        outcome: outcome === "dead_letter" ? "failed" : outcome,
        correlation: { replyId: delivery.replyId, attemptId: claim.attemptId }
      });
      this.options.onFailed?.(delivery, outcome);
      this.lastFailureAt = new Date(this.now()).toISOString();
    } finally {
      if (renewalHandle !== null) this.cancelWake(renewalHandle);
      if (ring) this.discard(ring); else this.oversized.delete(deliveryScopeKey(delivery.scope));
      refillEmptyScope = this.options.coldRecoveryEnabled === true && (ring === null || ring.isEmpty);
    }
    if (!advance && this.options.coldRecoveryEnabled) return delivery.scope;
    if (refillEmptyScope) return delivery.scope;
    return advance;
  }

  private prepareForExecution(work: DeliveryRingWork): PreparedDelivery | null {
    if (!("input" in work)) return work;
    try {
      if (!this.options.prepareSemanticDelivery) throw new GatewayPreparationError("semantic_delivery_preparer_unavailable");
      const preparedPlan = this.options.prepareSemanticDelivery(work, this.options.gateway);
      const frozen = this.options.store.freezeSemanticDelivery({ work, preparedPlan });
      if (frozen.outcome === "prepared") return frozen.delivery;
      const current = this.options.store.hydrateDeliveryInput(work.replyId);
      return current.status === "semantic-snapshot" && current.preparationState === "prepared"
        ? current.preparedDelivery
        : null;
    } catch (error) {
      if (!(error instanceof GatewayPreparationError)) throw error;
      const message = error.message;
      this.options.store.failSemanticDeliveryPreparation({ work, error: message });
      this.lastFailureAt = new Date(this.now()).toISOString();
      return null;
    }
  }

  private discard(ring: PreparedDeliveryRing<DeliveryRingWork>): void {
    const removed = ring.removeHead(this.now());
    if (removed) this.cachedBytes -= removed.estimatedBytes;
    ring.finishGrant(this.now());
  }

  private discardAll(ring: PreparedDeliveryRing<DeliveryRingWork>): void {
    const now = this.now();
    const { releasedBytes } = ring.removeAll(now);
    this.cachedBytes -= releasedBytes;
    ring.finishGrant(now);
  }

  private refill(scope: PreparedDelivery["scope"] | null, force = false, cause: RefillCause = "ordinary", excludedReplyId?: string): Promise<RefillOutcome> {
    if (this.state === "stopping" || this.state === "stopped") return Promise.resolve("complete");
    if (!this.options.refill || (!force && !this.options.coldRecoveryEnabled)) return Promise.resolve("complete");
    const key = `${scope ? deliveryScopeKey(scope) : "*"}:${excludedReplyId ?? ""}`;
    const existing = this.pendingRefills.get(key);
    if (existing) return existing;
    let resolvePending!: (outcome: RefillOutcome) => void;
    let rejectPending!: (error: unknown) => void;
    const pending = new Promise<RefillOutcome>((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
    void pending.catch(() => undefined);
    this.pendingRefills.set(key, pending);
    const task = this.performRefill(scope, cause, excludedReplyId)
      .finally(() => { this.pendingRefills.delete(key); this.activeRefills.delete(task); });
    void task.then(resolvePending, rejectPending);
    this.pendingRefills.set(key, task);
    this.activeRefills.add(task);
    return task;
  }

  private async performRefill(scope: PreparedDelivery["scope"] | null, cause: RefillCause, excludedReplyId?: string): Promise<RefillOutcome> {
    let pageToken: string | null | undefined = null;
    let discoveries = 0;
    const interactiveWorkRevision = this.interactiveWorkRevision;
    const recoveryWasReady = this.recoveryReady;
    try {
      if (scope === null) {
        const maintenanceLimit = this.options.refillLimit ?? DEFAULT_REFILL_MAINTENANCE_LIMIT;
        const retired = this.options.store.retireReconstructibleInvalidOwnerHeads?.({
          at: new Date(this.now()).toISOString(), limit: maintenanceLimit
        });
        if (retired) {
          if (retired.projectionRecoveryHints.length > 0) await this.options.onProjectionRecoveryHints?.(retired.projectionRecoveryHints);
          for (const scopeKey of retired.transitionedScopeKeys) {
            const transitionedScope = parseDeliveryScopeKey(scopeKey);
            if (transitionedScope) await this.refill(transitionedScope, true);
          }
          if (this.interactiveWorkRevision !== interactiveWorkRevision) return this.recordMaintenanceYield();
          if (retired.transitionedScopeKeys.length > 0) await this.yieldRefillPage();
        }
        const orphanedPending = this.options.store.retireOrphanedPrimaryMainPendingDeliveries?.({
          at: new Date(this.now()).toISOString(), limit: maintenanceLimit
        });
        if (orphanedPending) {
          for (const scopeKey of orphanedPending.transitionedScopeKeys) {
            const transitionedScope = parseDeliveryScopeKey(scopeKey);
            if (transitionedScope) await this.refill(transitionedScope, true);
          }
          if (this.interactiveWorkRevision !== interactiveWorkRevision) return this.recordMaintenanceYield();
          if (orphanedPending.transitionedScopeKeys.length > 0) await this.yieldRefillPage();
        }
        const hasBoundedMaintenance = this.options.store.dismissRejectedQuarantineReviewBatch !== undefined
          && this.options.store.coalesceHistoricalPrimaryMainSnapshots !== undefined;
        if (hasBoundedMaintenance) {
          const expiredClaims = this.options.store.recoverExpiredRingClaims(new Date(this.now()).toISOString(), maintenanceLimit);
          if (this.interactiveWorkRevision !== interactiveWorkRevision) return this.recordMaintenanceYield();
          if (expiredClaims.length > 0) await this.yieldRefillPage();
          const rejectedReviews = this.options.store.dismissRejectedQuarantineReviewBatch!({ at: new Date(this.now()).toISOString(), limit: maintenanceLimit });
          if (this.interactiveWorkRevision !== interactiveWorkRevision) return this.recordMaintenanceYield();
          if (rejectedReviews.length > 0) await this.yieldRefillPage();
          this.options.store.coalesceHistoricalPrimaryMainSnapshots!({ at: new Date(this.now()).toISOString(), limit: maintenanceLimit });
          if (this.interactiveWorkRevision !== interactiveWorkRevision) return this.recordMaintenanceYield();
        } else if (this.options.store.runGlobalRingMaintenance) {
          const maintenance = this.options.store.runGlobalRingMaintenance({
            at: new Date(this.now()).toISOString(),
            limit: maintenanceLimit
          });
          for (const scopeKey of maintenance?.affectedScopeKeys ?? []) {
            const transitionedScope = parseDeliveryScopeKey(scopeKey);
            if (transitionedScope) await this.refill(transitionedScope, true);
          }
          if (this.interactiveWorkRevision !== interactiveWorkRevision) return this.recordMaintenanceYield();
          if ((maintenance?.affectedScopeKeys.length ?? 0) > 0) await this.yieldRefillPage();
        } else {
          let recoveredCount: number;
          do {
            recoveredCount = this.options.store.recoverExpiredRingClaims(new Date(this.now()).toISOString(), maintenanceLimit).length;
            if (this.interactiveWorkRevision !== interactiveWorkRevision) return this.recordMaintenanceYield();
            if (recoveredCount >= maintenanceLimit && this.state !== "stopping" && this.state !== "stopped") await this.yieldRefillPage();
          } while (recoveredCount >= maintenanceLimit && this.state !== "stopping" && this.state !== "stopped");
        }
        let scopeCursor: string | null = null;
        do {
          const recovered = this.options.store.recoverQuarantinedRingHeads({
            afterScopeKey: scopeCursor,
            limit: this.options.refillLimit ?? DEFAULT_QUARANTINE_SCOPE_LIMIT,
            at: new Date(this.now()).toISOString(),
            skipGlobalMaintenance: hasBoundedMaintenance || this.options.store.runGlobalRingMaintenance !== undefined
          });
          scopeCursor = recovered.nextCursor;
          if (this.interactiveWorkRevision !== interactiveWorkRevision) return this.recordMaintenanceYield();
          if (scopeCursor !== null && this.state !== "stopping" && this.state !== "stopped") await this.yieldRefillPage();
        } while (scopeCursor !== null && this.state !== "stopping" && this.state !== "stopped");
      }
      do {
        const result = await this.options.refill!.load({ scope, limit: this.options.refillLimit ?? DEFAULT_REFILL_SCOPE_LIMIT, now: new Date(this.now()).toISOString(), pageToken });
        if (result.recoveryBlocked) throw new Error("ring_delivery_recovery_blocked");
        this.lastRefillAt = new Date(this.now()).toISOString();
        this.armRetry(result.nextRetryAt);
        for (const delivery of result.deliveries) {
          if (delivery.replyId === excludedReplyId) continue;
          if (this.offer(delivery, "cold")) discoveries += 1;
        }
        pageToken = scope === null ? result.nextPageToken ?? null : null;
        if (pageToken !== null && this.interactiveWorkRevision !== interactiveWorkRevision) {
          if (cause === "safety") this.pendingSafetyScanDiscoveries += discoveries;
          return this.recordMaintenanceYield();
        }
        if (pageToken !== null && this.state !== "stopping" && this.state !== "stopped") await this.yieldRefillPage();
      } while (pageToken !== null && this.state !== "stopping" && this.state !== "stopped");
      if (cause === "safety") {
        const completedAt = new Date(this.now()).toISOString();
        const recordedDiscoveries = this.pendingSafetyScanDiscoveries + discoveries;
        this.safetyScanRuns += 1;
        this.lastSafetyScanAt = completedAt;
        if (recordedDiscoveries > 0) {
          this.safetyScanDiscoveries += recordedDiscoveries;
          this.lastSafetyScanDiscoveryAt = completedAt;
        }
        this.pendingSafetyScanDiscoveries = 0;
      }
      if (this.state === "degraded") this.state = "running";
      return "complete";
    } catch (error) {
      if (cause === "safety") this.pendingSafetyScanDiscoveries += discoveries;
      if (this.state !== "stopping" && this.state !== "stopped") this.state = "degraded";
      this.recoveryReady = recoveryWasReady;
      this.lastFailureAt = new Date(this.now()).toISOString();
      throw error;
    }
  }

  private async recoverStartup(): Promise<void> {
    try {
      if (this.options.store.backfillLegacyConflictKeys) for (;;) {
        if (this.isStoppingOrStopped()) return;
        const page = this.options.store.backfillLegacyConflictKeys(this.options.refillLimit ?? DEFAULT_REFILL_MAINTENANCE_LIMIT);
        if (!page.hasMore) break;
        await this.yieldRefillPage();
      }
      if (this.isStoppingOrStopped()) return;
      await this.runRefillToCompletion(null, "ordinary");
      if (this.isStoppingOrStopped()) return;
      if (this.state === "starting") this.state = "running";
      this.recoveryReady = true;
      for (const ring of this.rings.values()) this.makeReady(ring, this.now());
      this.queueDrain();
      this.armMaintenance();
    } catch {
      if (!this.isStoppingOrStopped()) this.state = "degraded";
      this.recoveryReady = false;
      throw new Error("ring_delivery_recovery_not_ready");
    }
  }

  private isStoppingOrStopped(): boolean {
    return this.state === "stopping" || this.state === "stopped";
  }

  private yieldRefillPage(): Promise<void> {
    return (this.options.yieldRefillPage ?? yieldEventLoop)();
  }

  private runRefillToCompletion(scope: PreparedDelivery["scope"] | null, cause: RefillCause): Promise<void> {
    if (scope !== null) return this.performRefillToCompletion(scope, cause);
    this.globalRefillRequestRevision += 1;
    this.pendingGlobalRefillCause = mergeRefillCause(this.pendingGlobalRefillCause, cause);
    if (this.globalRefillLoop) return this.globalRefillLoop;
    let resolvePending!: () => void;
    let rejectPending!: (error: unknown) => void;
    const pending = new Promise<void>((resolve, reject) => { resolvePending = resolve; rejectPending = reject; });
    void pending.catch(() => undefined);
    this.globalRefillLoop = pending;
    const task = this.performGlobalRefills(pending);
    void task.then(resolvePending, rejectPending);
    return pending;
  }

  private async performGlobalRefills(owner: Promise<void>): Promise<void> {
    let cause = this.takePendingGlobalRefillCause() ?? "ordinary";
    try {
      while (this.state !== "stopping" && this.state !== "stopped") {
        const requestRevision = this.globalRefillRequestRevision;
        const outcome = await this.refill(null, true, cause);
        if (outcome === "yielded") {
          await this.waitForInteractiveBackoff();
          cause = mergeRefillCause(cause, this.takePendingGlobalRefillCause() ?? "ordinary");
          continue;
        }
        if (requestRevision === this.globalRefillRequestRevision && this.pendingGlobalRefillCause === null) return;
        cause = this.takePendingGlobalRefillCause() ?? "ordinary";
      }
    } catch (error) {
      this.pendingGlobalRefillCause = null;
      throw error;
    } finally {
      if (this.globalRefillLoop === owner) this.globalRefillLoop = null;
    }
  }

  private takePendingGlobalRefillCause(): RefillCause | null {
    const cause = this.pendingGlobalRefillCause;
    this.pendingGlobalRefillCause = null;
    return cause;
  }

  private async performRefillToCompletion(scope: PreparedDelivery["scope"] | null, cause: RefillCause): Promise<void> {
    while (this.state !== "stopping" && this.state !== "stopped") {
      const outcome = await this.refill(scope, true, cause);
      if (outcome === "complete") return;
      await this.waitForInteractiveBackoff();
    }
  }

  private recordMaintenanceYield(): "yielded" {
    this.options.deliveryTrace?.diagnose("maintenance_yield");
    return "yielded";
  }

  private async waitForInteractiveBackoff(): Promise<void> {
    const configured = this.options.interactiveBackoffMs ?? DEFAULT_INTERACTIVE_BACKOFF_MS;
    const delayMs = Number.isFinite(configured)
      ? Math.max(1, Math.min(MAX_INTERACTIVE_BACKOFF_MS, configured))
      : DEFAULT_INTERACTIVE_BACKOFF_MS;
    while (this.state !== "stopping" && this.state !== "stopped") {
      const quietRevision = this.interactiveWorkRevision;
      let stopWaiting!: () => void;
      const stopped = new Promise<void>((resolve) => {
        stopWaiting = resolve;
        this.backoffStopWaiters.add(resolve);
      });
      try {
        await Promise.race([(this.options.waitForInteractiveBackoff ?? waitForDelay)(delayMs), stopped]);
      } finally {
        this.backoffStopWaiters.delete(stopWaiting);
      }
      if (this.interactiveWorkRevision === quietRevision) return;
    }
  }

  private armRetry(nextRetryAt: string | null): void {
    if (!nextRetryAt || this.state === "stopping" || this.state === "stopped") return;
    if (this.nextRetryAt && Date.parse(this.nextRetryAt) <= Date.parse(nextRetryAt)) return;
    if (this.retryHandle !== null) this.cancelWake(this.retryHandle);
    this.nextRetryAt = nextRetryAt;
    this.retryHandle = this.scheduleWake(() => {
      this.retryHandle = null;
      this.nextRetryAt = null;
      if (this.state === "running" || this.state === "degraded") {
        void this.runRefillToCompletion(null, "ordinary").then(() => this.wakeRunnableRings()).catch(() => undefined);
      }
    }, Math.max(0, Date.parse(nextRetryAt) - this.now()));
  }

  private armMaintenance(): void {
    if (this.state !== "running" && this.state !== "degraded") return;
    this.maintenanceHandle = this.scheduleMaintenance(() => {
      this.maintenanceHandle = null;
      if (this.state !== "running" && this.state !== "degraded") return;
      void this.runRefillToCompletion(null, "safety").then(() => this.wakeRunnableRings()).catch(() => undefined).finally(() => this.armMaintenance());
    }, this.options.safetyScanIntervalMs ?? 30_000);
  }

  private wakeRunnableRings(): void {
    const at = this.now();
    for (const ring of this.rings.values()) this.makeReady(ring, at);
  }

  private scheduleWake(callback: () => void, delayMs: number): unknown {
    if (this.options.scheduleWake) return this.options.scheduleWake(callback, delayMs);
    const timer = setTimeout(callback, delayMs); timer.unref?.(); return timer;
  }
  private cancelWake(handle: unknown): void { if (this.options.cancelWake) this.options.cancelWake(handle); else clearTimeout(handle as ReturnType<typeof setTimeout>); }
  private scheduleMaintenance(callback: () => void, delayMs: number): unknown {
    if (this.options.scheduleMaintenance) return this.options.scheduleMaintenance(callback, delayMs);
    const timer = setTimeout(callback, delayMs); timer.unref?.(); return timer;
  }
  private cancelTimers(): void {
    if (this.retryHandle !== null) this.cancelWake(this.retryHandle);
    if (this.maintenanceHandle !== null) {
      if (this.options.cancelMaintenance) this.options.cancelMaintenance(this.maintenanceHandle);
      else clearTimeout(this.maintenanceHandle as ReturnType<typeof setTimeout>);
    }
    this.retryHandle = null;
    this.maintenanceHandle = null;
  }
}

function parseDeliveryScopeKey(scopeKey: string): DeliveryScope | null {
  try {
    const value = JSON.parse(scopeKey) as unknown;
    if (!Array.isArray(value)) return null;
    if (value.length === 1 && value[0] === "global") return { kind: "global" };
    if (value.length === 3 && value[0] === "pane" && typeof value[1] === "string" && typeof value[2] === "string") {
      return { kind: "pane", workspaceId: value[1], paneId: value[2] };
    }
    return null;
  } catch { return null; }
}

function mergeRefillCause(current: RefillCause | null, requested: RefillCause): RefillCause {
  return current === "safety" || requested === "safety" ? "safety" : "ordinary";
}

function acknowledgement(delivery: PreparedDelivery, receipt: GatewayDeliveryReceipt): PreparedDeliveryAck | null {
  const ref = (kind: "message" | "surface" | "thread") => receipt.refs.find((candidate) => candidate.kind === kind)?.opaqueId ?? null;
  const intent = delivery.preparedPlan.intent as Record<string, unknown>;
  const messageId = ref("message")
    ?? (typeof intent.messageId === "string" ? intent.messageId : null)
    ?? (typeof intent.surfaceId === "string" ? intent.surfaceId : null);
  if (!messageId) return null;
  return { messageId, surfaceId: ref("surface"), threadId: ref("thread"), ...(receipt.messageDeleteOutcome ? { messageDeleteOutcome: receipt.messageDeleteOutcome } : {}) };
}

function classify(error: unknown): { safeMessage: string; metadata: DeliveryFailureMetadata; retryAfterMs?: number } {
  if (error instanceof GatewayDeliveryError) return {
    safeMessage: error.failure.safeMessage,
    metadata: {
      failureClass: error.failure.failureClass,
      effectCertainty: error.failure.effectCertainty,
      httpStatus: error.failure.httpStatus,
      larkErrorCode: error.failure.providerCode,
      ...(error.failure.recoveryKind ? { recoveryKind: error.failure.recoveryKind } : {}),
      ...(error.failure.providerOperation ? { providerOperation: error.failure.providerOperation } : {})
    },
    ...(error.failure.retryAfterMs === undefined ? {} : { retryAfterMs: error.failure.retryAfterMs })
  };
  return { safeMessage: error instanceof RingCheckpointError ? error.message : "Gateway delivery outcome is uncertain", metadata: { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null } };
}

function retryAt(now: number, explicit?: number): string {
  return new Date(now + Math.max(1_000, Math.min(explicit ?? 1_000, 3_600_000))).toISOString();
}
