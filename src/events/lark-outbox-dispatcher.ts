import type { Logger } from "pino";
import type { LarkPort, OutboundCheckpointSubscriber, OutboxDispatcherControl, OutboxStore } from "../domain/ports.js";
import type { OutboundReply } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { PromptWorkScheduler } from "./prompt-work-scheduler.js";
import { InProcessOutboundWorkNotifier, type OutboundWorkNotifier } from "./outbound-work-notifier.js";
import { assertAnswerCardCreateTarget, assertAnswerCardTarget, assertAnswerMessageTarget, assertAnswerStreamTarget, PermanentDeliveryError } from "./outbound-target-validation.js";

/** Delivers user-visible lifecycle updates through a durable SQLite outbox. */
export class LarkOutboxDispatcher implements OutboxDispatcherControl, OutboundCheckpointSubscriber {
  private static readonly MAX_CONCURRENT_DELIVERIES = 4;
  private draining: Promise<void> | null = null;
  private readonly activeHandlers = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private safetyTimer: ReturnType<typeof setInterval> | null = null;
  private scanRequested = false;
  private forceRequested = false;
  private readonly streamCardCreatedListeners = new Set<(promptId: string, viewVersion: number) => void>();
  private scheduler: PromptWorkScheduler | null = null;

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
    const unsubscribeWork = this.work.subscribe(() => this.requestScan());
    this.unsubscribe = () => { unsubscribeWork(); this.unsubscribe = null; };
    this.safetyTimer = setInterval(() => void this.requestScan(), this.safetyScanIntervalMs);
    this.safetyTimer.unref?.();
    void this.requestScan();
    return this.unsubscribe;
  }

  onStreamCardCreated(listener: (promptId: string, viewVersion: number) => void): () => void {
    this.streamCardCreatedListeners.add(listener);
    return () => this.streamCardCreatedListeners.delete(listener);
  }

  connectPromptScheduler(scheduler: PromptWorkScheduler): void { this.scheduler = scheduler; }

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
      if (this.scanRequested && !this.stopping) void this.requestScan();
    });
    return this.draining;
  }

  private async runRequestedScans(): Promise<void> {
    while (this.scanRequested && !this.stopping) {
      const force = this.forceRequested;
      this.scanRequested = false;
      this.forceRequested = false;
      await this.drainPending(force);
    }
  }

  private trackHandler(work: Promise<void>): Promise<void> {
    this.activeHandlers.add(work);
    void work.then(
      () => this.activeHandlers.delete(work),
      () => this.activeHandlers.delete(work)
    );
    return work;
  }

  private async waitForActiveWork(): Promise<void> {
    await Promise.allSettled([...this.activeHandlers]);
    if (this.draining) await this.draining;
  }

  private async drainPending(force: boolean): Promise<void> {
    const blockedTargets = new Set<string>();
    while (true) {
      if (this.stopping) return;
      const batch = this.store.listOutboundLaneHeads(
        LarkOutboxDispatcher.MAX_CONCURRENT_DELIVERIES,
        force ? null : new Date().toISOString(),
        [...blockedTargets]
      );
      if (batch.length === 0) return;
      await Promise.all(batch.map((reply) => this.trackHandler(this.deliverReply(reply, blockedTargets))));
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.stopping) return;
    const nextAttemptAt = this.store.getNextOutboundLaneHeadAttemptAt();
    if (!nextAttemptAt) return;
    const dueAt = Date.parse(nextAttemptAt);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.requestScan();
    }, Math.max(0, dueAt - Date.now()));
    this.retryTimer.unref?.();
  }

  private async deliverReply(reply: OutboundReply, blockedTargets: Set<string>): Promise<void> {
    try {
      if (reply.kind === "card_update") {
        if (reply.cardRole === "answer") assertAnswerMessageTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId);
        await this.lark.updateCard(reply.rootMessageId, JSON.parse(reply.payload) as object);
        this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
      } else if (reply.kind === "stream_card_create") {
        const decoded = decodeStreamingCardPayload(reply.payload);
        assertAnswerCardCreateTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId, decoded.card, decoded.stream);
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
        if (reply.promptId && decoded.stream && decoded.stream.pageIndex > 0) {
          for (const listener of this.streamCardCreatedListeners) listener(reply.promptId, (reply.viewVersion ?? 0) + 1);
        }
      } else if (reply.kind === "stream_content") {
        if (!this.lark.streamCardContent) throw new Error("Lark adapter does not support CardKit content streaming");
        const payload = JSON.parse(reply.payload) as { elementId: string; content: string; sequence: number };
        assertAnswerStreamTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId, payload.elementId);
        await this.lark.streamCardContent(reply.rootMessageId, payload.elementId, payload.content, payload.sequence);
        this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
      } else if (reply.kind === "stream_finish") {
        if (!this.lark.finishStreamingCard) throw new Error("Lark adapter does not support CardKit stream finalization");
        const payload = JSON.parse(reply.payload) as { summary: string; sequence: number };
        assertAnswerCardTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId);
        await this.lark.finishStreamingCard(reply.rootMessageId, payload.sequence, payload.summary);
        this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
      } else {
        const sent = reply.kind === "text"
          ? await this.lark.replyText(reply.rootMessageId, reply.payload, reply.idempotencyKey)
          : await this.lark.replyCard(reply.rootMessageId, JSON.parse(reply.payload) as object, reply.idempotencyKey);
        this.store.markOutboundReplyDelivered(reply.id, sent.messageId);
        this.store.recordBridgeMessage(sent.messageId);
        if (reply.kind === "card_reply" && reply.bindingId && !reply.promptId) this.store.updateBinding(reply.bindingId, { statusMessageId: sent.messageId });
      }
    } catch (error) {
      const permanent = error instanceof PermanentDeliveryError;
      const retryDelayMs = permanent ? undefined : retryAfterDelayMs(error);
      const failed = permanent
        ? this.store.markOutboundReplyDeadLetter(reply.id, errorMessage(error))
        : this.store.markOutboundReplyFailed(reply.id, errorMessage(error), retryDelayMs);
      const context = {
        event: failed?.state === "dead_letter" ? "lark-outbox-dead-lettered" : "lark-outbox-retry-scheduled",
        err: safeLogError(error), replyId: reply.id, replyKind: reply.kind, bindingId: reply.bindingId, promptId: reply.promptId,
        attempt: failed?.attemptCount ?? reply.attemptCount + 1, nextAttemptAt: failed?.nextAttemptAt,
        outcome: failed?.state === "dead_letter" ? "dead_letter" : "retry"
      };
      if (failed?.state === "dead_letter") this.logger.error(context, permanent ? "Lark outbox reply rejected by durable target validation" : "Lark outbox reply exhausted retries");
      else this.logger.warn(context, "Lark outbox reply delivery failed; retry scheduled");
      blockedTargets.add(deliveryTargetKey(reply));
    }
  }
}

function deliveryTargetKey(reply: OutboundReply): string {
  if (reply.cardRole === "answer" && reply.promptId) return `answer:${reply.promptId}`;
  return reply.kind === "stream_content" || reply.kind === "stream_finish"
    ? `stream:${reply.rootMessageId}`
    : `message:${reply.rootMessageId}`;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function retryAfterDelayMs(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const response = isRecord(error.response) ? error.response : null;
  if (response?.status !== 429 || !isRecord(response.headers)) return undefined;
  const get = typeof response.headers.get === "function" ? response.headers.get as (name: string) => unknown : null;
  const header = get?.call(response.headers, "retry-after")
    ?? Object.entries(response.headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  if (typeof header !== "string" && typeof header !== "number") return undefined;
  const value = String(header).trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function decodeStreamingCardPayload(payload: string): { card: object; stream?: { pageIndex: number; pageStart: number; elementId: string } } {
  const decoded = JSON.parse(payload) as object & { card?: object; stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown } };
  return decoded.card && decoded.stream
    ? { card: decoded.card, stream: {
      pageIndex: typeof decoded.stream.pageIndex === "number" ? decoded.stream.pageIndex : -1,
      pageStart: typeof decoded.stream.pageStart === "number" ? decoded.stream.pageStart : -1,
      elementId: typeof decoded.stream.elementId === "string" ? decoded.stream.elementId : ""
    } }
    : { card: decoded };
}
