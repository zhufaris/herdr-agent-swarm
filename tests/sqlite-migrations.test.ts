import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteMigrations } from "../src/store/sqlite/migrations.js";
import {
  CURRENT_SCHEMA_EPOCH,
  canonicalMigrationMarkers,
  canonicalSchemaCatalog,
  legacyMigrationRequirements,
  readSchemaMetadata,
  validateCanonicalSchema
} from "../src/store/sqlite/schema-manifest.js";
import { applyOrderedMigrations, defineOrderedMigrations, orderedMigrations, prepareConversationActiveProjectionMigration } from "../src/store/sqlite/migration-registry.js";
import { repairLegacyMarker89Obligations } from "../src/store/sqlite/migrations/legacy-marker-89-migrations.js";
import { WorkerMigrations } from "../src/store/sqlite/migrations/worker-migrations.js";
import { runWithExclusiveMigrationLock } from "../src/store/sqlite/exclusive-migration-lock.js";
import { createInstanceLeaseSchema } from "../src/store/sqlite/schema.js";
import { createCurrentSchemaTestStoreBundle } from "./helpers/create-test-store-bundle.js";
import { SqliteOperationsStore } from "../src/store/sqlite/operations-store.js";
import { backupSqliteDatabase, validateSqliteMaintenanceDatabase } from "../src/store/sqlite-maintenance.js";
import { RETAINED_MULTI_AGENT_ACTIVITY_QUERY } from "../src/store/sqlite/session-activity-store.js";

type SchemaMigrationResult = {
  route: "fresh-baseline" | "current-fast" | "compatibility";
  compatibilityStepCount: number;
  epoch: string;
  fingerprint: string;
};

type CanonicalSchemaCatalog = {
  tables: readonly string[];
  indexes: readonly string[];
  triggers: readonly string[];
  views: readonly string[];
  markers: readonly number[];
};

type CurrentFixtureBundle = {
  schemaMigration: SchemaMigrationResult;
  driver: {
    database: DatabaseSync;
    close(): void;
  };
};

const contexts: SqliteContext[] = [];
const currentFixtureBundles: CurrentFixtureBundle[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const bundle of currentFixtureBundles.splice(0)) bundle.driver.close();
  for (const context of contexts.splice(0)) context.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite current-schema metadata and compatibility routes", () => {
  it("classifies schema-140 runtime identity evidence before creating the current-owner unique index", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DROP TABLE runtime_identity_claims;
      DELETE FROM schema_migrations WHERE version=141;
      UPDATE schema_metadata SET epoch='2026-10-18.1';
    `);
    insertRuntimeIdentityBinding(context.database, { id: "attached", paneId: "pane-attached", terminalId: "terminal-attached", session: "session-attached", attachment: "attached" });
    insertRuntimeIdentityBinding(context.database, { id: "orphan", paneId: "pane-orphan", terminalId: "terminal-orphan", session: "session-orphan", attachment: "orphaned" });
    insertRuntimeIdentityBinding(context.database, { id: "duplicate-attached", paneId: "pane-duplicate-attached", terminalId: "terminal-duplicate-attached", session: "session-duplicate", attachment: "attached" });
    insertRuntimeIdentityBinding(context.database, { id: "duplicate-orphan", paneId: "pane-duplicate-orphan", terminalId: "terminal-duplicate-orphan", session: "session-duplicate", attachment: "orphaned" });
    insertRuntimeIdentityBinding(context.database, { id: "incomplete", paneId: "pane-incomplete", terminalId: "terminal-incomplete", session: null, attachment: "attached" });
    insertRuntimeIdentityBinding(context.database, { id: "degraded", paneId: "pane-degraded", terminalId: "terminal-degraded", session: "session-degraded", attachment: "degraded" });
    insertRuntimeIdentityBinding(context.database, { id: "conflict-one", paneId: "pane-conflict-one", terminalId: "terminal-conflict-one", session: "session-conflict", attachment: "attached" });
    insertRuntimeIdentityBinding(context.database, { id: "conflict-two", paneId: "pane-conflict-two", terminalId: "terminal-conflict-two", session: "session-conflict", attachment: "attached" });
    insertRuntimeIdentityBinding(context.database, { id: "archived", paneId: "pane-archived", terminalId: "terminal-archived", session: "session-archived", attachment: "unattached", state: "archived", lifecycle: "archived" });

    expect(run(context)).toMatchObject({ route: "compatibility", epoch: CURRENT_SCHEMA_EPOCH });
    const claims = context.database.prepare("SELECT binding_id,state,attachment_state FROM runtime_identity_claims ORDER BY binding_id").all();
    expect(claims).toEqual([
      { binding_id: "archived", state: "released", attachment_state: null },
      { binding_id: "attached", state: "current", attachment_state: "attached" },
      { binding_id: "conflict-one", state: "conflicted", attachment_state: "attached" },
      { binding_id: "conflict-two", state: "conflicted", attachment_state: "attached" },
      { binding_id: "degraded", state: "current", attachment_state: "attached" },
      { binding_id: "duplicate-attached", state: "current", attachment_state: "attached" },
      { binding_id: "duplicate-orphan", state: "released", attachment_state: null },
      { binding_id: "incomplete", state: "unclaimed", attachment_state: null },
      { binding_id: "orphan", state: "current", attachment_state: "orphaned" }
    ]);
    expect(context.database.prepare("SELECT attachment FROM bindings WHERE id='degraded'").get()).toEqual({ attachment: "degraded" });
    expect(() => context.database.prepare(`INSERT INTO runtime_identity_claims(
      binding_id,binding_generation,session_epoch,state,native_session_source,native_session_agent,native_session_kind,native_session_value,
      attachment_state,workspace_id,pane_id,terminal_id,created_at,updated_at
    ) VALUES ('conflict-one',2,1,'current','herdr:traex','traex','id','session-attached','attached','workspace','other-pane','other-terminal','t','t')`).run()).toThrow(/UNIQUE/i);
    expect(run(context)).toMatchObject({ route: "current-fast" });
  });

  it("rejects migration 141 when an existing current claim diverges from its Binding projection", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DROP INDEX runtime_identity_claims_current_native_identity;
      DELETE FROM schema_migrations WHERE version=141;
      UPDATE schema_metadata SET epoch='2026-10-18.1';
    `);
    insertRuntimeIdentityBinding(context.database, {
      id: "divergent-owner",
      paneId: "binding-pane",
      terminalId: "binding-terminal",
      session: "binding-session",
      attachment: "attached"
    });
    context.database.prepare(`INSERT INTO runtime_identity_claims(
      binding_id,binding_generation,session_epoch,state,native_session_source,native_session_agent,native_session_kind,native_session_value,
      attachment_state,workspace_id,pane_id,terminal_id,created_at,updated_at
    ) VALUES ('divergent-owner',1,1,'current','herdr:traex','traex','id','binding-session','attached','workspace','claim-pane','binding-terminal','t','t')`).run();

    expect(() => run(context)).toThrow(/runtime identity claim.*binding projection.*integrity/i);
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=141").get()).toBeUndefined();
    expect(context.database.prepare("SELECT pane_id FROM runtime_identity_claims WHERE binding_id='divergent-owner'").get()).toEqual({ pane_id: "claim-pane" });
  });
  it("installs the Completion Review lifecycle schema and indexes on a fresh database", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });

    expect(columnNames(context.database, "completion_action_sets")).toEqual(expect.arrayContaining([
      "presentation_kind", "presentation_generation", "presentation_reply_id", "presentation_message_id", "presentation_card_id"
    ]));
    const definition = context.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='completion_action_sets'").get() as { sql: string };
    expect(definition.sql).toContain("'provisional'");
    expect(definition.sql).toContain("'presenting'");
    expect(definition.sql).toContain("'active'");
    expect(schemaObjects(context.database)).toEqual(expect.arrayContaining([
      "completion_action_sets_owner_state", "completion_action_sets_presentation_reply",
      "conversation_segments_actionable_page_keyset"
    ]));
  });

  it("adds bounded Core event conflict diagnostics through an idempotent ordered migration", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });
    const expectedColumns = ["conflict_count", "last_conflict_hash", "last_conflict_reason", "last_conflict_at"];
    expect(columnNames(context.database, "core_event_lane_items")).toEqual(expect.arrayContaining(expectedColumns));

    context.database.exec(`
      ALTER TABLE core_event_lane_items DROP COLUMN conflict_count;
      ALTER TABLE core_event_lane_items DROP COLUMN last_conflict_hash;
      ALTER TABLE core_event_lane_items DROP COLUMN last_conflict_reason;
      ALTER TABLE core_event_lane_items DROP COLUMN last_conflict_at;
      DELETE FROM schema_migrations WHERE version=140;
    `);

    const migration = orderedMigrations.find(({ id }) => id === 140);
    if (!migration) throw new Error("migration 140 is missing");
    migration.apply(context);
    migration.apply(context);
    expect(columnNames(context.database, "core_event_lane_items")).toEqual(expect.arrayContaining(expectedColumns));
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=140").get()).toBeUndefined();
  });

  it("upgrades the previous current epoch through migration 140 before fast-open validation", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });
    context.database.exec(`
      ALTER TABLE core_event_lane_items DROP COLUMN conflict_count;
      ALTER TABLE core_event_lane_items DROP COLUMN last_conflict_hash;
      ALTER TABLE core_event_lane_items DROP COLUMN last_conflict_reason;
      ALTER TABLE core_event_lane_items DROP COLUMN last_conflict_at;
      DELETE FROM schema_migrations WHERE version=140;
      UPDATE schema_metadata SET epoch='2026-10-15.1' WHERE singleton_id=1;
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(columnNames(context.database, "core_event_lane_items")).toEqual(expect.arrayContaining([
      "conflict_count", "last_conflict_hash", "last_conflict_reason", "last_conflict_at"
    ]));
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=140").get()).toEqual({ version: 140 });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("preserves a pre-existing completion-choice invalid reason through migration 124", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      PRAGMA foreign_keys=OFF;
      DROP INDEX completion_notification_obligations_waiting;
      DROP INDEX completion_action_sets_available;
      DROP INDEX completion_action_sets_owner_state;
      DROP INDEX completion_action_sets_presentation_reply;
      DROP TABLE completion_notification_obligations;
      DROP TABLE completion_choice_options;
      DROP TABLE completion_action_sets;
      DROP TABLE completion_choice_specifications;
      CREATE TABLE completion_notification_obligations(
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn')),
        owner_id TEXT NOT NULL,owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation>=1),
        required_view_version INTEGER NOT NULL CHECK(required_view_version>=1),
        state TEXT NOT NULL CHECK(state IN ('waiting_for_answer','missing_mention_target','released','suppressed')),
        notification_reply_id TEXT REFERENCES outbound_replies(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,released_at TEXT,
        PRIMARY KEY(owner_kind,owner_id,owner_generation)
      );
      CREATE TABLE completion_choice_specifications(
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn')),
        owner_id TEXT NOT NULL,owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),
        version INTEGER NOT NULL CHECK(version=1),question TEXT,default_option_id TEXT NOT NULL,
        invalid_reason TEXT,created_at TEXT NOT NULL,
        UNIQUE(owner_kind,owner_id,owner_generation)
      );
      CREATE TABLE completion_choice_options(
        specification_id TEXT NOT NULL REFERENCES completion_choice_specifications(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal>=0),option_id TEXT NOT NULL,label TEXT NOT NULL,message TEXT NOT NULL,
        PRIMARY KEY(specification_id,option_id),UNIQUE(specification_id,ordinal)
      );
      CREATE TABLE completion_action_sets(
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn')),
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
      ) VALUES(
        'legacy-invalid','primary-prompt','prompt-invalid',1,1,NULL,'','invalid-native-completion-choice','2026-10-15T00:00:00.000Z'
      );
      PRAGMA foreign_keys=ON;
    `);

    const migration = orderedMigrations.find(({ id }) => id === 124);
    if (!migration) throw new Error("migration 124 is missing");
    migration.apply(context);

    expect(columnNames(context.database, "completion_choice_specifications")).toContain("invalid_reason");
    expect(context.database.prepare(`SELECT owner_kind,owner_id,invalid_reason
      FROM completion_choice_specifications WHERE id='legacy-invalid'`).get()).toEqual({
      owner_kind: "primary-prompt", owner_id: "prompt-invalid", invalid_reason: "invalid-native-completion-choice"
    });
  });

  it("upgrades legacy Submission Intent text into canonical typed input JSON", () => {
    const context = openContext();
    run(context);
    context.database.prepare(`INSERT INTO submission_intents(
      submission_id,ingress_source,source_message_key,actor_json,input_json,text,owner_kind,owner_id,owner_generation,
      pane_id,terminal_id,expected_agent_kind,expected_session_id,state,created_at,updated_at
    ) VALUES('legacy-input','feishu:primary','legacy-message','{"kind":"human","id":"user","gatewayId":"feishu:primary","chatId":"chat","topicId":null,"rootMessageId":"root"}',
      '{"schemaVersion":2,"text":"legacy text"}','legacy text','primary','binding',1,'pane','terminal','traex','session','recorded','2026-10-15T00:00:00.000Z','2026-10-15T00:00:00.000Z')`).run();
    context.database.exec(`
      ALTER TABLE submission_intents DROP COLUMN input_json;
      DELETE FROM schema_migrations WHERE version=138;
      UPDATE schema_metadata SET epoch='2026-10-14.2',fingerprint='before-typed-input';
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT input_json,text FROM submission_intents WHERE submission_id='legacy-input'").get()).toEqual({
      input_json: JSON.stringify({ schemaVersion: 2, text: "legacy text" }), text: "legacy text"
    });
  });

  it("indexes replacement recovery identity on fresh and prior-epoch databases", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });
    const freshFingerprint = readSchemaMetadata(context.database).fingerprint;

    const assertReplacementLookup = () => {
      expect(schemaObjects(context.database)).toContain("delivery_recoveries_replacement");
      const plan = (context.database.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM delivery_recoveries WHERE replacement_reply_id=?").all("replacement") as Array<{ detail: string }>)
        .map(({ detail }) => detail.toLowerCase());
      expect(plan.some((detail) => detail.includes("delivery_recoveries_replacement") && detail.includes("search"))).toBe(true);
      expect(plan.some((detail) => detail.includes("scan delivery_recoveries"))).toBe(false);
    };
    assertReplacementLookup();

    context.database.exec(`
      DROP INDEX delivery_recoveries_replacement;
      DELETE FROM schema_migrations WHERE version=128;
      UPDATE schema_metadata SET epoch='2026-10-11.2',fingerprint='deployed-before-replacement-index';
    `);
    expect(run(context)).toMatchObject({
      route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint: freshFingerprint
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=128").get()).toEqual({ version: 128 });
    assertReplacementLookup();
    expect(readSchemaMetadata(context.database).fingerprint).toBe(freshFingerprint);
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("indexes sparse retained multi-agent calls on fresh and prior-epoch databases", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });
    const freshFingerprint = readSchemaMetadata(context.database).fingerprint;

    const assertSparseCallLookup = () => {
      expect(schemaObjects(context.database)).toContain("core_event_inbox_multi_agent_call");
      const eventCount = context.database.prepare("SELECT COUNT(*) AS count FROM core_event_inbox").get() as { count: number };
      if (eventCount.count === 0) context.database.exec(`
        WITH RECURSIVE counter(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM counter WHERE value<1000)
        INSERT INTO core_event_inbox(
          event_id,source_id,agent_kind,session_id,source_cursor,occurred_at,event_json,ingested_at,event_type,call_id
        ) SELECT 'irrelevant-'||value,'source','traex','session','cursor','2026-10-13T00:00:00.000Z',
          json_object('payload',json_object('name','unrelated_tool')),'2026-10-13T00:00:00.000Z','tool_call','call-'||value
        FROM counter;
        INSERT INTO core_event_inbox(
          event_id,source_id,agent_kind,session_id,source_cursor,occurred_at,event_json,ingested_at,event_type,call_id
        ) VALUES (
          'multi-agent-call','source','traex','session','cursor','2026-10-13T00:00:00.000Z',
          json_object('payload',json_object('name','multi_agent_v1__wait_agent')),
          '2026-10-13T00:00:00.000Z','tool_call','multi-agent-call'
        );
      `);
      context.database.exec("ANALYZE core_event_inbox");
      const plan = (context.database.prepare(`EXPLAIN QUERY PLAN SELECT event_id FROM core_event_inbox INDEXED BY core_event_inbox_multi_agent_call
        WHERE agent_kind=? AND session_id=? AND event_type='tool_call' AND payload_compacted_at IS NULL
          AND json_extract(event_json,'$.payload.name') IN (
            'multi_agent_v1__spawn_agent','multi_agent_v1__wait_agent','multi_agent_v1__close_agent',
            'collaboration__spawn_agent','collaboration__wait_agent','collaboration__interrupt_agent','collaboration__close_agent'
          )`).all("traex", "session") as Array<{ detail: string }>).map(({ detail }) => detail.toLowerCase());
      expect(plan.some((detail) => detail.includes("core_event_inbox_multi_agent_call") && detail.includes("search"))).toBe(true);
      expect(plan.some((detail) => detail.includes("scan core_event_inbox"))).toBe(false);
      const productionPlan = (context.database.prepare(`EXPLAIN QUERY PLAN ${RETAINED_MULTI_AGENT_ACTIVITY_QUERY}`)
        .all(null, "", "primary", "", "", -1, "", 129) as Array<{ detail: string }>).map(({ detail }) => detail.toLowerCase());
      expect(productionPlan.some((detail) => detail.includes("core_event_inbox_multi_agent_call") && detail.includes("search"))).toBe(true);
    };
    assertSparseCallLookup();

    context.database.exec(`
      DROP INDEX core_event_inbox_multi_agent_call;
      DELETE FROM schema_migrations WHERE version=129;
      UPDATE schema_metadata SET epoch='2026-10-12.1',fingerprint='deployed-before-retained-call-index';
    `);
    expect(run(context)).toMatchObject({
      route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint: freshFingerprint
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=129").get()).toEqual({ version: 129 });
    assertSparseCallLookup();
    expect(readSchemaMetadata(context.database).fingerprint).toBe(freshFingerprint);
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });

    context.database.exec(`
      DROP INDEX core_event_inbox_multi_agent_call;
      DELETE FROM schema_migrations WHERE version=135;
      UPDATE schema_metadata SET epoch='2026-10-13.6',fingerprint='deployed-before-collaboration-call-index';
    `);
    expect(run(context)).toMatchObject({
      route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint: freshFingerprint
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=135").get()).toEqual({ version: 135 });
    assertSparseCallLookup();
    expect(readSchemaMetadata(context.database).fingerprint).toBe(freshFingerprint);
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("indexes retained checkpoint session lookup on fresh and prior-epoch databases", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });
    const freshFingerprint = readSchemaMetadata(context.database).fingerprint;
    const assertCheckpointLookup = () => {
      const definition = context.database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='core_event_lane_checkpoints_session'")
        .get() as { sql: string } | undefined;
      expect(definition?.sql).toContain("core_event_lane_checkpoints(agent_kind,session_id,lane_id)");
      const plan = (context.database.prepare(`EXPLAIN QUERY PLAN ${RETAINED_MULTI_AGENT_ACTIVITY_QUERY}`)
        .all(null, "", "primary", "", "", -1, "", 129) as Array<{ detail: string }>).map(({ detail }) => detail.toLowerCase());
      const checkpointSteps = plan.filter((detail) => detail.includes("checkpoint"));
      expect(checkpointSteps).toHaveLength(2);
      expect(checkpointSteps.every((detail) => detail.includes("core_event_lane_checkpoints_session"))).toBe(true);
      expect(checkpointSteps.some((detail) => detail.includes("automatic") || detail.includes("scan checkpoint"))).toBe(false);
    };
    assertCheckpointLookup();

    context.database.exec(`
      DROP INDEX core_event_lane_checkpoints_session;
      DELETE FROM schema_migrations WHERE version=131;
      UPDATE schema_metadata SET epoch='2026-10-13.2',fingerprint='deployed-before-checkpoint-session-index';
    `);
    expect(run(context)).toMatchObject({
      route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint: freshFingerprint
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=131").get()).toEqual({ version: 131 });
    assertCheckpointLookup();
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("indexes oldest pending Core history on fresh and prior-epoch databases", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });
    const freshFingerprint = readSchemaMetadata(context.database).fingerprint;
    const assertHistoryLookup = () => {
      expect(schemaObjects(context.database)).toContain("core_event_lane_history_pending");
      const plan = (context.database.prepare(`EXPLAIN QUERY PLAN SELECT lane_id,event_id,sequence,created_at
        FROM core_event_lane_items INDEXED BY core_event_lane_history_pending
        WHERE state='pending' ORDER BY created_at,lane_id,sequence,event_id LIMIT 1`).all() as Array<{ detail: string }>)
        .map(({ detail }) => detail.toLowerCase());
      expect(plan.some((detail) => detail.includes("core_event_lane_history_pending") && detail.includes("search"))).toBe(true);
    };
    assertHistoryLookup();

    context.database.exec(`
      DROP INDEX core_event_lane_history_pending;
      DELETE FROM schema_migrations WHERE version=136;
      UPDATE schema_metadata SET epoch='2026-10-13.7',fingerprint='pre-history-index';
    `);
    expect(run(context)).toMatchObject({
      route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint: freshFingerprint
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=136").get()).toEqual({ version: 136 });
    assertHistoryLookup();
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("indexes never-attempted missing Turn Card pages on fresh and prior-epoch databases", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });
    const freshFingerprint = readSchemaMetadata(context.database).fingerprint;
    const assertMissingPageLookup = () => {
      expect(schemaObjects(context.database)).toContain("conversation_segment_pages_history_missing");
      const plan = (context.database.prepare(`EXPLAIN QUERY PLAN SELECT segment_id,page_index,updated_at
        FROM conversation_segment_pages INDEXED BY conversation_segment_pages_history_missing
        WHERE message_id IS NULL AND pending_reply_id IS NULL AND state IN ('creating','finished')
        ORDER BY updated_at,segment_id,page_index LIMIT 1`).all() as Array<{ detail: string }>)
        .map(({ detail }) => detail.toLowerCase());
      expect(plan.some((detail) => detail.includes("conversation_segment_pages_history_missing") && detail.includes("scan"))).toBe(true);
    };
    assertMissingPageLookup();

    context.database.exec(`
      DROP INDEX conversation_segment_pages_history_missing;
      DELETE FROM schema_migrations WHERE version=137;
      UPDATE schema_metadata SET epoch='2026-10-14.1',fingerprint='pre-missing-page-index';
    `);
    expect(run(context)).toMatchObject({
      route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint: freshFingerprint
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=137").get()).toEqual({ version: 137 });
    assertMissingPageLookup();
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("adds retained Session Activity recovery checkpoints on fresh and prior-epoch databases", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });
    const freshFingerprint = readSchemaMetadata(context.database).fingerprint;
    const assertColumns = () => {
      const columns = context.database.prepare("PRAGMA table_info(session_activity_snapshots)").all() as Array<{
        name: string; type: string; notnull: number; dflt_value: string | null;
      }>;
      expect(columns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "retained_recovery_lane_id", type: "TEXT", notnull: 0, dflt_value: null }),
        expect.objectContaining({ name: "retained_recovery_lane_sequence", type: "INTEGER", notnull: 1, dflt_value: "0" })
      ]));
    };
    assertColumns();

    context.database.exec(`
      ALTER TABLE session_activity_snapshots DROP COLUMN retained_recovery_lane_sequence;
      ALTER TABLE session_activity_snapshots DROP COLUMN retained_recovery_lane_id;
      DELETE FROM schema_migrations WHERE version=132;
      UPDATE schema_metadata SET epoch='2026-10-13.3',fingerprint='deployed-before-retained-recovery-checkpoint';
    `);
    expect(run(context)).toMatchObject({
      route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint: freshFingerprint
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=132").get()).toEqual({ version: 132 });
    assertColumns();
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("upgrades the deployed 2026-10-13.4 epoch through the per-pane compatibility route", () => {
    const context = openContext();
    const fresh = run(context);
    context.database.prepare("UPDATE schema_metadata SET epoch='2026-10-13.4',fingerprint='deployed-per-pane-predecessor'").run();

    expect(run(context)).toMatchObject({
      route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH,
      fingerprint: fresh.fingerprint
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version IN (133,134) ORDER BY version").all())
      .toEqual([{ version: 133 }, { version: 134 }]);
    expect(readSchemaMetadata(context.database)).toMatchObject({ epoch: CURRENT_SCHEMA_EPOCH, fingerprint: fresh.fingerprint });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("upgrades canonical recovery outcomes with terminal recovered settlement", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });
    const freshFingerprint = readSchemaMetadata(context.database).fingerprint;
    const insertIntent = context.database.prepare(`INSERT INTO submission_intents(
      submission_id,ingress_source,source_message_key,actor_json,text,owner_kind,owner_id,owner_generation,pane_id,terminal_id,
      expected_agent_kind,expected_session_id,state,attempted_at,created_at,updated_at
    ) VALUES(?,?,?,'{}','recover me','primary','binding-recovery',1,'pane-recovery','terminal-recovery',
      'traex','session-recovery','observed','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`);
    insertIntent.run("retry-submission", "feishu", "retry-source");
    insertIntent.run("closed-submission", "feishu", "closed-source");

    context.database.exec(`
      DROP INDEX canonical_input_recovery_attempts_due;
      DROP TABLE canonical_input_recovery_attempts;
      CREATE TABLE canonical_input_recovery_attempts(
        submission_id TEXT PRIMARY KEY REFERENCES submission_intents(submission_id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('retry_wait','needs_human','auto_closed')),
        failure_code TEXT NOT NULL CHECK(failure_code IN ('indexing','not_found','ambiguous','unavailable')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 1), next_attempt_at TEXT, updated_at TEXT NOT NULL,
        CHECK((state='retry_wait' AND next_attempt_at IS NOT NULL) OR (state IN ('needs_human','auto_closed') AND next_attempt_at IS NULL))
      );
      INSERT INTO canonical_input_recovery_attempts(submission_id,state,failure_code,attempt_count,next_attempt_at,updated_at) VALUES
        ('retry-submission','retry_wait','indexing',2,'2026-10-01T00:00:30.000Z','2026-10-01T00:00:00.000Z'),
        ('closed-submission','auto_closed','ambiguous',3,NULL,'2026-10-01T00:00:01.000Z');
      CREATE INDEX canonical_input_recovery_attempts_due
        ON canonical_input_recovery_attempts(state,next_attempt_at,submission_id);
      DELETE FROM schema_migrations WHERE version=130;
      UPDATE schema_metadata SET epoch='2026-10-13.1',fingerprint='deployed-before-recovered-settlement';
    `);

    expect(run(context)).toMatchObject({
      route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH, fingerprint: freshFingerprint
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=130").get()).toEqual({ version: 130 });
    const definition = context.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='canonical_input_recovery_attempts'")
      .get() as { sql: string };
    expect(definition.sql).toContain("'recovered'");
    expect(definition.sql).toContain("failure_code IS NULL");
    expect(context.database.prepare(`SELECT submission_id,state,failure_code,attempt_count,next_attempt_at
      FROM canonical_input_recovery_attempts ORDER BY submission_id`).all()).toEqual([
      { submission_id: "closed-submission", state: "auto_closed", failure_code: "ambiguous", attempt_count: 3, next_attempt_at: null },
      { submission_id: "retry-submission", state: "retry_wait", failure_code: "indexing", attempt_count: 2, next_attempt_at: "2026-10-01T00:00:30.000Z" }
    ]);
    expect(readSchemaMetadata(context.database).fingerprint).toBe(freshFingerprint);
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("upgrades the deployed 2026-10-10.5 epoch through the Completion Review compatibility route", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DROP INDEX completion_action_sets_presentation_reply;
      DROP INDEX completion_action_sets_owner_state;
      DROP TABLE completion_action_sets;
      CREATE TABLE completion_action_sets(
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn','primary-segment')),
        owner_id TEXT NOT NULL, owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation>=1),
        page_index INTEGER NOT NULL CHECK(page_index>=0),card_id TEXT NOT NULL,card_message_id TEXT NOT NULL,
        mention_open_id TEXT,state TEXT NOT NULL CHECK(state IN ('available','consumed','superseded','unavailable')),
        selected_action TEXT CHECK(selected_action IN ('default','approve','continue','reject')),
        result_source_key TEXT,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,decided_at TEXT,
        choice_specification_id TEXT REFERENCES completion_choice_specifications(id),selected_choice_option_id TEXT,
        UNIQUE(owner_kind,owner_id,owner_generation)
      );
      CREATE INDEX completion_action_sets_available
        ON completion_action_sets(state,owner_kind,binding_id,binding_generation,updated_at,owner_id);
      DELETE FROM schema_migrations WHERE version=126;
      UPDATE schema_metadata SET epoch='2026-10-10.5',fingerprint='deployed-pre-completion-review';
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(readSchemaMetadata(context.database)).toMatchObject({ epoch: CURRENT_SCHEMA_EPOCH });
    expect(columnNames(context.database, "completion_action_sets")).toEqual(expect.arrayContaining([
      "presentation_kind", "presentation_generation", "presentation_reply_id", "presentation_message_id", "presentation_card_id"
    ]));
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=126").get()).toEqual({ version: 126 });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("auto-closes legacy Canonical Human recovery rows without deleting their evidence", () => {
    const context = openContext();
    run(context);
    context.database.prepare(`INSERT INTO submission_intents(
      submission_id,ingress_source,source_message_key,actor_json,text,owner_kind,owner_id,owner_generation,pane_id,terminal_id,
      expected_agent_kind,expected_session_id,state,attempted_at,created_at,updated_at
    ) VALUES('auto-close-submission','feishu','auto-close-source','{}','recover me','primary','binding-auto-close',1,'pane-auto-close','terminal-auto-close','traex','session-auto-close','observed','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`).run();
    context.database.exec(`
      DROP INDEX canonical_input_recovery_attempts_due;
      DROP TABLE canonical_input_recovery_attempts;
      CREATE TABLE canonical_input_recovery_attempts(
        submission_id TEXT PRIMARY KEY REFERENCES submission_intents(submission_id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('retry_wait','needs_human')),
        failure_code TEXT NOT NULL CHECK(failure_code IN ('indexing','not_found','ambiguous','unavailable')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count >= 1), next_attempt_at TEXT, updated_at TEXT NOT NULL,
        CHECK((state='retry_wait' AND next_attempt_at IS NOT NULL) OR (state='needs_human' AND next_attempt_at IS NULL))
      );
      INSERT INTO canonical_input_recovery_attempts(submission_id,state,failure_code,attempt_count,next_attempt_at,updated_at)
        VALUES('auto-close-submission','needs_human','ambiguous',3,NULL,'2026-10-01T00:00:00.000Z');
      CREATE INDEX canonical_input_recovery_attempts_due
        ON canonical_input_recovery_attempts(state,next_attempt_at,submission_id);
      DELETE FROM schema_migrations WHERE version=127;
      UPDATE schema_metadata SET epoch='2026-10-11.1',fingerprint='pre-auto-close-recovery';
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT state,failure_code,attempt_count FROM canonical_input_recovery_attempts WHERE submission_id='auto-close-submission'").get())
      .toEqual({ state: "auto_closed", failure_code: "ambiguous", attempt_count: 3 });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=127").get()).toEqual({ version: 127 });
  });

  it("upgrades the pre-auto-close current epoch before accepting a current-schema fast open", () => {
    const context = openContext();
    run(context);
    context.database.exec("DELETE FROM schema_migrations WHERE version=127; UPDATE schema_metadata SET epoch='2026-10-11.1'");

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=127").get()).toEqual({ version: 127 });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("rebuilds legacy inline Action Sets without losing terminal evidence or provider identity", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DROP INDEX completion_action_sets_presentation_reply;
      DROP INDEX completion_action_sets_owner_state;
      DROP TABLE completion_action_sets;
      CREATE TABLE completion_action_sets(
        id TEXT PRIMARY KEY,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn','primary-segment')),
        owner_id TEXT NOT NULL, owner_generation INTEGER NOT NULL CHECK(owner_generation>=1),
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        binding_generation INTEGER NOT NULL CHECK(binding_generation>=1),
        page_index INTEGER NOT NULL CHECK(page_index>=0),card_id TEXT NOT NULL,card_message_id TEXT NOT NULL,
        mention_open_id TEXT,state TEXT NOT NULL CHECK(state IN ('available','consumed','superseded','unavailable')),
        selected_action TEXT CHECK(selected_action IN ('default','approve','continue','reject')),
        result_source_key TEXT,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,decided_at TEXT,
        choice_specification_id TEXT REFERENCES completion_choice_specifications(id),selected_choice_option_id TEXT,
        UNIQUE(owner_kind,owner_id,owner_generation)
      );
      CREATE INDEX completion_action_sets_available
        ON completion_action_sets(state,owner_kind,binding_id,binding_generation,updated_at,owner_id);
      INSERT INTO bindings(id,workspace_id,chat_id,title,runtime,state,last_agent_state,created_at,updated_at)
        VALUES('completion-review-binding','workspace','chat','review','traex','active','idle','t','t');
    `);
    const insert = context.database.prepare(`INSERT INTO completion_action_sets(
      id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,card_id,card_message_id,
      mention_open_id,state,selected_action,result_source_key,reason,created_at,updated_at,decided_at,choice_specification_id,selected_choice_option_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run("available", "primary-prompt", "owner-available", 1, "completion-review-binding", 1, 0, "card-available", "message-available", "ou-review", "available", null, null, null, "t", "t", null, null, null);
    insert.run("consumed", "primary-prompt", "owner-consumed", 1, "completion-review-binding", 1, 0, "card-consumed", "message-consumed", "ou-review", "consumed", "approve", "source-consumed", null, "t", "t", "t", null, null);
    insert.run("superseded", "worker-turn", "owner-superseded", 2, "completion-review-binding", 1, 0, "card-superseded", "message-superseded", null, "superseded", null, null, "newer-owner", "t", "t", "t", null, null);
    insert.run("unavailable", "primary-segment", "owner-unavailable", 3, "completion-review-binding", 1, 0, "card-unavailable", "message-unavailable", null, "unavailable", null, null, "missing-actor", "t", "t", "t", null, null);
    context.database.exec(`INSERT INTO outbound_replies(
        id,idempotency_key,root_message_id,kind,payload,state,next_attempt_at,created_at,updated_at,scope_kind,scope_key,delivery_order,lane_key,conflict_key
      ) VALUES('legacy-presentation-reply','legacy-presentation-reply','root','card_reply','{}','delivered','t','t','t','global',json_array('global'),1,'legacy-presentation-reply','legacy-presentation-reply');
      INSERT INTO completion_notification_obligations(
        owner_kind,owner_id,owner_generation,binding_id,binding_generation,required_view_version,state,presentation_reply_id,created_at,updated_at
      ) VALUES
        ('primary-prompt','owner-available',1,'completion-review-binding',1,1,'released','legacy-presentation-reply','t','t'),
        ('primary-prompt','owner-consumed',1,'completion-review-binding',1,1,'released','legacy-presentation-reply','t','t');`);
    context.database.exec("DELETE FROM schema_migrations WHERE version>=112; DROP TABLE schema_metadata");

    expect(run(context)).toMatchObject({ route: "compatibility", epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare(`SELECT id,presentation_kind,presentation_generation,presentation_message_id,presentation_card_id,state,selected_action,result_source_key,reason
      FROM completion_action_sets ORDER BY id`).all()).toEqual([
      { id: "available", presentation_kind: "legacy-inline", presentation_generation: 1, presentation_message_id: "message-available", presentation_card_id: "card-available", state: "available", selected_action: null, result_source_key: null, reason: null },
      { id: "consumed", presentation_kind: "legacy-inline", presentation_generation: 1, presentation_message_id: "message-consumed", presentation_card_id: "card-consumed", state: "consumed", selected_action: "approve", result_source_key: "source-consumed", reason: null },
      { id: "superseded", presentation_kind: "legacy-inline", presentation_generation: 1, presentation_message_id: "message-superseded", presentation_card_id: "card-superseded", state: "superseded", selected_action: null, result_source_key: null, reason: "newer-owner" },
      { id: "unavailable", presentation_kind: "legacy-inline", presentation_generation: 1, presentation_message_id: "message-unavailable", presentation_card_id: "card-unavailable", state: "unavailable", selected_action: null, result_source_key: null, reason: "missing-actor" }
    ]);
    expect(context.database.prepare("SELECT id FROM completion_action_sets WHERE id='available' AND presentation_kind='legacy-inline' AND state='available'").get()).toEqual({ id: "available" });
    expect(context.database.prepare("SELECT presentation_reply_id FROM completion_action_sets WHERE id='available'").get()).toEqual({ presentation_reply_id: null });
    expect(context.database.prepare("SELECT owner_id,presentation_reply_id FROM completion_notification_obligations WHERE presentation_reply_id='legacy-presentation-reply' ORDER BY owner_id").all()).toEqual([
      { owner_id: "owner-available", presentation_reply_id: "legacy-presentation-reply" },
      { owner_id: "owner-consumed", presentation_reply_id: "legacy-presentation-reply" }
    ]);
    context.database.exec(`INSERT INTO outbound_replies(
        id,idempotency_key,root_message_id,kind,payload,state,next_attempt_at,created_at,updated_at,scope_kind,scope_key,delivery_order,lane_key,conflict_key
      ) VALUES('fresh-presentation-reply','fresh-presentation-reply','root','card_reply','{}','delivered','t','t','t','global',json_array('global'),2,'fresh-presentation-reply','fresh-presentation-reply');
      INSERT INTO completion_action_sets(
        id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,presentation_kind,presentation_generation,presentation_reply_id,state,created_at,updated_at
      ) VALUES('fresh-action','primary-prompt','owner-fresh',1,'completion-review-binding',1,0,'fresh-card',1,'fresh-presentation-reply','presenting','t','t');
      DELETE FROM outbound_replies WHERE id='fresh-presentation-reply';`);
    expect(context.database.prepare("SELECT presentation_reply_id FROM completion_action_sets WHERE id='fresh-action'").get()).toEqual({ presentation_reply_id: null });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("installs nullable semantic-delivery identity and preparation columns without rewriting legacy rows", () => {
    const context = openContext();
    run(context);

    const semanticColumns = [
      "delivery_input_kind",
      "subject_kind",
      "subject_json",
      "subject_revision",
      "presentation_snapshot_json",
      "presentation_snapshot_hash",
      "planner_policy_version",
      "renderer_policy_version",
      "gateway_profile_version",
      "preparation_state"
    ];
    expect(columnNames(context.database, "outbound_replies")).toEqual(expect.arrayContaining(semanticColumns));
    const nullability = context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string; notnull: number }>;
    expect(nullability.filter(({ name }) => semanticColumns.includes(name)).map(({ name, notnull }) => ({ name, notnull })))
      .toEqual(semanticColumns.map((name) => ({ name, notnull: 0 })));
  });

  it("installs an old-reader-safe expansion guard without enabling semantic writers", () => {
    const context=openContext(); run(context);
    expect(tableNames(context.database)).toEqual(expect.arrayContaining(["semantic_delivery_rollout","semantic_delivery_shadow_evidence","semantic_delivery_backup_rehearsals"]));
    expect(context.database.prepare("SELECT phase,cohort_enabled FROM semantic_delivery_rollout WHERE singleton_id=1").get()).toEqual({ phase:"expansion",cohort_enabled:0 });
    expect((context.database.prepare("PRAGMA table_info(conversation_segment_pages)").all() as Array<{name:string;notnull:number}>).find(({name})=>name==="delivery_cohort"))
      .toMatchObject({ name:"delivery_cohort",notnull:0 });
  });

  it("upgrades the rollout epoch with the open-gap retention index", () => {
    const context=openContext(); run(context);
    context.database.exec("DROP INDEX projection_gaps_open_source_item; UPDATE schema_metadata SET epoch='2026-10-10.2',fingerprint='pre-gap-retention'");

    expect(run(context)).toMatchObject({ route:"compatibility",compatibilityStepCount:1,epoch:CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='projection_gaps_open_source_item'").get()).toEqual({ name:"projection_gaps_open_source_item" });
    expect(run(context)).toMatchObject({ route:"current-fast",compatibilityStepCount:0,epoch:CURRENT_SCHEMA_EPOCH });
  });

  it("upgrades epoch .3 additively and fast-reopens the shadow diagnostics catalog", () => {
    const context=openContext(); run(context);
    context.database.exec(`DROP INDEX outbound_replies_semantic_unprepared_age;
      DROP INDEX outbound_reply_prerequisites_lag;
      UPDATE schema_metadata SET epoch='2026-10-10.3',fingerprint='pre-shadow-diagnostics'`);

    expect(run(context)).toMatchObject({ route:"compatibility",compatibilityStepCount:1,epoch:CURRENT_SCHEMA_EPOCH });
    expect(columnNames(context.database,"semantic_delivery_rollout")).toEqual(expect.arrayContaining([
      "shadow_epoch","shadow_started_at","preparation_cas_failure_count","checkpoint_backward_rebase_count"
    ]));
    expect(columnNames(context.database,"semantic_delivery_shadow_evidence")).toEqual(expect.arrayContaining(["shadow_epoch","snapshot_schema_version"]));
    expect(run(context)).toMatchObject({ route:"current-fast",compatibilityStepCount:0,epoch:CURRENT_SCHEMA_EPOCH });
  });

  it("cumulatively upgrades epoch .1 with every later retention and rollout index", () => {
    const context=openContext(); run(context);
    context.database.exec(`
      DROP TRIGGER IF EXISTS semantic_delivery_rollout_guarded_transition;
      DROP TRIGGER IF EXISTS semantic_delivery_rollout_start_shadow;
      DROP TRIGGER IF EXISTS conversation_segment_pages_assign_delivery_cohort;
      DROP TRIGGER IF EXISTS conversation_segment_pages_delivery_cohort_immutable;
      DROP INDEX IF EXISTS semantic_delivery_shadow_result;
      DROP INDEX IF EXISTS semantic_delivery_backup_rehearsal_result;
      DROP INDEX IF EXISTS outbound_replies_semantic_unprepared_age;
      DROP INDEX IF EXISTS outbound_reply_prerequisites_lag;
      DROP INDEX IF EXISTS projection_gaps_open_source_item;
      DROP TABLE semantic_delivery_backup_rehearsals;
      DROP TABLE semantic_delivery_shadow_evidence;
      DROP TABLE semantic_delivery_rollout;
      UPDATE schema_metadata SET epoch='2026-10-10.1',fingerprint='epoch-1-before-rollout';
    `);

    expect(run(context)).toMatchObject({ route:"compatibility",compatibilityStepCount:1,epoch:CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='projection_gaps_open_source_item'").get()).toEqual({ name:"projection_gaps_open_source_item" });
    expect(()=>context.database.prepare("EXPLAIN QUERY PLAN SELECT id FROM outbound_replies WHERE NOT EXISTS (SELECT 1 FROM projection_gaps gap INDEXED BY projection_gaps_open_source_item WHERE gap.state='open' AND gap.source_item_id=outbound_replies.id)").all()).not.toThrow();
    expect(run(context)).toMatchObject({ route:"current-fast",compatibilityStepCount:0,epoch:CURRENT_SCHEMA_EPOCH });
  });

  it("uses bounded rollout diagnostic indexes with a production-shaped legacy backlog", () => {
    const context=openContext(); run(context);
    context.database.exec(`WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM seq WHERE value<2000)
      INSERT INTO outbound_replies(id,idempotency_key,root_message_id,kind,payload,state,next_attempt_at,created_at,updated_at,
        scope_kind,scope_key,delivery_order,lane_key,conflict_key)
      SELECT 'legacy-'||value,'legacy-'||value,'root','text','legacy','pending','t','t','t','global',json_array('global'),value,'legacy-'||value,'legacy-'||value FROM seq`);
    const unpreparedPlan=(context.database.prepare(`EXPLAIN QUERY PLAN SELECT MIN(created_at) FROM outbound_replies INDEXED BY outbound_replies_semantic_unprepared_age
      WHERE delivery_input_kind='semantic-snapshot' AND state IN ('pending','dead_letter') AND preparation_state IN ('reserved','preparing')`).all() as Array<{detail:string}>).map(({detail})=>detail).join(" ");
    const shadowPlan=(context.database.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM semantic_delivery_shadow_evidence
      WHERE shadow_epoch=? AND snapshot_schema_version=1 AND planner_policy_version=1 AND renderer_policy_version=1 AND gateway_profile_version=1 AND matched=0 AND observed_at>=?`).all(1,"t") as Array<{detail:string}>).map(({detail})=>detail).join(" ");
    const prerequisitePlan=(context.database.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM outbound_reply_prerequisites prerequisite INDEXED BY outbound_reply_prerequisites_lag
      JOIN outbound_replies dependent ON dependent.id=prerequisite.dependent_reply_id
      LEFT JOIN outbound_replies required ON required.id=prerequisite.prerequisite_reply_id
      WHERE dependent.state IN ('pending','dead_letter') AND (required.id IS NULL OR required.state!=prerequisite.required_state)`).all() as Array<{detail:string}>).map(({detail})=>detail).join(" ");

    expect(unpreparedPlan).toContain("outbound_replies_semantic_unprepared_age");
    expect(shadowPlan).toContain("semantic_delivery_shadow_result");
    expect(prerequisitePlan).toContain("outbound_reply_prerequisites_lag");
    expect(new SqliteOperationsStore(context).getSemanticDeliveryRolloutSummary()).toMatchObject({ oldestUnpreparedSemanticAt:null,unmetPrerequisiteCount:0 });
  });

  it.each([
    "shadow_mismatch","ambiguous_actionable_rows","unsupported_versions","unresolved_settlement_gaps","retention_blockers"
  ] as const)("refuses semantic cohort cutover for %s", (blocker) => {
    const context=openContext(); run(context); prepareSemanticShadow(context.database);
    installSemanticRolloutBlocker(context.database,blocker);
    expect(()=>context.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1,updated_at='cutover' WHERE singleton_id=1").run())
      .toThrow(/semantic_delivery_cutover_blocked/);
    expect(context.database.prepare("SELECT phase,cohort_enabled FROM semantic_delivery_rollout WHERE singleton_id=1").get()).toEqual({ phase:"shadow",cohort_enabled:0 });
  });

  it("refuses cohort cutover when shadow evidence predates the current supported policy versions", () => {
    const context=openContext(); run(context);
    context.database.prepare("UPDATE semantic_delivery_rollout SET phase='shadow',updated_at='2026-10-10T00:00:00.000Z' WHERE singleton_id=1").run();
    context.database.prepare(`INSERT INTO semantic_delivery_shadow_evidence(
      segment_id,page_index,view_version,planner_policy_version,renderer_policy_version,gateway_profile_version,
      legacy_fingerprint,semantic_fingerprint,matched,details_json,observed_at
    ) VALUES('stale',0,1,2,1,1,'same','same',1,'{}','2026-10-10T00:00:01.000Z')`).run();

    expect(()=>context.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1,updated_at='2026-10-10T00:00:02.000Z' WHERE singleton_id=1").run())
      .toThrow(/semantic_delivery_cutover_blocked/);
  });

  it("ignores stale-version and prior-epoch mismatches once current shadow evidence matches", () => {
    const context=openContext(); run(context); prepareSemanticShadow(context.database);
    context.database.prepare(`INSERT INTO semantic_delivery_shadow_evidence(
      segment_id,page_index,view_version,shadow_epoch,snapshot_schema_version,planner_policy_version,renderer_policy_version,gateway_profile_version,
      legacy_fingerprint,semantic_fingerprint,matched,details_json,observed_at
    ) VALUES('old-mismatch',0,1,0,1,1,1,1,'legacy','semantic',0,'{}','old')`).run();
    context.database.prepare(`INSERT INTO semantic_delivery_shadow_evidence(
      segment_id,page_index,view_version,shadow_epoch,snapshot_schema_version,planner_policy_version,renderer_policy_version,gateway_profile_version,
      legacy_fingerprint,semantic_fingerprint,matched,details_json,observed_at
    ) SELECT 'stale-version',0,1,shadow_epoch,1,2,1,1,'legacy','semantic',0,'{}','shadow'
      FROM semantic_delivery_rollout WHERE singleton_id=1`).run();

    expect(new SqliteOperationsStore(context).getSemanticDeliveryRolloutSummary()).toMatchObject({ shadowMatches:1,shadowMismatches:0,cutoverAllowed:true });
    expect(()=>context.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1,updated_at='cutover' WHERE singleton_id=1").run()).not.toThrow();
  });

  it.each([
    "shadow_mismatch","ambiguous_actionable_rows","unsupported_versions","unresolved_settlement_gaps","retention_blockers"
  ] as const)("refuses semantic contraction for %s", (blocker) => {
    const context=openContext(); run(context); prepareSemanticShadow(context.database);
    context.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1,updated_at='cutover' WHERE singleton_id=1").run();
    new SqliteOperationsStore(context).recordSemanticDeliveryBackupRestoreRehearsal({ id:"rehearsal",backupPathHash:"a".repeat(64),
      backupSchemaFingerprint:"same",restoreSchemaFingerprint:"same",quickCheck:"ok",foreignKeyIssues:0,semanticIssues:0,schemaValid:true,rehearsedAt:"t" });
    installSemanticRolloutBlocker(context.database,blocker);
    expect(()=>context.database.prepare("UPDATE semantic_delivery_rollout SET phase='contraction_ready',updated_at='contract' WHERE singleton_id=1").run())
      .toThrow(/semantic_delivery_cutover_blocked/);
    expect(context.database.prepare("SELECT phase,cohort_enabled FROM semantic_delivery_rollout WHERE singleton_id=1").get()).toEqual({ phase:"cohort",cohort_enabled:1 });
  });

  it("marks only pages inserted after guarded cutover as semantic and never replans historical pages", () => {
    const context=openContext(); run(context); insertConversationSegment(context.database,"old"); insertConversationPage(context.database,"old");
    prepareSemanticShadow(context.database);
    context.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1,updated_at='cutover' WHERE singleton_id=1").run();
    insertConversationSegment(context.database,"new"); insertConversationPage(context.database,"new");
    expect(context.database.prepare("SELECT segment_id,delivery_cohort FROM conversation_segment_pages ORDER BY segment_id").all()).toEqual([
      { segment_id:"new",delivery_cohort:"semantic" },{ segment_id:"old",delivery_cohort:"legacy" }
    ]);
    expect(()=>context.database.prepare("UPDATE conversation_segment_pages SET delivery_cohort='semantic' WHERE segment_id='old'").run()).toThrow(/immutable_turn_card_delivery_cohort/);
  });

  it("rehearses backup and restore on isolated files before permitting contraction", async () => {
    const source=temporaryDatabasePath(); const backup=`${source}.backup`; const restore=`${source}.restore`;
    const context=new SqliteContext(source); contexts.push(context); run(context); prepareSemanticShadow(context.database);
    context.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1,updated_at='cutover' WHERE singleton_id=1").run();
    await backupSqliteDatabase(source,backup); await backupSqliteDatabase(backup,restore);
    const validation=validateSqliteMaintenanceDatabase(restore); const restored=new DatabaseSync(restore,{ readOnly:true });
    const fingerprint=readSchemaMetadata(restored).fingerprint; restored.close();
    new SqliteOperationsStore(context).recordSemanticDeliveryBackupRestoreRehearsal({ id:"rehearsal-1",backupPathHash:"a".repeat(64),backupSchemaFingerprint:fingerprint,
      restoreSchemaFingerprint:fingerprint,quickCheck:validation.quickCheck,foreignKeyIssues:validation.foreignKeyIssues,semanticIssues:validation.semanticIssues,schemaValid:validation.schemaValid,rehearsedAt:"2026-10-10T00:00:00.000Z" });
    expect(new SqliteOperationsStore(context).getSemanticDeliveryRolloutSummary()).toMatchObject({ contractionAllowed:true,backupRestoreRehearsedAt:"2026-10-10T00:00:00.000Z" });
    expect(()=>context.database.prepare("UPDATE semantic_delivery_rollout SET phase='contraction_ready',updated_at='contract' WHERE singleton_id=1").run()).not.toThrow();
  });

  it("starts a valid semantic cohort with pending refill work", () => {
    const context=openContext(); run(context); prepareSemanticShadow(context.database);
    context.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1,updated_at='cutover' WHERE singleton_id=1").run();
    installSemanticRolloutBlocker(context.database,"retention_blockers");

    const operations=new SqliteOperationsStore(context);
    expect(operations.getSemanticDeliveryRolloutSummary()).toMatchObject({ phase:"cohort",retentionBlockers:1 });
    expect(()=>operations.assertSemanticDeliveryStartupSafe()).not.toThrow();
  });

  it("accepts verified compacted terminal semantic history as supported version evidence", () => {
    const context=openContext(); run(context); prepareSemanticShadow(context.database);
    context.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1,updated_at='cutover' WHERE singleton_id=1").run();
    insertCompactedTerminalSemantic(context.database,"compacted-semantic");

    expect(new SqliteOperationsStore(context).getSemanticDeliveryRolloutSummary()).toMatchObject({
      unsupportedVersions:0,retentionBlockers:0,
      versions:[{ snapshotSchemaVersion:1,plannerPolicyVersion:1,rendererPolicyVersion:1,gatewayProfileVersion:1,rows:1,supported:true }]
    });
  });

  it("upgrades the prior epoch idempotently without backfilling or rewriting a legacy prepared row", () => {
    const context = openContext();
    run(context);
    context.database.prepare(`INSERT INTO outbound_replies(
      id,idempotency_key,root_message_id,kind,payload,state,next_attempt_at,created_at,updated_at,
      scope_kind,scope_key,delivery_order,lane_key,conflict_key
    ) VALUES('legacy-prepared','legacy-prepared','root','text','legacy-bytes','pending','t','t','t',
      'global',json_array('global'),1,'legacy-lane','legacy-lane')`).run();
    context.database.exec("DROP TRIGGER outbound_replies_semantic_identity_immutable");
    context.database.exec("DROP TRIGGER semantic_delivery_rollout_guarded_transition");
    context.database.exec("DROP INDEX outbound_replies_semantic_unprepared_age");
    for (const column of [
      "delivery_input_kind", "subject_kind", "subject_json", "subject_revision", "presentation_snapshot_json",
      "presentation_snapshot_hash", "planner_policy_version", "renderer_policy_version", "gateway_profile_version", "preparation_state"
    ]) context.database.exec(`ALTER TABLE outbound_replies DROP COLUMN ${column}`);
    context.database.exec("UPDATE schema_metadata SET epoch='2026-10-09.5',fingerprint='pre-semantic-delivery'");
    const before = context.database.prepare(`SELECT id,idempotency_key,root_message_id,kind,payload,state,next_attempt_at,created_at,updated_at,
      gateway_plan_json,gateway_plan_hash,claim_attempt_id,effect_certainty,payload_compacted_at FROM outbound_replies WHERE id='legacy-prepared'`).get();

    const upgraded = run(context);

    expect(upgraded).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare(`SELECT id,idempotency_key,root_message_id,kind,payload,state,next_attempt_at,created_at,updated_at,
      gateway_plan_json,gateway_plan_hash,claim_attempt_id,effect_certainty,payload_compacted_at FROM outbound_replies WHERE id='legacy-prepared'`).get()).toEqual(before);
    expect(context.database.prepare(`SELECT delivery_input_kind,subject_kind,subject_json,subject_revision,presentation_snapshot_json,
      presentation_snapshot_hash,planner_policy_version,renderer_policy_version,gateway_profile_version,preparation_state
      FROM outbound_replies WHERE id='legacy-prepared'`).get()).toEqual({
        delivery_input_kind: null, subject_kind: null, subject_json: null, subject_revision: null,
        presentation_snapshot_json: null, presentation_snapshot_hash: null, planner_policy_version: null,
        renderer_policy_version: null, gateway_profile_version: null, preparation_state: null
      });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, fingerprint: upgraded.fingerprint });
  });

  it("records the canonical current epoch, fingerprint, and full marker set for a fresh database", () => {
    const context = openContext();

    const result = run(context);
    const metadata = readSchemaMetadata(context.database);

    expect(result).toEqual({
      route: "fresh-baseline",
      compatibilityStepCount: 0,
      epoch: CURRENT_SCHEMA_EPOCH,
      fingerprint: metadata.fingerprint
    });
    expect(metadata).toEqual({
      epoch: CURRENT_SCHEMA_EPOCH,
      fingerprint: result.fingerprint,
      markers: canonicalMigrationMarkers()
    });
    expect(canonicalSchemaCatalog(context.database).markers).toEqual(canonicalMigrationMarkers());
  });

  it("reopens a verified current database through the deterministic current-fast route", () => {
    const context = openContext();
    const schemaInstaller = vi.spyOn(WorkerMigrations.prototype, "ensureWorkerThreadEntryInvalidations");
    const dataConvergence = vi.spyOn(WorkerMigrations.prototype, "convergeWorkerThreadEntryInvalidations");
    const fresh = run(context);
    const metadata = readSchemaMetadata(context.database);

    const reopened = run(context);

    expect(fresh.route).toBe("fresh-baseline");
    expect(reopened).toEqual({
      route: "current-fast",
      compatibilityStepCount: 0,
      epoch: fresh.epoch,
      fingerprint: fresh.fingerprint
    });
    expect(readSchemaMetadata(context.database)).toEqual(metadata);
    expect(schemaInstaller).toHaveBeenCalledTimes(1);
    expect(dataConvergence).toHaveBeenCalledTimes(1);

    expect(run(context)).toEqual(reopened);
    expect(schemaInstaller).toHaveBeenCalledTimes(1);
    expect(dataConvergence).toHaveBeenCalledTimes(2);
  });

  it("upgrades the prior schema epoch with the bounded Worker Main terminal index and a fresh fingerprint", () => {
    const context = openContext();
    run(context);
    context.database.exec("DROP INDEX worker_turn_cards_session_terminal_updated; UPDATE schema_metadata SET epoch = '2026-10-08.3', fingerprint = 'prior-fingerprint'");

    const upgraded = run(context);

    expect(upgraded).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'worker_turn_cards_session_terminal_updated'").get()).toEqual(expect.objectContaining({
      sql: expect.stringContaining("updated_at DESC")
    }));
    expect(readSchemaMetadata(context.database).fingerprint).not.toBe("prior-fingerprint");
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, fingerprint: upgraded.fingerprint });
  });

  it("upgrades the prior current schema with the Worker actionable-page keyset index", () => {
    const context = openContext();
    expect(run(context)).toMatchObject({ route: "fresh-baseline", epoch: CURRENT_SCHEMA_EPOCH });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='worker_turn_cards_actionable_page_keyset'").get()).toEqual({
      name: "worker_turn_cards_actionable_page_keyset"
    });
    context.database.prepare(`INSERT INTO outbound_replies(
      id,idempotency_key,root_message_id,kind,payload,state,next_attempt_at,created_at,updated_at,
      scope_kind,scope_key,delivery_order,lane_key,conflict_key
    ) VALUES('legacy-worker-page','legacy-worker-page','root','text','legacy-worker-page-bytes','pending','t','t','t',
      'global',json_array('global'),1,'legacy-worker-page','legacy-worker-page')`).run();
    const before = context.database.prepare(`SELECT id,idempotency_key,root_message_id,kind,payload,state,next_attempt_at,created_at,updated_at,
      scope_kind,scope_key,delivery_order,lane_key,conflict_key FROM outbound_replies WHERE id='legacy-worker-page'`).get();
    context.database.exec(`
      DROP INDEX IF EXISTS worker_turn_cards_actionable_page_keyset;
      DELETE FROM schema_migrations WHERE version=142;
      UPDATE schema_metadata SET epoch='2026-10-18.2',fingerprint='pre-worker-page-keyset';
    `);

    const upgraded = run(context);

    expect(upgraded).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='worker_turn_cards_actionable_page_keyset'").get()).toEqual(expect.objectContaining({
      sql: expect.stringContaining("updated_at")
    }));
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=142").get()).toEqual({ version: 142 });
    expect(readSchemaMetadata(context.database).fingerprint).not.toBe("pre-worker-page-keyset");
    expect(context.database.prepare(`SELECT id,idempotency_key,root_message_id,kind,payload,state,next_attempt_at,created_at,updated_at,
      scope_kind,scope_key,delivery_order,lane_key,conflict_key FROM outbound_replies WHERE id='legacy-worker-page'`).get()).toEqual(before);
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, fingerprint: upgraded.fingerprint });
  });

  it("upgrades the prior current schema with the completed project selection keyset index", () => {
    const context = openContext();
    run(context);
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='project_selections_completed_initial_page'").get()).toEqual({
      name: "project_selections_completed_initial_page"
    });
    context.database.exec(`
      DROP INDEX IF EXISTS project_selections_completed_initial_page;
      DELETE FROM schema_migrations WHERE version=143;
      UPDATE schema_metadata SET epoch='2026-10-20.1',fingerprint='pre-project-selection-page-keyset';
    `);

    const upgraded = run(context);

    expect(upgraded).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='project_selections_completed_initial_page'").get()).toEqual(expect.objectContaining({
      sql: expect.stringContaining("WHERE state = 'completed' AND initial_prompt_text IS NOT NULL")
    }));
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=143").get()).toEqual({ version: 143 });
    expect(readSchemaMetadata(context.database).fingerprint).not.toBe("pre-project-selection-page-keyset");
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, fingerprint: upgraded.fingerprint });
  });

  it("upgrades the prior current schema with the Conversation actionable page keyset index", () => {
    const context = openContext();
    run(context);
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='conversation_segments_actionable_page_keyset'").get()).toEqual({
      name: "conversation_segments_actionable_page_keyset"
    });
    context.database.exec(`
      DROP INDEX IF EXISTS conversation_segments_actionable_page_keyset;
      DELETE FROM schema_migrations WHERE version=144;
      UPDATE schema_metadata SET epoch='2026-10-20.2',fingerprint='pre-conversation-actionable-page-keyset';
    `);

    const upgraded = run(context);

    expect(upgraded).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='conversation_segments_actionable_page_keyset'").get()).toEqual(expect.objectContaining({
      sql: expect.stringContaining("updated_at,id")
    }));
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=144").get()).toEqual({ version: 144 });
    expect(readSchemaMetadata(context.database).fingerprint).not.toBe("pre-conversation-actionable-page-keyset");
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, fingerprint: upgraded.fingerprint });
  });

  it("upgrades the T7 schema epoch with bounded Delivery Ring indexes and a fresh fingerprint", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DROP INDEX outbound_replies_scope_delivery_order;
      DROP INDEX worker_human_review_create_reply;
      DELETE FROM schema_migrations WHERE version=114;
      UPDATE schema_metadata SET epoch='2026-10-08.4',fingerprint='t7-fingerprint';
    `);

    const upgraded = run(context);

    expect(upgraded).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('outbound_replies_scope_delivery_order','worker_human_review_create_reply') ORDER BY name").all()).toEqual([
      { name: "outbound_replies_scope_delivery_order" },
      { name: "worker_human_review_create_reply" }
    ]);
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=114").get()).toEqual({ version: 114 });
    expect(readSchemaMetadata(context.database).fingerprint).not.toBe("t7-fingerprint");
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, fingerprint: upgraded.fingerprint });
  });

  it.each(["already present", "absent"] as const)("adopts the exact-turn owner projection ledger when it is %s", (state) => {
    const context = openContext();
    run(context);
    if (state === "absent") context.database.exec("DROP TABLE core_event_owner_projections");
    context.database.exec(`
      DELETE FROM schema_migrations WHERE version=122;
      UPDATE schema_metadata SET epoch='2026-10-09.2',fingerprint='pre-owner-ledger';
    `);

    const upgraded = run(context);

    expect(upgraded).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='core_event_owner_projections'").get())
      .toEqual({ name: "core_event_owner_projections" });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='core_event_owner_projection_event'").get())
      .toEqual({ name: "core_event_owner_projection_event" });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=122").get()).toEqual({ version: 122 });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, fingerprint: upgraded.fingerprint });
  });

  it("creates planner statistics after all released indexes exist", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DELETE FROM sqlite_stat1;
      DELETE FROM schema_migrations WHERE version=123;
      UPDATE schema_metadata SET epoch='2026-10-09.3',fingerprint='pre-planner-statistics';
    `);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM sqlite_stat1").get()).toEqual({ count: 0 });

    const upgraded = run(context);

    expect(upgraded).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM sqlite_stat1").get()).toMatchObject({ count: expect.any(Number) });
    expect((context.database.prepare("SELECT COUNT(*) AS count FROM sqlite_stat1").get() as { count: number }).count).toBeGreaterThan(0);
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=123").get()).toEqual({ version: 123 });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, fingerprint: upgraded.fingerprint });
  });

  it("adds the fenced Session Activity identity projection idempotently", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DROP INDEX session_activity_agent_identities_source;
      DROP TABLE session_activity_agent_identities;
      DELETE FROM schema_migrations WHERE version=125;
      UPDATE schema_metadata SET epoch='2026-10-10.4',fingerprint='pre-agent-identity';
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=125").get()).toEqual({ version: 125 });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_activity_agent_identities'").get())
      .toEqual({ name: "session_activity_agent_identities" });
    expect(context.database.prepare("PRAGMA foreign_key_list(session_activity_agent_identities)").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ table: "session_activity_snapshots", on_delete: "CASCADE" })]));
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0 });
  });

  it("upgrades a T7 database missing the longest Conversation recovery column", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      ALTER TABLE conversation_segment_page_recovery_parts DROP COLUMN end_anchor_inclusive;
      DELETE FROM schema_migrations WHERE version IN (113, 114);
      UPDATE schema_metadata SET epoch='2026-10-08.4',fingerprint='t7-fingerprint';
    `);

    const upgraded = run(context);

    expect(upgraded).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT name FROM pragma_table_info('conversation_segment_page_recovery_parts') WHERE name='end_anchor_inclusive'").get()).toEqual({ name: "end_anchor_inclusive" });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, fingerprint: upgraded.fingerprint });
  });

  it.each([
    "metadata-table-created",
    "canonical-schema-created",
    "canonical-schema-validated",
    "metadata-recorded-before-commit"
  ] as const)("rolls back the complete fresh baseline when %s fails", (stage) => {
    const path = temporaryDatabasePath();
    const failing = new SqliteContext(path);

    expect(() => new SqliteMigrations(failing, {
      onFreshBaselineStage(observedStage) {
        if (observedStage === stage) throw new Error(`injected ${stage}`);
      }
    }).run()).toThrow(`injected ${stage}`);
    failing.close();

    const reopened = new SqliteContext(path);
    expect(tableNames(reopened.database)).not.toContain("schema_metadata");
    expect(tableNames(reopened.database)).not.toContain("schema_migrations");
    expect(tableNames(reopened.database)).not.toContain("bindings");
    expect(run(reopened)).toMatchObject({ route: "fresh-baseline", compatibilityStepCount: 0 });
    reopened.close();
  });

  it("allows WAL initialization from a second handle while the fresh baseline holds the writer", () => {
    const path = temporaryDatabasePath();
    const first = new SqliteContext(path);
    let second: SqliteContext | undefined;
    const result = new SqliteMigrations(first, {
      onFreshBaselineStage(stage) {
        if (stage !== "canonical-schema-created") return;
        second = new SqliteContext(path, { busyTimeoutMs: 1 });
        expect(() => second?.database.exec("BEGIN IMMEDIATE")).toThrow(/busy|locked/i);
      }
    }).run();

    expect(result.route).toBe("fresh-baseline");
    expect(second).toBeDefined();
    expect(run(second!)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, fingerprint: result.fingerprint });
    second!.close();
    first.close();
  });

  it("fails closed without rewriting current metadata when the catalog or a required marker drifts", () => {
    const catalogContext = openContext();
    run(catalogContext);
    const catalogMetadata = readSchemaMetadata(catalogContext.database);
    catalogContext.database.exec("ALTER TABLE bindings ADD COLUMN unexpected_schema_drift TEXT");

    expect(() => run(catalogContext)).toThrow(/schema.*(fingerprint|catalog|drift)|fingerprint/i);
    expect(readSchemaMetadata(catalogContext.database)).toEqual(catalogMetadata);
    expect(columnNames(catalogContext.database, "bindings")).toContain("unexpected_schema_drift");

    const markerContext = openContext();
    run(markerContext);
    const markerMetadata = readSchemaMetadata(markerContext.database);
    const requiredMarker = canonicalMigrationMarkers().at(-1);
    if (requiredMarker === undefined) throw new Error("canonical marker set must not be empty");
    markerContext.database.prepare("DELETE FROM schema_migrations WHERE version = ?").run(requiredMarker);

    expect(() => run(markerContext)).toThrow(/schema.*(marker|fingerprint|drift)|marker/i);
    expect(readSchemaMetadata(markerContext.database)).toEqual(markerMetadata);
    expect(markerContext.database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(requiredMarker)).toBeUndefined();

    const metadataShapeContext = openContext();
    run(metadataShapeContext);
    metadataShapeContext.database.exec("ALTER TABLE schema_metadata ADD COLUMN unexpected_metadata_drift TEXT");
    expect(() => run(metadataShapeContext)).toThrow(/schema.*(fingerprint|catalog|drift)|fingerprint/i);

    const markerTableShapeContext = openContext();
    run(markerTableShapeContext);
    markerTableShapeContext.database.exec("ALTER TABLE schema_migrations ADD COLUMN unexpected_marker_drift TEXT");
    expect(() => run(markerTableShapeContext)).toThrow(/schema.*(fingerprint|catalog|drift)|fingerprint/i);
  });

  it("rejects a durable table without complete schema policy classification", () => {
    const context = openContext();
    run(context);
    context.database.exec("CREATE TABLE unclassified_workflow_state(id TEXT PRIMARY KEY)");

    expect(() => validateCanonicalSchema(context.database)).toThrow(/schema policy.*unclassified_workflow_state/i);
  });

  it.each([
    ["metadata only", false],
    ["metadata plus a dropped catalog index", true]
  ])("fails closed without compatibility repair when a T3-managed database loses %s", (_name, dropCatalogIndex) => {
    const context = openContext();
    run(context);
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=112").get()).toEqual({ version: 112 });
    context.database.exec("DROP TABLE schema_metadata");
    if (dropCatalogIndex) {
      context.database.exec("DROP INDEX binding_thread_aliases_binding");
      expect(schemaObjects(context.database)).not.toContain("binding_thread_aliases_binding");
    }

    expect(() => run(context)).toThrow(/metadata is missing.*applied ordered migrations/i);
    expect(tableNames(context.database)).not.toContain("schema_metadata");
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=112").get()).toEqual({ version: 112 });
    if (dropCatalogIndex) expect(schemaObjects(context.database)).not.toContain("binding_thread_aliases_binding");
  });

  it.each([
    ["input-card view only", "input-card-view"],
    ["conversation-turn projection only", "conversation-turn-projection"],
    ["neither obligation", "neither"]
  ] as const)("repairs only the missing named marker-89 obligation for the %s historical shape", (_name, presentObligation) => {
    const context = openLegacyMarker89Partial(presentObligation);
    const requirements = legacyMigrationRequirements.filter((requirement) => requirement.marker === 89);

    expect(requirements.map((requirement) => requirement.id)).toEqual([
      "input-card-view",
      "conversation-turn-projection"
    ]);
    expect(requirements).toHaveLength(2);
    const expectedPresent = presentObligation === "neither" ? [] : [presentObligation];
    expect(requirements.filter((requirement) => requirement.isSatisfied(context.database)).map((requirement) => requirement.id)).toEqual(expectedPresent);
    expect(requirements.filter((requirement) => !requirement.isSatisfied(context.database))).toHaveLength(2 - expectedPresent.length);

    const beforeObjects = schemaObjects(context.database);
    const preservedRows = marker89Sentinels(context.database);
    repairLegacyMarker89Obligations(context);
    expect(requirements.every((requirement) => requirement.isSatisfied(context.database))).toBe(true);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=89").get()).toEqual({ count: 1 });
    expect(context.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 89 }]);
    expect(schemaObjects(context.database).filter((name) => !beforeObjects.includes(name))).toEqual(missingMarker89Objects(presentObligation));
    expect(tableNames(context.database)).not.toEqual(expect.arrayContaining(["bindings", "outbound_replies", "schema_metadata"]));
    expect(marker89Sentinels(context.database)).toEqual(preservedRows);
  });

  it.each(["input-card-view", "conversation-turn-projection"] as const)("preserves marker-89 sentinels through the complete compatibility chain for %s", (presentObligation) => {
    const context = openLegacyMarker89Partial(presentObligation);
    const sentinels = marker89Sentinels(context.database);

    expect(run(context)).toMatchObject({ route: "compatibility" });
    expect(legacyMigrationRequirements.every((requirement) => requirement.isSatisfied(context.database))).toBe(true);
    expect(marker89Sentinels(context.database)).toEqual(sentinels);
  });

  it("uses the executable ordered registry as the only post-111 marker insertion path", () => {
    expect(() => defineOrderedMigrations([{ id: 112, name: "one", apply() {} }, { id: 112, name: "two", apply() {} }])).toThrow(/strictly increasing/i);
    expect(() => defineOrderedMigrations([{ id: 111, name: "released", apply() {} }])).toThrow(/greater than 111/i);
    expect(orderedMigrations).toEqual([
      expect.objectContaining({ id: 112, name: "current-schema-metadata" }),
      expect.objectContaining({ id: 113, name: "conversation-active-projection" }),
      expect.objectContaining({ id: 114, name: "delivery-scope-order" }),
      expect.objectContaining({ id: 115, name: "lease-expiry-milliseconds" }),
      expect.objectContaining({ id: 116, name: "core-event-discriminators" }),
      expect.objectContaining({ id: 117, name: "session-activity" }),
      expect.objectContaining({ id: 118, name: "retention-audit-skeletons" }),
      expect.objectContaining({ id: 119, name: "retention-payload-compaction" }),
      expect.objectContaining({ id: 120, name: "delivery-conflict-quarantine-budget" }),
      expect.objectContaining({ id: 121, name: "delivery-quarantine-review" }),
      expect.objectContaining({ id: 122, name: "core-event-owner-projections" }),
      expect.objectContaining({ id: 123, name: "sqlite-planner-statistics" }),
      expect.objectContaining({ id: 124, name: "primary-segment-completion-interactions" }),
      expect.objectContaining({ id: 125, name: "session-activity-agent-identities" }),
      expect.objectContaining({ id: 126, name: "completion-review-action-set-lifecycle" }),
      expect.objectContaining({ id: 127, name: "canonical-input-recovery-auto-close" }),
      expect.objectContaining({ id: 128, name: "replacement-recovery-identity-index" }),
      expect.objectContaining({ id: 129, name: "retained-multi-agent-call-index" }),
      expect.objectContaining({ id: 130, name: "canonical-recovery-recovered-state" }),
      expect.objectContaining({ id: 131, name: "retained-checkpoint-session-index" }),
      expect.objectContaining({ id: 132, name: "retained-recovery-checkpoint" }),
      expect.objectContaining({ id: 133, name: "pane-topology-intents" }),
      expect.objectContaining({ id: 134, name: "worker-delivery-parent-pane" }),
      expect.objectContaining({ id: 135, name: "collaboration-multi-agent-call-index" }),
      expect.objectContaining({ id: 136, name: "historical-core-recovery-index" }),
      expect.objectContaining({ id: 137, name: "historical-missing-page-index" }),
      expect.objectContaining({ id: 138, name: "typed-human-input-message" }),
      expect.objectContaining({ id: 139, name: "completion-choice-compatibility-reason" }),
      expect.objectContaining({ id: 140, name: "core-event-lane-conflict-diagnostics" }),
      expect.objectContaining({ id: 141, name: "runtime-identity-claim-owner" }),
      expect.objectContaining({ id: 142, name: "worker-actionable-page-keyset" }),
      expect.objectContaining({ id: 143, name: "completed-project-selection-page-keyset" }),
      expect.objectContaining({ id: 144, name: "conversation-actionable-page-keyset" })
    ]);
    const context = openContext();
    context.database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)");
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=112").get()).toBeUndefined();
    expect(() => applyOrderedMigrations(context)).toThrow(/instance_lease|conversation_segment/);
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=112").get()).toEqual({ version: 112 });
  });

  it("backfills the parent Pane fence without rescoping historical Worker delivery", () => {
    const context = openContext();
    context.database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE outbound_replies(
        id TEXT PRIMARY KEY,scope_kind TEXT,scope_key TEXT,scope_workspace_id TEXT,scope_pane_id TEXT,
        delivery_owner_kind TEXT,delivery_owner_id TEXT,delivery_owner_generation INTEGER,
        delivery_owner_session_generation INTEGER,delivery_parent_id TEXT,delivery_parent_generation INTEGER,
        delivery_parent_session_generation INTEGER,state TEXT,attempt_count INTEGER,effect_certainty TEXT,gateway_plan_hash TEXT
      );
      CREATE TRIGGER outbound_replies_immutable_claim
      BEFORE UPDATE OF delivery_parent_session_generation, state ON outbound_replies
      WHEN NEW.delivery_parent_session_generation IS NOT OLD.delivery_parent_session_generation OR NEW.state IS NOT OLD.state
      BEGIN SELECT RAISE(ABORT, 'immutable_outbound_revision'); END;
      INSERT INTO outbound_replies VALUES(
        'legacy-worker','pane',json_array('pane','workspace','primary-pane'),'workspace','primary-pane',
        'worker','worker',2,3,'binding',1,4,'pending',2,'uncertain','frozen-plan'
      );
    `);
    const insertMarker = context.database.prepare("INSERT INTO schema_migrations(version) VALUES (?)");
    for (const migration of orderedMigrations.filter(({ id }) => id < 134)) insertMarker.run(migration.id);

    applyOrderedMigrations(context);

    expect(context.database.prepare(`SELECT scope_key,scope_pane_id,delivery_parent_pane_id,state,attempt_count,effect_certainty,gateway_plan_hash
      FROM outbound_replies WHERE id='legacy-worker'`).get()).toEqual({
      scope_key: '["pane","workspace","primary-pane"]', scope_pane_id: "primary-pane",
      delivery_parent_pane_id: "primary-pane", state: "pending", attempt_count: 2,
      effect_certainty: "uncertain", gateway_plan_hash: "frozen-plan"
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=134").get()).toEqual({ version: 134 });
    expect(() => context.database.prepare("UPDATE outbound_replies SET delivery_parent_pane_id='other' WHERE id='legacy-worker'").run())
      .toThrow("immutable_outbound_revision");
  });

  it("backfills exact lease expiry milliseconds before recording migration 115", () => {
    const context = openContext();
    context.database.exec(`
      CREATE TABLE instance_lease(
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),owner_id TEXT NOT NULL,fencing_token INTEGER NOT NULL,
        expires_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE core_event_inbox(
        event_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,agent_kind TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT,
        source_cursor TEXT NOT NULL,occurred_at TEXT NOT NULL,event_json TEXT NOT NULL,ingested_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version) VALUES (112),(113),(114);
      INSERT INTO instance_lease(singleton_id,owner_id,fencing_token,expires_at,updated_at)
        VALUES (1,'old-owner',7,'2000-01-01T00:00:00.000+00:00','1999-12-31T23:59:59.000Z');
    `);

    applyOrderedMigrations(context);

    expect(columnNames(context.database, "instance_lease")).toContain("expires_at_ms");
    expect(context.database.prepare("SELECT expires_at,expires_at_ms FROM instance_lease").get()).toEqual({
      expires_at: "2000-01-01T00:00:00.000+00:00",
      expires_at_ms: Date.UTC(2000, 0, 1)
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=115").get()).toEqual({ version: 115 });
  });

  it("upgrades an epoch-5 lease row and fast-reopens the normalized millisecond schema", () => {
    const context = openContext();
    run(context);
    downgradeLeaseSchemaToEpoch5(context, "2000-01-01T00:00:00.000-05:00");

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT expires_at,expires_at_ms FROM instance_lease").get()).toEqual({
      expires_at: "2000-01-01T00:00:00.000-05:00",
      expires_at_ms: Date.UTC(2000, 0, 1, 5)
    });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("upgrades epoch 6 without activating normalized Core reads before bounded backfill", () => {
    const context = openContext();
    run(context);
    const legacyEvent = JSON.stringify({
      schemaVersion: 1, eventId: "legacy-core-event", cursor: "legacy:1", sourceId: "legacy", agentKind: "traex",
      sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-08T00:00:00.000Z",
      payload: { type: "message", message_id: "m1", channel: "final", text: "answer", truncated: false }
    });
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at
    ) VALUES('legacy-core-event','legacy','traex','session-1','turn-1','legacy:1','2026-10-08T00:00:00.000Z',?,'2026-10-08T00:00:00.000Z')`).run(legacyEvent);
    context.database.exec(`
      DROP INDEX core_event_inbox_type_session_turn;
      DROP INDEX core_event_inbox_submission;
      DROP INDEX core_event_inbox_channel;
      DROP INDEX core_event_inbox_call;
      DROP TABLE core_event_discriminator_backfill;
      DELETE FROM schema_migrations WHERE version=116;
      UPDATE schema_metadata SET epoch='2026-10-08.6',fingerprint='epoch-6-fixture' WHERE singleton_id=1;
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare(`SELECT state,high_water_event_id,after_event_id,processed_count
      FROM core_event_discriminator_backfill`).get()).toEqual({
      state: "backfilling", high_water_event_id: "legacy-core-event", after_event_id: "", processed_count: 0
    });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=116").get()).toEqual({ version: 116 });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("upgrades epoch 7 with fenced Session Activity tables", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DROP INDEX session_activity_items_visible;
      DROP TABLE session_activity_items;
      DROP INDEX session_activity_snapshots_binding;
      DROP TABLE session_activity_snapshots;
      DELETE FROM schema_migrations WHERE version=117;
      UPDATE schema_metadata SET epoch='2026-10-08.7',fingerprint='epoch-7-fixture' WHERE singleton_id=1;
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=117").get()).toEqual({ version: 117 });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_activity_snapshots'").get()).toEqual({ name: "session_activity_snapshots" });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_activity_items'").get()).toEqual({ name: "session_activity_items" });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("upgrades epoch 8 with permanent fenced Audit Skeleton tables", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DROP INDEX audit_skeleton_links_reverse;
      DROP TABLE audit_skeleton_links;
      DROP INDEX audit_skeletons_binding;
      DROP INDEX audit_skeletons_owner;
      DROP TABLE audit_skeletons;
      DELETE FROM schema_migrations WHERE version=118;
      UPDATE schema_metadata SET epoch='2026-10-08.8',fingerprint='epoch-8-fixture' WHERE singleton_id=1;
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=118").get()).toEqual({ version: 118 });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_skeletons'").get()).toEqual({ name: "audit_skeletons" });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_skeleton_links'").get()).toEqual({ name: "audit_skeleton_links" });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("upgrades epoch 9 without rewriting retained payload rows and fast-reopens the compaction schema", () => {
    const context = openContext();
    run(context);
    const eventJson = JSON.stringify({ schemaVersion: 1, eventId: "retained-event", payload: { type: "status", text: "retain me" } });
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type
    ) VALUES('retained-event','source','traex','session','turn','cursor','2026-09-01T00:00:00.000Z',?,'2026-09-01T00:00:00.000Z','status')`).run(eventJson);
    context.database.exec(`
      DROP INDEX core_event_inbox_retention;
      DROP INDEX core_event_inbox_multi_agent_call;
      DROP INDEX answer_timeline_items_retention;
      DROP INDEX conversation_segment_items_retention;
      DROP INDEX outbound_replies_payload_retention;
      DROP TABLE retention_compaction_cursors;
      DROP TRIGGER outbound_replies_immutable_claim;
      DROP TRIGGER semantic_delivery_rollout_guarded_transition;
      ALTER TABLE core_event_inbox DROP COLUMN payload_compacted_at;
      ALTER TABLE answer_timeline_items DROP COLUMN payload_compacted_at;
      ALTER TABLE conversation_segment_items DROP COLUMN payload_compacted_at;
      ALTER TABLE outbound_replies DROP COLUMN payload_compacted_at;
      DELETE FROM schema_migrations WHERE version=119;
      UPDATE schema_metadata SET epoch='2026-10-08.9',fingerprint='epoch-9-fixture' WHERE singleton_id=1;
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare("SELECT event_json FROM core_event_inbox WHERE event_id='retained-event'").get()).toEqual({ event_json: eventJson });
    for (const table of ["core_event_inbox", "answer_timeline_items", "conversation_segment_items", "outbound_replies"]) {
      expect(columnNames(context.database, table)).toContain("payload_compacted_at");
    }
    expect(context.database.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN (
      'core_event_inbox_retention','answer_timeline_items_retention','conversation_segment_items_retention','outbound_replies_payload_retention'
    ) ORDER BY name`).all()).toEqual([
      { name: "answer_timeline_items_retention" },
      { name: "conversation_segment_items_retention" },
      { name: "core_event_inbox_retention" },
      { name: "outbound_replies_payload_retention" }
    ]);
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=119").get()).toEqual({ version: 119 });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='retention_compaction_cursors'").get())
      .toEqual({ name: "retention_compaction_cursors" });
    expect((context.database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='outbound_replies_immutable_claim'").get() as { sql: string }).sql)
      .toContain("verified_payload_compaction");
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("upgrades epoch 10 with additive Delivery conflict and quarantine budget state", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DROP INDEX outbound_replies_scope_conflict_order;
      DROP INDEX outbound_replies_conflict_backfill;
      DROP INDEX outbox_lane_quarantines_phase_deadline;
      DROP TRIGGER outbound_replies_immutable_claim;
      ALTER TABLE outbound_replies DROP COLUMN conflict_key;
      ALTER TABLE outbox_lane_quarantines DROP COLUMN conflict_key;
      ALTER TABLE outbox_lane_quarantines DROP COLUMN phase;
      ALTER TABLE outbox_lane_quarantines DROP COLUMN first_failed_at;
      ALTER TABLE outbox_lane_quarantines DROP COLUMN grace_deadline_at;
      ALTER TABLE outbox_lane_quarantines DROP COLUMN degraded_at;
      ALTER TABLE outbox_lane_quarantines DROP COLUMN budget_attempt_limit;
      ALTER TABLE outbox_lane_quarantines DROP COLUMN budget_duration_ms;
      DELETE FROM schema_migrations WHERE version=120;
      UPDATE schema_metadata SET epoch='2026-10-08.10',fingerprint='epoch-10-fixture' WHERE singleton_id=1;
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(columnNames(context.database, "outbound_replies")).toContain("conflict_key");
    expect(columnNames(context.database, "outbox_lane_quarantines")).toEqual(expect.arrayContaining([
      "conflict_key", "phase", "first_failed_at", "grace_deadline_at", "degraded_at",
      "budget_attempt_limit", "budget_duration_ms"
    ]));
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=120").get()).toEqual({ version: 120 });
    expect((context.database.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='outbound_replies_immutable_claim'").get() as { sql: string }).sql)
      .toContain("conflict_key");
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it("upgrades the bounded-degradation epoch with durable quarantine review identity", () => {
    const context = openContext();
    run(context);
    context.database.exec(`
      DROP INDEX outbox_lane_quarantines_review_reply;
      ALTER TABLE outbox_lane_quarantines DROP COLUMN review_reply_id;
      ALTER TABLE outbox_lane_quarantines DROP COLUMN review_requested_at;
      DELETE FROM schema_migrations WHERE version=121;
      UPDATE schema_metadata SET epoch='2026-10-09.1',fingerprint='bounded-degradation-fixture' WHERE singleton_id=1;
    `);

    expect(run(context)).toMatchObject({ route: "compatibility", compatibilityStepCount: 1, epoch: CURRENT_SCHEMA_EPOCH });
    expect(columnNames(context.database, "outbox_lane_quarantines")).toEqual(expect.arrayContaining([
      "review_reply_id", "review_requested_at"
    ]));
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=121").get()).toEqual({ version: 121 });
    expect(context.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='outbox_lane_quarantines_review_reply'").get())
      .toEqual({ name: "outbox_lane_quarantines_review_reply" });
    expect(run(context)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0, epoch: CURRENT_SCHEMA_EPOCH });
  });

  it.each([
    "not-a-timestamp",
    "2026-02-30T00:00:00.000Z"
  ])("fails closed without metadata advancement when an epoch-5 lease expiry cannot be normalized exactly: %s", (expiresAt) => {
    const context = openContext();
    run(context);
    downgradeLeaseSchemaToEpoch5(context, expiresAt);

    expect(() => run(context)).toThrow(/invalid stored expires_at/i);
    expect(columnNames(context.database, "instance_lease")).not.toContain("expires_at_ms");
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=115").get()).toBeUndefined();
    expect(context.database.prepare("SELECT epoch FROM schema_metadata WHERE singleton_id=1").get()).toEqual({ epoch: "2026-10-08.5" });
  });

  it("rechecks the live lease inside each Conversation index DDL transaction", () => {
    const context = openContext(); run(context);
    context.database.exec(`DROP INDEX conversation_segment_pages_current_lookup;
      DROP INDEX conversation_segment_late_recoveries_open_item;
      DROP INDEX conversation_segment_late_recoveries_state;`);
    const original = context.migrationTransaction.bind(context);
    const transaction = vi.spyOn(context, "migrationTransaction");
    transaction.mockImplementation(((label: string, operation: () => unknown) => {
      if (label === "sqlite.migrations.t5-current-lookup-index") {
        context.database.prepare(`INSERT OR REPLACE INTO instance_lease(singleton_id,owner_id,fencing_token,expires_at,expires_at_ms,updated_at)
          VALUES(1,'racing-service',7,'2999-01-01T00:00:00.000Z',?,'2026-10-08T00:00:00.000Z')`).run(Date.UTC(2999, 0, 1));
      }
      return original(label, operation);
    }) as typeof context.migrationTransaction);

    expect(() => prepareConversationActiveProjectionMigration(context)).toThrow(/requires lease release.*racing-service/);
    expect(context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='conversation_segment_pages_current_lookup'").get()).toBeUndefined();
    expect(context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='conversation_segment_late_recoveries_state'").get()).toBeUndefined();
    transaction.mockRestore();
  });

  it("permits only the exact bootstrap lease and rechecks its fencing token before each Conversation index DDL transaction", () => {
    const context = openContext(); run(context);
    context.database.exec(`DROP INDEX conversation_segment_pages_current_lookup;
      DROP INDEX conversation_segment_late_recoveries_open_item;
      DROP INDEX conversation_segment_late_recoveries_state;`);
    context.database.prepare(`INSERT OR REPLACE INTO instance_lease(singleton_id,owner_id,fencing_token,expires_at,expires_at_ms,updated_at)
      VALUES(1,'bootstrap-owner',7,'2999-01-01T00:00:00.000Z',?,'2026-10-08T00:00:00.000Z')`).run(Date.UTC(2999, 0, 1));
    const original = context.migrationTransaction.bind(context);
    const transaction = vi.spyOn(context, "migrationTransaction");
    transaction.mockImplementation(((label: string, operation: () => unknown) => {
      if (label === "sqlite.migrations.t5-current-lookup-index") {
        context.database.prepare("UPDATE instance_lease SET fencing_token=8 WHERE singleton_id=1").run();
      }
      return original(label, operation);
    }) as typeof context.migrationTransaction);

    expect(() => runWithExclusiveMigrationLock(context, { ownerId: "bootstrap-owner", fencingToken: 7 }, (authorization) =>
      prepareConversationActiveProjectionMigration(context, authorization)))
      .toThrow(/bootstrap lease.*(changed|matching)/i);
    expect(context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='conversation_segment_pages_current_lookup'").get()).toBeUndefined();
    expect(context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='conversation_segment_late_recoveries_state'").get()).toBeUndefined();
    transaction.mockRestore();
  });

  it("rechecks the bootstrap lease before recording ordered migration 112", () => {
    const context = openContext(); run(context);
    context.database.prepare("DELETE FROM schema_migrations WHERE version=112").run();
    installBootstrapLease(context, 7);
    const original = context.migrationTransaction.bind(context);
    const transaction = vi.spyOn(context, "migrationTransaction");
    transaction.mockImplementation(((label: string, operation: () => unknown) => {
      if (label === "sqlite.migrations.record-112") context.database.prepare("UPDATE instance_lease SET fencing_token=8 WHERE singleton_id=1").run();
      return original(label, operation);
    }) as typeof context.migrationTransaction);

    expect(() => runWithExclusiveMigrationLock(context, { ownerId: "bootstrap-owner", fencingToken: 7 }, (authorization) =>
      applyOrderedMigrations(context, authorization))).toThrow(/bootstrap lease.*(changed|matching)/i);
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=112").get()).toBeUndefined();
    transaction.mockRestore();
  });

  it("rechecks the bootstrap lease between migration 113 final DDL and its marker write", () => {
    const context = openContext(); run(context);
    context.database.prepare("DELETE FROM schema_migrations WHERE version=113").run();
    installBootstrapLease(context, 7);
    const original = context.migrationTransaction.bind(context);
    const transaction = vi.spyOn(context, "migrationTransaction");
    transaction.mockImplementation(((label: string, operation: () => unknown) => {
      if (label === "sqlite.migrations.record-113") context.database.prepare("UPDATE instance_lease SET fencing_token=8 WHERE singleton_id=1").run();
      return original(label, operation);
    }) as typeof context.migrationTransaction);

    expect(() => runWithExclusiveMigrationLock(context, { ownerId: "bootstrap-owner", fencingToken: 7 }, (authorization) =>
      applyOrderedMigrations(context, authorization))).toThrow(/bootstrap lease.*(changed|matching)/i);
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=113").get()).toBeUndefined();
    transaction.mockRestore();
  });

  it("rechecks the bootstrap lease before each migration 114 index mutation", () => {
    const context = openContext(); run(context);
    context.database.exec(`DELETE FROM schema_migrations WHERE version=114;
      DROP INDEX outbound_replies_scope_delivery_order;
      DROP INDEX worker_human_review_create_reply;`);
    installBootstrapLease(context, 7);
    const original = context.migrationTransaction.bind(context);
    const transaction = vi.spyOn(context, "migrationTransaction");
    transaction.mockImplementation(((label: string, operation: () => unknown) => {
      if (label === "sqlite.migrations.t8-worker-review-create-reply") context.database.prepare("UPDATE instance_lease SET fencing_token=8 WHERE singleton_id=1").run();
      return original(label, operation);
    }) as typeof context.migrationTransaction);

    expect(() => runWithExclusiveMigrationLock(context, { ownerId: "bootstrap-owner", fencingToken: 7 }, (authorization) =>
      applyOrderedMigrations(context, authorization))).toThrow(/bootstrap lease.*(changed|matching)/i);
    expect(context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='outbound_replies_scope_delivery_order'").get()).toEqual({ 1: 1 });
    expect(context.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='worker_human_review_create_reply'").get()).toBeUndefined();
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=114").get()).toBeUndefined();
    transaction.mockRestore();
  });

  it("rechecks the bootstrap lease between migration 114 final DDL and its marker write", () => {
    const context = openContext(); run(context);
    context.database.prepare("DELETE FROM schema_migrations WHERE version=114").run();
    installBootstrapLease(context, 7);
    const original = context.migrationTransaction.bind(context);
    const transaction = vi.spyOn(context, "migrationTransaction");
    transaction.mockImplementation(((label: string, operation: () => unknown) => {
      if (label === "sqlite.migrations.record-114") context.database.prepare("UPDATE instance_lease SET fencing_token=8 WHERE singleton_id=1").run();
      return original(label, operation);
    }) as typeof context.migrationTransaction);

    expect(() => runWithExclusiveMigrationLock(context, { ownerId: "bootstrap-owner", fencingToken: 7 }, (authorization) =>
      applyOrderedMigrations(context, authorization))).toThrow(/bootstrap lease.*(changed|matching)/i);
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=114").get()).toBeUndefined();
    transaction.mockRestore();
  });

  it("rechecks the bootstrap lease before post-ordered query-index convergence", () => {
    const context = openContext(); run(context);
    context.database.prepare("UPDATE schema_metadata SET epoch='2026-10-08.2' WHERE singleton_id=1").run();
    installBootstrapLease(context, 7);
    const original = context.migrationTransaction.bind(context);
    const transaction = vi.spyOn(context, "migrationTransaction");
    transaction.mockImplementation(((label: string, operation: () => unknown) => {
      if (label === "sqlite.migrations.t7-worker-main-index") context.database.prepare("UPDATE instance_lease SET fencing_token=8 WHERE singleton_id=1").run();
      return original(label, operation);
    }) as typeof context.migrationTransaction);

    expect(() => runWithExclusiveMigrationLock(context, { ownerId: "bootstrap-owner", fencingToken: 7 }, (authorization) =>
      new SqliteMigrations(context, { migrationLeaseAuthorization: authorization }).run())).toThrow(/bootstrap lease.*(changed|matching)/i);
    expect(readSchemaMetadata(context.database).epoch).toBe("2026-10-08.2");
    transaction.mockRestore();
  });

  it("rechecks the bootstrap lease before post-ordered metadata ownership", () => {
    const context = openContext(); run(context);
    context.database.exec("UPDATE schema_metadata SET epoch='2026-10-08.4' WHERE singleton_id=1; DELETE FROM schema_migrations WHERE version=114;");
    installBootstrapLease(context, 7);
    const original = context.migrationTransaction.bind(context);
    const transaction = vi.spyOn(context, "migrationTransaction");
    transaction.mockImplementation(((label: string, operation: () => unknown) => {
      if (label === "sqlite.migrations.t8-delivery-scope-order-metadata") context.database.prepare("UPDATE instance_lease SET fencing_token=8 WHERE singleton_id=1").run();
      return original(label, operation);
    }) as typeof context.migrationTransaction);

    expect(() => runWithExclusiveMigrationLock(context, { ownerId: "bootstrap-owner", fencingToken: 7 }, (authorization) =>
      new SqliteMigrations(context, { migrationLeaseAuthorization: authorization }).run())).toThrow(/bootstrap lease.*(changed|matching)/i);
    expect(readSchemaMetadata(context.database).epoch).toBe("2026-10-08.4");
    transaction.mockRestore();
  });

  it("rechecks the bootstrap lease before entering compatibility writes", () => {
    const context = openLegacyMarker89Partial("input-card-view");
    createInstanceLeaseSchema(context);
    installBootstrapLease(context, 7);
    const original = context.observeManualTransactions.bind(context);
    const manualGroup = vi.spyOn(context, "observeManualTransactions");
    manualGroup.mockImplementation(((label: string, operation: () => unknown) => {
      if (label === "sqlite.migrations.compatibility") context.database.prepare("UPDATE instance_lease SET fencing_token=8 WHERE singleton_id=1").run();
      return original(label, operation);
    }) as typeof context.observeManualTransactions);

    expect(() => runWithExclusiveMigrationLock(context, { ownerId: "bootstrap-owner", fencingToken: 7 }, (authorization) =>
      new SqliteMigrations(context, { migrationLeaseAuthorization: authorization }).run())).toThrow(/bootstrap lease.*(changed|matching)/i);
    expect(tableNames(context.database)).not.toContain("schema_metadata");
    manualGroup.mockRestore();
  });

  it("makes fresh baseline and compatibility-upgraded catalogs canonically equivalent", () => {
    const freshContext = openContext();
    const compatibilityContext = openLegacyMarker89Partial("input-card-view");

    run(freshContext);
    const compatibility = run(compatibilityContext);
    const freshCatalog = canonicalSchemaCatalog(freshContext.database) as CanonicalSchemaCatalog;
    const compatibilityCatalog = canonicalSchemaCatalog(compatibilityContext.database) as CanonicalSchemaCatalog;

    expect(compatibility.route).toBe("compatibility");
    expectCanonicalOrdering(freshCatalog);
    expectCanonicalOrdering(compatibilityCatalog);
    expect(compatibilityCatalog).toEqual(freshCatalog);
  });

  it("restores a complete one-step-behind marker-69 historical catalog and fast-reopens it", () => {
    const freshContext = openContext();
    const historicalContext = openContext();
    run(freshContext);
    run(historicalContext);
    historicalContext.database.prepare(`
      INSERT INTO bindings(id, workspace_id, chat_id, title, runtime, state, last_agent_state, created_at, updated_at)
      VALUES ('marker-69-sentinel', 'workspace', 'chat', 'unaffected historical row', 'traex', 'active', 'idle', 't', 't')
    `).run();
    historicalContext.database.exec(`
      DROP TABLE card_dismissals;
      DROP INDEX worker_turn_cards_actionable_page_keyset;
      DROP INDEX project_selections_completed_initial_page;
      DROP INDEX conversation_segments_actionable_page_keyset;
      DELETE FROM schema_migrations WHERE version=111 OR version>=112;
      DROP TABLE schema_metadata;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (69);
    `);

    expect(run(historicalContext)).toMatchObject({ route: "compatibility" });
    expect(canonicalSchemaCatalog(historicalContext.database)).toEqual(canonicalSchemaCatalog(freshContext.database));
    expect(schemaObjects(historicalContext.database)).toEqual(expect.arrayContaining([
      "worker_turn_cards_actionable_page_keyset",
      "project_selections_completed_initial_page",
      "conversation_segments_actionable_page_keyset"
    ]));
    expect(historicalContext.database.prepare("SELECT version FROM schema_migrations WHERE version=69").get()).toEqual({ version: 69 });
    expect(canonicalSchemaCatalog(historicalContext.database).markers).not.toContain(69);
    expect(historicalContext.database.prepare("SELECT version FROM schema_migrations WHERE version=111").get()).toEqual({ version: 111 });
    expect(historicalContext.database.prepare("SELECT id, title FROM bindings WHERE id='marker-69-sentinel'").get()).toEqual({
      id: "marker-69-sentinel", title: "unaffected historical row"
    });
    expect(run(historicalContext)).toMatchObject({ route: "current-fast", compatibilityStepCount: 0 });
  });

  it("backfills authoritative snapshot counters on the metadata-absent compatibility route", () => {
    const context = openContext();
    run(context);
    const eventJson = JSON.stringify({ schemaVersion: 1, eventId: "event-1", cursor: "c1", sourceId: "source", agentKind: "traex", sessionId: "session", turnId: "turn", occurredAt: "2026-10-08T00:00:00.000Z", payload: { type: "turn_started" } });
    const eventsJson = `[${eventJson}]`;
    context.database.prepare(`INSERT INTO authoritative_turn_snapshots(
      agent_kind,session_id,turn_id,requested_started_at,owner_kind,owner_id,canonical_started_at,state,next_cursor,complete,
      failure_code,event_count,payload_bytes,created_at,updated_at
    ) VALUES ('traex','session','turn','requested','binding','b1','started','staging','c1',0,NULL,0,0,'t','t')`).run();
    context.database.prepare(`INSERT INTO authoritative_turn_snapshot_pages(
      agent_kind,session_id,turn_id,requested_started_at,after_cursor,next_cursor,outcome,complete,page_hash,events_json,created_at
    ) VALUES ('traex','session','turn','requested','','c1','recovered',0,'hash',?,'t')`).run(eventsJson);
    context.database.prepare(`INSERT INTO authoritative_turn_snapshot_events(
      agent_kind,session_id,turn_id,requested_started_at,event_id,sequence,event_hash,event_json,created_at
    ) VALUES ('traex','session','turn','requested','event-1',1,'hash',?,'t')`).run(eventJson);
    context.database.exec("DROP TABLE card_dismissals; DELETE FROM schema_migrations WHERE version>=112; DROP TABLE schema_metadata");

    expect(run(context)).toMatchObject({ route: "compatibility", epoch: CURRENT_SCHEMA_EPOCH });
    expect(context.database.prepare(`SELECT event_count,payload_bytes FROM authoritative_turn_snapshots
      WHERE agent_kind='traex' AND session_id='session' AND turn_id='turn' AND requested_started_at='requested'`).get()).toEqual({
      event_count: 1,
      payload_bytes: Buffer.byteLength(eventsJson, "utf8") + Buffer.byteLength(eventJson, "utf8")
    });
  });

  it("provides isolated current-schema fixture clones while explicit migration contexts retain compatibility routing", () => {
    const first = createCurrentSchemaTestStoreBundle() as CurrentFixtureBundle;
    const second = createCurrentSchemaTestStoreBundle() as CurrentFixtureBundle;
    currentFixtureBundles.push(first, second);

    expect(first.schemaMigration).toMatchObject({ route: "current-fast", compatibilityStepCount: 0 });
    expect(second.schemaMigration).toMatchObject({ route: "current-fast", compatibilityStepCount: 0 });
    first.driver.database.exec("CREATE TABLE fixture_isolation_probe(id TEXT PRIMARY KEY)");
    expect(tableNames(first.driver.database)).toContain("fixture_isolation_probe");
    expect(tableNames(second.driver.database)).not.toContain("fixture_isolation_probe");

    const explicitMigrationContext = openLegacyMarker89Partial("conversation-turn-projection");
    expect(run(explicitMigrationContext)).toMatchObject({ route: "compatibility" });
  });
});

function insertRuntimeIdentityBinding(database: DatabaseSync, input: {
  id: string;
  paneId: string;
  terminalId: string;
  session: string | null;
  attachment: "attached" | "orphaned" | "degraded" | "unattached";
  state?: "active" | "archived";
  lifecycle?: "active" | "archived";
}): void {
  database.prepare(`INSERT INTO bindings(
    id,workspace_id,chat_id,pane_id,traex_session_id,agent_session_source,agent_session_agent,agent_session_kind,agent_session_value,
    title,runtime,state,last_agent_state,lifecycle,attachment,generation,session_epoch,provisioning_checkpoint,degradation_count,has_completed_turn,last_activity_at,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?, 'traex', ?, 'idle', ?, ?, 1, 1, 'activated', 0, 0, 't', 't', 't')`).run(
    input.id, "workspace", "chat", input.paneId, input.terminalId,
    input.session === null ? null : "herdr:traex", input.session === null ? null : "traex", input.session === null ? null : "id", input.session,
    input.id, input.state ?? "active", input.lifecycle ?? "active", input.attachment
  );
}

function openContext(): SqliteContext {
  const context = new SqliteContext(":memory:");
  contexts.push(context);
  return context;
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "herdr-sqlite-migrations-"));
  directories.push(directory);
  return join(directory, "bridge.db");
}

function run(context: SqliteContext): SchemaMigrationResult {
  return new SqliteMigrations(context).run() as SchemaMigrationResult;
}

function installBootstrapLease(context: SqliteContext, fencingToken: number): void {
  context.database.prepare(`INSERT OR REPLACE INTO instance_lease(singleton_id,owner_id,fencing_token,expires_at,expires_at_ms,updated_at)
    VALUES(1,'bootstrap-owner',?,'2999-01-01T00:00:00.000Z',?,'2026-10-08T00:00:00.000Z')`).run(fencingToken, Date.UTC(2999, 0, 1));
}

function downgradeLeaseSchemaToEpoch5(context: SqliteContext, expiresAt: string): void {
  context.database.exec(`
    CREATE TABLE instance_lease_epoch5(
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),owner_id TEXT NOT NULL,fencing_token INTEGER NOT NULL,
      expires_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    DROP TABLE instance_lease;
    ALTER TABLE instance_lease_epoch5 RENAME TO instance_lease;
    DELETE FROM schema_migrations WHERE version=115;
    UPDATE schema_metadata SET epoch='2026-10-08.5',fingerprint='epoch-5-fixture' WHERE singleton_id=1;
  `);
  context.database.prepare(`INSERT INTO instance_lease(singleton_id,owner_id,fencing_token,expires_at,updated_at)
    VALUES(1,'expired-owner',7,?,'2000-01-01T00:00:00.000Z')`).run(expiresAt);
}

function openLegacyMarker89Partial(presentObligation: "input-card-view" | "conversation-turn-projection" | "neither"): SqliteContext {
  const context = openContext();
  // SQLite permits foreign-key targets to be created later, so marker storage is
  // the only prerequisite needed to model either independently applied legacy obligation.
  context.database.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
    INSERT INTO schema_migrations(version) VALUES (89);
    PRAGMA foreign_keys = OFF;
  `);
  if (presentObligation === "input-card-view") {
    createInputCardViewSchema(context);
    context.database.prepare(`INSERT INTO input_card_views(submission_id,state,root_message_id,card_json,working_card_json,revision,created_at,updated_at)
      VALUES ('sentinel-input','pending','root','{}','{}',1,'t','t')`).run();
  } else {
    if (presentObligation === "conversation-turn-projection") {
      createConversationTurnProjectionSchema(context);
      context.database.prepare(`INSERT INTO conversation_turn_projections(agent_kind,session_id,turn_id,started_at,source_lane_id,created_at,updated_at)
        VALUES ('traex','session','turn','started','lane','t','t')`).run();
      context.database.prepare(`INSERT INTO conversation_turn_projection_events(agent_kind,session_id,turn_id,started_at,event_id,sequence,created_at)
        VALUES ('traex','session','turn','started','event-sentinel',1,'t')`).run();
    }
  }
  context.database.exec("PRAGMA foreign_keys = ON");
  return context;
}

function missingMarker89Objects(presentObligation: "input-card-view" | "conversation-turn-projection" | "neither"): string[] {
  const inputCardObjects = ["input_card_views", "input_card_views_state"];
  const projectionObjects = ["conversation_turn_projection_events", "conversation_turn_projection_events_order", "conversation_turn_projections"];
  if (presentObligation === "input-card-view") return projectionObjects;
  if (presentObligation === "conversation-turn-projection") return inputCardObjects;
  return [...projectionObjects, ...inputCardObjects].sort();
}

function marker89Sentinels(database: DatabaseSync): Record<string, unknown[]> {
  const hasInput = tableNames(database).includes("input_card_views");
  const hasProjection = tableNames(database).includes("conversation_turn_projections");
  return {
    inputCards: hasInput
      ? database.prepare("SELECT submission_id, root_message_id, card_json, working_card_json FROM input_card_views ORDER BY submission_id").all()
      : [],
    projections: hasProjection
      ? database.prepare("SELECT agent_kind, session_id, turn_id, started_at, source_lane_id FROM conversation_turn_projections ORDER BY agent_kind, session_id, turn_id, started_at").all()
      : [],
    projectionEvents: tableNames(database).includes("conversation_turn_projection_events")
      ? database.prepare("SELECT agent_kind, session_id, turn_id, started_at, event_id, sequence, created_at FROM conversation_turn_projection_events ORDER BY event_id").all()
      : []
  };
}

function createInputCardViewSchema(context: SqliteContext): void {
  context.database.exec(`
    CREATE TABLE input_card_views(
      submission_id TEXT PRIMARY KEY REFERENCES submission_intents(submission_id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK(state IN ('pending','working')), root_message_id TEXT NOT NULL,
      message_id TEXT, card_id TEXT, card_json TEXT NOT NULL CHECK(json_valid(card_json)),
      working_card_json TEXT NOT NULL CHECK(json_valid(working_card_json)), observed_event_id TEXT UNIQUE,
      revision INTEGER NOT NULL CHECK(revision >= 1), delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK(delivered_revision >= 0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX input_card_views_state ON input_card_views(state, updated_at);
  `);
}

function createConversationTurnProjectionSchema(context: SqliteContext): void {
  context.database.exec(`
    CREATE TABLE conversation_turn_projections(
      agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')), session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, started_at TEXT NOT NULL, source_lane_id TEXT NOT NULL,
      projection_id TEXT UNIQUE, origin TEXT CHECK(origin IN ('herdr','feishu')),
      binding_id TEXT REFERENCES bindings(id) ON DELETE CASCADE,
      binding_generation INTEGER CHECK(binding_generation >= 1), pane_id TEXT,
      state_json TEXT CHECK(state_json IS NULL OR json_valid(state_json)), answer_card_json TEXT CHECK(answer_card_json IS NULL OR json_valid(answer_card_json)),
      answer_message_id TEXT, answer_card_id TEXT, delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK(delivered_revision >= 0),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_kind, session_id, turn_id, started_at)
    );
    CREATE TABLE conversation_turn_projection_events(
      agent_kind TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, started_at TEXT NOT NULL,
      event_id TEXT NOT NULL UNIQUE REFERENCES core_event_inbox(event_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK(sequence > 0), created_at TEXT NOT NULL,
      PRIMARY KEY(agent_kind, session_id, turn_id, started_at, event_id),
      UNIQUE(agent_kind, session_id, turn_id, started_at, sequence),
      FOREIGN KEY(agent_kind, session_id, turn_id, started_at)
        REFERENCES conversation_turn_projections(agent_kind, session_id, turn_id, started_at) ON DELETE CASCADE
    );
    CREATE INDEX conversation_turn_projection_events_order
      ON conversation_turn_projection_events(agent_kind, session_id, turn_id, started_at, sequence);
  `);
}

function expectCanonicalOrdering(catalog: CanonicalSchemaCatalog): void {
  expect(catalog.tables).toEqual([...catalog.tables].sort());
  expect(catalog.indexes).toEqual([...catalog.indexes].sort());
  expect(catalog.triggers).toEqual([...catalog.triggers].sort());
  expect(catalog.views).toEqual([...catalog.views].sort());
  expect(catalog.markers).toEqual([...catalog.markers].sort((left, right) => left - right));
}

function tableNames(database: DatabaseSync): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
}

function schemaObjects(database: DatabaseSync): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

function prepareSemanticShadow(database: DatabaseSync): void {
  database.prepare("UPDATE semantic_delivery_rollout SET phase='shadow',updated_at='shadow' WHERE singleton_id=1").run();
  database.prepare(`INSERT INTO semantic_delivery_shadow_evidence(
    segment_id,page_index,view_version,shadow_epoch,snapshot_schema_version,planner_policy_version,renderer_policy_version,gateway_profile_version,
    legacy_fingerprint,semantic_fingerprint,matched,details_json,observed_at
  ) SELECT 'shadow',0,1,shadow_epoch,1,1,1,1,'same','same',1,'{}','shadow'
    FROM semantic_delivery_rollout WHERE singleton_id=1`).run();
}

function installSemanticRolloutBlocker(database: DatabaseSync, blocker: "shadow_mismatch"|"ambiguous_actionable_rows"|"unsupported_versions"|"unresolved_settlement_gaps"|"retention_blockers"): void {
  if (blocker==="shadow_mismatch") { database.prepare("UPDATE semantic_delivery_shadow_evidence SET matched=0,semantic_fingerprint='different'").run(); return; }
  if (blocker==="unresolved_settlement_gaps") {
    database.prepare(`INSERT INTO projection_gaps(stage,owner_kind,owner_id,source_item_id,failure_code,state,first_failed_at,last_failed_at)
      VALUES('answer_delivery','turn_card','segment','reply','semantic_subject_settlement_mismatch','open','t','t')`).run(); return;
  }
  const semantic=blocker!=="ambiguous_actionable_rows";
  const state=blocker==="unsupported_versions"?"delivered":"pending";
  database.prepare(`INSERT INTO outbound_replies(
    id,idempotency_key,root_message_id,kind,payload,state,next_attempt_at,created_at,updated_at,
    scope_kind,scope_key,delivery_order,lane_key,conflict_key,projection_key,
    delivery_input_kind,subject_kind,subject_json,subject_revision,presentation_snapshot_json,presentation_snapshot_hash,
    planner_policy_version,renderer_policy_version,gateway_profile_version,preparation_state
  ) VALUES(?,?,?,?,?,?,?,?,?,'global',json_array('global'),1,'turn-card','turn-card','turn-card:block:page:0',?,?,?,?,?,?,?,?,?,?)`).run(
    `block-${blocker}`,`block-${blocker}`,'root','card_reply','{}',state,'t','t','t',
    semantic?'semantic-snapshot':null,semantic?'conversation-page':null,semantic?'{}':null,semantic?1:null,
    semantic?JSON.stringify({ schemaVersion:blocker==="unsupported_versions"?2:1,kind:"conversation-turn-card" }):null,
    semantic?'a'.repeat(64):null,semantic?1:null,semantic?1:null,semantic?1:null,semantic?'reserved':null
  );
}

function insertConversationSegment(database: DatabaseSync, id: string): void {
  database.prepare(`INSERT INTO conversation_segments(
    id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at
  ) VALUES(?,?,'primary',?,1,'traex','request','working',1,?,'t','t')`).run(id,`producer-${id}`,`owner-${id}`,`root-${id}`);
}

function insertConversationPage(database: DatabaseSync, segmentId: string): void {
  database.prepare(`INSERT INTO conversation_segment_pages(
    id,segment_id,page_index,element_id,state,sequence,created_at,updated_at
  ) VALUES(?,?,0,?,'creating',0,'t','t')`).run(`${segmentId}:page:0`,segmentId,`turn-card:${segmentId}:page:0`);
}

function insertCompactedTerminalSemantic(database: DatabaseSync, id: string): void {
  database.prepare(`INSERT INTO outbound_replies(
    id,idempotency_key,root_message_id,kind,payload,payload_compacted_at,intent_kind,intent_json,renderer_revision,state,next_attempt_at,created_at,updated_at,
    scope_kind,scope_key,delivery_order,lane_key,conflict_key,delivery_input_kind,subject_kind,subject_json,subject_revision,
    presentation_snapshot_json,presentation_snapshot_hash,planner_policy_version,renderer_policy_version,gateway_profile_version,
    preparation_state,gateway_plan_json,gateway_plan_hash
  ) VALUES(?,?,?,'card_reply','','compacted','card',json_object('schemaVersion',2,'kind','card'),1,'delivered','t','t','t','global',json_array('global'),1,?,?,'semantic-snapshot',
    'conversation-page',json_object('kind','conversation-page','segmentId','segment','pageIndex',0,'revision',1),1,NULL,?,1,1,1,
    'prepared','{}',?)`).run(id,id,"root",id,id,"a".repeat(64),"b".repeat(64));
  database.prepare(`INSERT INTO audit_skeletons(
    source_kind,source_id,payload_hash,payload_bytes,lifecycle_state,owner_kind,owner_id,created_at,terminal_at,
    barrier_version,state,verified_at,compacted_at,relationship_hash
  ) VALUES('delivery',?,?,0,'delivered','delivery',?,'t','t',1,'compacted','t','compacted',?)`)
    .run(id,"c".repeat(64),id,"d".repeat(64));
}
