import type {
  ConversationSegment,
  ConversationSegmentEventPosition,
  ConversationSegmentItem,
  ConversationSegmentPage,
  ConversationSegmentState
} from "../conversation-segment.js";
import type { OutboundWorkClass } from "../types.js";
import type { SubmissionIntentOwner } from "../submission-intent.js";
import type { CoreEventEnvelope } from "../core-event-inbox.js";
import type { ExactRecoveryRoute, HistoricalMissingPageCandidate } from "../historical-recovery.js";
import type { AnswerTimelineDelta } from "../answer-timeline.js";
import type { AnswerTimelineCursor, PresentationSnapshot } from "../delivery.js";
import type { AnswerTimelineItem } from "../answer-timeline.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReservation } from "./outbox.js";
import type { PresentationParityDescriptor } from "./presentation.js";
import type { GoalChange } from "../current-goal.js";
import type { CompletionActionSetRenderState } from "../completion-action-set.js";
import type { SessionActivityInvalidationFence } from "../session-activity.js";
export interface ConversationSegmentCardView { segmentId: string; ownerKind: "primary" | "worker"; ownerLabel: string; spaceName: string; projectLabel: string; tabLabel: string | null; paneToken: string | null; model?: string | null; requestText: string; state: ConversationSegmentState; timelineItems: readonly AnswerTimelineItem[]; gapWarning: string | null; viewVersion: number; currentGoal?: { objective: string; status?: string } | null; taskList?: readonly { label: string; state?: string }[]; }
export interface ConversationSegmentProjectionNotification { segmentId: string; viewVersion: number; urgency: "immediate" | "trailing"; workClass?: OutboundWorkClass; }
export type SegmentCompletionReason = "human_review" | "final_request" | "both";
export interface SegmentCompletionRenderState { mentionOpenId: string; reason: SegmentCompletionReason; completionActions: CompletionActionSetRenderState | null; }
export interface PrimarySegmentCompletionChoiceResult { segmentId: string; submissionId: string; inserted: boolean; }
export type PrimarySegmentCompletionReviewDecision =
  | { kind: "submission"; segmentId: string; submissionId: string; inserted: boolean }
  | { kind: "ignored"; segmentId: string; changed: boolean };
export interface ActiveConversationSegmentProjection {
  view: ConversationSegmentCardView;
  page: ConversationSegmentPage | null;
  pendingPage: ConversationSegmentPage | null;
  latestFrozenPage: ConversationSegmentPage | null;
  cursorBase: number;
  localStartCursor: AnswerTimelineCursor | null;
  startAnchor: ConversationSegmentCursorAnchor | null;
  itemPositions: readonly ConversationSegmentEventPosition[];
}
export interface BoundedConversationHistoryPage {
  items: readonly AnswerTimelineItem[];
  itemPositions: readonly ConversationSegmentEventPosition[];
  cursorBase: number;
  hasMore: boolean;
}
export interface ConversationSegmentCursorAnchor {
  position: ConversationSegmentEventPosition;
  inclusive: boolean;
}
export interface ConversationSegmentPageRecoveryCandidate { segmentId: string; sourcePageIndex: number; partIndex: number; startCursor: AnswerTimelineCursor; endCursor: AnswerTimelineCursor; anchorMessageId: string; gatewayId: string; projectionKey: string; }
export interface ConversationSegmentLateRecoveryCandidate { segmentId: string; recoveryId: number; partIndex: number; item: AnswerTimelineItem; startCursor: AnswerTimelineCursor | null; anchorMessageId: string; projectionKey: string; }
type SemanticConversationPageReservationBase = {
  segmentId: string;
  snapshot: PresentationSnapshot;
  plannerPolicyVersion: number;
  rendererPolicyVersion: number;
  gatewayProfileVersion: number;
  workClass?: OutboundWorkClass;
};
export type SemanticConversationPageReservation = SemanticConversationPageReservationBase & (
  | { transition: "snapshot"; pageIndex: number; messageId: string | null; cardId?: string | null; elementId: string; cursor: AnswerTimelineCursor | null; viewVersion: number }
  | { transition: "freeze"; pageIndex: number; messageId: string; cardId?: string | null; elementId: string; cursor: AnswerTimelineCursor; cursorAnchor: ConversationSegmentCursorAnchor }
  | { transition: "finish"; pageIndex: number; messageId: string; cardId?: string | null; elementId: string; summary: string; cursor: AnswerTimelineCursor }
  | { transition: "continuation"; pageIndex: number; messageId: string; nextPageIndex: number; nextElementId: string; nextStartCursor: AnswerTimelineCursor | null; nextStartAnchor: ConversationSegmentCursorAnchor; cursor: AnswerTimelineCursor | null }
);
export interface RejectedTurnCardRootRecovery { replacementReplyId: string; laneKey: string; }
export type SegmentCompletionNotificationRecoveryResult =
  | { outcome: "released"; notificationReplyId: string }
  | { outcome: "already_converged"; notificationReplyId: string }
  | { outcome: "not_ready"; reason: "missing_obligation" | "obligation_not_waiting" | "missing_mention_target" | "missing_presentation_reply" | "presentation_not_delivered" | "invalid_presentation_identity" | "final_event_mismatch" | "segment_not_completed" | "page_not_finished" | "message_mismatch" | "mention_payload_mismatch" | "stale_binding" };

/** Historical Pending-first row shape. New segments start from canonical Human evidence. */
export interface AdmitLegacyPendingConversationSegmentInput {
  segmentId: string; submissionId: string; producerKey: string;
  owner: SubmissionIntentOwner; agentKind: "traex" | "pi";
  expectedSessionId: string | null; requestText: string;
  rootMessageId: string; card: object; occurredAt: string;
  gatewayId?: string;
  requestProjection?: boolean;
}

export interface ConversationSegmentStore {
  /** Compatibility-only writer for historical recovery fixtures and migrations. */
  admitLegacyPending(input: AdmitLegacyPendingConversationSegmentInput): ConversationSegment;
  getConversationSegment(id: string): ConversationSegment | null;
  listConversationSegmentsForProducer(producerKey: string): ConversationSegment[];
  listConversationSegmentItems(segmentId: string): ConversationSegmentItem[];
  listConversationSegmentPages(segmentId: string): ConversationSegmentPage[];
  listHistoricalMissingPageCandidates(input: { limit?: number }): HistoricalMissingPageCandidate[];
  reserveHistoricalMissingPage(input: { candidate: HistoricalMissingPageCandidate; card: object; cursor: AnswerTimelineCursor | null }): "reserved" | "stale";
  projectCanonicalEvent(input: { laneId: string; laneSequence: number; event: CoreEventEnvelope; observedAt: string; route?: ExactRecoveryRoute; workClass?: OutboundWorkClass; model?: string; timelineDeltas?: readonly AnswerTimelineDelta[]; goalChanges?: readonly GoalChange[]; taskList?: readonly { label: string; state?: string }[] }): ConversationSegmentProjectionResult;
  loadCardView(segmentId: string): ConversationSegmentCardView | null;
  loadCompletionRenderState?(segmentId: string): SegmentCompletionRenderState | null;
  preparePrimarySegmentCompletionActionSet?(input: { segmentId: string; pageIndex: number; cardId: string | null; messageId: string; card: object }): CompletionActionSetRenderState | null;
  decidePrimarySegmentCompletionReview?(input: { actionSetId: string; optionId: string; messageId: string; actorOpenId: string; chatId: string; occurredAt: string }): PrimarySegmentCompletionReviewDecision;
  acceptPrimarySegmentCompletionChoice?(input: { actionSetId: string; optionId: string; ownerSegmentId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string; chatId: string; occurredAt: string }): PrimarySegmentCompletionChoiceResult;
  ignorePrimarySegmentCompletionChoice?(input: { actionSetId: string; ownerSegmentId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string; chatId: string; occurredAt: string }): import("../completion-action-set.js").CompletionActionIgnoreResult;
  loadActiveProjection(segmentId: string): ActiveConversationSegmentProjection | null;
  loadHistoryPage(input: { segmentId: string; startCursor: AnswerTimelineCursor; endCursor: AnswerTimelineCursor; limit: number }): BoundedConversationHistoryPage;
  getActivePage(segmentId: string): ConversationSegmentPage | null;
  nextHistoricalPageRecovery?(segmentId: string): ConversationSegmentPageRecoveryCandidate | null;
  nextLateItemRecovery?(segmentId: string): ConversationSegmentLateRecoveryCandidate | null;
  reserveLateItemRecovery?(input: ConversationSegmentLateRecoveryCandidate & { card: object; nextCursor: AnswerTimelineCursor | null; workClass?: OutboundWorkClass }): "reserved" | "waiting" | "stale";
  reserveHistoricalPageRecovery?(input: ConversationSegmentPageRecoveryCandidate & { card: object; endAnchor: ConversationSegmentCursorAnchor; workClass?: OutboundWorkClass }): "reserved" | "waiting" | "stale";
  reserveSemanticSnapshot?(input: SemanticConversationPageReservation): "reserved" | "waiting" | "noop" | "stale";
  previewSemanticShadowDelivery?(input: SemanticConversationPageReservation): Omit<PresentationParityDescriptor, "visibleStructureFingerprint" | "committedBounds" | "recomputedBounds"> | null;
  loadLegacyShadowDelivery?(segmentId: string, pageIndex: number, viewVersion: number, pagePlan: import("../conversation-segment.js").ConversationPagePlan): Omit<PresentationParityDescriptor, "visibleStructureFingerprint" | "committedBounds" | "recomputedBounds"> | null;
  reserveSnapshot(input: ({ messageId: null; cardId?: null; elementId: string } | { messageId: string; cardId?: string | null; elementId: string }) & { segmentId: string; pageIndex: number; card: object; cursor: AnswerTimelineCursor | null; viewVersion: number; workClass?: OutboundWorkClass }): "reserved" | "waiting" | "noop" | "stale";
  reserveFreeze(input: { segmentId: string; pageIndex: number; messageId: string; cardId?: string | null; elementId: string; card: object; cursor: AnswerTimelineCursor; cursorAnchor?: ConversationSegmentCursorAnchor; workClass?: OutboundWorkClass }): "reserved" | "waiting" | "noop" | "stale";
  reserveContinuation(input: { segmentId: string; pageIndex: number; messageId: string; card: object; nextPageIndex: number; nextElementId: string; nextStartCursor: AnswerTimelineCursor; nextStartAnchor?: ConversationSegmentCursorAnchor; workClass?: OutboundWorkClass }): "reserved" | "waiting" | "stale";
  reserveFinish(input: { segmentId: string; pageIndex: number; messageId: string; card: object; summary: string; cursor: AnswerTimelineCursor; cardId?: string | null; elementId: string; workClass?: OutboundWorkClass }): "reserved" | "waiting" | "noop" | "stale";
  reserveLateContinuation(input: { segmentId: string; pageIndex: number; messageId: string; card: object; nextPageIndex: number; nextElementId: string; nextStartCursor: AnswerTimelineCursor | null; nextStartAnchor?: ConversationSegmentCursorAnchor; workClass?: OutboundWorkClass }): "reserved" | "waiting" | "stale";
  checkpointPage(input: { segmentId: string; pageIndex: number; replyId: string; messageId: string; cardId: string | null }): "checkpointed" | "stale";
  reconcilePageDelivery(segmentId: string, pageIndex: number): "adopted" | "waiting" | "ready" | "stale";
  rebuildRejectedRoot(failedReplyId: string, recoveredAt: string): RejectedTurnCardRootRecovery | null;
  recoverPrimarySegmentCompletionNotification?(segmentId: string): SegmentCompletionNotificationRecoveryResult;
  listActionableConversationSegmentIds(limit?: number): string[];
  listActionableConversationSegmentPage(input: {
    limit: number;
    after: ActionableConversationSegmentCursor | null;
    upperBound: ActionableConversationSegmentCursor | null;
  }): ActionableConversationSegmentPage;
  invalidateCurrentPrimarySessionActivity(input: SessionActivityInvalidationFence): ConversationSegmentProjectionNotification | null;
  setInitialTurnCardRenderer?(renderer: (view: ConversationSegmentCardView, page: ConversationSegmentPage) => object): void;
  setProjectionNotifier?(notifier: (notification: ConversationSegmentProjectionNotification) => void | Promise<void>): void;
  setPreparedDeliveryReservation?(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void;
}

export interface ConversationSegmentProjectionResult {
  outcome: "adopted" | "created" | "projected" | "duplicate" | "conflict" | "ignored";
  segmentId: string | null;
}

export type ActionableConversationSegmentCursor = {
  updatedAt: string;
  segmentId: string;
};

export type ActionableConversationSegmentPage = {
  items: readonly string[];
  nextCursor: ActionableConversationSegmentCursor | null;
  upperBound: ActionableConversationSegmentCursor | null;
};

export interface ConversationSegmentPageReservation {
  segmentId: string;
  pageIndex: number;
  messageId: string | null;
  cardId: string | null;
  elementId: string;
  state: ConversationSegmentPage["state"];
  sequence: number;
  startCursor: ConversationSegmentPage["startCursor"];
  deliveredCursor: ConversationSegmentPage["deliveredCursor"];
  pendingReplyId: string | null;
  workClass?: OutboundWorkClass;
}

export interface ConversationSegmentMutation {
  segmentId: string;
  expectedState?: ConversationSegmentState;
  state: ConversationSegmentState;
  startAt?: ConversationSegmentEventPosition | null;
  endBefore?: ConversationSegmentEventPosition | null;
  updatedAt: string;
}
