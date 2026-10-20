import type { SqliteContext } from "../context.js";
import { runForeignKeySafeRebuild } from "./foreign-key-safe-rebuild.js";

export class PromptTurnMigrations {
  constructor(private readonly context: SqliteContext) {}

  ensureNaturalLanguageCommandFrozenTargets(): void {
    if (this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 63").get()) return;
    this.context.transaction("sqlite.prompt-turn-migrations.write", () => {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(natural_language_command_confirmations)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("frozen_target_json")) this.context.database.exec("ALTER TABLE natural_language_command_confirmations ADD COLUMN frozen_target_json TEXT");
      const timestamp = new Date().toISOString();
      this.context.database.prepare("UPDATE natural_language_command_confirmations SET state = 'cancelled', result_detail = 'legacy_incomplete_frozen_identity', resolved_at = ?, updated_at = ? WHERE state = 'pending' AND frozen_target_json IS NULL").run(timestamp, timestamp);
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (63)").run();
    });
  }

  ensurePromptCancelledState(): void {
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'prompt_jobs'").get() as { sql: string } | undefined;
    if (schema?.sql.includes("'cancelled'")) return;
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    const steeringOrigin = columns.has("steering_origin") ? "steering_origin" : "NULL";
    const sourcePromptId = columns.has("source_prompt_id") ? "source_prompt_id" : "NULL";
    const wasDetached = columns.has("was_detached") ? "was_detached" : "0";
    const dispatchedAt = columns.has("dispatched_at") ? "dispatched_at" : "NULL";
    const nativeSubmissionId = columns.has("native_submission_id") ? "native_submission_id" : "NULL";
    const transcriptTurnId = columns.has("transcript_turn_id") ? "transcript_turn_id" : "NULL";
    const transcriptTurnStartedAt = columns.has("transcript_turn_started_at") ? "transcript_turn_started_at" : "NULL";
    const executionOrigin = columns.has("execution_origin") ? "execution_origin" : "'bridge'";
    const ingressSource = columns.has("ingress_source") ? "ingress_source" : "NULL";
    const sourceMessageKey = columns.has("source_message_key") ? "source_message_key" : "NULL";
    const observationState = columns.has("observation_state") ? "observation_state" : "CASE WHEN state = 'running' THEN 'attached' WHEN state = 'queued' THEN 'not_started' ELSE 'completed' END";
    runForeignKeySafeRebuild(this.context, "Prompt-state migration", () => this.context.database.exec(`
      CREATE TABLE prompt_jobs_next(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE,
        ingress_source TEXT CHECK(ingress_source IN ('feishu','herdr','internal')), source_message_key TEXT,
        actor_open_id TEXT NOT NULL, body TEXT NOT NULL, execution_origin TEXT NOT NULL DEFAULT 'bridge' CHECK(execution_origin IN ('bridge','herdr')), dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering')), parent_prompt_id TEXT,
        steering_origin TEXT CHECK(steering_origin IN ('explicit','automatic','converted')), source_prompt_id TEXT REFERENCES prompt_jobs_next(id), was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1)),
        dispatched_at TEXT, native_submission_id TEXT UNIQUE, transcript_turn_id TEXT, transcript_turn_started_at TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed','cancelled')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO prompt_jobs_next(id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body, execution_origin, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, dispatched_at, native_submission_id, transcript_turn_id, transcript_turn_started_at, state, observation_state, attempt_count, error, created_at, updated_at) SELECT id, binding_id, lark_message_id, ${ingressSource}, ${sourceMessageKey}, actor_open_id, body, ${executionOrigin}, dispatch_kind, parent_prompt_id, ${steeringOrigin}, ${sourcePromptId}, ${wasDetached}, ${dispatchedAt}, ${nativeSubmissionId}, ${transcriptTurnId}, ${transcriptTurnStartedAt}, state, ${observationState}, attempt_count, error, created_at, updated_at FROM prompt_jobs;
      DROP TABLE prompt_jobs;
      ALTER TABLE prompt_jobs_next RENAME TO prompt_jobs;
      CREATE INDEX prompt_jobs_queue ON prompt_jobs(binding_id, state, created_at);
      CREATE INDEX prompt_jobs_dispatch ON prompt_jobs(binding_id, dispatch_kind, parent_prompt_id, state, created_at);
      CREATE UNIQUE INDEX prompt_jobs_source_prompt_once ON prompt_jobs(source_prompt_id) WHERE source_prompt_id IS NOT NULL;
    `));
  }

  ensurePromptExecutionLifecycle(): void {
    if (this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 72").get()) return;
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'prompt_jobs'").get() as { sql: string } | undefined;
    if (!schema) throw new Error("Prompt lifecycle migration requires prompt_jobs");
    if (!schema.sql.includes("'submitted'") || !schema.sql.includes("'recovering'") || !schema.sql.includes("'uncertain'")) {
      runForeignKeySafeRebuild(this.context, "Prompt execution lifecycle migration", () => this.context.database.exec(`
        CREATE TABLE prompt_jobs_next(
          id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE,
          ingress_source TEXT CHECK(ingress_source IN ('feishu','herdr','internal')), source_message_key TEXT,
          actor_open_id TEXT NOT NULL, body TEXT NOT NULL, parent_prompt_id TEXT REFERENCES prompt_jobs_next(id), execution_origin TEXT NOT NULL DEFAULT 'bridge' CHECK(execution_origin IN ('bridge','herdr')), priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','priority')), was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1)),
          dispatched_at TEXT, native_submission_id TEXT UNIQUE, transcript_turn_id TEXT, transcript_turn_started_at TEXT, model_name TEXT, model_revision INTEGER CHECK(model_revision IS NULL OR model_revision >= 0),
          state TEXT NOT NULL CHECK(state IN ('queued','submitted','running','recovering','uncertain','delivered','failed','cancelled')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
          attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO prompt_jobs_next(
          id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body, parent_prompt_id,
          execution_origin, priority, was_detached, dispatched_at, native_submission_id, transcript_turn_id,
          transcript_turn_started_at, model_name, model_revision, state, observation_state, attempt_count, error,
          created_at, updated_at
        )
        SELECT id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body, parent_prompt_id,
          execution_origin, priority, was_detached, dispatched_at, native_submission_id, transcript_turn_id,
          transcript_turn_started_at, model_name, model_revision,
          CASE
            WHEN state != 'running' THEN state
            WHEN transcript_turn_id IS NOT NULL AND transcript_turn_started_at IS NOT NULL THEN 'running'
            WHEN dispatched_at IS NOT NULL OR native_submission_id IS NOT NULL
              THEN CASE WHEN observation_state = 'detached' THEN 'recovering' ELSE 'submitted' END
            ELSE 'queued'
          END,
          CASE
            WHEN state = 'running' AND transcript_turn_id IS NULL AND transcript_turn_started_at IS NULL
              AND dispatched_at IS NULL AND native_submission_id IS NULL THEN 'not_started'
            ELSE observation_state
          END,
          attempt_count, error, created_at, updated_at
        FROM prompt_jobs;
        DROP TABLE prompt_jobs;
        ALTER TABLE prompt_jobs_next RENAME TO prompt_jobs;
        CREATE INDEX prompt_jobs_queue ON prompt_jobs(binding_id, state, created_at);
        CREATE INDEX prompt_jobs_priority_queue ON prompt_jobs(binding_id, state, priority, created_at);
        CREATE UNIQUE INDEX prompt_jobs_native_submission ON prompt_jobs(native_submission_id) WHERE native_submission_id IS NOT NULL;
        CREATE INDEX prompt_jobs_transcript_turn ON prompt_jobs(transcript_turn_id) WHERE transcript_turn_id IS NOT NULL;
        INSERT INTO schema_migrations(version) VALUES (72);
      `));
      return;
    }
    this.context.transaction("sqlite.prompt-turn-migrations.write", () => {
      this.context.database.exec(`
        UPDATE prompt_jobs SET
          state = CASE
            WHEN transcript_turn_id IS NOT NULL AND transcript_turn_started_at IS NOT NULL THEN 'running'
            WHEN dispatched_at IS NOT NULL OR native_submission_id IS NOT NULL
              THEN CASE WHEN observation_state = 'detached' THEN 'recovering' ELSE 'submitted' END
            ELSE 'queued'
          END,
          observation_state = CASE
            WHEN transcript_turn_id IS NULL AND transcript_turn_started_at IS NULL
              AND dispatched_at IS NULL AND native_submission_id IS NULL THEN 'not_started'
            ELSE observation_state
          END
        WHERE state = 'running';
        INSERT INTO schema_migrations(version) VALUES (72);
      `);
    });
  }

  ensurePromptObservationColumn(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "observation_state")) {
      this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed'))");
    }
    this.context.database.exec("UPDATE prompt_jobs SET observation_state = CASE WHEN state = 'running' THEN 'attached' WHEN state = 'queued' THEN 'not_started' ELSE 'completed' END WHERE observation_state = 'not_started' AND state != 'queued'");
  }

  ensurePromptProvenanceColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("was_detached")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1))");
  }

  ensurePromptTranscriptProvenanceColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("dispatched_at")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN dispatched_at TEXT");
    if (!names.has("transcript_turn_id")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN transcript_turn_id TEXT");
    if (!names.has("transcript_turn_started_at")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN transcript_turn_started_at TEXT");
  }

  ensurePromptNativeSubmissionColumn(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("native_submission_id")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN native_submission_id TEXT");
    this.context.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS prompt_jobs_native_submission ON prompt_jobs(native_submission_id) WHERE native_submission_id IS NOT NULL;
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (52);
    `);
  }

  ensurePromptTranscriptTurnOwnership(): void {
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'prompt_transcript_turns'").get() as { sql: string } | undefined;
    if (!schema) {
      this.context.database.exec(`
        CREATE TABLE prompt_transcript_turns(
          prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id) ON DELETE CASCADE, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
          pane_id TEXT, native_session_id TEXT, turn_id TEXT NOT NULL, started_at TEXT NOT NULL, chain_id TEXT NOT NULL, parent_turn_id TEXT,
          origin TEXT NOT NULL CHECK(origin IN ('prompt','runtime_continuation')), ordinal INTEGER NOT NULL CHECK(ordinal >= 0), created_at TEXT NOT NULL,
          PRIMARY KEY(prompt_id, turn_id), UNIQUE(binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at), UNIQUE(prompt_id, ordinal)
        );
        CREATE INDEX IF NOT EXISTS prompt_transcript_turns_chain ON prompt_transcript_turns(prompt_id, ordinal);
        INSERT OR IGNORE INTO prompt_transcript_turns(prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at, chain_id, parent_turn_id, origin, ordinal, created_at)
        SELECT p.id, p.binding_id, b.generation,
          CASE
            WHEN p.transcript_turn_id IS NOT NULL AND p.transcript_turn_started_at IS NOT NULL
              AND b.generation = (SELECT c.binding_generation FROM run_cards c WHERE c.prompt_id = p.id)
              AND b.pane_id IS NOT NULL AND b.agent_session_value IS NOT NULL
            THEN b.pane_id
            ELSE NULL
          END,
          CASE
            WHEN p.transcript_turn_id IS NOT NULL AND p.transcript_turn_started_at IS NOT NULL
              AND b.generation = (SELECT c.binding_generation FROM run_cards c WHERE c.prompt_id = p.id)
              AND b.pane_id IS NOT NULL AND b.agent_session_value IS NOT NULL
            THEN b.agent_session_value
            ELSE NULL
          END,
          p.transcript_turn_id, p.transcript_turn_started_at, p.transcript_turn_id, NULL, 'prompt', 0, p.updated_at
        FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
        WHERE p.transcript_turn_id IS NOT NULL AND p.transcript_turn_started_at IS NOT NULL;
      `);
    } else if (schema.sql.includes("UNIQUE(turn_id)") || !schema.sql.includes("pane_id TEXT") || !schema.sql.includes("native_session_id TEXT")
      || !schema.sql.includes("UNIQUE(binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at)")) {
      runForeignKeySafeRebuild(this.context, "Prompt transcript turn exact-identity migration", () => this.context.database.exec(`
        ALTER TABLE prompt_transcript_turns RENAME TO prompt_transcript_turns_legacy;
        CREATE TABLE prompt_transcript_turns(
          prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id) ON DELETE CASCADE, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
          pane_id TEXT, native_session_id TEXT, turn_id TEXT NOT NULL, started_at TEXT NOT NULL, chain_id TEXT NOT NULL, parent_turn_id TEXT,
          origin TEXT NOT NULL CHECK(origin IN ('prompt','runtime_continuation')), ordinal INTEGER NOT NULL CHECK(ordinal >= 0), created_at TEXT NOT NULL,
          PRIMARY KEY(prompt_id, turn_id), UNIQUE(binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at), UNIQUE(prompt_id, ordinal)
        );
        INSERT INTO prompt_transcript_turns(prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at, chain_id, parent_turn_id, origin, ordinal, created_at)
        SELECT legacy.prompt_id, legacy.binding_id, legacy.binding_generation,
          COALESCE(
            CASE
              WHEN recovery.turn_id = legacy.turn_id AND recovery.started_at = legacy.started_at THEN recovery.pane_id
              ELSE NULL
            END,
            CASE
              WHEN prompt.transcript_turn_id = legacy.turn_id AND prompt.transcript_turn_started_at = legacy.started_at
                AND binding.generation = legacy.binding_generation
                AND binding.pane_id IS NOT NULL AND binding.agent_session_value IS NOT NULL
              THEN binding.pane_id
              ELSE NULL
            END
          ),
          COALESCE(
            CASE
              WHEN recovery.turn_id = legacy.turn_id AND recovery.started_at = legacy.started_at THEN recovery.session_value
              ELSE NULL
            END,
            CASE
              WHEN prompt.transcript_turn_id = legacy.turn_id AND prompt.transcript_turn_started_at = legacy.started_at
                AND binding.generation = legacy.binding_generation
                AND binding.pane_id IS NOT NULL AND binding.agent_session_value IS NOT NULL
              THEN binding.agent_session_value
              ELSE NULL
            END
          ),
          legacy.turn_id, legacy.started_at, legacy.chain_id, legacy.parent_turn_id, legacy.origin, legacy.ordinal, legacy.created_at
        FROM prompt_transcript_turns_legacy legacy
        LEFT JOIN prompt_jobs prompt ON prompt.id = legacy.prompt_id
        LEFT JOIN bindings binding ON binding.id = legacy.binding_id
        LEFT JOIN external_turn_recovery_attempts recovery ON recovery.prompt_id = legacy.prompt_id;
        DROP TABLE prompt_transcript_turns_legacy;
        CREATE INDEX prompt_transcript_turns_chain ON prompt_transcript_turns(prompt_id, ordinal);
      `));
    }
    this.context.database.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (51);");
    this.context.database.exec("INSERT OR IGNORE INTO schema_migrations(version) VALUES (64);");
  }

  ensurePromptIdentityCorrections(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS prompt_identity_corrections(
        alias_prompt_id TEXT PRIMARY KEY, canonical_prompt_id TEXT NOT NULL,
        binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
        pane_id TEXT NOT NULL, native_session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        legacy_started_at TEXT NOT NULL, canonical_started_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('canonical_start_correction')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prompt_identity_corrections_canonical ON prompt_identity_corrections(canonical_prompt_id, created_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (65);
    `);
  }

  ensureTurnPriorityColumns(): void {
    const promptNames = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!promptNames.has("priority")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','priority'))");
    const turnNames = new Set((this.context.database.prepare("PRAGMA table_info(instance_turns)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!turnNames.has("priority")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','priority'))");
    this.context.database.exec(`
      CREATE INDEX IF NOT EXISTS prompt_jobs_priority_queue ON prompt_jobs(binding_id, state, priority, created_at);
      CREATE INDEX IF NOT EXISTS instance_turns_priority_queue ON instance_turns(instance_id, instance_generation, state, priority, created_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (26);
    `);
  }

  ensureModelPreferenceSchema(): void {
    const promptColumns = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!promptColumns.has("model_name")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN model_name TEXT");
    if (!promptColumns.has("model_revision")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN model_revision INTEGER CHECK(model_revision IS NULL OR model_revision >= 0)");
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS binding_model_preferences(
        binding_id TEXT PRIMARY KEY REFERENCES bindings(id), binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
        desired_model TEXT NOT NULL CHECK(length(desired_model) > 0), desired_revision INTEGER NOT NULL CHECK(desired_revision >= 1),
        effective_model TEXT, effective_revision INTEGER CHECK(effective_revision IS NULL OR effective_revision >= 1),
        state TEXT NOT NULL CHECK(state IN ('pending','applying','effective','uncertain')),
        dispatch_prompt_id TEXT UNIQUE REFERENCES prompt_jobs(id), prepared_operation_id TEXT, updated_at TEXT NOT NULL,
        CHECK((state = 'pending' AND dispatch_prompt_id IS NULL) OR state != 'pending')
      );
      CREATE INDEX IF NOT EXISTS binding_model_preferences_state ON binding_model_preferences(state, updated_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (25);
    `);
  }

  ensurePromptExecutionOriginColumn(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("execution_origin")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN execution_origin TEXT NOT NULL DEFAULT 'bridge' CHECK(execution_origin IN ('bridge','herdr'))");
    this.context.database.exec("CREATE INDEX IF NOT EXISTS prompt_jobs_transcript_turn ON prompt_jobs(transcript_turn_id) WHERE transcript_turn_id IS NOT NULL");
  }

  ensurePromptSourceIdentity(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("ingress_source")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN ingress_source TEXT CHECK(ingress_source IN ('feishu','herdr','internal'))");
    if (!names.has("source_message_key")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN source_message_key TEXT");
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 62").get();
    if (!migrated) {
      this.context.transaction("sqlite.prompt-turn-migrations.write", () => {
        this.context.database.exec(`
          UPDATE prompt_jobs AS p
          SET ingress_source = 'herdr',
              source_message_key = (
                SELECT 'herdr-turn:v1:' || json_array(
                  t.binding_id, t.binding_generation, t.pane_id, t.native_session_id, t.turn_id, t.started_at
                )
                FROM prompt_transcript_turns t
                WHERE t.prompt_id = p.id AND t.binding_id = p.binding_id
                  AND t.turn_id = p.transcript_turn_id AND t.started_at = p.transcript_turn_started_at
                  AND t.pane_id IS NOT NULL AND t.native_session_id IS NOT NULL
              )
          WHERE p.execution_origin = 'herdr'
            AND p.transcript_turn_id IS NOT NULL AND p.transcript_turn_started_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM prompt_transcript_turns t
              WHERE t.prompt_id = p.id AND t.binding_id = p.binding_id
                AND t.turn_id = p.transcript_turn_id AND t.started_at = p.transcript_turn_started_at
                AND t.pane_id IS NOT NULL AND t.native_session_id IS NOT NULL
            );
          UPDATE prompt_jobs SET ingress_source = 'herdr', source_message_key = 'legacy:v1:' || id
          WHERE execution_origin = 'herdr' AND (ingress_source IS NULL OR source_message_key IS NULL);
          UPDATE prompt_jobs SET ingress_source = 'feishu', source_message_key = lark_message_id
          WHERE execution_origin = 'bridge' AND lark_message_id IS NOT NULL AND (ingress_source IS NULL OR source_message_key IS NULL);
          UPDATE prompt_jobs SET ingress_source = 'internal', source_message_key = 'legacy:v1:' || id
          WHERE ingress_source IS NULL OR source_message_key IS NULL;
          CREATE TEMP TABLE prompt_source_identity_duplicates AS
          SELECT ingress_source, source_message_key FROM prompt_jobs
          GROUP BY ingress_source, source_message_key HAVING COUNT(*) > 1;
          UPDATE prompt_jobs SET source_message_key = 'legacy:v1:' || id
          WHERE EXISTS (
            SELECT 1 FROM prompt_source_identity_duplicates duplicate
            WHERE duplicate.ingress_source = prompt_jobs.ingress_source
              AND duplicate.source_message_key = prompt_jobs.source_message_key
          );
          DROP TABLE prompt_source_identity_duplicates;
          INSERT INTO schema_migrations(version) VALUES (62);
        `);
      });
    }
    this.context.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS prompt_jobs_source_identity ON prompt_jobs(ingress_source, source_message_key);
      CREATE TRIGGER IF NOT EXISTS prompt_jobs_source_identity_insert AFTER INSERT ON prompt_jobs
      WHEN NEW.ingress_source IS NULL OR NEW.source_message_key IS NULL BEGIN
        UPDATE prompt_jobs SET
          ingress_source = COALESCE(NEW.ingress_source, CASE WHEN NEW.execution_origin = 'herdr' THEN 'herdr' ELSE 'internal' END),
          source_message_key = COALESCE(NEW.source_message_key, 'legacy:new:v1:' || NEW.id)
        WHERE id = NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS prompt_jobs_source_identity_update BEFORE UPDATE OF ingress_source, source_message_key ON prompt_jobs
      WHEN NEW.ingress_source IS NULL OR NEW.source_message_key IS NULL BEGIN
        SELECT RAISE(ABORT, 'prompt_source_identity_required');
      END;
    `);
  }

  ensurePrimaryContinuationLineage(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("parent_prompt_id")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN parent_prompt_id TEXT REFERENCES prompt_jobs(id)");
    this.context.database.exec("CREATE INDEX IF NOT EXISTS prompt_jobs_parent_prompt ON prompt_jobs(parent_prompt_id) WHERE parent_prompt_id IS NOT NULL");
  }

  ensurePaneCloseOperationState(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(pane_close_requests)").all() as Array<{ name: string }>;
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pane_close_requests'").get() as { sql: string } | undefined;
    if (columns.some((column) => column.name === "detail") && schema?.sql.includes("'uncertain'")) return;
    runForeignKeySafeRebuild(this.context, "Pane-close state migration", () => this.context.database.exec(`
      ALTER TABLE pane_close_requests RENAME TO pane_close_requests_legacy;
      CREATE TABLE pane_close_requests(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), pane_id TEXT NOT NULL, actor_open_id TEXT NOT NULL, code_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','consumed','executing','succeeded','rejected','uncertain','expired','cancelled')), detail TEXT, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO pane_close_requests(id, binding_id, pane_id, actor_open_id, code_hash, state, expires_at, consumed_at, created_at, updated_at)
      SELECT id, binding_id, pane_id, actor_open_id, code_hash, state, expires_at, consumed_at, created_at, updated_at FROM pane_close_requests_legacy;
      DROP TABLE pane_close_requests_legacy;
      CREATE INDEX pane_close_requests_binding_state ON pane_close_requests(binding_id, state, created_at);
    `));
  }

  ensurePaneControlOperationState(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS pane_control_operations(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT NOT NULL REFERENCES bindings(id), pane_id TEXT NOT NULL, terminal_id TEXT, binding_generation INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('stop','steer','model')), payload TEXT, parent_prompt_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('accepted','running','applied','confirmed','rejected','failed','uncertain')), attempt_count INTEGER NOT NULL DEFAULT 0, detail TEXT,
        actor_open_id TEXT NOT NULL, source_message_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pane_control_operations_claim ON pane_control_operations(state, binding_id, kind, created_at);
      CREATE INDEX IF NOT EXISTS pane_control_operations_recovery ON pane_control_operations(state, updated_at);
    `);
  }

  ensureTurnControlOperations(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS turn_control_operations(
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('steer','interrupt')),
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('binding','instance')), owner_id TEXT NOT NULL, project_id TEXT NOT NULL, pane_id TEXT NOT NULL, generation INTEGER NOT NULL,
        agent_session_source TEXT NOT NULL, agent_session_agent TEXT NOT NULL, agent_session_kind TEXT NOT NULL CHECK(agent_session_kind IN ('id','path')), agent_session_value TEXT NOT NULL,
        logical_turn_id TEXT NOT NULL, runtime_turn_id TEXT NOT NULL, actor_json TEXT NOT NULL,
        payload TEXT CHECK((kind = 'steer' AND payload IS NOT NULL AND length(payload) > 0) OR (kind = 'interrupt' AND payload IS NULL)),
        source_message_id TEXT, source_card_id TEXT, state TEXT NOT NULL CHECK(state IN ('accepted','dispatching','delivered','rejected','uncertain')), result_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turn_control_operations_claim ON turn_control_operations(state, owner_kind, owner_id, created_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (10);
    `);
  }

  ensureSwarmCommandIntents(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS swarm_command_intents(
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, lane_key TEXT NOT NULL, command_json TEXT NOT NULL, context_json TEXT NOT NULL,
        replay_policy TEXT NOT NULL CHECK(replay_policy IN ('safe-before-effect','reconcilable','non-replayable')),
        state TEXT NOT NULL CHECK(state IN ('accepted','executing','succeeded','rejected','failed','uncertain')), attempt_count INTEGER NOT NULL DEFAULT 0,
        outcome_json TEXT, claimed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS swarm_command_intents_claim ON swarm_command_intents(state, lane_key, created_at);
      CREATE INDEX IF NOT EXISTS swarm_command_intents_recovery ON swarm_command_intents(state, updated_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (24);
    `);
  }
}
