import { describe, expect, it } from "vitest";
import {
  mapBinding, mapCardInteraction, mapPaneControlOperation, mapSessionOperation, mapTurnControlOperation,
  type BindingRow, type CardInteractionRow, type PaneControlOperationRow, type SessionOperationRow, type TurnControlOperationRow
} from "../src/store/sqlite-records.js";

function bindingRow(overrides: Partial<BindingRow> = {}): BindingRow {
  return {
    id: "binding-1", kind: "task", gateway_id: "feishu:primary", creator_open_id: null, project_id: "project-1", workspace_id: "workspace-1", chat_id: "chat-1", topic_id: null, root_message_id: null,
    retired_topic_id: null, retired_root_message_id: null, replaces_binding_id: null, reserved_topic_id: null, reserved_root_message_id: null, reset_message_id: null, pane_id: null, pane_token: null, traex_session_id: null,
    agent_session_source: null, agent_session_agent: null, agent_session_kind: null, agent_session_value: null,
    title: "Task", runtime: "traex", agent_kind: "traex", state: "pending", status_message_id: null, status_card_sequence: 0, last_agent_state: "idle", last_output_fingerprint: null,
    lifecycle: "provisioning", attachment: "unattached", generation: 1, session_epoch: 1, provisioning_checkpoint: "selected", degradation_count: 0, has_completed_turn: 0,
    last_observed_at: null, archived_at: null, last_activity_at: "2026-10-16T00:00:00.000Z", created_at: "2026-10-16T00:00:00.000Z", updated_at: "2026-10-16T00:00:00.000Z",
    ...overrides
  };
}

function turnControlRow(overrides: Partial<TurnControlOperationRow> = {}): TurnControlOperationRow {
  return {
    id: "control-1", idempotency_key: "control-key", kind: "steer", owner_kind: "binding", owner_id: "binding-1", project_id: "project-1", pane_id: "pane-1", generation: 1,
    agent_session_source: "herdr", agent_session_agent: "traex", agent_session_kind: "id", agent_session_value: "session-1", logical_turn_id: "logical-turn-1", runtime_turn_id: "runtime-turn-1",
    actor_json: JSON.stringify({ kind: "human", userId: "user-1" }), payload: "Continue", source_message_id: null, source_card_id: null, state: "accepted", result_json: null,
    created_at: "2026-10-16T00:00:00.000Z", updated_at: "2026-10-16T00:00:00.000Z",
    ...overrides
  };
}

function paneControlRow(overrides: Partial<PaneControlOperationRow> = {}): PaneControlOperationRow {
  return {
    id: "pane-control-1", idempotency_key: "pane-control-key", binding_id: "binding-1", pane_id: "pane-1", terminal_id: null, binding_generation: 1,
    kind: "steer", payload: null, parent_prompt_id: null, state: "accepted", attempt_count: 0, detail: null, actor_open_id: "user-1", source_message_id: "message-1",
    created_at: "2026-10-16T00:00:00.000Z", updated_at: "2026-10-16T00:00:00.000Z",
    ...overrides
  };
}

function cardInteractionRow(overrides: Partial<CardInteractionRow> = {}): CardInteractionRow {
  return {
    id: "interaction-1", binding_id: "binding-1", binding_generation: 1, actor_open_id: "user-1", action_kind: "supplement", parent_prompt_id: null,
    target_prompt_id: null, state: "active", expires_at: "2026-10-16T01:00:00.000Z", result_code: null, created_at: "2026-10-16T00:00:00.000Z",
    claimed_at: null, consumed_at: null,
    ...overrides
  };
}

function sessionOperationRow(overrides: Partial<SessionOperationRow> = {}): SessionOperationRow {
  return {
    id: "session-operation-1", idempotency_key: "session-operation-key", interaction_id: "interaction-1", binding_id: "binding-1", binding_generation: 1,
    expected_pane_id: null, expected_terminal_id: null, actor_open_id: "user-1", kind: "reset", argument: null, state: "accepted", attempt_count: 0,
    detail: null, created_at: "2026-10-16T00:00:00.000Z", updated_at: "2026-10-16T00:00:00.000Z",
    ...overrides
  };
}

describe("SQLite record discriminators", () => {
  it("maps supported binding and turn-control discriminator values", () => {
    const binding = mapBinding(bindingRow({ kind: "orchestrator", agent_session_kind: "path" }));
    const legacyBinding = mapBinding(bindingRow());
    const operation = mapTurnControlOperation(turnControlRow({ kind: "interrupt", owner_kind: "instance", state: "dispatching", agent_session_kind: "path" }));

    expect(binding.kind).toBe("orchestrator");
    expect(binding.agentSessionKind).toBe("path");
    expect(legacyBinding.agentSessionKind).toBeNull();
    expect(operation.kind).toBe("interrupt");
    expect(operation.target.owner).toEqual({ kind: "instance", id: "binding-1" });
    expect(operation.target.agentSession.kind).toBe("path");
    expect(operation.state).toBe("dispatching");
  });

  it.each([
    ["kind", { kind: "unexpected-binding-kind" }, "bindings.kind"],
    ["agent_session_kind", { agent_session_kind: "unexpected-session-kind" }, "bindings.agent_session_kind"],
    ["agent_kind", { agent_kind: "unexpected-agent-kind" }, "bindings.agent_kind"],
    ["state", { state: "unexpected-binding-state" }, "bindings.state"],
    ["last_agent_state", { last_agent_state: "unexpected-agent-state" }, "bindings.last_agent_state"],
    ["lifecycle", { lifecycle: "unexpected-lifecycle" }, "bindings.lifecycle"],
    ["attachment", { attachment: "unexpected-attachment" }, "bindings.attachment"],
    ["provisioning_checkpoint", { provisioning_checkpoint: "unexpected-checkpoint" }, "bindings.provisioning_checkpoint"]
  ] as const)("rejects an invalid binding %s", (_field, overrides, expectedField) => {
    expect(() => mapBinding(bindingRow(overrides))).toThrow(expectedField);
  });

  it.each([
    ["owner_kind", { owner_kind: "unexpected-owner-kind" }, "turn_control_operations.owner_kind"],
    ["kind", { kind: "unexpected-control-kind" }, "turn_control_operations.kind"],
    ["state", { state: "unexpected-control-state" }, "turn_control_operations.state"],
    ["agent_session_kind", { agent_session_kind: "unexpected-session-kind" }, "turn_control_operations.agent_session_kind"]
  ] as const)("rejects an invalid turn-control %s", (_field, overrides, expectedField) => {
    expect(() => mapTurnControlOperation(turnControlRow(overrides))).toThrow(expectedField);
  });

  it("maps a valid pane-control operation while preserving nullable fields", () => {
    const operation = mapPaneControlOperation(paneControlRow({ kind: "model", state: "confirmed" }));

    expect(operation.kind).toBe("model");
    expect(operation.state).toBe("confirmed");
    expect(operation.terminalId).toBeNull();
    expect(operation.payload).toBeNull();
  });

  it.each([
    ["kind", { kind: "unexpected-pane-control-kind" }, "pane_control_operations.kind"],
    ["state", { state: "unexpected-pane-control-state" }, "pane_control_operations.state"]
  ] as const)("rejects an invalid pane-control %s", (_field, overrides, expectedField) => {
    expect(() => mapPaneControlOperation(paneControlRow(overrides))).toThrow(expectedField);
  });

  it("maps a valid card interaction while preserving nullable fields", () => {
    const interaction = mapCardInteraction(cardInteractionRow({ action_kind: "session_control", state: "claimed" }));

    expect(interaction.actionKind).toBe("session_control");
    expect(interaction.state).toBe("claimed");
    expect(interaction.parentPromptId).toBeNull();
    expect(interaction.claimedAt).toBeNull();
  });

  it.each([
    ["action_kind", { action_kind: "unexpected-card-action" }, "card_interactions.action_kind"],
    ["state", { state: "unexpected-card-state" }, "card_interactions.state"]
  ] as const)("rejects an invalid card interaction %s", (_field, overrides, expectedField) => {
    expect(() => mapCardInteraction(cardInteractionRow(overrides))).toThrow(expectedField);
  });

  it("maps a valid session operation while preserving nullable fields", () => {
    const operation = mapSessionOperation(sessionOperationRow({ kind: "reattach", state: "succeeded" }));

    expect(operation.kind).toBe("reattach");
    expect(operation.state).toBe("succeeded");
    expect(operation.expectedPaneId).toBeNull();
    expect(operation.argument).toBeNull();
  });

  it.each([
    ["kind", { kind: "unexpected-session-operation-kind" }, "session_operations.kind"],
    ["state", { state: "unexpected-session-operation-state" }, "session_operations.state"]
  ] as const)("rejects an invalid session operation %s", (_field, overrides, expectedField) => {
    expect(() => mapSessionOperation(sessionOperationRow(overrides))).toThrow(expectedField);
  });

  it("preserves valid human and thread-primary turn-control actors", () => {
    const human = mapTurnControlOperation(turnControlRow({ actor_json: JSON.stringify({ kind: "human", userId: "user-1", channel: "feishu" }) }));
    const primary = mapTurnControlOperation(turnControlRow({ actor_json: JSON.stringify({ kind: "thread-primary", projectId: "project-1", bindingId: "binding-1", bindingGeneration: 2, parentPromptId: "prompt-1" }) }));

    expect(human.actor).toEqual({ kind: "human", userId: "user-1", channel: "feishu" });
    expect(primary.actor).toEqual({ kind: "thread-primary", projectId: "project-1", bindingId: "binding-1", bindingGeneration: 2, parentPromptId: "prompt-1" });
    expect(human.result).toBeNull();
  });

  it.each([
    ["actor_json", { actor_json: "{" }, "turn_control_operations.actor_json"],
    ["actor_json", { actor_json: JSON.stringify({ kind: "service", userId: "user-1" }) }, "turn_control_operations.actor_json"],
    ["actor_json", { actor_json: JSON.stringify({ kind: "human" }) }, "turn_control_operations.actor_json"],
    ["actor_json", { actor_json: JSON.stringify({ kind: "thread-primary", projectId: "project-1", bindingId: "binding-1", bindingGeneration: 1 }) }, "turn_control_operations.actor_json"],
    ["result_json", { result_json: "{" }, "turn_control_operations.result_json"],
    ["result_json", { result_json: JSON.stringify(null) }, "turn_control_operations.result_json"],
    ["result_json", { result_json: JSON.stringify(["result"]) }, "turn_control_operations.result_json"],
    ["result_json", { result_json: JSON.stringify("result") }, "turn_control_operations.result_json"]
  ] as const)("rejects invalid turn-control %s JSON", (_field, overrides, expectedField) => {
    expect(() => mapTurnControlOperation(turnControlRow(overrides))).toThrow(expectedField);
  });

  it("preserves a valid turn-control result object", () => {
    const operation = mapTurnControlOperation(turnControlRow({ result_json: JSON.stringify({ targetMessageId: "message-1" }) }));
    expect(operation.result).toEqual({ targetMessageId: "message-1" });
  });
});
