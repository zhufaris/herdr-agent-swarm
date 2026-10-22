import type { CoreEventEnvelope } from "../../domain/core-event-inbox.js";
import type { AgentEvent, AgentEventPayload, AgentTokenUsageGroup } from "../../domain/herdr-events.js";
import { snakeCaseAgentEventPayloadSchema, type SnakeCaseAgentEventPayload } from "../../domain/herdr-event-payload-schema.js";

type PersistedPayload = SnakeCaseAgentEventPayload;
type PersistedTokenUsagePayload = Extract<PersistedPayload, { type: "token_usage" }>;

export function decodePersistedAgentEvent(event: CoreEventEnvelope): AgentEvent {
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    cursor: event.cursor,
    sourceId: event.sourceId,
    agentKind: event.agentKind,
    sessionId: event.sessionId,
    turnId: event.turnId,
    occurredAt: event.occurredAt,
    payload: normalizePayload(snakeCaseAgentEventPayloadSchema.parse(event.payload))
  };
}

export function encodePersistedAgentEvent(event: AgentEvent): CoreEventEnvelope {
  return {
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    cursor: event.cursor,
    sourceId: event.sourceId,
    agentKind: event.agentKind,
    sessionId: event.sessionId,
    turnId: event.turnId,
    occurredAt: event.occurredAt,
    payload: snakeCaseAgentEventPayloadSchema.parse(serializePayload(event.payload))
  };
}

function normalizePayload(payload: PersistedPayload): AgentEventPayload {
  switch (payload.type) {
    case "human_message": return {
      type: payload.type,
      messageId: payload.message_id,
      text: payload.text,
      truncated: payload.truncated,
      ...(payload.submission_id ? { submissionId: payload.submission_id } : {}),
      ...(payload.choice ? { choice: payload.choice } : {})
    };
    case "message": return {
      type: payload.type,
      messageId: payload.message_id,
      ...(payload.role ? { role: payload.role } : {}),
      channel: payload.channel,
      text: payload.text,
      truncated: payload.truncated,
      ...(payload.completion_choice ? { completionChoice: payload.completion_choice } : {})
    };
    case "agent_activity": return {
      type: payload.type,
      agentId: payload.agent_id,
      ...(payload.display_name ? { displayName: payload.display_name } : {}),
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.content ? { content: payload.content, contentTruncated: payload.content_truncated ?? false } : {}),
      ...(payload.result_handoff ? { resultHandoff: payload.result_handoff } : {}),
      state: payload.state
    };
    case "token_usage": return {
      type: payload.type,
      responseId: payload.response_id,
      response: normalizeTokenUsageGroup(payload.response),
      ...(payload.turn ? { turn: normalizeTokenUsageGroup(payload.turn) } : {}),
      ...(payload.thread ? { thread: normalizeTokenUsageGroup(payload.thread) } : {}),
      ...(payload.model_context_window ? { modelContextWindow: payload.model_context_window } : {}),
      ...(payload.auto_compact_limit ? { autoCompactLimit: payload.auto_compact_limit } : {})
    };
    case "tool_call": return { type: payload.type, callId: payload.call_id, name: payload.name, arguments: payload.arguments, truncated: payload.truncated };
    case "tool_result": return { type: payload.type, callId: payload.call_id, text: payload.text, isError: payload.is_error, truncated: payload.truncated };
    case "goal_changed": return {
      type: payload.type,
      goalId: payload.goal_id,
      objective: payload.objective,
      status: payload.status,
      sourceUpdatedAt: payload.source_updated_at,
      truncated: payload.truncated
    };
    case "branch_changed": return { type: payload.type, parentId: payload.parent_id };
    case "submission_receipt": return { type: payload.type, submissionId: payload.submission_id, state: payload.state };
    case "runtime_status_changed": return { type: payload.type, paneId: payload.pane_id, status: payload.status };
    case "runtime_agent_changed": return { type: payload.type, paneId: payload.pane_id, released: payload.released, ...(payload.final_status ? { finalStatus: payload.final_status } : {}) };
    case "runtime_ended": return { type: payload.type, paneId: payload.pane_id, reason: payload.reason };
    default: return payload;
  }
}

function serializePayload(payload: AgentEventPayload): PersistedPayload {
  switch (payload.type) {
    case "human_message": return {
      type: payload.type,
      message_id: payload.messageId,
      text: payload.text,
      truncated: payload.truncated,
      ...(payload.submissionId ? { submission_id: payload.submissionId } : {}),
      ...(payload.choice ? { choice: payload.choice } : {})
    };
    case "message": return {
      type: payload.type,
      message_id: payload.messageId,
      ...(payload.role ? { role: payload.role } : {}),
      channel: payload.channel,
      text: payload.text,
      truncated: payload.truncated,
      ...(payload.completionChoice ? { completion_choice: payload.completionChoice } : {})
    };
    case "agent_activity": return {
      type: payload.type,
      agent_id: payload.agentId,
      ...(payload.displayName ? { display_name: payload.displayName } : {}),
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.content ? { content: payload.content, content_truncated: payload.contentTruncated ?? false } : {}),
      ...(payload.resultHandoff ? { result_handoff: payload.resultHandoff } : {}),
      state: payload.state
    };
    case "token_usage": return {
      type: payload.type,
      response_id: payload.responseId,
      response: serializeTokenUsageGroup(payload.response),
      ...(payload.turn ? { turn: serializeTokenUsageGroup(payload.turn) } : {}),
      ...(payload.thread ? { thread: serializeTokenUsageGroup(payload.thread) } : {}),
      ...(payload.modelContextWindow ? { model_context_window: payload.modelContextWindow } : {}),
      ...(payload.autoCompactLimit ? { auto_compact_limit: payload.autoCompactLimit } : {})
    };
    case "tool_call": return { type: payload.type, call_id: payload.callId, name: payload.name, arguments: payload.arguments, truncated: payload.truncated };
    case "tool_result": return { type: payload.type, call_id: payload.callId, text: payload.text, is_error: payload.isError, truncated: payload.truncated };
    case "goal_changed": return {
      type: payload.type,
      goal_id: payload.goalId,
      objective: payload.objective,
      status: payload.status,
      source_updated_at: payload.sourceUpdatedAt,
      truncated: payload.truncated
    };
    case "branch_changed": return { type: payload.type, parent_id: payload.parentId };
    case "submission_receipt": return { type: payload.type, submission_id: payload.submissionId, state: payload.state };
    case "runtime_status_changed": return { type: payload.type, pane_id: payload.paneId, status: payload.status };
    case "runtime_agent_changed": return { type: payload.type, pane_id: payload.paneId, released: payload.released, ...(payload.finalStatus ? { final_status: payload.finalStatus } : {}) };
    case "runtime_ended": return { type: payload.type, pane_id: payload.paneId, reason: payload.reason };
    default: return payload;
  }
}

function normalizeTokenUsageGroup(group: PersistedTokenUsagePayload["response"]): AgentTokenUsageGroup {
  return {
    inputTokens: group.input_tokens,
    cachedInputTokens: group.cached_input_tokens,
    cacheCreationInputTokens: group.cache_creation_input_tokens,
    outputTokens: group.output_tokens,
    reasoningOutputTokens: group.reasoning_output_tokens,
    totalTokens: group.total_tokens
  };
}

function serializeTokenUsageGroup(group: AgentTokenUsageGroup): PersistedTokenUsagePayload["response"] {
  return {
    input_tokens: group.inputTokens,
    cached_input_tokens: group.cachedInputTokens,
    cache_creation_input_tokens: group.cacheCreationInputTokens,
    output_tokens: group.outputTokens,
    reasoning_output_tokens: group.reasoningOutputTokens,
    total_tokens: group.totalTokens
  };
}
