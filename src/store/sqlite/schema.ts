import type { SqliteContext } from "./context.js";
import type { DatabaseSync } from "node:sqlite";
import { createConversationSegmentSchema } from "./migrations/conversation-segment-migrations.js";

export function createInstanceLeaseSchema(context: SqliteContext): void {
  context.database.exec(`
  CREATE TABLE IF NOT EXISTS instance_lease(
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1), owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL,
    expires_at TEXT NOT NULL, expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0), updated_at TEXT NOT NULL
  );
  `);
}

export function createRuntimeIdentityClaimSchema(database: DatabaseSync, includeCurrentIdentityIndex = true): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_identity_claims(
      binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
      binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1), session_epoch INTEGER NOT NULL CHECK(session_epoch >= 1),
      state TEXT NOT NULL CHECK(state IN ('current','unclaimed','conflicted','released')),
      native_session_source TEXT, native_session_agent TEXT, native_session_kind TEXT CHECK(native_session_kind IN ('id','path')), native_session_value TEXT,
      attachment_state TEXT CHECK(attachment_state IN ('attached','orphaned')),
      workspace_id TEXT, pane_id TEXT, terminal_id TEXT,
      last_rejected_evidence_fingerprint TEXT, last_rejected_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(binding_id,binding_generation,session_epoch),
      CHECK((native_session_source IS NULL AND native_session_agent IS NULL AND native_session_kind IS NULL AND native_session_value IS NULL)
        OR (native_session_source IS NOT NULL AND native_session_agent IS NOT NULL AND native_session_kind IS NOT NULL AND native_session_value IS NOT NULL)),
      CHECK(state <> 'current' OR (native_session_source IS NOT NULL AND attachment_state IS NOT NULL AND workspace_id IS NOT NULL AND pane_id IS NOT NULL AND terminal_id IS NOT NULL)),
      CHECK(state <> 'unclaimed' OR (native_session_source IS NULL AND attachment_state IS NULL AND workspace_id IS NULL AND pane_id IS NULL AND terminal_id IS NULL))
    );
  `);
  if (includeCurrentIdentityIndex) database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS runtime_identity_claims_current_native_identity
    ON runtime_identity_claims(native_session_source,native_session_agent,native_session_kind,native_session_value)
    WHERE state = 'current'`);
}

export function createLatestSchema(context: SqliteContext): void {
  // Schema declarations are intentionally kept in dependency order.
  createInstanceLeaseSchema(context);
  context.database.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS answer_timeline_items(
    aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('primary-run','worker-turn')), aggregate_id TEXT NOT NULL, item_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence >= 0), item_json TEXT NOT NULL CHECK(json_valid(item_json)), payload_compacted_at TEXT,
    PRIMARY KEY(aggregate_kind, aggregate_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS answer_timeline_items_order ON answer_timeline_items(aggregate_kind, aggregate_id, sequence, item_id);
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
  CREATE TABLE IF NOT EXISTS bindings(
    id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','orchestrator')), gateway_id TEXT NOT NULL DEFAULT 'feishu:primary', creator_open_id TEXT, project_id TEXT, workspace_id TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id TEXT UNIQUE,
    root_message_id TEXT, retired_topic_id TEXT, retired_root_message_id TEXT, replaces_binding_id TEXT REFERENCES bindings(id), reserved_topic_id TEXT, reserved_root_message_id TEXT, reset_message_id TEXT, pane_id TEXT UNIQUE, pane_token TEXT, traex_session_id TEXT, agent_session_source TEXT, agent_session_agent TEXT, agent_session_kind TEXT CHECK(agent_session_kind IN ('id','path')), agent_session_value TEXT, title TEXT NOT NULL,
    runtime TEXT NOT NULL CHECK(runtime = 'traex'), agent_kind TEXT NOT NULL DEFAULT 'traex' CHECK(agent_kind IN ('pi','claude-code','codex','traex')),
    state TEXT NOT NULL CHECK(state IN ('pending','active','archived','orphaned','failed')),
    status_message_id TEXT, status_card_sequence INTEGER NOT NULL DEFAULT 0,
    last_agent_state TEXT NOT NULL CHECK(last_agent_state IN ('idle','working','blocked','done','unknown')),
    last_output_fingerprint TEXT, session_epoch INTEGER NOT NULL DEFAULT 1 CHECK(session_epoch >= 1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS binding_thread_aliases(
    id TEXT PRIMARY KEY, publication_key TEXT NOT NULL UNIQUE, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL, chat_id TEXT NOT NULL, pane_id TEXT NOT NULL, source_main_message_id TEXT NOT NULL, action_message_id TEXT NOT NULL, topic_id TEXT UNIQUE, root_message_id TEXT UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('reserving','active','stale')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK((state = 'reserving' AND topic_id IS NULL AND root_message_id IS NULL) OR (state IN ('active','stale') AND topic_id IS NOT NULL AND root_message_id IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS binding_thread_aliases_binding ON binding_thread_aliases(binding_id, binding_generation, state);
  CREATE TABLE IF NOT EXISTS agent_instances(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('primary','worker')),
    agent_kind TEXT NOT NULL CHECK(agent_kind IN ('pi','claude-code','codex','traex')), model TEXT, source_primary_pane_label TEXT, parent_binding_id TEXT, parent_binding_generation INTEGER, parent_pane_id TEXT, parent_native_session_id TEXT, worker_session_lifecycle TEXT CHECK(worker_session_lifecycle IN ('active','legacy','terminated')), worker_session_generation INTEGER NOT NULL DEFAULT 1,
    desired_state TEXT NOT NULL CHECK(desired_state IN ('running','stopped')),
    observed_state TEXT NOT NULL CHECK(observed_state IN ('unprovisioned','starting','idle','working','blocked','detached','stopped','failed')),
    workspace_lease_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 1, herdr_workspace_id TEXT, pane_id TEXT UNIQUE, pane_token TEXT, native_session_id TEXT,
    provisioning_checkpoint TEXT NOT NULL DEFAULT 'recorded', last_error TEXT, pending_herdr_workspace_id TEXT, pending_pane_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS agent_instances_project_primary ON agent_instances(project_id) WHERE role = 'primary';
  CREATE INDEX IF NOT EXISTS agent_instances_project_state ON agent_instances(project_id, observed_state, created_at);
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
  CREATE TABLE IF NOT EXISTS worker_thread_entry_requests(
    command_intent_id TEXT PRIMARY KEY REFERENCES swarm_command_intents(id) ON DELETE CASCADE, worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, worker_session_generation INTEGER NOT NULL,
    binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE, binding_generation INTEGER NOT NULL, root_message_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','reserved','stale')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS worker_thread_entry_requests_pending ON worker_thread_entry_requests(worker_id, worker_session_generation, state);
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
    parent_turn_id TEXT REFERENCES instance_turns(id), source_message_id TEXT, runtime_turn_id TEXT, runtime_turn_started_at TEXT,
    canonical_segment_id TEXT, canonical_submission_id TEXT, canonical_agent_kind TEXT CHECK(canonical_agent_kind IN ('traex','pi')),
    canonical_expected_session_id TEXT, canonical_root_message_id TEXT, canonical_gateway_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS instance_turns_queue ON instance_turns(instance_id, state, created_at);
  CREATE INDEX IF NOT EXISTS instance_turns_observable ON instance_turns(created_at, id) WHERE state IN ('dispatching','running','blocked','dispatch-uncertain');
  CREATE INDEX IF NOT EXISTS instance_turns_instance_history ON instance_turns(instance_id, created_at, id);
  CREATE TABLE IF NOT EXISTS worker_turn_cards(
    turn_id TEXT PRIMARY KEY REFERENCES instance_turns(id) ON DELETE CASCADE, instance_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, instance_generation INTEGER NOT NULL, worker_session_generation INTEGER NOT NULL DEFAULT 1, worker_name TEXT NOT NULL, parent_turn_id TEXT, root_message_id TEXT NOT NULL,
    message_id TEXT UNIQUE, card_id TEXT, element_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('queued','preparing','running','blocked','completed','failed','cancelled','dispatch-uncertain')), request_text TEXT NOT NULL, answer TEXT NOT NULL, status_title TEXT, token_count INTEGER, progress_json TEXT NOT NULL DEFAULT '[]', queue_position INTEGER NOT NULL,
    started_at TEXT, finished_at TEXT, notice TEXT, result_capture TEXT NOT NULL CHECK(result_capture IN ('pending','captured','unavailable')), page_index INTEGER NOT NULL, page_start INTEGER NOT NULL, sequence INTEGER NOT NULL, view_version INTEGER NOT NULL, delivered_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worker_turn_card_pages(
    id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES instance_turns(id) ON DELETE CASCADE, page_index INTEGER NOT NULL, segment_index INTEGER NOT NULL DEFAULT 0, page_start INTEGER NOT NULL, element_id TEXT NOT NULL, message_id TEXT UNIQUE, card_id TEXT, delivery_mode TEXT NOT NULL DEFAULT 'streaming' CHECK(delivery_mode IN ('streaming')), state TEXT NOT NULL CHECK(state IN ('active','finished')), sequence INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(turn_id, page_index)
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
    event_id TEXT PRIMARY KEY, gateway_id TEXT NOT NULL DEFAULT 'feishu:primary', message_id TEXT NOT NULL, payload_json TEXT NOT NULL, scope_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('received','processing','accepted')), error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS inbound_messages_pending ON inbound_messages(state, scope_key, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_message_id ON inbound_messages(message_id);
  CREATE TABLE IF NOT EXISTS bridge_messages(message_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS card_interactions(
    id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL, actor_open_id TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK(action_kind IN ('supplement','more_actions','session_control','continuation')),
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
  CREATE TABLE IF NOT EXISTS submission_intents(
    submission_id TEXT PRIMARY KEY, ingress_source TEXT NOT NULL, source_message_key TEXT NOT NULL,
    actor_json TEXT NOT NULL CHECK(json_valid(actor_json)), input_json TEXT NOT NULL DEFAULT '{"schemaVersion":2,"text":""}' CHECK(json_valid(input_json)), text TEXT NOT NULL,
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
  CREATE INDEX IF NOT EXISTS submission_intents_owner ON submission_intents(owner_kind, owner_id, owner_generation, submission_id);
  CREATE TABLE IF NOT EXISTS input_card_views(
    submission_id TEXT PRIMARY KEY REFERENCES submission_intents(submission_id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK(state IN ('pending','working')), root_message_id TEXT NOT NULL,
    message_id TEXT, card_id TEXT, card_json TEXT NOT NULL CHECK(json_valid(card_json)),
    working_card_json TEXT NOT NULL CHECK(json_valid(working_card_json)), observed_event_id TEXT UNIQUE,
    revision INTEGER NOT NULL CHECK(revision >= 1), delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK(delivered_revision >= 0),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS input_card_views_state ON input_card_views(state, updated_at);
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
  CREATE TABLE IF NOT EXISTS command_status_views(
    intent_id TEXT PRIMARY KEY REFERENCES swarm_command_intents(id) ON DELETE CASCADE, command_kind TEXT NOT NULL, summary TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('literal','natural-language','card','primary-tool')),
    actor_open_id TEXT NOT NULL, lane_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('accepted','executing','succeeded','rejected','failed','uncertain')), attempt_count INTEGER NOT NULL DEFAULT 0, outcome_json TEXT,
    message_id TEXT, card_id TEXT, card_json TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision >= 1), delivered_revision INTEGER NOT NULL DEFAULT 0 CHECK(delivered_revision >= 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS command_status_views_state ON command_status_views(state, updated_at);
  CREATE TABLE IF NOT EXISTS natural_language_command_confirmations(
    id TEXT PRIMARY KEY, source_message_id TEXT NOT NULL UNIQUE, actor_open_id TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id TEXT, root_message_id TEXT NOT NULL,
    command_json TEXT NOT NULL, frozen_target_json TEXT, expected_binding_id TEXT, expected_binding_generation INTEGER, expected_instance_id TEXT, expected_instance_generation INTEGER,
    state TEXT NOT NULL CHECK(state IN ('pending','consumed','expired','cancelled')), expires_at TEXT NOT NULL, result_detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT,
    CHECK((expected_binding_id IS NULL) = (expected_binding_generation IS NULL)),
    CHECK((expected_instance_id IS NULL) = (expected_instance_generation IS NULL)),
    CHECK(state != 'pending' OR frozen_target_json IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS natural_language_command_confirmations_pending ON natural_language_command_confirmations(state, expires_at, created_at);
  CREATE TABLE IF NOT EXISTS controller_interpretation_jobs(
    id TEXT PRIMARY KEY, source_message_id TEXT NOT NULL UNIQUE, message_json TEXT NOT NULL, controller_generation INTEGER NOT NULL, capability_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('accepted','dispatching','observing','succeeded','clarification','unsupported','task','failed','uncertain')), result_json TEXT, runtime_turn_id TEXT, dispatched_at TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS controller_interpretation_jobs_queue ON controller_interpretation_jobs(state, created_at);
  CREATE TABLE IF NOT EXISTS controller_runtime(
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), generation INTEGER NOT NULL, pane_id TEXT NOT NULL, terminal_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','stale')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prompt_jobs(
    id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), session_epoch INTEGER NOT NULL DEFAULT 1 CHECK(session_epoch >= 1), lark_message_id TEXT UNIQUE,
    ingress_source TEXT CHECK(ingress_source IN ('feishu','herdr','internal')), source_message_key TEXT,
    actor_open_id TEXT NOT NULL, body TEXT NOT NULL, parent_prompt_id TEXT REFERENCES prompt_jobs(id), execution_origin TEXT NOT NULL DEFAULT 'bridge' CHECK(execution_origin IN ('bridge','herdr')), priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('normal','priority')), was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1)),
    dispatched_at TEXT, native_submission_id TEXT UNIQUE, transcript_turn_id TEXT, transcript_turn_started_at TEXT, model_name TEXT, model_revision INTEGER CHECK(model_revision IS NULL OR model_revision >= 0),
    state TEXT NOT NULL CHECK(state IN ('queued','submitted','running','recovering','uncertain','delivered','failed','cancelled')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
    attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS prompt_jobs_queue ON prompt_jobs(binding_id, state, created_at);
  CREATE INDEX IF NOT EXISTS prompt_jobs_priority_queue ON prompt_jobs(binding_id, state, priority, created_at);
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
  CREATE TABLE IF NOT EXISTS prompt_transcript_turns(
    prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id) ON DELETE CASCADE, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
    pane_id TEXT, native_session_id TEXT, turn_id TEXT NOT NULL, started_at TEXT NOT NULL, chain_id TEXT NOT NULL, parent_turn_id TEXT,
    origin TEXT NOT NULL CHECK(origin IN ('prompt','runtime_continuation')), ordinal INTEGER NOT NULL CHECK(ordinal >= 0), created_at TEXT NOT NULL,
    PRIMARY KEY(prompt_id, turn_id), UNIQUE(binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at), UNIQUE(prompt_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS prompt_transcript_turns_chain ON prompt_transcript_turns(prompt_id, ordinal);
  CREATE TABLE IF NOT EXISTS prompt_identity_corrections(
    alias_prompt_id TEXT PRIMARY KEY, canonical_prompt_id TEXT NOT NULL,
    binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
    pane_id TEXT NOT NULL, native_session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    legacy_started_at TEXT NOT NULL, canonical_started_at TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN ('canonical_start_correction')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS prompt_identity_corrections_canonical ON prompt_identity_corrections(canonical_prompt_id, created_at);
  CREATE TABLE IF NOT EXISTS binding_model_preferences(
    binding_id TEXT PRIMARY KEY REFERENCES bindings(id), binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
    desired_model TEXT NOT NULL CHECK(length(desired_model) > 0), desired_revision INTEGER NOT NULL CHECK(desired_revision >= 1),
    effective_model TEXT, effective_revision INTEGER CHECK(effective_revision IS NULL OR effective_revision >= 1),
    state TEXT NOT NULL CHECK(state IN ('pending','applying','effective','uncertain')),
    dispatch_prompt_id TEXT UNIQUE REFERENCES prompt_jobs(id), prepared_operation_id TEXT, updated_at TEXT NOT NULL,
    CHECK((state = 'pending' AND dispatch_prompt_id IS NULL) OR state != 'pending')
  );
  CREATE TABLE IF NOT EXISTS shortcut_panels(
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('reserving','active','stale')),
    topic_id TEXT, root_message_id TEXT, card_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, activated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS outbound_replies(
    id TEXT PRIMARY KEY, gateway_id TEXT NOT NULL DEFAULT 'feishu:primary', gateway_profile_id TEXT NOT NULL DEFAULT 'feishu-cardkit-v1', gateway_plan_json TEXT, gateway_plan_hash TEXT, gateway_checkpoint_json TEXT,
    delivery_input_kind TEXT CHECK(delivery_input_kind IN ('semantic-snapshot','prepared-effect')),
    subject_kind TEXT CHECK(subject_kind IN ('conversation-page')), subject_json TEXT CHECK(subject_json IS NULL OR json_valid(subject_json)), subject_revision INTEGER CHECK(subject_revision IS NULL OR subject_revision>=1),
    presentation_snapshot_json TEXT CHECK(presentation_snapshot_json IS NULL OR json_valid(presentation_snapshot_json)), presentation_snapshot_hash TEXT CHECK(presentation_snapshot_hash IS NULL OR length(presentation_snapshot_hash)=64),
    planner_policy_version INTEGER CHECK(planner_policy_version IS NULL OR planner_policy_version>=1), renderer_policy_version INTEGER CHECK(renderer_policy_version IS NULL OR renderer_policy_version>=1), gateway_profile_version INTEGER CHECK(gateway_profile_version IS NULL OR gateway_profile_version>=1),
    preparation_state TEXT CHECK(preparation_state IN ('reserved','preparing','prepared')),
    idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, worker_turn_id TEXT REFERENCES instance_turns(id) ON DELETE CASCADE, worker_id TEXT REFERENCES agent_instances(id) ON DELETE CASCADE, worker_session_generation INTEGER, view_version INTEGER, card_sequence INTEGER, selection_id TEXT, stream_page_index INTEGER, stream_element_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), target_role TEXT CHECK(target_role IN ('session_status','operation_result')), thread_alias_id TEXT REFERENCES binding_thread_aliases(id), worker_thread_id TEXT REFERENCES worker_session_threads(id), shortcut_panel_id TEXT REFERENCES shortcut_panels(id), target_chat_id TEXT, work_class TEXT NOT NULL DEFAULT 'live' CHECK(work_class IN ('live','history')),
    scope_kind TEXT CHECK(scope_kind IN ('pane','global')), scope_key TEXT, scope_workspace_id TEXT, scope_pane_id TEXT,
    delivery_owner_kind TEXT CHECK(delivery_owner_kind IN ('primary','worker')), delivery_owner_id TEXT,
    delivery_owner_generation INTEGER, delivery_owner_session_generation INTEGER,
    delivery_parent_id TEXT, delivery_parent_generation INTEGER, delivery_parent_session_generation INTEGER,
    root_message_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','group_card_create','stream_card_create','stream_content','stream_finish','message_delete')), payload TEXT NOT NULL, payload_compacted_at TEXT, intent_kind TEXT, intent_json TEXT, renderer_revision INTEGER,
    state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0,
    error TEXT, delivered_message_id TEXT, card_id_checkpoint TEXT, delivery_order INTEGER, lane_key TEXT, conflict_key TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    failure_class TEXT CHECK(failure_class IN ('transient','permanent','unknown')), effect_certainty TEXT CHECK(effect_certainty IN ('not-started','rejected','uncertain')), http_status INTEGER, lark_error_code TEXT, auto_recovery_count INTEGER NOT NULL DEFAULT 0, dead_lettered_at TEXT, claim_expires_at TEXT,
    CHECK((kind = 'group_card_create' AND root_message_id IS NULL AND target_chat_id IS NOT NULL AND ((thread_alias_id IS NOT NULL AND worker_thread_id IS NULL AND shortcut_panel_id IS NULL) OR (thread_alias_id IS NULL AND worker_thread_id IS NOT NULL AND shortcut_panel_id IS NULL) OR (thread_alias_id IS NULL AND worker_thread_id IS NULL AND shortcut_panel_id IS NOT NULL))) OR (kind = 'card_update' AND root_message_id IS NOT NULL AND target_chat_id IS NULL AND thread_alias_id IS NOT NULL AND worker_thread_id IS NULL AND shortcut_panel_id IS NULL) OR (kind != 'group_card_create' AND root_message_id IS NOT NULL AND target_chat_id IS NULL AND thread_alias_id IS NULL AND worker_thread_id IS NULL AND shortcut_panel_id IS NULL))
  );
  CREATE TABLE IF NOT EXISTS outbound_reply_prerequisites(
    dependent_reply_id TEXT NOT NULL REFERENCES outbound_replies(id) ON DELETE CASCADE,
    prerequisite_reply_id TEXT NOT NULL REFERENCES outbound_replies(id) ON DELETE RESTRICT,
    required_state TEXT NOT NULL CHECK(required_state IN ('delivered','dismissed')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(dependent_reply_id, prerequisite_reply_id),
    CHECK(dependent_reply_id != prerequisite_reply_id)
  );
  CREATE INDEX IF NOT EXISTS outbound_reply_prerequisites_reverse ON outbound_reply_prerequisites(prerequisite_reply_id, dependent_reply_id);
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
  CREATE TABLE IF NOT EXISTS completion_action_sets(
    id TEXT PRIMARY KEY,
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('primary-prompt','worker-turn','primary-segment')),
    owner_id TEXT NOT NULL,
    owner_generation INTEGER NOT NULL CHECK(owner_generation >= 1),
    binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
    binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
    page_index INTEGER NOT NULL CHECK(page_index >= 0),
    card_id TEXT,
    card_message_id TEXT,
    mention_open_id TEXT,
    presentation_kind TEXT NOT NULL DEFAULT 'legacy-inline' CHECK(presentation_kind IN ('legacy-inline','fresh-card')),
    presentation_generation INTEGER NOT NULL DEFAULT 1 CHECK(presentation_generation >= 1),
    presentation_reply_id TEXT REFERENCES outbound_replies(id) ON DELETE SET NULL,
    presentation_message_id TEXT,
    presentation_card_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('available','provisional','presenting','active','consumed','superseded','unavailable')),
    selected_action TEXT CHECK(selected_action IN ('default','approve','continue','reject')),
    result_source_key TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    decided_at TEXT,
    UNIQUE(owner_kind, owner_id, owner_generation)
  );
  CREATE INDEX IF NOT EXISTS completion_action_sets_owner_state
    ON completion_action_sets(state, owner_kind, binding_id, binding_generation, updated_at, owner_id);
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
  CREATE TABLE IF NOT EXISTS lark_delivery_cooldowns(
    scope TEXT PRIMARY KEY CHECK(scope = 'app'), blocked_until TEXT NOT NULL,
    trigger_count INTEGER NOT NULL CHECK(trigger_count >= 1), last_http_status INTEGER, last_lark_error_code TEXT,
    last_reason TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS outbound_replies_typed_intent_insert
  AFTER INSERT ON outbound_replies
  WHEN NEW.intent_json IS NULL
  BEGIN
    UPDATE outbound_replies SET
      intent_kind = CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'group_card_create' THEN 'group-card' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END,
      intent_json = json_object('schemaVersion', 2, 'kind', CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'group_card_create' THEN 'group-card' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END),
      renderer_revision = 1
    WHERE id = NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS outbound_replies_typed_intent_payload_update
  AFTER UPDATE OF payload ON outbound_replies
  BEGIN
    UPDATE outbound_replies SET
      intent_kind = CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'group_card_create' THEN 'group-card' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END,
      intent_json = json_object('schemaVersion', 2, 'kind', CASE NEW.kind WHEN 'text' THEN 'text' WHEN 'group_card_create' THEN 'group-card' WHEN 'stream_card_create' THEN 'stream-card' WHEN 'stream_content' THEN 'stream-content' WHEN 'stream_finish' THEN 'stream-finish' ELSE 'card' END),
      renderer_revision = 1
    WHERE id = NEW.id;
  END;
  CREATE INDEX IF NOT EXISTS outbound_replies_pending ON outbound_replies(state, created_at);
  CREATE TABLE IF NOT EXISTS project_selections(
    id TEXT PRIMARY KEY, command_message_id TEXT UNIQUE NOT NULL, selector_message_id TEXT, chat_id TEXT NOT NULL, topic_id TEXT, root_message_id TEXT NOT NULL, actor_open_id TEXT NOT NULL,
    requested_title TEXT, initial_prompt_text TEXT, agent_kind TEXT NOT NULL DEFAULT 'traex' CHECK(agent_kind IN ('pi','claude-code','codex','traex')), selected_project_id TEXT, binding_id TEXT REFERENCES bindings(id), state TEXT NOT NULL CHECK(state IN ('pending','processing','completed','failed','expired')),
    error TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pane_close_requests(
    id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), pane_id TEXT NOT NULL, actor_open_id TEXT NOT NULL, code_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','consumed','executing','succeeded','rejected','uncertain','expired','cancelled')), detail TEXT, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pane_close_requests_binding_state ON pane_close_requests(binding_id, state, created_at);
  CREATE TABLE IF NOT EXISTS worker_pane_close_steps(
    operation_id TEXT NOT NULL REFERENCES pane_close_requests(id) ON DELETE CASCADE, binding_id TEXT NOT NULL, parent_pane_id TEXT NOT NULL, worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, pane_id TEXT NOT NULL, instance_generation INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('executing','succeeded','retained','uncertain')), detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(operation_id, worker_id, pane_id)
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
  CREATE TABLE IF NOT EXISTS primary_human_review_episodes(
    id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
    binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1), pane_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK(state IN ('open','resolved')), notice TEXT NOT NULL,
    requested_at TEXT NOT NULL, resolved_at TEXT,
    surface_generation INTEGER NOT NULL DEFAULT 0 CHECK(surface_generation >= 0),
    view_version INTEGER NOT NULL DEFAULT 0 CHECK(view_version >= 0),
    delivered_version INTEGER NOT NULL DEFAULT 0 CHECK(delivered_version >= 0),
    create_reply_id TEXT, message_id TEXT, card_id TEXT, card_json TEXT, updated_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS primary_human_review_open
    ON primary_human_review_episodes(binding_id, binding_generation, prompt_id) WHERE state = 'open';
  CREATE INDEX IF NOT EXISTS primary_human_review_history
    ON primary_human_review_episodes(binding_id, requested_at, id);
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
  CREATE TABLE IF NOT EXISTS human_review_candidates(
    source_event_id TEXT PRIMARY KEY REFERENCES core_event_inbox(event_id) ON DELETE CASCADE,
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('binding','worker_turn')), owner_id TEXT NOT NULL,
    owner_generation INTEGER NOT NULL CHECK(owner_generation >= 1), native_session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    notice TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','absorbed','expired')),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, absorbed_episode_id TEXT, absorbed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS human_review_candidates_pending
    ON human_review_candidates(owner_kind, owner_id, owner_generation, state, expires_at, created_at);
  CREATE TABLE IF NOT EXISTS topic_views(
    binding_id TEXT PRIMARY KEY REFERENCES bindings(id), state_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_cards(
    prompt_id TEXT PRIMARY KEY REFERENCES prompt_jobs(id), binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL DEFAULT 1, conversion_parent_prompt_id TEXT, queue_feedback_json TEXT, lark_message_id TEXT, answer_message_id TEXT, answer_card_id TEXT, answer_element_id TEXT NOT NULL DEFAULT '', answer_sequence INTEGER NOT NULL DEFAULT 0, answer_page_index INTEGER NOT NULL DEFAULT 0, answer_page_start INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL CHECK(phase IN ('queued','submitted','running','recovering','uncertain','blocked','completed','failed')), title TEXT NOT NULL, session_title TEXT, agent_kind TEXT NOT NULL DEFAULT 'traex' CHECK(agent_kind IN ('pi','claude-code','codex','traex')), request_text TEXT NOT NULL DEFAULT '', reply_context TEXT, workspace_id TEXT NOT NULL, space_name TEXT NOT NULL DEFAULT 'unknown', pane_id TEXT, pane_token TEXT,
    answer TEXT NOT NULL, answer_segments_json TEXT NOT NULL DEFAULT '[]', answer_draft TEXT NOT NULL DEFAULT '', answer_draft_transient INTEGER NOT NULL DEFAULT 0, progress_events_json TEXT NOT NULL, task_list_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(task_list_json)), task_list_title TEXT, current_goal_json TEXT CHECK(current_goal_json IS NULL OR json_valid(current_goal_json)), progress_summary_json TEXT NOT NULL DEFAULT '{"total":0,"stepTotal":0,"stepDone":0}', queue_position INTEGER NOT NULL, started_at TEXT, finished_at TEXT, notice TEXT, worker_activity_json TEXT NOT NULL DEFAULT '[]', worker_dependency_revision INTEGER NOT NULL DEFAULT 0, worker_context_frozen_at TEXT, activity_at TEXT NOT NULL,
    view_version INTEGER NOT NULL, delivered_version INTEGER NOT NULL, answer_delivered_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS run_cards_binding ON run_cards(binding_id, created_at);
  CREATE TABLE IF NOT EXISTS answer_pages(
    prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id), page_index INTEGER NOT NULL, segment_index INTEGER NOT NULL DEFAULT 0, message_id TEXT, card_id TEXT, element_id TEXT NOT NULL,
    source_start INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN ('creating','active','frozen','finished')), delivery_mode TEXT NOT NULL DEFAULT 'streaming' CHECK(delivery_mode IN ('streaming','static')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(prompt_id, page_index)
  );
  CREATE TABLE IF NOT EXISTS answer_timeline_page_checkpoints(
    aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('primary-run','worker-turn')), aggregate_id TEXT NOT NULL, page_index INTEGER NOT NULL,
    start_cursor_json TEXT NOT NULL CHECK(json_valid(start_cursor_json)), delivered_cursor_json TEXT CHECK(delivered_cursor_json IS NULL OR json_valid(delivered_cursor_json)),
    delivered_items_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(delivered_items_json)), pending_reply_id TEXT REFERENCES outbound_replies(id) ON DELETE SET NULL,
    pending_cursor_json TEXT CHECK(pending_cursor_json IS NULL OR json_valid(pending_cursor_json)), pending_items_json TEXT CHECK(pending_items_json IS NULL OR json_valid(pending_items_json)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(aggregate_kind, aggregate_id, page_index)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS answer_timeline_page_pending_reply ON answer_timeline_page_checkpoints(pending_reply_id) WHERE pending_reply_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS answer_pages_active ON answer_pages(prompt_id) WHERE state = 'active';
  CREATE TABLE IF NOT EXISTS core_event_inbox(
    event_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')),
    session_id TEXT NOT NULL, turn_id TEXT, source_cursor TEXT NOT NULL, occurred_at TEXT NOT NULL,
    event_json TEXT NOT NULL CHECK(json_valid(event_json)), payload_compacted_at TEXT, ingested_at TEXT NOT NULL,
    event_type TEXT, submission_id TEXT, channel TEXT, call_id TEXT
  );
  CREATE INDEX IF NOT EXISTS core_event_inbox_session_turn ON core_event_inbox(agent_kind, session_id, turn_id, occurred_at, event_id);
  CREATE TABLE IF NOT EXISTS session_activity_snapshots(
    scope_key TEXT NOT NULL, workspace_id TEXT NOT NULL, pane_id TEXT NOT NULL,
    producer_kind TEXT NOT NULL CHECK(producer_kind IN ('primary','worker')), producer_id TEXT NOT NULL,
    producer_generation INTEGER NOT NULL CHECK(producer_generation>=1), producer_session_generation INTEGER NOT NULL CHECK(producer_session_generation>=1), runtime_pane_id TEXT NOT NULL,
    binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE, binding_generation INTEGER NOT NULL CHECK(binding_generation>=1), session_epoch INTEGER NOT NULL CHECK(session_epoch>=1),
    native_session_id TEXT NOT NULL, agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')),
    lane_id TEXT NOT NULL, source_id TEXT NOT NULL, source_epoch TEXT NOT NULL, source_lane_sequence INTEGER NOT NULL CHECK(source_lane_sequence>=0), source_event_id TEXT NOT NULL,
    reducer_revision INTEGER NOT NULL DEFAULT 1 CHECK(reducer_revision>=1), revision INTEGER NOT NULL CHECK(revision>=1),
    current_model TEXT, current_goal_json TEXT CHECK(current_goal_json IS NULL OR json_valid(current_goal_json)),
    last_turn_id TEXT, last_turn_state TEXT CHECK(last_turn_state IS NULL OR last_turn_state IN ('active','completed','aborted')),
    compaction_count INTEGER NOT NULL DEFAULT 0 CHECK(compaction_count>=0), token_usage INTEGER, context_usage INTEGER, updated_at TEXT NOT NULL,
    retained_recovery_lane_id TEXT, retained_recovery_lane_sequence INTEGER NOT NULL DEFAULT 0 CHECK(retained_recovery_lane_sequence>=0),
    PRIMARY KEY(scope_key,producer_kind,producer_id)
  );
  CREATE INDEX IF NOT EXISTS session_activity_snapshots_binding ON session_activity_snapshots(binding_id,binding_generation,session_epoch,scope_key);
  CREATE TABLE IF NOT EXISTS session_activity_items(
    scope_key TEXT NOT NULL, producer_kind TEXT NOT NULL CHECK(producer_kind IN ('primary','worker')), producer_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('task','agent','tool')), item_id TEXT NOT NULL,
    producer_generation INTEGER NOT NULL CHECK(producer_generation>=1), producer_session_generation INTEGER NOT NULL CHECK(producer_session_generation>=1), runtime_pane_id TEXT NOT NULL,
    lane_id TEXT NOT NULL, source_id TEXT NOT NULL, source_epoch TEXT NOT NULL, source_lane_sequence INTEGER NOT NULL CHECK(source_lane_sequence>=0), source_event_id TEXT NOT NULL,
    item_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(item_ordinal>=0), label TEXT NOT NULL, state TEXT NOT NULL, terminal INTEGER NOT NULL CHECK(terminal IN (0,1)), updated_at TEXT NOT NULL,
    PRIMARY KEY(scope_key,producer_kind,producer_id,kind,item_id),
    FOREIGN KEY(scope_key,producer_kind,producer_id) REFERENCES session_activity_snapshots(scope_key,producer_kind,producer_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS session_activity_items_visible ON session_activity_items(scope_key,kind,terminal,item_ordinal,updated_at DESC,producer_kind,producer_id,item_id);
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
    source_kind TEXT NOT NULL, source_id TEXT NOT NULL,
    link_kind TEXT NOT NULL CHECK(link_kind IN ('checkpoint','gap','recovery','prerequisite','replacement','projection','owner')),
    link_id TEXT NOT NULL, link_state TEXT NOT NULL,
    PRIMARY KEY(source_kind,source_id,link_kind,link_id,link_state),
    FOREIGN KEY(source_kind,source_id) REFERENCES audit_skeletons(source_kind,source_id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS audit_skeleton_links_reverse ON audit_skeleton_links(link_kind,link_id,source_kind,source_id);
  CREATE TABLE IF NOT EXISTS retention_compaction_cursors(
    source_kind TEXT PRIMARY KEY CHECK(source_kind IN ('core_event','conversation_segment_item','answer_timeline_item','delivery')),
    cycle_started_at TEXT NOT NULL, high_water_key_json TEXT NOT NULL CHECK(json_valid(high_water_key_json)),
    after_key_json TEXT CHECK(after_key_json IS NULL OR json_valid(after_key_json)),
    cycle_state TEXT NOT NULL CHECK(cycle_state IN ('scanning','complete')),
    compacted_count INTEGER NOT NULL DEFAULT 0 CHECK(compacted_count>=0),
    refusal_counts_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(refusal_counts_json)), updated_at TEXT NOT NULL
  );
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
  CREATE TABLE IF NOT EXISTS core_event_discriminator_backfill(
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
    state TEXT NOT NULL CHECK(state IN ('backfilling','complete')),
    high_water_event_id TEXT, after_event_id TEXT NOT NULL,
    processed_count INTEGER NOT NULL CHECK(processed_count>=0), updated_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO core_event_discriminator_backfill(
    singleton_id,state,high_water_event_id,after_event_id,processed_count,updated_at
  ) VALUES(1,'complete',NULL,'',0,'1970-01-01T00:00:00.000Z');
  CREATE TABLE IF NOT EXISTS canonical_human_message_submissions(
    submission_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES core_event_inbox(event_id) ON DELETE CASCADE,
    agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')), session_id TEXT NOT NULL, observed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS canonical_human_message_submissions_observed ON canonical_human_message_submissions(observed_at, submission_id);
  CREATE TABLE IF NOT EXISTS canonical_input_recovery_attempts(
    submission_id TEXT PRIMARY KEY REFERENCES submission_intents(submission_id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK(state IN ('retry_wait','needs_human','auto_closed','recovered')),
    failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN ('indexing','not_found','ambiguous','unavailable')),
    attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0), next_attempt_at TEXT, updated_at TEXT NOT NULL,
    CHECK((state='retry_wait' AND failure_code IS NOT NULL AND attempt_count>=1 AND next_attempt_at IS NOT NULL)
      OR (state IN ('needs_human','auto_closed') AND failure_code IS NOT NULL AND attempt_count>=1 AND next_attempt_at IS NULL)
      OR (state='recovered' AND failure_code IS NULL AND attempt_count=0 AND next_attempt_at IS NULL))
  );
  CREATE INDEX IF NOT EXISTS canonical_input_recovery_attempts_due
    ON canonical_input_recovery_attempts(state,next_attempt_at,submission_id);
  CREATE TABLE IF NOT EXISTS canonical_input_recovery_scan(
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), scan_cutoff TEXT NOT NULL,
    after_created_at TEXT NOT NULL, after_submission_id TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS core_event_lane_items(
    lane_id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES core_event_inbox(event_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK(sequence > 0), state TEXT NOT NULL CHECK(state IN ('pending','projected','ignored','quarantined')),
    failure TEXT, failure_fingerprint TEXT, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0), reducer_revision INTEGER NOT NULL DEFAULT 1 CHECK(reducer_revision >= 1),
    conflict_count INTEGER NOT NULL DEFAULT 0 CHECK(conflict_count >= 0), last_conflict_hash TEXT, last_conflict_reason TEXT, last_conflict_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(lane_id, event_id), UNIQUE(lane_id, sequence)
  );
  CREATE INDEX IF NOT EXISTS core_event_lane_pending ON core_event_lane_items(lane_id, state, sequence);
  CREATE INDEX IF NOT EXISTS core_event_lane_history_pending
    ON core_event_lane_items(state, created_at, lane_id, sequence, event_id);
  CREATE TABLE IF NOT EXISTS conversation_turn_projections(
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
  CREATE TABLE IF NOT EXISTS conversation_turn_projection_events(
    agent_kind TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, started_at TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE REFERENCES core_event_inbox(event_id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL CHECK(sequence > 0), created_at TEXT NOT NULL,
    PRIMARY KEY(agent_kind, session_id, turn_id, started_at, event_id),
    UNIQUE(agent_kind, session_id, turn_id, started_at, sequence),
    FOREIGN KEY(agent_kind, session_id, turn_id, started_at)
      REFERENCES conversation_turn_projections(agent_kind, session_id, turn_id, started_at) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS conversation_turn_projection_events_order
    ON conversation_turn_projection_events(agent_kind, session_id, turn_id, started_at, sequence);
  CREATE TABLE IF NOT EXISTS authoritative_turn_snapshots(
    agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')), session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL, requested_started_at TEXT NOT NULL,
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('binding','worker_turn')), owner_id TEXT NOT NULL,
    canonical_started_at TEXT, state TEXT NOT NULL CHECK(state IN ('staging','ready','indexing','not_found','ambiguous')),
    next_cursor TEXT NOT NULL, complete INTEGER NOT NULL CHECK(complete IN (0,1)),
    failure_code TEXT, event_count INTEGER NOT NULL DEFAULT 0 CHECK(event_count >= 0),
    payload_bytes INTEGER NOT NULL DEFAULT 0 CHECK(payload_bytes >= 0),
    applied_at TEXT, applied_projection_id TEXT, applied_view_version INTEGER,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
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
  CREATE TABLE IF NOT EXISTS projection_gaps(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stage TEXT NOT NULL CHECK(stage IN ('core_projection','answer_delivery','main_delivery','worker_delivery','turn_recovery')),
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('binding','prompt','answer_page','worker_turn','turn_card')),
    owner_id TEXT NOT NULL, source_item_id TEXT NOT NULL, failure_class TEXT NOT NULL DEFAULT 'unknown', failure_code TEXT NOT NULL, required_version INTEGER,
    occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count >= 1),
    state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','compensated','dismissed')),
    compensated_by_version INTEGER, first_failed_at TEXT NOT NULL, last_failed_at TEXT NOT NULL, compensated_at TEXT,
    details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json)),
    UNIQUE(stage,owner_kind,owner_id,source_item_id)
  );
  CREATE INDEX IF NOT EXISTS projection_gaps_open ON projection_gaps(state, owner_kind, owner_id, first_failed_at);
  CREATE INDEX IF NOT EXISTS projection_gaps_open_source_item ON projection_gaps(state, source_item_id);
  CREATE TABLE IF NOT EXISTS delivery_debt_classifications(
    debt_kind TEXT NOT NULL CHECK(debt_kind IN ('delivery_recovery','projection_gap')),
    debt_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope = 'historical'), reason TEXT NOT NULL,
    source_updated_at TEXT NOT NULL, classified_at TEXT NOT NULL,
    PRIMARY KEY(debt_kind, debt_id)
  );
  CREATE INDEX IF NOT EXISTS delivery_debt_classifications_scope ON delivery_debt_classifications(scope, classified_at, debt_kind, debt_id);
  CREATE TABLE IF NOT EXISTS external_turn_recovery_attempts(
    prompt_id TEXT PRIMARY KEY REFERENCES prompt_jobs(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL,
    pane_id TEXT NOT NULL, session_value TEXT NOT NULL, turn_id TEXT NOT NULL, started_at TEXT NOT NULL,
    failure_code TEXT NOT NULL, failure_fingerprint TEXT NOT NULL, recovery_state TEXT NOT NULL DEFAULT 'waiting' CHECK(recovery_state IN ('waiting','indexing','not_found','ambiguous','transient')),
    attempt_count INTEGER NOT NULL CHECK(attempt_count >= 1), last_runtime_observed_at TEXT,
    last_attempt_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS external_turn_recovery_due ON external_turn_recovery_attempts(next_attempt_at, binding_id);
  CREATE TABLE IF NOT EXISTS detached_prompt_recovery_attempts(
    prompt_id TEXT PRIMARY KEY REFERENCES prompt_jobs(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL CHECK(binding_generation >= 1),
    pane_id TEXT NOT NULL, session_value TEXT NOT NULL,
    attempt_count INTEGER NOT NULL CHECK(attempt_count >= 1),
    first_attempt_at TEXT NOT NULL, last_attempt_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS detached_prompt_recovery_due ON detached_prompt_recovery_attempts(next_attempt_at, binding_id);
  CREATE TABLE IF NOT EXISTS core_event_lane_checkpoints(
    lane_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')),
    session_id TEXT NOT NULL, source_epoch TEXT, read_cursor TEXT NOT NULL, latest_cursor TEXT NOT NULL, updated_at TEXT NOT NULL
  );
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
  INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);

  `);
  createRuntimeIdentityClaimSchema(context.database);
  const completionActionSetColumns = new Set((context.database.prepare("PRAGMA table_info(completion_action_sets)").all() as Array<{ name: string }>).map(({ name }) => name));
  if (completionActionSetColumns.has("presentation_reply_id")) {
    context.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS completion_action_sets_presentation_reply
      ON completion_action_sets(presentation_reply_id) WHERE presentation_reply_id IS NOT NULL`);
  }
  createConversationSegmentSchema(context);
}

