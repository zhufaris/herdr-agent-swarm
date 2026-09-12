import type { AgentState, HerdrAgentSession, HerdrPane, HerdrPaneCreationOptions, IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult, RuntimeObservation, RuntimeTurnObservation } from "../types.js";
import type { RunProgressEvent } from "../run-card-view.js";
import type { ModelDispatch, TraexModelSummary } from "../model-selection.js";

export interface TraexModelPromptDispatchOptions {
  modelDispatch: ModelDispatch;
  agentSession: HerdrAgentSession;
  onPrepared(operationId: string): void | Promise<void>;
  onPrepareAborted?(operationId: string): void | Promise<void>;
  onAccepted?(receipt: { operationId: string; turnId: string }): void | Promise<void>;
}

export interface TraexControlPort {
  listModels(agentSession: HerdrAgentSession): Promise<TraexModelSummary[]>;
  runModelPrompt(target: string, text: string, options: TraexModelPromptDispatchOptions, signal?: AbortSignal, onDispatched?: () => void | Promise<void>): Promise<{ operationId: string; turnId: string }>;
}

export interface LarkPort {
  start(onMessage: (message: IncomingLarkMessage) => Promise<void>, onCardAction?: (action: IncomingLarkCardAction) => Promise<LarkCardActionResult | void>): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  createTopic(card: object, idempotencyKey?: string, targetChatId?: string): Promise<{ topicId: string; rootMessageId: string }>;
  replyText(rootMessageId: string, text: string, idempotencyKey?: string): Promise<{ messageId: string }>;
  replyCard(rootMessageId: string, card: object, idempotencyKey?: string): Promise<{ messageId: string }>;
  replyStreamingCard?(rootMessageId: string, card: object): Promise<{ messageId: string; cardId: string }>;
  createStreamingCard?(card: object): Promise<{ cardId: string }>;
  replyStreamingCardReference?(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<{ messageId: string }>;
  streamCardContent?(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  finishStreamingCard?(cardId: string, sequence: number, summary: string): Promise<void>;
  shareThread(topicOrRootMessageId: string, target: { messageId: string; chatId: string }): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
  updateCardKit?(messageId: string, card: object, sequence: number): Promise<void>;
}

export interface HerdrPort {
  assertWorkspace(workspaceId: string, expectedSpaceName?: string): Promise<void>;
  listAllPanes?(): Promise<HerdrPane[]>;
  listPanes(workspaceId: string, options?: { forceRefresh?: boolean }): Promise<HerdrPane[]>;
  getPane(paneId: string): Promise<HerdrPane | null>;
  observeRuntime(paneId: string): Promise<RuntimeObservation>;
  waitForRuntimeChange?(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  createPane(workspaceId: string, cwd: string, options?: HerdrPaneCreationOptions): Promise<HerdrPane>;
  startTraex(paneId: string, executable: string, args?: string[]): Promise<void>;
  startAgent?(paneId: string, input: { name: string; kind: "pi" | "claude" | "codex" | "traex"; executable: string; args?: string[] }): Promise<void>;
  runPrompt(paneId: string, text: string, timeoutMs: number, onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>, signal?: AbortSignal, onDispatched?: () => void | Promise<void>): Promise<AgentState>;
  waitForAgent?(paneId: string, timeoutMs: number, onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>, signal?: AbortSignal): Promise<AgentState>;
  interruptAgent?(input: { paneId: string; agentSession: HerdrAgentSession; runtimeTurnId: string; idempotencyKey: string }): Promise<import("../agent-runtime.js").InterruptReceipt>;
  sendEscape?(paneId: string): Promise<void>;
  renamePane(paneId: string, title: string, options?: { tabTitle?: string }): Promise<void>;
  closePane(paneId: string): Promise<void>;
}

export interface TraexTranscriptCursorPort {
  readDelta(): Promise<string>;
  readObservation?(): Promise<TraexTranscriptObservation>;
}

export interface TraexTranscriptPlanStep {
  key: string;
  label: string;
  state: "pending" | "active" | "done";
}

export interface TraexTranscriptMainStatus {
  statusTitle?: string;
  planSteps?: TraexTranscriptPlanStep[];
  tokenCount?: number;
}

export interface TraexTranscriptObservation {
  turnId?: string;
  freshTurnStart?: boolean;
  requestText?: string;
  answerDelta: string;
  toolActivities?: Omit<RunProgressEvent, "occurredAt">[];
  mainStatus?: TraexTranscriptMainStatus;
  turnLifecycle?: { turnId: string; state: "active" | "completed" | "aborted"; startedAt: string; finalAnswer?: string; reason?: string };
}

export type TraexTranscriptUnavailableReason = "missing_session_identity" | "unsupported_session_identity" | "transcript_not_found" | "ambiguous_transcript" | "turn_boundary_not_found" | "turn_boundary_incomplete" | "transcript_validation_failed";
export type TraexTranscriptOpenResult = { mode: "typed"; cursor: TraexTranscriptCursorPort } | { mode: "unavailable"; reason: TraexTranscriptUnavailableReason };

export interface TraexTranscriptReaderPort {
  open(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptOpenResult>;
  openActiveTurn?(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptOpenResult>;
  openFirstTurn?(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptOpenResult>;
  openAtTurn?(session: HerdrAgentSession | null | undefined, turnId: string, startedAt: string): Promise<TraexTranscriptOpenResult>;
  openAfterTurn?(session: HerdrAgentSession | null | undefined, turnId: string, startedAt: string): Promise<TraexTranscriptOpenResult>;
}
