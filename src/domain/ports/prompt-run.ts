import type { Binding } from "../binding.js";
import type { DurablePromptWorkScan, PromptJob, StalePromptClaim, TranscriptTurnClaimOutcome, UndispatchedPromptClaimFence } from "../prompt.js";
import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { SessionTransition } from "../pane-thread-lifecycle.js";
import type { ClaimedPrompt, DetachedPromptSkipResult } from "./prompt-acceptance.js";

export interface PromptDispatchStore {
  getBinding(id: string): Binding | null;
  getPrompt(id: string): PromptJob | null;
  getActiveOrdinaryPrompt(bindingId: string, expectedGeneration: number): PromptJob | null;
  claimNextDispatchablePrompt(bindingId: string): ClaimedPrompt | null;
  markPromptDispatched(id: string, dispatchedAt: string): void;
  markModelPromptPrepared(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string }): boolean;
  markModelPromptAccepted(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string; turnId: string }): boolean;
  rollbackPreparedModelPrompt(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string }): boolean;
  claimPromptTranscriptTurn(input: { promptId: string; bindingId: string; turnId: string; startedAt: string }): TranscriptTurnClaimOutcome;
  markPromptObservationDetached(id: string, notice: string): void;
  completeTurn(input: { promptId: string; bindingId: string; answer: string; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): Binding;
  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  countPendingPrompts(bindingId: string): number;
  loadRunCard(promptId: string): RunCardView | null;
}

export interface PromptRecoveryStore {
  recoverRunningPrompts(): number;
  listDetachedPrompts(): PromptJob[];
  skipOldestDetachedPrompt(input: { bindingId: string; expectedBindingGeneration: number; actorOpenId: string; sourceMessageId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): DetachedPromptSkipResult;
  settleDetachedPrompt(input: { promptId: string; bindingId: string; runtime: Binding["lastAgentState"]; occurredAt: string; terminal: { kind: "completed"; answer: string; outputFingerprint: string } | { kind: "failed"; error: string } }): boolean;
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
