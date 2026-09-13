import type { SqliteContext } from "../context.js";
import { runForeignKeySafeRebuild } from "./foreign-key-safe-rebuild.js";

export class WorkerMigrations {
  constructor(private readonly context: SqliteContext) {}

  ensureWorkerSessionThreads(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 35").get();
    const table = this.context.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker_session_threads'").get();
    if (migrated && table) return;
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS worker_session_threads(
        id TEXT PRIMARY KEY, publication_key TEXT NOT NULL UNIQUE, worker_id TEXT NOT NULL, worker_session_generation INTEGER NOT NULL,
        parent_binding_id TEXT NOT NULL, parent_binding_generation INTEGER NOT NULL, parent_pane_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('canonical-main','legacy-entry')), source_main_message_id TEXT, action_message_id TEXT, topic_id TEXT UNIQUE, root_message_id TEXT UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('legacy-unpublished','reserving','active','stale')), created_at TEXT NOT NULL, activated_at TEXT, stale_at TEXT, updated_at TEXT NOT NULL,
        UNIQUE(worker_id, worker_session_generation),
        CHECK((mode = 'canonical-main' AND source_main_message_id IS NULL) OR (mode = 'legacy-entry' AND (state = 'legacy-unpublished' OR source_main_message_id IS NOT NULL))),
        CHECK((state IN ('legacy-unpublished','reserving') AND topic_id IS NULL AND root_message_id IS NULL AND activated_at IS NULL) OR (state = 'active' AND topic_id IS NOT NULL AND root_message_id IS NOT NULL AND activated_at IS NOT NULL AND stale_at IS NULL) OR (state = 'stale' AND stale_at IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS worker_session_threads_parent ON worker_session_threads(parent_binding_id, parent_binding_generation, state);
    `);
    const timestamp = now();
    this.context.database.prepare(`
      INSERT OR IGNORE INTO worker_session_threads(id, publication_key, worker_id, worker_session_generation, parent_binding_id, parent_binding_generation, parent_pane_id, chat_id, mode, state, created_at, updated_at)
      SELECT 'legacy-' || worker.id || '-' || worker.worker_session_generation, 'legacy-placement:' || worker.id || ':' || worker.worker_session_generation, worker.id, worker.worker_session_generation, worker.parent_binding_id, worker.parent_binding_generation, worker.parent_pane_id, binding.chat_id, 'legacy-entry', 'legacy-unpublished', ?, ?
      FROM agent_instances worker JOIN bindings binding ON binding.id = worker.parent_binding_id
      WHERE worker.role = 'worker' AND worker.worker_session_lifecycle = 'active' AND worker.parent_binding_id IS NOT NULL AND worker.parent_binding_generation IS NOT NULL AND worker.parent_pane_id IS NOT NULL
    `).run(timestamp, timestamp);
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (35)").run();
  }

  ensureWorkerThreadEntryRequests(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 42").get();
    if (migrated) return;
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS worker_thread_entry_requests(
        command_intent_id TEXT PRIMARY KEY REFERENCES swarm_command_intents(id) ON DELETE CASCADE, worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, worker_session_generation INTEGER NOT NULL,
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE, binding_generation INTEGER NOT NULL, root_message_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','reserved','stale')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS worker_thread_entry_requests_pending ON worker_thread_entry_requests(worker_id, worker_session_generation, state);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (42);
    `);
  }

  ensureWorkerThreadEntryInvalidations(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 43").get();
    if (migrated) return;
    const timestamp = now();
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database.prepare(`
        INSERT INTO card_context_invalidations(target_kind, target_id, target_generation, requested_dependency_revision, projected_dependency_revision, reason, created_at, updated_at)
        SELECT 'worker-session', request.worker_id, request.worker_session_generation, 1, 0, 'startup.worker-thread-entry-backfill', ?, ?
        FROM worker_thread_entry_requests request
        JOIN agent_instances worker ON worker.id = request.worker_id
          AND worker.role = 'worker' AND worker.worker_session_generation = request.worker_session_generation
          AND worker.parent_binding_id = request.binding_id AND worker.parent_binding_generation = request.binding_generation
        JOIN bindings binding ON binding.id = request.binding_id AND binding.generation = request.binding_generation
          AND binding.root_message_id = request.root_message_id
        JOIN worker_session_threads thread ON thread.worker_id = request.worker_id
          AND thread.worker_session_generation = request.worker_session_generation AND thread.state = 'active'
        JOIN worker_main_views main ON main.worker_id = request.worker_id
          AND main.worker_session_generation = request.worker_session_generation AND main.message_id = thread.root_message_id
        WHERE request.state = 'pending'
          AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
        ON CONFLICT(target_kind, target_id, target_generation) DO UPDATE SET
          requested_dependency_revision = card_context_invalidations.requested_dependency_revision + 1,
          reason = excluded.reason, updated_at = excluded.updated_at
      `).run(timestamp, timestamp);
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (43)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerCardDisplayRequests(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS worker_card_display_requests(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE, binding_generation INTEGER NOT NULL,
        parent_prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL,
        worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, worker_session_generation INTEGER NOT NULL, worker_name TEXT NOT NULL,
        receipt_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(binding_id, binding_generation, idempotency_key)
      );
    `);
  }

  ensureAgentInstanceLifecycleColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(agent_instances)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!names.has("provisioning_checkpoint")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN provisioning_checkpoint TEXT NOT NULL DEFAULT 'recorded'");
    if (!names.has("last_error")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN last_error TEXT");
    if (!names.has("pending_herdr_workspace_id")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN pending_herdr_workspace_id TEXT");
    if (!names.has("pending_pane_id")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN pending_pane_id TEXT");
  }

  ensureInstanceTurnActorProvenance(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 27").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const names = new Set((this.context.database.prepare("PRAGMA table_info(instance_turns)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!names.has("actor_kind")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN actor_kind TEXT CHECK(actor_kind IN ('human','thread-primary'))");
      if (!names.has("source_binding_id")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN source_binding_id TEXT");
      if (!names.has("source_binding_generation")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN source_binding_generation INTEGER");
      if (!names.has("source_parent_prompt_id")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN source_parent_prompt_id TEXT");
      this.context.database.exec(`
        UPDATE instance_turns SET
          actor_kind = CASE WHEN json_valid(actor_json) AND json_extract(actor_json, '$.kind') IN ('human','thread-primary') THEN json_extract(actor_json, '$.kind') ELSE NULL END,
          source_binding_id = CASE WHEN json_valid(actor_json) AND json_extract(actor_json, '$.kind') = 'thread-primary' THEN json_extract(actor_json, '$.bindingId') ELSE NULL END,
          source_binding_generation = CASE WHEN json_valid(actor_json) AND json_extract(actor_json, '$.kind') = 'thread-primary' THEN json_extract(actor_json, '$.bindingGeneration') ELSE NULL END,
          source_parent_prompt_id = CASE WHEN json_valid(actor_json) AND json_extract(actor_json, '$.kind') = 'thread-primary' THEN json_extract(actor_json, '$.parentPromptId') ELSE NULL END
        WHERE actor_kind IS NULL AND json_valid(actor_json);
        CREATE INDEX IF NOT EXISTS instance_turns_primary_source ON instance_turns(source_parent_prompt_id, source_binding_id, source_binding_generation) WHERE actor_kind = 'thread-primary';
        CREATE INDEX IF NOT EXISTS worker_turn_cards_session_phase ON worker_turn_cards(instance_id, worker_session_generation, phase, created_at, turn_id);
        INSERT INTO schema_migrations(version) VALUES (27);
      `);
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerOutboxStreamMetadata(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 28").get();
    const existingColumns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    const existingIndexes = new Set((this.context.database.prepare("PRAGMA index_list(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (migrated && existingColumns.has("stream_page_index") && existingColumns.has("stream_element_id") && existingIndexes.has("outbound_replies_worker_pending") && existingIndexes.has("outbound_replies_worker_stream")) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const names = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!names.has("stream_page_index")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN stream_page_index INTEGER");
      if (!names.has("stream_element_id")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN stream_element_id TEXT");
      this.context.database.exec(`
        UPDATE outbound_replies SET
          stream_page_index = CASE
            WHEN kind = 'stream_card_create' AND json_valid(payload) AND json_type(payload, '$.stream.pageIndex') = 'integer' THEN json_extract(payload, '$.stream.pageIndex')
            WHEN kind IN ('stream_content','stream_finish') AND json_valid(payload) AND json_type(payload, '$.pageIndex') = 'integer' THEN json_extract(payload, '$.pageIndex')
            ELSE NULL
          END,
          stream_element_id = CASE
            WHEN kind = 'stream_card_create' AND json_valid(payload) AND json_type(payload, '$.stream.elementId') = 'text' THEN json_extract(payload, '$.stream.elementId')
            WHEN kind = 'stream_content' AND json_valid(payload) AND json_type(payload, '$.elementId') = 'text' THEN json_extract(payload, '$.elementId')
            ELSE NULL
          END
        WHERE worker_turn_id IS NOT NULL AND (stream_page_index IS NULL OR stream_element_id IS NULL);
        CREATE INDEX IF NOT EXISTS outbound_replies_worker_pending ON outbound_replies(worker_turn_id, state) WHERE worker_turn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS outbound_replies_worker_stream ON outbound_replies(worker_turn_id, kind, stream_page_index, selection_id, delivery_order DESC) WHERE worker_turn_id IS NOT NULL AND state IN ('pending','delivered','dead_letter');
        INSERT OR IGNORE INTO schema_migrations(version) VALUES (28);
      `);
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerTurnCards(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 8").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const turnColumns = new Set((this.context.database.prepare("PRAGMA table_info(instance_turns)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!turnColumns.has("parent_turn_id")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN parent_turn_id TEXT REFERENCES instance_turns(id)");
      if (!turnColumns.has("source_message_id")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN source_message_id TEXT");
      if (!turnColumns.has("runtime_turn_id")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN runtime_turn_id TEXT");
      if (!turnColumns.has("runtime_turn_started_at")) this.context.database.exec("ALTER TABLE instance_turns ADD COLUMN runtime_turn_started_at TEXT");
      const outboxColumns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!outboxColumns.has("worker_turn_id")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN worker_turn_id TEXT REFERENCES instance_turns(id) ON DELETE CASCADE");
      this.context.database.exec(`
        CREATE INDEX IF NOT EXISTS instance_turns_parent ON instance_turns(parent_turn_id) WHERE parent_turn_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS instance_turns_runtime_turn ON instance_turns(runtime_turn_id) WHERE runtime_turn_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS worker_turn_cards(
          turn_id TEXT PRIMARY KEY REFERENCES instance_turns(id) ON DELETE CASCADE, instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, instance_generation INTEGER NOT NULL, worker_name TEXT NOT NULL, parent_turn_id TEXT, root_message_id TEXT NOT NULL,
          message_id TEXT UNIQUE, card_id TEXT, element_id TEXT NOT NULL, progress_sequence INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL CHECK(phase IN ('queued','preparing','running','blocked','completed','failed','cancelled','dispatch-uncertain')), request_text TEXT NOT NULL, answer TEXT NOT NULL, status_title TEXT, progress_json TEXT NOT NULL DEFAULT '[]', queue_position INTEGER NOT NULL,
          started_at TEXT, finished_at TEXT, notice TEXT, result_capture TEXT NOT NULL CHECK(result_capture IN ('pending','captured','unavailable')), page_index INTEGER NOT NULL, page_start INTEGER NOT NULL, sequence INTEGER NOT NULL, view_version INTEGER NOT NULL, delivered_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS worker_turn_cards_instance ON worker_turn_cards(instance_id, created_at, turn_id);
        CREATE TABLE IF NOT EXISTS worker_turn_card_pages(
          id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES instance_turns(id) ON DELETE CASCADE, page_index INTEGER NOT NULL, page_start INTEGER NOT NULL, element_id TEXT NOT NULL, message_id TEXT UNIQUE, card_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','finished')), sequence INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(turn_id, page_index)
        );
        CREATE INDEX IF NOT EXISTS worker_turn_card_pages_turn ON worker_turn_card_pages(turn_id, page_index);
        INSERT INTO schema_migrations(version) VALUES (8);
      `);
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerTurnCardPageStates(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 9").get();
    if (migrated) return;
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worker_turn_card_pages'").get() as { sql: string } | undefined;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      if (schema && (!schema.sql.includes("'creating'") || !schema.sql.includes("'frozen'"))) this.context.database.exec(`
        CREATE TABLE worker_turn_card_pages_next(
          id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES instance_turns(id) ON DELETE CASCADE, page_index INTEGER NOT NULL, page_start INTEGER NOT NULL, element_id TEXT NOT NULL, message_id TEXT UNIQUE, card_id TEXT, state TEXT NOT NULL CHECK(state IN ('creating','active','frozen','finished')), sequence INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(turn_id, page_index)
        );
        INSERT INTO worker_turn_card_pages_next SELECT * FROM worker_turn_card_pages;
        DROP TABLE worker_turn_card_pages; ALTER TABLE worker_turn_card_pages_next RENAME TO worker_turn_card_pages;
      `);
      this.context.database.exec("CREATE INDEX IF NOT EXISTS worker_turn_card_pages_turn ON worker_turn_card_pages(turn_id, page_index)");
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (9)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerTurnCardProgress(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 11").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(worker_turn_cards)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("status_title")) this.context.database.exec("ALTER TABLE worker_turn_cards ADD COLUMN status_title TEXT");
      if (!columns.has("progress_json")) this.context.database.exec("ALTER TABLE worker_turn_cards ADD COLUMN progress_json TEXT NOT NULL DEFAULT '[]'");
      if (!columns.has("progress_sequence")) this.context.database.exec("ALTER TABLE worker_turn_cards ADD COLUMN progress_sequence INTEGER NOT NULL DEFAULT 0");
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (11)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerTurnProgressSequence(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 12").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(worker_turn_cards)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("progress_sequence")) this.context.database.exec("ALTER TABLE worker_turn_cards ADD COLUMN progress_sequence INTEGER NOT NULL DEFAULT 0");
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (12)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerSourcePrimaryPaneLabel(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 13").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(agent_instances)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("source_primary_pane_label")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN source_primary_pane_label TEXT");
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (13)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerParentIdentity(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 14").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(agent_instances)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("parent_binding_id")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN parent_binding_id TEXT");
      if (!columns.has("parent_pane_id")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN parent_pane_id TEXT");
      if (!columns.has("parent_native_session_id")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN parent_native_session_id TEXT");
      if (!columns.has("worker_session_lifecycle")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN worker_session_lifecycle TEXT");
      this.context.database.exec("UPDATE agent_instances SET worker_session_lifecycle = 'legacy' WHERE role = 'worker' AND worker_session_lifecycle IS NULL");
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (14)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensurePrimaryScopedWorkerNames(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 16").get();
    if (migrated) return;
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_instances'").get() as { sql: string } | undefined;
    if (!schema?.sql) throw new Error("agent_instances schema is unavailable");
    if (/UNIQUE\s*\(\s*project_id\s*,\s*name\s*\)/i.test(schema.sql)) {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(agent_instances)").all() as Array<{ name: string }>).map(({ name }) => name));
      const parentBindingGeneration = columns.has("parent_binding_generation") ? "parent_binding_generation" : "NULL";
      const workerSessionGeneration = columns.has("worker_session_generation") ? "worker_session_generation" : "1";
      runForeignKeySafeRebuild(this.context, "Worker-scope migration", () => this.context.database.exec(`
        CREATE TABLE agent_instances_next(
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('primary','worker')),
        agent_kind TEXT NOT NULL CHECK(agent_kind IN ('pi','claude-code','codex','traex')), model TEXT, source_primary_pane_label TEXT, parent_binding_id TEXT, parent_binding_generation INTEGER, parent_pane_id TEXT, parent_native_session_id TEXT, worker_session_lifecycle TEXT CHECK(worker_session_lifecycle IN ('active','legacy','terminated')), worker_session_generation INTEGER NOT NULL DEFAULT 1,
          desired_state TEXT NOT NULL CHECK(desired_state IN ('running','stopped')),
          observed_state TEXT NOT NULL CHECK(observed_state IN ('unprovisioned','starting','idle','working','blocked','detached','stopped','failed')),
          workspace_lease_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 1, herdr_workspace_id TEXT, pane_id TEXT UNIQUE, native_session_id TEXT,
          provisioning_checkpoint TEXT NOT NULL DEFAULT 'recorded', last_error TEXT, pending_herdr_workspace_id TEXT, pending_pane_id TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO agent_instances_next(
          id, project_id, name, role, agent_kind, model, source_primary_pane_label, parent_binding_id, parent_binding_generation, parent_pane_id, parent_native_session_id, worker_session_lifecycle, worker_session_generation,
          desired_state, observed_state, workspace_lease_id, generation, herdr_workspace_id, pane_id, native_session_id, provisioning_checkpoint, last_error, pending_herdr_workspace_id, pending_pane_id, created_at, updated_at
        ) SELECT
          id, project_id, name, role, agent_kind, model, source_primary_pane_label, parent_binding_id, ${parentBindingGeneration}, parent_pane_id, parent_native_session_id, worker_session_lifecycle, ${workerSessionGeneration},
          desired_state, observed_state, workspace_lease_id, generation, herdr_workspace_id, pane_id, native_session_id, provisioning_checkpoint, last_error, pending_herdr_workspace_id, pending_pane_id, created_at, updated_at
        FROM agent_instances;
        DROP TABLE agent_instances;
        ALTER TABLE agent_instances_next RENAME TO agent_instances;
        CREATE UNIQUE INDEX agent_instances_project_primary ON agent_instances(project_id) WHERE role = 'primary';
        CREATE INDEX agent_instances_project_state ON agent_instances(project_id, observed_state, created_at);
      `));
    }
    this.context.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS agent_instances_worker_parent_name ON agent_instances(parent_binding_id, parent_pane_id, name) WHERE role = 'worker' AND parent_binding_id IS NOT NULL AND parent_pane_id IS NOT NULL");
    this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (16)").run();
  }

  ensureCardContextProjectionTables(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 17").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(agent_instances)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("worker_session_generation")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN worker_session_generation INTEGER NOT NULL DEFAULT 1");
      if (!columns.has("parent_binding_generation")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN parent_binding_generation INTEGER");
      this.context.database.exec(`
        CREATE TABLE worker_main_views(
          worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, worker_session_generation INTEGER NOT NULL,
          parent_binding_id TEXT NOT NULL, parent_binding_generation INTEGER NOT NULL, parent_pane_id TEXT NOT NULL, state_json TEXT NOT NULL,
          view_version INTEGER NOT NULL, delivered_version INTEGER NOT NULL, message_id TEXT, card_id TEXT, frozen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(worker_id, worker_session_generation)
        );
        CREATE INDEX worker_main_views_parent ON worker_main_views(parent_binding_id, parent_binding_generation, parent_pane_id, frozen_at);
        CREATE TABLE card_context_invalidations(
          target_kind TEXT NOT NULL CHECK(target_kind IN ('primary-session','primary-turn','worker-session','worker-turn')), target_id TEXT NOT NULL, target_generation INTEGER NOT NULL,
          requested_dependency_revision INTEGER NOT NULL, projected_dependency_revision INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(target_kind, target_id, target_generation)
        );
        CREATE INDEX card_context_invalidations_pending ON card_context_invalidations(projected_dependency_revision, requested_dependency_revision, updated_at);
        INSERT INTO schema_migrations(version) VALUES (17);
      `);
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureActiveWorkerScopedNames(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 21").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database.exec(`
        DROP INDEX IF EXISTS agent_instances_worker_parent_name;
        CREATE UNIQUE INDEX agent_instances_worker_parent_name
          ON agent_instances(parent_binding_id, parent_pane_id, name)
          WHERE role = 'worker' AND worker_session_lifecycle = 'active' AND parent_binding_id IS NOT NULL AND parent_pane_id IS NOT NULL;
      `);
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (21)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerTurnContextReferences(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 18").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(worker_turn_cards)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("worker_main_ref_json")) this.context.database.exec("ALTER TABLE worker_turn_cards ADD COLUMN worker_main_ref_json TEXT");
      if (!columns.has("primary_answer_ref_json")) this.context.database.exec("ALTER TABLE worker_turn_cards ADD COLUMN primary_answer_ref_json TEXT");
      if (!columns.has("worker_session_generation")) this.context.database.exec("ALTER TABLE worker_turn_cards ADD COLUMN worker_session_generation INTEGER NOT NULL DEFAULT 1");
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (18)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerMainOutboxIdentity(): void {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("worker_id")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN worker_id TEXT REFERENCES agent_instances(id) ON DELETE CASCADE");
      if (!columns.has("worker_session_generation")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN worker_session_generation INTEGER");
      this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (19)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensurePrimaryCardContextColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!names.has("worker_activity_json")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN worker_activity_json TEXT NOT NULL DEFAULT '[]'");
    if (!names.has("worker_dependency_revision")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN worker_dependency_revision INTEGER NOT NULL DEFAULT 0");
    if (!names.has("worker_context_frozen_at")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN worker_context_frozen_at TEXT");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (20)").run();
  }

  ensureCardContextStartupInvalidations(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 23").get();
    if (migrated) return;
    const timestamp = now();
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database.prepare(`
        INSERT INTO card_context_invalidations(target_kind, target_id, target_generation, requested_dependency_revision, projected_dependency_revision, reason, created_at, updated_at)
        SELECT 'worker-session', worker.id, worker.worker_session_generation, 1, 0, 'startup.worker-backfill', ?, ?
        FROM agent_instances worker
        JOIN bindings binding ON binding.id = worker.parent_binding_id
        WHERE worker.role = 'worker' AND worker.worker_session_lifecycle IN ('active','terminated')
          AND worker.parent_binding_id IS NOT NULL AND worker.parent_binding_generation IS NOT NULL AND worker.parent_pane_id IS NOT NULL
          AND binding.generation = worker.parent_binding_generation AND binding.pane_id = worker.parent_pane_id
        ON CONFLICT(target_kind, target_id, target_generation) DO UPDATE SET
          requested_dependency_revision = MAX(card_context_invalidations.requested_dependency_revision, 1),
          reason = excluded.reason, updated_at = excluded.updated_at
      `).run(timestamp, timestamp);
      this.context.database.prepare(`
        INSERT INTO card_context_invalidations(target_kind, target_id, target_generation, requested_dependency_revision, projected_dependency_revision, reason, created_at, updated_at)
        SELECT 'primary-session', binding.id, binding.generation, 1, 0, 'startup.primary-backfill', ?, ?
        FROM bindings binding
        WHERE binding.pane_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM agent_instances worker
          WHERE worker.role = 'worker' AND worker.worker_session_lifecycle = 'active'
            AND worker.parent_binding_id = binding.id AND worker.parent_binding_generation = binding.generation AND worker.parent_pane_id = binding.pane_id
        )
        ON CONFLICT(target_kind, target_id, target_generation) DO UPDATE SET
          requested_dependency_revision = MAX(card_context_invalidations.requested_dependency_revision, 1),
          reason = excluded.reason, updated_at = excluded.updated_at
      `).run(timestamp, timestamp);
      this.context.database.prepare(`
        INSERT INTO card_context_invalidations(target_kind, target_id, target_generation, requested_dependency_revision, projected_dependency_revision, reason, created_at, updated_at)
        SELECT 'primary-turn', run.prompt_id, run.binding_generation, 1, 0, 'startup.answer-backfill', ?, ?
        FROM run_cards run
        JOIN bindings binding ON binding.id = run.binding_id AND binding.generation = run.binding_generation
        LEFT JOIN answer_pages page ON page.prompt_id = run.prompt_id AND page.page_index = run.answer_page_index
        WHERE run.worker_context_frozen_at IS NULL AND run.phase IN ('queued','running','blocked')
          AND COALESCE(page.state, 'active') NOT IN ('frozen','finished')
        ON CONFLICT(target_kind, target_id, target_generation) DO UPDATE SET
          requested_dependency_revision = MAX(card_context_invalidations.requested_dependency_revision, 1),
          reason = excluded.reason, updated_at = excluded.updated_at
      `).run(timestamp, timestamp);
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (23)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  ensureWorkerPaneCloseSteps(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 15").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database.exec(`
        CREATE TABLE IF NOT EXISTS worker_pane_close_steps(
          operation_id TEXT NOT NULL REFERENCES pane_close_requests(id) ON DELETE CASCADE, binding_id TEXT NOT NULL, parent_pane_id TEXT NOT NULL, worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, pane_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('executing','succeeded','uncertain')), detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(operation_id, worker_id, pane_id)
        );
        CREATE INDEX IF NOT EXISTS worker_pane_close_steps_unresolved ON worker_pane_close_steps(state, created_at);
      `);
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (15)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
  }
}

function now(): string { return new Date().toISOString(); }
