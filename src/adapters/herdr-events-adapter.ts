import { z } from "zod";
import type { CommandRunner } from "../infra/command-runner.js";
import type {
  AgentEvent,
  AgentEventPayload,
  CoreEventBatch,
  CoreEventCapabilities,
  CoreEventSourceDescriptor,
  CoreRecoveryBatch,
  CoreSessionEventRing,
  CoreSessionEventRingReadResult,
  CoreSessionEventMultiplexAck,
  CoreSessionEventMultiplexFrame,
  CoreSessionEventReadResult,
  CoreSessionEventStream,
  CoreSessionSubmissionReceipt,
  HerdrEventsPort
} from "../domain/herdr-events.js";
import type { AgentTranscriptSubmissionReceipt, AgentTranscriptTurnList } from "../domain/ports/external.js";
import { snakeCaseAgentEventPayloadSchema } from "../domain/herdr-event-payload-schema.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const sourceSchema = z.object({
  source_id: z.string().min(1).max(256),
  terminal_id: z.string().min(1),
  agent_kind: z.enum(["traex", "pi"]),
  session_id: z.string(),
  state: z.string(),
  checkpoint_offset: z.number().int().nonnegative(),
  latest_cursor: z.string().max(1024)
});
const attachedSchema = z.object({ result: z.object({
  type: z.literal("agent_events_attached"),
  source_id: z.string().min(1).max(256),
  attach_offset: z.number().int().nonnegative(),
  sources: z.array(sourceSchema).max(256)
}) });
const sourcesSchema = z.object({ result: z.object({
  type: z.literal("agent_events_sources"),
  enabled: z.boolean(),
  sources: z.array(sourceSchema).max(256)
}) });
const eventEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  event_id: z.string(),
  cursor: z.string(),
  source_id: z.string(),
  agent_kind: z.enum(["traex", "pi"]),
  session_id: z.string(),
  turn_id: z.string().nullable(),
  occurred_at: z.string(),
  payload: z.object({ type: z.string().min(1).max(128) }).passthrough()
});
const eventSchema = eventEnvelopeSchema.extend({ payload: snakeCaseAgentEventPayloadSchema });
const knownPayloadTypes = new Set<string>([
  "turn_started", "turn_completed", "turn_aborted", "human_message", "message", "agent_activity", "model_changed",
  "context_compacted", "token_usage", "context_snapshot", "tool_call", "tool_result", "goal_changed", "branch_changed", "submission_receipt",
  "runtime_status_changed", "runtime_agent_changed", "runtime_ended", "source_error", "record_skipped"
]);
const batchSchema = z.object({ result: z.object({
  type: z.literal("agent_events_batch"),
  events: z.array(eventEnvelopeSchema).max(128),
  next_cursor: z.string().max(1024),
  earliest_cursor: z.string().max(1024),
  latest_cursor: z.string().max(1024)
}) });
const turnCursorSchema = z.object({ result: z.object({
  type: z.literal("agent_events_turn_cursor"),
  source_id: z.string().min(1).max(256),
  found: z.boolean(),
  after_cursor: z.string().max(1024)
}) });
const capabilitiesSchema = z.object({ result: z.object({
  type: z.literal("agent_events_capabilities"),
  exact_turn_recovery_v1: z.boolean(),
  historical_turn_index_recovery_v1: z.boolean().default(false),
  session_turn_enumeration_v1: z.boolean(),
  visible_reasoning_v1: z.boolean().default(false),
  session_event_ring_v2: z.boolean().default(false)
}) });
const submissionReceiptSchema = z.object({ result: z.object({
  type: z.literal("agent_events_submission_receipt"),
  submission_id: z.string().min(1).max(256),
  state: z.enum(["prepared", "observed", "terminal", "cancelled", "legacy_unavailable"]),
  agent_kind: z.enum(["traex", "pi"]),
  session_id: z.string().min(1).max(512),
  turn_id: z.string().min(1).max(512).optional(),
  started_at: z.string().min(1).max(128).optional(),
  terminal_state: z.string().min(1).max(64).optional()
}) });
const recoveryBatchFields = {
  type: z.literal("agent_events_recovery_batch"),
  events: z.array(eventEnvelopeSchema).max(128),
  next_cursor: z.string().max(65_536),
  complete: z.boolean()
};
const recoveryBatchSchema = z.object({ result: z.discriminatedUnion("outcome", [
  z.object({ ...recoveryBatchFields, outcome: z.literal("recovered"), canonical_started_at: z.string().min(1).max(128) }),
  z.object({ ...recoveryBatchFields, outcome: z.literal("indexing"), canonical_started_at: z.string().min(1).max(128).optional() }),
  z.object({ ...recoveryBatchFields, outcome: z.literal("not_found"), canonical_started_at: z.string().min(1).max(128).optional() }),
  z.object({ ...recoveryBatchFields, outcome: z.literal("ambiguous"), canonical_started_at: z.string().min(1).max(128).optional() })
]) });
const turnListSchema = z.object({ result: z.object({
  type: z.literal("agent_events_turn_list"),
  turns: z.array(z.object({
    turn_id: z.string().min(1).max(512),
    started_at: z.string().min(1).max(128),
    terminal_state: z.string().min(1).max(64).optional(),
    has_human_message: z.boolean(),
    submission_id: z.string().min(1).max(256).optional()
  })).max(128),
  next_cursor: z.string().max(16_384).optional(),
  complete: z.boolean()
}) });
const serverCapabilitySchema = z.object({
  type: z.literal("pong"),
  capabilities: z.object({
    session_event_stream_v1: z.boolean().default(false),
    session_event_multiplex_v1: z.boolean().default(false),
    pane_agent_status_all_v1: z.boolean().default(false)
  }).nullable().optional()
});
const sessionMultiplexAckSchema = z.object({
  type: z.literal("session_event_multiplex_subscribed_v3"),
  target_count: z.number().int().min(1).max(128)
});
const sessionMultiplexBatchFrameSchema = z.object({
  event: z.literal("session.events.batch.v3"),
  data: z.object({
    ring_id: z.string().min(1).max(512),
    epoch: z.string().min(1).max(512),
    events: z.array(eventSchema).max(128),
    next_cursor: z.string().max(65_536),
    earliest_cursor: z.string().max(65_536),
    latest_cursor: z.string().max(65_536)
  })
});
const sessionMultiplexGapFrameSchema = z.discriminatedUnion("code", [
  z.object({
    ring_id: z.string().min(1).max(512),
    epoch: z.string().min(1).max(512),
    code: z.literal("cursor_expired"),
    resume_cursor: z.string().min(1).max(65_536),
    earliest_cursor: z.string().max(65_536),
    latest_cursor: z.string().max(65_536)
  }),
  z.object({
    ring_id: z.string().min(1).max(512),
    epoch: z.string().min(1).max(512),
    code: z.literal("epoch_changed"),
    current_epoch: z.string().min(1).max(512)
  }),
  z.object({ ring_id: z.string().min(1).max(512), epoch: z.string().min(1).max(512), code: z.literal("missing") }),
  z.object({ ring_id: z.string().min(1).max(512), epoch: z.string().min(1).max(512), code: z.literal("unavailable") })
]);
const sessionMultiplexFrameSchema = z.discriminatedUnion("event", [
  sessionMultiplexBatchFrameSchema,
  z.object({ event: z.literal("session.events.gap.v3"), data: sessionMultiplexGapFrameSchema })
]);
const sessionOpenedSchema = z.object({
  type: z.literal("session_events_opened"),
  stream_id: z.string().min(1).max(512),
  terminal_id: z.string().min(1).max(512),
  agent_kind: z.enum(["traex", "pi"]),
  session_id: z.string().min(1).max(512),
  earliest_cursor: z.string().max(65_536),
  latest_cursor: z.string().max(65_536)
});
const sessionBatchSchema = z.object({
  type: z.literal("session_events_batch"),
  stream_id: z.string().min(1).max(512),
  events: z.array(eventEnvelopeSchema).max(128),
  next_cursor: z.string().max(65_536),
  earliest_cursor: z.string().max(65_536),
  latest_cursor: z.string().max(65_536)
});
const sessionRingOpenedSchema = z.object({
  type: z.literal("session_event_ring_opened_v2"),
  ring_id: z.string().min(1).max(512),
  epoch: z.string().min(1).max(512),
  terminal_id: z.string().min(1).max(512),
  agent_kind: z.enum(["traex", "pi"]),
  session_id: z.string().min(1).max(512),
  earliest_cursor: z.string().max(65_536),
  latest_cursor: z.string().max(65_536)
});
const sessionRingBatchSchema = z.object({
  type: z.literal("session_event_ring_batch_v2"),
  ring_id: z.string().min(1).max(512),
  epoch: z.string().min(1).max(512),
  events: z.array(eventEnvelopeSchema).max(128),
  next_cursor: z.string().max(65_536),
  earliest_cursor: z.string().max(65_536),
  latest_cursor: z.string().max(65_536)
});
const sessionSubmissionReceiptSchema = z.object({
  type: z.literal("agent_events_submission_receipt"),
  submission_id: z.string().min(1).max(256),
  terminal_id: z.string().min(1).max(512),
  agent_kind: z.enum(["traex", "pi"]),
  session_id: z.string().min(1).max(512),
  state: z.enum(["prepared", "accepted", "rejected", "uncertain"]),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative()
});

interface HerdrSessionRpc {
  request(method: string, params: object, timeoutMs: number): Promise<unknown>;
}

type RawAgentEvent = z.infer<typeof eventSchema>;
type RawAgentEventEnvelope = z.infer<typeof eventEnvelopeSchema>;
type RawTokenUsagePayload = Extract<RawAgentEvent["payload"], { type: "token_usage" }>;
type RawContextSnapshotPayload = Extract<RawAgentEvent["payload"], { type: "context_snapshot" }>;

export function parseHerdrAgentEvent(value: unknown): AgentEvent {
  return normalizeEvent(eventSchema.parse(value));
}

export function normalizeSessionEventMultiplexAck(value: unknown): CoreSessionEventMultiplexAck {
  const ack = sessionMultiplexAckSchema.parse(value);
  return { targetCount: ack.target_count };
}

export function normalizeSessionEventMultiplexFrame(value: unknown): CoreSessionEventMultiplexFrame {
  const frame = sessionMultiplexFrameSchema.parse(value);
  if (frame.event === "session.events.batch.v3") {
    const batch = frame.data;
    return {
      outcome: "batch",
      batch: {
        ringId: batch.ring_id,
        epoch: batch.epoch,
        events: batch.events.map(normalizeEvent),
        nextCursor: batch.next_cursor,
        earliestCursor: batch.earliest_cursor,
        latestCursor: batch.latest_cursor
      }
    };
  }

  const gap = frame.data;
  switch (gap.code) {
    case "cursor_expired":
      return { outcome: "gap", gap: {
        ringId: gap.ring_id, epoch: gap.epoch, code: gap.code,
        resumeCursor: gap.resume_cursor, earliestCursor: gap.earliest_cursor, latestCursor: gap.latest_cursor
      } };
    case "epoch_changed":
      return { outcome: "gap", gap: { ringId: gap.ring_id, epoch: gap.epoch, code: gap.code, currentEpoch: gap.current_epoch } };
    default:
      return { outcome: "gap", gap: { ringId: gap.ring_id, epoch: gap.epoch, code: gap.code } };
  }
}

export class HerdrEventsAdapter implements HerdrEventsPort {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executable: string,
    private readonly rpc?: HerdrSessionRpc
  ) {}

  async supportsSessionEventStream(): Promise<boolean> {
    if (!this.rpc) return false;
    try {
      return serverCapabilitySchema.parse(await this.rpc.request("ping", {}, 2_000)).capabilities?.session_event_stream_v1 === true;
    } catch { return false; }
  }

  async supportsSessionEventRingV2(): Promise<boolean> {
    if (!this.rpc) return false;
    try {
      const server = serverCapabilitySchema.parse(await this.rpc.request("ping", {}, 2_000));
      if (server.capabilities?.session_event_stream_v1 !== true) return false;
      return (await this.capabilities()).sessionEventRingV2;
    }
    catch { return false; }
  }

  async supportsSessionEventMultiplex(): Promise<boolean> {
    if (!this.rpc) return false;
    try {
      return serverCapabilitySchema.parse(await this.rpc.request("ping", {}, 2_000)).capabilities?.session_event_multiplex_v1 === true;
    } catch { return false; }
  }

  async supportsPaneAgentStatusAll(): Promise<boolean> {
    if (!this.rpc) return false;
    try {
      return serverCapabilitySchema.parse(await this.rpc.request("ping", {}, 2_000)).capabilities?.pane_agent_status_all_v1 === true;
    } catch { return false; }
  }

  async openSession(paneId: string): Promise<CoreSessionEventStream> {
    const result = sessionOpenedSchema.parse(await this.sessionRequest("session.events.open", { pane_id: paneId }));
    return {
      streamId: result.stream_id, terminalId: result.terminal_id, agentKind: result.agent_kind,
      sessionId: result.session_id, earliestCursor: result.earliest_cursor, latestCursor: result.latest_cursor
    };
  }

  async openSessionRing(paneId: string): Promise<CoreSessionEventRing> {
    const result = sessionRingOpenedSchema.parse(await this.sessionRequest("session.events.open.v2", { pane_id: paneId }));
    return {
      ringId: result.ring_id, epoch: result.epoch, terminalId: result.terminal_id,
      agentKind: result.agent_kind, sessionId: result.session_id,
      earliestCursor: result.earliest_cursor, latestCursor: result.latest_cursor
    };
  }

  readSession(streamId: string, after: string): Promise<CoreSessionEventReadResult> {
    return this.readSessionMethod("session.events.read", streamId, after);
  }

  readSessionRing(ringId: string, after: string): Promise<CoreSessionEventRingReadResult> {
    return this.readSessionRingMethod(ringId, after);
  }

  subscribeSession(streamId: string, after: string): Promise<CoreSessionEventReadResult> {
    return this.readSessionMethod("session.events.subscribe", streamId, after);
  }

  async sessionSubmissionReceipt(submissionId: string): Promise<CoreSessionSubmissionReceipt> {
    const result = sessionSubmissionReceiptSchema.parse(await this.sessionRequest("agent.events.submission", { submission_id: submissionId }));
    return {
      submissionId: result.submission_id, terminalId: result.terminal_id, agentKind: result.agent_kind,
      sessionId: result.session_id, state: result.state, createdAt: result.created_at, updatedAt: result.updated_at
    };
  }

  async attach(input: { paneId: string; agentKind: string; sessionId: string; path: string; from: "start" | "end" }): Promise<{ sourceId: string; attachOffset: number; sources: CoreEventSourceDescriptor[] }> {
    const result = attachedSchema.parse(await this.command([
      "attach", "--pane", input.paneId, "--kind", input.agentKind,
      "--session-id", input.sessionId, "--path", input.path, "--from", input.from
    ])).result;
    return { sourceId: result.source_id, attachOffset: result.attach_offset, sources: result.sources.map(normalizeSource) };
  }

  async listSources(): Promise<CoreEventSourceDescriptor[]> {
    return sourcesSchema.parse(await this.command(["sources"])).result.sources.map(normalizeSource);
  }

  async locate(sourceId: string, boundary: "active" | "at" | "after", turn?: { id: string; startedAt: string }): Promise<{ found: boolean; afterCursor: string }> {
    const args = ["locate", "--source", sourceId, "--boundary", boundary];
    if (turn) args.push("--turn-id", turn.id, "--started-at", turn.startedAt);
    const result = turnCursorSchema.parse(await this.command(args)).result;
    if (result.source_id !== sourceId) throw new Error("event source mismatch");
    return { found: result.found, afterCursor: result.after_cursor };
  }

  async read(sourceId: string, after: string): Promise<CoreEventBatch> {
    const result = batchSchema.parse(await this.command(["read", "--source", sourceId, "--after", after, "--limit", "128"])).result;
    if (result.events.some((event) => event.source_id !== sourceId)) throw new Error("event source mismatch");
    return { events: normalizeKnownEvents(result.events), nextCursor: result.next_cursor, latestCursor: result.latest_cursor };
  }

  async capabilities(): Promise<CoreEventCapabilities> {
    const result = capabilitiesSchema.parse(await this.command(["capabilities"])).result;
    return {
      exactTurnRecovery: result.exact_turn_recovery_v1,
      historicalTurnIndexRecovery: result.historical_turn_index_recovery_v1,
      sessionTurnEnumeration: result.session_turn_enumeration_v1,
      visibleReasoning: result.visible_reasoning_v1,
      sessionEventRingV2: result.session_event_ring_v2
    };
  }

  async submissionReceipt(submissionId: string, identity: { agentKind: "traex" | "pi"; sessionId: string }): Promise<AgentTranscriptSubmissionReceipt> {
    const result = submissionReceiptSchema.parse(await this.command(["submission", "--submission-id", submissionId])).result;
    if (result.agent_kind !== identity.agentKind || result.session_id !== identity.sessionId) throw new Error("submission identity mismatch");
    return {
      submissionId: result.submission_id,
      state: result.state,
      agentKind: result.agent_kind,
      sessionId: result.session_id,
      ...(result.turn_id ? { turnId: result.turn_id } : {}),
      ...(result.started_at ? { startedAt: result.started_at } : {}),
      ...(result.terminal_state ? { terminalState: result.terminal_state } : {})
    };
  }

  async listTurns(identity: { agentKind: "traex" | "pi"; sessionId: string }, after?: string): Promise<AgentTranscriptTurnList> {
    const args = ["turns", "--kind", identity.agentKind, "--session-id", identity.sessionId, "--limit", "128"];
    if (after) args.push("--after", after);
    const result = turnListSchema.parse(await this.command(args)).result;
    return {
      turns: result.turns.map((turn) => ({
        turnId: turn.turn_id,
        startedAt: turn.started_at,
        hasHumanMessage: turn.has_human_message,
        ...(turn.terminal_state ? { terminalState: turn.terminal_state } : {}),
        ...(turn.submission_id ? { submissionId: turn.submission_id } : {})
      })),
      ...(result.next_cursor ? { nextCursor: result.next_cursor } : {}),
      complete: result.complete
    };
  }

  async recoverTurn(input: { agentKind: "traex" | "pi"; sessionId: string; turnId: string; startedAt: string; after: string }): Promise<CoreRecoveryBatch> {
    const args = [
      "recover-turn", "--kind", input.agentKind, "--session-id", input.sessionId,
      "--turn-id", input.turnId, "--started-at", input.startedAt, "--limit", "128"
    ];
    if (input.after) args.push("--after", input.after);
    const result = recoveryBatchSchema.parse(await this.command(args)).result;
    if (result.events.some((event) => event.agent_kind !== input.agentKind || event.session_id !== input.sessionId || event.turn_id !== input.turnId)) {
      throw new Error("recovered turn identity mismatch");
    }
    const common = {
      events: normalizeKnownEvents(result.events),
      nextCursor: result.next_cursor,
      latestCursor: result.next_cursor,
      complete: result.complete
    };
    if (result.outcome === "recovered") {
      return { ...common, outcome: result.outcome, canonicalStartedAt: result.canonical_started_at };
    }
    return {
      ...common,
      outcome: result.outcome,
      ...(result.canonical_started_at ? { canonicalStartedAt: result.canonical_started_at } : {})
    };
  }

  private async command(args: string[]): Promise<unknown> {
    const { stdout } = await this.runner.run(this.executable, ["agent", "events", ...args], 2_000, undefined, AbortSignal.timeout(5_000));
    if (Buffer.byteLength(stdout) > MAX_RESPONSE_BYTES) throw new Error("oversized event response");
    return JSON.parse(stdout) as unknown;
  }

  private async readSessionMethod(method: "session.events.read" | "session.events.subscribe", streamId: string, after: string): Promise<CoreSessionEventReadResult> {
    try {
      const result = sessionBatchSchema.parse(await this.sessionRequest(method, { stream_id: streamId, after, limit: 64 }));
      if (result.stream_id !== streamId || result.events.some((event) => event.source_id !== streamId)) throw new Error("session event stream identity mismatch");
      return { outcome: "batch", batch: {
        streamId: result.stream_id, events: normalizeKnownEvents(result.events), nextCursor: result.next_cursor,
        earliestCursor: result.earliest_cursor, latestCursor: result.latest_cursor
      } };
    } catch (error) {
      const gap = cursorGap(error);
      if (gap) return gap;
      if (invalidCursor(error)) return { outcome: "invalid_cursor" };
      throw error;
    }
  }

  private async readSessionRingMethod(ringId: string, after: string): Promise<CoreSessionEventRingReadResult> {
    try {
      const result = sessionRingBatchSchema.parse(await this.sessionRequest("session.events.read.v2", { ring_id: ringId, after, limit: 128 }));
      if (result.ring_id !== ringId || result.events.some((event) => event.session_id.length === 0)) throw new Error("session event ring identity mismatch");
      return { outcome: "batch", batch: {
        ringId: result.ring_id, epoch: result.epoch, events: normalizeKnownEvents(result.events),
        nextCursor: result.next_cursor, latestCursor: result.latest_cursor, earliestCursor: result.earliest_cursor
      } };
    } catch (error) {
      const gap = cursorGap(error);
      if (gap) return gap;
      if (invalidCursor(error)) return { outcome: "invalid_cursor" };
      throw error;
    }
  }

  private sessionRequest(method: string, params: object): Promise<unknown> {
    if (!this.rpc) throw new Error("session_event_stream_v1 unavailable");
    return this.rpc.request(method, params, 5_000);
  }
}

function cursorGap(error: unknown): Extract<CoreSessionEventRingReadResult, { outcome: "cursor_expired" }> | null {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "cursor_expired" || !("details" in error)) return null;
  const parsed = z.object({
    resume_cursor: z.string().min(1).max(65_536).optional(),
    earliest_cursor: z.string().max(65_536),
    latest_cursor: z.string().max(65_536)
  }).safeParse(error.details);
  return parsed.success ? {
    outcome: "cursor_expired",
    ...(parsed.data.resume_cursor ? { resumeCursor: parsed.data.resume_cursor } : {}),
    earliestCursor: parsed.data.earliest_cursor,
    latestCursor: parsed.data.latest_cursor
  } : null;
}

function invalidCursor(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "invalid_cursor");
}
function normalizeSource(source: z.infer<typeof sourceSchema>): CoreEventSourceDescriptor {
  return {
    sourceId: source.source_id,
    terminalId: source.terminal_id,
    agentKind: source.agent_kind,
    sessionId: source.session_id,
    state: source.state,
    checkpointOffset: source.checkpoint_offset,
    latestCursor: source.latest_cursor
  };
}

function normalizeEvent(event: RawAgentEvent): AgentEvent {
  return {
    schemaVersion: event.schema_version,
    eventId: event.event_id,
    cursor: event.cursor,
    sourceId: event.source_id,
    agentKind: event.agent_kind,
    sessionId: event.session_id,
    turnId: event.turn_id,
    occurredAt: event.occurred_at,
    payload: normalizePayload(event.payload)
  };
}

function normalizeKnownEvents(events: RawAgentEventEnvelope[]): AgentEvent[] {
  const normalized: AgentEvent[] = [];
  for (const event of events) {
    const parsed = eventSchema.safeParse(event);
    if (parsed.success) {
      normalized.push(normalizeEvent(parsed.data));
      continue;
    }
    if (knownPayloadTypes.has(event.payload.type)) throw parsed.error;
  }
  return normalized;
}

function normalizePayload(payload: RawAgentEvent["payload"]): AgentEventPayload {
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
    case "context_snapshot": return normalizeContextSnapshotPayload(payload);
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

function normalizeTokenUsageGroup(group: RawTokenUsagePayload["response"]) {
  return {
    inputTokens: group.input_tokens,
    cachedInputTokens: group.cached_input_tokens,
    cacheCreationInputTokens: group.cache_creation_input_tokens,
    outputTokens: group.output_tokens,
    reasoningOutputTokens: group.reasoning_output_tokens,
    totalTokens: group.total_tokens
  };
}

function normalizeContextSnapshotPayload(payload: RawContextSnapshotPayload): AgentEventPayload {
  return {
    type: payload.type,
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.provider ? { provider: payload.provider } : {}),
    ...(payload.backend_variant ? { backendVariant: payload.backend_variant } : {}),
    ...(payload.effort ? { effort: payload.effort } : {}),
    ...(payload.cwd ? { cwd: payload.cwd } : {}),
    ...(payload.collaboration_mode ? { collaborationMode: payload.collaboration_mode } : {}),
    ...(payload.permission_mode ? { permissionMode: payload.permission_mode } : {}),
    ...(payload.current_date ? { currentDate: payload.current_date } : {}),
    ...(payload.timezone ? { timezone: payload.timezone } : {}),
    ...(payload.worktree_path ? { worktreePath: payload.worktree_path } : {}),
    ...(payload.worktree_state ? { worktreeState: payload.worktree_state } : {}),
    ...(payload.model_context_window ? { modelContextWindow: payload.model_context_window } : {}),
    ...(payload.auto_compact_limit ? { autoCompactLimit: payload.auto_compact_limit } : {})
  };
}
