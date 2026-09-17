import type { SqliteContext } from "../context.js";
import { runForeignKeySafeRebuild } from "./foreign-key-safe-rebuild.js";

export class BindingSessionMigrations {
  constructor(private readonly context: SqliteContext) {}

  ensureBindingResetColumns(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("retired_topic_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN retired_topic_id TEXT");
    if (!columns.has("retired_root_message_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN retired_root_message_id TEXT");
  }

  ensureInboundMessageIdempotency(): void {
    this.context.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_message_id ON inbound_messages(message_id)");
  }

  ensureInboundMessageScopes(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(inbound_messages)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("scope_key")) this.context.database.exec("ALTER TABLE inbound_messages ADD COLUMN scope_key TEXT");
    this.context.database.exec(`
      UPDATE inbound_messages
      SET scope_key = CASE
        WHEN json_extract(payload_json, '$.topicId') IS NOT NULL THEN 'topic:' || json_extract(payload_json, '$.topicId')
        WHEN json_extract(payload_json, '$.rootMessageId') IS NOT NULL THEN 'root:' || json_extract(payload_json, '$.rootMessageId')
        ELSE 'message:' || message_id
      END
      WHERE scope_key IS NULL OR scope_key = ''
    `);
    const pendingIndexColumns = (this.context.database.prepare("PRAGMA index_info(inbound_messages_pending)").all() as Array<{ name: string }>).map(({ name }) => name);
    if (pendingIndexColumns.join(",") !== "state,scope_key,created_at") {
      this.context.database.exec("DROP INDEX IF EXISTS inbound_messages_pending; CREATE INDEX inbound_messages_pending ON inbound_messages(state, scope_key, created_at)");
    }
  }

  ensureTwoPhaseResetState(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("replaces_binding_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN replaces_binding_id TEXT REFERENCES bindings(id)");
    if (!columns.has("reserved_topic_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN reserved_topic_id TEXT");
    if (!columns.has("reserved_root_message_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN reserved_root_message_id TEXT");
    if (!columns.has("reset_message_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN reset_message_id TEXT");
    this.context.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_reset_message ON bindings(reset_message_id) WHERE reset_message_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_unfinished_reset_predecessor ON bindings(replaces_binding_id) WHERE replaces_binding_id IS NOT NULL AND lifecycle = 'provisioning';
      CREATE TABLE IF NOT EXISTS retired_pane_cleanup_operations(
        id TEXT PRIMARY KEY, old_binding_id TEXT NOT NULL UNIQUE REFERENCES bindings(id), replacement_binding_id TEXT NOT NULL REFERENCES bindings(id),
        pane_id TEXT NOT NULL, expected_workspace_id TEXT NOT NULL, expected_project_id TEXT NOT NULL, expected_cwd TEXT NOT NULL, expected_terminal_id TEXT NOT NULL, actor_open_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','waiting_busy','executing','succeeded','retained')), attempt_count INTEGER NOT NULL DEFAULT 0, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS retired_pane_cleanup_state_created ON retired_pane_cleanup_operations(state, created_at, id);
    `);
  }

  ensureBindingLifecycleColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("lifecycle")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'provisioning' CHECK(lifecycle IN ('provisioning','active','draining','archived','closed','failed'))");
    if (!names.has("attachment")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN attachment TEXT NOT NULL DEFAULT 'unattached' CHECK(attachment IN ('unattached','attached','degraded','orphaned'))");
    if (!names.has("generation")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
    if (!names.has("provisioning_checkpoint")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN provisioning_checkpoint TEXT NOT NULL DEFAULT 'selected' CHECK(provisioning_checkpoint IN ('selected','pane_created','runtime_started','thread_created','activated'))");
    if (!names.has("degradation_count")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN degradation_count INTEGER NOT NULL DEFAULT 0");
    if (!names.has("has_completed_turn")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN has_completed_turn INTEGER NOT NULL DEFAULT 0");
    if (!names.has("last_observed_at")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN last_observed_at TEXT");
    if (!names.has("archived_at")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN archived_at TEXT");
    if (!names.has("last_activity_at")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN last_activity_at TEXT");
    this.context.database.exec(`
      UPDATE bindings SET
        lifecycle = CASE state WHEN 'active' THEN 'active' WHEN 'archived' THEN 'archived' WHEN 'failed' THEN 'failed' WHEN 'orphaned' THEN 'active' ELSE lifecycle END,
        attachment = CASE WHEN state = 'orphaned' THEN 'orphaned' WHEN pane_id IS NOT NULL THEN 'attached' ELSE attachment END,
        provisioning_checkpoint = CASE WHEN state IN ('active','archived','orphaned') THEN 'activated' WHEN pane_id IS NOT NULL THEN 'pane_created' ELSE provisioning_checkpoint END,
        archived_at = CASE WHEN state = 'archived' THEN COALESCE(archived_at, updated_at) ELSE archived_at END,
        last_activity_at = COALESCE(last_activity_at, updated_at);
    `);
  }

  ensureBindingPrimaryToolCapabilities(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(primary_tool_capabilities)").all() as Array<{ name: string }>).map(({ name }) => name));
    const primaryKey = (this.context.database.prepare("PRAGMA table_info(primary_tool_capabilities)").all() as Array<{ name: string; pk: number }>).filter(({ pk }) => pk > 0).sort((left, right) => left.pk - right.pk).map(({ name }) => name);
    if (columns.has("binding_id") && columns.has("binding_generation") && primaryKey.join(",") === "binding_id,binding_generation") return;
    this.context.database.exec(`
      DROP TABLE IF EXISTS primary_tool_capabilities;
      CREATE TABLE primary_tool_capabilities(
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE, binding_generation INTEGER NOT NULL, capability_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(binding_id, binding_generation)
      );
    `);
  }

  ensureBindingCreatorColumn(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "creator_open_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN creator_open_id TEXT");
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS card_interactions(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL, actor_open_id TEXT NOT NULL,
        action_kind TEXT NOT NULL CHECK(action_kind IN ('supplement','convert_queued_prompt','more_actions','session_control','continuation')),
        parent_prompt_id TEXT, target_prompt_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','claimed','consumed','expired')),
        expires_at TEXT NOT NULL, result_code TEXT, created_at TEXT NOT NULL, claimed_at TEXT, consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS card_interactions_expiry ON card_interactions(state, expires_at);
    `);
  }

  ensureSessionOperations(): void {
    const interactionSchema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'card_interactions'").get() as { sql: string } | undefined;
    if (interactionSchema && !interactionSchema.sql.includes("'continuation'")) {
      runForeignKeySafeRebuild(this.context, "Card-interaction migration", () => this.context.database.exec(`
        CREATE TABLE card_interactions_next(
          id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL, actor_open_id TEXT NOT NULL,
          action_kind TEXT NOT NULL CHECK(action_kind IN ('supplement','convert_queued_prompt','more_actions','session_control','continuation')),
          parent_prompt_id TEXT, target_prompt_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','claimed','consumed','expired')),
          expires_at TEXT NOT NULL, result_code TEXT, created_at TEXT NOT NULL, claimed_at TEXT, consumed_at TEXT
        );
        INSERT INTO card_interactions_next SELECT * FROM card_interactions;
        DROP TABLE card_interactions;
        ALTER TABLE card_interactions_next RENAME TO card_interactions;
        CREATE INDEX card_interactions_expiry ON card_interactions(state, expires_at);
      `));
    }
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS session_operations(
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, interaction_id TEXT NOT NULL UNIQUE REFERENCES card_interactions(id),
        binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL, expected_pane_id TEXT, expected_terminal_id TEXT,
        actor_open_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('stop','model','reset','archive','resume','replace','pane_close','rename','reattach')),
        argument TEXT CHECK((kind IN ('rename','reattach') AND argument IS NOT NULL AND length(argument) BETWEEN 1 AND 500) OR (kind NOT IN ('rename','reattach') AND argument IS NULL)),
        state TEXT NOT NULL CHECK(state IN ('accepted','running','succeeded','rejected','failed','uncertain')), attempt_count INTEGER NOT NULL DEFAULT 0, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS session_operations_claim ON session_operations(state, binding_id, created_at);
      CREATE INDEX IF NOT EXISTS session_operations_recovery ON session_operations(state, updated_at);
    `);
  }

  ensureAgentSessionColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("agent_session_source")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_source TEXT");
    if (!names.has("agent_session_agent")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_agent TEXT");
    if (!names.has("agent_session_kind")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_kind TEXT CHECK(agent_session_kind IN ('id','path'))");
    if (!names.has("agent_session_value")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_value TEXT");
  }

  ensureProjectSelectionColumns(): void {
    const bindingColumns = this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>;
    if (!bindingColumns.some((column) => column.name === "project_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN project_id TEXT");
    const selectionColumns = this.context.database.prepare("PRAGMA table_info(project_selections)").all() as Array<{ name: string }>;
    if (!selectionColumns.some((column) => column.name === "initial_prompt_text")) this.context.database.exec("ALTER TABLE project_selections ADD COLUMN initial_prompt_text TEXT");
    const outboundColumns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!outboundColumns.some((column) => column.name === "selection_id")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN selection_id TEXT");
  }

  ensurePrimaryAgentKindColumns(): void {
    const bindingColumns = new Set((this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!bindingColumns.has("agent_kind")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'traex' CHECK(agent_kind IN ('pi','claude-code','codex','traex'))");
    const selectionColumns = new Set((this.context.database.prepare("PRAGMA table_info(project_selections)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!selectionColumns.has("agent_kind")) this.context.database.exec("ALTER TABLE project_selections ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'traex' CHECK(agent_kind IN ('pi','claude-code','codex','traex'))");
  }
}
