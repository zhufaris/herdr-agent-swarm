import type { SqliteContext } from "./context.js";
import { createLatestSchema } from "./schema.js";
import { BindingSessionMigrations } from "./migrations/binding-session-migrations.js";
import { CardOutboxMigrations } from "./migrations/card-outbox-migrations.js";
import { PromptTurnMigrations } from "./migrations/prompt-turn-migrations.js";
import { RetiredSchemaMigrations } from "./migrations/retired-schema-migrations.js";
import { WorkerMigrations } from "./migrations/worker-migrations.js";
import { GatewayMigrations } from "./migrations/gateway-migrations.js";

export class SqliteMigrations {
  private readonly binding: BindingSessionMigrations;
  private readonly prompt: PromptTurnMigrations;
  private readonly cards: CardOutboxMigrations;
  private readonly worker: WorkerMigrations;
  private readonly retired: RetiredSchemaMigrations;
  private readonly gateway: GatewayMigrations;

  constructor(private readonly context: SqliteContext) {
    this.binding = new BindingSessionMigrations(context);
    this.prompt = new PromptTurnMigrations(context);
    this.cards = new CardOutboxMigrations(context);
    this.worker = new WorkerMigrations(context);
    this.retired = new RetiredSchemaMigrations(context);
    this.gateway = new GatewayMigrations(context);
  }

  run(): void {
    const runCardViewNeedsRebuild = this.prepareRunCardView();
    createLatestSchema(this.context);
    this.applyInitialCompatibility();
    this.applyBindingAndPromptCompatibility();
    this.applyWorkerAndProjectionCompatibility();
    this.applyDeliveryAndControlCompatibility();
    this.restoreRunCardViewAndIndexes(runCardViewNeedsRebuild);
    this.runHistoricalAnswerConvergence();
    this.applyFinalDeliveryAndGatewayCompatibility();
    this.ensureAnswerTimelines();
    this.ensureAnswerTimelinePageCheckpoints();
  }

  private prepareRunCardView(): boolean {
    const runCardViewNeedsRebuild = this.cards.runCardViewNeedsRebuild();
    if (runCardViewNeedsRebuild) this.context.database.exec("DROP VIEW IF EXISTS run_cards_view");
    return runCardViewNeedsRebuild;
  }

  private applyInitialCompatibility(): void {
    this.cards.ensureOutboundReplyColumns();
    this.cards.ensureMainCardSequences();
    this.worker.ensureAgentInstanceLifecycleColumns();
    this.binding.ensureInboundMessageIdempotency();
    this.binding.ensureInboundMessageScopes();
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
  }

  private applyBindingAndPromptCompatibility(): void {
    this.binding.ensureProjectSelectionColumns();
    this.binding.ensurePrimaryAgentKindColumns();
    this.binding.ensureBindingLifecycleColumns();
    this.binding.ensureBindingPrimaryToolCapabilities();
    this.binding.ensureBindingCreatorColumn();
    this.binding.ensureSessionOperations();
    this.binding.ensureAgentSessionColumns();
    this.retired.removeReportedTraexSessionColumns();
    this.binding.ensureBindingResetColumns();
    this.binding.ensureTwoPhaseResetState();
    this.binding.ensureSessionQueryIndex();
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
  }

  private applyWorkerAndProjectionCompatibility(): void {
    this.cards.ensureOutboundDeliveryOrder();
    this.cards.ensureOutboundDismissedState();
    this.cards.ensureOutboundDeliveryOrder();
    this.worker.ensureWorkerTurnCards();
    this.worker.ensureWorkerTurnCardPageStates();
    this.worker.ensureWorkerTurnCardProgress();
    this.worker.ensureWorkerTurnProgressSequence();
    this.worker.ensureWorkerTurnTokenCount();
    this.worker.ensureWorkerSourcePrimaryPaneLabel();
    this.worker.ensureWorkerParentIdentity();
    this.worker.ensurePrimaryScopedWorkerNames();
    this.worker.ensureCardContextProjectionTables();
    this.worker.ensureCardContextPendingIndex();
    this.worker.ensureActiveWorkerScopedNames();
    this.worker.ensureWorkerTurnContextReferences();
    this.worker.ensureInstanceTurnActorProvenance();
    this.worker.ensureWorkerOutboxStreamMetadata();
    this.worker.ensureWorkerMainOutboxIdentity();
    this.worker.ensurePrimaryCardContextColumns();
    this.worker.ensureCardContextStartupInvalidations();
    this.worker.ensureWorkerPaneCloseSteps();
    this.worker.ensureWorkerPaneCloseRetainedState();
  }

  private applyDeliveryAndControlCompatibility(): void {
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
    this.ensureNaturalLanguageCommandConfirmations();
    this.ensureControllerInterpretationJobs();
    this.ensureCommandStatusViews();
    this.worker.ensureWorkerCardDisplayRequests();
    this.worker.ensureWorkerSessionThreads();
    this.worker.ensureWorkerThreadEntryRequests();
    this.worker.ensureWorkerThreadEntryInvalidations();
  }

  private restoreRunCardViewAndIndexes(runCardViewNeedsRebuild: boolean): void {
    if (runCardViewNeedsRebuild) this.cards.recreateRunCardsView();
    this.cards.ensureQueryIndexes();
  }

  private runHistoricalAnswerConvergence(): void {
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
  }

  private applyFinalDeliveryAndGatewayCompatibility(): void {
    this.cards.ensureOutboundWorkClass();
    this.gateway.ensureGatewayIdentityAndPlans();
    this.cards.ensureOutboundClaims();
    this.cards.ensureDeliveryRecoveries();
    this.cards.ensureAnswerRecoveryEvidence();
    this.cards.ensureGroupCardCreates();
    this.cards.ensureWorkerThreadTargets();
    this.cards.ensureOutboundEffectCertainty();
    this.cards.ensureLarkDeliveryCooldown();
    // Legacy outbox rebuilds above intentionally preserve their historical
    // layouts. Re-apply additive Gateway columns and the claim immutability
    // trigger after every possible rebuild so mixed-version databases converge.
    this.gateway.ensureGatewayIdentityAndPlans();
    this.gateway.ensureGatewayScopedOutboxLanes();
    this.cards.ensureOutboundClaims();
    this.gateway.convergeLegacyExpiredAnswerTargets();
  }

  private ensureAnswerTimelines(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS answer_timeline_items(
        aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('primary-run','worker-turn')), aggregate_id TEXT NOT NULL, item_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence >= 0), item_json TEXT NOT NULL CHECK(json_valid(item_json)),
        PRIMARY KEY(aggregate_kind, aggregate_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS answer_timeline_items_order ON answer_timeline_items(aggregate_kind, aggregate_id, sequence, item_id);
      CREATE TRIGGER IF NOT EXISTS answer_timeline_primary_delete AFTER DELETE ON run_cards BEGIN
        DELETE FROM answer_timeline_items WHERE aggregate_kind = 'primary-run' AND aggregate_id = OLD.prompt_id;
      END;
      CREATE TRIGGER IF NOT EXISTS answer_timeline_worker_delete AFTER DELETE ON instance_turns BEGIN
        DELETE FROM answer_timeline_items WHERE aggregate_kind = 'worker-turn' AND aggregate_id = OLD.id;
      END;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (50);
    `);
  }

  private ensureAnswerTimelinePageCheckpoints(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS answer_timeline_page_checkpoints(
        aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('primary-run','worker-turn')), aggregate_id TEXT NOT NULL, page_index INTEGER NOT NULL,
        start_cursor_json TEXT NOT NULL CHECK(json_valid(start_cursor_json)), delivered_cursor_json TEXT CHECK(delivered_cursor_json IS NULL OR json_valid(delivered_cursor_json)),
        delivered_items_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(delivered_items_json)), pending_reply_id TEXT REFERENCES outbound_replies(id) ON DELETE SET NULL,
        pending_cursor_json TEXT CHECK(pending_cursor_json IS NULL OR json_valid(pending_cursor_json)), pending_items_json TEXT CHECK(pending_items_json IS NULL OR json_valid(pending_items_json)),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(aggregate_kind, aggregate_id, page_index)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS answer_timeline_page_pending_reply ON answer_timeline_page_checkpoints(pending_reply_id) WHERE pending_reply_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS answer_timeline_page_primary_delete AFTER DELETE ON run_cards BEGIN
        DELETE FROM answer_timeline_page_checkpoints WHERE aggregate_kind = 'primary-run' AND aggregate_id = OLD.prompt_id;
      END;
      CREATE TRIGGER IF NOT EXISTS answer_timeline_page_worker_delete AFTER DELETE ON instance_turns BEGIN
        DELETE FROM answer_timeline_page_checkpoints WHERE aggregate_kind = 'worker-turn' AND aggregate_id = OLD.id;
      END;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (51);
    `);
  }

  canonicalizeLegacyAnswerTargets(timestamp: string): void {
    this.cards.canonicalizeLegacyAnswerTargets(timestamp);
  }

  private ensureNaturalLanguageCommandConfirmations(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS natural_language_command_confirmations(
        id TEXT PRIMARY KEY, source_message_id TEXT NOT NULL UNIQUE, actor_open_id TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id TEXT, root_message_id TEXT NOT NULL,
        command_json TEXT NOT NULL, expected_binding_id TEXT, expected_binding_generation INTEGER, expected_instance_id TEXT, expected_instance_generation INTEGER,
        state TEXT NOT NULL CHECK(state IN ('pending','consumed','expired','cancelled')), expires_at TEXT NOT NULL, result_detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT,
        CHECK((expected_binding_id IS NULL) = (expected_binding_generation IS NULL)),
        CHECK((expected_instance_id IS NULL) = (expected_instance_generation IS NULL))
      );
      CREATE INDEX IF NOT EXISTS natural_language_command_confirmations_pending ON natural_language_command_confirmations(state, expires_at, created_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (47);
    `);
  }

  private ensureControllerInterpretationJobs(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS controller_interpretation_jobs(
        id TEXT PRIMARY KEY, source_message_id TEXT NOT NULL UNIQUE, message_json TEXT NOT NULL, controller_generation INTEGER NOT NULL, capability_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('accepted','dispatching','observing','succeeded','clarification','unsupported','task','failed','uncertain')), result_json TEXT, runtime_turn_id TEXT, dispatched_at TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS controller_interpretation_jobs_queue ON controller_interpretation_jobs(state, created_at);
      CREATE TABLE IF NOT EXISTS controller_runtime(
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), generation INTEGER NOT NULL, pane_id TEXT NOT NULL, terminal_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','stale')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (48);
    `);
  }

  private ensureCommandStatusViews(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS command_status_views(
        intent_id TEXT PRIMARY KEY REFERENCES swarm_command_intents(id) ON DELETE CASCADE, command_kind TEXT NOT NULL, summary TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('literal','natural-language','card','primary-tool')),
        actor_open_id TEXT NOT NULL, lane_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('accepted','executing','succeeded','rejected','failed','uncertain')), attempt_count INTEGER NOT NULL DEFAULT 0, outcome_json TEXT,
        message_id TEXT, card_id TEXT, card_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1), delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK(delivered_revision >= 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS command_status_views_state ON command_status_views(state, updated_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (49);
    `);
  }
}

function now(): string { return new Date().toISOString(); }
