import type { ClassifiedPromptAcceptance, ClassifiedPromptInput } from "../ports.js";
import type { Binding, BindingMetadataPatch, DurablePromptWorkScan, OperationalSummary, PromptJob, StaleOutboxQuarantineRecovery } from "../types.js";
import type { RunCardView } from "../run-card-view.js";
import type { MainCardReservationOutcome } from "../types.js";
import type { TopicViewState } from "../topic-view.js";
import type { SessionTransition } from "../pane-thread-lifecycle.js";
import type { TranscriptTurnClaimOutcome } from "../types.js";

export interface PromptAcceptanceStore {
  acceptPrompt(input: { prompt: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached" | "executionOrigin">>; view: RunCardView; rootMessageId: string; taskCard?: object; answerCard: object }): { prompt: PromptJob; view: RunCardView; inserted: boolean };
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
  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery;
  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object): MainCardReservationOutcome;
  saveRunCard(view: RunCardView): RunCardView;
  saveTopicView(view: TopicViewState): void;
}

export interface PromptRunStore {
  recoverRunningPrompts(): number;
  listDetachedPrompts(): PromptJob[];
  scanDurablePromptWork(): DurablePromptWorkScan;
  getBinding(id: string): Binding | null;
  getPrompt(id: string): PromptJob | null;
  claimNextDispatchablePrompt(bindingId: string): { binding: Binding; prompt: PromptJob } | null;
  claimNextReadySteering(bindingId: string, parentPromptId: string): PromptJob | null;
  markPromptDispatched(id: string, dispatchedAt: string): void;
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
