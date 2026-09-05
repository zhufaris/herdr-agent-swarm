import type { Binding, AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, MainCardReservationOutcome } from "../types.js";
import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { InstanceStore } from "./instance.js";
import type { OutboundReply } from "../types.js";
import type { ModelPreference } from "../model-selection.js";

export interface AnswerPageStore {
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  getAnswerPageDeliveryFacts(promptId: string, pageIndex: number): AnswerPageDeliveryFacts;
  getBinding(id: string): Binding | null;
  listAnswerPages(promptId: string): AnswerPage[];
  loadRunCard(promptId: string): RunCardView | null;
  reserveAnswerContent(input: { promptId: string; pageIndex: number; cardId: string; elementId: string; content: string }): AnswerPageReservationOutcome;
  reserveAnswerContinuation(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome;
  reserveAnswerFinish(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object }): AnswerPageReservationOutcome;
  reserveAnswerRebuild(input: { promptId: string; pageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome;
  reserveFinalAnswerCardUpdate(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; card: object }): AnswerPageReservationOutcome;
  reserveClosedAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object }): AnswerPageReservationOutcome;
  reserveStaticAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object }): AnswerPageReservationOutcome;
  reserveStaticAnswerReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome;
}

export type WorkerTurnCardStore = Pick<InstanceStore, "getWorkerTurnCardDeliveryFacts" | "listWorkerTurnCardPages" | "loadWorkerTurnCard" | "reserveWorkerTurnContent" | "reserveWorkerTurnProgress" | "reserveWorkerTurnContinuation" | "reserveWorkerTurnFinish" | "reserveWorkerTurnCardHydration"> & {
  listPendingOutboundReplies(): OutboundReply[];
};

export interface MainCardStore {
  getBinding(id: string): Binding | null;
  getModelPreference(bindingId: string): ModelPreference | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object): MainCardReservationOutcome;
  saveTopicView(view: TopicViewState): void;
}

export interface ProjectionStore {
  getBinding(id: string): Binding | null;
  loadRunCard(promptId: string): RunCardView | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  saveRunCard(view: RunCardView): RunCardView;
  saveTopicView(view: TopicViewState): void;
}

export interface QueueFeedbackStore {
  listBindings(): Binding[];
  loadQueueFeedbackInputs(bindingId: string): { activeStartedAt: string | null; queued: RunCardView[]; durationsMs: number[] };
  projectQueuedRunCards(input: { bindingId: string; projections: Array<{ expectedViewVersion: number; view: RunCardView; card: object | null }> }): { projected: RunCardView[]; stalePromptIds: string[]; outboxReserved: boolean };
}
