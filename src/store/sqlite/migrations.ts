import type { SqliteContext } from "./context.js";
import { createLatestSchema } from "./schema.js";
import { BindingSessionMigrations } from "./migrations/binding-session-migrations.js";
import { CardOutboxMigrations } from "./migrations/card-outbox-migrations.js";
import { PromptTurnMigrations } from "./migrations/prompt-turn-migrations.js";
import { RetiredSchemaMigrations } from "./migrations/retired-schema-migrations.js";
import { WorkerMigrations } from "./migrations/worker-migrations.js";
import { GatewayMigrations } from "./migrations/gateway-migrations.js";
import { ConversationSegmentMigrations } from "./migrations/conversation-segment-migrations.js";
import { applyOrderedMigrations, hasAppliedOrderedMigration, installReleasedLegacyMigrationMarkers } from "./migration-registry.js";
import type { ExclusiveMigrationLeaseAuthorization } from "./exclusive-migration-lock.js";
import { repairLegacyMarker89Obligations } from "./migrations/legacy-marker-89-migrations.js";
import { contractedDeliveryScopeTriggersSql, validContractedDeliveryScopeSql, validDeliveryScopeSql } from "./delivery-scope-schema.js";
import {
  CURRENT_SCHEMA_EPOCH,
  countCompatibilitySteps,
  ensureSchemaMetadataTable,
  isFreshSchema,
  readOptionalSchemaMetadata,
  recordSchemaMetadata,
  validateCanonicalSchema,
  validateCurrentSchema,
  type SchemaMigrationResult
} from "./schema-manifest.js";

export type FreshBaselineStage = "metadata-table-created" | "canonical-schema-created" | "canonical-schema-validated" | "metadata-recorded-before-commit";

export interface SqliteMigrationsOptions {
  onFreshBaselineStage?(stage: FreshBaselineStage): void;
  migrationLeaseAuthorization?: ExclusiveMigrationLeaseAuthorization;
}

export class SqliteMigrations {
  private readonly binding: BindingSessionMigrations;
  private readonly prompt: PromptTurnMigrations;
  private readonly cards: CardOutboxMigrations;
  private readonly worker: WorkerMigrations;
  private readonly retired: RetiredSchemaMigrations;
  private readonly gateway: GatewayMigrations;
  private readonly conversationSegments: ConversationSegmentMigrations;

  constructor(private readonly context: SqliteContext, private readonly options: SqliteMigrationsOptions = {}) {
    this.binding = new BindingSessionMigrations(context);
    this.prompt = new PromptTurnMigrations(context);
    this.cards = new CardOutboxMigrations(context);
    this.worker = new WorkerMigrations(context);
    this.retired = new RetiredSchemaMigrations(context);
    this.gateway = new GatewayMigrations(context);
    this.conversationSegments = new ConversationSegmentMigrations(context);
  }

  run(): SchemaMigrationResult {
    return this.runLocked();
  }

  private migrationTransaction<T>(operation: () => T): T {
    return this.context.migrationTransaction("sqlite.migrations.compatibility-helper", operation);
  }

  private runLocked(): SchemaMigrationResult {
    const metadata = readOptionalSchemaMetadata(this.context.database);
    if (metadata) {
      if (metadata.epoch === "2026-10-08.1") return this.upgradeT4RecoverySchema();
      if (metadata.epoch === "2026-10-08.2") return this.upgradeConversationProjectionSchema();
      if (metadata.epoch === "2026-10-08.3") return this.upgradeWorkerMainRankingSchema();
      if (metadata.epoch === "2026-10-08.4") return this.upgradeDeliveryScopeOrderSchema();
      if (metadata.epoch === "2026-10-08.5") return this.upgradeLeasePolicySchema();
      if (metadata.epoch === "2026-10-08.6") return this.upgradeCoreEventDiscriminatorSchema();
      if (metadata.epoch === "2026-10-08.7") return this.upgradeSessionActivitySchema();
      if (metadata.epoch === "2026-10-08.8") return this.upgradeRetentionAuditSchema();
      if (metadata.epoch === "2026-10-08.9") return this.upgradeRetentionCompactionSchema();
      if (metadata.epoch === "2026-10-08.10") return this.upgradeDeliveryConflictSchema();
      if (metadata.epoch === "2026-10-09.1") return this.upgradeDeliveryConflictSchema();
      if (metadata.epoch === "2026-10-09.2") return this.upgradeExactTurnOwnerProjectionSchema();
      if (metadata.epoch === "2026-10-09.3") return this.upgradePlannerStatisticsSchema();
      if (metadata.epoch === "2026-10-09.4") return this.upgradePrimarySegmentCompletionSchema();
      if (metadata.epoch === "2026-10-09.5") return this.upgradeSemanticDeliverySchema();
      if (metadata.epoch === "2026-10-10.1") return this.upgradeSemanticDeliveryRolloutSchema();
      if (metadata.epoch === "2026-10-10.2") return this.upgradeProjectionGapRetentionSchema();
      if (metadata.epoch === "2026-10-10.3") return this.upgradeSemanticDeliveryDiagnosticsSchema();
      if (metadata.epoch === "2026-10-10.4") return this.upgradeSessionAgentIdentitySchema();
      if (metadata.epoch === "2026-10-10.5") return this.upgradeCompletionReviewSchema();
      if (metadata.epoch === "2026-10-11.1") return this.upgradeCanonicalInputRecoveryAutoCloseSchema();
      if (metadata.epoch === "2026-10-11.2") return this.upgradeReplacementRecoveryIdentitySchema();
      if (metadata.epoch === "2026-10-12.1") return this.upgradeRetainedMultiAgentCallIndexSchema();
      if (metadata.epoch === "2026-10-13.1") return this.upgradeCanonicalRecoverySettlementSchema();
      if (metadata.epoch === "2026-10-13.2") return this.upgradeRetainedCheckpointSessionIndexSchema();
      if (metadata.epoch === "2026-10-13.3") return this.upgradeRetainedRecoveryCheckpointSchema();
      if (["2026-10-13.4", "2026-10-13.5"].includes(metadata.epoch)) return this.upgradeWorkerDeliveryParentPaneSchema();
      if (metadata.epoch === "2026-10-13.6") return this.upgradeCollaborationMultiAgentCallIndexSchema();
      if (metadata.epoch === "2026-10-13.7") return this.upgradeHistoricalCoreRecoveryIndexSchema();
      if (metadata.epoch === "2026-10-14.1") return this.upgradeHistoricalMissingPageIndexSchema();
      if (metadata.epoch === "2026-10-14.2") return this.upgradeTypedHumanInputSchema();
      if (metadata.epoch === "2026-10-15.1") return this.upgradeCoreEventLaneConflictDiagnosticsSchema();
      if (metadata.epoch === "2026-10-18.1") return this.upgradeRuntimeIdentityClaimSchema();
      if (metadata.epoch === "2026-10-18.2") return this.upgradeWorkerActionablePageSchema();
      if (metadata.epoch === "2026-10-20.1") return this.upgradeCompletedProjectSelectionPageSchema();
      if (metadata.epoch === "2026-10-20.2") return this.upgradeConversationActionablePageSchema();
      const fingerprint = validateCurrentSchema(this.context.database, metadata);
      this.worker.convergeWorkerThreadEntryInvalidations();
      return {
        route: "current-fast",
        compatibilityStepCount: 0,
        epoch: CURRENT_SCHEMA_EPOCH,
        fingerprint
      };
    }

    const fresh = isFreshSchema(this.context.database);
    // A durable post-111 registry marker proves this database has already
    // crossed into the metadata-governed epoch. Missing metadata is corruption
    // in that state, never permission to replay historical repair migrations.
    if (!fresh && hasAppliedOrderedMigration(this.context.database)) {
      throw new Error("SQLite schema metadata is missing for a database with applied ordered migrations");
    }
    if (!fresh) {
      // A database that already has the complete canonical catalog is not an
      // unknown historical shape. Missing metadata there is corruption (or a
      // failed external edit), never permission to replay migrations over it.
      let isCanonical = false;
      try {
        validateCanonicalSchema(this.context.database);
        isCanonical = true;
      } catch {
        // An actually historical schema continues through its ordered repair
        // chain below.
      }
      if (isCanonical) {
        throw new Error("SQLite schema metadata is missing for an otherwise current schema");
      }
    }
    const compatibilityStepCount = fresh ? 0 : countCompatibilitySteps(this.context.database);
    // A fresh database is one atomic, exclusive current-baseline operation.
    // Compatibility contains legacy migrations with their own durable
    // transactions, so it remains observable as a group; it is never marked
    // current until all steps and metadata have completed.
    const fingerprint = fresh
      ? this.runFreshBaselineAndRecordMetadata()
      : this.runCompatibilityAndRecordMetadata();
    return {
      route: fresh ? "fresh-baseline" : "compatibility",
      compatibilityStepCount,
      epoch: CURRENT_SCHEMA_EPOCH,
      fingerprint
    };
  }

  private upgradeCanonicalRecoverySettlementSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.canonical-recovery-settlement-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeRuntimeIdentityClaimSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.runtime-identity-claim-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeWorkerActionablePageSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.worker-actionable-page-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeCompletedProjectSelectionPageSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.completed-project-selection-page-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeConversationActionablePageSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.conversation-actionable-page-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeHistoricalCoreRecoveryIndexSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.historical-core-recovery-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeHistoricalMissingPageIndexSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.historical-missing-page-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeTypedHumanInputSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.typed-human-input-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeCoreEventLaneConflictDiagnosticsSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.core-event-lane-conflict-diagnostics-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeWorkerDeliveryParentPaneSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    this.cards.ensureOutboundClaims();
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.worker-delivery-parent-pane-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeRetainedCheckpointSessionIndexSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.retained-checkpoint-session-index-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeRetainedRecoveryCheckpointSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.retained-recovery-checkpoint-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeRetainedMultiAgentCallIndexSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.retained-multi-agent-call-index-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeCollaborationMultiAgentCallIndexSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.collaboration-multi-agent-call-index-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeReplacementRecoveryIdentitySchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.replacement-recovery-identity-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeCanonicalInputRecoveryAutoCloseSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.canonical-input-recovery-auto-close-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeConversationProjectionSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    this.context.migrationTransaction("sqlite.migrations.t7-worker-main-index", () => this.cards.ensureQueryIndexes());
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.t5-conversation-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradePrimarySegmentCompletionSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.primary-segment-completion-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeSessionAgentIdentitySchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.session-agent-identity-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeCompletionReviewSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.completion-review-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeSemanticDeliverySchema(): SchemaMigrationResult {
    this.cards.ensureSemanticDeliveryContract();
    this.cards.ensureSemanticDeliveryRolloutGuard();
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.semantic-delivery-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeSemanticDeliveryRolloutSchema(): SchemaMigrationResult {
    return this.upgradeSemanticDeliveryCumulativeSchema("sqlite.migrations.semantic-delivery-rollout-metadata");
  }

  private upgradeProjectionGapRetentionSchema(): SchemaMigrationResult {
    return this.upgradeSemanticDeliveryCumulativeSchema("sqlite.migrations.projection-gap-retention-metadata");
  }

  private upgradeSemanticDeliveryDiagnosticsSchema(): SchemaMigrationResult {
    return this.upgradeSemanticDeliveryCumulativeSchema("sqlite.migrations.semantic-delivery-diagnostics-metadata");
  }

  private upgradeSemanticDeliveryCumulativeSchema(metadataTransaction: string): SchemaMigrationResult {
    this.cards.ensureSemanticDeliveryRolloutGuard();
    const fingerprint = this.context.migrationTransaction(metadataTransaction, () => {
      this.context.database.exec("CREATE INDEX IF NOT EXISTS projection_gaps_open_source_item ON projection_gaps(state, source_item_id)");
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeWorkerMainRankingSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    this.context.migrationTransaction("sqlite.migrations.t7-worker-main-index", () => this.cards.ensureQueryIndexes());
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.t7-worker-main-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeDeliveryScopeOrderSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.t8-delivery-scope-order-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeLeasePolicySchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.t9-lease-policy-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeCoreEventDiscriminatorSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.t10-core-event-discriminator-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeSessionActivitySchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.t11-session-activity-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeRetentionAuditSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.t12-retention-audit-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeRetentionCompactionSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    this.cards.ensureOutboundClaims();
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.t13-retention-compaction-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeDeliveryConflictSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    this.cards.ensureOutboundClaims();
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.bd1-delivery-conflict-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeExactTurnOwnerProjectionSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.exact-turn-owner-projection-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradePlannerStatisticsSchema(): SchemaMigrationResult {
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.planner-statistics-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private upgradeT4RecoverySchema(): SchemaMigrationResult {
    this.context.migrationTransaction("sqlite.migrations.t4-recovery-bounds", () => {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(authoritative_turn_snapshots)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("event_count")) this.context.database.exec("ALTER TABLE authoritative_turn_snapshots ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0 CHECK(event_count >= 0)");
      if (!columns.has("payload_bytes")) this.context.database.exec("ALTER TABLE authoritative_turn_snapshots ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(payload_bytes >= 0)");
      this.context.database.exec(`
        CREATE INDEX IF NOT EXISTS outbound_replies_active_claim_id ON outbound_replies(id) WHERE claim_attempt_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS submission_intents_recovery_keyset ON submission_intents(state,created_at,submission_id);
        CREATE TABLE IF NOT EXISTS agent_input_recovery_scan(
          singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),scan_cutoff TEXT NOT NULL,
          after_created_at TEXT NOT NULL,after_submission_id TEXT NOT NULL,updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS canonical_input_recovery_scan(
          singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),scan_cutoff TEXT NOT NULL,
          after_created_at TEXT NOT NULL,after_submission_id TEXT NOT NULL,updated_at TEXT NOT NULL
        );
      `);
      this.convergeAuthoritativeSnapshotCounters();
    });
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    this.context.migrationTransaction("sqlite.migrations.t7-worker-main-index", () => this.cards.ensureQueryIndexes());
    const fingerprint = this.context.migrationTransaction("sqlite.migrations.t5-conversation-metadata", () => {
      const next = validateCanonicalSchema(this.context.database);
      recordSchemaMetadata(this.context.database, next);
      return next;
    });
    return { route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint };
  }

  private runFreshBaselineAndRecordMetadata(): string {
    return this.context.migrationTransaction("sqlite.migrations.fresh-baseline", () => {
      ensureSchemaMetadataTable(this.context.database);
      this.options.onFreshBaselineStage?.("metadata-table-created");
      this.createCanonicalCurrentSchema();
      this.options.onFreshBaselineStage?.("canonical-schema-created");
      const fingerprint = validateCanonicalSchema(this.context.database);
      this.options.onFreshBaselineStage?.("canonical-schema-validated");
      recordSchemaMetadata(this.context.database, fingerprint);
      this.options.onFreshBaselineStage?.("metadata-recorded-before-commit");
      return fingerprint;
    });
  }

  private createCanonicalCurrentSchema(): void {
    createLatestSchema(this.context);
    // createLatestSchema intentionally contains only stable table DDL.  The
    // following are current-schema convergence declarations: they create the
    // final indexes, triggers and views directly against empty tables.  They
    // do not run the initial historical data-repair chain.
    const runCardViewNeedsRebuild = this.prepareRunCardView();
    this.prepareContractedMigrationCompatibility();
    this.applyBindingAndPromptCompatibility();
    this.applyWorkerAndProjectionCompatibility();
    this.applyDeliveryAndControlCompatibility();
    this.restoreRunCardViewAndIndexes(runCardViewNeedsRebuild);
    this.applyFinalDeliveryAndGatewayCompatibility();
    this.cards.ensureMessageDeleteDeliveries();
    this.ensureAnswerTimelines();
    this.ensureAnswerTimelinePageCheckpoints();
    this.ensureAnswerSegments();
    this.ensureCoreEventInbox();
    this.ensureCoreEventProjectionAttempts();
    this.ensureConversationTurnProjectionOrder();
    this.ensureAuthoritativeTurnSnapshotStaging();
    this.ensureProjectionGaps();
    this.upgradeProjectionGapsForTurnCards();
    this.ensureCoreEventCheckpointRebase();
    this.ensureDeliveryDebtClassifications();
    this.ensureExternalTurnRecoveryAttempts();
    this.ensureDetachedPromptRecoveryAttempts();
    this.ensurePrimaryHumanReviewEpisodes();
    this.ensureHumanReviewCandidates();
    this.ensurePrimaryHumanReviewSurfaces();
    this.ensureWorkerHumanReviewEpisodes();
    this.ensureCompletionNotificationObligations();
    this.ensureCompletionActionSets();
    this.ensureCompletionChoiceSpecifications();
    this.ensurePrimaryCardRedeliveries();
    this.ensureNativeInputBatches();
    this.ensureSubmissionIntents();
    this.ensureInputCardViews();
    this.ensureLegacyInputCardRetirements();
    this.ensureCardDismissals();
    this.ensureCanonicalHumanMessageSubmissions();
    this.ensureSubmissionIntentOwnerIndex();
    this.ensureCanonicalInputRecoveryAttempts();
    this.conversationSegments.ensureConversationSegments();
    this.binding.ensureSessionEpochColumns();
    this.binding.ensureOrchestratorClearOperations();
    this.binding.ensureOrchestratorIdentityMigrations();
    this.ensureDeliveryScopes();
    this.ensureDeliverySchedulerControl();
    this.cards.ensurePaneEntryAliasTargets();
    this.cards.ensureOutboxLaneHeads();
    this.cards.ensureOutboundClaims();
    this.ensurePreparedDeliveryDiscovery();
    this.ensureDeliveryRingCheckpoints();
    this.contractLegacyDeliveryScheduler();
    installReleasedLegacyMigrationMarkers(this.context.database);
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    this.cards.ensureOutboundClaims();
    this.cards.ensureSemanticDeliveryContract();
    this.cards.ensureSemanticDeliveryRolloutGuard();
  }

  private runCompatibilityAndRecordMetadata(): string {
    this.context.observeManualTransactions("sqlite.migrations.compatibility", () => this.runCompatibility());
    this.context.migrationTransaction("sqlite.migrations.compatibility-metadata-table", () => ensureSchemaMetadataTable(this.context.database));
    const fingerprint = validateCanonicalSchema(this.context.database);
    // This write is deliberately last. A crash before it leaves a historical
    // (metadata-absent) database which safely re-enters compatibility; a crash
    // after it can only take the verified fast route.
    this.context.transaction("sqlite.migrations.compatibility-metadata", () => {
      recordSchemaMetadata(this.context.database, fingerprint);
    });
    return fingerprint;
  }

  private runCompatibility(): void {
    // Compatibility may rebuild tables referenced by the rollout transition
    // trigger. Remove that cross-table trigger until all historical rebuilds
    // finish; final convergence recreates it against the canonical names.
    this.context.database.exec("DROP TRIGGER IF EXISTS semantic_delivery_rollout_guarded_transition");
    const runCardViewNeedsRebuild = this.prepareRunCardView();
    repairLegacyMarker89Obligations(this.context);
    createLatestSchema(this.context);
    this.prepareContractedMigrationCompatibility();
    this.applyInitialCompatibility();
    this.applyBindingAndPromptCompatibility();
    this.applyWorkerAndProjectionCompatibility();
    this.applyDeliveryAndControlCompatibility();
    this.restoreRunCardViewAndIndexes(runCardViewNeedsRebuild);
    this.runHistoricalAnswerConvergence();
    this.applyFinalDeliveryAndGatewayCompatibility();
    this.cards.ensureMessageDeleteDeliveries();
    this.ensureAnswerTimelines();
    this.ensureAnswerTimelinePageCheckpoints();
    this.ensureAnswerSegments();
    this.ensureCoreEventInbox();
    this.ensureCoreEventProjectionAttempts();
    this.ensureConversationTurnProjectionOrder();
    this.ensureAuthoritativeTurnSnapshotStaging();
    this.ensureProjectionGaps();
    this.upgradeProjectionGapsForTurnCards();
    this.ensureCoreEventCheckpointRebase();
    this.ensureDeliveryDebtClassifications();
    this.ensureExternalTurnRecoveryAttempts();
    this.ensureDetachedPromptRecoveryAttempts();
    this.ensurePrimaryHumanReviewEpisodes();
    this.ensureHumanReviewCandidates();
    this.ensurePrimaryHumanReviewSurfaces();
    this.ensureWorkerHumanReviewEpisodes();
    this.ensureCompletionNotificationObligations();
    this.ensureCompletionActionSets();
    this.ensureCompletionChoiceSpecifications();
    this.ensurePrimaryCardRedeliveries();
    this.ensureNativeInputBatches();
    this.ensureSubmissionIntents();
    this.ensureInputCardViews();
    this.ensureLegacyInputCardRetirements();
    this.ensureCardDismissals();
    this.ensureCanonicalHumanMessageSubmissions();
    this.ensureSubmissionIntentOwnerIndex();
    this.ensureCanonicalInputRecoveryAttempts();
    this.conversationSegments.ensureConversationSegments();
    this.binding.ensureSessionEpochColumns();
    this.binding.ensureOrchestratorClearOperations();
    this.binding.ensureOrchestratorIdentityMigrations();
    this.ensureDeliveryScopes();
    this.ensureDeliverySchedulerControl();
    this.cards.ensurePaneEntryAliasTargets();
    this.cards.ensureOutboxLaneHeads();
    this.cards.ensureOutboundClaims();
    this.ensurePreparedDeliveryDiscovery();
    this.ensureDeliveryRingCheckpoints();
    this.contractLegacyDeliveryScheduler();
    applyOrderedMigrations(this.context, this.options.migrationLeaseAuthorization);
    this.cards.ensureOutboundClaims();
    this.cards.ensureSemanticDeliveryContract();
    this.cards.ensureSemanticDeliveryRolloutGuard();
  }

  private prepareContractedMigrationCompatibility(): void {
    if (!this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version=109").get()) return;
    const needsLaneTable = [7, 22, 40, 56, 59].some((version) => !this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version));
    if (!needsLaneTable) return;
    this.context.database.exec(`CREATE TABLE IF NOT EXISTS outbox_lane_heads(
      lane_key TEXT PRIMARY KEY,reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE CASCADE,
      delivery_order INTEGER NOT NULL,next_attempt_at TEXT NOT NULL,created_at TEXT NOT NULL
    )`);
  }

  private ensureDeliverySchedulerControl(): void {
    if (this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version=109").get()) return;
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS delivery_scheduler_control(
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        mode TEXT NOT NULL CHECK(mode IN ('ring','legacy')), updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO delivery_scheduler_control(singleton_id,mode,updated_at) VALUES(1,'ring','1970-01-01T00:00:00.000Z');
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (107);
    `);
  }

  private ensureDeliveryScopes(): void {
    if (this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version=109").get()) {
      this.ensureContractedDeliverySchema();
      return;
    }
    const definitions = [
      ["scope_kind", "TEXT CHECK(scope_kind IN ('pane','global'))"],
      ["scope_key", "TEXT"],
      ["scope_workspace_id", "TEXT"], ["scope_pane_id", "TEXT"],
      ["delivery_owner_kind", "TEXT CHECK(delivery_owner_kind IN ('primary','worker'))"], ["delivery_owner_id", "TEXT"],
      ["delivery_owner_generation", "INTEGER"], ["delivery_owner_session_generation", "INTEGER"], ["delivery_parent_id", "TEXT"],
      ["delivery_parent_generation", "INTEGER"], ["delivery_parent_session_generation", "INTEGER"],
      ["scheduler_owner", "TEXT NOT NULL DEFAULT 'legacy' CHECK(scheduler_owner IN ('legacy','ring'))"]
    ] as const;
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    const splitColumns = ["scope_binding_id", "scope_binding_generation", "scope_session_epoch", "scope_worker_id", "scope_worker_session_generation", "scope_runtime_generation", "scope_parent_binding_id", "scope_parent_binding_generation", "scope_parent_session_epoch"] as const;
    const normalizedScopeFenceColumns = ["scope_owner_id", "scope_owner_generation", "scope_owner_session_generation", "scope_parent_id", "scope_parent_generation", "scope_parent_session_generation"] as const;
    const hasSplitScope = splitColumns.some((name) => columns.has(name));
    const hasNormalizedScopeFence = normalizedScopeFenceColumns.some((name) => columns.has(name));
    const hasLegacyFence = hasSplitScope || hasNormalizedScopeFence || columns.has("scope_owner_kind");
    if (hasLegacyFence) this.context.database.exec(`
      DROP TRIGGER IF EXISTS outbound_replies_valid_delivery_scope_insert;
      DROP TRIGGER IF EXISTS outbound_replies_valid_delivery_scope_update;
      DROP TRIGGER IF EXISTS outbound_replies_immutable_claim;
    `);
    for (const [name, definition] of definitions) {
      if (!columns.has(name)) this.context.database.exec(`ALTER TABLE outbound_replies ADD COLUMN ${name} ${definition}`);
    }
    if (hasSplitScope) {
      this.context.database.exec(`
        UPDATE outbound_replies SET
          delivery_owner_kind = scope_owner_kind,
          delivery_owner_id = CASE scope_owner_kind WHEN 'primary' THEN scope_binding_id WHEN 'worker' THEN scope_worker_id END,
          delivery_owner_generation = CASE scope_owner_kind WHEN 'primary' THEN scope_binding_generation WHEN 'worker' THEN scope_runtime_generation END,
          delivery_owner_session_generation = CASE scope_owner_kind WHEN 'primary' THEN scope_session_epoch WHEN 'worker' THEN scope_worker_session_generation END,
          delivery_parent_id = CASE scope_owner_kind WHEN 'worker' THEN scope_parent_binding_id END,
          delivery_parent_generation = CASE scope_owner_kind WHEN 'worker' THEN scope_parent_binding_generation END,
          delivery_parent_session_generation = CASE scope_owner_kind WHEN 'worker' THEN scope_parent_session_epoch END;
        UPDATE outbound_replies SET
          scope_workspace_id = (SELECT workspace_id FROM bindings WHERE id=delivery_parent_id AND generation=delivery_parent_generation AND session_epoch=delivery_parent_session_generation),
          scope_pane_id = (SELECT pane_id FROM bindings WHERE id=delivery_parent_id AND generation=delivery_parent_generation AND session_epoch=delivery_parent_session_generation)
          WHERE delivery_owner_kind='worker';
      `);
    } else if (hasNormalizedScopeFence) {
      this.context.database.exec(`
        UPDATE outbound_replies SET delivery_owner_kind=scope_owner_kind,delivery_owner_id=scope_owner_id,
          delivery_owner_generation=scope_owner_generation,delivery_owner_session_generation=scope_owner_session_generation,
          delivery_parent_id=scope_parent_id,delivery_parent_generation=scope_parent_generation,
          delivery_parent_session_generation=scope_parent_session_generation;
        UPDATE outbound_replies SET
          scope_workspace_id = (SELECT workspace_id FROM bindings WHERE id=delivery_parent_id AND generation=delivery_parent_generation AND session_epoch=delivery_parent_session_generation),
          scope_pane_id = (SELECT pane_id FROM bindings WHERE id=delivery_parent_id AND generation=delivery_parent_generation AND session_epoch=delivery_parent_session_generation)
          WHERE delivery_owner_kind='worker';
      `);
    }
    if (hasLegacyFence) {
      this.context.database.exec(`UPDATE outbound_replies SET
        scope_kind=CASE WHEN scope_kind='pane' AND length(scope_workspace_id)>0 AND length(scope_pane_id)>0 THEN 'pane' WHEN scope_kind IS NULL THEN NULL ELSE 'global' END,
        scope_key=CASE WHEN scope_kind='pane' AND length(scope_workspace_id)>0 AND length(scope_pane_id)>0 THEN json_array('pane',scope_workspace_id,scope_pane_id) WHEN scope_kind IS NULL THEN NULL ELSE json_array('global') END,
        scope_workspace_id=CASE WHEN scope_kind='pane' AND length(scope_workspace_id)>0 AND length(scope_pane_id)>0 THEN scope_workspace_id END,
        scope_pane_id=CASE WHEN scope_kind='pane' AND length(scope_workspace_id)>0 AND length(scope_pane_id)>0 THEN scope_pane_id END`);
      for (const name of [...splitColumns, ...normalizedScopeFenceColumns, "scope_owner_kind"] as const) {
        if (columns.has(name)) this.context.database.exec(`ALTER TABLE outbound_replies DROP COLUMN ${name}`);
      }
    }
    this.context.database.exec(`
      CREATE INDEX IF NOT EXISTS outbound_replies_scope_order
        ON outbound_replies(scope_key, state, delivery_order) WHERE scope_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS outbound_replies_scheduler_scope
        ON outbound_replies(scheduler_owner, state, scope_key, delivery_order);
    `);
    const insertTrigger = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'outbound_replies_valid_delivery_scope_insert'").get() as { sql: string } | undefined;
    const updateTrigger = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'outbound_replies_valid_delivery_scope_update'").get() as { sql: string } | undefined;
    const triggersCurrent = insertTrigger?.sql.includes("delivery_owner_generation")
      && updateTrigger?.sql.includes("scheduler_owner")
      && updateTrigger.sql.includes("delivery_parent_session_generation");
    if (!triggersCurrent) this.context.database.exec(`
      DROP TRIGGER IF EXISTS outbound_replies_valid_delivery_scope_insert;
      DROP TRIGGER IF EXISTS outbound_replies_valid_delivery_scope_update;
      CREATE TRIGGER outbound_replies_valid_delivery_scope_insert
      BEFORE INSERT ON outbound_replies WHEN NOT (${validDeliveryScopeSql("NEW", columns.has("delivery_parent_pane_id"))})
      BEGIN SELECT RAISE(ABORT, 'invalid_delivery_scope'); END;
      CREATE TRIGGER outbound_replies_valid_delivery_scope_update
      BEFORE UPDATE OF scope_kind, scope_key, scope_workspace_id, scope_pane_id,
        delivery_owner_kind, delivery_owner_id, delivery_owner_generation, delivery_owner_session_generation,
        delivery_parent_id, delivery_parent_generation, delivery_parent_session_generation, scheduler_owner ON outbound_replies
      WHEN NOT (${validDeliveryScopeSql("NEW", columns.has("delivery_parent_pane_id"))})
      BEGIN SELECT RAISE(ABORT, 'invalid_delivery_scope'); END;
    `);
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (104),(106)").run();
  }

  private ensurePreparedDeliveryDiscovery(): void {
    if (this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version=109").get()) {
      this.ensureContractedDeliverySchema();
      return;
    }
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("claim_expires_at")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN claim_expires_at TEXT");
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS outbound_reply_prerequisites(
        dependent_reply_id TEXT NOT NULL REFERENCES outbound_replies(id) ON DELETE CASCADE,
        prerequisite_reply_id TEXT NOT NULL REFERENCES outbound_replies(id) ON DELETE RESTRICT,
        required_state TEXT NOT NULL CHECK(required_state IN ('delivered','dismissed')),
        created_at TEXT NOT NULL,
        PRIMARY KEY(dependent_reply_id, prerequisite_reply_id),
        CHECK(dependent_reply_id != prerequisite_reply_id)
      );
      CREATE INDEX IF NOT EXISTS outbound_reply_prerequisites_reverse
        ON outbound_reply_prerequisites(prerequisite_reply_id, dependent_reply_id);
      CREATE INDEX IF NOT EXISTS outbound_replies_scope_nonterminal_order
        ON outbound_replies(scope_key, delivery_order)
        WHERE scope_key IS NOT NULL AND state IN ('pending','dead_letter');
      CREATE INDEX IF NOT EXISTS outbound_replies_expired_ring_claims
        ON outbound_replies(claim_expires_at, id)
        WHERE scheduler_owner='ring' AND state='pending' AND claim_attempt_id IS NOT NULL AND claim_expires_at IS NOT NULL;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (105);
    `);
  }

  private ensureDeliveryRingCheckpoints(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS delivery_ring_checkpoints(
        scope_key TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK(scope_kind IN ('pane','global')),
        scope_workspace_id TEXT,
        scope_pane_id TEXT,
        committed_delivery_order INTEGER NOT NULL CHECK(committed_delivery_order >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((scope_kind='global' AND scope_workspace_id IS NULL AND scope_pane_id IS NULL)
          OR (scope_kind='pane' AND scope_workspace_id IS NOT NULL AND scope_pane_id IS NOT NULL))
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (110);
    `);
  }

  private contractLegacyDeliveryScheduler(): void {
    const alreadyContracted = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version=109").get() !== undefined;
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("scheduler_owner")) {
      const debt = this.context.database.prepare(`SELECT
        SUM(CASE WHEN NOT (${validContractedDeliveryScopeSql("candidate", columns.has("delivery_parent_pane_id"))}) THEN 1 ELSE 0 END) AS unscoped
        FROM outbound_replies candidate
        WHERE candidate.state='pending' OR (candidate.state='dead_letter' AND (
          NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery
            WHERE recovery.failed_reply_id=candidate.id AND recovery.state IN ('recovered','dismissed'))
          OR EXISTS (SELECT 1 FROM outbox_lane_quarantines quarantine
            WHERE quarantine.failed_reply_id=candidate.id AND quarantine.state='active')
        ))`).get() as { unscoped: number | null };
      if (Number(debt.unscoped ?? 0) > 0) {
        throw new Error(`delivery_contraction_blocked legacy=0 unscoped=${Number(debt.unscoped ?? 0)}`);
      }
      this.context.database.exec(`
        DROP TRIGGER IF EXISTS outbox_lane_heads_after_insert;
        DROP TRIGGER IF EXISTS outbox_lane_heads_after_update;
        DROP TRIGGER IF EXISTS outbox_lane_heads_after_delete;
        DROP TABLE IF EXISTS outbox_lane_heads;
        DROP TABLE IF EXISTS delivery_scheduler_control;
        INSERT OR IGNORE INTO schema_migrations(version) VALUES (109);
      `);
      this.ensureContractedDeliverySchema();
      return;
    }
    if (alreadyContracted) throw new Error("delivery_contraction_invalid: scheduler_owner returned after migration 109");
    const debt = this.context.database.prepare(`SELECT
      SUM(CASE WHEN candidate.scheduler_owner!='ring' THEN 1 ELSE 0 END) AS legacy,
      SUM(CASE WHEN NOT (${validContractedDeliveryScopeSql("candidate", columns.has("delivery_parent_pane_id"))}) THEN 1 ELSE 0 END) AS unscoped
      FROM outbound_replies candidate
      WHERE candidate.state='pending' OR (candidate.state='dead_letter' AND (
        NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery
          WHERE recovery.failed_reply_id=candidate.id AND recovery.state IN ('recovered','dismissed'))
        OR EXISTS (SELECT 1 FROM outbox_lane_quarantines quarantine
          WHERE quarantine.failed_reply_id=candidate.id AND quarantine.state='active')
      ))`).get() as { legacy: number | null; unscoped: number | null };
    if (Number(debt.legacy ?? 0) > 0 || Number(debt.unscoped ?? 0) > 0) {
      throw new Error(`delivery_contraction_blocked legacy=${Number(debt.legacy ?? 0)} unscoped=${Number(debt.unscoped ?? 0)}`);
    }
    this.context.transaction("sqlite.migrations.write", () => {
      this.context.database.exec(`
        DROP TRIGGER IF EXISTS outbox_lane_heads_after_insert;
        DROP TRIGGER IF EXISTS outbox_lane_heads_after_update;
        DROP TRIGGER IF EXISTS outbox_lane_heads_after_delete;
        DROP TRIGGER IF EXISTS outbound_replies_valid_delivery_scope_insert;
        DROP TRIGGER IF EXISTS outbound_replies_valid_delivery_scope_update;
        DROP INDEX IF EXISTS outbound_replies_scheduler_scope;
        DROP INDEX IF EXISTS outbound_replies_expired_ring_claims;
        DROP TABLE IF EXISTS outbox_lane_heads;
        DROP TABLE IF EXISTS delivery_scheduler_control;
        ALTER TABLE outbound_replies DROP COLUMN scheduler_owner;
        CREATE INDEX IF NOT EXISTS outbound_replies_expired_ring_claims
          ON outbound_replies(claim_expires_at,id)
          WHERE state='pending' AND claim_attempt_id IS NOT NULL AND claim_expires_at IS NOT NULL;
        ${contractedDeliveryScopeTriggersSql(columns.has("delivery_parent_pane_id"))}
        INSERT INTO schema_migrations(version) VALUES (109);
      `);
    });
  }

  private ensureContractedDeliverySchema(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    this.context.database.exec(`
      CREATE INDEX IF NOT EXISTS outbound_replies_scope_order
        ON outbound_replies(scope_key,state,delivery_order) WHERE scope_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS outbound_replies_scope_nonterminal_order
        ON outbound_replies(scope_key,delivery_order)
        WHERE scope_key IS NOT NULL AND state IN ('pending','dead_letter');
      CREATE INDEX IF NOT EXISTS outbound_replies_expired_ring_claims
        ON outbound_replies(claim_expires_at,id)
        WHERE state='pending' AND claim_attempt_id IS NOT NULL AND claim_expires_at IS NOT NULL;
      ${contractedDeliveryScopeTriggersSql(columns.has("delivery_parent_pane_id"))}
    `);
  }

  private ensureSubmissionIntents(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS submission_intents(
        submission_id TEXT PRIMARY KEY, ingress_source TEXT NOT NULL, source_message_key TEXT NOT NULL,
        actor_json TEXT NOT NULL CHECK(json_valid(actor_json)), text TEXT NOT NULL,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary','worker')), owner_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL CHECK(owner_generation >= 1), pane_id TEXT NOT NULL, terminal_id TEXT NOT NULL,
        expected_agent_kind TEXT NOT NULL CHECK(expected_agent_kind IN ('traex','pi')), expected_session_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('recorded','attempting','prepared','observed','terminal','cancelled','uncertain')),
        receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
        uncertainty_json TEXT CHECK(uncertainty_json IS NULL OR json_valid(uncertainty_json)),
        cancellation_json TEXT CHECK(cancellation_json IS NULL OR json_valid(cancellation_json)),
        attempted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(ingress_source, source_message_key),
        CHECK((state = 'recorded' AND attempted_at IS NULL) OR (state != 'recorded' AND attempted_at IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS submission_intents_recovery ON submission_intents(state, updated_at, submission_id);
      CREATE INDEX IF NOT EXISTS submission_intents_recovery_keyset ON submission_intents(state, created_at, submission_id);
      CREATE TABLE IF NOT EXISTS agent_input_recovery_scan(
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), scan_cutoff TEXT NOT NULL,
        after_created_at TEXT NOT NULL, after_submission_id TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (88);
    `);
  }

  private ensureInputCardViews(): void {
    repairLegacyMarker89Obligations(this.context);
  }

  private ensureLegacyInputCardRetirements(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS legacy_input_card_retirements(
        submission_id TEXT PRIMARY KEY REFERENCES input_card_views(submission_id) ON DELETE RESTRICT,
        gateway_id TEXT NOT NULL, message_id TEXT NOT NULL,
        outbound_reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK(state IN ('eligible','deleting','retired','failed')),
        outcome TEXT CHECK(outcome IN ('deleted','already_absent','failed')), detail TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, retired_at TEXT,
        UNIQUE(gateway_id, message_id),
        CHECK((state = 'retired' AND outcome IN ('deleted','already_absent') AND retired_at IS NOT NULL)
          OR (state = 'failed' AND outcome = 'failed' AND retired_at IS NULL)
          OR (state IN ('eligible','deleting') AND outcome IS NULL AND retired_at IS NULL))
      );
      CREATE INDEX IF NOT EXISTS legacy_input_card_retirements_state
        ON legacy_input_card_retirements(state, updated_at, submission_id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (103);
    `);
  }

  private ensureCardDismissals(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS card_dismissals(
        id TEXT PRIMARY KEY, action_kind TEXT NOT NULL, semantic_key TEXT NOT NULL,
        actor_open_id TEXT NOT NULL, chat_id TEXT NOT NULL, gateway_id TEXT NOT NULL, message_id TEXT NOT NULL,
        outbound_reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE RESTRICT,
        state TEXT NOT NULL CHECK(state IN ('deleting','deleted','already_absent','failed')),
        outcome TEXT CHECK(outcome IN ('deleted','already_absent','failed')), detail TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, settled_at TEXT,
        UNIQUE(action_kind, semantic_key, gateway_id, message_id),
        CHECK((state = 'deleting' AND outcome IS NULL AND settled_at IS NULL)
          OR (state IN ('deleted','already_absent') AND outcome = state AND settled_at IS NOT NULL)
          OR (state = 'failed' AND outcome = 'failed' AND settled_at IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS card_dismissals_state ON card_dismissals(state, updated_at, id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (111);
    `);
  }

  private ensureCanonicalHumanMessageSubmissions(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS canonical_human_message_submissions(
        submission_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES core_event_inbox(event_id) ON DELETE CASCADE,
        agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')), session_id TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canonical_human_message_submissions_observed
        ON canonical_human_message_submissions(observed_at, submission_id);
      INSERT OR IGNORE INTO canonical_human_message_submissions(submission_id,event_id,agent_kind,session_id,observed_at)
      SELECT json_extract(event_json, '$.payload.submission_id'), event_id, agent_kind, session_id, ingested_at
      FROM core_event_inbox
      WHERE json_extract(event_json, '$.payload.type') = 'human_message'
        AND json_type(event_json, '$.payload.submission_id') = 'text'
        AND length(json_extract(event_json, '$.payload.submission_id')) > 0
      ORDER BY ingested_at, event_id;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (92);
    `);
  }

  private ensureSubmissionIntentOwnerIndex(): void {
    this.context.database.exec(`
      CREATE INDEX IF NOT EXISTS submission_intents_owner
        ON submission_intents(owner_kind, owner_id, owner_generation, submission_id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (93);
    `);
  }

  private ensureCanonicalInputRecoveryAttempts(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS canonical_input_recovery_attempts(
        submission_id TEXT PRIMARY KEY REFERENCES submission_intents(submission_id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('retry_wait','needs_human','auto_closed')),
        failure_code TEXT NOT NULL CHECK(failure_code IN ('indexing','not_found','ambiguous','unavailable')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 1), next_attempt_at TEXT, updated_at TEXT NOT NULL,
        CHECK((state='retry_wait' AND next_attempt_at IS NOT NULL) OR (state IN ('needs_human','auto_closed') AND next_attempt_at IS NULL))
      );
      CREATE INDEX IF NOT EXISTS canonical_input_recovery_attempts_due
        ON canonical_input_recovery_attempts(state,next_attempt_at,submission_id);
      CREATE TABLE IF NOT EXISTS canonical_input_recovery_scan(
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),scan_cutoff TEXT NOT NULL,
        after_created_at TEXT NOT NULL,after_submission_id TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (94);
    `);
  }

  private ensureCompletionChoiceSpecifications(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS completion_choice_specifications(
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn','primary-segment')),
        owner_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL CHECK(owner_generation >= 1),
        version INTEGER NOT NULL CHECK(version = 1),
        question TEXT,
        default_option_id TEXT NOT NULL,
        invalid_reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(owner_kind, owner_id, owner_generation)
      );
      CREATE TABLE IF NOT EXISTS completion_choice_options(
        specification_id TEXT NOT NULL REFERENCES completion_choice_specifications(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        option_id TEXT NOT NULL,
        label TEXT NOT NULL,
        message TEXT NOT NULL,
        PRIMARY KEY(specification_id, option_id),
        UNIQUE(specification_id, ordinal)
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (76);
    `);
    const specificationColumns = new Set((this.context.database.prepare("PRAGMA table_info(completion_choice_specifications)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!specificationColumns.has("question")) this.context.database.exec("ALTER TABLE completion_choice_specifications ADD COLUMN question TEXT");
    if (!specificationColumns.has("invalid_reason")) this.context.database.exec("ALTER TABLE completion_choice_specifications ADD COLUMN invalid_reason TEXT");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (87)").run();
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(completion_action_sets)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("choice_specification_id")) this.context.database.exec("ALTER TABLE completion_action_sets ADD COLUMN choice_specification_id TEXT REFERENCES completion_choice_specifications(id)");
    if (!columns.has("selected_choice_option_id")) this.context.database.exec("ALTER TABLE completion_action_sets ADD COLUMN selected_choice_option_id TEXT");
  }


  private ensureCompletionActionSets(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS completion_action_sets(
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn','primary-segment')),
        owner_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL CHECK(owner_generation >= 1),
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
        page_index INTEGER NOT NULL CHECK(page_index >= 0),
        card_id TEXT NOT NULL,
        card_message_id TEXT NOT NULL,
        mention_open_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('available','consumed','superseded','unavailable')),
        selected_action TEXT CHECK(selected_action IN ('default','approve','continue','reject')),
        result_source_key TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        decided_at TEXT,
        UNIQUE(owner_kind, owner_id, owner_generation)
      );
      CREATE INDEX IF NOT EXISTS completion_action_sets_available
        ON completion_action_sets(state, owner_kind, binding_id, binding_generation, updated_at, owner_id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (74);
    `);
  }

  private ensureNativeInputBatches(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS native_input_batches(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
        state TEXT NOT NULL CHECK(state IN ('collecting','formed','cancelled')),
        window_opened_at TEXT NOT NULL, drain_due_at TEXT NOT NULL, combined_body TEXT,
        execution_prompt_id TEXT UNIQUE REFERENCES prompt_jobs(id) ON DELETE CASCADE,
        formed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK((state = 'formed' AND combined_body IS NOT NULL AND execution_prompt_id = id AND formed_at IS NOT NULL)
          OR (state != 'formed' AND combined_body IS NULL AND execution_prompt_id IS NULL AND formed_at IS NULL))
      );
      CREATE INDEX IF NOT EXISTS native_input_batches_binding_state
        ON native_input_batches(binding_id, binding_generation, state, drain_due_at, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS native_input_batches_one_collecting
        ON native_input_batches(binding_id, binding_generation) WHERE state = 'collecting';
      CREATE TABLE IF NOT EXISTS prompt_inputs(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
        ingress_source TEXT NOT NULL CHECK(ingress_source = 'feishu'), source_message_key TEXT NOT NULL,
        lark_message_id TEXT NOT NULL UNIQUE, actor_open_id TEXT NOT NULL, body TEXT NOT NULL,
        root_message_id TEXT NOT NULL, parent_prompt_id TEXT REFERENCES prompt_jobs(id),
        state TEXT NOT NULL CHECK(state IN ('queued','batched','cancelled')),
        batch_id TEXT REFERENCES native_input_batches(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(ingress_source, source_message_key),
        CHECK((state = 'batched' AND batch_id IS NOT NULL) OR state != 'batched')
      );
      CREATE INDEX IF NOT EXISTS prompt_inputs_fifo
        ON prompt_inputs(binding_id, binding_generation, state, created_at, id);
      CREATE TABLE IF NOT EXISTS native_input_batch_members(
        batch_id TEXT NOT NULL REFERENCES native_input_batches(id) ON DELETE CASCADE,
        prompt_input_id TEXT NOT NULL UNIQUE REFERENCES prompt_inputs(id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0 AND ordinal < 3),
        created_at TEXT NOT NULL,
        PRIMARY KEY(batch_id, ordinal)
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (75);
    `);
  }

  private ensurePrimaryCardRedeliveries(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS primary_card_redeliveries(
        command_intent_id TEXT PRIMARY KEY REFERENCES swarm_command_intents(id) ON DELETE CASCADE,
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
        topic_view_version INTEGER NOT NULL CHECK(topic_view_version >= 0),
        prompt_id TEXT REFERENCES prompt_jobs(id), run_view_version INTEGER, answer_page_index INTEGER,
        main_reply_id TEXT NOT NULL REFERENCES outbound_replies(id), answer_reply_id TEXT REFERENCES outbound_replies(id),
        outcome TEXT NOT NULL CHECK(outcome IN ('main_and_answer','main_only')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        CHECK((prompt_id IS NULL AND run_view_version IS NULL AND answer_page_index IS NULL AND answer_reply_id IS NULL)
          OR (prompt_id IS NOT NULL AND run_view_version IS NOT NULL AND answer_page_index IS NOT NULL AND answer_reply_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS primary_card_redeliveries_binding
        ON primary_card_redeliveries(binding_id, binding_generation, created_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (77);
    `);
  }

  private ensureCompletionNotificationObligations(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS completion_notification_obligations(
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn','primary-segment')),
        owner_id TEXT NOT NULL, owner_generation INTEGER NOT NULL CHECK(owner_generation >= 1),
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
        required_view_version INTEGER NOT NULL CHECK(required_view_version >= 1),
        mention_open_id TEXT,
        notice_kind TEXT NOT NULL DEFAULT 'choice' CHECK(notice_kind IN ('choice','completion')),
        state TEXT NOT NULL CHECK(state IN ('waiting_for_answer','missing_mention_target','released','suppressed')),
        notification_reply_id TEXT REFERENCES outbound_replies(id) ON DELETE SET NULL,
        presentation_reply_id TEXT REFERENCES outbound_replies(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, released_at TEXT,
        PRIMARY KEY(owner_kind, owner_id, owner_generation)
      );
      CREATE INDEX IF NOT EXISTS completion_notification_obligations_waiting
        ON completion_notification_obligations(state, owner_kind, updated_at, owner_id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (73);
    `);
  }

  private ensureDeliveryDebtClassifications(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS delivery_debt_classifications(
        debt_kind TEXT NOT NULL CHECK(debt_kind IN ('delivery_recovery','projection_gap')),
        debt_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope = 'historical'), reason TEXT NOT NULL,
        source_updated_at TEXT NOT NULL, classified_at TEXT NOT NULL,
        PRIMARY KEY(debt_kind, debt_id)
      );
      CREATE INDEX IF NOT EXISTS delivery_debt_classifications_scope
        ON delivery_debt_classifications(scope, classified_at, debt_kind, debt_id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (61);
    `);
  }

  private ensurePrimaryHumanReviewEpisodes(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS primary_human_review_episodes(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1), pane_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('open','resolved')), notice TEXT NOT NULL,
        requested_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS primary_human_review_open
        ON primary_human_review_episodes(binding_id, binding_generation, prompt_id) WHERE state = 'open';
      CREATE INDEX IF NOT EXISTS primary_human_review_history
        ON primary_human_review_episodes(binding_id, requested_at, id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (60);
    `);
  }

  private ensureHumanReviewCandidates(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS human_review_candidates(
        source_event_id TEXT PRIMARY KEY REFERENCES core_event_inbox(event_id) ON DELETE CASCADE,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('binding','worker_turn')), owner_id TEXT NOT NULL,
        owner_generation INTEGER NOT NULL CHECK(owner_generation >= 1), native_session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        notice TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','absorbed','expired')),
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, absorbed_episode_id TEXT, absorbed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS human_review_candidates_pending
        ON human_review_candidates(owner_kind, owner_id, owner_generation, state, expires_at, created_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (84);
    `);
  }

  private ensurePrimaryHumanReviewSurfaces(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(primary_human_review_episodes)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("surface_generation")) this.context.database.exec("ALTER TABLE primary_human_review_episodes ADD COLUMN surface_generation INTEGER NOT NULL DEFAULT 0 CHECK(surface_generation >= 0)");
    if (!columns.has("view_version")) this.context.database.exec("ALTER TABLE primary_human_review_episodes ADD COLUMN view_version INTEGER NOT NULL DEFAULT 0 CHECK(view_version >= 0)");
    if (!columns.has("delivered_version")) this.context.database.exec("ALTER TABLE primary_human_review_episodes ADD COLUMN delivered_version INTEGER NOT NULL DEFAULT 0 CHECK(delivered_version >= 0)");
    if (!columns.has("create_reply_id")) this.context.database.exec("ALTER TABLE primary_human_review_episodes ADD COLUMN create_reply_id TEXT");
    if (!columns.has("message_id")) this.context.database.exec("ALTER TABLE primary_human_review_episodes ADD COLUMN message_id TEXT");
    if (!columns.has("card_id")) this.context.database.exec("ALTER TABLE primary_human_review_episodes ADD COLUMN card_id TEXT");
    if (!columns.has("card_json")) this.context.database.exec("ALTER TABLE primary_human_review_episodes ADD COLUMN card_json TEXT");
    if (!columns.has("updated_at")) this.context.database.exec("ALTER TABLE primary_human_review_episodes ADD COLUMN updated_at TEXT");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (85)").run();
  }

  private ensureWorkerHumanReviewEpisodes(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS worker_human_review_episodes(
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES instance_turns(id) ON DELETE CASCADE,
        instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE,
        instance_generation INTEGER NOT NULL CHECK(instance_generation >= 1),
        worker_session_generation INTEGER NOT NULL CHECK(worker_session_generation >= 1),
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
        state TEXT NOT NULL CHECK(state IN ('open','resolved')), notice TEXT NOT NULL,
        requested_at TEXT NOT NULL, resolved_at TEXT,
        surface_generation INTEGER NOT NULL CHECK(surface_generation >= 1),
        view_version INTEGER NOT NULL CHECK(view_version >= 1),
        delivered_version INTEGER NOT NULL DEFAULT 0 CHECK(delivered_version >= 0),
        create_reply_id TEXT, message_id TEXT, card_id TEXT,
        create_card_json TEXT NOT NULL, card_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS worker_human_review_open
        ON worker_human_review_episodes(turn_id, instance_generation) WHERE state = 'open';
      CREATE INDEX IF NOT EXISTS worker_human_review_history
        ON worker_human_review_episodes(instance_id, worker_session_generation, requested_at, id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (86);
    `);
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
    this.cards.ensureRunCardReplyContext();
    this.cards.ensureRunCardSpaceName();
    this.cards.ensureRunCardSessionTitle();
    this.cards.ensureRunCardPaneToken();
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
    this.binding.ensureBindingKindColumn();
    this.binding.ensurePrimaryAgentKindColumns();
    this.cards.ensureRunCardProjectionContext();
    this.binding.ensureBindingLifecycleColumns();
    this.binding.ensureBindingPaneTokenColumn();
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
    this.prompt.ensurePromptNativeSubmissionColumn();
    this.prompt.ensurePromptTranscriptTurnOwnership();
    this.prompt.ensurePromptIdentityCorrections();
    this.prompt.ensureTurnPriorityColumns();
    this.prompt.ensureModelPreferenceSchema();
    this.prompt.ensurePromptExecutionOriginColumn();
    this.prompt.ensurePromptSourceIdentity();
    this.prompt.ensurePromptExecutionLifecycle();
    this.cards.ensureRunCardExecutionPhases();
    this.cards.ensureRunCardTaskListTitle();
    this.cards.ensureRunCardActivityColumn();
    this.retired.convergeRetiredPromptSteering();
    this.prompt.ensurePrimaryContinuationLineage();
  }

  private applyWorkerAndProjectionCompatibility(): void {
    this.cards.ensureOutboundDeliveryOrder();
    this.cards.ensureOutboundDismissedState();
    this.cards.ensureOutboundDeliveryOrder();
    this.worker.ensureWorkerTurnCards();
    this.worker.ensureWorkerPaneTokenColumn();
    this.worker.ensureWorkerTurnCardPageStates();
    this.cards.ensureCardKitAnswerPageModes();
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
    this.prompt.ensureNaturalLanguageCommandFrozenTargets();
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
      this.migrationTransaction(() => {
        this.cards.canonicalizeLegacyAnswerTargets(now());
        this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (2)").run();
      });
    }
    const answerFinishMigration = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get();
    if (!answerFinishMigration) {
      this.migrationTransaction(() => {
        this.cards.finishLegacyDeliveredAnswerPages(now());
        this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (3)").run();
      });
    }
    const answerDeadLetterMigration = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get();
    if (!answerDeadLetterMigration) {
      this.migrationTransaction(() => {
        this.cards.dismissStreamsForFinishedAnswerPages(now());
        this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (4)").run();
      });
    }
  }

  private applyFinalDeliveryAndGatewayCompatibility(): void {
    this.cards.ensureOutboundWorkClass();
    this.gateway.ensureGatewayIdentityAndPlans();
    this.binding.ensureOrchestratorBindingIndex();
    this.cards.ensureOutboundClaims();
    this.cards.ensureOutboundEffectCertainty();
    this.cards.ensureDeliveryRecoveries();
    this.cards.ensureDeliveryRecoverySemanticProof();
    this.cards.backfillLegacyWorkerExpiredTargetSemanticProof();
    this.cards.ensureAnswerRecoveryEvidence();
    this.cards.ensureGroupCardCreates();
    this.cards.ensureWorkerThreadTargets();
    // Historical outbox rebuilds above may remove columns added by newer
    // migrations. Restore failure metadata before later rebuilds select it.
    this.cards.ensureOutboundEffectCertainty();
    // The historical group/worker-target rebuilds intentionally use their
    // original layouts and can therefore drop columns added by a newer
    // Gateway migration. Shortcut-panel migration copies those columns, so
    // restore them before that rebuild as well as during final convergence.
    this.gateway.ensureGatewayIdentityAndPlans();
    this.cards.ensureShortcutPanelTargets();
    this.cards.ensureLarkDeliveryCooldown();
    // Legacy outbox rebuilds above intentionally preserve their historical
    // layouts. Re-apply additive Gateway columns and the claim immutability
    // trigger after every possible rebuild so mixed-version databases converge.
    this.gateway.ensureGatewayIdentityAndPlans();
    if (!this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version=109").get()) {
      this.gateway.ensureGatewayScopedOutboxLanes();
    }
    this.cards.ensureOutboundClaims();
    this.cards.ensureAnswerPageOutboxLanes();
    this.cards.ensureWorkerTurnPageOutboxLanes();
    this.cards.dismissUnclaimedLegacyRichTextIntents(now());
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

  private ensureAnswerSegments(): void {
    if (this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 68").get()) return;
    this.context.transaction("sqlite.migrations.write", () => {
      this.context.database.exec(`
        CREATE TABLE IF NOT EXISTS answer_segments(
          aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('primary-run','worker-turn')), aggregate_id TEXT NOT NULL, segment_index INTEGER NOT NULL CHECK(segment_index >= 0),
          source_human_item_id TEXT, request_text TEXT NOT NULL, start_after_sequence INTEGER NOT NULL CHECK(start_after_sequence >= 0),
          end_before_sequence INTEGER, end_before_item_id TEXT, state TEXT NOT NULL CHECK(state IN ('open','closed')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(aggregate_kind, aggregate_id, segment_index),
          CHECK((state = 'open' AND end_before_sequence IS NULL AND end_before_item_id IS NULL) OR (state = 'closed' AND end_before_sequence IS NOT NULL AND end_before_item_id IS NOT NULL))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS answer_segments_source_boundary
          ON answer_segments(aggregate_kind, aggregate_id, source_human_item_id)
          WHERE source_human_item_id IS NOT NULL;
      `);

      const answerPageColumns = new Set((this.context.database.prepare("PRAGMA table_info(answer_pages)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!answerPageColumns.has("segment_index")) this.context.database.exec("ALTER TABLE answer_pages ADD COLUMN segment_index INTEGER NOT NULL DEFAULT 0");

      const workerPageColumns = new Set((this.context.database.prepare("PRAGMA table_info(worker_turn_card_pages)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!workerPageColumns.has("segment_index")) this.context.database.exec("ALTER TABLE worker_turn_card_pages ADD COLUMN segment_index INTEGER NOT NULL DEFAULT 0");

      const timestamp = now();
      this.context.database.exec(`
        INSERT OR IGNORE INTO answer_segments(
          aggregate_kind, aggregate_id, segment_index, source_human_item_id, request_text,
          start_after_sequence, end_before_sequence, end_before_item_id, state, created_at, updated_at
        )
        SELECT 'primary-run', run.prompt_id, 0, NULL, run.request_text,
          COALESCE((SELECT MAX(t.sequence) FROM answer_timeline_items t WHERE t.aggregate_kind = 'primary-run' AND t.aggregate_id = run.prompt_id), 0),
          NULL, NULL, 'open', '${timestamp}', '${timestamp}'
        FROM run_cards run;

        INSERT OR IGNORE INTO answer_segments(
          aggregate_kind, aggregate_id, segment_index, source_human_item_id, request_text,
          start_after_sequence, end_before_sequence, end_before_item_id, state, created_at, updated_at
        )
        SELECT 'worker-turn', card.turn_id, 0, NULL, card.request_text,
          COALESCE((SELECT MAX(t.sequence) FROM answer_timeline_items t WHERE t.aggregate_kind = 'worker-turn' AND t.aggregate_id = card.turn_id), 0),
          NULL, NULL, 'open', '${timestamp}', '${timestamp}'
        FROM worker_turn_cards card;

        UPDATE answer_pages SET segment_index = 0 WHERE segment_index IS NULL;
        UPDATE worker_turn_card_pages SET segment_index = 0 WHERE segment_index IS NULL;
        INSERT INTO schema_migrations(version) VALUES (68);
      `);
    });
  }

  private ensureCoreEventInbox(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS core_event_inbox(
        event_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')),
        session_id TEXT NOT NULL, turn_id TEXT, source_cursor TEXT NOT NULL, occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL CHECK(json_valid(event_json)), ingested_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS core_event_inbox_session_turn ON core_event_inbox(agent_kind, session_id, turn_id, occurred_at, event_id);
      CREATE TABLE IF NOT EXISTS core_event_lane_items(
        lane_id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES core_event_inbox(event_id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence > 0), state TEXT NOT NULL CHECK(state IN ('pending','projected','ignored','quarantined')),
        failure TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(lane_id, event_id), UNIQUE(lane_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS core_event_lane_pending ON core_event_lane_items(lane_id, state, sequence);
      CREATE TABLE IF NOT EXISTS core_event_lane_checkpoints(
        lane_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')),
        session_id TEXT NOT NULL, read_cursor TEXT NOT NULL, latest_cursor TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (53);
    `);
  }

  private ensureExternalTurnRecoveryAttempts(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS external_turn_recovery_attempts(
        prompt_id TEXT PRIMARY KEY REFERENCES prompt_jobs(id) ON DELETE CASCADE,
        binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL,
        pane_id TEXT NOT NULL, session_value TEXT NOT NULL, turn_id TEXT NOT NULL, started_at TEXT NOT NULL,
        failure_code TEXT NOT NULL, failure_fingerprint TEXT NOT NULL DEFAULT '', recovery_state TEXT NOT NULL DEFAULT 'waiting' CHECK(recovery_state IN ('waiting','indexing','not_found','ambiguous','transient')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 1), last_runtime_observed_at TEXT,
        last_attempt_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS external_turn_recovery_due ON external_turn_recovery_attempts(next_attempt_at, binding_id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (54);
    `);
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(external_turn_recovery_attempts)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("failure_fingerprint")) this.context.database.exec("ALTER TABLE external_turn_recovery_attempts ADD COLUMN failure_fingerprint TEXT NOT NULL DEFAULT ''");
    if (!columns.has("recovery_state")) this.context.database.exec("ALTER TABLE external_turn_recovery_attempts ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'waiting' CHECK(recovery_state IN ('waiting','indexing','not_found','ambiguous','transient'))");
    if (!columns.has("last_runtime_observed_at")) this.context.database.exec("ALTER TABLE external_turn_recovery_attempts ADD COLUMN last_runtime_observed_at TEXT");
  }

  private ensureDetachedPromptRecoveryAttempts(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS detached_prompt_recovery_attempts(
        prompt_id TEXT PRIMARY KEY REFERENCES prompt_jobs(id) ON DELETE CASCADE,
        binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
        pane_id TEXT NOT NULL, session_value TEXT NOT NULL,
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 1),
        first_attempt_at TEXT NOT NULL, last_attempt_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS detached_prompt_recovery_due ON detached_prompt_recovery_attempts(next_attempt_at, binding_id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (59);
    `);
  }

  private ensureCoreEventProjectionAttempts(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(core_event_lane_items)").all() as Array<{ name: string }>).map(({ name }) => name));
    const upgradingLegacyRows = !columns.has("reducer_revision");
    if (!columns.has("failure_fingerprint")) this.context.database.exec("ALTER TABLE core_event_lane_items ADD COLUMN failure_fingerprint TEXT");
    if (!columns.has("attempt_count")) this.context.database.exec("ALTER TABLE core_event_lane_items ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0)");
    if (!columns.has("reducer_revision")) this.context.database.exec("ALTER TABLE core_event_lane_items ADD COLUMN reducer_revision INTEGER NOT NULL DEFAULT 1 CHECK(reducer_revision >= 1)");
    if (!columns.has("conflict_count")) this.context.database.exec("ALTER TABLE core_event_lane_items ADD COLUMN conflict_count INTEGER NOT NULL DEFAULT 0 CHECK(conflict_count >= 0)");
    if (!columns.has("last_conflict_hash")) this.context.database.exec("ALTER TABLE core_event_lane_items ADD COLUMN last_conflict_hash TEXT");
    if (!columns.has("last_conflict_reason")) this.context.database.exec("ALTER TABLE core_event_lane_items ADD COLUMN last_conflict_reason TEXT");
    if (!columns.has("last_conflict_at")) this.context.database.exec("ALTER TABLE core_event_lane_items ADD COLUMN last_conflict_at TEXT");
    if (upgradingLegacyRows) this.context.database.prepare(`UPDATE core_event_lane_items
      SET state='pending', failure=NULL, failure_fingerprint=NULL, attempt_count=0, reducer_revision=1
      WHERE state='quarantined'`).run();
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (58)").run();
  }

  private ensureConversationTurnProjectionOrder(): void {
    repairLegacyMarker89Obligations(this.context);
  }

  private ensureAuthoritativeTurnSnapshotStaging(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS authoritative_turn_snapshots(
        agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')), session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, requested_started_at TEXT NOT NULL,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('binding','worker_turn')), owner_id TEXT NOT NULL,
        canonical_started_at TEXT, state TEXT NOT NULL CHECK(state IN ('staging','ready','indexing','not_found','ambiguous')),
        next_cursor TEXT NOT NULL, complete INTEGER NOT NULL CHECK(complete IN (0,1)),
        failure_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(agent_kind, session_id, turn_id, requested_started_at)
      );
      CREATE TABLE IF NOT EXISTS authoritative_turn_snapshot_pages(
        agent_kind TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, requested_started_at TEXT NOT NULL,
        after_cursor TEXT NOT NULL, next_cursor TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('recovered','indexing','not_found','ambiguous')),
        complete INTEGER NOT NULL CHECK(complete IN (0,1)), page_hash TEXT NOT NULL, events_json TEXT NOT NULL CHECK(json_valid(events_json)), created_at TEXT NOT NULL,
        PRIMARY KEY(agent_kind, session_id, turn_id, requested_started_at, after_cursor),
        FOREIGN KEY(agent_kind, session_id, turn_id, requested_started_at)
          REFERENCES authoritative_turn_snapshots(agent_kind, session_id, turn_id, requested_started_at) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS authoritative_turn_snapshot_events(
        agent_kind TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, requested_started_at TEXT NOT NULL,
        event_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0), event_hash TEXT NOT NULL,
        event_json TEXT NOT NULL CHECK(json_valid(event_json)), created_at TEXT NOT NULL,
        PRIMARY KEY(agent_kind, session_id, turn_id, requested_started_at, event_id),
        UNIQUE(agent_kind, session_id, turn_id, requested_started_at, sequence),
        FOREIGN KEY(agent_kind, session_id, turn_id, requested_started_at)
          REFERENCES authoritative_turn_snapshots(agent_kind, session_id, turn_id, requested_started_at) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS authoritative_turn_snapshot_events_order
        ON authoritative_turn_snapshot_events(agent_kind, session_id, turn_id, requested_started_at, sequence);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (90);
    `);
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(authoritative_turn_snapshots)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("applied_at")) this.context.database.exec("ALTER TABLE authoritative_turn_snapshots ADD COLUMN applied_at TEXT");
    if (!columns.has("applied_projection_id")) this.context.database.exec("ALTER TABLE authoritative_turn_snapshots ADD COLUMN applied_projection_id TEXT");
    if (!columns.has("applied_view_version")) this.context.database.exec("ALTER TABLE authoritative_turn_snapshots ADD COLUMN applied_view_version INTEGER");
    if (!columns.has("event_count")) this.context.database.exec("ALTER TABLE authoritative_turn_snapshots ADD COLUMN event_count INTEGER NOT NULL DEFAULT 0 CHECK(event_count >= 0)");
    if (!columns.has("payload_bytes")) this.context.database.exec("ALTER TABLE authoritative_turn_snapshots ADD COLUMN payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(payload_bytes >= 0)");
    this.context.database.exec("CREATE INDEX IF NOT EXISTS outbound_replies_active_claim_id ON outbound_replies(id) WHERE claim_attempt_id IS NOT NULL");
    this.convergeAuthoritativeSnapshotCounters();
    this.context.database.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (91)");
  }

  private convergeAuthoritativeSnapshotCounters(): void {
    this.context.database.exec(`UPDATE authoritative_turn_snapshots SET
      event_count=(SELECT COUNT(*) FROM authoritative_turn_snapshot_events event
        WHERE event.agent_kind=authoritative_turn_snapshots.agent_kind AND event.session_id=authoritative_turn_snapshots.session_id
          AND event.turn_id=authoritative_turn_snapshots.turn_id AND event.requested_started_at=authoritative_turn_snapshots.requested_started_at),
      payload_bytes=COALESCE((SELECT SUM(length(CAST(page.events_json AS BLOB))) FROM authoritative_turn_snapshot_pages page
        WHERE page.agent_kind=authoritative_turn_snapshots.agent_kind AND page.session_id=authoritative_turn_snapshots.session_id
          AND page.turn_id=authoritative_turn_snapshots.turn_id AND page.requested_started_at=authoritative_turn_snapshots.requested_started_at),0)
        +COALESCE((SELECT SUM(length(CAST(event.event_json AS BLOB))) FROM authoritative_turn_snapshot_events event
        WHERE event.agent_kind=authoritative_turn_snapshots.agent_kind AND event.session_id=authoritative_turn_snapshots.session_id
          AND event.turn_id=authoritative_turn_snapshots.turn_id AND event.requested_started_at=authoritative_turn_snapshots.requested_started_at),0)`);
    const oversized = this.context.database.prepare(`SELECT 1 FROM authoritative_turn_snapshots
      WHERE event_count>1024 OR payload_bytes>8388608 LIMIT 1`).get();
    if (oversized) throw new Error("Existing authoritative Turn snapshot exceeds the bounded recovery limits");
  }

  private ensureProjectionGaps(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS projection_gaps(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stage TEXT NOT NULL CHECK(stage IN ('core_projection','answer_delivery','main_delivery','worker_delivery','turn_recovery')),
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('binding','prompt','answer_page','worker_turn','turn_card')),
        owner_id TEXT NOT NULL, source_item_id TEXT NOT NULL, failure_class TEXT NOT NULL DEFAULT 'unknown', failure_code TEXT NOT NULL, required_version INTEGER,
        occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count >= 1),
        state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','compensated','dismissed')),
        compensated_by_version INTEGER, first_failed_at TEXT NOT NULL, last_failed_at TEXT NOT NULL, compensated_at TEXT,
        UNIQUE(stage,owner_kind,owner_id,source_item_id)
      );
      CREATE INDEX IF NOT EXISTS projection_gaps_open ON projection_gaps(state, owner_kind, owner_id, first_failed_at);
      CREATE INDEX IF NOT EXISTS projection_gaps_open_source_item ON projection_gaps(state, source_item_id);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (55);
    `);
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(projection_gaps)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("failure_class")) this.context.database.exec("ALTER TABLE projection_gaps ADD COLUMN failure_class TEXT NOT NULL DEFAULT 'unknown'");
    if (!columns.has("required_version")) this.context.database.exec("ALTER TABLE projection_gaps ADD COLUMN required_version INTEGER");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (57)").run();
  }

  private upgradeProjectionGapsForTurnCards(): void {
    const sql = String((this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projection_gaps'").get() as { sql?: string } | undefined)?.sql ?? "");
    if (sql.includes("'turn_card'")) {
      this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (96)").run();
      return;
    }
    this.context.transaction("sqlite.migrations.write", () => {
      this.context.database.exec("DROP INDEX IF EXISTS projection_gaps_open");
      this.context.database.exec("DROP INDEX IF EXISTS projection_gaps_open_source_item");
      this.context.database.exec("ALTER TABLE projection_gaps RENAME TO projection_gaps_legacy");
      this.context.database.exec(`CREATE TABLE projection_gaps(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stage TEXT NOT NULL CHECK(stage IN ('core_projection','answer_delivery','main_delivery','worker_delivery','turn_recovery')),
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('binding','prompt','answer_page','worker_turn','turn_card')),
        owner_id TEXT NOT NULL, source_item_id TEXT NOT NULL, failure_class TEXT NOT NULL DEFAULT 'unknown', failure_code TEXT NOT NULL, required_version INTEGER,
        occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count >= 1), state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','compensated','dismissed')),
        compensated_by_version INTEGER, first_failed_at TEXT NOT NULL, last_failed_at TEXT NOT NULL, compensated_at TEXT,
        UNIQUE(stage,owner_kind,owner_id,source_item_id)
      );
      INSERT INTO projection_gaps(id,stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,required_version,occurrence_count,state,compensated_by_version,first_failed_at,last_failed_at,compensated_at)
        SELECT id,stage,owner_kind,owner_id,source_item_id,COALESCE(failure_class,'unknown'),failure_code,required_version,occurrence_count,state,compensated_by_version,first_failed_at,last_failed_at,compensated_at FROM projection_gaps_legacy;
      CREATE INDEX projection_gaps_open ON projection_gaps(state, owner_kind, owner_id, first_failed_at);
      CREATE INDEX projection_gaps_open_source_item ON projection_gaps(state, source_item_id);
      DROP TABLE projection_gaps_legacy;`);
      this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (96)").run();
    });
  }

  private ensureCoreEventCheckpointRebase(): void {
    const checkpointColumns = new Set((this.context.database.prepare("PRAGMA table_info(core_event_lane_checkpoints)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!checkpointColumns.has("source_epoch")) this.context.database.exec("ALTER TABLE core_event_lane_checkpoints ADD COLUMN source_epoch TEXT");
    const gapColumns = new Set((this.context.database.prepare("PRAGMA table_info(projection_gaps)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!gapColumns.has("details_json")) this.context.database.exec("ALTER TABLE projection_gaps ADD COLUMN details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json))");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (102)").run();
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
