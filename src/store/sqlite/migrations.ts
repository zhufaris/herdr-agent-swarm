import { answerElementId } from "../../domain/run-card-view.js";
import { outboundLaneKeySql } from "../outbox-lanes.js";
import { canonicalizeAnswerPayload } from "./answer-payload.js";
import type { SqliteContext } from "./context.js";
import { createLatestSchema } from "./schema.js";

export class SqliteMigrations {
  constructor(private readonly context: SqliteContext) {}

  run(): void {
    const runCardViewNeedsRebuild = this.runCardViewNeedsRebuild();
    if (runCardViewNeedsRebuild) this.context.database.exec("DROP VIEW IF EXISTS run_cards_view");
    createLatestSchema(this.context);
    this.ensureOutboundReplyColumns();
    this.ensureMainCardSequences();
    this.ensureAgentInstanceLifecycleColumns();
    this.ensureInboundMessageIdempotency();
    this.ensureOutboundCardCheckpoint();
    this.ensureRequestCardOutboxColumns();
    this.ensureOutboundTargetRole();
    this.ensureRunCardQueueFeedbackColumn();
    this.ensureRunCardRequestText();
    this.ensureRunCardSpaceName();
    this.ensureRunCardSessionTitle();
    this.ensureDualRequestCardColumns();
    this.ensureRunCardAnswerState();
    this.ensureRunCardProgressSummary();
    this.ensureRunCardInteractionColumns();
    this.ensureStreamingCardColumns();
    this.ensureAnswerPageDeliveryMode();
    this.ensureAnswerPages();
    this.ensureProjectSelectionColumns();
    this.ensureBindingLifecycleColumns();
    this.ensureBindingPrimaryToolCapabilities();
    this.ensureBindingCreatorColumn();
    this.ensureSessionOperations();
    this.ensureAgentSessionColumns();
    this.removeReportedTraexSessionColumns();
    this.ensureBindingResetColumns();
    this.ensureTwoPhaseResetState();
    this.ensurePromptCancelledState();
    this.ensurePromptObservationColumn();
    this.ensurePromptProvenanceColumns();
    this.ensurePromptTranscriptProvenanceColumns();
    this.ensureTurnPriorityColumns();
    this.ensureModelPreferenceSchema();
    this.ensurePromptExecutionOriginColumn();
    this.ensureRunCardActivityColumn();
    this.convergeRetiredPromptSteering();
    this.ensureOutboundDeliveryOrder();
    this.ensureOutboundDismissedState();
    this.ensureOutboundDeliveryOrder();
    this.ensureWorkerTurnCards();
    this.ensureWorkerTurnCardPageStates();
    this.ensureWorkerTurnCardProgress();
    this.ensureWorkerTurnProgressSequence();
    this.ensureWorkerSourcePrimaryPaneLabel();
    this.ensureWorkerParentIdentity();
    this.ensurePrimaryScopedWorkerNames();
    this.ensureCardContextProjectionTables();
    this.ensureActiveWorkerScopedNames();
    this.ensureWorkerTurnContextReferences();
    this.ensureInstanceTurnActorProvenance();
    this.ensureWorkerOutboxStreamMetadata();
    this.ensureWorkerMainOutboxIdentity();
    this.ensurePrimaryCardContextColumns();
    this.ensureCardContextStartupInvalidations();
    this.ensureWorkerPaneCloseSteps();
    this.ensureOutboundLaneKey();
    this.ensureOutboxLaneQuarantines();
    this.ensureOutboxLaneHeads();
    this.ensureIndependentReplyLanes();
    this.ensureCardContextOutboxLanes();
    this.ensureOutboundFailureMetadata();
    this.ensureTypedDeliveryIntents();
    this.ensurePaneCloseOperationState();
    this.ensurePaneControlOperationState();
    this.ensureTurnControlOperations();
    this.ensureSwarmCommandIntents();
    this.ensureWorkerCardDisplayRequests();
    if (runCardViewNeedsRebuild) this.recreateRunCardsView();
    this.ensureQueryIndexes();
    const answerTargetMigration = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 2").get();
    if (!answerTargetMigration) {
      this.context.database.exec("BEGIN IMMEDIATE");
      try {
        this.canonicalizeLegacyAnswerTargets(now());
        this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (2)").run();
        this.context.database.exec("COMMIT");
      } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
    }
    const answerFinishMigration = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get();
    if (!answerFinishMigration) {
      this.context.database.exec("BEGIN IMMEDIATE");
      try {
        this.finishLegacyDeliveredAnswerPages(now());
        this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (3)").run();
        this.context.database.exec("COMMIT");
      } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
    }
    const answerDeadLetterMigration = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get();
    if (!answerDeadLetterMigration) {
      this.context.database.exec("BEGIN IMMEDIATE");
      try {
        this.dismissStreamsForFinishedAnswerPages(now());
        this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (4)").run();
        this.context.database.exec("COMMIT");
      } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
    }
  }

  private ensureWorkerCardDisplayRequests(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS worker_card_display_requests(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE, binding_generation INTEGER NOT NULL,
        parent_prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL,
        worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, worker_session_generation INTEGER NOT NULL, worker_name TEXT NOT NULL,
        receipt_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(binding_id, binding_generation, idempotency_key)
      );
    `);
  }

  private ensureAgentInstanceLifecycleColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(agent_instances)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!names.has("provisioning_checkpoint")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN provisioning_checkpoint TEXT NOT NULL DEFAULT 'recorded'");
    if (!names.has("last_error")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN last_error TEXT");
    if (!names.has("pending_herdr_workspace_id")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN pending_herdr_workspace_id TEXT");
    if (!names.has("pending_pane_id")) this.context.database.exec("ALTER TABLE agent_instances ADD COLUMN pending_pane_id TEXT");
  }

  private finishLegacyDeliveredAnswerPages(timestamp: string): void {
    this.context.database.prepare(`
      UPDATE answer_pages AS page
      SET state = 'finished',
          sequence = MAX(sequence, COALESCE((
            SELECT MAX(COALESCE(reply.view_version, json_extract(reply.payload, '$.sequence'), 0))
            FROM outbound_replies AS reply
            WHERE reply.prompt_id = page.prompt_id AND reply.card_role = 'answer'
              AND reply.kind = 'stream_finish' AND reply.state = 'delivered'
              AND reply.root_message_id = page.card_id
              AND json_extract(reply.payload, '$.pageIndex') IS NULL
              AND json_extract(reply.payload, '$.summary') IN ('Completed', 'Failed')
          ), sequence)),
          updated_at = ?
      WHERE page.state = 'active'
        AND EXISTS (SELECT 1 FROM run_cards AS card WHERE card.prompt_id = page.prompt_id AND card.phase IN ('completed', 'failed'))
        AND EXISTS (
          SELECT 1 FROM outbound_replies AS reply
          WHERE reply.prompt_id = page.prompt_id AND reply.card_role = 'answer'
            AND reply.kind = 'stream_finish' AND reply.state = 'delivered'
            AND reply.root_message_id = page.card_id
            AND json_extract(reply.payload, '$.pageIndex') IS NULL
            AND json_extract(reply.payload, '$.summary') IN ('Completed', 'Failed')
        )
    `).run(timestamp);
    this.dismissStreamsForFinishedAnswerPages(timestamp);
  }

  private dismissStreamsForFinishedAnswerPages(timestamp: string): void {
    this.context.database.prepare(`
      UPDATE outbound_replies
      SET state = 'dismissed', error = 'Answer stream targets a legacy page that was already finished', updated_at = ?
      WHERE state IN ('pending', 'dead_letter') AND kind IN ('stream_content', 'stream_finish')
        AND EXISTS (
          SELECT 1 FROM answer_pages AS page
          WHERE page.prompt_id = outbound_replies.prompt_id AND page.state = 'finished'
            AND page.card_id = outbound_replies.root_message_id
        )
    `).run(timestamp);
  }

  canonicalizeLegacyAnswerTargets(timestamp: string): void {
    let afterPromptId = "";
    while (true) {
      const cards = this.context.database.prepare("SELECT prompt_id, answer_element_id, answer_page_index FROM run_cards WHERE answer_element_id != '' AND prompt_id > ? ORDER BY prompt_id LIMIT 100")
        .all(afterPromptId) as Array<{ prompt_id: string; answer_element_id: string; answer_page_index: number }>;
      if (cards.length === 0) return;
      for (const card of cards) {
        const canonical = answerElementId(card.prompt_id, Number(card.answer_page_index));
        if (canonical !== card.answer_element_id) this.context.database.prepare("UPDATE run_cards SET answer_element_id = ?, updated_at = ? WHERE prompt_id = ?").run(canonical, timestamp, card.prompt_id);
        const replies = this.context.database.prepare("SELECT id, kind, payload FROM outbound_replies INDEXED BY outbound_replies_prompt_role_state WHERE prompt_id = ? AND card_role = 'answer' AND state IN ('pending','dead_letter')").all(card.prompt_id) as Array<{ id: string; kind: string; payload: string }>;
        for (const reply of replies) {
          const payload = canonicalizeAnswerPayload(reply.kind, reply.payload, card.prompt_id, canonical);
          if (payload !== reply.payload) this.context.database.prepare("UPDATE outbound_replies SET payload = ?, updated_at = ? WHERE id = ?").run(payload, timestamp, reply.id);
        }
      }
      afterPromptId = cards.at(-1)!.prompt_id;
    }
  }

  private ensureBindingResetColumns(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("retired_topic_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN retired_topic_id TEXT");
    if (!columns.has("retired_root_message_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN retired_root_message_id TEXT");
  }

  private ensureInboundMessageIdempotency(): void {
    this.context.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_message_id ON inbound_messages(message_id)");
  }

  private ensureOutboundTargetRole(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("target_role")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN target_role TEXT CHECK(target_role IN ('session_status','operation_result'))");
    this.context.database.prepare("UPDATE outbound_replies SET target_role = 'session_status' WHERE target_role IS NULL AND kind = 'card_reply' AND idempotency_key LIKE 'status-card:%'").run();
    this.context.database.prepare("UPDATE outbound_replies SET target_role = 'operation_result' WHERE target_role IS NULL AND kind = 'card_reply' AND idempotency_key LIKE 'model:%'").run();
    this.context.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'Status update target was an operation result', updated_at = ? WHERE state = 'pending' AND kind = 'card_update' AND prompt_id IS NULL AND root_message_id IN (SELECT delivered_message_id FROM outbound_replies WHERE target_role = 'operation_result' AND delivered_message_id IS NOT NULL)").run(now());
    this.context.database.prepare("UPDATE bindings SET status_message_id = root_message_id, updated_at = ? WHERE root_message_id IS NOT NULL AND status_message_id IN (SELECT delivered_message_id FROM outbound_replies WHERE target_role = 'operation_result' AND delivered_message_id IS NOT NULL)").run(now());
  }

  private ensureTwoPhaseResetState(): void {
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

  private ensureQueryIndexes(): void {
    this.context.database.exec(`
      CREATE INDEX IF NOT EXISTS bindings_state_created ON bindings(state, created_at, id);
      CREATE INDEX IF NOT EXISTS bindings_root_created ON bindings(root_message_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS run_cards_binding_phase_created ON run_cards(binding_id, phase, created_at, prompt_id);
      CREATE INDEX IF NOT EXISTS outbound_replies_prompt_role_state ON outbound_replies(prompt_id, card_role, state);
      CREATE INDEX IF NOT EXISTS outbound_replies_prompt_kind_state_updated ON outbound_replies(prompt_id, kind, state, updated_at);
      CREATE INDEX IF NOT EXISTS outbound_replies_binding_target_version ON outbound_replies(binding_id, target_role, view_version);
      CREATE INDEX IF NOT EXISTS outbound_replies_retention ON outbound_replies(state, updated_at, delivery_order);
      CREATE INDEX IF NOT EXISTS inbound_messages_retention ON inbound_messages(state, updated_at, event_id);
      CREATE INDEX IF NOT EXISTS prompt_jobs_priority_queue ON prompt_jobs(binding_id, state, priority, created_at);
    `);
  }

  private ensureOutboundDismissedState(): void {
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_replies'").get() as { sql: string } | undefined;
    if (schema?.sql.includes("'dismissed'") && schema.sql.includes("'stream_card_create'")) return;
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    const workerTurnId = columns.has("worker_turn_id") ? "worker_turn_id" : "NULL";
    this.context.database.exec(`
      PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;
      CREATE TABLE outbound_replies_next(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, worker_turn_id TEXT REFERENCES instance_turns(id) ON DELETE CASCADE, view_version INTEGER, card_sequence INTEGER, selection_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), target_role TEXT CHECK(target_role IN ('session_status','operation_result')), root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT, card_id_checkpoint TEXT, delivery_order INTEGER, lane_key TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO outbound_replies_next(id, idempotency_key, binding_id, prompt_id, worker_turn_id, view_version, card_sequence, selection_id, card_role, target_role, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, lane_key, next_attempt_at, created_at, updated_at)
      SELECT id, idempotency_key, binding_id, prompt_id, ${workerTurnId}, view_version, card_sequence, selection_id, card_role, target_role, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, ${outboundLaneKeySql(workerTurnId, "NULL", "NULL")}, next_attempt_at, created_at, updated_at FROM outbound_replies;
      DROP TABLE outbound_replies; ALTER TABLE outbound_replies_next RENAME TO outbound_replies;
      CREATE INDEX outbound_replies_pending ON outbound_replies(state, next_attempt_at, created_at); COMMIT; PRAGMA foreign_keys = ON;
    `);
    const violation = this.context.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) throw new Error(`Outbound-state migration produced a foreign-key violation: ${JSON.stringify(violation)}`);
  }

  private ensureStreamingCardColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("answer_card_id")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_card_id TEXT");
    if (!names.has("answer_element_id")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_element_id TEXT NOT NULL DEFAULT ''");
    if (!names.has("answer_sequence")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_sequence INTEGER NOT NULL DEFAULT 0");
    if (!names.has("answer_page_index")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_page_index INTEGER NOT NULL DEFAULT 0");
    if (!names.has("answer_page_start")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_page_start INTEGER NOT NULL DEFAULT 0");
    this.context.database.exec("UPDATE run_cards SET answer_element_id = 'answer-content-' || replace(prompt_id, ':', '-') WHERE answer_element_id = ''");
  }

  private ensureAnswerPages(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS answer_pages(
        prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id), page_index INTEGER NOT NULL, message_id TEXT, card_id TEXT, element_id TEXT NOT NULL,
        source_start INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN ('creating','active','frozen','finished')), delivery_mode TEXT NOT NULL DEFAULT 'streaming' CHECK(delivery_mode IN ('streaming','static')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(prompt_id, page_index)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS answer_pages_active ON answer_pages(prompt_id) WHERE state = 'active';
      INSERT OR IGNORE INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at)
      SELECT prompt_id, answer_page_index, answer_message_id, answer_card_id, answer_element_id, answer_page_start, answer_sequence,
        CASE WHEN answer_card_id IS NULL THEN 'creating' ELSE 'active' END, 'streaming', created_at, updated_at FROM run_cards;
    `);
  }

  private ensureAnswerPageDeliveryMode(): void {
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(answer_pages)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has("delivery_mode")) this.context.database.exec("ALTER TABLE answer_pages ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'streaming' CHECK(delivery_mode IN ('streaming','static'))");
  }

  private ensurePromptCancelledState(): void {
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

  private ensureBindingLifecycleColumns(): void {
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

  private ensureMainCardSequences(): void {
    const bindingColumns = new Set((this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!bindingColumns.has("status_card_sequence")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN status_card_sequence INTEGER NOT NULL DEFAULT 0");
    const outboundColumns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!outboundColumns.has("card_sequence")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN card_sequence INTEGER");
  }

  private ensureBindingPrimaryToolCapabilities(): void {
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

  private ensureBindingCreatorColumn(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "creator_open_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN creator_open_id TEXT");
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS card_interactions(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL, actor_open_id TEXT NOT NULL,
        action_kind TEXT NOT NULL CHECK(action_kind IN ('supplement','convert_queued_prompt','more_actions','session_control')),
        parent_prompt_id TEXT, target_prompt_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','claimed','consumed','expired')),
        expires_at TEXT NOT NULL, result_code TEXT, created_at TEXT NOT NULL, claimed_at TEXT, consumed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS card_interactions_expiry ON card_interactions(state, expires_at);
    `);
  }

  private ensureFailedSteeringInteractionKind(): void {
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'card_interactions'").get() as { sql: string } | undefined;
    if (!schema || schema.sql.includes("'enqueue_failed_steering'")) return;
    this.context.database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      ALTER TABLE card_interactions RENAME TO card_interactions_legacy;
      CREATE TABLE card_interactions(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL, actor_open_id TEXT NOT NULL,
        action_kind TEXT NOT NULL CHECK(action_kind IN ('supplement','convert_queued_prompt','enqueue_failed_steering','more_actions','session_control')),
        parent_prompt_id TEXT, target_prompt_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','claimed','consumed','expired')),
        expires_at TEXT NOT NULL, result_code TEXT, created_at TEXT NOT NULL, claimed_at TEXT, consumed_at TEXT
      );
      INSERT INTO card_interactions SELECT * FROM card_interactions_legacy;
      DROP TABLE card_interactions_legacy;
      CREATE INDEX card_interactions_expiry ON card_interactions(state, expires_at);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    const violation = this.context.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) throw new Error(`Card-interaction migration produced a foreign-key violation: ${JSON.stringify(violation)}`);
  }

  private ensureSessionOperations(): void {
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

  private ensureAgentSessionColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("agent_session_source")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_source TEXT");
    if (!names.has("agent_session_agent")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_agent TEXT");
    if (!names.has("agent_session_kind")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_kind TEXT CHECK(agent_session_kind IN ('id','path'))");
    if (!names.has("agent_session_value")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_value TEXT");
  }

  private removeReportedTraexSessionColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map((column) => column.name));
    const obsolete = ["reported_traex_session_id", "reported_traex_session_at"].filter((name) => names.has(name));
    if (!obsolete.length) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      for (const name of obsolete) this.context.database.exec(`ALTER TABLE bindings DROP COLUMN ${name}`);
      this.context.database.exec("COMMIT");
    } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
  }

  private ensureProjectSelectionColumns(): void {
    const bindingColumns = this.context.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>;
    if (!bindingColumns.some((column) => column.name === "project_id")) this.context.database.exec("ALTER TABLE bindings ADD COLUMN project_id TEXT");
    const selectionColumns = this.context.database.prepare("PRAGMA table_info(project_selections)").all() as Array<{ name: string }>;
    if (!selectionColumns.some((column) => column.name === "initial_prompt_text")) this.context.database.exec("ALTER TABLE project_selections ADD COLUMN initial_prompt_text TEXT");
    const outboundColumns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!outboundColumns.some((column) => column.name === "selection_id")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN selection_id TEXT");
  }

  private ensurePromptObservationColumn(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "observation_state")) {
      this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed'))");
    }
    this.context.database.exec("UPDATE prompt_jobs SET observation_state = CASE WHEN state = 'running' THEN 'attached' WHEN state = 'queued' THEN 'not_started' ELSE 'completed' END WHERE observation_state = 'not_started' AND state != 'queued'");
  }

  private ensurePromptProvenanceColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("was_detached")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1))");
  }

  private ensurePromptTranscriptProvenanceColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("dispatched_at")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN dispatched_at TEXT");
    if (!names.has("transcript_turn_id")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN transcript_turn_id TEXT");
    if (!names.has("transcript_turn_started_at")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN transcript_turn_started_at TEXT");
  }

  private ensureTurnPriorityColumns(): void {
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

  private ensureModelPreferenceSchema(): void {
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

  private ensurePromptExecutionOriginColumn(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("execution_origin")) this.context.database.exec("ALTER TABLE prompt_jobs ADD COLUMN execution_origin TEXT NOT NULL DEFAULT 'bridge' CHECK(execution_origin IN ('bridge','herdr'))");
    this.context.database.exec("CREATE INDEX IF NOT EXISTS prompt_jobs_transcript_turn ON prompt_jobs(transcript_turn_id) WHERE transcript_turn_id IS NOT NULL");
  }

  private ensureInstanceTurnActorProvenance(): void {
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

  private ensureWorkerOutboxStreamMetadata(): void {
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

  private ensureRunCardActivityColumn(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "activity_at")) return;
    this.context.database.exec("ALTER TABLE run_cards ADD COLUMN activity_at TEXT");
    this.context.database.exec("UPDATE run_cards SET activity_at = created_at WHERE activity_at IS NULL");
  }

  private convergeRetiredPromptSteering(): void {
    if (this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 30").get()) return;
    const promptColumns = new Set((this.context.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!promptColumns.has("dispatch_kind")) {
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (30)").run();
      return;
    }
    const runCardColumns = new Set((this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!runCardColumns.has("steering_origin")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN steering_origin TEXT CHECK(steering_origin IN ('explicit','automatic','converted'))");
    if (!runCardColumns.has("steering_failure_kind")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN steering_failure_kind TEXT CHECK(steering_failure_kind IN ('rejected','uncertain'))");
    const retiredPromptColumns = ["source_prompt_id", "steering_origin", "parent_prompt_id", "dispatch_kind"].filter((column) => promptColumns.has(column));
    const timestamp = now();
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database.prepare(`
        UPDATE prompt_jobs
        SET state = 'failed', observation_state = 'completed', was_detached = CASE state WHEN 'running' THEN 1 ELSE was_detached END,
          error = CASE state
            WHEN 'queued' THEN 'Retired steering work was rejected during upgrade and was not sent.'
            ELSE 'Retired steering delivery may already have reached Herdr; inspect the pane before retrying.'
          END, updated_at = ?
        WHERE dispatch_kind = 'steering' AND state IN ('queued','running')
      `).run(timestamp);
      this.context.database.prepare(`
        UPDATE run_cards
        SET phase = 'failed', finished_at = ?, queue_position = 0,
          notice = CASE (SELECT state FROM prompt_jobs WHERE prompt_jobs.id = run_cards.prompt_id)
            WHEN 'failed' THEN CASE (SELECT was_detached FROM prompt_jobs WHERE prompt_jobs.id = run_cards.prompt_id)
              WHEN 1 THEN 'Retired steering delivery may already have reached Herdr; inspect the pane before retrying.'
              ELSE 'Retired steering work was rejected during upgrade and was not sent.'
            END
            ELSE notice
          END,
          activity_at = ?, view_version = view_version + 1, updated_at = ?
        WHERE prompt_id IN (SELECT id FROM prompt_jobs WHERE dispatch_kind = 'steering' AND state = 'failed' AND updated_at = ?)
      `).run(timestamp, timestamp, timestamp, timestamp);
      this.context.database.exec(`
        DROP VIEW IF EXISTS run_cards_view;
        DROP INDEX IF EXISTS prompt_jobs_dispatch;
        DROP INDEX IF EXISTS prompt_jobs_source_prompt_once;
        DROP INDEX IF EXISTS prompt_jobs_queue_kind;
        DROP INDEX IF EXISTS prompt_jobs_priority_queue;
        ALTER TABLE run_cards DROP COLUMN steering_failure_kind;
        ALTER TABLE run_cards DROP COLUMN steering_origin;
        ${retiredPromptColumns.map((column) => `ALTER TABLE prompt_jobs DROP COLUMN ${column};`).join("\n        ")}
        CREATE INDEX prompt_jobs_priority_queue ON prompt_jobs(binding_id, state, priority, created_at);
      `);
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (30)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  private ensureRunCardQueueFeedbackColumn(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("queue_feedback_json")) {
      this.context.database.exec("ALTER TABLE run_cards ADD COLUMN queue_feedback_json TEXT");
    }
  }

  private ensurePaneCloseOperationState(): void {
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

  private ensurePaneControlOperationState(): void {
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

  private ensureTurnControlOperations(): void {
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

  private ensureSwarmCommandIntents(): void {
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

  private ensureRequestCardOutboxColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("prompt_id")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN prompt_id TEXT");
    if (!names.has("view_version")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN view_version INTEGER");
    if (!names.has("card_role")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN card_role TEXT CHECK(card_role IN ('task','answer'))");
  }

  private ensureWorkerTurnCards(): void {
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

  private ensureWorkerTurnCardPageStates(): void {
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

  private ensureWorkerTurnCardProgress(): void {
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

  private ensureWorkerTurnProgressSequence(): void {
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

  private ensureWorkerSourcePrimaryPaneLabel(): void {
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

  private ensureWorkerParentIdentity(): void {
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

  private ensurePrimaryScopedWorkerNames(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 16").get();
    if (migrated) return;
    const schema = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_instances'").get() as { sql: string } | undefined;
    if (!schema?.sql) throw new Error("agent_instances schema is unavailable");
    if (/UNIQUE\s*\(\s*project_id\s*,\s*name\s*\)/i.test(schema.sql)) {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(agent_instances)").all() as Array<{ name: string }>).map(({ name }) => name));
      const parentBindingGeneration = columns.has("parent_binding_generation") ? "parent_binding_generation" : "NULL";
      const workerSessionGeneration = columns.has("worker_session_generation") ? "worker_session_generation" : "1";
      this.context.database.exec(`
        PRAGMA foreign_keys = OFF;
        BEGIN IMMEDIATE;
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
        COMMIT;
        PRAGMA foreign_keys = ON;
      `);
      const violation = this.context.database.prepare("PRAGMA foreign_key_check").get();
      if (violation) throw new Error(`Worker-scope migration produced a foreign-key violation: ${JSON.stringify(violation)}`);
    }
    this.context.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS agent_instances_worker_parent_name ON agent_instances(parent_binding_id, parent_pane_id, name) WHERE role = 'worker' AND parent_binding_id IS NOT NULL AND parent_pane_id IS NOT NULL");
    this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (16)").run();
  }

  private ensureCardContextProjectionTables(): void {
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

  private ensureActiveWorkerScopedNames(): void {
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

  private ensureWorkerTurnContextReferences(): void {
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

  private ensureWorkerMainOutboxIdentity(): void {
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
      if (!columns.has("worker_id")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN worker_id TEXT REFERENCES agent_instances(id) ON DELETE CASCADE");
      if (!columns.has("worker_session_generation")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN worker_session_generation INTEGER");
      this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (19)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  private ensurePrimaryCardContextColumns(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!names.has("worker_activity_json")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN worker_activity_json TEXT NOT NULL DEFAULT '[]'");
    if (!names.has("worker_dependency_revision")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN worker_dependency_revision INTEGER NOT NULL DEFAULT 0");
    if (!names.has("worker_context_frozen_at")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN worker_context_frozen_at TEXT");
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (20)").run();
  }

  private ensureCardContextStartupInvalidations(): void {
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

  private ensureWorkerPaneCloseSteps(): void {
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

  private ensureOutboundCardCheckpoint(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "card_id_checkpoint")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN card_id_checkpoint TEXT");
  }

  private ensureOutboundDeliveryOrder(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "delivery_order")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN delivery_order INTEGER");
    this.context.database.exec(`
      UPDATE outbound_replies SET delivery_order = rowid WHERE delivery_order IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS outbound_replies_delivery_order ON outbound_replies(delivery_order);
      CREATE TRIGGER IF NOT EXISTS outbound_replies_assign_delivery_order
      AFTER INSERT ON outbound_replies WHEN NEW.delivery_order IS NULL
      BEGIN
        UPDATE outbound_replies SET delivery_order = (SELECT COALESCE(MAX(delivery_order), 0) + 1 FROM outbound_replies WHERE id != NEW.id) WHERE id = NEW.id;
      END;
    `);
  }

  private ensureOutboundLaneKey(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "lane_key")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN lane_key TEXT");
    this.context.database.exec(`
      UPDATE outbound_replies SET lane_key = ${outboundLaneKeySql()} WHERE lane_key IS NULL OR lane_key = '';
      CREATE INDEX IF NOT EXISTS outbound_replies_lane_order ON outbound_replies(state, lane_key, delivery_order);
    `);
  }

  private ensureOutboxLaneHeads(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS outbox_lane_heads(
        lane_key TEXT PRIMARY KEY, reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE CASCADE,
        delivery_order INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_lane_heads_delivery_order ON outbox_lane_heads(delivery_order);
      CREATE INDEX IF NOT EXISTS outbox_lane_heads_next_attempt ON outbox_lane_heads(next_attempt_at, delivery_order);
    `);
    const trigger = this.context.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'outbox_lane_heads_after_insert'").get() as { sql: string } | undefined;
    if (!trigger?.sql.includes("outbox_lane_quarantines")) this.context.database.exec(`
      DROP TRIGGER IF EXISTS outbox_lane_heads_after_insert;
      DROP TRIGGER IF EXISTS outbox_lane_heads_after_update;
      DROP TRIGGER IF EXISTS outbox_lane_heads_after_delete;
      CREATE TRIGGER outbox_lane_heads_after_insert AFTER INSERT ON outbound_replies
      WHEN NEW.delivery_order IS NOT NULL
      BEGIN
        DELETE FROM outbox_lane_heads WHERE lane_key = NEW.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = NEW.lane_key AND state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = NEW.lane_key AND q.state = 'active')
          ORDER BY delivery_order LIMIT 1;
      END;
      CREATE TRIGGER outbox_lane_heads_after_update AFTER UPDATE OF state, lane_key, delivery_order, next_attempt_at ON outbound_replies
      BEGIN
        DELETE FROM outbox_lane_heads WHERE lane_key = OLD.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = OLD.lane_key AND state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = OLD.lane_key AND q.state = 'active')
          ORDER BY delivery_order LIMIT 1;
        DELETE FROM outbox_lane_heads WHERE lane_key = NEW.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = NEW.lane_key AND state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = NEW.lane_key AND q.state = 'active')
          ORDER BY delivery_order LIMIT 1;
      END;
      CREATE TRIGGER outbox_lane_heads_after_delete AFTER DELETE ON outbound_replies
      BEGIN
        DELETE FROM outbox_lane_heads WHERE lane_key = OLD.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = OLD.lane_key AND state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = OLD.lane_key AND q.state = 'active')
          ORDER BY delivery_order LIMIT 1;
      END;
    `);
    this.context.database.exec(`
      DELETE FROM outbox_lane_heads;
      INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
        SELECT pending.lane_key, pending.id, pending.delivery_order, pending.next_attempt_at, pending.created_at
        FROM outbound_replies pending
        WHERE pending.state = 'pending'
          AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = pending.lane_key AND q.state = 'active')
          AND pending.delivery_order = (
            SELECT MIN(candidate.delivery_order)
            FROM outbound_replies candidate
            WHERE candidate.state = 'pending' AND candidate.lane_key = pending.lane_key
          );
    `);
  }

  private ensureOutboxLaneQuarantines(): void {
    this.context.database.exec(`
      CREATE TABLE IF NOT EXISTS outbox_lane_quarantines(
        lane_key TEXT PRIMARY KEY, failed_reply_id TEXT NOT NULL REFERENCES outbound_replies(id) ON DELETE CASCADE,
        lane_class TEXT NOT NULL CHECK(lane_class IN ('answer_stream','main_card','replaceable_card','immutable')),
        failure_class TEXT NOT NULL CHECK(failure_class IN ('transient','permanent','unknown')),
        state TEXT NOT NULL CHECK(state IN ('active','released')), action TEXT NOT NULL, reason TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, released_at TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_lane_quarantines_state ON outbox_lane_quarantines(state, created_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (5);
    `);
  }

  private ensureIndependentReplyLanes(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 7").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database.exec(`
        UPDATE outbox_lane_quarantines
        SET lane_key = 'reply:' || failed_reply_id, updated_at = datetime('now')
        WHERE failed_reply_id IN (
          SELECT id FROM outbound_replies WHERE kind IN ('card_reply','text')
        );
        UPDATE outbound_replies
        SET lane_key = 'reply:' || id
        WHERE kind IN ('card_reply','text');
        DELETE FROM outbox_lane_heads;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT pending.lane_key, pending.id, pending.delivery_order, pending.next_attempt_at, pending.created_at
          FROM outbound_replies pending
          WHERE pending.state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = pending.lane_key AND q.state = 'active')
            AND pending.delivery_order = (
              SELECT MIN(candidate.delivery_order)
              FROM outbound_replies candidate
              WHERE candidate.state = 'pending' AND candidate.lane_key = pending.lane_key
            );
        INSERT INTO schema_migrations(version) VALUES (7);
      `);
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureCardContextOutboxLanes(): void {
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 22").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      this.context.database.exec(`
        UPDATE outbound_replies
        SET lane_key = 'worker-main:' || worker_id || ':' || worker_session_generation
        WHERE worker_id IS NOT NULL AND worker_session_generation IS NOT NULL;

        UPDATE outbound_replies
        SET lane_key = 'primary-answer:' || prompt_id || ':' || (
          SELECT binding_generation FROM run_cards WHERE run_cards.prompt_id = outbound_replies.prompt_id
        )
        WHERE kind = 'card_update' AND card_role = 'answer' AND prompt_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM run_cards WHERE run_cards.prompt_id = outbound_replies.prompt_id);

        UPDATE outbound_replies
        SET lane_key = 'primary-main:' || binding_id || ':' || (
          SELECT generation FROM bindings WHERE bindings.id = outbound_replies.binding_id
        )
        WHERE kind = 'card_update' AND target_role = 'session_status' AND binding_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM bindings WHERE bindings.id = outbound_replies.binding_id);

        UPDATE OR REPLACE outbox_lane_quarantines
        SET lane_key = (
          SELECT lane_key FROM outbound_replies WHERE outbound_replies.id = outbox_lane_quarantines.failed_reply_id
        ), updated_at = datetime('now')
        WHERE EXISTS (
          SELECT 1 FROM outbound_replies
          WHERE outbound_replies.id = outbox_lane_quarantines.failed_reply_id
            AND outbound_replies.lane_key != outbox_lane_quarantines.lane_key
        );

        DELETE FROM outbox_lane_heads;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT pending.lane_key, pending.id, pending.delivery_order, pending.next_attempt_at, pending.created_at
          FROM outbound_replies pending
          WHERE pending.state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = pending.lane_key AND q.state = 'active')
            AND pending.delivery_order = (
              SELECT MIN(candidate.delivery_order) FROM outbound_replies candidate
              WHERE candidate.state = 'pending' AND candidate.lane_key = pending.lane_key
            );
        INSERT INTO schema_migrations(version) VALUES (22);
      `);
      this.context.database.exec("COMMIT");
    } catch (error) { if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK"); throw error; }
  }

  private ensureOutboundFailureMetadata(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("failure_class")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN failure_class TEXT CHECK(failure_class IN ('transient','permanent','unknown'))");
    if (!names.has("http_status")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN http_status INTEGER");
    if (!names.has("lark_error_code")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN lark_error_code TEXT");
    if (!names.has("auto_recovery_count")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN auto_recovery_count INTEGER NOT NULL DEFAULT 0");
    if (!names.has("dead_lettered_at")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN dead_lettered_at TEXT");
    this.context.database.exec("CREATE INDEX IF NOT EXISTS outbound_replies_auto_recovery ON outbound_replies(state, failure_class, auto_recovery_count, dead_lettered_at)");
  }

  private ensureDualRequestCardColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("answer_message_id")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_message_id TEXT");
    if (!names.has("answer_delivered_version")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_delivered_version INTEGER NOT NULL DEFAULT 0");
  }

  private ensureRunCardAnswerState(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("answer_segments_json")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_segments_json TEXT NOT NULL DEFAULT '[]'");
    if (!names.has("answer_draft")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_draft TEXT NOT NULL DEFAULT ''");
    if (!names.has("answer_draft_transient")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN answer_draft_transient INTEGER NOT NULL DEFAULT 0");
    this.context.database.exec("UPDATE run_cards SET answer_segments_json = json_array(answer) WHERE answer <> '' AND answer_segments_json = '[]' AND answer_draft = ''");
  }

  private ensureRunCardProgressSummary(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("progress_summary_json")) this.context.database.exec(`ALTER TABLE run_cards ADD COLUMN progress_summary_json TEXT NOT NULL DEFAULT '{"total":0,"stepTotal":0,"stepDone":0}'`);
    const migrated = this.context.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get();
    if (migrated) return;
    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.context.database.prepare("SELECT prompt_id, progress_events_json FROM run_cards").all() as Array<{ prompt_id: string; progress_events_json: string }>;
      const update = this.context.database.prepare("UPDATE run_cards SET progress_events_json = ?, progress_summary_json = ? WHERE prompt_id = ?");
      for (const row of rows) {
        const events = JSON.parse(row.progress_events_json) as Array<{ kind?: unknown; state?: unknown }>;
        let stepTotal = 0; let stepDone = 0;
        for (const event of events) if (event.kind === "step") { stepTotal += 1; if (event.state === "done") stepDone += 1; }
        update.run(JSON.stringify(events.slice(-8)), JSON.stringify({ total: events.length, stepTotal, stepDone }), row.prompt_id);
      }
      this.context.database.prepare("INSERT INTO schema_migrations(version) VALUES (6)").run();
      this.context.database.exec("COMMIT");
    } catch (error) { this.context.database.exec("ROLLBACK"); throw error; }
  }

  private ensureRunCardInteractionColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("binding_generation")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN binding_generation INTEGER NOT NULL DEFAULT 1");
    if (!names.has("conversion_parent_prompt_id")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN conversion_parent_prompt_id TEXT");
  }

  private ensureRunCardRequestText(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "request_text")) {
      this.context.database.exec("ALTER TABLE run_cards ADD COLUMN request_text TEXT NOT NULL DEFAULT ''");
    }
    this.context.database.exec("UPDATE run_cards SET request_text = COALESCE((SELECT body FROM prompt_jobs WHERE prompt_jobs.id = run_cards.prompt_id), '') WHERE request_text = ''");
  }

  private ensureRunCardSpaceName(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "space_name")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN space_name TEXT NOT NULL DEFAULT 'unknown'");
  }

  private ensureRunCardSessionTitle(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "session_title")) this.context.database.exec("ALTER TABLE run_cards ADD COLUMN session_title TEXT");
  }

  private recreateRunCardsView(): void {
    this.context.database.exec(`
      DROP VIEW IF EXISTS run_cards_view;
      CREATE VIEW run_cards_view AS SELECT *, json_object(
        'promptId', prompt_id, 'bindingId', binding_id, 'bindingGeneration', binding_generation, 'conversionParentPromptId', conversion_parent_prompt_id, 'queueFeedback', CASE WHEN queue_feedback_json IS NULL THEN NULL ELSE json(queue_feedback_json) END, 'larkMessageId', lark_message_id, 'answerMessageId', answer_message_id, 'answerCardId', answer_card_id, 'answerElementId', answer_element_id, 'answerSequence', answer_sequence, 'answerPageIndex', answer_page_index, 'answerPageStart', answer_page_start, 'phase', phase, 'title', title, 'sessionTitle', session_title, 'requestText', request_text,
        'workspaceId', workspace_id, 'spaceName', space_name, 'paneId', pane_id, 'answer', answer, 'answerSegments', json(answer_segments_json), 'answerDraft', answer_draft, 'answerDraftTransient', CASE WHEN answer_draft_transient = 1 THEN json('true') ELSE json('false') END, 'progressEvents', json(progress_events_json), 'progressSummary', json(progress_summary_json),
        'queuePosition', queue_position, 'startedAt', started_at, 'finishedAt', finished_at, 'notice', notice, 'workerActivity', json(worker_activity_json), 'workerDependencyRevision', worker_dependency_revision, 'workerContextFrozenAt', worker_context_frozen_at, 'activityAt', activity_at,
        'viewVersion', view_version, 'deliveredVersion', delivered_version, 'answerDeliveredVersion', answer_delivered_version, 'createdAt', created_at, 'updatedAt', updated_at
      ) AS state_json FROM run_cards;
    `);
  }

  private runCardViewNeedsRebuild(): boolean {
    const view = this.context.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'run_cards_view'").get();
    if (!view) return true;
    const columns = new Set((this.context.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map((column) => column.name));
    return [
      "binding_generation", "conversion_parent_prompt_id", "queue_feedback_json",
      "answer_message_id", "answer_card_id", "answer_element_id", "answer_sequence", "answer_page_index", "answer_page_start",
      "request_text", "space_name", "session_title", "answer_segments_json", "answer_draft", "answer_draft_transient", "progress_summary_json", "worker_activity_json", "worker_dependency_revision", "worker_context_frozen_at", "activity_at", "answer_delivered_version"
    ].some((column) => !columns.has(column));
  }

  private ensureOutboundReplyColumns(): void {
    const columns = this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (names.has("binding_id") && names.has("next_attempt_at")) return;
    this.context.database.exec(`
      BEGIN;
      ALTER TABLE outbound_replies RENAME TO outbound_replies_legacy;
      CREATE TABLE outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter')), attempt_count INTEGER NOT NULL DEFAULT 0,
        error TEXT, delivered_message_id TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO outbound_replies(id, idempotency_key, binding_id, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, next_attempt_at, created_at, updated_at)
      SELECT id, idempotency_key, NULL, root_message_id, CASE kind WHEN 'card' THEN 'card_reply' ELSE kind END, payload, state, attempt_count, error, delivered_message_id, updated_at, created_at, updated_at
      FROM outbound_replies_legacy;
      DROP TABLE outbound_replies_legacy;
      CREATE INDEX IF NOT EXISTS outbound_replies_pending ON outbound_replies(state, next_attempt_at, created_at);
      COMMIT;
    `);
  }

  private ensureTypedDeliveryIntents(): void {
    const names = new Set((this.context.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name));
    if (!names.has("intent_kind")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN intent_kind TEXT");
    if (!names.has("intent_json")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN intent_json TEXT");
    if (!names.has("renderer_revision")) this.context.database.exec("ALTER TABLE outbound_replies ADD COLUMN renderer_revision INTEGER");
    this.context.database.exec(`
      CREATE TRIGGER IF NOT EXISTS outbound_replies_typed_intent_insert AFTER INSERT ON outbound_replies WHEN NEW.intent_json IS NULL BEGIN
        UPDATE outbound_replies SET intent_kind = CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, intent_json = json_object('schemaVersion', 1, 'kind', CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, 'materializedPayload', NEW.payload), renderer_revision = 1 WHERE id = NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS outbound_replies_typed_intent_payload_update AFTER UPDATE OF payload ON outbound_replies BEGIN
        UPDATE outbound_replies SET intent_kind = CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, intent_json = json_object('schemaVersion', 1, 'kind', CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, 'materializedPayload', NEW.payload), renderer_revision = 1 WHERE id = NEW.id;
      END;
    `);
    this.context.database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (29)").run();
  }
}

function now(): string { return new Date().toISOString(); }
