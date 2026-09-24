import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import type { GatewaySession } from "../gateways/contract/plugin.js";
import type { LifecycleEventPublisher, LifecycleEventSubscriber } from "../events/bridge-event-bus.js";
import { CardContextRebuilder } from "../events/card-context-rebuilder.js";
import { ConversationViewProjector } from "../events/conversation-view-projector.js";
import { GatewayOutboxDispatcher } from "../events/gateway-outbox-dispatcher.js";
import { OutboundIntentWriter } from "../events/outbound-intent-writer.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { QueueFeedbackProjector } from "../events/queue-feedback-projector.js";
import { AnswerPageWorkflow } from "../coordinator/answer-page-workflow.js";
import { MainCardWorkflow } from "../coordinator/main-card-workflow.js";
import { feishuGatewayApplicationPresentation, feishuGatewayPrimaryPresentation } from "../gateways/feishu/presentation.js";
import { OutboxRetentionMaintainer } from "../runtime/outbox-retention-maintainer.js";
import type { ApplicationPresentation, PrimaryPresentation } from "../domain/ports/presentation.js";
import type { OutboundIntentStore, OutboxStore } from "../domain/ports/outbox.js";
import type { AnswerPageStore, MainCardStore, ProjectionStore, QueueFeedbackStore } from "../domain/ports/projection.js";
import type { CardContextProjectionStore } from "../domain/ports/card-context.js";
import type { RetentionStore } from "../domain/ports/retention.js";

export interface OutboundRuntimeStores {
  outboundIntent: OutboundIntentStore; outbox: OutboxStore; answerPages: AnswerPageStore; mainCards: MainCardStore;
  projection: ProjectionStore; queueFeedback: QueueFeedbackStore; cardContext: CardContextProjectionStore; retention: RetentionStore;
}

export function createOutboundRuntime(config: BridgeConfig, stores: OutboundRuntimeStores, gateway: GatewaySession, bus: LifecycleEventPublisher & LifecycleEventSubscriber, outboundWork: OutboundWorkNotifier, logger: Logger, presentation: { primary: PrimaryPresentation; application: ApplicationPresentation } = { primary: feishuGatewayPrimaryPresentation, application: feishuGatewayApplicationPresentation }) {
  const outbound = new OutboundIntentWriter(stores.outboundIntent, outboundWork);
  const channelPublisher = new GatewayOutboxDispatcher(stores.outbox, gateway.delivery, logger, outboundWork, config.runtimeTuning.outboxSafetyScanIntervalMs);
  const answerPages = new AnswerPageWorkflow(stores.answerPages, () => outboundWork.wake(), presentation.primary, logger, { pageLimit: config.runtimeTuning.cards.answerPageLimitChars, answerStreamContent: presentation.primary.answerStreamContent, renderAnswerStreamPage: presentation.primary.answerStreamPage });
  const mainCards = new MainCardWorkflow(stores.mainCards, () => outboundWork.wake(), presentation.primary, logger);
  const projector = new ConversationViewProjector(bus, stores.projection, outbound, channelPublisher, logger, presentation.primary, answerPages, mainCards, { cardUpdateDebounceMs: config.runtimeTuning.cards.updateDebounceMs });
  const queueFeedbackProjector = new QueueFeedbackProjector({ store: stores.queueFeedback, outboundWork, logger, presentation: presentation.primary });
  const cardContextRebuilder = new CardContextRebuilder(stores.cardContext, () => outboundWork.wake(), logger, presentation.application, outboundWork);
  const outboxRetention = new OutboxRetentionMaintainer(stores.retention, { retentionDays: config.outboxRetention.days, batchSize: config.outboxRetention.batchSize, maxBatches: config.outboxRetention.maxBatches }, logger);
  return { outboundWork, outbound, channelPublisher, answerPages, mainCards, projector, queueFeedbackProjector, cardContextRebuilder, outboxRetention };
}
