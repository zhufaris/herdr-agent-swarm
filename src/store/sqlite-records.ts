import type {
  AnswerPage, AnswerPageDeliveryMode, AnswerPageState, Binding, CardInteraction, DeliveryFailureClass,
  BindingThreadAlias, OutboundReply, OutboundReplyKind, OutboundReplyState, OutboundTargetRole, OutboundWorkClass, PaneControlOperation,
  ProjectSelection, ProjectSelectionState,
  PromptJob, PromptObservationState, PromptState, RequestCardRole, TurnPriority,
  RetiredPaneCleanupOperation, RetiredPaneCleanupState, SessionOperation
} from "../domain/types.js";
import type { OrchestratorClearOperation, OrchestratorClearState, SessionRotationReceipt } from "../domain/orchestrator-clear.js";
import type { OrchestratorIdentityMigration, OrchestratorIdentityMigrationState } from "../domain/orchestrator-identity.js";
import type { PaneIdentityReconcileReceipt } from "../domain/ports/external.js";
import type { ModelPreference, ModelPreferenceState } from "../domain/model-selection.js";
import type { TurnControlKind, TurnControlOperation, TurnControlState } from "../domain/turn-control.js";
import type { ControlActor } from "../domain/commands.js";
import type { CommandIntent, CommandIntentState } from "../domain/command-intent.js";
import { frozenCommandTargetSchema, naturalLanguageCommandEnvelopeSchema, type NaturalLanguageCommandConfirmation, type NaturalLanguageCommandConfirmationState } from "../domain/natural-language-command-confirmation.js";
import type { BridgeCommand } from "../domain/types.js";
import type { SwarmCommandContext, SwarmCommandReplayPolicy } from "../domain/swarm-command.js";
import type { InstanceLease } from "../domain/types.js";
import type { WorkerSessionThread } from "../domain/worker-session-thread.js";
import type { AgentKind } from "../domain/agent-instance.js";
import type { DeliveryOwnerFence, DeliveryScope } from "../domain/delivery-scope.js";
import type { RuntimeIdentityClaim } from "../domain/runtime-identity-claim.js";

export type SqlValue = string | number | bigint | null;
export type BindingRow = Record<string, SqlValue> & {
  id: string; kind: string; gateway_id: string; creator_open_id: string | null; project_id: string | null; workspace_id: string; chat_id: string; topic_id: string | null; root_message_id: string | null;
  retired_topic_id: string | null; retired_root_message_id: string | null; replaces_binding_id: string | null; reserved_topic_id: string | null;
  reserved_root_message_id: string | null; reset_message_id: string | null; pane_id: string | null; pane_token: string | null; traex_session_id: string | null;
  agent_session_source: string | null; agent_session_agent: string | null; agent_session_kind: string | null; agent_session_value: string | null;
  title: string; runtime: string; agent_kind: string; state: string; status_message_id: string | null; status_card_sequence: number; last_agent_state: string; last_output_fingerprint: string | null;
  lifecycle: string; attachment: string; generation: number; session_epoch: number; provisioning_checkpoint: string; degradation_count: number; has_completed_turn: number;
  last_observed_at: string | null; archived_at: string | null; last_activity_at: string; created_at: string; updated_at: string;
};
export type RuntimeIdentityClaimRow = Record<string, SqlValue> & {
  binding_id: string; binding_generation: number; session_epoch: number; state: string;
  native_session_source: string | null; native_session_agent: string | null; native_session_kind: string | null; native_session_value: string | null;
  attachment_state: string | null; workspace_id: string | null; pane_id: string | null; terminal_id: string | null;
  last_rejected_evidence_fingerprint: string | null; last_rejected_reason: string | null; created_at: string; updated_at: string;
};
export type PromptRow = Record<string, SqlValue> & { id: string; binding_id: string; session_epoch: number; lark_message_id: string | null; ingress_source: string; source_message_key: string; actor_open_id: string; body: string; parent_prompt_id: string | null; execution_origin: string; state: string; priority: string; was_detached: number; dispatched_at: string | null; native_submission_id: string | null; transcript_turn_id: string | null; transcript_turn_started_at: string | null; model_name: string | null; model_revision: number | null; observation_state: string; attempt_count: number; error: string | null; created_at: string; updated_at: string; };
export type ModelPreferenceRow = Record<string, SqlValue> & { binding_id: string; binding_generation: number; desired_model: string; desired_revision: number; effective_model: string | null; effective_revision: number | null; state: string; dispatch_prompt_id: string | null; prepared_operation_id: string | null; updated_at: string; };
export type OutboundReplyRow = Record<string, SqlValue> & { id: string; gateway_id: string; gateway_profile_id: string; gateway_plan_json: string | null; gateway_plan_hash: string | null; gateway_checkpoint_json: string | null; idempotency_key: string; binding_id: string | null; prompt_id: string | null; worker_turn_id: string | null; worker_id: string | null; worker_session_generation: number | null; view_version: number | null; card_sequence: number | null; selection_id: string | null; stream_page_index: number | null; stream_element_id: string | null; card_role: string | null; target_role: string | null; thread_alias_id: string | null; worker_thread_id: string | null; shortcut_panel_id: string | null; target_chat_id: string | null; work_class: string; root_message_id: string | null; kind: string; payload: string; intent_kind: string | null; intent_json: string | null; renderer_revision: number | null; state: string; attempt_count: number; error: string | null; delivered_message_id: string | null; next_attempt_at: string; created_at: string; updated_at: string; card_id_checkpoint: string | null; delivery_order: number; lane_key: string; conflict_key: string | null; projection_key: string | null; failure_class: string | null; effect_certainty: string | null; http_status: number | null; lark_error_code: string | null; auto_recovery_count: number; dead_lettered_at: string | null; claim_attempt_id: string | null; claimed_fence: number | null; claimed_owner_id: string | null; claimed_at: string | null; claim_expires_at: string | null; snapshot_revision: number; scope_kind: string | null; scope_key: string | null; scope_workspace_id: string | null; scope_pane_id: string | null; delivery_owner_kind: string | null; delivery_owner_id: string | null; delivery_owner_generation: number | null; delivery_owner_session_generation: number | null; delivery_parent_id: string | null; delivery_parent_generation: number | null; delivery_parent_session_generation: number | null; delivery_parent_pane_id: string | null; };
export type BindingThreadAliasRow = Record<string, SqlValue> & { id: string; publication_key: string; binding_id: string; binding_generation: number; chat_id: string; pane_id: string; source_main_message_id: string; action_message_id: string; topic_id: string | null; root_message_id: string | null; state: string; created_at: string; updated_at: string };
export type WorkerSessionThreadRow = Record<string, SqlValue> & { id: string; publication_key: string; worker_id: string; worker_session_generation: number; parent_binding_id: string; parent_binding_generation: number; parent_pane_id: string; chat_id: string; mode: string; source_main_message_id: string | null; action_message_id: string | null; topic_id: string | null; root_message_id: string | null; state: string; created_at: string; activated_at: string | null; stale_at: string | null; updated_at: string };
export type AnswerPageRow = Record<string, SqlValue> & { prompt_id: string; page_index: number; message_id: string | null; card_id: string | null; element_id: string; source_start: number; sequence: number; state: string; delivery_mode: string; created_at: string; updated_at: string; };
export type ProjectSelectionRow = Record<string, SqlValue> & { id: string; command_message_id: string; selector_message_id: string | null; chat_id: string; topic_id: string | null; root_message_id: string; actor_open_id: string; requested_title: string | null; initial_prompt_text: string | null; agent_kind: string; selected_project_id: string | null; binding_id: string | null; state: string; error: string | null; expires_at: string; created_at: string; updated_at: string; };
export type RetiredPaneCleanupRow = Record<string, SqlValue> & { id: string; old_binding_id: string; replacement_binding_id: string; pane_id: string; expected_workspace_id: string; expected_project_id: string; expected_cwd: string; expected_terminal_id: string; actor_open_id: string; state: string; attempt_count: number; detail: string | null; created_at: string; updated_at: string; };
export type PaneControlOperationRow = Record<string, SqlValue> & { id: string; idempotency_key: string; binding_id: string; pane_id: string; terminal_id: string | null; binding_generation: number; kind: string; payload: string | null; parent_prompt_id: string | null; state: string; attempt_count: number; detail: string | null; actor_open_id: string; source_message_id: string; created_at: string; updated_at: string; };
export type CardInteractionRow = Record<string, SqlValue> & { id: string; binding_id: string; binding_generation: number; actor_open_id: string; action_kind: string; parent_prompt_id: string | null; target_prompt_id: string | null; state: string; expires_at: string; result_code: string | null; created_at: string; claimed_at: string | null; consumed_at: string | null; };
export type SessionOperationRow = Record<string, SqlValue> & { id: string; idempotency_key: string; interaction_id: string; binding_id: string; binding_generation: number; expected_pane_id: string | null; expected_terminal_id: string | null; actor_open_id: string; kind: string; argument: string | null; state: string; attempt_count: number; detail: string | null; created_at: string; updated_at: string; };
export type OrchestratorClearOperationRow = Record<string, SqlValue> & { id: string; idempotency_key: string; actor_open_id: string; source_message_id: string; confirmation_id: string; binding_id: string; binding_generation: number; old_session_epoch: number; expected_workspace_id: string; expected_pane_id: string; expected_terminal_id: string; expected_session_source: string; expected_session_agent: string; expected_session_kind: string; expected_session_value: string; expected_state_change_seq: number; state: string; attempt_count: number; receipt_json: string | null; answer_target_snapshot_json: string; answer_target_count: number; withdrawn_count: number; already_absent_count: number; failed_count: number; detail: string | null; created_at: string; updated_at: string; };
export type OrchestratorIdentityMigrationRow = Record<string, SqlValue> & { id: string; binding_id: string; binding_generation: number; expected_workspace_id: string; expected_pane_id: string; expected_terminal_id: string; expected_token: string; target_workspace_id: string; expected_workspace_label: string; target_token: string; state: string; attempt_count: number; receipt_json: string | null; detail: string | null; created_at: string; updated_at: string };
export type CommandIntentRow = Record<string, SqlValue> & { id: string; idempotency_key: string; lane_key: string; command_json: string; context_json: string; replay_policy: string; state: string; attempt_count: number; outcome_json: string | null; claimed_at: string | null; created_at: string; updated_at: string; };
export type CommandStatusViewRow = Record<string, SqlValue> & { intent_id: string; command_kind: string; summary: string; source: string; actor_open_id: string; lane_key: string; state: string; attempt_count: number; outcome_json: string | null; message_id: string | null; card_id: string | null; card_json: string; revision: number; delivered_revision: number; created_at: string; updated_at: string; };
export type NaturalLanguageCommandConfirmationRow = Record<string, SqlValue> & { id: string; source_message_id: string; actor_open_id: string; chat_id: string; topic_id: string | null; root_message_id: string; command_json: string; frozen_target_json: string | null; state: string; expires_at: string; result_detail: string | null; created_at: string; updated_at: string; resolved_at: string | null };
export type TurnControlOperationRow = Record<string, SqlValue> & { id: string; idempotency_key: string; kind: string; owner_kind: string; owner_id: string; project_id: string; pane_id: string; generation: number; agent_session_source: string; agent_session_agent: string; agent_session_kind: string; agent_session_value: string; logical_turn_id: string; runtime_turn_id: string; actor_json: string; payload: string | null; source_message_id: string | null; source_card_id: string | null; state: string; result_json: string | null; created_at: string; updated_at: string; };

function requirePersistedEnum<T extends string>(field: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid persisted enum discriminator for ${field}`);
}

export function mapInstanceLease(row: { owner_id: string; fencing_token: number; expires_at: string; updated_at: string }): InstanceLease { return { ownerId: row.owner_id, fencingToken: Number(row.fencing_token), expiresAt: row.expires_at, updatedAt: row.updated_at }; }

export function mapPaneControlOperation(row: PaneControlOperationRow): PaneControlOperation {
  const kind = requirePersistedEnum("pane_control_operations.kind", row.kind, ["stop", "steer", "model"] as const);
  const state = requirePersistedEnum("pane_control_operations.state", row.state, ["accepted", "running", "applied", "confirmed", "rejected", "failed", "uncertain"] as const);
  return { id: row.id, idempotencyKey: row.idempotency_key, bindingId: row.binding_id, paneId: row.pane_id, terminalId: row.terminal_id, bindingGeneration: Number(row.binding_generation), kind, payload: row.payload, parentPromptId: row.parent_prompt_id, state, attemptCount: Number(row.attempt_count), detail: row.detail, actorOpenId: row.actor_open_id, sourceMessageId: row.source_message_id, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function mapBinding(row: BindingRow): Binding {
  const kind = requirePersistedEnum("bindings.kind", row.kind, ["task", "orchestrator"] as const);
  const agentSessionKind = row.agent_session_kind === null ? null : requirePersistedEnum("bindings.agent_session_kind", row.agent_session_kind, ["id", "path"] as const);
  const agentKind = requirePersistedEnum("bindings.agent_kind", row.agent_kind, ["traex", "codex", "claude-code", "pi"] as const);
  const state = requirePersistedEnum("bindings.state", row.state, ["pending", "active", "archived", "orphaned", "failed"] as const);
  const lastAgentState = requirePersistedEnum("bindings.last_agent_state", row.last_agent_state, ["idle", "working", "blocked", "done", "unknown"] as const);
  const lifecycle = requirePersistedEnum("bindings.lifecycle", row.lifecycle, ["provisioning", "active", "draining", "archived", "closed", "failed"] as const);
  const attachment = requirePersistedEnum("bindings.attachment", row.attachment, ["unattached", "attached", "degraded", "orphaned"] as const);
  const provisioningCheckpoint = requirePersistedEnum("bindings.provisioning_checkpoint", row.provisioning_checkpoint, ["selected", "pane_created", "runtime_started", "thread_created", "activated"] as const);
  return { id: row.id, kind, gatewayId: row.gateway_id ?? "feishu:primary", creatorOpenId: row.creator_open_id ?? null, projectId: row.project_id, workspaceId: row.workspace_id, chatId: row.chat_id, topicId: row.topic_id, rootMessageId: row.root_message_id, retiredTopicId: row.retired_topic_id ?? null, retiredRootMessageId: row.retired_root_message_id ?? null, replacesBindingId: row.replaces_binding_id ?? null, reservedTopicId: row.reserved_topic_id ?? null, reservedRootMessageId: row.reserved_root_message_id ?? null, resetMessageId: row.reset_message_id ?? null, paneId: row.pane_id, paneToken: row.pane_token ?? null, traexSessionId: row.traex_session_id, agentSessionSource: row.agent_session_source ?? null, agentSessionAgent: row.agent_session_agent ?? null, agentSessionKind, agentSessionValue: row.agent_session_value ?? null, title: row.title, agentKind, state, statusMessageId: row.status_message_id, statusCardSequence: Number(row.status_card_sequence ?? 0), lastAgentState, lastOutputFingerprint: row.last_output_fingerprint, lifecycle, attachment, generation: Number(row.generation), sessionEpoch: Number(row.session_epoch ?? 1), provisioningCheckpoint, degradationCount: Number(row.degradation_count), hasCompletedTurn: Boolean(row.has_completed_turn), lastObservedAt: row.last_observed_at, archivedAt: row.archived_at, lastActivityAt: row.last_activity_at, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function mapRuntimeIdentityClaim(row: RuntimeIdentityClaimRow): RuntimeIdentityClaim {
  const state = requirePersistedEnum("runtime_identity_claims.state", row.state, ["current", "unclaimed", "conflicted", "released"] as const);
  const nativeIdentity = row.native_session_source === null && row.native_session_agent === null && row.native_session_kind === null && row.native_session_value === null
    ? null
    : {
      source: requiredRuntimeIdentityColumn("native_session_source", row.native_session_source),
      agent: requiredRuntimeIdentityColumn("native_session_agent", row.native_session_agent),
      kind: requirePersistedEnum("runtime_identity_claims.native_session_kind", requiredRuntimeIdentityColumn("native_session_kind", row.native_session_kind), ["id", "path"] as const),
      value: requiredRuntimeIdentityColumn("native_session_value", row.native_session_value)
    };
  const attachment = row.attachment_state === null && row.workspace_id === null && row.pane_id === null && row.terminal_id === null
    ? null
    : {
      state: requirePersistedEnum("runtime_identity_claims.attachment_state", requiredRuntimeIdentityColumn("attachment_state", row.attachment_state), ["attached", "orphaned"] as const),
      workspaceId: requiredRuntimeIdentityColumn("workspace_id", row.workspace_id),
      paneId: requiredRuntimeIdentityColumn("pane_id", row.pane_id),
      terminalId: requiredRuntimeIdentityColumn("terminal_id", row.terminal_id)
    };
  const base = {
    owner: { bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation), sessionEpoch: Number(row.session_epoch) },
    state,
    nativeIdentity,
    attachment,
    lastRejectedEvidenceFingerprint: row.last_rejected_evidence_fingerprint,
    lastRejectedReason: row.last_rejected_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (state === "current" && nativeIdentity && attachment) return base as RuntimeIdentityClaim;
  if (state === "unclaimed" && nativeIdentity === null && attachment === null) return base as RuntimeIdentityClaim;
  if ((state === "conflicted" || state === "released")) return base as RuntimeIdentityClaim;
  throw new Error("Invalid persisted RuntimeIdentityClaim state payload");
}

function requiredRuntimeIdentityColumn(column: string, value: string | null): string {
  if (value !== null) return value;
  throw new Error(`Invalid persisted runtime_identity_claims.${column}`);
}
export function mapCardInteraction(row: CardInteractionRow): CardInteraction {
  const actionKind = requirePersistedEnum("card_interactions.action_kind", row.action_kind, ["supplement", "more_actions", "session_control", "continuation"] as const);
  const state = requirePersistedEnum("card_interactions.state", row.state, ["active", "claimed", "consumed", "expired"] as const);
  return { id: row.id, bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation), actorOpenId: row.actor_open_id, actionKind, parentPromptId: row.parent_prompt_id, targetPromptId: row.target_prompt_id, state, expiresAt: row.expires_at, resultCode: row.result_code, createdAt: row.created_at, claimedAt: row.claimed_at, consumedAt: row.consumed_at };
}
export function mapSessionOperation(row: SessionOperationRow): SessionOperation {
  const kind = requirePersistedEnum("session_operations.kind", row.kind, ["stop", "model", "reset", "archive", "resume", "replace", "pane_close", "rename", "reattach"] as const);
  const state = requirePersistedEnum("session_operations.state", row.state, ["accepted", "running", "succeeded", "rejected", "failed", "uncertain"] as const);
  return { id: row.id, idempotencyKey: row.idempotency_key, interactionId: row.interaction_id, bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation), expectedPaneId: row.expected_pane_id, expectedTerminalId: row.expected_terminal_id, actorOpenId: row.actor_open_id, kind, argument: row.argument, state, attemptCount: Number(row.attempt_count), detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function mapOrchestratorClearOperation(row: OrchestratorClearOperationRow): OrchestratorClearOperation {
  return {
    id: row.id, idempotencyKey: row.idempotency_key, actorOpenId: row.actor_open_id, sourceMessageId: row.source_message_id, confirmationId: row.confirmation_id,
    bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation), oldSessionEpoch: Number(row.old_session_epoch),
    expectedWorkspaceId: row.expected_workspace_id, expectedPaneId: row.expected_pane_id, expectedTerminalId: row.expected_terminal_id,
    expectedSession: { source: row.expected_session_source, agent: row.expected_session_agent, kind: row.expected_session_kind as "id" | "path", value: row.expected_session_value },
    expectedStateChangeSeq: Number(row.expected_state_change_seq), state: row.state as OrchestratorClearState, attemptCount: Number(row.attempt_count),
    receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json) as SessionRotationReceipt,
    answerTargetSnapshot: JSON.parse(row.answer_target_snapshot_json) as string[], answerTargetCount: Number(row.answer_target_count), withdrawnCount: Number(row.withdrawn_count),
    alreadyAbsentCount: Number(row.already_absent_count), failedCount: Number(row.failed_count), detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
export function mapOrchestratorIdentityMigration(row: OrchestratorIdentityMigrationRow): OrchestratorIdentityMigration {
  return {
    id: row.id, bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation),
    expected: { workspaceId: row.expected_workspace_id, paneId: row.expected_pane_id, terminalId: row.expected_terminal_id, token: row.expected_token },
    target: { workspaceId: row.target_workspace_id, expectedWorkspaceLabel: row.expected_workspace_label, token: row.target_token },
    state: row.state as OrchestratorIdentityMigrationState, attemptCount: Number(row.attempt_count),
    receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json) as PaneIdentityReconcileReceipt,
    detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
export function mapCommandIntent(row: CommandIntentRow): CommandIntent { return { id: row.id, idempotencyKey: row.idempotency_key, laneKey: row.lane_key, command: JSON.parse(row.command_json) as BridgeCommand, context: JSON.parse(row.context_json) as SwarmCommandContext, replayPolicy: row.replay_policy as SwarmCommandReplayPolicy, state: row.state as CommandIntentState, attemptCount: Number(row.attempt_count), outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json) as CommandIntent["outcome"], claimedAt: row.claimed_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
export function mapCommandStatusView(row: CommandStatusViewRow): import("../domain/command-status-view.js").CommandStatusView { return { intentId: row.intent_id, commandKind: row.command_kind as BridgeCommand["kind"], summary: row.summary, source: row.source as import("../domain/swarm-command.js").SwarmCommandSource, actorOpenId: row.actor_open_id, laneKey: row.lane_key, state: row.state as CommandIntentState, attemptCount: Number(row.attempt_count), outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json) as CommandIntent["outcome"], messageId: row.message_id, cardId: row.card_id, revision: Number(row.revision), deliveredRevision: Number(row.delivered_revision), createdAt: row.created_at, updatedAt: row.updated_at }; }
export function mapNaturalLanguageCommandConfirmation(row: NaturalLanguageCommandConfirmationRow): NaturalLanguageCommandConfirmation | null {
  const envelope = parseJson(row.command_json, naturalLanguageCommandEnvelopeSchema);
  if (!envelope) return null;
  return { id: row.id, sourceMessageId: row.source_message_id, actorOpenId: row.actor_open_id, chatId: row.chat_id, topicId: row.topic_id, rootMessageId: row.root_message_id, envelope, frozenTarget: row.frozen_target_json === null ? null : parseJson(row.frozen_target_json, frozenCommandTargetSchema), state: row.state as NaturalLanguageCommandConfirmationState, expiresAt: row.expires_at, resultDetail: row.result_detail, createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at };
}
function parseJson<T>(json: string, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T | null {
  try { const parsed = schema.safeParse(JSON.parse(json)); return parsed.success ? parsed.data : null; } catch { return null; }
}

function parseTurnControlActor(json: string): ControlActor {
  const value = parsePersistedJson("turn_control_operations.actor_json", json);
  if (!isRecord(value)) throwInvalidPersistedValue("turn_control_operations.actor_json");
  if (value.kind === "human" && typeof value.userId === "string" && (value.channel === undefined || value.channel === "feishu" || value.channel === "local")) {
    return value.channel === undefined ? { kind: "human", userId: value.userId } : { kind: "human", userId: value.userId, channel: value.channel };
  }
  if (value.kind === "thread-primary" && typeof value.projectId === "string" && typeof value.bindingId === "string" && typeof value.bindingGeneration === "number" && Number.isFinite(value.bindingGeneration) && typeof value.parentPromptId === "string") {
    return { kind: "thread-primary", projectId: value.projectId, bindingId: value.bindingId, bindingGeneration: value.bindingGeneration, parentPromptId: value.parentPromptId };
  }
  throwInvalidPersistedValue("turn_control_operations.actor_json");
}

function parseTurnControlResult(json: string): Record<string, unknown> {
  const value = parsePersistedJson("turn_control_operations.result_json", json);
  if (!isRecord(value)) throwInvalidPersistedValue("turn_control_operations.result_json");
  return value;
}

function parsePersistedJson(field: string, json: string): unknown {
  try { return JSON.parse(json); } catch { throw new Error(`Invalid persisted JSON for ${field}`); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwInvalidPersistedValue(field: string): never {
  throw new Error(`Invalid persisted value for ${field}`);
}

export function mapTurnControlOperation(row: TurnControlOperationRow): TurnControlOperation {
  const kind = requirePersistedEnum("turn_control_operations.kind", row.kind, ["steer", "interrupt"] as const);
  const ownerKind = requirePersistedEnum("turn_control_operations.owner_kind", row.owner_kind, ["binding", "instance"] as const);
  const agentSessionKind = requirePersistedEnum("turn_control_operations.agent_session_kind", row.agent_session_kind, ["id", "path"] as const);
  const state = requirePersistedEnum("turn_control_operations.state", row.state, ["accepted", "dispatching", "delivered", "rejected", "uncertain"] as const);
  return {
    id: row.id, idempotencyKey: row.idempotency_key, kind,
    target: {
      owner: ownerKind === "binding" ? { kind: "binding", id: row.owner_id } : { kind: "instance", id: row.owner_id },
      projectId: row.project_id, paneId: row.pane_id, generation: Number(row.generation),
      agentSession: { source: row.agent_session_source, agent: row.agent_session_agent, kind: agentSessionKind, value: row.agent_session_value },
      logicalTurnId: row.logical_turn_id, runtimeTurnId: row.runtime_turn_id
    },
    actor: parseTurnControlActor(row.actor_json), payload: row.payload, sourceMessageId: row.source_message_id, sourceCardId: row.source_card_id,
    state, result: row.result_json === null ? null : parseTurnControlResult(row.result_json),
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
export function mapRetiredPaneCleanup(row: RetiredPaneCleanupRow): RetiredPaneCleanupOperation { return { id: row.id, oldBindingId: row.old_binding_id, replacementBindingId: row.replacement_binding_id, paneId: row.pane_id, expectedWorkspaceId: row.expected_workspace_id, expectedProjectId: row.expected_project_id, expectedCwd: row.expected_cwd, expectedTerminalId: row.expected_terminal_id, actorOpenId: row.actor_open_id, state: row.state as RetiredPaneCleanupState, attemptCount: Number(row.attempt_count), detail: row.detail, createdAt: row.created_at, updatedAt: row.updated_at }; }
export function mapPrompt(row: PromptRow): PromptJob { return { id: row.id, bindingId: row.binding_id, sessionEpoch: Number(row.session_epoch ?? 1), larkMessageId: row.lark_message_id, ingressSource: row.ingress_source as PromptJob["ingressSource"], sourceMessageKey: row.source_message_key, actorOpenId: row.actor_open_id, body: row.body, parentPromptId: row.parent_prompt_id ?? null, executionOrigin: row.execution_origin as PromptJob["executionOrigin"], priority: (row.priority ?? "normal") as TurnPriority, wasDetached: Boolean(row.was_detached), dispatchedAt: row.dispatched_at, nativeSubmissionId: row.native_submission_id ?? null, transcriptTurnId: row.transcript_turn_id, transcriptTurnStartedAt: row.transcript_turn_started_at, modelName: row.model_name ?? null, modelRevision: row.model_revision === null || row.model_revision === undefined ? null : Number(row.model_revision), observationState: row.observation_state as PromptObservationState, state: row.state as PromptState, attemptCount: Number(row.attempt_count), error: row.error, createdAt: row.created_at, updatedAt: row.updated_at }; }
export function mapModelPreference(row: ModelPreferenceRow): ModelPreference { return { bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation), desiredModel: row.desired_model, desiredRevision: Number(row.desired_revision), effectiveModel: row.effective_model, effectiveRevision: row.effective_revision === null ? null : Number(row.effective_revision), state: row.state as ModelPreferenceState, dispatchPromptId: row.dispatch_prompt_id, preparedOperationId: row.prepared_operation_id, updatedAt: row.updated_at }; }
export function mapOutboundReply(row: OutboundReplyRow): OutboundReply { return { id: row.id, gatewayId: row.gateway_id ?? "feishu:primary", gatewayProfileId: row.gateway_profile_id ?? "feishu-cardkit-v1", gatewayPlanJson: row.gateway_plan_json ?? null, gatewayPlanHash: row.gateway_plan_hash ?? null, gatewayCheckpointJson: row.gateway_checkpoint_json ?? null, idempotencyKey: row.idempotency_key, bindingId: row.binding_id, rootMessageId: row.root_message_id, promptId: row.prompt_id, workerTurnId: row.worker_turn_id ?? null, workerId: row.worker_id ?? null, workerSessionGeneration: row.worker_session_generation === null || row.worker_session_generation === undefined ? null : Number(row.worker_session_generation), viewVersion: row.view_version === null ? null : Number(row.view_version), cardSequence: row.card_sequence === null ? null : Number(row.card_sequence), selectionId: row.selection_id, streamPageIndex: row.stream_page_index === null || row.stream_page_index === undefined ? null : Number(row.stream_page_index), streamElementId: row.stream_element_id ?? null, cardRole: row.card_role as RequestCardRole | null, targetRole: row.target_role as OutboundTargetRole | null, threadAliasId: row.thread_alias_id ?? null, workerThreadId: row.worker_thread_id ?? null, shortcutPanelId: row.shortcut_panel_id ?? null, targetChatId: row.target_chat_id ?? null, laneKey: row.lane_key, conflictKey: row.conflict_key ?? row.lane_key, projectionKey: row.projection_key ?? null, workClass: row.work_class as OutboundWorkClass, kind: row.kind as OutboundReplyKind, payload: row.payload, intentKind: row.intent_kind as OutboundReply["intentKind"] ?? null, intentJson: row.intent_json ?? null, rendererRevision: row.renderer_revision === null || row.renderer_revision === undefined ? null : Number(row.renderer_revision), state: row.state as OutboundReplyState, attemptCount: Number(row.attempt_count), error: row.error, deliveredMessageId: row.delivered_message_id, cardIdCheckpoint: row.card_id_checkpoint ?? null, failureClass: row.failure_class as DeliveryFailureClass | null, effectCertainty: row.effect_certainty as OutboundReply["effectCertainty"] ?? null, httpStatus: row.http_status === null ? null : Number(row.http_status), larkErrorCode: row.lark_error_code, autoRecoveryCount: Number(row.auto_recovery_count ?? 0), deadLetteredAt: row.dead_lettered_at, nextAttemptAt: row.next_attempt_at, createdAt: row.created_at, updatedAt: row.updated_at, deliveryScope: mapDeliveryScope(row), deliveryOwnerFence: mapDeliveryOwnerFence(row), deliveryParentPaneId: row.delivery_parent_pane_id ?? null }; }

function mapDeliveryScope(row: OutboundReplyRow): DeliveryScope | null {
  if (row.scope_kind === "global") return { kind: "global" };
  if (row.scope_kind !== "pane" || !row.scope_workspace_id || !row.scope_pane_id) return null;
  return { kind: "pane", workspaceId: row.scope_workspace_id, paneId: row.scope_pane_id };
}
function mapDeliveryOwnerFence(row: OutboundReplyRow): DeliveryOwnerFence | null {
  if ((row.delivery_owner_kind !== "primary" && row.delivery_owner_kind !== "worker") || !row.delivery_owner_id || row.delivery_owner_generation === null || row.delivery_owner_session_generation === null) return null;
  const base = { kind: row.delivery_owner_kind, id: row.delivery_owner_id, generation: Number(row.delivery_owner_generation), sessionGeneration: Number(row.delivery_owner_session_generation) } as const;
  if (row.delivery_owner_kind === "primary") return base;
  if (!row.delivery_parent_id || row.delivery_parent_generation === null || row.delivery_parent_session_generation === null) return null;
  return { ...base, parent: { id: row.delivery_parent_id, generation: Number(row.delivery_parent_generation), sessionGeneration: Number(row.delivery_parent_session_generation) } };
}
export function mapBindingThreadAlias(row: BindingThreadAliasRow): BindingThreadAlias { return { id: row.id, publicationKey: row.publication_key, bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation), chatId: row.chat_id, paneId: row.pane_id, sourceMainMessageId: row.source_main_message_id, actionMessageId: row.action_message_id, topicId: row.topic_id, rootMessageId: row.root_message_id, state: row.state as BindingThreadAlias["state"], createdAt: row.created_at, updatedAt: row.updated_at }; }
export function mapWorkerSessionThread(row: WorkerSessionThreadRow): WorkerSessionThread { return { id: row.id, publicationKey: row.publication_key, workerId: row.worker_id, workerSessionGeneration: Number(row.worker_session_generation), parentBindingId: row.parent_binding_id, parentBindingGeneration: Number(row.parent_binding_generation), parentPaneId: row.parent_pane_id, chatId: row.chat_id, mode: row.mode as WorkerSessionThread["mode"], sourceMainMessageId: row.source_main_message_id, actionMessageId: row.action_message_id, topicId: row.topic_id, rootMessageId: row.root_message_id, state: row.state as WorkerSessionThread["state"], createdAt: row.created_at, activatedAt: row.activated_at, staleAt: row.stale_at, updatedAt: row.updated_at }; }
export function mapAnswerPage(row: AnswerPageRow): AnswerPage { return { promptId: row.prompt_id, pageIndex: Number(row.page_index), messageId: row.message_id, cardId: row.card_id, elementId: row.element_id, sourceStart: Number(row.source_start), sequence: Number(row.sequence), state: row.state as AnswerPageState, deliveryMode: (row.delivery_mode ?? "streaming") as AnswerPageDeliveryMode, createdAt: row.created_at, updatedAt: row.updated_at }; }
export function mapProjectSelection(row: ProjectSelectionRow): ProjectSelection { return { id: row.id, commandMessageId: row.command_message_id, selectorMessageId: row.selector_message_id, chatId: row.chat_id, topicId: row.topic_id, rootMessageId: row.root_message_id, actorOpenId: row.actor_open_id, requestedTitle: row.requested_title, initialPromptText: row.initial_prompt_text ?? null, agentKind: (row.agent_kind ?? "traex") as AgentKind, selectedProjectId: row.selected_project_id, bindingId: row.binding_id, state: row.state as ProjectSelectionState, error: row.error, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at }; }
