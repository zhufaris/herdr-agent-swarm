import type { OutboundDeliveryClaim } from "../../domain/delivery.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { DeliveryFailureMetadata, OutboundFailureTransition, OutboundReply } from "../../domain/types.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteBindingThreadAliasStore } from "./binding-thread-alias-store.js";
import type { SqliteCardContextStore } from "./card-context-store.js";
import type { SqliteInboundProjectStore } from "./inbound-project-store.js";
import type { SqliteOutboxStore } from "./outbox-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqlitePromptDispatchStore } from "./prompt-dispatch-store.js";
import type { SqliteWorkerTurnStore } from "./worker-turn-store.js";

export class SqliteOutboxCapabilityStore implements OutboxStore {
  constructor(
    private readonly outbox: SqliteOutboxStore,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly aliases: SqliteBindingThreadAliasStore,
    private readonly projections: SqliteProjectionStore,
    private readonly promptDispatch: SqlitePromptDispatchStore,
    private readonly inbound: SqliteInboundProjectStore,
    private readonly workerTurns: SqliteWorkerTurnStore,
    private readonly cardContexts: SqliteCardContextStore
  ) {}

  setGatewayPlanPreparer(preparer: Parameters<OutboxStore["setGatewayPlanPreparer"]>[0]): void { this.outbox.setGatewayPlanPreparer(preparer); }
  reservePreparedOutboundReply(input: Parameters<OutboxStore["reservePreparedOutboundReply"]>[0]): ReturnType<OutboxStore["reservePreparedOutboundReply"]> { return this.outbox.reservePreparedOutboundReply(input); }
  reserveSemanticOutboundReply(input: Parameters<OutboxStore["reserveSemanticOutboundReply"]>[0]): ReturnType<OutboxStore["reserveSemanticOutboundReply"]> { return this.outbox.reserveSemanticOutboundReply(input); }
  previewSemanticOutboundReply(input: Parameters<OutboxStore["previewSemanticOutboundReply"]>[0]): ReturnType<OutboxStore["previewSemanticOutboundReply"]> { return this.outbox.previewSemanticOutboundReply(input); }
  getReservedDeliveryIdentity(replyId: string): ReturnType<OutboxStore["getReservedDeliveryIdentity"]> { return this.outbox.getReservedDeliveryIdentity(replyId); }
  prepareOutboundGatewayPlan(id: string, input: { gatewayId: string; gatewayProfileId: string; gatewayPlanJson: string }): OutboundReply | null { return this.outbox.prepareOutboundGatewayPlan(id, input); }
  checkpointOutboundReplyCard(claim: OutboundDeliveryClaim, cardId: string): OutboundReply | null { return this.outbox.checkpointOutboundReplyCard(claim.reply.id, cardId, claim); }
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0]): OutboundReply { return this.outbox.enqueueOutboundReply(input); }
  getActiveAnswerPage(promptId: string): ReturnType<OutboxStore["getActiveAnswerPage"]> { return this.projections.getActiveAnswerPage(promptId); }
  getAnswerPage(promptId: string, pageIndex: number): ReturnType<OutboxStore["getAnswerPage"]> { return this.projections.getAnswerPage(promptId, pageIndex); }
  getAnswerTimelinePage(promptId: string, pageIndex: number): ReturnType<OutboxStore["getAnswerTimelinePage"]> { return this.projections.getAnswerTimelinePage(promptId, pageIndex); }
  getWorkerAnswerTimelinePage(turnId: string, pageIndex: number): ReturnType<OutboxStore["getWorkerAnswerTimelinePage"]> { return this.workerTurns.getWorkerAnswerTimelinePage(turnId, pageIndex); }
  getBinding(id: string): ReturnType<OutboxStore["getBinding"]> { return this.bindings.getBinding(id); }
  getOutboundReply(id: string): ReturnType<OutboxStore["getOutboundReply"]> { return this.outbox.getOutboundReply(id); }
  isActiveBindingThreadAlias(bindingId: string, rootMessageId: string): boolean { return this.aliases.isActiveBindingRoot(bindingId, rootMessageId); }
  getLarkDeliveryCooldown(): ReturnType<OutboxStore["getLarkDeliveryCooldown"]> { return this.outbox.getLarkDeliveryCooldown(); }
  getPrompt(id: string): ReturnType<OutboxStore["getPrompt"]> { return this.promptDispatch.getPrompt(id); }
  loadRunCard(promptId: string): ReturnType<OutboxStore["loadRunCard"]> { return this.projections.loadRunCard(promptId); }
  markOutboundReplyDelivered(claim: OutboundDeliveryClaim, messageId: string, cardId?: string, topicId?: string, messageDeleteOutcome?: "deleted" | "already_absent"): boolean { return this.outbox.markOutboundReplyDelivered(claim.reply.id, messageId, cardId, claim, topicId, messageDeleteOutcome); }
  markOutboundReplyFailedWithQuarantine(claim: OutboundDeliveryClaim, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number): OutboundFailureTransition | null { return this.outbox.markOutboundReplyFailedWithQuarantine(claim.reply.id, error, metadata, retryDelayMs, claim); }
  rejectUnclaimedOutboundReply(id: string, error: string, metadata: DeliveryFailureMetadata): OutboundFailureTransition | null { return this.outbox.markOutboundReplyFailedWithQuarantine(id, error, metadata); }
  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] { return this.outbox.recoverEligibleDeadLetters(cutoff, limit); }
  recordBridgeMessage(messageId: string): void { this.inbound.recordBridgeMessage(messageId); }
  dismissSupersededAnswerStream(replyId: string): boolean { return this.outbox.dismissSupersededAnswerStream(replyId); }
  loadWorkerTurnCard(turnId: string): ReturnType<OutboxStore["loadWorkerTurnCard"]> { return this.workerTurns.loadWorkerTurnCard(turnId); }
  loadWorkerMainView(workerId: string, workerSessionGeneration: number): ReturnType<OutboxStore["loadWorkerMainView"]> { return this.cardContexts.loadWorkerMainView(workerId, workerSessionGeneration); }
  listWorkerTurnCardPages(turnId: string): ReturnType<OutboxStore["listWorkerTurnCardPages"]> { return this.workerTurns.listWorkerTurnCardPages(turnId); }
  getWorkerThreadTarget(threadId: string): ReturnType<OutboxStore["getWorkerThreadTarget"]> { return this.outbox.getWorkerThreadTarget(threadId); }
}
