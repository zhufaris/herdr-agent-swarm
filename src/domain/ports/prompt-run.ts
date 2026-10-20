import type { Binding } from "../binding.js";
import type { DurablePromptWorkScan, PromptJob, PromptTranscriptTurn, StalePromptClaim, TranscriptTurnAdoptionOutcome, TranscriptTurnClaimOutcome, UndispatchedPromptClaimFence } from "../prompt.js";
import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { SessionTransition } from "../pane-thread-lifecycle.js";
import type { ModelDispatchEvidenceCommand } from "../model-selection.js";
import type { ClaimedPrompt, DetachedPromptSkipResult } from "./prompt-acceptance.js";
import type { PrimaryPromptStateObservationInput, PrimaryPromptStateObservationResult } from "../human-review.js";
import type { CompletionActionEligibilityReservation } from "../completion-action-eligibility.js";
import type { ChoicePrompt } from "../completion-choice.js";

export interface PrimaryCompletionResult {
  binding: Binding;
  completionActionEligibility: CompletionActionEligibilityReservation;
}

export interface AdvanceDetachedPromptRecoveryInput {
  promptId: string; bindingId: string; expectedBindingGeneration: number; expectedPaneId: string; expectedNativeSessionId: string;
  expiredBefore: string; reason: string; occurredAt: string; renderRunCard(view: RunCardView): object;
}

export type DetachedPromptRecoveryResult =
  | { outcome: "stale" }
  | { outcome: "deferred" | "observed"; attemptCount: number; nextAttemptAt: string }
  | { outcome: "skipped"; promptId: string; outboxReserved: boolean; attemptCount: number };

export type ProjectedBridgeTurnRecoveryResult =
  | { outcome: "recovered"; terminalState: "completed"; answer: string; turnId: string; completionActionEligibility?: CompletionActionEligibilityReservation }
  | { outcome: "recovered"; terminalState: "aborted"; error: string; turnId: string }
  | { outcome: "recovered"; terminalState: "completed"; answer: string; turnId: string; recoveryMode: "late"; outboxReserved: boolean; completionActionEligibility?: CompletionActionEligibilityReservation }
  | { outcome: "recovered"; terminalState: "aborted"; error: string; turnId: string; recoveryMode: "late"; outboxReserved: boolean }
  | { outcome: "needs_human"; outboxReserved: boolean }
  | { outcome: "not_found" | "stale" | "turn_owned_by_other_prompt" };

export interface ProjectedBridgeTurnRecoveryInput {
  promptId: string; bindingId: string; expectedBindingGeneration: number; expectedPaneId: string; expectedNativeSessionId: string; occurredAt: string;
  renderRunCard?(view: RunCardView): object;
}

export interface DetachedPromptNeedsHumanInput {
  promptId: string; bindingId: string; expectedBindingGeneration: number; expectedPaneId: string; expectedNativeSessionId: string;
  reason: string; occurredAt: string; renderRunCard(view: RunCardView): object;
}

export type DetachedPromptNeedsHumanResult =
  | { outcome: "needs_human"; outboxReserved: boolean }
  | { outcome: "stale" };

export interface PromptDispatchStore {
  getBinding(id: string): Binding | null;
  getPrompt(id: string): PromptJob | null;
  getActiveOrdinaryPrompt(bindingId: string, expectedGeneration: number): PromptJob | null;
  claimNextDispatchablePrompt(bindingId: string, options?: { nativeInputBatchOnly?: boolean }): ClaimedPrompt | null;
  markPromptDispatched(id: string, dispatchedAt: string): void;
  fencePromptNativeSubmission(input: { promptId: string; bindingId: string; submissionId: string; dispatchedAt: string }): boolean;
  markPromptNativeQueued(input: { promptId: string; bindingId: string; submissionId: string; dispatchedAt: string; uncertainReason?: string }): boolean;
  applyPromptNativeSubmissionReceipt(input: { promptId: string; bindingId: string; submissionId: string; dispatchedAt: string; state: "accepted" | "uncertain"; notice: string }): boolean;
  releaseRejectedNativeSubmission(input: { promptId: string; bindingId: string; submissionId: string; dispatchedAt: string }): boolean;
  recordModelDispatchEvidence(input: ModelDispatchEvidenceCommand): boolean;
  claimPromptTranscriptTurn(input: { promptId: string; bindingId: string; turnId: string; startedAt: string }): TranscriptTurnClaimOutcome;
  listPromptTranscriptTurns(promptId: string): PromptTranscriptTurn[];
  adoptPromptTranscriptContinuation(input: { promptId: string; bindingId: string; bindingGeneration: number; turnId: string; startedAt: string; parentTurnId: string; chainId: string }): TranscriptTurnAdoptionOutcome;
  markPromptObservationDetached(id: string, notice: string): void;
  completeTurn(input: { promptId: string; bindingId: string; answer: string; completionChoice?: ChoicePrompt; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): PrimaryCompletionResult;
  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  observePrimaryPromptState(input: PrimaryPromptStateObservationInput): PrimaryPromptStateObservationResult;
  countPendingPrompts(bindingId: string): number;
  loadRunCard(promptId: string): RunCardView | null;
}

export interface PromptRecoveryStore {
  recoverRunningPrompts(): number;
  listDetachedPrompts(): PromptJob[];
  skipOldestDetachedPrompt(input: { bindingId: string; expectedBindingGeneration: number; actorOpenId: string; sourceMessageId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): DetachedPromptSkipResult;
  advanceDetachedPromptRecovery(input: AdvanceDetachedPromptRecoveryInput): DetachedPromptRecoveryResult;
  markDetachedPromptRecoveryNeedsHuman(input: DetachedPromptNeedsHumanInput): DetachedPromptNeedsHumanResult;
  recoverProjectedBridgeTurn(input: ProjectedBridgeTurnRecoveryInput): ProjectedBridgeTurnRecoveryResult;
  settleDetachedPrompt(input: { promptId: string; bindingId: string; runtime: Binding["lastAgentState"]; occurredAt: string; terminal: { kind: "completed"; answer: string; completionChoice?: ChoicePrompt; outputFingerprint: string } | { kind: "failed"; error: string } }): { settled: boolean; completionActionEligibility: CompletionActionEligibilityReservation };
  scanDurablePromptWork(): DurablePromptWorkScan;
  listStaleUndispatchedPromptClaims(updatedBefore: string, limit: number): StalePromptClaim[];
  requeueStaleUndispatchedPromptClaim(candidate: StalePromptClaim): boolean;
  releaseUndispatchedPromptClaim(candidate: UndispatchedPromptClaimFence): boolean;
  getBinding(id: string): Binding | null;
  getPrompt(id: string): PromptJob | null;
  markPromptObservationDetached(id: string, notice: string): void;
  countPendingPrompts(bindingId: string): number;
}

export interface PromptSessionStore {
  getBinding(id: string): Binding | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: import("../events.js").BridgeEvent; view: TopicViewState; messageId: string; card: object; paneEntryCard: object }): Binding;
}
