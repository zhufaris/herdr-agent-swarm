import type { Logger } from "pino";
import type { LarkPort } from "../domain/ports/external.js";
import type { OutboundCheckpointSubscriber, OutboxDispatcherControl, OutboxStore } from "../domain/ports/outbox.js";
import type { OutboxDispatcherDiagnostics } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ActiveWorkTracker } from "../runtime/active-work-tracker.js";
import type { PromptWorkScheduler } from "./prompt-work-scheduler.js";
import type { OutboundWorkNotifier } from "./outbound-work-notifier.js";
import { OutboundDeliveryExecutor } from "./outbound-delivery-executor.js";

/** Delivers user-visible lifecycle updates through a durable SQLite outbox. */
export class LarkOutboxDispatcher implements OutboxDispatcherControl, OutboundCheckpointSubscriber {
  private static readonly MAX_CONCURRENT_DELIVERIES = 4;
  private static readonly SCAN_RETRY_BASE_MS = 250;
  private static readonly SCAN_RETRY_MAX_MS = 30_000;
  private static readonly MAX_DELIVERIES_PER_SCAN = 100;
  private draining: Promise<void> | null = null;
  private readonly activeHandlers = new ActiveWorkTracker();
  private unsubscribe: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private safetyTimer: ReturnType<typeof setInterval> | null = null;
  private scanRequested = false;
  private forceRequested = false;
  private readonly delivery: OutboundDeliveryExecutor;
  private lastScanAt: string | null = null;
  private lastScanOutcome: OutboxDispatcherDiagnostics["lastScanOutcome"] = null;
  private lastSuccessfulScanAt: string | null = null;
  private lastScanFailureAt: string | null = null;
  private consecutiveScanFailures = 0;
  private lastDeliveryAt: string | null = null;
  private lastDeliveryFailureAt: string | null = null;

  constructor(
    private readonly store: OutboxStore,
    lark: LarkPort,
    private readonly logger: Logger,
    private readonly work: OutboundWorkNotifier,
    private readonly safetyScanIntervalMs = 30_000
  ) { this.delivery = new OutboundDeliveryExecutor(store, lark, logger); }

  start(): () => void {
    if (this.unsubscribe) return this.unsubscribe;
    this.stopping = false;
    const unsubscribeWork = this.work.subscribe(() => this.launchScan());
    this.unsubscribe = () => { unsubscribeWork(); this.unsubscribe = null; };
    this.safetyTimer = setInterval(() => this.launchScan(), this.safetyScanIntervalMs);
    this.safetyTimer.unref?.();
    this.launchScan();
    return this.unsubscribe;
  }

  onAnswerCheckpoint(listener: (promptId: string, viewVersion: number) => void): () => void {
    return this.delivery.onAnswerCheckpoint(listener);
  }

  onWorkerTurnCheckpoint(listener: (turnId: string, viewVersion: number) => void): () => void {
    return this.delivery.onWorkerTurnCheckpoint(listener);
  }

  onWorkerMainCheckpoint(listener: (workerId: string, workerSessionGeneration: number, viewVersion: number) => void): () => void {
    return this.delivery.onWorkerMainCheckpoint(listener);
  }

  onMainCardCheckpoint(listener: (bindingId: string, viewVersion: number) => void): () => void {
    return this.delivery.onMainCardCheckpoint(listener);
  }

  connectPromptScheduler(scheduler: PromptWorkScheduler): void { this.delivery.connectPromptScheduler(scheduler); }

  snapshot(): OutboxDispatcherDiagnostics {
    return {
      state: this.stopping ? "stopping" : this.draining ? "running" : "idle",
      activeDeliveries: this.activeHandlers.size, scanPending: this.scanRequested,
      lastScanAt: this.lastScanAt, lastScanOutcome: this.lastScanOutcome,
      lastSuccessfulScanAt: this.lastSuccessfulScanAt, lastScanFailureAt: this.lastScanFailureAt,
      consecutiveScanFailures: this.consecutiveScanFailures,
      lastDeliveryAt: this.lastDeliveryAt, lastDeliveryFailureAt: this.lastDeliveryFailureAt
    };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    this.safetyTimer = null;
    this.stopPromise = this.waitForActiveWork();
    return this.stopPromise;
  }

  /** Explicit control for tests and recovery tooling; workflows publish notifier hints instead. */
  async requestScan(force = false): Promise<void> {
    if (this.stopping) return;
    this.scanRequested = true;
    this.forceRequested ||= force;
    if (this.draining) return this.draining;
    this.draining = this.runRequestedScans().finally(() => {
      this.draining = null;
      this.scheduleRetry();
      if (this.scanRequested && !this.stopping) this.launchScan();
    });
    return this.draining;
  }

  private async runRequestedScans(): Promise<void> {
    while (this.scanRequested && !this.stopping) {
      const force = this.forceRequested;
      this.scanRequested = false;
      this.forceRequested = false;
      try {
        this.recoverTransientDeadLetters();
        this.lastScanOutcome = await this.drainPending(force);
        this.consecutiveScanFailures = 0;
        this.lastSuccessfulScanAt = new Date().toISOString();
      } catch (error) {
        this.lastScanOutcome = "failed";
        this.consecutiveScanFailures += 1;
        this.lastScanFailureAt = new Date().toISOString();
        throw error;
      } finally {
        this.lastScanAt = new Date().toISOString();
      }
    }
  }

  private launchScan(force = false): void {
    void this.requestScan(force).catch((error) => {
      this.logger.warn({ event: "lark-outbox-scan-failed", err: safeLogError(error), consecutiveFailures: this.consecutiveScanFailures, outcome: "retry" }, "Lark outbox scan failed; retry scheduled");
    });
  }

  private recoverTransientDeadLetters(): void {
    const cutoff = new Date(Date.now() - 300_000).toISOString();
    for (const reply of this.store.recoverEligibleDeadLetters(cutoff, 100)) {
      this.logger.info({ event: "lark-outbox-auto-recovered", replyId: reply.id, replyKind: reply.kind, laneKey: reply.laneKey, failureClass: reply.failureClass, autoRecoveryCount: reply.autoRecoveryCount, deadLetteredAt: reply.deadLetteredAt, outcome: "pending" }, "transient Lark outbox dead letter reopened for one recovery round");
    }
  }

  private trackHandler<T>(work: Promise<T>): Promise<T> {
    return this.activeHandlers.track(work);
  }

  private async waitForActiveWork(): Promise<void> {
    await this.activeHandlers.settle();
    if (this.draining) await this.draining;
  }

  private async drainPending(force: boolean): Promise<"idle" | "delivered" | "failed"> {
    const blockedTargets = new Set<string>();
    const attemptedReplyIds = new Set<string>();
    let deliveryCount = 0;
    let outcome: "idle" | "delivered" | "failed" = "idle";
    while (true) {
      if (this.stopping) return outcome;
      const batch = this.store.listOutboundLaneHeads(
        Math.min(LarkOutboxDispatcher.MAX_CONCURRENT_DELIVERIES, LarkOutboxDispatcher.MAX_DELIVERIES_PER_SCAN - deliveryCount),
        force ? null : new Date().toISOString(),
        [...blockedTargets]
      );
      if (batch.length === 0) return outcome;
      const repeated = batch.filter((reply) => attemptedReplyIds.has(reply.id));
      for (const reply of repeated) blockedTargets.add(reply.laneKey);
      const deliverable = batch.filter((reply) => !attemptedReplyIds.has(reply.id));
      if (deliverable.length === 0) continue;
      for (const reply of deliverable) attemptedReplyIds.add(reply.id);
      const results = await Promise.all(deliverable.map((reply) => this.trackHandler(this.delivery.deliver(reply))));
      const completedAt = new Date().toISOString();
      deliverable.forEach((reply, index) => {
        if (results[index] === "failed") { blockedTargets.add(reply.laneKey); this.lastDeliveryFailureAt = completedAt; }
        else this.lastDeliveryAt = completedAt;
      });
      deliveryCount += deliverable.length;
      if (results.includes("failed")) outcome = "failed";
      else if (outcome === "idle" && results.includes("delivered")) outcome = "delivered";
      if (deliveryCount >= LarkOutboxDispatcher.MAX_DELIVERIES_PER_SCAN) {
        this.scanRequested = true;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return outcome;
      }
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.stopping) return;
    if (this.consecutiveScanFailures > 0) {
      const delayMs = Math.min(
        LarkOutboxDispatcher.SCAN_RETRY_BASE_MS * (2 ** (this.consecutiveScanFailures - 1)),
        LarkOutboxDispatcher.SCAN_RETRY_MAX_MS
      );
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.launchScan();
      }, delayMs);
      this.retryTimer.unref?.();
      return;
    }
    const nextAttemptAt = this.store.getNextOutboundLaneHeadAttemptAt();
    if (!nextAttemptAt) return;
    const dueAt = Date.parse(nextAttemptAt);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.launchScan();
    }, Math.max(LarkOutboxDispatcher.SCAN_RETRY_BASE_MS, dueAt - Date.now()));
    this.retryTimer.unref?.();
  }

}
