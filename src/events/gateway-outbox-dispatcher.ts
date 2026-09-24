import type { Logger } from "pino";
import type { GatewayDeliveryPort } from "../gateways/contract/plugin.js";
import type { OutboundCheckpointSubscriber, OutboxDispatcherControl, OutboundDeliveryStore, OutboundScanStore } from "../domain/ports/outbox.js";
import type { OutboxDispatcherDiagnostics } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ActiveWorkTracker } from "../runtime/active-work-tracker.js";
import type { PromptWorkScheduler } from "./prompt-work-scheduler.js";
import type { OutboundWorkNotifier } from "./outbound-work-notifier.js";
import { OutboundDeliveryExecutor } from "./outbound-delivery-executor.js";
import { OutboundLaneDrain } from "./outbound-lane-drain.js";

/** Delivers user-visible lifecycle updates through a durable SQLite outbox. */
export class GatewayOutboxDispatcher implements OutboxDispatcherControl, OutboundCheckpointSubscriber {
  private static readonly SCAN_RETRY_BASE_MS = 250;
  private static readonly SCAN_RETRY_MAX_MS = 30_000;
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
  private readonly laneDrain: OutboundLaneDrain;
  private lastScanAt: string | null = null;
  private lastScanOutcome: OutboxDispatcherDiagnostics["lastScanOutcome"] = null;
  private lastSuccessfulScanAt: string | null = null;
  private lastScanFailureAt: string | null = null;
  private consecutiveScanFailures = 0;
  private lastDeliveryAt: string | null = null;
  private lastDeliveryFailureAt: string | null = null;

  constructor(
    private readonly store: OutboundScanStore & OutboundDeliveryStore,
    gateway: GatewayDeliveryPort,
    private readonly logger: Logger,
    private readonly work: OutboundWorkNotifier,
    private readonly safetyScanIntervalMs = 30_000
  ) {
    this.delivery = new OutboundDeliveryExecutor(store, gateway, logger);
    this.laneDrain = new OutboundLaneDrain({ store, delivery: this.delivery, logger });
  }

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
    this.laneDrain.notifyRequest();
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
        const result = await this.laneDrain.drain(force, {
          isStopping: () => this.stopping,
          track: (delivery) => this.trackHandler(delivery)
        });
        this.lastScanOutcome = result.outcome;
        if (result.lastDeliveryAt) this.lastDeliveryAt = result.lastDeliveryAt;
        if (result.lastDeliveryFailureAt) this.lastDeliveryFailureAt = result.lastDeliveryFailureAt;
        if (result.attempted >= 100) this.scanRequested = true;
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
      this.logger.warn({ event: "gateway-outbox-scan-failed", err: safeLogError(error), consecutiveFailures: this.consecutiveScanFailures, outcome: "retry" }, "Gateway outbox scan failed; retry scheduled");
    });
  }

  private recoverTransientDeadLetters(): void {
    const cutoff = new Date(Date.now() - 300_000).toISOString();
    for (const reply of this.store.recoverEligibleDeadLetters(cutoff, 100)) {
      this.logger.info({ event: "gateway-outbox-auto-recovered", replyId: reply.id, replyKind: reply.kind, laneKey: reply.laneKey, failureClass: reply.failureClass, autoRecoveryCount: reply.autoRecoveryCount, deadLetteredAt: reply.deadLetteredAt, outcome: "pending" }, "transient Gateway outbox dead letter reopened for one recovery round");
    }
  }

  private trackHandler<T>(work: Promise<T>): Promise<T> {
    return this.activeHandlers.track(work);
  }

  private async waitForActiveWork(): Promise<void> {
    await this.activeHandlers.settle();
    if (this.draining) await this.draining;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.stopping) return;
    if (this.consecutiveScanFailures > 0) {
      const delayMs = Math.min(
        GatewayOutboxDispatcher.SCAN_RETRY_BASE_MS * (2 ** (this.consecutiveScanFailures - 1)),
        GatewayOutboxDispatcher.SCAN_RETRY_MAX_MS
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
    const cooldown = this.store.getLarkDeliveryCooldown();
    const cooldownJitterMs = cooldown.active && cooldown.blockedUntil === nextAttemptAt ? Math.floor(Math.random() * 251) : 0;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.launchScan();
    }, Math.max(GatewayOutboxDispatcher.SCAN_RETRY_BASE_MS, dueAt - Date.now() + cooldownJitterMs));
    this.retryTimer.unref?.();
  }

}
