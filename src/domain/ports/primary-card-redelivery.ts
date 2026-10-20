import type { AnswerPage } from "../delivery.js";
import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { CompletionActionSetRenderState } from "../completion-action-set.js";

export interface PrimaryCardRedeliverySnapshot {
  outcome: "available";
  topic: TopicViewState;
  answer: { run: RunCardView; page: AnswerPage; nextPageStart: number | null; completionActions: CompletionActionSetRenderState | null } | null;
}

export type PrimaryCardRedeliverySnapshotResult = PrimaryCardRedeliverySnapshot
  | { outcome: "unavailable"; reason: "stale_binding" | "stale_projection" | "missing_main_target" | "ambiguous_active_prompt" };

export type PrimaryCardRedeliveryReservation =
  | { outcome: "scheduled"; mainScheduled: true; answerScheduled: boolean }
  | { outcome: "duplicate"; mainScheduled: true; answerScheduled: boolean }
  | { outcome: "stale"; reason: string }
  | { outcome: "unavailable"; reason: string };

export interface PrimaryCardRedeliveryStore {
  loadSnapshot(input: { bindingId: string; expectedBindingGeneration: number }): PrimaryCardRedeliverySnapshotResult;
  reserve(input: {
    commandIntentId: string;
    snapshot: PrimaryCardRedeliverySnapshot;
    mainCard: object;
    answerCard: object | null;
  }): PrimaryCardRedeliveryReservation;
}

export interface PrimaryCardRedelivery {
  redeliver(input: { commandIntentId: string; bindingId: string; expectedBindingGeneration: number }): PrimaryCardRedeliveryReservation;
}
