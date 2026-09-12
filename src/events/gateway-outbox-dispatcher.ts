import type { Logger } from "pino";
import type { GatewayDeliveryPort } from "../gateways/contract/plugin.js";
import type { OutboundCheckpointSubscriber, OutboxDispatcherControl, OutboxStore } from "../domain/ports/outbox.js";
import type { OutboundReply, OutboxDispatcherDiagnostics } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ActiveWorkTracker } from "../runtime/active-work-tracker.js";
import type { PromptWorkScheduler } from "./prompt-work-scheduler.js";
import type { OutboundWorkNotifier } from "./outbound-work-notifier.js";
import { OutboundDeliveryExecutor, type OutboundDeliveryOutcome } from "./outbound-delivery-executor.js";

type ActiveDeliveryCompletion =
  | { reply: OutboundReply; result: OutboundDeliveryOutcome; error?: never }
  | { reply: OutboundReply; result?: never; error: unknown };

/** Delivers user-visible lifecycle updates through a durable SQLite outbox. */
export class GatewayOutboxDispatcher implements OutboxDispatcherControl, OutboundCheckpointSubscriber {
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
  private scanRequestRevision = 0;
  private scanWake: (() => void) | null = null;
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
    gateway: GatewayDeliveryPort,
    private readonly logger: Logger,
    private readonly work: OutboundWorkNotifier,
    private readonly safetyScanIntervalMs = 30_000
  ) { this.delivery = new OutboundDeliveryExecutor(store, gateway, logger); }

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
    this.scanRequestRevision += 1;
    this.scanWake?.();
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
    const active = new Map<string, Promise<ActiveDeliveryCompletion>>();
    let deliveryCount = 0;
    let dispatchOrdinal = 0;
    let outcome: "idle" | "delivered" | "failed" = "idle";
    let observedScanRevision = this.scanRequestRevision;
    let fatalError: unknown;
    let fatal = false;
    while (true) {
      if (this.stopping && active.size === 0) { if (fatal) throw fatalError; return outcome; }
      const available = Math.min(
        fatal || this.stopping ? 0 : GatewayOutboxDispatcher.MAX_CONCURRENT_DELIVERIES - active.size,
        GatewayOutboxDispatcher.MAX_DELIVERIES_PER_SCAN - deliveryCount
      );
      if (available > 0) {
        const dueAt = force ? null : new Date().toISOString();
        const selected: OutboundReply[] = [];
        for (let slot = 0; slot < available; slot += 1) {
          const excluded = [...blockedTargets, ...active.keys(), ...selected.map((reply) => reply.laneKey)];
          const preferred = dispatchOrdinal % 4 === 3 ? "history" : "live";
          const reply = this.store.listOutboundLaneHeads(1, dueAt, excluded, preferred)[0]
            ?? this.store.listOutboundLaneHeads(1, dueAt, excluded, preferred === "live" ? "history" : "live")[0];
          if (!reply) break;
          selected.push(reply);
          dispatchOrdinal += 1;
        }
        for (const reply of selected) {
          if (attemptedReplyIds.has(reply.id)) { blockedTargets.add(reply.laneKey); continue; }
          attemptedReplyIds.add(reply.id);
          deliveryCount += 1;
          active.set(reply.laneKey, this.trackHandler(this.delivery.deliver(reply, dueAt)).then(
            (result): ActiveDeliveryCompletion => ({ reply, result }),
            (error): ActiveDeliveryCompletion => ({ reply, error })
          ));
        }
        if (selected.length > 0) continue;
      }
      if (active.size === 0) {
        if (fatal) throw fatalError;
        if (deliveryCount < GatewayOutboxDispatcher.MAX_DELIVERIES_PER_SCAN) return outcome;
        this.scanRequested = true;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return outcome;
      }
      if (this.scanRequestRevision !== observedScanRevision) {
        observedScanRevision = this.scanRequestRevision;
        continue;
      }
      let wake!: () => void;
      const wakeSignal = new Promise<null>((resolve) => { wake = () => resolve(null); });
      this.scanWake = wake;
      if (this.scanRequestRevision !== observedScanRevision) wake();
      let completed: ActiveDeliveryCompletion | null;
      try { completed = await Promise.race([...active.values(), wakeSignal]); }
      finally { if (this.scanWake === wake) this.scanWake = null; }
      if (!completed) { observedScanRevision = this.scanRequestRevision; continue; }
      active.delete(completed.reply.laneKey);
      if ("error" in completed) { fatal = true; fatalError = completed.error; continue; }
      const completedAt = new Date().toISOString();
      if (completed.result === "failed") {
        blockedTargets.add(completed.reply.laneKey);
        this.lastDeliveryFailureAt = completedAt;
        outcome = "failed";
      } else {
        this.lastDeliveryAt = completedAt;
        if (outcome === "idle") outcome = "delivered";
      }
    }
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
