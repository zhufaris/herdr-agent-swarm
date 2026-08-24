import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BindingStorePort, LarkPort } from "../domain/ports.js";
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
      const replies = (force ? this.store.listPendingOutboundReplies() : this.store.listDueOutboundReplies()).filter((reply) => !blockedTargets.has(reply.rootMessageId));
      if (replies.length === 0) return;
      for (const reply of replies) {
        try {
        if (reply.kind === "card_update") {
          if (reply.cardRole === "answer") assertAnswerMessageTarget(this.store, reply.bindingId, reply.promptId, reply.rootMessageId);
          await this.lark.updateCard(reply.rootMessageId, JSON.parse(reply.payload) as object);
          this.store.markOutboundReplyDelivered(reply.id, reply.rootMessageId);
        } else if (reply.kind === "stream_card_create") {
          const decoded = decodeStreamingCardPayload(reply.payload);
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
          const failed = this.store.markOutboundReplyFailed(reply.id, errorMessage(error));
          const context = {
            event: failed?.state === "dead_letter" ? "lark-outbox-dead-lettered" : "lark-outbox-retry-scheduled",
            err: safeLogError(error), replyId: reply.id, replyKind: reply.kind, bindingId: reply.bindingId, promptId: reply.promptId,
            attempt: failed?.attemptCount ?? reply.attemptCount + 1, nextAttemptAt: failed?.nextAttemptAt,
            outcome: failed?.state === "dead_letter" ? "dead_letter" : "retry"
          };
          if (failed?.state === "dead_letter") this.logger.error(context, "Lark outbox reply exhausted retries");
          else this.logger.warn(context, "Lark outbox reply delivery failed; retry scheduled");
          blockedTargets.add(reply.rootMessageId);
        }
      }
    }
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function decodeStreamingCardPayload(payload: string): { card: object; stream?: { pageIndex: number } } {
  const decoded = JSON.parse(payload) as object & { card?: object; stream?: { pageIndex?: unknown } };
  return decoded.card && decoded.stream
    ? { card: decoded.card, stream: { pageIndex: typeof decoded.stream.pageIndex === "number" ? decoded.stream.pageIndex : 0 } }
    : { card: decoded };
}

function assertAnswerCardTarget(store: BindingStorePort, bindingId: string | null, promptId: string | null, cardId: string): void {
  if (!bindingId || !promptId) throw new Error("Answer stream target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  if (!view || view.bindingId !== bindingId || view.answerCardId !== cardId) {
    throw new Error(`Answer stream card target mismatch for prompt ${promptId}`);
  }
}

function assertAnswerStreamTarget(store: BindingStorePort, bindingId: string | null, promptId: string | null, cardId: string, elementId: string): void {
  assertAnswerCardTarget(store, bindingId, promptId, cardId);
  const view = store.loadRunCard(promptId!);
  if (!view || view.answerElementId !== elementId) {
    throw new Error(`Answer stream element target mismatch for prompt ${promptId}`);
  }
}

function assertAnswerMessageTarget(store: BindingStorePort, bindingId: string | null, promptId: string | null, messageId: string): void {
  if (!bindingId || !promptId) throw new Error("Answer card target is missing binding or prompt identity");
  const view = store.loadRunCard(promptId);
  if (!view || view.bindingId !== bindingId || view.answerMessageId !== messageId) {
    throw new Error(`Answer card message target mismatch for prompt ${promptId}`);
  }
}
