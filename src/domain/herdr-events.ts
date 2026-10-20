import type { AgentTranscriptSubmissionReceipt, AgentTranscriptTurnList } from "./ports/external.js";
import type { FinalMessageCompletionChoice } from "./completion-choice.js";
import type { ChoiceSelectionRef } from "./inbound.js";

export type AgentEventPayload =
  | { type: "turn_started" }
  | { type: "turn_completed" }
  | { type: "turn_aborted"; reason: string }
  | { type: "human_message"; messageId: string; text: string; truncated: boolean; submissionId?: string; choice?: ChoiceSelectionRef }
  | { type: "message"; messageId: string; channel: string; text: string; truncated: boolean; completionChoice?: FinalMessageCompletionChoice }
  | { type: "agent_activity"; agentId: string; displayName?: string; model?: string; content?: string; contentTruncated?: boolean; resultHandoff?: "delivered_to_parent"; state: "started" | "running" | "completed" | "failed" | "interrupted" | "blocked" }
  | { type: "model_changed"; model: string }
  | { type: "context_compacted" }
  | { type: "tool_call"; callId: string; name: string; arguments: string; truncated: boolean }
  | { type: "tool_result"; callId: string; text: string; isError: boolean; truncated: boolean }
  | { type: "goal_changed"; goalId: string; objective: string; status: "active" | "paused" | "blocked" | "completed" | "budget_limited" | "usage_limited"; sourceUpdatedAt: number; truncated: boolean }
  | { type: "branch_changed"; parentId: string | null }
  | { type: "submission_receipt"; submissionId: string; state: "prepared" | "accepted" | "rejected" | "uncertain" }
  | { type: "runtime_status_changed"; paneId: string; status: string }
  | { type: "runtime_agent_changed"; paneId: string; released: boolean; finalStatus?: string }
  | { type: "runtime_ended"; paneId: string; reason: string }
  | { type: "source_error"; code: string }
  | { type: "record_skipped"; code: string };

export interface AgentEvent {
  schemaVersion: 1;
  eventId: string;
  cursor: string;
  sourceId: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  turnId: string | null;
  occurredAt: string;
  payload: AgentEventPayload;
}

export interface CoreEventSourceDescriptor {
  sourceId: string;
  terminalId: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  state: string;
  checkpointOffset: number;
  latestCursor: string;
}

export interface CoreEventCapabilities {
  exactTurnRecovery: boolean;
  historicalTurnIndexRecovery: boolean;
  sessionTurnEnumeration: boolean;
  visibleReasoning: boolean;
    sessionEventRingV2: boolean;
}

export interface CoreSessionEventRing {
  ringId: string;
  epoch: string;
  terminalId: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  earliestCursor: string;
  latestCursor: string;
}

export interface CoreSessionEventMultiplexTarget {
  ringId: string;
  epoch: string;
  after: string;
  limit: number;
}

export interface CoreSessionEventMultiplexAck {
  targetCount: number;
}

export interface CoreSessionEventMultiplexBatch extends CoreEventBatch {
  ringId: string;
  epoch: string;
  earliestCursor: string;
}

export type CoreSessionEventMultiplexGap =
  | { ringId: string; epoch: string; code: "cursor_expired"; resumeCursor: string; earliestCursor: string; latestCursor: string }
  | { ringId: string; epoch: string; code: "epoch_changed"; currentEpoch: string }
  | { ringId: string; epoch: string; code: "missing" }
  | { ringId: string; epoch: string; code: "unavailable" };

export type CoreSessionEventMultiplexFrame =
  | { outcome: "batch"; batch: CoreSessionEventMultiplexBatch }
  | { outcome: "gap"; gap: CoreSessionEventMultiplexGap };

export interface CoreSessionEventRingBatch extends CoreEventBatch {
  ringId: string;
  epoch: string;
  earliestCursor: string;
}

export type CoreSessionEventRingReadResult =
  | { outcome: "batch"; batch: CoreSessionEventRingBatch }
  | { outcome: "cursor_expired"; resumeCursor?: string; earliestCursor: string; latestCursor: string }
  | { outcome: "invalid_cursor" };

export interface CoreSessionEventStream {
  streamId: string;
  terminalId: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  earliestCursor: string;
  latestCursor: string;
}

export interface CoreSessionEventBatch extends CoreEventBatch {
  streamId: string;
  earliestCursor: string;
}

export type CoreSessionEventReadResult =
  | { outcome: "batch"; batch: CoreSessionEventBatch }
  | { outcome: "cursor_expired"; resumeCursor?: string; earliestCursor: string; latestCursor: string }
  | { outcome: "invalid_cursor" };

export interface CoreSessionCursorFailureContext {
  laneId: string;
  sourceId: string;
  sourceEpoch: string | null;
  agentKind: "traex" | "pi";
  sessionId: string;
  readCursor: string;
  owner: { kind: "binding" | "worker_turn"; id: string };
}

export class CoreSessionInvalidCursorError extends Error {
  readonly laneId: string;
  readonly sourceId: string;
  readonly sourceEpoch: string | null;
  readonly agentKind: "traex" | "pi";
  readonly sessionId: string;
  readonly readCursor: string;
  readonly owner: { kind: "binding" | "worker_turn"; id: string };

  constructor(context: CoreSessionCursorFailureContext) {
    super("Core session event cursor is invalid");
    this.name = "CoreSessionInvalidCursorError";
    this.laneId = context.laneId;
    this.sourceId = context.sourceId;
    this.sourceEpoch = context.sourceEpoch;
    this.agentKind = context.agentKind;
    this.sessionId = context.sessionId;
    this.readCursor = context.readCursor;
    this.owner = context.owner;
  }
}

export class CoreSessionUnrecoverableCursorError extends Error {
  readonly laneId: string;
  readonly sourceId: string;
  readonly sourceEpoch: string | null;
  readonly agentKind: "traex" | "pi";
  readonly sessionId: string;
  readonly readCursor: string;
  readonly owner: { kind: "binding" | "worker_turn"; id: string };

  constructor(context: CoreSessionCursorFailureContext) {
    super("Core session event cursor remained invalid after verified reopen");
    this.name = "CoreSessionUnrecoverableCursorError";
    this.laneId = context.laneId;
    this.sourceId = context.sourceId;
    this.sourceEpoch = context.sourceEpoch;
    this.agentKind = context.agentKind;
    this.sessionId = context.sessionId;
    this.readCursor = context.readCursor;
    this.owner = context.owner;
  }
}

export interface CoreSessionSubmissionReceipt {
  submissionId: string;
  terminalId: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  state: "prepared" | "accepted" | "rejected" | "uncertain";
  createdAt: number;
  updatedAt: number;
}

export interface CoreEventBatch {
  events: AgentEvent[];
  nextCursor: string;
  latestCursor: string;
  complete?: boolean;
}

export type CoreRecoveryBatch =
  | (CoreEventBatch & { outcome: "recovered"; canonicalStartedAt: string; complete: boolean })
  | (CoreEventBatch & { outcome: "indexing" | "not_found" | "ambiguous"; canonicalStartedAt?: string; complete: boolean });

export interface HerdrEventsPort {
  supportsSessionEventStream(): Promise<boolean>;
  supportsSessionEventRingV2(): Promise<boolean>;
  supportsSessionEventMultiplex(): Promise<boolean>;
  supportsPaneAgentStatusAll(): Promise<boolean>;
  openSession(paneId: string): Promise<CoreSessionEventStream>;
  openSessionRing(paneId: string): Promise<CoreSessionEventRing>;
  readSession(streamId: string, after: string): Promise<CoreSessionEventReadResult>;
  readSessionRing(ringId: string, after: string): Promise<CoreSessionEventRingReadResult>;
  subscribeSession(streamId: string, after: string): Promise<CoreSessionEventReadResult>;
  sessionSubmissionReceipt(submissionId: string): Promise<CoreSessionSubmissionReceipt>;
  attach(input: { paneId: string; agentKind: string; sessionId: string; path: string; from: "start" | "end" }): Promise<{
    sourceId: string;
    attachOffset: number;
    sources: CoreEventSourceDescriptor[];
  }>;
  listSources(): Promise<CoreEventSourceDescriptor[]>;
  locate(sourceId: string, boundary: "active" | "at" | "after", turn?: { id: string; startedAt: string }): Promise<{ found: boolean; afterCursor: string }>;
  read(sourceId: string, after: string): Promise<CoreEventBatch>;
  capabilities(): Promise<CoreEventCapabilities>;
  submissionReceipt(submissionId: string, identity: { agentKind: "traex" | "pi"; sessionId: string }): Promise<AgentTranscriptSubmissionReceipt>;
  listTurns(identity: { agentKind: "traex" | "pi"; sessionId: string }, after?: string): Promise<AgentTranscriptTurnList>;
  recoverTurn(input: { agentKind: "traex" | "pi"; sessionId: string; turnId: string; startedAt: string; after: string }): Promise<CoreRecoveryBatch>;
}
