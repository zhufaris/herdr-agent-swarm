import type { Binding, AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, MainCardReservationOutcome, OutboundWorkClass } from "../types.js";
import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { ModelPreference } from "../model-selection.js";

export interface AnswerPageStore {
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  getAnswerPageDeliveryFacts(promptId: string, pageIndex: number): AnswerPageDeliveryFacts;
  getBinding(id: string): Binding | null;
  listAnswerPages(promptId: string): AnswerPage[];
  loadRunCard(promptId: string): RunCardView | null;
  reserveAnswerContent(input: { promptId: string; pageIndex: number; cardId: string; elementId: string; content: string; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveAnswerContinuation(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveAnswerFinish(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveAnswerRebuild(input: { promptId: string; pageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveFinalAnswerCardUpdate(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveClosedAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveStaticAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveStaticAnswerReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
}

export interface MainCardStore {
  getBinding(id: string): Binding | null;
  getModelPreference(bindingId: string): ModelPreference | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object, workClass?: OutboundWorkClass, paneEntryCard?: object): MainCardReservationOutcome;
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
