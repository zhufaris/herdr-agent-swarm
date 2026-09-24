import type { Logger } from "pino";
import { AnswerPageWorkflow } from "../../src/coordinator/answer-page-workflow.js";
import { MainCardWorkflow } from "../../src/coordinator/main-card-workflow.js";
import type { AnswerPageConvergencePort, MainCardConvergencePort } from "../../src/domain/ports/card-convergence.js";
import type { OutboundCheckpointSubscriber, OutboundIntentPort } from "../../src/domain/ports/outbox.js";
import type { PrimaryPresentation } from "../../src/domain/ports/presentation.js";
import type { AnswerPageStore, MainCardStore, ProjectionStore } from "../../src/domain/ports/projection.js";
import type { LifecycleEventSubscriber } from "../../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../../src/events/conversation-view-projector.js";

type TestProjectionStore = ProjectionStore & AnswerPageStore & MainCardStore;
type TestPresentation = Pick<PrimaryPresentation, "mainCard" | "paneEntryCard" | "answerCard" | "finalAnswer" | "answerStreamContent" | "answerStreamPage" | "finalAnswerPage">;

export class TestConversationViewProjector extends ConversationViewProjector {
  constructor(
    bus: LifecycleEventSubscriber,
    store: TestProjectionStore,
    channelPublisher: OutboundIntentPort,
    checkpoints: OutboundCheckpointSubscriber,
    logger: Logger,
    presentation: TestPresentation,
    answerPages: AnswerPageConvergencePort = new AnswerPageWorkflow(store, () => { void checkpoints.requestScan(); }, presentation, logger),
    mainCards: MainCardConvergencePort = new MainCardWorkflow(store, () => { void checkpoints.requestScan(); }, presentation, logger),
    options: { cardUpdateDebounceMs?: number; mainCardUpdateDebounceMs?: number } = {}
  ) {
    super(bus, store, channelPublisher, checkpoints, logger, presentation, answerPages, mainCards, options);
  }
}
