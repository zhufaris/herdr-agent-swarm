import type { SqliteContext } from "../context.js";

export class PromptTurnMigrations {
  constructor(private readonly context: SqliteContext) {}

  ensurePromptCancelledState(): void {
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'prompt_jobs'").get() as { sql: string } | undefined;
    if (schema?.sql.includes("'cancelled'")) return;
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    const steeringOrigin = columns.has("steering_origin") ? "steering_origin" : "NULL";
    const sourcePromptId = columns.has("source_prompt_id") ? "source_prompt_id" : "NULL";
    const wasDetached = columns.has("was_detached") ? "was_detached" : "0";
    const dispatchedAt = columns.has("dispatched_at") ? "dispatched_at" : "NULL";
    const transcriptTurnId = columns.has("transcript_turn_id") ? "transcript_turn_id" : "NULL";
    const transcriptTurnStartedAt = columns.has("transcript_turn_started_at") ? "transcript_turn_started_at" : "NULL";
    const executionOrigin = columns.has("execution_origin") ? "execution_origin" : "'bridge'";
    const observationState = columns.has("observation_state") ? "observation_state" : "CASE WHEN state = 'running' THEN 'attached' WHEN state = 'queued' THEN 'not_started' ELSE 'completed' END";
    this.context.database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE prompt_jobs_next(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE NOT NULL,
        actor_open_id TEXT NOT NULL, body TEXT NOT NULL, execution_origin TEXT NOT NULL DEFAULT 'bridge' CHECK(execution_origin IN ('bridge','herdr')), dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering')), parent_prompt_id TEXT,
        steering_origin TEXT CHECK(steering_origin IN ('explicit','automatic','converted')), source_prompt_id TEXT REFERENCES prompt_jobs_next(id), was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1)),
        dispatched_at TEXT, transcript_turn_id TEXT, transcript_turn_started_at TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed','cancelled')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO prompt_jobs_next(id, binding_id, lark_message_id, actor_open_id, body, execution_origin, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, dispatched_at, transcript_turn_id, transcript_turn_started_at, state, observation_state, attempt_count, error, created_at, updated_at) SELECT id, binding_id, lark_message_id, actor_open_id, body, ${executionOrigin}, dispatch_kind, parent_prompt_id, ${steeringOrigin}, ${sourcePromptId}, ${wasDetached}, ${dispatchedAt}, ${transcriptTurnId}, ${transcriptTurnStartedAt}, state, ${observationState}, attempt_count, error, created_at, updated_at FROM prompt_jobs;
      DROP TABLE prompt_jobs;
      ALTER TABLE prompt_jobs_next RENAME TO prompt_jobs;
      CREATE INDEX prompt_jobs_queue ON prompt_jobs(binding_id, state, created_at);
      CREATE INDEX prompt_jobs_dispatch ON prompt_jobs(binding_id, dispatch_kind, parent_prompt_id, state, created_at);
      CREATE UNIQUE INDEX prompt_jobs_source_prompt_once ON prompt_jobs(source_prompt_id) WHERE source_prompt_id IS NOT NULL;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    const violation = this.context.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) throw new Error(`Prompt-state migration produced a foreign-key violation: ${JSON.stringify(violation)}`);
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

  ensurePaneCloseOperationState(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(pane_close_requests)").all() as Array<{ name: string }>;
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pane_close_requests'").get() as { sql: string } | undefined;
    if (columns.some((column) => column.name === "detail") && schema?.sql.includes("'uncertain'")) return;
    this.context.database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      ALTER TABLE pane_close_requests RENAME TO pane_close_requests_legacy;
      CREATE TABLE pane_close_requests(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), pane_id TEXT NOT NULL, actor_open_id TEXT NOT NULL, code_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','consumed','executing','succeeded','rejected','uncertain','expired','cancelled')), detail TEXT, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO pane_close_requests(id, binding_id, pane_id, actor_open_id, code_hash, state, expires_at, consumed_at, created_at, updated_at)
      SELECT id, binding_id, pane_id, actor_open_id, code_hash, state, expires_at, consumed_at, created_at, updated_at FROM pane_close_requests_legacy;
      DROP TABLE pane_close_requests_legacy;
      CREATE INDEX pane_close_requests_binding_state ON pane_close_requests(binding_id, state, created_at);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
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
