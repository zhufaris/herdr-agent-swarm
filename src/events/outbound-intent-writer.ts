import { randomUUID } from "node:crypto";
import type { OutboundIntentPort, OutboundIntentStore } from "../domain/ports/outbox.js";
import type { OutboundWorkNotifier } from "./outbound-work-notifier.js";
import { assertAnswerCardTarget, assertAnswerStreamTarget } from "./outbound-target-validation.js";

export class OutboundIntentWriter implements OutboundIntentPort {
  constructor(private readonly store: OutboundIntentStore, private readonly work: OutboundWorkNotifier) {}

  async enqueueCard(rootMessageId: string, idempotencyKey: string, card: object, bindingId: string | null = null, targetRole: "session_status" | "operation_result" | null = null): Promise<void> {
    this.store.enqueueOutboundReply({ id: randomUUID(), idempotencyKey, bindingId, targetRole, rootMessageId, kind: "card_reply", payload: JSON.stringify(card) });
    this.work.wake();
  }

  async enqueueCardUpdate(bindingId: string | null, messageId: string, eventId: string, card: object): Promise<void> {
    this.store.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `card-update:${messageId}:${eventId}`, bindingId, rootMessageId: messageId, kind: "card_update", payload: JSON.stringify(card) });
    this.work.wake();
  }

  async enqueueRunCardUpdate(bindingId: string, promptId: string, messageId: string, viewVersion: number, cardRole: "task" | "answer", card: object): Promise<void> {
    this.store.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:update:${promptId}:${cardRole}:${viewVersion}`, bindingId, promptId, viewVersion, cardRole, rootMessageId: messageId, kind: "card_update", payload: JSON.stringify(card) });
    this.work.wake();
  }

  async enqueueStreamContent(bindingId: string, promptId: string, cardId: string, elementId: string, content: string, sequence: number): Promise<void> {
    assertAnswerStreamTarget(this.store, bindingId, promptId, cardId, elementId);
    this.store.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream:${promptId}:${cardId}:${sequence}`, bindingId, promptId, viewVersion: sequence, cardRole: "answer", rootMessageId: cardId, kind: "stream_content", payload: JSON.stringify({ elementId, content, sequence }) });
    this.work.wake();
  }

  async enqueueStreamCardCreate(input: { bindingId: string; promptId: string; rootMessageId: string; card: object; pageIndex: number; pageStart: number; elementId: string; viewVersion: number }): Promise<void> {
    this.store.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-card:${input.promptId}:${input.pageIndex}`, bindingId: input.bindingId, promptId: input.promptId, viewVersion: input.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.pageIndex, pageStart: input.pageStart, elementId: input.elementId } }) });
    this.work.wake();
  }

  async enqueueStreamFinish(bindingId: string, promptId: string, cardId: string, summary: string, sequence: number): Promise<void> {
    assertAnswerCardTarget(this.store, bindingId, promptId, cardId);
    this.store.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-finish:${promptId}:${cardId}:${sequence}`, bindingId, promptId, viewVersion: sequence, cardRole: "answer", rootMessageId: cardId, kind: "stream_finish", payload: JSON.stringify({ summary, sequence }) });
    this.work.wake();
  }
}
