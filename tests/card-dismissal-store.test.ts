import { describe, expect, it } from "vitest";
import type { DeliveryFailureMetadata } from "../src/domain/types.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

describe("Card dismissal store", () => {
  it("atomically reserves one auditable message delete for duplicate validated dismissals", () => {
    const stores = createTestStoreBundle();
    try {
      const input = {
        actionKind: "human_review_ignore",
        semanticKey: "human-review:episode-1",
        actorOpenId: "operator-1",
        chatId: "chat-1",
        gatewayId: "feishu:primary",
        messageId: "card-message-1"
      };

      const first = stores.cardDismissals.reserveValidated(input);
      const duplicate = stores.cardDismissals.reserveValidated(input);

      expect(duplicate).toEqual(first);
      expect(first).toMatchObject({
        actionKind: "human_review_ignore",
        semanticKey: "human-review:episode-1",
        state: "deleting",
        outcome: null,
        outboundReplyId: expect.stringMatching(/^card-dismissal:[a-f0-9]{32}$/)
      });
      expect(stores.driver.database.prepare("SELECT action_kind, semantic_key, actor_open_id, chat_id, gateway_id, message_id, outbound_reply_id, state FROM card_dismissals").all()).toEqual([{
        action_kind: "human_review_ignore",
        semantic_key: "human-review:episode-1",
        actor_open_id: "operator-1",
        chat_id: "chat-1",
        gateway_id: "feishu:primary",
        message_id: "card-message-1",
        outbound_reply_id: first.outboundReplyId,
        state: "deleting"
      }]);
      expect(stores.driver.database.prepare("SELECT version FROM schema_migrations WHERE version=111").get()).toEqual({ version: 111 });
      expect(stores.outbox.getOutboundReply(first.outboundReplyId)).toMatchObject({
        id: first.outboundReplyId,
        idempotencyKey: first.outboundReplyId,
        gatewayId: "feishu:primary",
        rootMessageId: "card-message-1",
        kind: "message_delete",
        state: "pending"
      });
    } finally {
      stores.lifecycle.close();
    }
  });

  it("settles a delivered delete through the outbox acknowledgement hook", () => {
    const stores = createTestStoreBundle();
    try {
      const dismissal = stores.cardDismissals.reserveValidated({
        actionKind: "primary_completion_ignore",
        semanticKey: "completion:primary-1",
        actorOpenId: "operator-1",
        chatId: "chat-1",
        gatewayId: "feishu:primary",
        messageId: "card-message-2"
      });
      const claim = stores.driver.claimOutboundReply(dismissal.outboundReplyId, null);
      expect(claim).not.toBeNull();
      expect(stores.driver.markOutboundReplyDelivered(claim!, "card-message-2", undefined, undefined)).toBe(true);

      expect(stores.cardDismissals.get(dismissal.id)).toMatchObject({
        state: "deleted",
        outcome: "deleted",
        settledAt: expect.any(String)
      });
    } finally {
      stores.lifecycle.close();
    }
  });

  it("records an already-absent acknowledgement once and rejects late contradictory settlement", () => {
    const stores = createTestStoreBundle();
    try {
      const dismissal = stores.cardDismissals.reserveValidated({
        actionKind: "worker_completion_ignore",
        semanticKey: "completion:worker-1",
        actorOpenId: "operator-1",
        chatId: "chat-1",
        gatewayId: "feishu:primary",
        messageId: "card-message-3"
      });

      expect(stores.cardDismissals.settle({ outboundReplyId: dismissal.outboundReplyId, outcome: "already_absent" })).toMatchObject({
        state: "already_absent",
        outcome: "already_absent"
      });
      expect(stores.cardDismissals.settle({ outboundReplyId: dismissal.outboundReplyId, outcome: "failed", detail: "late contradiction" })).toMatchObject({
        state: "already_absent",
        outcome: "already_absent",
        detail: null
      });
    } finally {
      stores.lifecycle.close();
    }
  });

  it("preserves terminal delete failure for recovery without claiming visible withdrawal", () => {
    const stores = createTestStoreBundle();
    try {
      const dismissal = stores.cardDismissals.reserveValidated({
        actionKind: "dead_letter_dismiss",
        semanticKey: "dead-letter:reply-1",
        actorOpenId: "operator-1",
        chatId: "chat-1",
        gatewayId: "feishu:primary",
        messageId: "card-message-4"
      });
      const metadata: DeliveryFailureMetadata = {
        failureClass: "permanent",
        effectCertainty: "uncertain",
        httpStatus: 500,
        larkErrorCode: null
      };

      expect(stores.driver.rejectUnclaimedOutboundReply(dismissal.outboundReplyId, "delete outcome unknown", metadata)?.reply.state).toBe("dead_letter");
      expect(stores.cardDismissals.get(dismissal.id)).toMatchObject({
        state: "failed",
        outcome: "failed",
        detail: "delete outcome unknown",
        settledAt: expect.any(String)
      });
      expect(stores.outbox.getOutboundReply(dismissal.outboundReplyId)).toMatchObject({
        state: "dead_letter",
        effectCertainty: "uncertain"
      });
    } finally {
      stores.lifecycle.close();
    }
  });
});
