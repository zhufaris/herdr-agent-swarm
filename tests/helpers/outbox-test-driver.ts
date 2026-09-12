import type { OutboundDeliveryClaim } from "../../src/domain/delivery.js";
import type { DeliveryFailureMetadata } from "../../src/domain/types.js";
import type { SqliteOutboxStore } from "../../src/store/sqlite/outbox-store.js";

export function createOutboxTestDriver(outbox: SqliteOutboxStore) {
  return {
    prepareOutboundGatewayPlan: (id: string, input: { gatewayId: string; gatewayProfileId: string; gatewayPlanJson: string }) => outbox.prepareOutboundGatewayPlan(id, input),
    claimOutboundReply: (id: string, dueAt: string | null) => outbox.claimOutboundReply(id, dueAt),
    markOutboundReplyDelivered(target: string | OutboundDeliveryClaim, messageId: string, cardId?: string, topicId?: string) {
      return typeof target === "string" ? outbox.markOutboundReplyDelivered(target, messageId, cardId, undefined, topicId) : outbox.markOutboundReplyDelivered(target.reply.id, messageId, cardId, target, topicId);
    },
    checkpointOutboundReplyCard(target: string | OutboundDeliveryClaim, cardId: string) {
      return typeof target === "string" ? outbox.checkpointOutboundReplyCard(target, cardId) : outbox.checkpointOutboundReplyCard(target.reply.id, cardId, target);
    },
    markOutboundReplyFailedWithQuarantine(target: string | OutboundDeliveryClaim, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number) {
      return typeof target === "string" ? outbox.markOutboundReplyFailedWithQuarantine(target, error, metadata, retryDelayMs) : outbox.markOutboundReplyFailedWithQuarantine(target.reply.id, error, metadata, retryDelayMs, target);
    }
  };
}

export type OutboxTestDriver = ReturnType<typeof createOutboxTestDriver>;
