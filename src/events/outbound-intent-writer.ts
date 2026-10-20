import { randomUUID } from "node:crypto";
import type { OutboundIntentPort, OutboundIntentStore, PreparedDeliveryConsumer, PreparedDeliveryReservationInput } from "../domain/ports/outbox.js";
import type { OutboundWorkClass } from "../domain/types.js";
import type { OutboundWorkNotifier } from "./outbound-work-notifier.js";
import { assertAnswerCardTarget, assertAnswerStreamTarget } from "./outbound-target-validation.js";

export class OutboundIntentWriter implements OutboundIntentPort {
  constructor(private readonly store: OutboundIntentStore, private readonly work: OutboundWorkNotifier, private readonly consumer: PreparedDeliveryConsumer) {}

  async enqueueCard(rootMessageId: string, idempotencyKey: string, card: object, bindingId: string | null = null, targetRole: "session_status" | "operation_result" | null = null): Promise<void> {
    this.reserve({ id: randomUUID(), idempotencyKey, bindingId, targetRole, rootMessageId, kind: "card_reply", payload: JSON.stringify(card), ...(bindingId === null ? { globalDelivery: true as const } : {}) });
  }

  async enqueueCardUpdate(bindingId: string | null, messageId: string, eventId: string, card: object): Promise<void> {
    this.reserve({ id: randomUUID(), idempotencyKey: `card-update:${messageId}:${eventId}`, bindingId, rootMessageId: messageId, kind: "card_update", payload: JSON.stringify(card), ...(bindingId === null ? { globalDelivery: true as const } : {}) });
  }

  async enqueueRunCardUpdate(bindingId: string, promptId: string, messageId: string, viewVersion: number, cardRole: "task" | "answer", card: object, workClass?: OutboundWorkClass): Promise<void> {
    const streamPageIndex = cardRole === "answer" ? this.store.loadRunCard(promptId)?.answerPageIndex ?? null : null;
    this.reserve({ id: randomUUID(), idempotencyKey: `run-card:update:${promptId}:${cardRole}:${viewVersion}`, bindingId, promptId, viewVersion, streamPageIndex, cardRole, ...outboundWorkClass(workClass), rootMessageId: messageId, kind: "card_update", payload: JSON.stringify(card) });
  }

  async enqueueStreamContent(bindingId: string, promptId: string, cardId: string, elementId: string, content: string, sequence: number): Promise<void> {
    assertAnswerStreamTarget(this.store, bindingId, promptId, cardId, elementId);
    this.reserve({ id: randomUUID(), idempotencyKey: `stream:${promptId}:${cardId}:${sequence}`, bindingId, promptId, viewVersion: sequence, cardRole: "answer", rootMessageId: cardId, kind: "stream_content", payload: JSON.stringify({ elementId, content, sequence }) });
  }

  async enqueueStreamCardCreate(input: { bindingId: string; promptId: string; rootMessageId: string; card: object; pageIndex: number; pageStart: number; elementId: string; viewVersion: number }): Promise<void> {
    this.reserve({ id: randomUUID(), idempotencyKey: `answer-post:${input.promptId}:${input.pageIndex}`, bindingId: input.bindingId, promptId: input.promptId, viewVersion: input.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.pageIndex, pageStart: input.pageStart, elementId: input.elementId } }) });
  }

  async enqueueStreamFinish(bindingId: string, promptId: string, cardId: string, summary: string, sequence: number): Promise<void> {
    assertAnswerCardTarget(this.store, bindingId, promptId, cardId);
    this.reserve({ id: randomUUID(), idempotencyKey: `stream-finish:${promptId}:${cardId}:${sequence}`, bindingId, promptId, viewVersion: sequence, cardRole: "answer", rootMessageId: cardId, kind: "stream_finish", payload: JSON.stringify({ summary, sequence }) });
  }

  async enqueueMessageDelete(bindingId: string | null, messageId: string, idempotencyKey: string): Promise<void> {
    this.reserve({ id: randomUUID(), idempotencyKey, bindingId, rootMessageId: messageId, kind: "message_delete", payload: "", ...(bindingId === null ? { globalDelivery: true as const } : {}) });
  }

  private reserve(input: PreparedDeliveryReservationInput): void {
    const receipt = this.store.reservePreparedOutboundReply(input);
    queueMicrotask(() => {
      const deliveries = receipt.consumeEffects();
      for (const delivery of deliveries) this.consumer.enqueuePreparedDelivery(delivery);
    });
  }
}

function outboundWorkClass(workClass: OutboundWorkClass | undefined): { workClass?: OutboundWorkClass } {
  return workClass ? { workClass } : {};
}
