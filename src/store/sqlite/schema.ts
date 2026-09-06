import type { SqliteContext } from "./context.js";

export function createLatestSchema(context: SqliteContext): void {
  context.database.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS instance_lease(
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1), owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL,
    expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bindings(
    id TEXT PRIMARY KEY, creator_open_id TEXT, project_id TEXT, workspace_id TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id TEXT UNIQUE,
    root_message_id TEXT, retired_topic_id TEXT, retired_root_message_id TEXT, replaces_binding_id TEXT REFERENCES bindings(id), reserved_topic_id TEXT, reserved_root_message_id TEXT, reset_message_id TEXT, pane_id TEXT UNIQUE, traex_session_id TEXT, agent_session_source TEXT, agent_session_agent TEXT, agent_session_kind TEXT CHECK(agent_session_kind IN ('id','path')), agent_session_value TEXT, title TEXT NOT NULL,
    runtime TEXT NOT NULL CHECK(runtime = 'traex'),
    state TEXT NOT NULL CHECK(state IN ('pending','active','archived','orphaned','failed')),
    status_message_id TEXT, status_card_sequence INTEGER NOT NULL DEFAULT 0,
    last_agent_state TEXT NOT NULL CHECK(last_agent_state IN ('idle','working','blocked','done','unknown')),
    last_output_fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_instances(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('primary','worker')),
    agent_kind TEXT NOT NULL CHECK(agent_kind IN ('pi','claude-code','codex','traex')), model TEXT, source_primary_pane_label TEXT, parent_binding_id TEXT, parent_binding_generation INTEGER, parent_pane_id TEXT, parent_native_session_id TEXT, worker_session_lifecycle TEXT CHECK(worker_session_lifecycle IN ('active','legacy','terminated')), worker_session_generation INTEGER NOT NULL DEFAULT 1,
    desired_state TEXT NOT NULL CHECK(desired_state IN ('running','stopped')),
    observed_state TEXT NOT NULL CHECK(observed_state IN ('unprovisioned','starting','idle','working','blocked','detached','stopped','failed')),
    workspace_lease_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 1, herdr_workspace_id TEXT, pane_id TEXT UNIQUE, native_session_id TEXT,
    provisioning_checkpoint TEXT NOT NULL DEFAULT 'recorded', last_error TEXT, pending_herdr_workspace_id TEXT, pending_pane_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_instances_project_primary ON agent_instances(project_id) WHERE role = 'primary';
  CREATE INDEX IF NOT EXISTS agent_instances_project_state ON agent_instances(project_id, observed_state, created_at);
  CREATE TABLE IF NOT EXISTS workspace_leases(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, instance_id TEXT NOT NULL UNIQUE REFERENCES agent_instances(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN ('main-checkout','git-worktree','shared-read-only')), cwd TEXT NOT NULL, branch TEXT, base_commit TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('allocating','ready','dirty','committed','conflicted','release-requested','retained','released')),
    generation INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS instance_removal_plans(
    id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, instance_generation INTEGER NOT NULL, workspace_generation INTEGER NOT NULL,
    worktree_fingerprint TEXT, safe INTEGER NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','consumed','stale')), created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS instance_turns(
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, instance_generation INTEGER NOT NULL, actor_json TEXT NOT NULL,
    actor_kind TEXT CHECK(actor_kind IN ('human','thread-primary')), source_binding_id TEXT, source_binding_generation INTEGER, source_parent_prompt_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('turn','followup')), priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','priority')), text TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','claimed','dispatching','running','blocked','completed','failed','cancelled','dispatch-uncertain')), result TEXT, error TEXT,
    parent_turn_id TEXT REFERENCES instance_turns(id), source_message_id TEXT, runtime_turn_id TEXT, runtime_turn_started_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS instance_turns_queue ON instance_turns(instance_id, state, created_at);
  CREATE INDEX IF NOT EXISTS instance_turns_observable ON instance_turns(created_at, id) WHERE state IN ('dispatching','running','blocked','dispatch-uncertain');
  CREATE INDEX IF NOT EXISTS instance_turns_instance_history ON instance_turns(instance_id, created_at, id);
  CREATE TABLE IF NOT EXISTS worker_turn_cards(
    turn_id TEXT PRIMARY KEY REFERENCES instance_turns(id) ON DELETE CASCADE, instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, instance_generation INTEGER NOT NULL, worker_session_generation INTEGER NOT NULL DEFAULT 1, worker_name TEXT NOT NULL, parent_turn_id TEXT, root_message_id TEXT NOT NULL,
    message_id TEXT UNIQUE, card_id TEXT, element_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('queued','preparing','running','blocked','completed','failed','cancelled','dispatch-uncertain')), request_text TEXT NOT NULL, answer TEXT NOT NULL, status_title TEXT, progress_json TEXT NOT NULL DEFAULT '[]', queue_position INTEGER NOT NULL,
    started_at TEXT, finished_at TEXT, notice TEXT, result_capture TEXT NOT NULL CHECK(result_capture IN ('pending','captured','unavailable')), page_index INTEGER NOT NULL, page_start INTEGER NOT NULL, sequence INTEGER NOT NULL, view_version INTEGER NOT NULL, delivered_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worker_turn_card_pages(
    id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES instance_turns(id) ON DELETE CASCADE, page_index INTEGER NOT NULL, page_start INTEGER NOT NULL, element_id TEXT NOT NULL, message_id TEXT UNIQUE, card_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','finished')), sequence INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(turn_id, page_index)
  );
  CREATE TABLE IF NOT EXISTS instance_operations(
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, instance_generation INTEGER NOT NULL, actor_json TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('steer','interrupt')), payload TEXT, state TEXT NOT NULL CHECK(state IN ('accepted','running','succeeded','rejected','failed')), result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS instance_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, turn_id TEXT REFERENCES instance_turns(id) ON DELETE SET NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS instance_events_instance_id ON instance_events(instance_id, id);
  CREATE TABLE IF NOT EXISTS primary_tool_capabilities(
    binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE, binding_generation INTEGER NOT NULL, capability_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(binding_id, binding_generation)
  );
  CREATE TABLE IF NOT EXISTS worker_card_display_requests(
    id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE, binding_generation INTEGER NOT NULL,
    parent_prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id) ON DELETE CASCADE, idempotency_key TEXT NOT NULL,
    worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, worker_session_generation INTEGER NOT NULL, worker_name TEXT NOT NULL,
    receipt_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(binding_id, binding_generation, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS approval_requests(
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, instance_generation INTEGER NOT NULL,
    action_fingerprint TEXT NOT NULL, resource_scope TEXT NOT NULL, policy_version TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier = 'remote-confirmation'),
    state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','expired')), expires_at TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS approval_grants(
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id) ON DELETE CASCADE, actor_id TEXT NOT NULL, project_id TEXT NOT NULL, instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, instance_generation INTEGER NOT NULL,
    action_fingerprint TEXT NOT NULL, resource_scope TEXT NOT NULL, policy_version TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation_targets(
    chat_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('primary','instance')), instance_id TEXT, instance_generation INTEGER, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inbound_messages(
    event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('received','processing','accepted')), error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS inbound_messages_pending ON inbound_messages(state, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_message_id ON inbound_messages(message_id);
  CREATE TABLE IF NOT EXISTS bridge_messages(message_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS card_interactions(
    id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL, actor_open_id TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK(action_kind IN ('supplement','convert_queued_prompt','enqueue_failed_steering','more_actions','session_control')),
    parent_prompt_id TEXT, target_prompt_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','claimed','consumed','expired')),
    expires_at TEXT NOT NULL, result_code TEXT, created_at TEXT NOT NULL, claimed_at TEXT, consumed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS card_interactions_expiry ON card_interactions(state, expires_at);
  CREATE TABLE IF NOT EXISTS swarm_command_intents(
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, lane_key TEXT NOT NULL, command_json TEXT NOT NULL, context_json TEXT NOT NULL,
    replay_policy TEXT NOT NULL CHECK(replay_policy IN ('safe-before-effect','reconcilable','non-replayable')),
    state TEXT NOT NULL CHECK(state IN ('accepted','executing','succeeded','rejected','failed','uncertain')), attempt_count INTEGER NOT NULL DEFAULT 0,
    outcome_json TEXT, claimed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS swarm_command_intents_claim ON swarm_command_intents(state, lane_key, created_at);
  CREATE INDEX IF NOT EXISTS swarm_command_intents_recovery ON swarm_command_intents(state, updated_at);
  CREATE TABLE IF NOT EXISTS prompt_jobs(
    id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE NOT NULL,
    actor_open_id TEXT NOT NULL, body TEXT NOT NULL, execution_origin TEXT NOT NULL DEFAULT 'bridge' CHECK(execution_origin IN ('bridge','herdr')), dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering')), priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','priority')), parent_prompt_id TEXT,
    steering_origin TEXT CHECK(steering_origin IN ('explicit','automatic','converted')), source_prompt_id TEXT REFERENCES prompt_jobs(id), was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1)),
    dispatched_at TEXT, transcript_turn_id TEXT, transcript_turn_started_at TEXT, model_name TEXT, model_revision INTEGER CHECK(model_revision IS NULL OR model_revision >= 0),
    state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed','cancelled')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
    attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS prompt_jobs_queue ON prompt_jobs(binding_id, state, created_at);
  CREATE INDEX IF NOT EXISTS prompt_jobs_queue_kind ON prompt_jobs(binding_id, state, dispatch_kind, created_at);
  CREATE TABLE IF NOT EXISTS binding_model_preferences(
    binding_id TEXT PRIMARY KEY REFERENCES bindings(id), binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
    desired_model TEXT NOT NULL CHECK(length(desired_model) > 0), desired_revision INTEGER NOT NULL CHECK(desired_revision >= 1),
    effective_model TEXT, effective_revision INTEGER CHECK(effective_revision IS NULL OR effective_revision >= 1),
    state TEXT NOT NULL CHECK(state IN ('pending','applying','effective','uncertain')),
    dispatch_prompt_id TEXT UNIQUE REFERENCES prompt_jobs(id), prepared_operation_id TEXT, updated_at TEXT NOT NULL,
    CHECK((state = 'pending' AND dispatch_prompt_id IS NULL) OR state != 'pending')
  );
  CREATE TABLE IF NOT EXISTS outbound_replies(
    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, worker_turn_id TEXT REFERENCES instance_turns(id) ON DELETE CASCADE, worker_id TEXT REFERENCES agent_instances(id) ON DELETE CASCADE, worker_session_generation INTEGER, view_version INTEGER, card_sequence INTEGER, selection_id TEXT, stream_page_index INTEGER, stream_element_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), target_role TEXT CHECK(target_role IN ('session_status','operation_result')), root_message_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL, intent_kind TEXT, intent_json TEXT, renderer_revision INTEGER,
    state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0,
    error TEXT, delivered_message_id TEXT, card_id_checkpoint TEXT, delivery_order INTEGER, lane_key TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    failure_class TEXT CHECK(failure_class IN ('transient','permanent','unknown')), http_status INTEGER, lark_error_code TEXT, auto_recovery_count INTEGER NOT NULL DEFAULT 0, dead_lettered_at TEXT
  );
  CREATE TRIGGER IF NOT EXISTS outbound_replies_typed_intent_insert
  AFTER INSERT ON outbound_replies
  WHEN NEW.intent_json IS NULL
  BEGIN
    UPDATE outbound_replies SET
      intent_kind = CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END,
      intent_json = json_object('schemaVersion', 1, 'kind', CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, 'materializedPayload', NEW.payload),
      renderer_revision = 1
    WHERE id = NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS outbound_replies_typed_intent_payload_update
  AFTER UPDATE OF payload ON outbound_replies
  BEGIN
    UPDATE outbound_replies SET
      intent_kind = CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END,
      intent_json = json_object('schemaVersion', 1, 'kind', CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END, 'materializedPayload', NEW.payload),
      renderer_revision = 1
    WHERE id = NEW.id;
  END;
  CREATE INDEX IF NOT EXISTS outbound_replies_pending ON outbound_replies(state, created_at);
  CREATE TABLE IF NOT EXISTS project_selections(
    id TEXT PRIMARY KEY, command_message_id TEXT UNIQUE NOT NULL, selector_message_id TEXT, chat_id TEXT NOT NULL, topic_id TEXT, root_message_id TEXT NOT NULL, actor_open_id TEXT NOT NULL,
    requested_title TEXT, initial_prompt_text TEXT, selected_project_id TEXT, binding_id TEXT REFERENCES bindings(id), state TEXT NOT NULL CHECK(state IN ('pending','processing','completed','failed','expired')),
    error TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pane_close_requests(
    id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), pane_id TEXT NOT NULL, actor_open_id TEXT NOT NULL, code_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','consumed','executing','succeeded','rejected','uncertain','expired','cancelled')), detail TEXT, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pane_close_requests_binding_state ON pane_close_requests(binding_id, state, created_at);
  CREATE TABLE IF NOT EXISTS worker_pane_close_steps(
    operation_id TEXT NOT NULL REFERENCES pane_close_requests(id) ON DELETE CASCADE, binding_id TEXT NOT NULL, parent_pane_id TEXT NOT NULL, worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, pane_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('executing','succeeded','uncertain')), detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(operation_id, worker_id, pane_id)
  );
  CREATE INDEX IF NOT EXISTS worker_pane_close_steps_unresolved ON worker_pane_close_steps(state, created_at);
  CREATE TABLE IF NOT EXISTS pane_control_operations(
    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT NOT NULL REFERENCES bindings(id), pane_id TEXT NOT NULL, terminal_id TEXT, binding_generation INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('stop','steer','model')), payload TEXT, parent_prompt_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('accepted','running','applied','confirmed','rejected','failed','uncertain')), attempt_count INTEGER NOT NULL DEFAULT 0, detail TEXT,
    actor_open_id TEXT NOT NULL, source_message_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pane_control_operations_claim ON pane_control_operations(state, binding_id, kind, created_at);
  CREATE INDEX IF NOT EXISTS pane_control_operations_recovery ON pane_control_operations(state, updated_at);
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
  CREATE TABLE IF NOT EXISTS retired_pane_cleanup_operations(
    id TEXT PRIMARY KEY, old_binding_id TEXT NOT NULL UNIQUE REFERENCES bindings(id), replacement_binding_id TEXT NOT NULL REFERENCES bindings(id),
    pane_id TEXT NOT NULL, expected_workspace_id TEXT NOT NULL, expected_project_id TEXT NOT NULL, expected_cwd TEXT NOT NULL, expected_terminal_id TEXT NOT NULL, actor_open_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','waiting_busy','executing','succeeded','retained')), attempt_count INTEGER NOT NULL DEFAULT 0, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS retired_pane_cleanup_state_created ON retired_pane_cleanup_operations(state, created_at, id);
  CREATE TABLE IF NOT EXISTS audit_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_open_id TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lifecycle_events(
    event_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS topic_views(
    binding_id TEXT PRIMARY KEY REFERENCES bindings(id), state_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_cards(
    prompt_id TEXT PRIMARY KEY REFERENCES prompt_jobs(id), binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL DEFAULT 1, conversion_parent_prompt_id TEXT, steering_origin TEXT CHECK(steering_origin IN ('explicit','automatic','converted')), steering_failure_kind TEXT CHECK(steering_failure_kind IN ('rejected','uncertain')), queue_feedback_json TEXT, lark_message_id TEXT, answer_message_id TEXT, answer_card_id TEXT, answer_element_id TEXT NOT NULL DEFAULT '', answer_sequence INTEGER NOT NULL DEFAULT 0, answer_page_index INTEGER NOT NULL DEFAULT 0, answer_page_start INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL CHECK(phase IN ('queued','running','blocked','completed','failed')), title TEXT NOT NULL, session_title TEXT, request_text TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL, space_name TEXT NOT NULL DEFAULT 'unknown', pane_id TEXT,
    answer TEXT NOT NULL, answer_segments_json TEXT NOT NULL DEFAULT '[]', answer_draft TEXT NOT NULL DEFAULT '', answer_draft_transient INTEGER NOT NULL DEFAULT 0, progress_events_json TEXT NOT NULL, progress_summary_json TEXT NOT NULL DEFAULT '{"total":0,"stepTotal":0,"stepDone":0}', queue_position INTEGER NOT NULL, started_at TEXT, finished_at TEXT, notice TEXT, worker_activity_json TEXT NOT NULL DEFAULT '[]', worker_dependency_revision INTEGER NOT NULL DEFAULT 0, worker_context_frozen_at TEXT, activity_at TEXT NOT NULL,
    view_version INTEGER NOT NULL, delivered_version INTEGER NOT NULL, answer_delivered_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS run_cards_binding ON run_cards(binding_id, created_at);
  CREATE TABLE IF NOT EXISTS answer_pages(
    prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id), page_index INTEGER NOT NULL, message_id TEXT, card_id TEXT, element_id TEXT NOT NULL,
    source_start INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN ('creating','active','frozen','finished')), delivery_mode TEXT NOT NULL DEFAULT 'streaming' CHECK(delivery_mode IN ('streaming','static')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(prompt_id, page_index)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS answer_pages_active ON answer_pages(prompt_id) WHERE state = 'active';
  INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);

  `);
}

