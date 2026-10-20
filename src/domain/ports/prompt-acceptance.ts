import type { Binding } from "../binding.js";
import type { ExternalTurnAdoption, ExternalTurnSupersessionFence, HerdrAgentSession } from "../types.js";
import type { ModelDispatch } from "../model-selection.js";
import type { DurablePromptWorkScan, PromptJob, StalePromptClaim, TranscriptTurnClaimOutcome } from "../prompt.js";
import type { RunCardView } from "../run-card-view.js";
import type { BridgeEvent } from "../events.js";
import type { CurrentGoal } from "../current-goal.js";
import type { AgentTranscriptObservation } from "./external.js";
import type { ChoicePrompt } from "../completion-choice.js";
import type { CompletionActionIgnoreResult, CompletionActionSelection } from "../completion-action-set.js";
import type { AcceptCollectingNativeInputInput, AcceptImmediateNativeInputBatchInput, FormDueNativeInputBatchInput, NativeInputBacklog, NativeInputBatchAcceptanceResult, NativeInputBatchFormationResult, NativeInputCollectionResult } from "../native-input-batch.js";

export interface ClaimedPrompt { binding: Binding; prompt: PromptJob; executionBody: string; model: ModelDispatch | null; nativeInputBatch: boolean }
export type DetachedPromptSkipResult = { outcome: "skipped"; promptId: string; outboxReserved: boolean } | { outcome: "none" | "stale" };
export interface ManagedPromptInput {
  binding: Binding;
  body: string;
  actor: { openId: string };
  ingressSource: PromptJob["ingressSource"];
  sourceMessageKey: string;
  larkMessageId: string | null;
  parentPromptId?: string | null;
  priority?: PromptJob["priority"];
  initialProjectionContext: { rootMessageId: string };
}
export interface AcceptedPromptSourceIdentity {
  ingressSource: "feishu";
  sourceMessageKey: string;
}
export interface ManagedContinuationInput {
  binding: Binding;
  interactionId: string;
  parentPromptId: string;
  sourceAnswerMessageId: string;
  body: string;
  actor: { openId: string };
  initialProjectionContext: { rootMessageId: string };
}
export interface ManagedPrimaryCompletionActionInput {
  binding: Binding;
  actionSetId: string;
  selection?: CompletionActionSelection;
  optionId?: string;
  ownerPromptId: string;
  ownerGeneration: number;
  cardMessageId: string;
  actor: { openId: string };
  initialProjectionContext: { rootMessageId: string };
}
export type ManagedPrimaryCompletionIgnoreInput = Omit<ManagedPrimaryCompletionActionInput, "selection" | "optionId" | "initialProjectionContext">;
export interface AcceptPromptInput {
  prompt: Omit<PromptJob, "sessionEpoch" | "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "priority" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin" | "parentPromptId" | "ingressSource" | "sourceMessageKey"> & Partial<Pick<PromptJob, "priority" | "wasDetached" | "executionOrigin" | "parentPromptId" | "ingressSource" | "sourceMessageKey">>;
  view: RunCardView; rootMessageId: string; answerCard: object; maxQueueDepth?: number; expectedBindingGeneration?: number;
}
export interface InterruptedContinuationAcceptanceInput {
  interactionId: string;
  parentPromptId: string;
  sourceAnswerMessageId: string;
  expectedBindingGeneration: number;
  actorOpenId: string;
  accepted: AcceptPromptInput;
}
export interface PrimaryCompletionActionAcceptanceInput {
  actionSetId: string;
  selection?: CompletionActionSelection;
  optionId?: string;
  ownerPromptId: string;
  ownerGeneration: number;
  cardMessageId: string;
  actorOpenId: string;
  accepted: AcceptPromptInput;
}
export type PromptAcceptanceEffect =
  | { kind: "outbound-wake" }
  | { kind: "prompt-wake"; bindingId: string }
  | { kind: "answer-converge"; promptId: string }
  | { kind: "lifecycle-event"; event: BridgeEvent };
export interface PromptAcceptanceReceipt {
  readonly result: { prompt: PromptJob; view: RunCardView; inserted: boolean };
  readonly commitState: "pending" | "committed" | "rolled_back";
  consumeEffects(): readonly PromptAcceptanceEffect[];
}
export interface NativeInputCollectionReceipt {
  readonly result: NativeInputCollectionResult & { prompt: null; view: null };
  readonly commitState: "committed";
  consumeEffects(): readonly PromptAcceptanceEffect[];
}
export interface PromptAcceptanceStore {
  getCurrentGoal(bindingId: string): CurrentGoal | null;
  acceptPrompt(input: AcceptPromptInput): { prompt: PromptJob; view: RunCardView; inserted: boolean };
  acceptPromptWithEffects(input: AcceptPromptInput): PromptAcceptanceReceipt;
  acceptImmediateNativeInputBatch(input: AcceptImmediateNativeInputBatchInput): NativeInputBatchAcceptanceResult;
  acceptCollectingNativeInput(input: AcceptCollectingNativeInputInput): NativeInputCollectionResult;
  formDueNativeInputBatch(input: FormDueNativeInputBatchInput): NativeInputBatchFormationResult;
  hasAcceptedPromptSource(identity: AcceptedPromptSourceIdentity): boolean;
  getNativeInputBacklog(bindingId: string, bindingGeneration: number): NativeInputBacklog;
  acceptInterruptedContinuation(input: InterruptedContinuationAcceptanceInput): PromptAcceptanceReceipt;
  acceptPrimaryCompletionAction(input: PrimaryCompletionActionAcceptanceInput): PromptAcceptanceReceipt;
  ignorePrimaryCompletionAction(input: { actionSetId: string; ownerPromptId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string }): CompletionActionIgnoreResult;
  resolvePrimaryCompletionChoice(input: { actionSetId: string; optionId: string; ownerPromptId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string }): { label: string; message: string };
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  countPendingPrompts(bindingId: string): number;
}
export interface NativeTurnAdoptionInput {
  binding: Binding;
  session: HerdrAgentSession;
  turnId: string;
  startedAt: string;
  requestText: string;
  requestSubmissionId?: string;
  supersede?: ExternalTurnSupersessionFence;
}
export interface PromptCoreObservationOutput {
  emitted?: boolean;
  text: string;
  truncated: boolean;
  terminalLifecycle?: NonNullable<AgentTranscriptObservation["turnLifecycle"]>;
}
export interface PromptCoreObservationState {
  pendingStarts: Map<string, string>;
  promptsByTurn: Map<string, { promptId: string; output: PromptCoreObservationOutput }>;
}
export type PromptCoreObservation =
  | {
    origin: "bridge";
    binding: Binding;
    prompt: PromptJob;
    observation: AgentTranscriptObservation;
    output: PromptCoreObservationOutput;
    elapsedSeconds?: number;
    settleTerminal?: boolean;
    terminalAnswer?: string;
    replaceTerminalAnswer?: boolean;
    settlement?:
      | { kind: "completed"; answer: string; sourceAnswer: string; completionChoice?: ChoicePrompt; replaceAnswer?: boolean }
      | { kind: "failed"; error: string; eventOrigin?: import("../types.js").EventOrigin }
      | { kind: "detached"; notice: string };
  }
  | {
    origin: "herdr";
    binding: Binding;
    session: HerdrAgentSession;
    observation: AgentTranscriptObservation;
    state: PromptCoreObservationState;
    supersede?: ExternalTurnSupersessionFence;
  };
export type PromptObservationReceipt =
  | { outcome: "ignored" | "pending"; owned: false; terminal: null; prompt: PromptJob | null; output?: PromptCoreObservationOutput }
  | { outcome: "projected" | "observing" | "completed"; owned: false; terminal: "completed" | "aborted" | null; prompt: null; output: PromptCoreObservationOutput; supersededPromptIds?: string[]; outboxReserved?: boolean }
  | { outcome: "projected" | "observing" | "completed" | "detached"; owned: true; terminal: "completed" | "aborted" | null; prompt: PromptJob; output: PromptCoreObservationOutput; supersededPromptIds?: string[]; outboxReserved?: boolean };
export interface BindingPromptWorkflowPort {
  acceptManagedInput(input: ManagedPromptInput): Promise<PromptAcceptanceReceipt | NativeInputCollectionReceipt | null>;
  drainDueNativeInputBatch(bindingId: string, occurredAt?: string): Promise<{ outcome: "none" | "not_due" | "formed"; nextDueAt: string | null }>;
  acceptInterruptedContinuation(input: ManagedContinuationInput): Promise<PromptAcceptanceReceipt>;
  acceptPrimaryCompletionAction(input: ManagedPrimaryCompletionActionInput): Promise<PromptAcceptanceReceipt>;
  ignorePrimaryCompletionAction(input: ManagedPrimaryCompletionIgnoreInput): Promise<CompletionActionIgnoreResult>;
  adoptNativeTurn(input: NativeTurnAdoptionInput): ExternalTurnAdoption;
  applyCoreObservation(input: PromptCoreObservation): Promise<PromptObservationReceipt>;
}
export type { DurablePromptWorkScan, StalePromptClaim, TranscriptTurnClaimOutcome };
