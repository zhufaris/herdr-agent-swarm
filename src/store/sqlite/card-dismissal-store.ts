import { createHash } from "node:crypto";
import type { CardDismissal, CardDismissalState, CardDismissalStore, ReserveValidatedCardDismissalInput } from "../../domain/ports/card-dismissal.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import type { SqliteContext } from "./context.js";

interface CardDismissalRow {
  id: string;
  action_kind: string;
  semantic_key: string;
  actor_open_id: string;
  chat_id: string;
  gateway_id: string;
  message_id: string;
  outbound_reply_id: string;
  state: CardDismissalState;
  outcome: "deleted" | "already_absent" | "failed" | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

export class SqliteCardDismissalStore implements CardDismissalStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;

  constructor(private readonly context: SqliteContext, private readonly dependencies: {
    enqueueOutboundReply(input: EnqueueOutboundReplyInput): unknown;
  }) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  reserveValidated(input: ReserveValidatedCardDismissalInput): CardDismissal {
    return this.context.transaction("sqlite.card-dismissal-store.write", () => {
      const id = dismissalId(input);
      const existing = this.get(id);
      if (existing) return existing;
      if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) {
        throw new Error("Card Dismissal prepared delivery is not connected");
      }
      const timestamp = now();
      const outboundReplyId = `card-dismissal:${id}`;
      const outbound: EnqueueOutboundReplyInput = {
        id: outboundReplyId,
        idempotencyKey: outboundReplyId,
        gatewayId: input.gatewayId,
        bindingId: null,
        rootMessageId: input.messageId,
        kind: "message_delete",
        payload: "",
        workClass: "live",
        laneKeyOverride: `card-dismissal:${id}`
      };
      this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply(outbound));
      this.context.database.prepare(`INSERT INTO card_dismissals(
        id,action_kind,semantic_key,actor_open_id,chat_id,gateway_id,message_id,outbound_reply_id,
        state,outcome,detail,created_at,updated_at,settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deleting', NULL, NULL, ?, ?, NULL)`).run(
        id, input.actionKind, input.semanticKey, input.actorOpenId, input.chatId, input.gatewayId,
        input.messageId, outboundReplyId, timestamp, timestamp
      );
      return this.require(id);
    });
  }

  get(id: string): CardDismissal | null {
    const row = this.context.database.prepare("SELECT * FROM card_dismissals WHERE id=?").get(id) as CardDismissalRow | undefined;
    return row ? mapDismissal(row) : null;
  }

  settle(input: { outboundReplyId: string; outcome: "deleted" | "already_absent" | "failed"; detail?: string | null }): CardDismissal | null {
    return this.context.transaction("sqlite.card-dismissal-store.write", () => {
      const current = this.context.database.prepare("SELECT * FROM card_dismissals WHERE outbound_reply_id=?").get(input.outboundReplyId) as CardDismissalRow | undefined;
      if (!current) return null;
      if (current.state !== "deleting") return mapDismissal(current);
      const timestamp = now();
      const state: CardDismissalState = input.outcome;
      this.context.database.prepare(`UPDATE card_dismissals
        SET state=?, outcome=?, detail=?, settled_at=?, updated_at=?
        WHERE outbound_reply_id=? AND state='deleting'`).run(
        state, input.outcome, input.detail?.slice(0, 500) ?? null, timestamp, timestamp, input.outboundReplyId
      );
      return this.require(current.id);
    });
  }

  private require(id: string): CardDismissal {
    const result = this.get(id);
    if (!result) throw new Error(`Missing Card Dismissal ${id}`);
    return result;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }
}

function dismissalId(input: ReserveValidatedCardDismissalInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.actionKind, input.semanticKey, input.gatewayId, input.messageId
  ])).digest("hex").slice(0, 32);
}

function mapDismissal(row: CardDismissalRow): CardDismissal {
  return {
    id: row.id,
    actionKind: row.action_kind,
    semanticKey: row.semantic_key,
    actorOpenId: row.actor_open_id,
    chatId: row.chat_id,
    gatewayId: row.gateway_id,
    messageId: row.message_id,
    outboundReplyId: row.outbound_reply_id,
    state: row.state,
    outcome: row.outcome,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at
  };
}

function now(): string { return new Date().toISOString(); }
