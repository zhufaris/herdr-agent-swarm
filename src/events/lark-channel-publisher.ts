import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BindingStorePort, LarkPort } from "../domain/ports.js";
import type { OutboundReply } from "../domain/types.js";
import type { BridgeEventBus } from "./bridge-event-bus.js";
import { safeLogError } from "../runtime/safe-error.js";

/** Delivers user-visible lifecycle updates through a durable SQLite outbox. */
export class LarkChannelPublisher {
  private draining: Promise<void> | null = null;
  private readonly activeHandlers = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly streamCardCreatedListeners = new Set<(promptId: string, viewVersion: number) => void>();

  constructor(
    private readonly bus: BridgeEventBus,
    private readonly store: BindingStorePort,
    private readonly lark: LarkPort,
    private readonly logger: Logger
  ) {}

  start(): () => void {
    void this.drain();
    this.unsubscribe = () => {};
    return () => this.unsubscribe?.();
  }

  onStreamCardCreated(listener: (promptId: string, viewVersion: number) => void): () => void {
    this.streamCardCreatedListeners.add(listener);
    return () => this.streamCardCreatedListeners.delete(listener);
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopPromise = this.waitForActiveWork();
    return this.stopPromise;
  }

  async enqueueCard(rootMessageId: string, idempotencyKey: string, card: object, bindingId: string | null = null): Promise<void> {
    this.store.enqueueOutboundReply({
      id: randomUUID(), idempotencyKey, bindingId, rootMessageId, kind: "card_reply", payload: JSON.stringify(card)
    });
    await this.drain();
  }

  async enqueueCardUpdate(bindingId: string | null, messageId: string, eventId: string, card: object): Promise<void> {
    this.store.enqueueOutboundReply({
      id: randomUUID(), idempotencyKey: `card-update:${messageId}:${eventId}`, bindingId, rootMessageId: messageId, kind: "card_update", payload: JSON.stringify(card)
    });
    await this.drain();
  }

  async enqueueRunCardUpdate(bindingId: string, promptId: string, messageId: string, viewVersion: number, cardRole: "task" | "answer", card: object): Promise<void> {
    this.store.enqueueOutboundReply({
      id: randomUUID(), idempotencyKey: "run-card:update:" + promptId + ":" + cardRole + ":" + viewVersion, bindingId, promptId, viewVersion, cardRole,
      rootMessageId: messageId, kind: "card_update", payload: JSON.stringify(card)
    });
    await this.drain();
  }

  async enqueueStreamContent(bindingId: string, promptId: string, cardId: string, elementId: string, content: string, sequence: number): Promise<void> {
    assertAnswerStreamTarget(this.store, bindingId, promptId, cardId, elementId);
    this.store.enqueueOutboundReply({
      id: randomUUID(), idempotencyKey: `stream:${promptId}:${cardId}:${sequence}`, bindingId, promptId, viewVersion: sequence, cardRole: "answer",
      rootMessageId: cardId, kind: "stream_content", payload: JSON.stringify({ elementId, content, sequence })
    });
    await this.drain();
  }

  async enqueueStreamCardCreate(input: { bindingId: string; promptId: string; rootMessageId: string; card: object; pageIndex: number; pageStart: number; elementId: string; viewVersion: number }): Promise<void> {
    this.store.enqueueOutboundReply({
      id: randomUUID(), idempotencyKey: `stream-card:${input.promptId}:${input.pageIndex}`, bindingId: input.bindingId, promptId: input.promptId, viewVersion: input.viewVersion, cardRole: "answer",
      rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.pageIndex, pageStart: input.pageStart, elementId: input.elementId } })
    });
    await this.drain();
  }

  async enqueueStreamFinish(bindingId: string, promptId: string, cardId: string, summary: string, sequence: number): Promise<void> {
    assertAnswerCardTarget(this.store, bindingId, promptId, cardId);
    this.store.enqueueOutboundReply({
      id: randomUUID(), idempotencyKey: `stream-finish:${promptId}:${cardId}:${sequence}`, bindingId, promptId, viewVersion: sequence, cardRole: "answer",
      rootMessageId: cardId, kind: "stream_finish", payload: JSON.stringify({ summary, sequence })
    });
    await this.drain();
  }

  async drain(force = false): Promise<void> {
    if (this.draining) {
      await this.draining;
      return this.drain(force);
    }
    this.draining = this.drainPending(force).finally(() => { this.draining = null; });
    return this.draining;
  }

  async retryPending(): Promise<void> { await this.drain(true); }

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
      const batch = firstReplyPerTarget(force ? this.store.listPendingOutboundReplies() : this.store.listDueOutboundReplies(), blockedTargets);
      if (batch.length === 0) return;
      await Promise.all(batch.map((reply) => this.trackHandler(this.deliverReply(reply, blockedTargets))));
    }
  }

  private async deliverReply(reply: OutboundReply, blockedTargets: Set<string>): Promise<void> {
    try {
      if (reply.kind === "card_update") {
        if (reply.cardRole === "answer") assertAnswerMessageTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId);
        await this.lark.updateCard(reply.rootMessageId, JSON.parse(reply.payload) as object);
        this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
      } else if (reply.kind === "stream_card_create") {
        const decoded = decodeStreamingCardPayload(reply.payload);
        assertAnswerCardCreateTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId, decoded.stream);
        const card = decoded.card;
        const sent = this.lark.replyStreamingCard
          ? await this.lark.replyStreamingCard(reply.rootMessageId, card)
          : { ...(await this.lark.replyCard(reply.rootMessageId, card)), cardId: undefined };
        this.store.markOutboundReplyDelivered(reply.id, sent.messageId, sent.cardId);
        this.store.recordBridgeMessage(sent.messageId);
        if (reply.promptId && reply.attemptCount > 0 && decoded.stream && decoded.stream.pageIndex > 0) {
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
          ? await this.lark.replyText(reply.rootMessageId, reply.payload)
          : await this.lark.replyCard(reply.rootMessageId, JSON.parse(reply.payload) as object);
        this.store.markOutboundReplyDelivered(reply.id, sent.messageId);
        this.store.recordBridgeMessage(sent.messageId);
        if (reply.kind === "card_reply" && reply.bindingId && !reply.promptId) this.store.updateBinding(reply.bindingId, { statusMessageId: sent.messageId });
      }
    } catch (error) {
      const permanent = error instanceof PermanentDeliveryError;
      const failed = permanent
        ? this.store.markOutboundReplyDeadLetter(reply.id, errorMessage(error))
        : this.store.markOutboundReplyFailed(reply.id, errorMessage(error));
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

function firstReplyPerTarget(replies: OutboundReply[], blockedTargets: Set<string>): OutboundReply[] {
  const selected: OutboundReply[] = [];
  const selectedTargets = new Set<string>();
  for (const reply of replies) {
    const target = deliveryTargetKey(reply);
    if (blockedTargets.has(target) || selectedTargets.has(target)) continue;
    selectedTargets.add(target);
    selected.push(reply);
  }
  return selected;
}

function deliveryTargetKey(reply: OutboundReply): string {
  return reply.kind === "stream_content" || reply.kind === "stream_finish"
    ? `stream:${reply.rootMessageId}`
    : `message:${reply.rootMessageId}`;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
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

class PermanentDeliveryError extends Error {}

function assertAnswerCardCreateTarget(
  store: BindingStorePort, bindingId: string | null, promptId: string | null, rootMessageId: string,
  stream?: { pageIndex: number; pageStart: number; elementId: string }
): void {
  if (!bindingId || !promptId) throw new PermanentDeliveryError("Answer card create target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  const binding = store.getBinding(bindingId);
  if (!view || view.bindingId !== bindingId || binding?.rootMessageId !== rootMessageId) {
    throw new PermanentDeliveryError(`Answer card create target mismatch for prompt ${promptId}`);
  }
  if (!stream) {
    if (view.answerMessageId || view.answerCardId || view.answerPageIndex !== 0) throw new PermanentDeliveryError(`Initial answer card create is stale for prompt ${promptId}`);
    return;
  }
  if (!view.answerCardId || stream.pageIndex !== view.answerPageIndex + 1 || stream.pageStart <= view.answerPageStart || !stream.elementId) {
    throw new PermanentDeliveryError(`Answer continuation target mismatch for prompt ${promptId}`);
  }
}

function assertAnswerCardTarget(store: BindingStorePort, bindingId: string | null, promptId: string | null, cardId: string): void {
  if (!bindingId || !promptId) throw new PermanentDeliveryError("Answer stream target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  if (!view || view.bindingId !== bindingId || view.answerCardId !== cardId) {
    throw new PermanentDeliveryError(`Answer stream card target mismatch for prompt ${promptId}`);
  }
}

function assertAnswerStreamTarget(store: BindingStorePort, bindingId: string | null, promptId: string | null, cardId: string, elementId: string): void {
  assertAnswerCardTarget(store, bindingId, promptId, cardId);
  const view = store.loadRunCard(promptId!);
  if (!view || view.answerElementId !== elementId) {
    throw new PermanentDeliveryError(`Answer stream element target mismatch for prompt ${promptId}`);
  }
}

function assertAnswerMessageTarget(store: BindingStorePort, bindingId: string | null, promptId: string | null, messageId: string): void {
  if (!bindingId || !promptId) throw new PermanentDeliveryError("Answer card target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  if (!view || view.bindingId !== bindingId || view.answerMessageId !== messageId) {
    throw new PermanentDeliveryError(`Answer card message target mismatch for prompt ${promptId}`);
  }
}
