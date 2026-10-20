import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import type { GatewaySession } from "../gateways/contract/plugin.js";
import type { LifecycleEventPublisher, LifecycleEventSubscriber } from "../events/bridge-event-bus.js";
import { CardContextRebuilder } from "../events/card-context-rebuilder.js";
import { ConversationViewProjector } from "../events/conversation-view-projector.js";
import { DeliveryCheckpointBus } from "../events/delivery-checkpoint-bus.js";
import { OutboundIntentWriter } from "../events/outbound-intent-writer.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { AnswerPageWorkflow } from "../coordinator/answer-page-workflow.js";
import { MainCardWorkflow } from "../coordinator/main-card-workflow.js";
import { PrimaryCardRedeliveryWorkflow } from "../coordinator/primary-card-redelivery.js";
import { WorkerTurnCardWorkflow } from "../coordinator/worker-turn-card-workflow.js";
import { TurnCardWorkflow } from "../coordinator/turn-card-workflow.js";
import type { ConversationSegmentStore } from "../domain/ports/conversation-segment.js";
import { feishuGatewayApplicationPresentation, feishuGatewayPrimaryPresentation } from "../gateways/feishu/presentation.js";
import { OutboxRetentionMaintainer } from "../runtime/outbox-retention-maintainer.js";
import type { ApplicationPresentation, PrimaryPresentation } from "../domain/ports/presentation.js";
import type { OutboundIntentStore, OutboxStore, PreparedDeliveryProducerConnector } from "../domain/ports/outbox.js";
import type { AnswerPageStore, MainCardStore, ProjectionStore } from "../domain/ports/projection.js";
import type { CardContextProjectionStore } from "../domain/ports/card-context.js";
import type { RetentionStore } from "../domain/ports/retention.js";
import type { WorkerTurnCardStore } from "../domain/ports/instance.js";
import { ProjectionDeliveryRecoveryWatchdog } from "../coordinator/projection-delivery-recovery-watchdog.js";
import type { PrimaryCardRedeliveryStore } from "../domain/ports/primary-card-redelivery.js";
import { prepareOutboundGatewayIntent, prepareSemanticOutboundGatewayPlan } from "../events/outbound-gateway-intent.js";
import { PreparedDeliveryPoisonError, type PreparedDelivery, type PreparedDeliveryAck } from "../domain/delivery.js";
import { PermanentDeliveryError } from "../events/outbound-target-validation.js";
import type { GatewayDeliveryPort } from "../gateways/contract/plugin.js";
import type { PreparedDeliveryConsumer } from "../domain/ports/outbox.js";
import type { PreparedDeliveryStore } from "../domain/ports/prepared-delivery.js";
import type { DeliveryEngineRefillPort } from "../domain/delivery-engine.js";
import type { SessionActivityStore } from "../domain/ports/session-activity.js";
import { RingDeliveryEngine } from "../events/ring-delivery-engine.js";
import { parseTurnCardLateRecoveryProjectionKey, parseTurnCardProjectionKey, parseTurnCardRecoveryProjectionKey } from "../domain/turn-card-projection-key.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { DeliveryLatencyTrace } from "../domain/delivery-trace.js";
import type { PreparedDeliveryProjectionRecoveryHint } from "../domain/ports/prepared-delivery.js";

export interface OutboundRuntimeStores {
  deliveryTrace: DeliveryLatencyTrace;
  outboundIntent: OutboundIntentStore; outbox: OutboxStore; answerPages: AnswerPageStore; mainCards: MainCardStore;
  primaryCardRedelivery: PrimaryCardRedeliveryStore; projection: ProjectionStore; cardContext: CardContextProjectionStore; retention: RetentionStore; workerTurns: WorkerTurnCardStore;
  conversationSegments: ConversationSegmentStore;
  sessionActivity: SessionActivityStore;
  preparedDeliveries: PreparedDeliveryStore & DeliveryEngineRefillPort;
  preparedDeliveryProducers: PreparedDeliveryProducerConnector;
}
export function connectPreparedDeliveryReservation(
  outbox: OutboxStore,
  conversationSegments: Pick<ConversationSegmentStore, "setPreparedDeliveryReservation">,
  gatewayDelivery: Pick<GatewayDeliveryPort, "prepare">,
  consumer: PreparedDeliveryConsumer
): void {
  outbox.setGatewayPlanPreparer((reply) => {
    try { return gatewayDelivery.prepare(prepareOutboundGatewayIntent(outbox, reply).intent); }
    catch (error) {
      if (error instanceof PermanentDeliveryError) throw new PreparedDeliveryPoisonError("Gateway plan preparation rejected deterministic delivery data", { cause: error });
      throw error;
    }
  });
  if (!conversationSegments.setPreparedDeliveryReservation) throw new Error("Conversation Segment prepared-delivery reservation is unavailable");
  conversationSegments.setPreparedDeliveryReservation(outbox, consumer);
}
export function connectPreparedDeliveryProducers(
  outbox: OutboxStore,
  producers: PreparedDeliveryProducerConnector,
  gatewayDelivery: Pick<GatewayDeliveryPort, "prepare">,
  consumer: PreparedDeliveryConsumer
): void {
  outbox.setGatewayPlanPreparer((reply) => {
    try { return gatewayDelivery.prepare(prepareOutboundGatewayIntent(outbox, reply).intent); }
    catch (error) {
      if (error instanceof PermanentDeliveryError) throw new PreparedDeliveryPoisonError("Gateway plan preparation rejected deterministic delivery data", { cause: error });
      throw error;
    }
  });
  producers.connectPreparedDeliveryProducers(outbox, consumer);
}

export function convergeAfterRingAcknowledgement(
  prepared: PreparedDelivery,
  ack: PreparedDeliveryAck,
  dependencies: {
    outbox: Pick<OutboxStore, "getOutboundReply" | "recordBridgeMessage">;
    checkpoints: DeliveryCheckpointBus;
  }
): void {
  const target = prepared.projectionKey ? parseTurnCardProjectionKey(prepared.projectionKey) : null;
  if (target) {
    dependencies.checkpoints.publishTurnCard(target.segmentId, target.pageIndex, prepared.replyId, ack.messageId, ack.surfaceId);
    return;
  }
  const reply = dependencies.outbox.getOutboundReply(prepared.replyId);
  if (!reply) return;
  if (reply.kind === "card_reply" || reply.kind === "stream_card_create" || reply.kind === "text") dependencies.outbox.recordBridgeMessage(ack.messageId);
  const recoverySegmentId = reply.projectionKey ? parseTurnCardRecoveryProjectionKey(reply.projectionKey) ?? parseTurnCardLateRecoveryProjectionKey(reply.projectionKey) : null;
  if (recoverySegmentId) dependencies.checkpoints.publishTurnCardRecovery(recoverySegmentId.segmentId);
  if (reply.promptId && (reply.kind === "stream_content" || reply.kind === "stream_finish" || reply.kind === "card_update" && reply.cardRole === "answer")) dependencies.checkpoints.publishAnswer(reply.promptId, reply.viewVersion ?? 0);
  if (reply.promptId && reply.kind === "stream_card_create") dependencies.checkpoints.publishAnswer(reply.promptId, (reply.viewVersion ?? 0) + 1);
  if (reply.workerTurnId && (reply.kind === "stream_content" || reply.kind === "stream_finish" || reply.kind === "card_update")) dependencies.checkpoints.publishWorkerTurn(reply.workerTurnId, reply.viewVersion ?? 0);
  if (reply.workerTurnId && reply.kind === "stream_card_create") dependencies.checkpoints.publishWorkerTurn(reply.workerTurnId, (reply.viewVersion ?? 0) + 1);
  if (reply.workerId && reply.workerSessionGeneration !== null && reply.kind !== "group_card_create") dependencies.checkpoints.publishWorkerMain(reply.workerId, reply.workerSessionGeneration, reply.viewVersion ?? 0);
  if (reply.workerThreadId && reply.workerId && reply.workerSessionGeneration !== null && reply.kind === "group_card_create" && reply.viewVersion !== null) dependencies.checkpoints.publishWorkerMain(reply.workerId, reply.workerSessionGeneration, reply.viewVersion);
  if (reply.bindingId && reply.targetRole === "session_status") dependencies.checkpoints.publishMainCard(reply.bindingId, reply.viewVersion ?? 0);
}

export function createOutboundRuntime(config: BridgeConfig, stores: OutboundRuntimeStores, gateway: GatewaySession, bus: LifecycleEventPublisher & LifecycleEventSubscriber, outboundWork: OutboundWorkNotifier, logger: Logger, presentation: { primary: PrimaryPresentation; application: ApplicationPresentation } = { primary: feishuGatewayPrimaryPresentation, application: feishuGatewayApplicationPresentation }) {
  const checkpoints = new DeliveryCheckpointBus(logger);
  const answerPages = new AnswerPageWorkflow(stores.answerPages, () => outboundWork.wake(), presentation.application, logger, { pageLimit: config.runtimeTuning.cards.answerPageLimitChars, answerStreamContent: presentation.primary.answerStreamContent, renderAnswerStreamPage: presentation.primary.answerStreamPage });
  const mainCards = new MainCardWorkflow(stores.mainCards, () => outboundWork.wake(), presentation.primary, logger);
  const primaryCardRedelivery = new PrimaryCardRedeliveryWorkflow({
    store: stores.primaryCardRedelivery, mainCards: stores.mainCards, answerPages: stores.answerPages,
    presentation: presentation.primary, wakeOutbound: () => outboundWork.wake(),
    answerPageLimit: config.runtimeTuning.cards.answerPageLimitChars
  });
  const workerTurnCards = new WorkerTurnCardWorkflow(stores.workerTurns, () => outboundWork.wake(), presentation.application, config.runtimeTuning.cards.answerPageLimitChars, logger);
  const turnCards = new TurnCardWorkflow(stores.conversationSegments, () => outboundWork.wake(), presentation.application, config.runtimeTuning.cards.payloadLimitChars, logger, stores.sessionActivity, presentation.application.turnCardSemanticPolicy, gateway.profile.rendererRevision, false);
  let dispatchProjectionRecovery = (_hints: readonly PreparedDeliveryProjectionRecoveryHint[]): Promise<void> => Promise.resolve();
  const ringDeliveryEngine = new RingDeliveryEngine({
    store: stores.preparedDeliveries, refill: stores.preparedDeliveries, gateway: gateway.delivery, coldRecoveryEnabled: true,
    deliveryTrace: stores.deliveryTrace,
    prepareSemanticDelivery: (work, port) => prepareSemanticOutboundGatewayPlan(work, port, {
      policy: presentation.application.turnCardSemanticPolicy,
      gatewayProfileVersion: gateway.profile.rendererRevision
    }),
    safetyScanIntervalMs: config.runtimeTuning.outboxSafetyScanIntervalMs,
    onProjectionRecoveryHints: (hints) => dispatchProjectionRecovery(hints),
    subscribeWork: (listener) => outboundWork.subscribe(listener),
    onAcknowledged: (prepared, ack) => {
      try { convergeAfterRingAcknowledgement(prepared, ack, { outbox: stores.outbox, checkpoints }); }
      catch (error) { logger.error({ event: "ring-checkpoint-fanout-failed", replyId: prepared.replyId, err: safeLogError(error), outcome: "isolated" }, "post-delivery checkpoint fanout failed; durable acknowledgement remains authoritative"); }
    },
    onFailed: (prepared) => {
      const reply = stores.outbox.getOutboundReply(prepared.replyId);
      if (reply?.promptId) checkpoints.publishAnswer(reply.promptId, reply.viewVersion ?? 0);
      if (reply?.workerTurnId) checkpoints.publishWorkerTurn(reply.workerTurnId, reply.viewVersion ?? 0);
    }
  });
  const deliveryConsumer: PreparedDeliveryConsumer = {
    enqueuePreparedDelivery: (delivery) => {
      ringDeliveryEngine.enqueue(delivery);
      outboundWork.wake({ kind: "scope", scope: delivery.scope });
    }
  };
  const outbound = new OutboundIntentWriter(stores.outboundIntent, outboundWork, deliveryConsumer);
  connectPreparedDeliveryProducers(stores.outbox, stores.preparedDeliveryProducers, gateway.delivery, deliveryConsumer);
  stores.preparedDeliveries.setQuarantineReviewRenderer(presentation.application.deliveryQuarantineReview);
  const projector = new ConversationViewProjector(bus, stores.projection, outbound, checkpoints, logger, presentation.primary, answerPages, mainCards, {
    cardUpdateDebounceMs: config.runtimeTuning.cards.updateDebounceMs,
    mainCardUpdateDebounceMs: config.runtimeTuning.cards.updateDebounceMs,
    turnCards,
    sessionActivity: stores.sessionActivity
  });
  stores.conversationSegments.setInitialTurnCardRenderer?.((view, page) => presentation.application.turnCard(view, page, {
    sessionState: stores.sessionActivity.loadTurnSessionStateForCurrentSegment(view.segmentId)
  }));
  stores.conversationSegments.setProjectionNotifier?.((notification) => projector.scheduleTurnCard(notification));
  stores.sessionActivity.setCardRenderers?.({
    main: (view, sessionActivity) => presentation.primary.mainCard(view, { sessionActivity }),
    pane: (view, sessionActivity) => presentation.primary.paneEntryCard(view, { sessionActivity })
  });
  const projectionDeliveryRecoveryWatchdog = new ProjectionDeliveryRecoveryWatchdog({
    store: {
      listRecoverablePrimaryAnswerPromptIds: (limit) => stores.answerPages.listRecoverablePrimaryAnswerPromptIds(limit),
      listRecoverableWorkerTurnIds: (limit) => stores.workerTurns.listRecoverableWorkerTurnIds(limit),
      listRecoverableConversationSegmentIds: (limit) => stores.conversationSegments.listActionableConversationSegmentIds(limit)
    },
    answerPages,
    workerTurns: workerTurnCards,
    turnCards,
    logger
  });
  checkpoints.onWorkerTurnCheckpoint((turnId) => {
    void workerTurnCards.converge(turnId);
  });
  checkpoints.onTurnCardCheckpoint?.((segmentId, pageIndex, replyId, messageId, cardId) => {
    const viewVersion = stores.conversationSegments.getConversationSegment(segmentId)?.viewVersion ?? 0;
    projector.scheduleTurnCard({ segmentId, viewVersion, urgency: "immediate" });
  });
  checkpoints.onTurnCardRecoveryCheckpoint?.((segmentId) => {
    const viewVersion = stores.conversationSegments.getConversationSegment(segmentId)?.viewVersion ?? 0;
    projector.scheduleTurnCard({ segmentId, viewVersion, urgency: "immediate" });
  });
  const cardContextRebuilder = new CardContextRebuilder(stores.cardContext, () => outboundWork.wake(), logger, presentation.application, outboundWork);
  dispatchProjectionRecovery = async (hints) => {
    for (const hint of hints) {
      if (hint.kind === "card-context") await cardContextRebuilder.requestProjectionRecovery(hint);
      else await projectionDeliveryRecoveryWatchdog.requestRecoveryHint(hint);
    }
  };
  const outboxRetention = new OutboxRetentionMaintainer(stores.retention, {
    retentionDays: config.outboxRetention.days, batchSize: config.outboxRetention.batchSize,
    maxBatches: config.outboxRetention.maxBatches, timeBudgetMs: config.outboxRetention.timeBudgetMs,
    payloadCompactionEnabled: config.outboxRetention.payloadCompactionEnabled,
    coreEventMode: config.outboxRetention.coreEventMode,
    coreEventRetentionMs: config.outboxRetention.coreEventRetentionHours * 60 * 60 * 1_000
  }, logger);
  return { outboundWork, outbound, checkpoints, ringDeliveryEngine, answerPages, turnCards, projectionDeliveryRecoveryWatchdog, workerTurnCards, mainCards, primaryCardRedelivery, projector, cardContextRebuilder, outboxRetention };
}
