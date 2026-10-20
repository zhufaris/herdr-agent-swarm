import type { AgentKind } from "../agent-instance.js";
import type { AgentState, HerdrActiveTurn, HerdrAgentSession, HerdrPane, HerdrPaneCreationOptions, IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult, RuntimeObservation, RuntimeTurnObservation } from "../types.js";
import type { RunProgressEvent } from "../run-card-view.js";
import type { TraexModelSummary } from "../model-selection.js";
import type { AnswerTimelineDelta } from "../answer-timeline.js";
import type { GoalChange } from "../current-goal.js";
import type { CoreEventProjectionSettlement } from "../core-event-inbox.js";
import type { ChoicePrompt } from "../completion-choice.js";
import type { SessionRotationRequest, SessionRotationResult } from "../orchestrator-clear.js";
import type { SessionActivityProjectionContext } from "../session-activity.js";
import type { PaneTopologyLabelRequest, PaneTopologyMoveReceipt, PaneTopologyMoveRequest } from "../pane-topology-intent.js";

export interface TraexControlPort {
  listModels(agentSession: HerdrAgentSession): Promise<TraexModelSummary[]>;
}

export interface NativePromptSubmissionReceipt {
  submissionId: string;
  terminalId: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  state: "prepared" | "accepted" | "rejected" | "uncertain";
  createdAt: number;
  updatedAt: number;
}

export interface NativePromptSubmissionResult {
  submissionId: string;
  receipt?: NativePromptSubmissionReceipt;
}

export interface LarkPort {
  start(onMessage: (message: IncomingLarkMessage) => Promise<void>, onCardAction?: (action: IncomingLarkCardAction) => Promise<LarkCardActionResult | void>): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  ingressStatus?(): { state: string; receivedEvents: number; lastReceivedAt: string | null; lastAcceptedAt: string | null };
  createTopic(card: object, idempotencyKey?: string, targetChatId?: string): Promise<{ topicId: string; rootMessageId: string }>;
  replyText(rootMessageId: string, text: string, idempotencyKey?: string): Promise<{ messageId: string }>;
  replyCard(rootMessageId: string, card: object, idempotencyKey?: string): Promise<{ messageId: string }>;
  replyStreamingCard?(rootMessageId: string, card: object): Promise<{ messageId: string; cardId: string }>;
  createStreamingCard?(card: object): Promise<{ cardId: string }>;
  replyStreamingCardReference?(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<{ messageId: string }>;
  streamCardContent?(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  finishStreamingCard?(cardId: string, sequence: number, summary: string): Promise<void>;
  shareThread(topicOrRootMessageId: string, target: { messageId: string; chatId: string; sourceRootMessageId?: string }): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
  updateCardKit?(messageId: string, card: object, sequence: number): Promise<void>;
  deleteMessage?(messageId: string): Promise<"deleted" | "already_absent">;
}

export interface HerdrPort {
  assertWorkspace(workspaceId: string, expectedSpaceName?: string): Promise<void>;
  listWorkspaces?(): Promise<HerdrWorkspace[]>;
  listAllPanes?(options?: { forceRefresh?: boolean }): Promise<HerdrPane[]>;
  listPanes(workspaceId: string, options?: { forceRefresh?: boolean; skipAllWorkspaceSnapshot?: boolean }): Promise<HerdrPane[]>;
  getPane(paneId: string): Promise<HerdrPane | null>;
  getActiveTurn?(paneId: string): Promise<HerdrActiveTurn | null>;
  observeRuntime(paneId: string): Promise<RuntimeObservation>;
  observeRuntimes?(paneIds: readonly string[]): Promise<ReadonlyMap<string, RuntimeObservation>>;
  waitForRuntimeChange?(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  createPane(workspaceId: string, cwd: string, options?: HerdrPaneCreationOptions): Promise<HerdrPane>;
  movePane?(input: PaneTopologyMoveRequest): Promise<PaneTopologyMoveReceipt>;
  labelPane?(input: PaneTopologyLabelRequest): Promise<PaneTopologyMoveReceipt>;
  supportsPaneCreationV2?(): Promise<boolean>;
  createPaneV2?(input: PaneCreationV2Request): Promise<PaneCreationV2Result>;
  supportsPaneIdentityReconcileV1?(): Promise<boolean>;
  reconcilePaneIdentityV1?(input: PaneIdentityReconcileV1Request): Promise<PaneIdentityReconcileV1Result>;
  startTraex(paneId: string, executable: string, args?: string[]): Promise<void>;
  startAgent?(paneId: string, input: { name: string; kind: "pi" | "claude" | "codex" | "traex"; executable: string; args?: string[]; useConfiguredPermissionMode?: boolean; rotatable?: boolean }): Promise<void>;
  runPrompt(paneId: string, text: string, timeoutMs: number, onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>, signal?: AbortSignal, onDispatched?: () => void | Promise<void>): Promise<AgentState>;
  supportsPromptQueue?(): Promise<boolean>;
  queuePrompt?(paneId: string, text: string, input: { submissionId: string; expectedSessionId: string }, signal?: AbortSignal): Promise<NativePromptSubmissionResult>;
  supportsModelPrompt?(): Promise<boolean>;
  queueModelPrompt?(paneId: string, text: string, input: { model: string; submissionId: string; expectedSessionId: string }, signal?: AbortSignal): Promise<NativePromptSubmissionResult>;
  waitForAgent?(paneId: string, timeoutMs: number, onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>, signal?: AbortSignal): Promise<AgentState>;
  interruptAgent?(input: { paneId: string; agentSession: HerdrAgentSession; runtimeTurnId: string; idempotencyKey: string }): Promise<import("../agent-runtime.js").InterruptReceipt>;
  supportsSessionRotation?(): Promise<boolean>;
  rotateSession?(input: SessionRotationRequest): Promise<SessionRotationResult>;
  sendEscape?(paneId: string): Promise<void>;
  renamePane(paneId: string, title: string, options?: { tabTitle?: string }): Promise<void>;
  closePane(paneId: string): Promise<void>;
}

export interface HerdrWorkspace {
  workspaceId: string;
  label: string;
}

export interface PaneCreationV2Request {
  workspaceId: string;
  expectedWorkspaceLabel: string;
  token: string;
  cwd: string;
  options: HerdrPaneCreationOptions;
}

export interface PaneCreationReceipt {
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
  token: string;
}

export interface CoreCapabilityUnavailable {
  outcome: "capability-unavailable";
  capability: "tab.create.v2" | "pane.identity_reconcile.v1" | "agent.session_rotate.v1";
  reason: string;
}

export interface CoreOperationRejected {
  outcome: "token-conflict" | "stale-fence" | "label-mismatch" | "rejected";
  code: string;
  reason: string;
}

export interface CoreOperationUncertain {
  outcome: "uncertain";
  code: "transport_timeout" | "transport_failure" | "pane_identity_reconcile_uncertain";
  reason: string;
}

export interface CoreMalformedResponse {
  outcome: "malformed-response";
  code: "malformed_json" | "invalid_response";
  reason: string;
}

export type PaneCreationV2Result =
  | { outcome: "created"; receipt: PaneCreationReceipt }
  | CoreCapabilityUnavailable
  | CoreOperationRejected
  | CoreOperationUncertain
  | CoreMalformedResponse;

export interface PaneIdentity {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  token: string;
}

export interface PaneIdentityReconcileV1Request {
  operationId: string;
  expected: PaneIdentity;
  target: { workspaceId: string; expectedWorkspaceLabel: string; token: string };
}

export interface PaneIdentityReconcileReceipt {
  operationId: string;
  disposition: "applied" | "already-converged";
  previous: PaneIdentity;
  current: PaneIdentity;
}

export type PaneIdentityReconcileV1Result = {
  outcome: "applied" | "already-converged";
  receipt: PaneIdentityReconcileReceipt;
} | CoreCapabilityUnavailable | CoreOperationRejected | CoreOperationUncertain | CoreMalformedResponse;

export interface AgentTranscriptCursorPort {
  readDelta(): Promise<string>;
  readObservation?(): Promise<AgentTranscriptObservation>;
  acknowledge?(outcome: "projected" | "ignored" | "quarantined", error?: string): void | Promise<void>;
}

export interface AgentTranscriptPlanStep {
  key: string;
  label: string;
  state: "pending" | "active" | "done";
}

export interface AgentTranscriptMainStatus {
  statusTitle?: string;
  planSteps?: AgentTranscriptPlanStep[];
  tokenCount?: number;
}

export interface AgentTranscriptProjectionState {
  planSteps?: AgentTranscriptPlanStep[];
  goalChanges?: GoalChange[];
}

export interface AgentTranscriptObservation {
  turnId?: string;
  freshTurnStart?: boolean;
  requestText?: string;
  requestMessageId?: string;
  requestSubmissionId?: string;
  answerDelta: string;
  model?: string;
  timelineDeltas?: AnswerTimelineDelta[];
  toolActivities?: Omit<RunProgressEvent, "occurredAt">[];
  mainStatus?: AgentTranscriptMainStatus;
  goalChanges?: GoalChange[];
  turnLifecycle?: { turnId: string; state: "active" | "completed" | "aborted"; startedAt: string; finalAnswer?: string; completionChoice?: ChoicePrompt; reason?: string };
  coreEventSettlement?: CoreEventProjectionSettlement;
  authoritativeSnapshot?: {
    agentKind: "traex" | "pi";
    sessionId: string;
    turnId: string;
    requestedStartedAt: string;
    canonicalStartedAt: string;
  };
}

export type AgentTranscriptUnavailableReason = "missing_session_identity" | "unsupported_session_identity" | "transcript_not_found" | "ambiguous_transcript" | "turn_boundary_not_found" | "turn_boundary_incomplete" | "transcript_validation_failed" | "cursor_expired" | "recovery_indexing" | "recovery_not_found" | "recovery_ambiguous" | "recovery_capability_unavailable" | "recovery_transient_failure";
export type AgentTranscriptOpenResult =
  | { mode: "typed"; cursor: AgentTranscriptCursorPort; recoveredIdentity?: { turnId: string; canonicalStartedAt: string } }
  | { mode: "unavailable"; reason: AgentTranscriptUnavailableReason };
export interface AgentTranscriptSource {
  agentKind: AgentKind;
  bindingId: string;
  generation: number;
  coreEventOwner?: { kind: "binding" | "worker_turn"; id: string };
  sessionActivityContext?: SessionActivityProjectionContext;
  paneId?: string | null;
  terminalId?: string | null;
  nativeSession: HerdrAgentSession | null;
}

export interface AgentTranscriptReaderPort {
  open(source: AgentTranscriptSource): Promise<AgentTranscriptOpenResult>;
  openActiveTurn?(source: AgentTranscriptSource): Promise<AgentTranscriptOpenResult>;
  openFirstTurn?(source: AgentTranscriptSource): Promise<AgentTranscriptOpenResult>;
  openAtTurn?(source: AgentTranscriptSource, turnId: string, startedAt: string): Promise<AgentTranscriptOpenResult>;
  openAfterTurn?(source: AgentTranscriptSource, turnId: string, startedAt: string): Promise<AgentTranscriptOpenResult>;
  getSubmissionReceipt?(source: AgentTranscriptSource, submissionId: string): Promise<AgentTranscriptSubmissionReceipt | null>;
  getNativeSubmissionReceipt?(source: AgentTranscriptSource, submissionId: string): Promise<NativePromptSubmissionReceipt | null>;
  listSessionTurns?(source: AgentTranscriptSource, after?: string): Promise<AgentTranscriptTurnList>;
  /** Rebuilds only owner-view state from already-settled exact-turn Core
   * evidence. It cannot replay prompt/answer/tool output or settle a turn. */
  replayProjectedTurnState?(source: AgentTranscriptSource, turnId: string, startedAt: string): Promise<AgentTranscriptProjectionState | null>;
}

export interface AgentTranscriptSubmissionReceipt {
  submissionId: string;
  state: "prepared" | "observed" | "terminal" | "cancelled" | "legacy_unavailable";
  agentKind: "traex" | "pi";
  sessionId: string;
  turnId?: string;
  startedAt?: string;
  terminalState?: string;
}

export interface AgentTranscriptTurnSummary {
  turnId: string;
  startedAt: string;
  terminalState?: string;
  hasHumanMessage: boolean;
  submissionId?: string;
}

export interface AgentTranscriptTurnList {
  turns: AgentTranscriptTurnSummary[];
  nextCursor?: string;
  complete: boolean;
}
