import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import type { LarkPort } from "../domain/ports/external.js";
import type { LifecycleEventPublisher, LifecycleEventSubscriber } from "../events/bridge-event-bus.js";
import { CardContextRebuilder } from "../events/card-context-rebuilder.js";
import { ConversationViewProjector } from "../events/conversation-view-projector.js";
import { LarkOutboxDispatcher } from "../events/lark-outbox-dispatcher.js";
import { OutboundIntentWriter } from "../events/outbound-intent-writer.js";
import { InProcessOutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { QueueFeedbackProjector } from "../events/queue-feedback-projector.js";
import { AnswerPageWorkflow } from "../coordinator/answer-page-workflow.js";
import { MainCardWorkflow } from "../coordinator/main-card-workflow.js";
import { cardKitPrimaryPresentation } from "../cards/cardkit-primary-presentation.js";
import { OutboxRetentionMaintainer } from "../runtime/outbox-retention-maintainer.js";
import type { SqliteBindingStore } from "../store/sqlite-store.js";

export function createOutboundRuntime(config: BridgeConfig, store: SqliteBindingStore, lark: LarkPort, bus: LifecycleEventPublisher & LifecycleEventSubscriber, logger: Logger) {
  const outboundWork = new InProcessOutboundWorkNotifier(logger);
  const outbound = new OutboundIntentWriter(store, outboundWork);
  const channelPublisher = new LarkOutboxDispatcher(store, lark, logger, outboundWork, config.runtimeTuning.outboxSafetyScanIntervalMs);
  const answerPages = new AnswerPageWorkflow(store, () => outboundWork.wake(), logger);
  const mainCards = new MainCardWorkflow(store, () => outboundWork.wake(), cardKitPrimaryPresentation, logger);
  const projector = new ConversationViewProjector(bus, store, outbound, channelPublisher, logger, cardKitPrimaryPresentation, answerPages, mainCards, { cardUpdateDebounceMs: config.runtimeTuning.cardUpdateDebounceMs });
  const queueFeedbackProjector = new QueueFeedbackProjector({ store, outboundWork, logger, presentation: cardKitPrimaryPresentation });
  const cardContextRebuilder = new CardContextRebuilder(store, () => outboundWork.wake(), logger, outboundWork);
  const outboxRetention = new OutboxRetentionMaintainer(store, { retentionDays: config.outboxRetention.days, batchSize: config.outboxRetention.batchSize, maxBatches: config.outboxRetention.maxBatches }, logger);
  return { outboundWork, outbound, channelPublisher, answerPages, mainCards, projector, queueFeedbackProjector, cardContextRebuilder, outboxRetention };
}
