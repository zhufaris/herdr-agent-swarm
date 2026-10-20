import type { DatabaseSync } from "node:sqlite";
import type { SqliteContext } from "./context.js";
import type { ExclusiveMigrationLeaseAuthorization } from "./exclusive-migration-lock.js";
import { hasLeaseExpiryMilliseconds, leaseExpiryMs, parseLeaseTimestampMs } from "./lease-time.js";
import { runForeignKeySafeRebuild } from "./migrations/foreign-key-safe-rebuild.js";
import { rebuildCompletionActionSetsForCompletionReview } from "./migrations/completion-action-set-migrations.js";
import { contractedDeliveryScopeTriggersSql } from "./delivery-scope-schema.js";
import { createRuntimeIdentityClaimSchema } from "./schema.js";
import { BindingSessionMigrations } from "./migrations/binding-session-migrations.js";
import { ConversationSegmentMigrations } from "./migrations/conversation-segment-migrations.js";
import { WorkerMigrations } from "./migrations/worker-migrations.js";

export const LAST_RELEASED_LEGACY_MARKER = 111;

/**
 * Released marker history is a physical database contract, not a migration
 * definition.  Keeping its installation in this module prevents a baseline
 * helper from becoming a second insertion path for new marker IDs.
 */
export const RELEASED_LEGACY_MARKERS = Object.freeze([
  ...integerRange(1, 68),
  ...integerRange(70, LAST_RELEASED_LEGACY_MARKER)
]);

export interface OrderedMigration {
  readonly id: number;
  readonly name: string;
  apply(context: SqliteContext, leaseAuthorization?: ExclusiveMigrationLeaseAuthorization): void;
}

/** New migration identity and execution live in the same ordered registry. */
export function defineOrderedMigrations(definitions: readonly OrderedMigration[]): readonly OrderedMigration[] {
  let previous = LAST_RELEASED_LEGACY_MARKER;
  for (const definition of definitions) {
    if (!Number.isSafeInteger(definition.id) || definition.id <= LAST_RELEASED_LEGACY_MARKER) {
      throw new Error(`Ordered migration id must be a safe integer greater than ${LAST_RELEASED_LEGACY_MARKER}: ${definition.id}`);
    }
    if (!definition.name.trim()) throw new Error(`Ordered migration ${definition.id} requires a name`);
    if (definition.id <= previous) throw new Error(`Ordered migrations must be strictly increasing: ${definition.id}`);
    previous = definition.id;
  }
  return Object.freeze(definitions.map((definition) => Object.freeze(definition)));
}

function recordRegisteredMigration(database: DatabaseSync, id: number): void {
  database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(id);
}

export const orderedMigrations = defineOrderedMigrations([
  {
    id: 112,
    name: "current-schema-metadata",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.t3-schema-metadata", () => {
        assertMigrationLease(context, leaseAuthorization);
        context.database.exec(`
          CREATE TABLE IF NOT EXISTS schema_metadata(
            singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
            epoch TEXT NOT NULL,
            fingerprint TEXT NOT NULL
          )
        `);
      });
    }
  },
  {
    id: 113,
    name: "conversation-active-projection",
    apply(context, leaseAuthorization) {
      prepareConversationActiveProjectionMigration(context, leaseAuthorization);
    }
  },
  {
    id: 114,
    name: "delivery-scope-order",
    apply(context, leaseAuthorization) {
      for (const [label, sql] of [
        ["scope-delivery-order", "CREATE INDEX IF NOT EXISTS outbound_replies_scope_delivery_order ON outbound_replies(scope_key,delivery_order) WHERE scope_key IS NOT NULL"],
        ["worker-review-create-reply", "CREATE INDEX IF NOT EXISTS worker_human_review_create_reply ON worker_human_review_episodes(create_reply_id) WHERE create_reply_id IS NOT NULL"]
      ] as const) context.migrationTransaction(`sqlite.migrations.t8-${label}`, () => {
        assertMigrationLease(context, leaseAuthorization);
        context.database.exec(sql);
      });
    }
  },
  {
    id: 115,
    name: "lease-expiry-milliseconds",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.t9-lease-expiry", () => {
        assertMigrationLease(context, leaseAuthorization);
        if (hasLeaseExpiryMilliseconds(context.database)) return;
        const row = context.database.prepare("SELECT singleton_id,owner_id,fencing_token,expires_at,updated_at FROM instance_lease WHERE singleton_id=1").get() as {
          singleton_id: number; owner_id: string; fencing_token: number; expires_at: string; updated_at: string;
        } | undefined;
        const expiresAtMs = row ? parseLeaseTimestampMs(row.expires_at, "stored expires_at") : null;
        context.database.exec(`
          CREATE TABLE instance_lease_next(
            singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),owner_id TEXT NOT NULL,fencing_token INTEGER NOT NULL,
            expires_at TEXT NOT NULL,expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=0),updated_at TEXT NOT NULL
          )
        `);
        if (row) context.database.prepare(`INSERT INTO instance_lease_next(
          singleton_id,owner_id,fencing_token,expires_at,expires_at_ms,updated_at
        ) VALUES (?,?,?,?,?,?)`).run(row.singleton_id, row.owner_id, row.fencing_token, row.expires_at, expiresAtMs, row.updated_at);
        context.database.exec("DROP TABLE instance_lease; ALTER TABLE instance_lease_next RENAME TO instance_lease");
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 116,
    name: "core-event-discriminators",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.t10-core-event-discriminators", () => {
        assertMigrationLease(context, leaseAuthorization);
        const columns = new Set((context.database.prepare("PRAGMA table_info(core_event_inbox)").all() as Array<{ name: string }>).map(({ name }) => name));
        const definitions = [
          ["event_type", "TEXT"], ["submission_id", "TEXT"], ["channel", "TEXT"], ["call_id", "TEXT"]
        ] as const;
        const addedColumns = definitions.filter(([name]) => !columns.has(name));
        for (const [name, definition] of addedColumns) context.database.exec(`ALTER TABLE core_event_inbox ADD COLUMN ${name} ${definition}`);
        context.database.exec(`
          CREATE TABLE IF NOT EXISTS core_event_discriminator_backfill(
            singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
            state TEXT NOT NULL CHECK(state IN ('backfilling','complete')),
            high_water_event_id TEXT,after_event_id TEXT NOT NULL,
            processed_count INTEGER NOT NULL CHECK(processed_count>=0),updated_at TEXT NOT NULL
          );
        `);
        const maximum = context.database.prepare("SELECT MAX(event_id) AS event_id FROM core_event_inbox").get() as { event_id: string | null };
        const existing = context.database.prepare("SELECT 1 FROM core_event_discriminator_backfill WHERE singleton_id=1").get();
        if (!existing || addedColumns.length > 0) {
          context.database.prepare(`INSERT INTO core_event_discriminator_backfill(
            singleton_id,state,high_water_event_id,after_event_id,processed_count,updated_at
          ) VALUES(1,?,?,?,?,?) ON CONFLICT(singleton_id) DO UPDATE SET
            state=excluded.state,high_water_event_id=excluded.high_water_event_id,after_event_id='',processed_count=0,updated_at=excluded.updated_at`).run(
            maximum.event_id === null ? "complete" : "backfilling", maximum.event_id, "", 0, new Date().toISOString()
          );
        }
        assertMigrationLease(context, leaseAuthorization);
      });
      for (const [label, sql] of [
        ["type-session-turn", "CREATE INDEX IF NOT EXISTS core_event_inbox_type_session_turn ON core_event_inbox(event_type,agent_kind,session_id,turn_id,occurred_at,event_id)"],
        ["submission", "CREATE INDEX IF NOT EXISTS core_event_inbox_submission ON core_event_inbox(submission_id,event_id) WHERE submission_id IS NOT NULL"],
        ["channel", "CREATE INDEX IF NOT EXISTS core_event_inbox_channel ON core_event_inbox(event_type,channel,agent_kind,session_id,turn_id,occurred_at,event_id) WHERE channel IS NOT NULL"],
        ["call", "CREATE INDEX IF NOT EXISTS core_event_inbox_call ON core_event_inbox(call_id,event_type,event_id) WHERE call_id IS NOT NULL"]
      ] as const) context.migrationTransaction(`sqlite.migrations.t10-core-event-${label}-index`, () => {
        assertMigrationLease(context, leaseAuthorization);
        context.database.exec(sql);
      });
    }
  },
  {
    id: 117,
    name: "session-activity",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.t11-session-activity", () => {
        assertMigrationLease(context, leaseAuthorization);
        context.database.exec(`
          CREATE TABLE IF NOT EXISTS session_activity_snapshots(
            scope_key TEXT NOT NULL,workspace_id TEXT NOT NULL,pane_id TEXT NOT NULL,
            producer_kind TEXT NOT NULL CHECK(producer_kind IN ('primary','worker')),producer_id TEXT NOT NULL,
            producer_generation INTEGER NOT NULL CHECK(producer_generation>=1),producer_session_generation INTEGER NOT NULL CHECK(producer_session_generation>=1),runtime_pane_id TEXT NOT NULL,
            binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,binding_generation INTEGER NOT NULL CHECK(binding_generation>=1),session_epoch INTEGER NOT NULL CHECK(session_epoch>=1),
            native_session_id TEXT NOT NULL,agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')),
            lane_id TEXT NOT NULL,source_id TEXT NOT NULL,source_epoch TEXT NOT NULL,source_lane_sequence INTEGER NOT NULL CHECK(source_lane_sequence>=0),source_event_id TEXT NOT NULL,
            reducer_revision INTEGER NOT NULL DEFAULT 1 CHECK(reducer_revision>=1),revision INTEGER NOT NULL CHECK(revision>=1),
            current_model TEXT,current_goal_json TEXT CHECK(current_goal_json IS NULL OR json_valid(current_goal_json)),
            last_turn_id TEXT,last_turn_state TEXT CHECK(last_turn_state IS NULL OR last_turn_state IN ('active','completed','aborted')),
            compaction_count INTEGER NOT NULL DEFAULT 0 CHECK(compaction_count>=0),token_usage INTEGER,context_usage INTEGER,updated_at TEXT NOT NULL,
            PRIMARY KEY(scope_key,producer_kind,producer_id)
          );
          CREATE INDEX IF NOT EXISTS session_activity_snapshots_binding ON session_activity_snapshots(binding_id,binding_generation,session_epoch,scope_key);
          CREATE TABLE IF NOT EXISTS session_activity_items(
            scope_key TEXT NOT NULL,producer_kind TEXT NOT NULL CHECK(producer_kind IN ('primary','worker')),producer_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('task','agent','tool')),item_id TEXT NOT NULL,
            producer_generation INTEGER NOT NULL CHECK(producer_generation>=1),producer_session_generation INTEGER NOT NULL CHECK(producer_session_generation>=1),runtime_pane_id TEXT NOT NULL,
            lane_id TEXT NOT NULL,source_id TEXT NOT NULL,source_epoch TEXT NOT NULL,source_lane_sequence INTEGER NOT NULL CHECK(source_lane_sequence>=0),source_event_id TEXT NOT NULL,
            item_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(item_ordinal>=0),label TEXT NOT NULL,state TEXT NOT NULL,terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),updated_at TEXT NOT NULL,
            PRIMARY KEY(scope_key,producer_kind,producer_id,kind,item_id),
            FOREIGN KEY(scope_key,producer_kind,producer_id) REFERENCES session_activity_snapshots(scope_key,producer_kind,producer_id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS session_activity_items_visible ON session_activity_items(scope_key,kind,terminal,item_ordinal,updated_at DESC,producer_kind,producer_id,item_id);
        `);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 118,
    name: "retention-audit-skeletons",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.t12-retention-audit-skeletons", () => {
        assertMigrationLease(context, leaseAuthorization);
        context.database.exec(`
          CREATE TABLE IF NOT EXISTS audit_skeletons(
            source_kind TEXT NOT NULL CHECK(source_kind IN ('core_event','conversation_segment_item','answer_timeline_item','delivery')),
            source_id TEXT NOT NULL,payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),payload_bytes INTEGER NOT NULL CHECK(payload_bytes>=0),
            lifecycle_state TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,
            owner_generation INTEGER CHECK(owner_generation IS NULL OR owner_generation>=1),owner_session_generation INTEGER CHECK(owner_session_generation IS NULL OR owner_session_generation>=1),
            owner_parent_id TEXT,owner_parent_generation INTEGER CHECK(owner_parent_generation IS NULL OR owner_parent_generation>=1),owner_parent_session_generation INTEGER CHECK(owner_parent_session_generation IS NULL OR owner_parent_session_generation>=1),scope_key TEXT,
            binding_id TEXT,prompt_id TEXT,created_at TEXT NOT NULL,terminal_at TEXT NOT NULL,
            barrier_version INTEGER NOT NULL CHECK(barrier_version>=1),state TEXT NOT NULL CHECK(state IN ('verified','compacted')),
            verified_at TEXT NOT NULL,compacted_at TEXT,relationship_hash TEXT NOT NULL CHECK(length(relationship_hash)=64),
            PRIMARY KEY(source_kind,source_id),
            CHECK((state='verified' AND compacted_at IS NULL) OR (state='compacted' AND compacted_at IS NOT NULL)),
            CHECK((owner_parent_id IS NULL AND owner_parent_generation IS NULL AND owner_parent_session_generation IS NULL)
              OR (owner_parent_id IS NOT NULL AND owner_parent_generation IS NOT NULL AND owner_parent_session_generation IS NOT NULL))
          );
          CREATE INDEX IF NOT EXISTS audit_skeletons_owner ON audit_skeletons(owner_kind,owner_id,source_kind,source_id);
          CREATE INDEX IF NOT EXISTS audit_skeletons_binding ON audit_skeletons(binding_id,source_kind,source_id) WHERE binding_id IS NOT NULL;
          CREATE TABLE IF NOT EXISTS audit_skeleton_links(
            source_kind TEXT NOT NULL,source_id TEXT NOT NULL,
            link_kind TEXT NOT NULL CHECK(link_kind IN ('checkpoint','gap','recovery','prerequisite','replacement','projection','owner')),
            link_id TEXT NOT NULL,link_state TEXT NOT NULL,
            PRIMARY KEY(source_kind,source_id,link_kind,link_id,link_state),
            FOREIGN KEY(source_kind,source_id) REFERENCES audit_skeletons(source_kind,source_id) ON DELETE RESTRICT
          );
          CREATE INDEX IF NOT EXISTS audit_skeleton_links_reverse ON audit_skeleton_links(link_kind,link_id,source_kind,source_id);
          CREATE TRIGGER IF NOT EXISTS audit_skeletons_no_delete BEFORE DELETE ON audit_skeletons
            BEGIN SELECT RAISE(ABORT,'permanent_audit_skeleton'); END;
          CREATE TRIGGER IF NOT EXISTS audit_skeletons_immutable
            BEFORE UPDATE OF source_kind,source_id,payload_hash,payload_bytes,lifecycle_state,owner_kind,owner_id,owner_generation,owner_session_generation,owner_parent_id,owner_parent_generation,owner_parent_session_generation,scope_key,binding_id,prompt_id,created_at,terminal_at,barrier_version,verified_at,relationship_hash
            ON audit_skeletons BEGIN SELECT RAISE(ABORT,'immutable_audit_skeleton'); END;
          CREATE TRIGGER IF NOT EXISTS audit_skeletons_state_forward BEFORE UPDATE OF state,compacted_at ON audit_skeletons
            WHEN NOT (OLD.state='verified' AND NEW.state='compacted' AND NEW.compacted_at IS NOT NULL)
            BEGIN SELECT RAISE(ABORT,'invalid_audit_skeleton_transition'); END;
          CREATE TRIGGER IF NOT EXISTS audit_skeleton_links_no_delete BEFORE DELETE ON audit_skeleton_links
            BEGIN SELECT RAISE(ABORT,'permanent_audit_skeleton_link'); END;
          CREATE TRIGGER IF NOT EXISTS audit_skeleton_links_no_update BEFORE UPDATE ON audit_skeleton_links
            BEGIN SELECT RAISE(ABORT,'immutable_audit_skeleton_link'); END;
          CREATE TRIGGER IF NOT EXISTS audit_skeleton_links_verified_insert BEFORE INSERT ON audit_skeleton_links
            WHEN NOT EXISTS(SELECT 1 FROM audit_skeletons skeleton WHERE skeleton.source_kind=NEW.source_kind AND skeleton.source_id=NEW.source_id AND skeleton.state='verified')
            BEGIN SELECT RAISE(ABORT,'audit_skeleton_not_verified'); END;
        `);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 119,
    name: "retention-payload-compaction",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.t13-retention-payload-compaction", () => {
        assertMigrationLease(context, leaseAuthorization);
        for (const table of ["core_event_inbox", "answer_timeline_items", "conversation_segment_items", "outbound_replies"] as const) {
          const exists = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
          if (!exists) continue;
          const columns = new Set((context.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));
          if (!columns.has("payload_compacted_at")) context.database.exec(`ALTER TABLE ${table} ADD COLUMN payload_compacted_at TEXT`);
        }
        const indexes = [
          ["core_event_inbox", "CREATE INDEX IF NOT EXISTS core_event_inbox_retention ON core_event_inbox(payload_compacted_at,ingested_at,event_id)"],
          ["answer_timeline_items", "CREATE INDEX IF NOT EXISTS answer_timeline_items_retention ON answer_timeline_items(payload_compacted_at,aggregate_kind,aggregate_id,sequence,item_id)"],
          ["conversation_segment_items", "CREATE INDEX IF NOT EXISTS conversation_segment_items_retention ON conversation_segment_items(payload_compacted_at,segment_id,lane_sequence,item_ordinal,item_id)"],
          ["outbound_replies", "CREATE INDEX IF NOT EXISTS outbound_replies_payload_retention ON outbound_replies(payload_compacted_at,updated_at,id)"]
        ] as const;
        for (const [table, sql] of indexes) {
          if (context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) context.database.exec(sql);
        }
        context.database.exec(`CREATE TABLE IF NOT EXISTS retention_compaction_cursors(
            source_kind TEXT PRIMARY KEY CHECK(source_kind IN ('core_event','conversation_segment_item','answer_timeline_item','delivery')),
            cycle_started_at TEXT NOT NULL,high_water_key_json TEXT NOT NULL CHECK(json_valid(high_water_key_json)),
            after_key_json TEXT CHECK(after_key_json IS NULL OR json_valid(after_key_json)),
            cycle_state TEXT NOT NULL CHECK(cycle_state IN ('scanning','complete')),
            compacted_count INTEGER NOT NULL DEFAULT 0 CHECK(compacted_count>=0),
            refusal_counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(refusal_counts_json)),updated_at TEXT NOT NULL
          )`);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 120,
    name: "delivery-conflict-quarantine-budget",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.bd1-delivery-conflict", () => {
        assertMigrationLease(context, leaseAuthorization);
        const hasReplies = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbound_replies'").get() !== undefined;
        const hasQuarantines = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox_lane_quarantines'").get() !== undefined;
        if (hasReplies) {
          const replyColumns = new Set((context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
          if (!replyColumns.has("conflict_key")) context.database.exec("ALTER TABLE outbound_replies ADD COLUMN conflict_key TEXT");
        }
        if (hasQuarantines) {
          const quarantineColumns = new Set((context.database.prepare("PRAGMA table_info(outbox_lane_quarantines)").all() as Array<{ name: string }>).map(({ name }) => name));
          for (const [name, definition] of [
            ["conflict_key", "TEXT"],
            ["phase", "TEXT NOT NULL DEFAULT 'grace_blocking' CHECK(phase IN ('grace_blocking','conflict_isolated'))"],
            ["first_failed_at", "TEXT"],
            ["grace_deadline_at", "TEXT"],
            ["degraded_at", "TEXT"],
            ["budget_attempt_limit", "INTEGER CHECK(budget_attempt_limit IS NULL OR budget_attempt_limit >= 0)"],
            ["budget_duration_ms", "INTEGER CHECK(budget_duration_ms IS NULL OR budget_duration_ms >= 0)"]
          ] as const) {
            if (!quarantineColumns.has(name)) context.database.exec(`ALTER TABLE outbox_lane_quarantines ADD COLUMN ${name} ${definition}`);
          }
        }
        if (hasReplies) context.database.exec(`
          CREATE INDEX IF NOT EXISTS outbound_replies_scope_conflict_order
            ON outbound_replies(scope_key,conflict_key,delivery_order)
            WHERE scope_key IS NOT NULL AND conflict_key IS NOT NULL AND state IN ('pending','dead_letter');
          CREATE INDEX IF NOT EXISTS outbound_replies_conflict_backfill
            ON outbound_replies(delivery_order,id)
            WHERE conflict_key IS NULL AND state IN ('pending','dead_letter');
        `);
        if (hasQuarantines) context.database.exec(`
          CREATE INDEX IF NOT EXISTS outbox_lane_quarantines_phase_deadline
            ON outbox_lane_quarantines(state,phase,grace_deadline_at,failed_reply_id);
        `);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 121,
    name: "delivery-quarantine-review",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.bd4-delivery-review", () => {
        assertMigrationLease(context, leaseAuthorization);
        const exists = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbox_lane_quarantines'").get();
        if (exists) {
          const columns = new Set((context.database.prepare("PRAGMA table_info(outbox_lane_quarantines)").all() as Array<{ name: string }>).map(({ name }) => name));
          if (!columns.has("review_reply_id")) context.database.exec("ALTER TABLE outbox_lane_quarantines ADD COLUMN review_reply_id TEXT REFERENCES outbound_replies(id)");
          if (!columns.has("review_requested_at")) context.database.exec("ALTER TABLE outbox_lane_quarantines ADD COLUMN review_requested_at TEXT");
          context.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS outbox_lane_quarantines_review_reply ON outbox_lane_quarantines(review_reply_id) WHERE review_reply_id IS NOT NULL");
        }
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 122,
    name: "core-event-owner-projections",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.exact-turn-owner-projections", () => {
        assertMigrationLease(context, leaseAuthorization);
        context.database.exec(`
          CREATE TABLE IF NOT EXISTS core_event_owner_projections(
            owner_kind TEXT NOT NULL CHECK(owner_kind IN ('prompt','worker_turn')),
            owner_id TEXT NOT NULL,
            event_id TEXT NOT NULL REFERENCES core_event_inbox(event_id) ON DELETE CASCADE,
            reducer_revision INTEGER NOT NULL CHECK(reducer_revision >= 1),
            projected_at TEXT NOT NULL,
            PRIMARY KEY(owner_kind,owner_id,event_id,reducer_revision)
          );
          CREATE INDEX IF NOT EXISTS core_event_owner_projection_event
            ON core_event_owner_projections(event_id,reducer_revision);
        `);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 123,
    name: "sqlite-planner-statistics",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.planner-statistics", () => {
        assertMigrationLease(context, leaseAuthorization);
        context.database.exec("ANALYZE");
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 124,
    name: "primary-segment-completion-interactions",
    apply(context, leaseAuthorization) {
      const definition = (table: string) => (context.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined)?.sql ?? "";
      const noticeSql = definition("completion_notification_obligations");
      const choiceSql = definition("completion_choice_specifications");
      const actionSql = definition("completion_action_sets");
      const choiceColumns = new Set((context.database.prepare("PRAGMA table_info(completion_choice_specifications)").all() as Array<{ name: string }>).map(({ name }) => name));
      const legacyInvalidReason = choiceColumns.has("invalid_reason") ? "invalid_reason" : "NULL";
      const actionHasCompletionReviewExpansion = actionSql.includes("presentation_kind") && actionSql.includes("presentation_generation");
      const completionReviewMarkerExists = context.database.prepare("SELECT 1 FROM schema_migrations WHERE version=126").get() !== undefined;
      const restoreCompletionReviewExpansion = actionHasCompletionReviewExpansion || completionReviewMarkerExists;
      if (!noticeSql && !choiceSql && !actionSql) return;
      if (noticeSql.includes("'primary-segment'") && noticeSql.includes("mention_open_id")
        && noticeSql.includes("notice_kind") && noticeSql.includes("presentation_reply_id")
        && choiceSql.includes("'primary-segment'") && actionSql.includes("'primary-segment'")) {
        if (completionReviewMarkerExists && !actionHasCompletionReviewExpansion) {
          assertMigrationLease(context, leaseAuthorization);
          rebuildCompletionActionSetsForCompletionReview(context);
          assertMigrationLease(context, leaseAuthorization);
        }
        return;
      }
      assertMigrationLease(context, leaseAuthorization);
      context.database.exec("PRAGMA legacy_alter_table = ON");
      try {
        runForeignKeySafeRebuild(context, "primary segment completion interactions", () => {
          assertMigrationLease(context, leaseAuthorization);
          context.database.exec(`
          DROP INDEX IF EXISTS completion_notification_obligations_waiting;
          DROP INDEX IF EXISTS completion_action_sets_available;
          ALTER TABLE completion_notification_obligations RENAME TO completion_notification_obligations_legacy;
          ALTER TABLE completion_choice_options RENAME TO completion_choice_options_legacy;
          ALTER TABLE completion_action_sets RENAME TO completion_action_sets_legacy;
          ALTER TABLE completion_choice_specifications RENAME TO completion_choice_specifications_legacy;
          CREATE TABLE completion_notification_obligations(
            owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn','primary-segment')),
            owner_id TEXT NOT NULL,owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),
            binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
            binding_generation INTEGER NOT NULL CHECK(binding_generation>=1),
            required_view_version INTEGER NOT NULL CHECK(required_view_version>=1),
            mention_open_id TEXT,
            notice_kind TEXT NOT NULL DEFAULT 'choice' CHECK(notice_kind IN ('choice','completion')),
            state TEXT NOT NULL CHECK(state IN ('waiting_for_answer','missing_mention_target','released','suppressed')),
            notification_reply_id TEXT REFERENCES outbound_replies(id) ON DELETE SET NULL,
            presentation_reply_id TEXT REFERENCES outbound_replies(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL,released_at TEXT,
            PRIMARY KEY(owner_kind,owner_id,owner_generation)
          );
          CREATE TABLE completion_choice_specifications(
            id TEXT PRIMARY KEY,
            owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn','primary-segment')),
            owner_id TEXT NOT NULL,owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),
            version INTEGER NOT NULL CHECK(version=1),question TEXT,default_option_id TEXT NOT NULL,invalid_reason TEXT,created_at TEXT NOT NULL,
            UNIQUE(owner_kind,owner_id,owner_generation)
          );
          CREATE TABLE completion_choice_options(
            specification_id TEXT NOT NULL REFERENCES completion_choice_specifications(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL CHECK(ordinal>=0),option_id TEXT NOT NULL,label TEXT NOT NULL,message TEXT NOT NULL,
            PRIMARY KEY(specification_id,option_id),UNIQUE(specification_id,ordinal)
          );
          CREATE TABLE completion_action_sets(
            id TEXT PRIMARY KEY,
            owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn','primary-segment')),
            owner_id TEXT NOT NULL,owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),
            binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
            binding_generation INTEGER NOT NULL CHECK(binding_generation>=1),
            page_index INTEGER NOT NULL CHECK(page_index>=0),card_id TEXT NOT NULL,card_message_id TEXT NOT NULL,
            mention_open_id TEXT,state TEXT NOT NULL CHECK(state IN ('available','consumed','superseded','unavailable')),
            selected_action TEXT CHECK(selected_action IN ('default','approve','continue','reject')),
            result_source_key TEXT,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,decided_at TEXT,
            choice_specification_id TEXT REFERENCES completion_choice_specifications(id),selected_choice_option_id TEXT,
            UNIQUE(owner_kind,owner_id,owner_generation)
          );
          INSERT INTO completion_choice_specifications(
            id,owner_kind,owner_id,owner_generation,version,question,default_option_id,invalid_reason,created_at
          ) SELECT
            id,owner_kind,owner_id,owner_generation,version,question,default_option_id,${legacyInvalidReason},created_at
          FROM completion_choice_specifications_legacy;
          INSERT INTO completion_choice_options SELECT * FROM completion_choice_options_legacy;
          INSERT INTO completion_action_sets(
            id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,card_id,card_message_id,
            mention_open_id,state,selected_action,result_source_key,reason,created_at,updated_at,decided_at,
            choice_specification_id,selected_choice_option_id
          ) SELECT
            id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,card_id,card_message_id,
            mention_open_id,state,selected_action,result_source_key,reason,created_at,updated_at,decided_at,
            choice_specification_id,selected_choice_option_id
          FROM completion_action_sets_legacy;
          INSERT INTO completion_notification_obligations(
            owner_kind,owner_id,owner_generation,binding_id,binding_generation,required_view_version,
            mention_open_id,notice_kind,state,notification_reply_id,presentation_reply_id,created_at,updated_at,released_at
          ) SELECT legacy.owner_kind,legacy.owner_id,legacy.owner_generation,legacy.binding_id,legacy.binding_generation,
            legacy.required_view_version,
            (SELECT action.mention_open_id FROM completion_action_sets action
              WHERE action.owner_kind=legacy.owner_kind AND action.owner_id=legacy.owner_id
                AND action.owner_generation=legacy.owner_generation),
            'choice',legacy.state,legacy.notification_reply_id,NULL,legacy.created_at,legacy.updated_at,legacy.released_at
          FROM completion_notification_obligations_legacy legacy;
          DROP TABLE completion_choice_options_legacy;
          DROP TABLE completion_action_sets_legacy;
          DROP TABLE completion_choice_specifications_legacy;
          DROP TABLE completion_notification_obligations_legacy;
          CREATE INDEX completion_notification_obligations_waiting
            ON completion_notification_obligations(state,owner_kind,updated_at,owner_id);
            CREATE INDEX completion_action_sets_available
              ON completion_action_sets(state,owner_kind,binding_id,binding_generation,updated_at,owner_id);
          `);
          assertMigrationLease(context, leaseAuthorization);
        });
      } finally {
        context.database.exec("PRAGMA legacy_alter_table = OFF");
      }
      if (restoreCompletionReviewExpansion) {
        assertMigrationLease(context, leaseAuthorization);
        rebuildCompletionActionSetsForCompletionReview(context);
        assertMigrationLease(context, leaseAuthorization);
      }
    }
  },
  {
    id: 125,
    name: "session-activity-agent-identities",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.session-activity-agent-identities", () => {
        assertMigrationLease(context, leaseAuthorization);
        context.database.exec(`
          CREATE TABLE IF NOT EXISTS session_activity_agent_identities(
            scope_key TEXT NOT NULL,producer_kind TEXT NOT NULL CHECK(producer_kind IN ('primary','worker')),producer_id TEXT NOT NULL,agent_id TEXT NOT NULL,
            producer_generation INTEGER NOT NULL CHECK(producer_generation>=1),producer_session_generation INTEGER NOT NULL CHECK(producer_session_generation>=1),
            display_name TEXT,display_name_lane_sequence INTEGER CHECK(display_name_lane_sequence IS NULL OR display_name_lane_sequence>=0),display_name_event_id TEXT,
            model TEXT,model_lane_sequence INTEGER CHECK(model_lane_sequence IS NULL OR model_lane_sequence>=0),model_event_id TEXT,
            source_lane_sequence INTEGER NOT NULL CHECK(source_lane_sequence>=0),source_event_id TEXT NOT NULL,updated_at TEXT NOT NULL,
            PRIMARY KEY(scope_key,producer_kind,producer_id,agent_id),
            FOREIGN KEY(scope_key,producer_kind,producer_id) REFERENCES session_activity_snapshots(scope_key,producer_kind,producer_id) ON DELETE CASCADE,
            CHECK((display_name IS NULL AND display_name_lane_sequence IS NULL AND display_name_event_id IS NULL)
              OR (display_name IS NOT NULL AND display_name_lane_sequence IS NOT NULL AND display_name_event_id IS NOT NULL)),
            CHECK((model IS NULL AND model_lane_sequence IS NULL AND model_event_id IS NULL)
              OR (model IS NOT NULL AND model_lane_sequence IS NOT NULL AND model_event_id IS NOT NULL)),
            CHECK(display_name IS NOT NULL OR model IS NOT NULL)
          );
          CREATE INDEX IF NOT EXISTS session_activity_agent_identities_source
            ON session_activity_agent_identities(scope_key,producer_kind,producer_id,source_lane_sequence,source_event_id);
        `);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 126,
    name: "completion-review-action-set-lifecycle",
    apply(context, leaseAuthorization) {
      assertMigrationLease(context, leaseAuthorization);
      rebuildCompletionActionSetsForCompletionReview(context);
      assertMigrationLease(context, leaseAuthorization);
    }
  },
  {
    id: 127,
    name: "canonical-input-recovery-auto-close",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.canonical-input-recovery-auto-close", () => {
        assertMigrationLease(context, leaseAuthorization);
        const definition = context.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='canonical_input_recovery_attempts'").get() as { sql?: string } | undefined;
        if (!definition) return;
        if (definition.sql?.includes("'auto_closed'")) {
          context.database.prepare("UPDATE canonical_input_recovery_attempts SET state='auto_closed' WHERE state='needs_human'").run();
          return;
        }
        context.database.exec(`
          CREATE TABLE canonical_input_recovery_attempts_next(
            submission_id TEXT PRIMARY KEY REFERENCES submission_intents(submission_id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK(state IN ('retry_wait','needs_human','auto_closed')),
            failure_code TEXT NOT NULL CHECK(failure_code IN ('indexing','not_found','ambiguous','unavailable')),
            attempt_count INTEGER NOT NULL CHECK(attempt_count >= 1), next_attempt_at TEXT, updated_at TEXT NOT NULL,
            CHECK((state='retry_wait' AND next_attempt_at IS NOT NULL) OR (state IN ('needs_human','auto_closed') AND next_attempt_at IS NULL))
          );
          INSERT INTO canonical_input_recovery_attempts_next(submission_id,state,failure_code,attempt_count,next_attempt_at,updated_at)
          SELECT submission_id,CASE WHEN state='needs_human' THEN 'auto_closed' ELSE state END,failure_code,attempt_count,next_attempt_at,updated_at
          FROM canonical_input_recovery_attempts;
          DROP TABLE canonical_input_recovery_attempts;
          ALTER TABLE canonical_input_recovery_attempts_next RENAME TO canonical_input_recovery_attempts;
          CREATE INDEX canonical_input_recovery_attempts_due
            ON canonical_input_recovery_attempts(state,next_attempt_at,submission_id);
        `);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 128,
    name: "replacement-recovery-identity-index",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.replacement-recovery-identity-index", () => {
        assertMigrationLease(context, leaseAuthorization);
        const recoveries = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_recoveries'").get();
        if (!recoveries) return;
        context.database.exec(`CREATE INDEX IF NOT EXISTS delivery_recoveries_replacement
          ON delivery_recoveries(replacement_reply_id) WHERE replacement_reply_id IS NOT NULL`);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 129,
    name: "retained-multi-agent-call-index",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.retained-multi-agent-call-index", () => {
        assertMigrationLease(context, leaseAuthorization);
        const inbox = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_event_inbox'").get();
        if (!inbox) return;
        context.database.exec(`CREATE INDEX IF NOT EXISTS core_event_inbox_multi_agent_call
          ON core_event_inbox(agent_kind,session_id,call_id,event_id)
          WHERE event_type='tool_call' AND payload_compacted_at IS NULL
            AND json_extract(event_json,'$.payload.name') IN (
              'multi_agent_v1__spawn_agent','multi_agent_v1__wait_agent','multi_agent_v1__close_agent',
              'collaboration__spawn_agent','collaboration__wait_agent','collaboration__interrupt_agent','collaboration__close_agent'
            )`);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 130,
    name: "canonical-recovery-recovered-state",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.canonical-recovery-recovered-state", () => {
        assertMigrationLease(context, leaseAuthorization);
        const definition = context.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='canonical_input_recovery_attempts'")
          .get() as { sql?: string } | undefined;
        if (!definition || definition.sql?.includes("'recovered'")) return;
        context.database.exec(`
          ALTER TABLE canonical_input_recovery_attempts RENAME TO canonical_input_recovery_attempts_previous;
          CREATE TABLE canonical_input_recovery_attempts(
            submission_id TEXT PRIMARY KEY REFERENCES submission_intents(submission_id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK(state IN ('retry_wait','needs_human','auto_closed','recovered')),
            failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN ('indexing','not_found','ambiguous','unavailable')),
            attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0), next_attempt_at TEXT, updated_at TEXT NOT NULL,
            CHECK((state='retry_wait' AND failure_code IS NOT NULL AND attempt_count>=1 AND next_attempt_at IS NOT NULL)
              OR (state IN ('needs_human','auto_closed') AND failure_code IS NOT NULL AND attempt_count>=1 AND next_attempt_at IS NULL)
              OR (state='recovered' AND failure_code IS NULL AND attempt_count=0 AND next_attempt_at IS NULL))
          );
          INSERT INTO canonical_input_recovery_attempts(
            submission_id,state,failure_code,attempt_count,next_attempt_at,updated_at
          ) SELECT submission_id,state,failure_code,attempt_count,next_attempt_at,updated_at
            FROM canonical_input_recovery_attempts_previous;
          DROP TABLE canonical_input_recovery_attempts_previous;
          CREATE INDEX canonical_input_recovery_attempts_due
            ON canonical_input_recovery_attempts(state,next_attempt_at,submission_id);
        `);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 131,
    name: "retained-checkpoint-session-index",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.retained-checkpoint-session-index", () => {
        assertMigrationLease(context, leaseAuthorization);
        const checkpoints = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_event_lane_checkpoints'").get();
        if (!checkpoints) return;
        context.database.exec(`CREATE INDEX IF NOT EXISTS core_event_lane_checkpoints_session
          ON core_event_lane_checkpoints(agent_kind,session_id,lane_id)`);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 132,
    name: "retained-recovery-checkpoint",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.retained-recovery-checkpoint", () => {
        assertMigrationLease(context, leaseAuthorization);
        const columns = new Set((context.database.prepare("PRAGMA table_info(session_activity_snapshots)").all() as Array<{ name: string }>).map(({ name }) => name));
        if (!columns.has("retained_recovery_lane_id")) {
          context.database.exec("ALTER TABLE session_activity_snapshots ADD COLUMN retained_recovery_lane_id TEXT");
        }
        if (!columns.has("retained_recovery_lane_sequence")) {
          context.database.exec("ALTER TABLE session_activity_snapshots ADD COLUMN retained_recovery_lane_sequence INTEGER NOT NULL DEFAULT 0 CHECK(retained_recovery_lane_sequence>=0)");
        }
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 133,
    name: "pane-topology-intents",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.pane-topology-intents", () => {
        assertMigrationLease(context, leaseAuthorization);
        context.database.exec(`CREATE TABLE IF NOT EXISTS pane_topology_intents(
          id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,
          owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary','worker')),owner_id TEXT NOT NULL,
          owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),owner_session_generation INTEGER NOT NULL CHECK(owner_session_generation>=1),
          parent_binding_id TEXT,parent_binding_generation INTEGER CHECK(parent_binding_generation IS NULL OR parent_binding_generation>=1),
          parent_session_generation INTEGER CHECK(parent_session_generation IS NULL OR parent_session_generation>=1),parent_pane_id TEXT,
          workspace_id TEXT NOT NULL,expected_pane_id TEXT NOT NULL,expected_terminal_id TEXT NOT NULL,
          expected_agent_session_id TEXT NOT NULL,expected_tab_id TEXT NOT NULL,expected_pane_label TEXT NOT NULL,expected_tab_label TEXT NOT NULL,
          target_tab_id TEXT NOT NULL,target_anchor_pane_id TEXT NOT NULL,desired_pane_label TEXT NOT NULL,desired_tab_label TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','executing','uncertain','succeeded','stale')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
          result_previous_pane_id TEXT,result_pane_id TEXT,result_tab_id TEXT,detail TEXT,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT,
          CHECK((owner_kind='primary' AND parent_binding_id IS NULL AND parent_binding_generation IS NULL AND parent_session_generation IS NULL AND parent_pane_id IS NULL)
            OR (owner_kind='worker' AND parent_binding_id IS NOT NULL AND parent_binding_generation IS NOT NULL AND parent_session_generation IS NOT NULL AND parent_pane_id IS NOT NULL)),
          CHECK((state='succeeded' AND result_previous_pane_id IS NOT NULL AND result_pane_id IS NOT NULL AND result_tab_id IS NOT NULL AND completed_at IS NOT NULL)
            OR (state!='succeeded' AND completed_at IS NULL))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS pane_topology_intents_active_owner
          ON pane_topology_intents(owner_kind,owner_id,owner_generation,owner_session_generation)
          WHERE state IN ('pending','executing','uncertain');
        CREATE INDEX IF NOT EXISTS pane_topology_intents_recovery
          ON pane_topology_intents(state,updated_at,id);
        `);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 134,
    name: "worker-delivery-parent-pane",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.worker-delivery-parent-pane", () => {
        assertMigrationLease(context, leaseAuthorization);
        const outbox = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbound_replies'").get();
        if (!outbox) return;
        const columns = new Set((context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
        if (!columns.has("delivery_parent_pane_id")) {
          context.database.exec("ALTER TABLE outbound_replies ADD COLUMN delivery_parent_pane_id TEXT");
        }
        context.database.prepare(`UPDATE outbound_replies SET delivery_parent_pane_id=scope_pane_id
          WHERE delivery_owner_kind='worker' AND delivery_parent_pane_id IS NULL`).run();
        const invalid = context.database.prepare(`SELECT id FROM outbound_replies
          WHERE (delivery_owner_kind='worker' AND (delivery_parent_pane_id IS NULL OR length(delivery_parent_pane_id)=0))
            OR (delivery_owner_kind IS NOT 'worker' AND delivery_parent_pane_id IS NOT NULL) LIMIT 1`).get() as { id: string } | undefined;
        if (invalid) throw new Error(`Worker Delivery parent Pane backfill is incomplete for ${invalid.id}`);
        context.database.exec(`
          DROP TRIGGER IF EXISTS outbound_replies_valid_delivery_scope_insert;
          DROP TRIGGER IF EXISTS outbound_replies_valid_delivery_scope_update;
          ${contractedDeliveryScopeTriggersSql(true)}
        `);
        const immutable = context.database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='outbound_replies_immutable_claim'").get() as { sql: string } | undefined;
        if (!immutable?.sql) throw new Error("Worker Delivery parent Pane migration requires outbound claim immutability");
        if (!immutable.sql.includes("delivery_parent_pane_id")) {
          const columnAnchor = "delivery_parent_session_generation,";
          const changeAnchor = "NEW.delivery_parent_session_generation IS NOT OLD.delivery_parent_session_generation OR";
          if (!immutable.sql.includes(columnAnchor) || !immutable.sql.includes(changeAnchor)) {
            throw new Error("Worker Delivery parent Pane migration cannot extend outbound claim immutability safely");
          }
          const next = immutable.sql
            .replace(columnAnchor, `delivery_parent_session_generation, delivery_parent_pane_id,`)
            .replace(changeAnchor, `${changeAnchor} NEW.delivery_parent_pane_id IS NOT OLD.delivery_parent_pane_id OR`);
          context.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
          context.database.exec(next);
        }
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 135,
    name: "collaboration-multi-agent-call-index",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.collaboration-multi-agent-call-index", () => {
        assertMigrationLease(context, leaseAuthorization);
        const inbox = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_event_inbox'").get();
        if (!inbox) return;
        context.database.exec(`
          DROP INDEX IF EXISTS core_event_inbox_multi_agent_call;
          CREATE INDEX core_event_inbox_multi_agent_call
            ON core_event_inbox(agent_kind,session_id,call_id,event_id)
            WHERE event_type='tool_call' AND payload_compacted_at IS NULL
              AND json_extract(event_json,'$.payload.name') IN (
                'multi_agent_v1__spawn_agent','multi_agent_v1__wait_agent','multi_agent_v1__close_agent',
                'collaboration__spawn_agent','collaboration__wait_agent','collaboration__interrupt_agent','collaboration__close_agent'
              )
        `);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 136,
    name: "historical-core-recovery-index",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.historical-core-recovery-index", () => {
        assertMigrationLease(context, leaseAuthorization);
        const lanes = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_event_lane_items'").get();
        if (!lanes) return;
        context.database.exec(`CREATE INDEX IF NOT EXISTS core_event_lane_history_pending
          ON core_event_lane_items(state,created_at,lane_id,sequence,event_id)`);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 137,
    name: "historical-missing-page-index",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.historical-missing-page-index", () => {
        assertMigrationLease(context, leaseAuthorization);
        const pages = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_segment_pages'").get();
        if (!pages) return;
        context.database.exec(`CREATE INDEX IF NOT EXISTS conversation_segment_pages_history_missing
          ON conversation_segment_pages(updated_at,segment_id,page_index)
          WHERE message_id IS NULL AND pending_reply_id IS NULL AND state IN ('creating','finished')`);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 138,
    name: "typed-human-input-message",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.typed-human-input-message", () => {
        assertMigrationLease(context, leaseAuthorization);
        if (!context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='submission_intents'").get()) return;
        const columns = new Set((context.database.prepare("PRAGMA table_info(submission_intents)").all() as Array<{ name: string }>).map(({ name }) => name));
        if (!columns.has("input_json")) {
          context.database.exec(`ALTER TABLE submission_intents ADD COLUMN input_json TEXT NOT NULL DEFAULT '{"schemaVersion":2,"text":""}' CHECK(json_valid(input_json))`);
        }
        context.database.prepare(`UPDATE submission_intents
          SET input_json=json_object('schemaVersion',2,'text',text)
          WHERE json_extract(input_json,'$.schemaVersion') IS NULL
             OR json_extract(input_json,'$.text') IS NOT text`).run();
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 139,
    name: "completion-choice-compatibility-reason",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.completion-choice-compatibility-reason", () => {
        assertMigrationLease(context, leaseAuthorization);
        if (!context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='completion_choice_specifications'").get()) return;
        const columns = new Set((context.database.prepare("PRAGMA table_info(completion_choice_specifications)").all() as Array<{ name: string }>).map(({ name }) => name));
        if (!columns.has("invalid_reason")) context.database.exec("ALTER TABLE completion_choice_specifications ADD COLUMN invalid_reason TEXT");
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 140,
    name: "core-event-lane-conflict-diagnostics",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.core-event-lane-conflict-diagnostics", () => {
        assertMigrationLease(context, leaseAuthorization);
        if (!context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='core_event_lane_items'").get()) return;
        const columns = new Set((context.database.prepare("PRAGMA table_info(core_event_lane_items)").all() as Array<{ name: string }>).map(({ name }) => name));
        const definitions = [
          ["conflict_count", "INTEGER NOT NULL DEFAULT 0 CHECK(conflict_count >= 0)"],
          ["last_conflict_hash", "TEXT"],
          ["last_conflict_reason", "TEXT"],
          ["last_conflict_at", "TEXT"]
        ] as const;
        for (const [name, definition] of definitions) {
          if (!columns.has(name)) context.database.exec(`ALTER TABLE core_event_lane_items ADD COLUMN ${name} ${definition}`);
        }
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 141,
    name: "runtime-identity-claim-owner",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.runtime-identity-claim-owner", () => {
        assertMigrationLease(context, leaseAuthorization);
        createRuntimeIdentityClaimSchema(context.database, false);
        const hasBindings = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bindings'").get();
        if (!hasBindings) {
          context.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS runtime_identity_claims_current_native_identity
            ON runtime_identity_claims(native_session_source,native_session_agent,native_session_kind,native_session_value)
            WHERE state = 'current'`);
          return;
        }
        const existing = context.database.prepare("SELECT 1 FROM runtime_identity_claims LIMIT 1").get();
        if (!existing) backfillRuntimeIdentityClaims(context.database);
        assertCurrentRuntimeIdentityClaimBindingProjectionIntegrity(context.database);
        const duplicate = context.database.prepare(`SELECT native_session_source FROM runtime_identity_claims
          WHERE state='current' GROUP BY native_session_source,native_session_agent,native_session_kind,native_session_value HAVING COUNT(*) > 1 LIMIT 1`).get();
        if (duplicate) throw new Error("Runtime identity migration produced multiple current owners");
        context.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS runtime_identity_claims_current_native_identity
          ON runtime_identity_claims(native_session_source,native_session_agent,native_session_kind,native_session_value)
          WHERE state = 'current'`);
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 142,
    name: "worker-actionable-page-keyset",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.worker-actionable-page-keyset", () => {
        assertMigrationLease(context, leaseAuthorization);
        new WorkerMigrations(context).ensureActionableWorkerTurnPageIndex();
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 143,
    name: "completed-project-selection-page-keyset",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.completed-project-selection-page-keyset", () => {
        assertMigrationLease(context, leaseAuthorization);
        new BindingSessionMigrations(context).ensureCompletedProjectSelectionPageIndex();
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  },
  {
    id: 144,
    name: "conversation-actionable-page-keyset",
    apply(context, leaseAuthorization) {
      context.migrationTransaction("sqlite.migrations.conversation-actionable-page-keyset", () => {
        assertMigrationLease(context, leaseAuthorization);
        new ConversationSegmentMigrations(context).ensureActionableConversationSegmentPageIndex();
        assertMigrationLease(context, leaseAuthorization);
      });
    }
  }
]);

type LegacyRuntimeIdentityBinding = {
  id: string;
  generation: number;
  session_epoch: number;
  workspace_id: string;
  pane_id: string | null;
  traex_session_id: string | null;
  attachment: string;
  lifecycle: string;
  state: string;
  agent_session_source: string | null;
  agent_session_agent: string | null;
  agent_session_kind: "id" | "path" | null;
  agent_session_value: string | null;
  created_at: string;
  updated_at: string;
};

function backfillRuntimeIdentityClaims(database: DatabaseSync): void {
  const rows = database.prepare(`SELECT id,generation,session_epoch,workspace_id,pane_id,traex_session_id,attachment,lifecycle,state,
    agent_session_source,agent_session_agent,agent_session_kind,agent_session_value,created_at,updated_at FROM bindings ORDER BY created_at,id`).all() as LegacyRuntimeIdentityBinding[];
  const states = new Map<LegacyRuntimeIdentityBinding, "current" | "unclaimed" | "conflicted" | "released">();
  const complete = (row: LegacyRuntimeIdentityBinding) => Boolean(row.agent_session_source?.trim() && row.agent_session_agent?.trim() && row.agent_session_kind && row.agent_session_value?.trim());
  const archived = (row: LegacyRuntimeIdentityBinding) => row.state === "archived" || row.lifecycle === "archived" || row.lifecycle === "closed";
  const candidate = (row: LegacyRuntimeIdentityBinding) => !archived(row) && (row.attachment === "attached" || row.attachment === "orphaned" || row.attachment === "degraded") && Boolean(row.pane_id && row.traex_session_id);
  const identityKey = (row: LegacyRuntimeIdentityBinding) => JSON.stringify([row.agent_session_source?.trim(), row.agent_session_agent?.trim(), row.agent_session_kind, row.agent_session_value?.trim()]);
  const groups = new Map<string, LegacyRuntimeIdentityBinding[]>();
  for (const row of rows) {
    if (!complete(row)) { states.set(row, "unclaimed"); continue; }
    const group = groups.get(identityKey(row)) ?? [];
    group.push(row);
    groups.set(identityKey(row), group);
  }
  for (const group of groups.values()) {
    const live = group.filter(candidate);
    const attached = live.filter((row) => row.attachment === "attached");
    if (live.length === 1) {
      states.set(live[0]!, "current");
      for (const row of group) if (row !== live[0]) states.set(row, "released");
    } else if (attached.length === 1 && live.every((row) => row.attachment === "attached" || row.attachment === "orphaned")) {
      states.set(attached[0]!, "current");
      for (const row of group) if (row !== attached[0]) states.set(row, "released");
    } else if (live.length > 1) {
      for (const row of live) states.set(row, "conflicted");
      for (const row of group) if (!candidate(row)) states.set(row, "released");
    } else {
      for (const row of group) states.set(row, "released");
    }
  }
  const insert = database.prepare(`INSERT INTO runtime_identity_claims(
    binding_id,binding_generation,session_epoch,state,native_session_source,native_session_agent,native_session_kind,native_session_value,
    attachment_state,workspace_id,pane_id,terminal_id,last_rejected_evidence_fingerprint,last_rejected_reason,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    const state = states.get(row)!;
    const identity = complete(row);
    const attachment = state === "current" || state === "conflicted"
      ? row.attachment === "orphaned" ? "orphaned" : "attached"
      : null;
    insert.run(
      row.id, row.generation, row.session_epoch, state,
      identity ? row.agent_session_source!.trim() : null, identity ? row.agent_session_agent!.trim() : null, identity ? row.agent_session_kind : null, identity ? row.agent_session_value!.trim() : null,
      attachment, attachment ? row.workspace_id : null, attachment ? row.pane_id : null, attachment ? row.traex_session_id : null,
      null, null, row.created_at, row.updated_at
    );
  }
}

function assertCurrentRuntimeIdentityClaimBindingProjectionIntegrity(database: DatabaseSync): void {
  const divergent = database.prepare(`SELECT claim.binding_id
    FROM runtime_identity_claims claim
    LEFT JOIN bindings binding ON binding.id=claim.binding_id
      AND binding.generation=claim.binding_generation
      AND binding.session_epoch=claim.session_epoch
    WHERE claim.state='current' AND (
      binding.id IS NULL
      OR binding.workspace_id IS NOT claim.workspace_id
      OR binding.pane_id IS NOT claim.pane_id
      OR binding.traex_session_id IS NOT claim.terminal_id
      OR binding.agent_session_source IS NOT claim.native_session_source
      OR binding.agent_session_agent IS NOT claim.native_session_agent
      OR binding.agent_session_kind IS NOT claim.native_session_kind
      OR binding.agent_session_value IS NOT claim.native_session_value
      OR CASE binding.attachment WHEN 'degraded' THEN 'attached' ELSE binding.attachment END IS NOT claim.attachment_state
    ) LIMIT 1`).get();
  if (divergent) throw new Error("Runtime identity claim Binding projection integrity violation");
}

export function prepareConversationActiveProjectionMigration(context: SqliteContext, leaseAuthorization?: ExclusiveMigrationLeaseAuthorization): void {
  const addColumns = (table: keyof typeof conversationProjectionTableLabels, columns: readonly (readonly [name: string, definition: string])[]) => {
    const existing = new Set((context.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));
    for (const [name, definition] of columns) {
      if (existing.has(name)) continue;
      const label = `sqlite.migrations.t5-${conversationProjectionTableLabels[table]}-${name}`.replaceAll("_", "-");
      context.migrationTransaction(label, () => {
        assertConversationMigrationFence(context, leaseAuthorization);
        context.database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      });
    }
  };
  addColumns("conversation_segments", [
    ["timeline_item_count", "INTEGER NOT NULL DEFAULT 0 CHECK(timeline_item_count >= 0)"],
    ["has_visible_assistant_content", "INTEGER NOT NULL DEFAULT 0 CHECK(has_visible_assistant_content IN (0,1))"]
  ]);
  addColumns("conversation_segment_pages", [
    ["start_lane_sequence", "INTEGER"], ["start_item_ordinal", "INTEGER"],
    ["cursor_base", "INTEGER NOT NULL DEFAULT 0 CHECK(cursor_base >= 0)"],
    ["start_anchor_inclusive", "INTEGER NOT NULL DEFAULT 1 CHECK(start_anchor_inclusive IN (0,1))"],
    ["continuation_lane_sequence", "INTEGER"], ["continuation_item_ordinal", "INTEGER"],
    ["continuation_anchor_inclusive", "INTEGER NOT NULL DEFAULT 1 CHECK(continuation_anchor_inclusive IN (0,1))"],
    ["continuation_cursor_base", "INTEGER"]
  ]);
  addColumns("conversation_segment_page_recovery_parts", [
    ["end_lane_sequence", "INTEGER"], ["end_item_ordinal", "INTEGER"],
    ["end_anchor_inclusive", "INTEGER NOT NULL DEFAULT 1 CHECK(end_anchor_inclusive IN (0,1))"]
  ]);
  context.migrationTransaction("sqlite.migrations.t5-late-recoveries-table", () => {
    assertConversationMigrationFence(context, leaseAuthorization);
    context.database.exec(`CREATE TABLE IF NOT EXISTS conversation_segment_late_recoveries(
      id INTEGER PRIMARY KEY AUTOINCREMENT,segment_id TEXT NOT NULL REFERENCES conversation_segments(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,lane_sequence INTEGER NOT NULL CHECK(lane_sequence>=0),item_ordinal INTEGER NOT NULL CHECK(item_ordinal>=0),
      source_event_id TEXT NOT NULL,part_index INTEGER NOT NULL DEFAULT 0 CHECK(part_index>=0),
      start_cursor_json TEXT CHECK(start_cursor_json IS NULL OR json_valid(start_cursor_json)),
      pending_cursor_json TEXT CHECK(pending_cursor_json IS NULL OR json_valid(pending_cursor_json)),
      reply_id TEXT UNIQUE REFERENCES outbound_replies(id) ON DELETE RESTRICT,message_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('queued','pending','delivered','failed')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  });

  reconcileConversationActiveProjectionMetadata(context, leaseAuthorization);
  for (const [label, sql] of [
    ["item-segment-index", "CREATE INDEX IF NOT EXISTS conversation_segment_items_item_segment ON conversation_segment_items(item_id,segment_id)"],
    ["one-current-index", "CREATE UNIQUE INDEX IF NOT EXISTS conversation_segment_pages_one_current ON conversation_segment_pages(segment_id) WHERE state IN ('creating','active')"],
    ["current-lookup-index", "CREATE INDEX IF NOT EXISTS conversation_segment_pages_current_lookup ON conversation_segment_pages(segment_id,page_index) WHERE state IN ('creating','active')"]
    ,["late-recovery-open-index", "CREATE UNIQUE INDEX IF NOT EXISTS conversation_segment_late_recoveries_open_item ON conversation_segment_late_recoveries(segment_id,item_id) WHERE state IN ('queued','pending')"]
    ,["late-recovery-state-index", "CREATE INDEX IF NOT EXISTS conversation_segment_late_recoveries_state ON conversation_segment_late_recoveries(state,segment_id,id)"]
  ] as const) context.migrationTransaction(`sqlite.migrations.t5-${label}`, () => {
    assertConversationMigrationFence(context, leaseAuthorization);
    context.database.exec(sql);
  });
}

const conversationProjectionTableLabels = {
  conversation_segments: "segments",
  conversation_segment_pages: "pages",
  conversation_segment_page_recovery_parts: "recovery-parts"
} as const;

function reconcileConversationActiveProjectionMetadata(context: SqliteContext, leaseAuthorization?: ExclusiveMigrationLeaseAuthorization): void {
  let afterSegmentId = "";
  for (;;) {
    const aggregates = context.database.prepare(`SELECT segment.id,
        (SELECT COUNT(*) FROM conversation_segment_items item WHERE item.segment_id=segment.id) AS item_count,
        EXISTS(SELECT 1 FROM conversation_segment_items item WHERE item.segment_id=segment.id
          AND json_extract(item.item_json,'$.kind') IN ('agent_message','final_answer')
          AND length(COALESCE(json_extract(item.item_json,'$.markdown'),''))>0 LIMIT 1) AS visible
      FROM conversation_segments segment WHERE segment.id>? ORDER BY segment.id LIMIT 100`).all(afterSegmentId) as Array<{ id: string; item_count: number; visible: number }>;
    if (aggregates.length === 0) break;
    for (const row of aggregates) context.migrationTransaction("sqlite.migrations.t5-segment-metadata", () => {
      assertConversationMigrationFence(context, leaseAuthorization);
      context.database.prepare(`UPDATE conversation_segments SET timeline_item_count=?,has_visible_assistant_content=?
        WHERE id=? AND (timeline_item_count<>? OR has_visible_assistant_content<>?)`)
        .run(row.item_count, row.visible, row.id, row.item_count, row.visible);
    });
    afterSegmentId = aggregates.at(-1)!.id;
  }

  let afterPageSegmentId = "";
  let afterPageIndex = -1;
  for (;;) {
    const pages = context.database.prepare(`SELECT segment_id,page_index,start_cursor_json,delivered_cursor_json
      FROM conversation_segment_pages
      WHERE (segment_id>? OR (segment_id=? AND page_index>?))
        AND ((start_cursor_json IS NOT NULL AND start_lane_sequence IS NULL)
          OR (state='frozen' AND delivered_cursor_json IS NOT NULL AND continuation_cursor_base IS NULL))
      ORDER BY segment_id,page_index LIMIT 100`).all(afterPageSegmentId, afterPageSegmentId, afterPageIndex) as Array<{ segment_id: string; page_index: number; start_cursor_json: string | null; delivered_cursor_json: string | null }>;
    if (pages.length === 0) break;
    for (const page of pages) {
    const resolve = (cursorJson: string | null | undefined) => {
      if (!cursorJson) return null;
      const cursor = JSON.parse(cursorJson) as { itemIndex?: number; markdownOffset?: number; offset?: number };
      const cursorBase = Math.max(0, Math.floor(cursor.itemIndex ?? 0));
      if (cursorBase === 0) return { cursorBase, anchor: null, inclusive: 1 };
      const offset = cursor.offset ?? cursor.markdownOffset ?? 0;
      const targetIndex = offset > 0 ? cursorBase : cursorBase;
      let anchor = context.database.prepare(`SELECT lane_sequence,item_ordinal FROM conversation_segment_items
        WHERE segment_id=? ORDER BY lane_sequence,item_ordinal,item_id LIMIT 1 OFFSET ?`).get(page.segment_id, targetIndex) as { lane_sequence: number; item_ordinal: number } | undefined;
      let inclusive = 1;
      if (!anchor && offset === 0) {
        anchor = context.database.prepare(`SELECT lane_sequence,item_ordinal FROM conversation_segment_items
          WHERE segment_id=? ORDER BY lane_sequence DESC,item_ordinal DESC,item_id DESC LIMIT 1`).get(page.segment_id) as { lane_sequence: number; item_ordinal: number } | undefined;
        inclusive = 0;
      }
      if (!anchor) throw new Error(`Conversation Segment ${page.segment_id} page cursor has no canonical anchor`);
      return { cursorBase, anchor, inclusive };
    };
    const start = resolve(page.start_cursor_json);
    const continuation = resolve(page.delivered_cursor_json);
      context.migrationTransaction("sqlite.migrations.t5-page-anchor", () => {
        assertConversationMigrationFence(context, leaseAuthorization);
        context.database.prepare(`UPDATE conversation_segment_pages
          SET start_lane_sequence=COALESCE(start_lane_sequence,?),start_item_ordinal=COALESCE(start_item_ordinal,?),
            cursor_base=CASE WHEN start_cursor_json IS NOT NULL THEN ? ELSE cursor_base END,start_anchor_inclusive=?,
            continuation_lane_sequence=COALESCE(continuation_lane_sequence,?),continuation_item_ordinal=COALESCE(continuation_item_ordinal,?),
            continuation_cursor_base=COALESCE(continuation_cursor_base,?),continuation_anchor_inclusive=?
          WHERE segment_id=? AND page_index=?`)
          .run(start?.anchor?.lane_sequence ?? null, start?.anchor?.item_ordinal ?? null, start?.cursorBase ?? 0, start?.inclusive ?? 1,
            continuation?.anchor?.lane_sequence ?? null, continuation?.anchor?.item_ordinal ?? null, continuation?.cursorBase ?? null, continuation?.inclusive ?? 1,
            page.segment_id, page.page_index);
      });
    }
    const last = pages.at(-1)!;
    afterPageSegmentId = last.segment_id;
    afterPageIndex = last.page_index;
  }
}

function assertMigrationLease(context: SqliteContext, authorization?: ExclusiveMigrationLeaseAuthorization): void {
  const now = Date.now();
  const leaseTable = context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='instance_lease'").get();
  if (!leaseTable) {
    if (authorization) throw new Error("Conversation projection bootstrap lease changed or no longer has a live matching owner and fencing token");
    return;
  }
  const hasExpiryMs = hasLeaseExpiryMilliseconds(context.database);
  const lease = context.database.prepare(`SELECT owner_id,fencing_token,expires_at${hasExpiryMs ? ",expires_at_ms" : ""}
    FROM instance_lease WHERE singleton_id=1`).get() as { owner_id: string; fencing_token: number; expires_at: string; expires_at_ms?: number } | undefined;
  if (authorization) {
    if (!lease || lease.owner_id !== authorization.ownerId || Number(lease.fencing_token) !== authorization.fencingToken || leaseExpiryMs(lease) <= now) {
      throw new Error("Conversation projection bootstrap lease changed or no longer has a live matching owner and fencing token");
    }
  } else if (lease && leaseExpiryMs(lease) > now) {
    throw new Error(`Conversation projection index migration requires lease release; owner ${lease.owner_id} is valid until ${lease.expires_at}`);
  }
}

function assertConversationMigrationFence(context: SqliteContext, authorization?: ExclusiveMigrationLeaseAuthorization): void {
  const duplicateCurrent = context.database.prepare(`SELECT segment_id FROM conversation_segment_pages
    WHERE state IN ('creating','active') GROUP BY segment_id HAVING COUNT(*)>1 LIMIT 1`).get() as { segment_id: string } | undefined;
  if (duplicateCurrent) throw new Error(`Conversation Segment ${duplicateCurrent.segment_id} has multiple current pages`);
  assertMigrationLease(context, authorization);
}

export function applyOrderedMigrations(context: SqliteContext, leaseAuthorization?: ExclusiveMigrationLeaseAuthorization): void {
  for (const migration of orderedMigrations) {
    if (context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(migration.id)) continue;
    migration.apply(context, leaseAuthorization);
    context.migrationTransaction(`sqlite.migrations.record-${migration.id}`, () => {
      assertMigrationLease(context, leaseAuthorization);
      recordRegisteredMigration(context.database, migration.id);
    });
  }
}

/** A retained post-legacy marker is durable evidence of T3-era ownership. */
export function hasAppliedOrderedMigration(database: DatabaseSync): boolean {
  return orderedMigrations.some((migration) => database.prepare(
    "SELECT 1 FROM schema_migrations WHERE version = ?"
  ).get(migration.id) !== undefined);
}

/**
 * A fresh baseline installs only released physical history here, then invokes
 * applyOrderedMigrations() for every post-111 declaration.  No other module
 * may write parameterised migration markers.
 */
export function installReleasedLegacyMigrationMarkers(database: DatabaseSync): void {
  database.exec("DELETE FROM schema_migrations");
  const insert = database.prepare("INSERT INTO schema_migrations(version) VALUES (?)");
  for (const marker of RELEASED_LEGACY_MARKERS) insert.run(marker);
}

function integerRange(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
