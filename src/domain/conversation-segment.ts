import type { AnswerTimelineItem } from "./answer-timeline.js";
import type { AnswerTimelineCursor } from "./delivery.js";
import type { SubmissionIntentOwnerKind } from "./submission-intent.js";
import type { OutboundWorkClass } from "./types.js";

export type ConversationSegmentState = "pending" | "working" | "completed" | "failed" | "cancelled" | "needs_human" | "closed";

export interface ConversationSegmentEventPosition {
  laneSequence: number;
  itemOrdinal: number;
}

export interface ConversationSegment {
  id: string;
  producerKey: string;
  ownerKind: SubmissionIntentOwnerKind;
  ownerId: string;
  ownerGeneration: number;
  submissionId: string | null;
  humanEventId: string | null;
  agentKind: "traex" | "pi";
  sessionId: string | null;
  requestText: string;
  startAt: ConversationSegmentEventPosition | null;
  endBefore: ConversationSegmentEventPosition | null;
  state: ConversationSegmentState;
  viewVersion: number;
  rootMessageId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSegmentItem {
  segmentId: string;
  itemId: string;
  position: ConversationSegmentEventPosition;
  item: AnswerTimelineItem;
}

export interface ConversationSegmentPage {
  id: string;
  segmentId: string;
  pageIndex: number;
  messageId: string | null;
  cardId: string | null;
  elementId: string;
  state: "creating" | "active" | "frozen" | "finished";
  sequence: number;
  deliveredSequence: number;
  startCursor: AnswerTimelineCursor | null;
  deliveredCursor: AnswerTimelineCursor | null;
  pendingCursor: AnswerTimelineCursor | null;
  pendingReplyId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deliveryCohort?: "legacy" | "semantic";
}

export interface ConversationPagePresentationBudget {
  encodedBytes: number;
  elementCount: number;
  actionCount: number;
  profileVersion: number;
}

/** Canonical source interval selected by one immutable presentation policy. */
export interface ConversationPagePlan {
  policyVersion: number;
  budgetProfileVersion: number;
  pageIndex: number;
  startCursor: AnswerTimelineCursor | null;
  endCursor: AnswerTimelineCursor | null;
  hasContinuation: boolean;
}

export interface ConversationPagePresentationMeasure {
  encodedBytesUpperBound: number;
  elementCount: number;
  actionCount: number;
}

export interface ConversationSegmentDeliveryReservation {
  segmentId: string;
  pageId: string;
  workClass: OutboundWorkClass;
}

export function compareSegmentPosition(left: ConversationSegmentEventPosition, right: ConversationSegmentEventPosition): number {
  if (left.laneSequence !== right.laneSequence) return left.laneSequence - right.laneSequence;
  return left.itemOrdinal - right.itemOrdinal;
}

export function closeConversationSegment(
  segment: ConversationSegment,
  endBefore: ConversationSegmentEventPosition,
  updatedAt: string,
): ConversationSegment {
  if (segment.state === "closed") throw new Error(`Conversation segment ${segment.id} is already closed`);
  assertPositionNonNegative(endBefore, "endBefore");
  if (segment.startAt !== null && compareSegmentPosition(endBefore, segment.startAt) <= 0) {
    throw new Error(`Conversation segment ${segment.id} cannot close at or before its start position`);
  }
  if (segment.endBefore !== null && compareSegmentPosition(endBefore, segment.endBefore) < 0) {
    throw new Error(`Conversation segment ${segment.id} cannot move its end boundary backward`);
  }
  return {
    ...segment,
    endBefore,
    state: "closed",
    updatedAt,
  };
}

export function workingConversationSegment(
  segment: ConversationSegment,
  input: { humanEventId: string; startAt: ConversationSegmentEventPosition },
  updatedAt: string,
): ConversationSegment {
  if (segment.state === "closed") throw new Error(`Conversation segment ${segment.id} is closed and cannot re-enter working`);
  if (segment.state !== "pending" && segment.state !== "needs_human" && segment.state !== "working") {
    throw new Error(`Conversation segment ${segment.id} cannot enter working from state ${segment.state}`);
  }
  if (input.humanEventId.length === 0) throw new Error("Conversation segment working transition requires a human event ID");
  assertPositionNonNegative(input.startAt, "startAt");
  if (segment.startAt !== null && compareSegmentPosition(input.startAt, segment.startAt) !== 0) {
    const direction = compareSegmentPosition(input.startAt, segment.startAt) < 0 ? "backward" : "forward";
    throw new Error(`Conversation segment ${segment.id} cannot move its start position ${direction}`);
  }
  if (segment.endBefore !== null && compareSegmentPosition(segment.endBefore, input.startAt) < 0) {
    throw new Error(`Conversation segment ${segment.id} cannot start after its closing boundary`);
  }
  if (segment.humanEventId !== null && segment.humanEventId !== input.humanEventId) {
    throw new Error(`Conversation segment ${segment.id} already belongs to canonical human event ${segment.humanEventId}`);
  }
  return {
    ...segment,
    humanEventId: input.humanEventId,
    startAt: input.startAt,
    state: "working",
    updatedAt,
  };
}

export function terminalConversationSegment(
  segment: ConversationSegment,
  state: ConversationSegmentState,
  updatedAt: string,
): ConversationSegment {
  if (!TERMINAL_SEGMENT_STATES.has(state)) throw new Error(`Conversation segment terminal transition requires a terminal state, got ${state}`);
  if (segment.state === "closed") throw new Error(`Conversation segment ${segment.id} is closed and cannot change terminal lifecycle state`);
  return {
    ...segment,
    state,
    updatedAt,
  };
}

const TERMINAL_SEGMENT_STATES = new Set<ConversationSegmentState>(["completed", "failed", "cancelled", "needs_human"]);

function assertPositionNonNegative(position: ConversationSegmentEventPosition, label: string): void {
  if (position.laneSequence < 0 || position.itemOrdinal < 0) {
    throw new Error(`Conversation segment ${label} must be non-negative`);
  }
}
