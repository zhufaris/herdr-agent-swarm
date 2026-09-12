import type { SqliteContext } from "./context.js";
import { createLatestSchema } from "./schema.js";
import { BindingSessionMigrations } from "./migrations/binding-session-migrations.js";
import { CardOutboxMigrations } from "./migrations/card-outbox-migrations.js";
import { PromptTurnMigrations } from "./migrations/prompt-turn-migrations.js";
import { RetiredSchemaMigrations } from "./migrations/retired-schema-migrations.js";
import { WorkerMigrations } from "./migrations/worker-migrations.js";

export class SqliteMigrations {
  private readonly binding: BindingSessionMigrations;
  private readonly prompt: PromptTurnMigrations;
  private readonly cards: CardOutboxMigrations;
  private readonly worker: WorkerMigrations;
  private readonly retired: RetiredSchemaMigrations;

  constructor(private readonly context: SqliteContext) {
    this.binding = new BindingSessionMigrations(context);
    this.prompt = new PromptTurnMigrations(context);
    this.cards = new CardOutboxMigrations(context);
    this.worker = new WorkerMigrations(context);
    this.retired = new RetiredSchemaMigrations(context);
  }

  run(): void {
    const runCardViewNeedsRebuild = this.cards.runCardViewNeedsRebuild();
    if (runCardViewNeedsRebuild) this.context.database.exec("DROP VIEW IF EXISTS run_cards_view");
    createLatestSchema(this.context);
    this.cards.ensureOutboundReplyColumns();
    this.cards.ensureMainCardSequences();
    this.worker.ensureAgentInstanceLifecycleColumns();
    this.binding.ensureInboundMessageIdempotency();
    this.cards.ensureOutboundCardCheckpoint();
    this.cards.ensureRequestCardOutboxColumns();
    this.cards.ensureOutboundTargetRole();
    this.cards.ensureRunCardQueueFeedbackColumn();
    this.cards.ensureRunCardRequestText();
    this.cards.ensureRunCardSpaceName();
    this.cards.ensureRunCardSessionTitle();
    this.cards.ensureDualRequestCardColumns();
    this.cards.ensureRunCardAnswerState();
    this.cards.ensureRunCardProgressSummary();
    this.cards.ensureRunCardInteractionColumns();
    this.cards.ensureStreamingCardColumns();
    this.cards.ensureAnswerPageDeliveryMode();
    this.cards.ensureAnswerPages();
    this.binding.ensureProjectSelectionColumns();
    this.binding.ensureBindingLifecycleColumns();
    this.binding.ensureBindingPrimaryToolCapabilities();
    this.binding.ensureBindingCreatorColumn();
    this.binding.ensureSessionOperations();
    this.binding.ensureAgentSessionColumns();
    this.retired.removeReportedTraexSessionColumns();
    this.binding.ensureBindingResetColumns();
    this.binding.ensureTwoPhaseResetState();
    this.prompt.ensurePromptCancelledState();
    this.prompt.ensurePromptObservationColumn();
    this.prompt.ensurePromptProvenanceColumns();
    this.prompt.ensurePromptTranscriptProvenanceColumns();
    this.prompt.ensureTurnPriorityColumns();
    this.prompt.ensureModelPreferenceSchema();
    this.prompt.ensurePromptExecutionOriginColumn();
    this.cards.ensureRunCardActivityColumn();
    this.retired.convergeRetiredPromptSteering();
    this.prompt.ensurePrimaryContinuationLineage();
    this.cards.ensureOutboundDeliveryOrder();
    this.cards.ensureOutboundDismissedState();
    this.cards.ensureOutboundDeliveryOrder();
    this.worker.ensureWorkerTurnCards();
    this.worker.ensureWorkerTurnCardPageStates();
    this.worker.ensureWorkerTurnCardProgress();
    this.worker.ensureWorkerTurnProgressSequence();
    this.worker.ensureWorkerSourcePrimaryPaneLabel();
    this.worker.ensureWorkerParentIdentity();
    this.worker.ensurePrimaryScopedWorkerNames();
    this.worker.ensureCardContextProjectionTables();
    this.worker.ensureActiveWorkerScopedNames();
    this.worker.ensureWorkerTurnContextReferences();
    this.worker.ensureInstanceTurnActorProvenance();
    this.worker.ensureWorkerOutboxStreamMetadata();
    this.worker.ensureWorkerMainOutboxIdentity();
    this.worker.ensurePrimaryCardContextColumns();
    this.worker.ensureCardContextStartupInvalidations();
    this.worker.ensureWorkerPaneCloseSteps();
    this.cards.ensureOutboundLaneKey();
    this.cards.ensureOutboxLaneQuarantines();
    this.cards.ensureOutboxLaneHeads();
    this.cards.ensureIndependentReplyLanes();
    this.cards.ensureCardContextOutboxLanes();
    this.cards.ensureOutboundFailureMetadata();
    this.cards.ensureTypedDeliveryIntents();
    this.prompt.ensurePaneCloseOperationState();
    this.prompt.ensurePaneControlOperationState();
    this.prompt.ensureTurnControlOperations();
    this.prompt.ensureSwarmCommandIntents();
    this.worker.ensureWorkerCardDisplayRequests();
    this.worker.ensureWorkerSessionThreads();
    if (runCardViewNeedsRebuild) this.cards.recreateRunCardsView();
    this.cards.ensureQueryIndexes();
    const answerTargetMigration = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 2").get();
    if (!answerTargetMigration) {
      this.context.database.exec("BEGIN IMMEDIATE");
      try {
        this.cards.canonicalizeLegacyAnswerTargets(now());
        this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (2)").run();
        this.context.database.exec("COMMIT");
      } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
    }
    const answerFinishMigration = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get();
    if (!answerFinishMigration) {
      this.context.database.exec("BEGIN IMMEDIATE");
      try {
        this.cards.finishLegacyDeliveredAnswerPages(now());
        this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (3)").run();
        this.context.database.exec("COMMIT");
      } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
    }
    const answerDeadLetterMigration = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get();
    if (!answerDeadLetterMigration) {
      this.context.database.exec("BEGIN IMMEDIATE");
      try {
        this.cards.dismissStreamsForFinishedAnswerPages(now());
        this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (4)").run();
        this.context.database.exec("COMMIT");
      } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
    }
    this.cards.ensureOutboundWorkClass();
    this.cards.ensureOutboundClaims();
    this.cards.ensureDeliveryRecoveries();
    this.cards.ensureAnswerRecoveryEvidence();
    this.cards.ensureGroupCardCreates();
    this.cards.ensureWorkerThreadTargets();
  }

  canonicalizeLegacyAnswerTargets(timestamp: string): void {
    this.cards.canonicalizeLegacyAnswerTargets(timestamp);
  }
}

function now(): string { return new Date().toISOString(); }
