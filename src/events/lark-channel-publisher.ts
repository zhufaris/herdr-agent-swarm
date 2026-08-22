import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BindingStorePort, LarkPort } from "../domain/ports.js";
import type { BridgeEventBus } from "./bridge-event-bus.js";

/** Delivers user-visible lifecycle updates through a durable SQLite outbox. */
export class LarkChannelPublisher {
  private draining: Promise<void> | null = null;
  private readonly activeHandlers = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

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

  async drain(force = false): Promise<void> {
    if (this.draining) {
      await this.draining;
      return this.drain(force);
    }
    this.draining = this.drainPending(force).finally(() => { this.draining = null; });
    return this.draining;
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
      const replies = (force ? this.store.listPendingOutboundReplies() : this.store.listDueOutboundReplies()).filter((reply) => !blockedTargets.has(reply.rootMessageId));
      if (replies.length === 0) return;
      for (const reply of replies) {
        try {
        if (reply.kind === "card_update") {
          await this.lark.updateCard(reply.rootMessageId, JSON.parse(reply.payload) as object);
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
            err: error, replyId: reply.id, replyKind: reply.kind, bindingId: reply.bindingId, promptId: reply.promptId,
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
