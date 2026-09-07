import type { Binding } from "../binding.js";
import type { ModelDispatch } from "../model-selection.js";
import type { DurablePromptWorkScan, PromptJob, StalePromptClaim, TranscriptTurnClaimOutcome } from "../prompt.js";
import type { RunCardView } from "../run-card-view.js";
import type { BridgeEvent } from "../events.js";

export interface ClaimedPrompt { binding: Binding; prompt: PromptJob; model: ModelDispatch | null }
export type DetachedPromptSkipResult = { outcome: "skipped"; promptId: string; outboxReserved: boolean } | { outcome: "none" | "stale" };
export interface AcceptPromptInput {
  prompt: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "priority" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin"> & Partial<Pick<PromptJob, "priority" | "wasDetached" | "executionOrigin">>;
  view: RunCardView; rootMessageId: string; taskCard?: object; answerCard: object; maxQueueDepth?: number; expectedBindingGeneration?: number;
}
export type PromptAcceptanceEffect =
  | { kind: "outbound-wake" }
  | { kind: "prompt-wake"; bindingId: string }
  | { kind: "lifecycle-event"; event: BridgeEvent };
export interface PromptAcceptanceReceipt {
  readonly result: { prompt: PromptJob; view: RunCardView; inserted: boolean };
  readonly commitState: "pending" | "committed" | "rolled_back";
  consumeEffects(): readonly PromptAcceptanceEffect[];
}
export interface PromptAcceptanceStore {
  acceptPrompt(input: AcceptPromptInput): { prompt: PromptJob; view: RunCardView; inserted: boolean };
  acceptPromptWithEffects(input: AcceptPromptInput): PromptAcceptanceReceipt;
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  countPendingPrompts(bindingId: string): number;
}
export type { DurablePromptWorkScan, StalePromptClaim, TranscriptTurnClaimOutcome };
