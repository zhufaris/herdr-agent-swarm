import type { Binding, AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, AnswerTimelineFrozenItem, AnswerTimelinePageCheckpoint, MainCardReservationOutcome, OutboundWorkClass } from "../types.js";
import type { AnswerSegment, AnswerSegmentBoundary } from "../answer-segment.js";
import type { AnswerTimelineItem } from "../answer-timeline.js";
import type { ProjectionGapSummary } from "../projection-gap.js";
import type { AnswerTimelineCursor } from "../delivery.js";
import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { ModelPreference } from "../model-selection.js";
import type { CoreEventProjectionOwner, CoreEventProjectionResult, CoreEventProjectionSettlement } from "../core-event-inbox.js";
import type { CompletionActionSetRenderState } from "../completion-action-set.js";
import type { NativeInputBacklog } from "../native-input-batch.js";
import type { SessionActivityView } from "../session-activity.js";

export interface AnswerPageStore {
  listRecoverablePrimaryAnswerPromptIds(limit: number): readonly string[];
  listRecoverablePrimaryAnswerPromptIdsForBinding(bindingId: string, limit: number): readonly string[];
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  getAnswerPageDeliveryFacts(promptId: string, pageIndex: number): AnswerPageDeliveryFacts;
  getBinding(id: string): Binding | null;
  listAnswerSegments(aggregateKind: "primary-run" | "worker-turn", aggregateId: string): AnswerSegment[];
  listAnswerPages(promptId: string): AnswerPage[];
  hasPendingExpiredAnswerTarget(promptId: string, pageIndex: number): boolean;
  loadRunCard(promptId: string): RunCardView | null;
  preparePrimaryCompletionActionSet?(input: {
    promptId: string;
    pageIndex: number;
    cardId: string;
    messageId: string;
    card?: object | ((review: { actionSetId: string; mentionOpenId: string; choicePrompt: import("../completion-choice.js").ChoicePrompt; choiceSpecification: import("../completion-choice.js").ChoicePrompt }) => object);
  }): CompletionActionSetRenderState | null;
  getProjectionGapSummary?(input: { bindingId: string; promptId: string; pageIndex: number }): ProjectionGapSummary;
  getAnswerTimelinePage(promptId: string, pageIndex: number): AnswerTimelinePageCheckpoint;
  listFrozenAnswerTimelineItems(promptId: string, beforePageIndex: number): AnswerTimelineFrozenItem[];
  reserveHumanMessageAnswerSegments(input: {
    aggregateKind: "primary-run" | "worker-turn";
    aggregateId: string;
    expectedGeneration: number;
    boundaries: readonly AnswerSegmentBoundary[];
    previousFinalizedCard: object;
    nextCards: readonly object[];
    rootMessageId: string;
    workClass?: OutboundWorkClass;
  }): { created: number; replyIds: string[] };
  reserveAnswerTimelineCard(input: { promptId: string; pageIndex: number; messageId: string; card: object; cursor: AnswerTimelineCursor | null; items: readonly AnswerTimelineItem[]; source?: string; workClass?: OutboundWorkClass }): AnswerPageReservationOutcome;
  reserveAnswerContent(input: { promptId: string; pageIndex: number; cardId: string; elementId: string; content: string; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveAnswerContinuation(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; timelineStartCursor?: AnswerTimelineCursor; timelineEndCursor?: AnswerTimelineCursor | null; timelineItems?: readonly AnswerTimelineItem[]; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveAnswerFinish(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveAnswerRebuild(input: { promptId: string; pageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveFinalAnswerCardUpdate(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; card: object; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveClosedAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveStaticAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveClosedAnswerStreamReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; source?: string; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
  reserveStaticAnswerReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; source?: string; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome;
}

export interface MainCardStore {
  getBinding(id: string): Binding | null;
  getModelPreference(bindingId: string): ModelPreference | null;
  getNativeInputBacklog(bindingId: string, bindingGeneration: number): NativeInputBacklog;
  loadTopicView(bindingId: string): TopicViewState | null;
  loadSessionActivity?(bindingId: string): SessionActivityView | null;
  listRunCardsByPhases(bindingId: string, phases: readonly RunCardView["phase"][]): RunCardView[];
  getProjectionGapSummary?(input: { bindingId: string }): ProjectionGapSummary;
  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object, workClass?: OutboundWorkClass, paneEntryCard?: object): MainCardReservationOutcome;
  saveTopicView(view: TopicViewState): void;
}

export interface ProjectionStore {
  getBinding(id: string): Binding | null;
  listAnswerSegments(aggregateKind: "primary-run" | "worker-turn", aggregateId: string): AnswerSegment[];
  loadRunCard(promptId: string): RunCardView | null;
  listRunCardsByPhases(bindingId: string, phases: readonly RunCardView["phase"][]): RunCardView[];
  loadTopicView(bindingId: string): TopicViewState | null;
  reserveHumanMessageAnswerSegments(input: {
    aggregateKind: "primary-run" | "worker-turn";
    aggregateId: string;
    expectedGeneration: number;
    boundaries: readonly AnswerSegmentBoundary[];
    previousFinalizedCard: object;
    nextCards: readonly object[];
    rootMessageId: string;
    workClass?: OutboundWorkClass;
  }): { created: number; replyIds: string[] };
  saveRunCard(view: RunCardView): RunCardView;
  saveTopicView(view: TopicViewState): void;
  saveGoalProjection(topic: TopicViewState, runCards: readonly RunCardView[]): RunCardView[];
  projectCoreEvent<Result>(settlement: CoreEventProjectionSettlement, projectionOwner: CoreEventProjectionOwner, operation: () => Result): CoreEventProjectionResult<Result>;
}

export interface QueueFeedbackStore {
  listBindings(): Binding[];
  loadQueueFeedbackInputs(bindingId: string): { activeStartedAt: string | null; queued: RunCardView[]; durationsMs: number[] };
  projectQueuedRunCards(input: { bindingId: string; projections: Array<{ expectedViewVersion: number; view: RunCardView; card: object | null }> }): { projected: RunCardView[]; stalePromptIds: string[]; outboxReserved: boolean };
}
