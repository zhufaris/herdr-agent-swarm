import type { ClassifiedPromptAcceptance, ClassifiedPromptInput } from "../ports.js";
import type { Binding, BindingMetadataPatch, DurablePromptWorkScan, OperationalSummary, PromptJob, StaleOutboxQuarantineRecovery, StalePromptClaim } from "../types.js";
import type { RunCardView } from "../run-card-view.js";
import type { MainCardReservationOutcome } from "../types.js";
import type { TopicViewState } from "../topic-view.js";
import type { SessionTransition } from "../pane-thread-lifecycle.js";
import type { TranscriptTurnClaimOutcome } from "../types.js";
import type { ModelDispatch } from "../model-selection.js";
import type { WorkerTurnCardPage, WorkerTurnCardView } from "../worker-turn-card-view.js";

export interface ClaimedPrompt {
  binding: Binding;
  prompt: PromptJob;
  model: ModelDispatch | null;
}

export type DetachedPromptSkipResult =
  | { outcome: "skipped"; promptId: string; outboxReserved: boolean }
  | { outcome: "none" | "stale" };

export interface PromptAcceptanceStore {
  acceptPrompt(input: { prompt: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "priority" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin"> & Partial<Pick<PromptJob, "dispatchKind" | "priority" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached" | "executionOrigin">>; view: RunCardView; rootMessageId: string; taskCard?: object; answerCard: object; maxQueueDepth?: number; expectedBindingGeneration?: number }): { prompt: PromptJob; view: RunCardView; inserted: boolean };
  acceptClassifiedPrompt(input: ClassifiedPromptInput): ClassifiedPromptAcceptance;
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  countPendingPrompts(bindingId: string): number;
  ensureAnswerCard(promptId: string, rootMessageId: string, card: object): void;
  getOperationalSummary(): OperationalSummary;
  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean;
  listBindings(): Binding[];
  listRunCards(bindingId: string): RunCardView[];
  loadTopicView(bindingId: string): TopicViewState | null;
  recoverLegacyElementIdDeadLetters(): number;
  recoverUnsupportedWorkerCardCreates(render: (view: WorkerTurnCardView) => object): string[];
  convergeWorkerTaskCardRenderer(revision: string, render: (view: WorkerTurnCardView, page?: WorkerTurnCardPage) => object): string[];
  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery;
  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object): MainCardReservationOutcome;
  saveRunCard(view: RunCardView): RunCardView;
  saveTopicView(view: TopicViewState): void;
}

export interface PromptRunStore {
  recoverRunningPrompts(): number;
  listDetachedPrompts(): PromptJob[];
  skipOldestDetachedPrompt(input: {
    bindingId: string; expectedBindingGeneration: number; actorOpenId: string; sourceMessageId: string;
    reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object;
  }): DetachedPromptSkipResult;
  settleDetachedPrompt(input: {
    promptId: string; bindingId: string; runtime: Binding["lastAgentState"]; occurredAt: string;
    terminal: { kind: "completed"; answer: string; outputFingerprint: string } | { kind: "failed"; error: string };
  }): boolean;
  scanDurablePromptWork(): DurablePromptWorkScan;
  listStaleUndispatchedPromptClaims?(updatedBefore: string, limit: number): StalePromptClaim[];
  requeueStaleUndispatchedPromptClaim?(candidate: StalePromptClaim): boolean;
  getBinding(id: string): Binding | null;
  getPrompt(id: string): PromptJob | null;
  claimNextDispatchablePrompt(bindingId: string): ClaimedPrompt | null;
  claimNextReadySteering(bindingId: string, parentPromptId: string): PromptJob | null;
  markPromptDispatched(id: string, dispatchedAt: string): void;
  markModelPromptPrepared(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string }): boolean;
  markModelPromptAccepted(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string; turnId: string }): boolean;
  rollbackPreparedModelPrompt(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string }): boolean;
  claimPromptTranscriptTurn(input: { promptId: string; bindingId: string; turnId: string; startedAt: string }): TranscriptTurnClaimOutcome;
  markPromptObservationDetached(id: string, notice: string): void;
  failQueuedSteering(bindingId: string, parentPromptId: string, notice: string): string[];
  updatePrompt(id: string, state: PromptJob["state"], error?: string | null): void;
  completeTurn(input: { promptId: string; bindingId: string; answer: string; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): Binding;
  failPrompt(input: { promptId: string; error: string; occurredAt: string; steeringFailureKind?: "rejected" | "uncertain" }): void;
  completeSteering(input: { promptId: string; notice: string; occurredAt: string }): void;
  updateBindingMetadata(id: string, patch: BindingMetadataPatch): Binding;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  countPendingPrompts(bindingId: string): number;
  listQueuedTurnRunCards(bindingId: string): RunCardView[];
  loadRunCard(promptId: string): RunCardView | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: import("../events.js").BridgeEvent; view: TopicViewState; messageId: string; card: object }): Binding;
}
