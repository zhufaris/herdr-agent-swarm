import type { Logger } from "pino";
import type { LarkPort } from "../domain/ports/external.js";
import type { OutboundCheckpointSubscriber, OutboxDispatcherControl, OutboxStore } from "../domain/ports/outbox.js";
import type { OutboundReply, OutboxDispatcherDiagnostics } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ActiveWorkTracker } from "../runtime/active-work-tracker.js";
import type { PromptWorkScheduler } from "./prompt-work-scheduler.js";
import { InProcessOutboundWorkNotifier, type OutboundWorkNotifier } from "./outbound-work-notifier.js";
import { classifyDeliveryError } from "./delivery-error-classifier.js";
import { assertAnswerCardCreateTarget, assertAnswerCardTarget, assertAnswerMessageTarget, assertAnswerStreamTarget, assertWorkerCardCreateTarget, assertWorkerCardTarget, assertWorkerMessageTarget, assertWorkerProgressTarget } from "./outbound-target-validation.js";

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
  private readonly answerCheckpointListeners = new Set<(promptId: string, viewVersion: number) => void>();
  private readonly workerTurnCheckpointListeners = new Set<(turnId: string, viewVersion: number) => void>();
  private readonly mainCardCheckpointListeners = new Set<(bindingId: string, viewVersion: number) => void>();
  private scheduler: PromptWorkScheduler | null = null;
  private lastScanAt: string | null = null;
  private lastScanOutcome: OutboxDispatcherDiagnostics["lastScanOutcome"] = null;
  private lastSuccessfulScanAt: string | null = null;
  private lastScanFailureAt: string | null = null;
  private consecutiveScanFailures = 0;
  private lastDeliveryAt: string | null = null;
  private lastDeliveryFailureAt: string | null = null;

  constructor(
    private readonly store: OutboxStore,
    private readonly lark: LarkPort,
    private readonly logger: Logger,
    private readonly work: OutboundWorkNotifier = new InProcessOutboundWorkNotifier(logger),
    private readonly safetyScanIntervalMs = 30_000
  ) {}

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
    this.answerCheckpointListeners.add(listener);
    return () => this.answerCheckpointListeners.delete(listener);
  }

  onWorkerTurnCheckpoint(listener: (turnId: string, viewVersion: number) => void): () => void {
    this.workerTurnCheckpointListeners.add(listener);
    return () => this.workerTurnCheckpointListeners.delete(listener);
  }

  onMainCardCheckpoint(listener: (bindingId: string, viewVersion: number) => void): () => void {
    this.mainCardCheckpointListeners.add(listener);
    return () => this.mainCardCheckpointListeners.delete(listener);
  }

  connectPromptScheduler(scheduler: PromptWorkScheduler): void { this.scheduler = scheduler; }

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
      this.logger.info({ event: "lark-outbox-auto-recovered", replyId: reply.id, replyKind: reply.kind, laneKey: deliveryTargetKey(reply), failureClass: reply.failureClass, autoRecoveryCount: reply.autoRecoveryCount, deadLetteredAt: reply.deadLetteredAt, outcome: "pending" }, "transient Lark outbox dead letter reopened for one recovery round");
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
      for (const reply of repeated) blockedTargets.add(deliveryTargetKey(reply));
      const deliverable = batch.filter((reply) => !attemptedReplyIds.has(reply.id));
      if (deliverable.length === 0) continue;
      for (const reply of deliverable) attemptedReplyIds.add(reply.id);
      const results = await Promise.all(deliverable.map((reply) => this.trackHandler(this.deliverReply(reply, blockedTargets))));
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

  private async deliverReply(reply: OutboundReply, blockedTargets: Set<string>): Promise<"delivered" | "failed"> {
    try {
      if ((reply.kind === "stream_content" || reply.kind === "stream_finish") && this.store.dismissSupersededAnswerStream(reply.id)) {
        this.logger.info({ event: "lark-outbox-answer-stream-dismissed", replyId: reply.id, bindingId: reply.bindingId, promptId: reply.promptId, replyKind: reply.kind, outcome: "dismissed" }, "dismissed an Answer stream event superseded by a continuation page");
        return "delivered";
      }
      if (reply.kind === "card_update") {
        if (reply.cardRole === "answer") assertAnswerMessageTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId);
        if (reply.workerTurnId) assertWorkerMessageTarget(this.store, reply.workerTurnId, reply.rootMessageId);
        const card = JSON.parse(reply.payload) as object;
        if (reply.targetRole === "session_status" && this.lark.updateCardKit) {
          await this.lark.updateCardKit(reply.rootMessageId, card, reply.cardSequence ?? 1);
        } else await this.lark.updateCard(reply.rootMessageId, card);
        this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
        if (reply.workerTurnId) for (const listener of this.workerTurnCheckpointListeners) listener(reply.workerTurnId, reply.viewVersion ?? 0);
        if (reply.bindingId && reply.targetRole === "session_status") for (const listener of this.mainCardCheckpointListeners) listener(reply.bindingId, reply.viewVersion ?? 0);
      } else if (reply.kind === "stream_card_create") {
        const decoded = decodeStreamingCardPayload(reply.payload);
        if (reply.workerTurnId) assertWorkerCardCreateTarget(this.store, reply.workerTurnId, reply.rootMessageId, decoded.card, decoded.stream);
        else assertAnswerCardCreateTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId, decoded.card, decoded.stream);
        const card = decoded.card;
        let sent: { messageId: string; cardId?: string };
        if (this.lark.createStreamingCard && this.lark.replyStreamingCardReference) {
          const cardId = reply.cardIdCheckpoint ?? (await this.lark.createStreamingCard(card)).cardId;
          if (!reply.cardIdCheckpoint) this.store.checkpointOutboundReplyCard(reply.id, cardId);
          sent = { ...(await this.lark.replyStreamingCardReference(reply.rootMessageId, cardId, reply.idempotencyKey)), cardId };
        } else if (this.lark.replyStreamingCard) sent = await this.lark.replyStreamingCard(reply.rootMessageId, card);
        else sent = await this.lark.replyCard(reply.rootMessageId, card, reply.idempotencyKey);
        this.store.markOutboundReplyDelivered(reply.id, sent.messageId, sent.cardId);
        this.store.recordBridgeMessage(sent.messageId);
        if (reply.bindingId && reply.promptId) {
          const prompt = this.store.getPrompt(reply.promptId);
          if (prompt?.dispatchKind === "steering" && prompt.parentPromptId) this.scheduler?.wake({ kind: "steering-ready", bindingId: reply.bindingId, parentPromptId: prompt.parentPromptId });
          else this.scheduler?.wake({ kind: "prompt-ready", bindingId: reply.bindingId });
        }
        if (reply.promptId && decoded.stream) for (const listener of this.answerCheckpointListeners) listener(reply.promptId, (reply.viewVersion ?? 0) + 1);
        if (reply.workerTurnId && decoded.stream) for (const listener of this.workerTurnCheckpointListeners) listener(reply.workerTurnId, (reply.viewVersion ?? 0) + 1);
      } else if (reply.kind === "stream_content") {
        if (!this.lark.streamCardContent) throw new Error("Lark adapter does not support CardKit content streaming");
        const payload = JSON.parse(reply.payload) as { elementId: string; content: string; sequence: number; pageIndex: number; workerElement?: "progress" };
        if (reply.workerTurnId) {
          if (payload.workerElement === "progress") assertWorkerProgressTarget(this.store, reply.workerTurnId, reply.rootMessageId, payload.elementId, payload.pageIndex);
          else assertWorkerCardTarget(this.store, reply.workerTurnId, reply.rootMessageId, payload.elementId);
        }
        else assertAnswerStreamTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId, payload.elementId);
        if (payload.content) await this.lark.streamCardContent(reply.rootMessageId, payload.elementId, payload.content, payload.sequence);
        else this.logger.info({ event: "lark-outbox-empty-answer-content-skipped", replyId: reply.id, bindingId: reply.bindingId, promptId: reply.promptId, sequence: payload.sequence, outcome: "checkpointed" }, "checkpointed an empty legacy Answer update without sending it to Lark");
        this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
        if (reply.promptId) for (const listener of this.answerCheckpointListeners) listener(reply.promptId, reply.viewVersion ?? 0);
        if (reply.workerTurnId) for (const listener of this.workerTurnCheckpointListeners) listener(reply.workerTurnId, reply.viewVersion ?? 0);
      } else if (reply.kind === "stream_finish") {
        if (!this.lark.finishStreamingCard) throw new Error("Lark adapter does not support CardKit stream finalization");
        const payload = JSON.parse(reply.payload) as { summary: string; sequence: number };
        if (reply.workerTurnId) assertWorkerCardTarget(this.store, reply.workerTurnId, reply.rootMessageId);
        else assertAnswerCardTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId);
        await this.lark.finishStreamingCard(reply.rootMessageId, payload.sequence, payload.summary);
        this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
        if (reply.promptId) for (const listener of this.answerCheckpointListeners) listener(reply.promptId, reply.viewVersion ?? 0);
        if (reply.workerTurnId) for (const listener of this.workerTurnCheckpointListeners) listener(reply.workerTurnId, reply.viewVersion ?? 0);
      } else {
        const sent = reply.kind === "text"
          ? await this.lark.replyText(reply.rootMessageId, reply.payload, reply.idempotencyKey)
          : await this.lark.replyCard(reply.rootMessageId, JSON.parse(reply.payload) as object, reply.idempotencyKey);
        this.store.markOutboundReplyDelivered(reply.id, sent.messageId);
        this.store.recordBridgeMessage(sent.messageId);
        if (reply.bindingId && reply.targetRole === "session_status") for (const listener of this.mainCardCheckpointListeners) listener(reply.bindingId, reply.viewVersion ?? 0);
      }
      this.lastDeliveryAt = new Date().toISOString();
      return "delivered";
    } catch (error) {
      const classified = classifyDeliveryError(error);
      const permanent = classified.failureClass === "permanent";
      const metadata = { failureClass: classified.failureClass, httpStatus: classified.httpStatus, larkErrorCode: classified.larkErrorCode };
      const transition = this.store.markOutboundReplyFailedWithQuarantine(reply.id, classified.message, metadata, classified.retryDelayMs);
      const failed = transition?.reply ?? null;
      const context = {
        event: failed?.state === "dead_letter" ? "lark-outbox-dead-lettered" : "lark-outbox-retry-scheduled",
        err: safeLogError(error), replyId: reply.id, replyKind: reply.kind, bindingId: reply.bindingId, promptId: reply.promptId,
        attempt: failed?.attemptCount ?? reply.attemptCount + 1, nextAttemptAt: failed?.nextAttemptAt,
        failureClass: classified.failureClass, httpStatus: classified.httpStatus, larkErrorCode: classified.larkErrorCode, autoRecoveryCount: failed?.autoRecoveryCount ?? reply.autoRecoveryCount,
        laneClass: transition?.laneClass, quarantineAction: transition?.action,
        outcome: failed?.state === "dead_letter" ? "dead_letter" : "retry"
      };
      if (failed?.state === "dead_letter") this.logger.error(context, permanent ? "Lark outbox reply rejected by durable target validation" : "Lark outbox reply exhausted retries");
      else this.logger.warn(context, "Lark outbox reply delivery failed; retry scheduled");
      if (transition?.action === "rebuild_answer" && transition.promptId) {
        for (const listener of this.answerCheckpointListeners) listener(transition.promptId, failed?.viewVersion ?? 0);
      }
      blockedTargets.add(deliveryTargetKey(reply));
      this.lastDeliveryFailureAt = new Date().toISOString();
      return "failed";
    }
  }
}

function deliveryTargetKey(reply: OutboundReply): string {
  if (reply.workerTurnId) return `worker-turn:${reply.workerTurnId}`;
  if (reply.cardRole === "answer" && reply.promptId) return `answer:${reply.promptId}`;
  return reply.kind === "stream_content" || reply.kind === "stream_finish"
    ? `stream:${reply.rootMessageId}`
    : `message:${reply.rootMessageId}`;
}

function decodeStreamingCardPayload(payload: string): { card: object; stream?: { pageIndex: number; pageStart: number; elementId: string; deliveryMode?: "static" } } {
  const decoded = JSON.parse(payload) as object & { card?: object; stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown; deliveryMode?: unknown } };
  if (!decoded.card || !decoded.stream) return { card: decoded };
  const stream = {
    pageIndex: typeof decoded.stream.pageIndex === "number" ? decoded.stream.pageIndex : -1,
    pageStart: typeof decoded.stream.pageStart === "number" ? decoded.stream.pageStart : -1,
    elementId: typeof decoded.stream.elementId === "string" ? decoded.stream.elementId : ""
  };
  return decoded.stream.deliveryMode === "static"
    ? { card: decoded.card, stream: { ...stream, deliveryMode: "static" } }
    : { card: decoded.card, stream };
}
