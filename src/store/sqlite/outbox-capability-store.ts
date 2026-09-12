import type { OutboundDeliveryClaim } from "../../domain/delivery.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { DeliveryFailureMetadata, OutboundFailureTransition, OutboundReply } from "../../domain/types.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteBindingThreadAliasStore } from "./binding-thread-alias-store.js";
import type { SqliteCardContextStore } from "./card-context-store.js";
import type { SqliteInboundProjectStore } from "./inbound-project-store.js";
import type { SqliteOutboxStore } from "./outbox-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqlitePromptStore } from "./prompt-store.js";
import type { SqliteWorkerTurnStore } from "./worker-turn-store.js";

export class SqliteOutboxCapabilityStore implements OutboxStore {
  constructor(
    private readonly outbox: SqliteOutboxStore,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly aliases: SqliteBindingThreadAliasStore,
    private readonly projections: SqliteProjectionStore,
    private readonly prompts: SqlitePromptStore,
    private readonly inbound: SqliteInboundProjectStore,
    private readonly workerTurns: SqliteWorkerTurnStore,
    private readonly cardContexts: SqliteCardContextStore
  ) {}

  prepareOutboundGatewayPlan(id: string, input: { gatewayId: string; gatewayProfileId: string; gatewayPlanJson: string }): OutboundReply | null { return this.outbox.prepareOutboundGatewayPlan(id, input); }
  claimOutboundReply(id: string, dueAt: string | null): OutboundDeliveryClaim | null { return this.outbox.claimOutboundReply(id, dueAt); }
  checkpointOutboundReplyCard(claim: OutboundDeliveryClaim, cardId: string): OutboundReply | null { return this.outbox.checkpointOutboundReplyCard(claim.reply.id, cardId, claim); }
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0]): OutboundReply { return this.outbox.enqueueOutboundReply(input); }
  getActiveAnswerPage(promptId: string): ReturnType<OutboxStore["getActiveAnswerPage"]> { return this.projections.getActiveAnswerPage(promptId); }
  getBinding(id: string): ReturnType<OutboxStore["getBinding"]> { return this.bindings.getBinding(id); }
  isActiveBindingThreadAlias(bindingId: string, rootMessageId: string): boolean { return this.aliases.isActiveBindingRoot(bindingId, rootMessageId); }
  getNextOutboundLaneHeadAttemptAt(): string | null { return this.outbox.getNextOutboundLaneHeadAttemptAt(); }
  getLarkDeliveryCooldown(): ReturnType<OutboxStore["getLarkDeliveryCooldown"]> { return this.outbox.getLarkDeliveryCooldown(); }
  getPrompt(id: string): ReturnType<OutboxStore["getPrompt"]> { return this.prompts.getPrompt(id); }
  listOutboundLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys?: readonly string[], workClass?: import("../../domain/types.js").OutboundWorkClass): OutboundReply[] { return this.outbox.listOutboundLaneHeads(limit, dueAt, excludedLaneKeys, workClass); }
  loadRunCard(promptId: string): ReturnType<OutboxStore["loadRunCard"]> { return this.projections.loadRunCard(promptId); }
  markOutboundReplyDelivered(claim: OutboundDeliveryClaim, messageId: string, cardId?: string, topicId?: string): boolean { return this.outbox.markOutboundReplyDelivered(claim.reply.id, messageId, cardId, claim, topicId); }
  markOutboundReplyFailedWithQuarantine(claim: OutboundDeliveryClaim, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number): OutboundFailureTransition | null { return this.outbox.markOutboundReplyFailedWithQuarantine(claim.reply.id, error, metadata, retryDelayMs, claim); }
  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] { return this.outbox.recoverEligibleDeadLetters(cutoff, limit); }
  recordBridgeMessage(messageId: string): void { this.inbound.recordBridgeMessage(messageId); }
  dismissSupersededAnswerStream(replyId: string): boolean { return this.outbox.dismissSupersededAnswerStream(replyId); }
  loadWorkerTurnCard(turnId: string): ReturnType<OutboxStore["loadWorkerTurnCard"]> { return this.workerTurns.loadWorkerTurnCard(turnId); }
  loadWorkerMainView(workerId: string, workerSessionGeneration: number): ReturnType<OutboxStore["loadWorkerMainView"]> { return this.cardContexts.loadWorkerMainView(workerId, workerSessionGeneration); }
  listWorkerTurnCardPages(turnId: string): ReturnType<OutboxStore["listWorkerTurnCardPages"]> { return this.workerTurns.listWorkerTurnCardPages(turnId); }
}
