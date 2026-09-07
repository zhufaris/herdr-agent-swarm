import type { Binding } from "../binding.js";
import type { MainCardReservationOutcome, StaleOutboxQuarantineRecovery } from "../delivery.js";
import type { ModelDispatch } from "../model-selection.js";
import type { DurablePromptWorkScan, PromptJob, StalePromptClaim, TranscriptTurnClaimOutcome } from "../prompt.js";
import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { OperationalSummary } from "../types.js";
import type { WorkerTurnCardPage, WorkerTurnCardView } from "../worker-turn-card-view.js";

export interface ClaimedPrompt { binding: Binding; prompt: PromptJob; model: ModelDispatch | null }
export type DetachedPromptSkipResult = { outcome: "skipped"; promptId: string; outboxReserved: boolean } | { outcome: "none" | "stale" };
export interface AcceptPromptInput {
  prompt: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "priority" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin"> & Partial<Pick<PromptJob, "priority" | "wasDetached" | "executionOrigin">>;
  view: RunCardView; rootMessageId: string; taskCard?: object; answerCard: object; maxQueueDepth?: number; expectedBindingGeneration?: number;
}
export interface PromptAcceptanceStore {
  acceptPrompt(input: AcceptPromptInput): { prompt: PromptJob; view: RunCardView; inserted: boolean }; audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void; countPendingPrompts(bindingId: string): number; ensureAnswerCard(promptId: string, rootMessageId: string, card: object): void; getOperationalSummary(): OperationalSummary; hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean; listBindings(): Binding[]; listRunCards(bindingId: string): RunCardView[]; loadTopicView(bindingId: string): TopicViewState | null; recoverLegacyElementIdDeadLetters(): number; recoverUnsupportedWorkerCardCreates(render: (view: WorkerTurnCardView) => object): string[]; convergeWorkerTaskCardRenderer(revision: string, render: (view: WorkerTurnCardView, page?: WorkerTurnCardPage) => object): string[]; recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery; reserveMainCard(view: TopicViewState, rootMessageId: string, card: object): MainCardReservationOutcome; saveRunCard(view: RunCardView): RunCardView; saveTopicView(view: TopicViewState): void;
}
export type { DurablePromptWorkScan, StalePromptClaim, TranscriptTurnClaimOutcome };
