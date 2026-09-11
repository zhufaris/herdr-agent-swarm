import type { DeliveryIntentKind } from "./delivery-intent.js";

export type OutboundReplyState = "pending" | "delivered" | "dead_letter" | "dismissed";
export type DeliveryFailureClass = "transient" | "permanent" | "unknown";
export type CardKitRecoveryKind = "closed_answer_stream" | "stale_main_card";
export interface DeliveryFailureMetadata {
  failureClass: DeliveryFailureClass; httpStatus: number | null; larkErrorCode: string | null;
  recoveryKind?: CardKitRecoveryKind;
}
export type OutboxLaneClass = "answer_stream" | "main_card" | "replaceable_card" | "immutable";
export type OutboxQuarantineAction = "retry" | "blocked" | "rebuild_answer" | "rebuild_main" | "released_newer_snapshot" | "startup_rebuild" | "startup_rollback" | "startup_dismiss" | "startup_terminalized";
export type OutboundReplyKind = "text" | "card_reply" | "card_update" | "stream_card_create" | "stream_content" | "stream_finish";
export type RequestCardRole = "task" | "answer";
export type OutboundTargetRole = "session_status" | "operation_result";
export type AnswerPageState = "creating" | "active" | "frozen" | "finished";
export type AnswerPageDeliveryMode = "streaming" | "static";
export type MainCardReservationOutcome = "reserved" | "waiting" | "current";
export type AnswerPageReservationOutcome = "reserved" | "waiting" | "stale";
export type DeadLetterActionOutcome = "retried" | "dismissed" | "missing" | "unauthorized" | "stale";

export interface OutboundReply {
  id: string; idempotencyKey: string; bindingId: string | null; promptId: string | null; workerTurnId: string | null;
  workerId: string | null; workerSessionGeneration: number | null; viewVersion: number | null; cardSequence: number | null;
  selectionId: string | null; cardRole: RequestCardRole | null; targetRole: OutboundTargetRole | null; laneKey: string;
  rootMessageId: string; kind: OutboundReplyKind; payload: string; intentKind: DeliveryIntentKind | null; intentJson: string | null;
  rendererRevision: number | null; state: OutboundReplyState; attemptCount: number; error: string | null;
  deliveredMessageId: string | null; cardIdCheckpoint: string | null; failureClass: DeliveryFailureClass | null;
  httpStatus: number | null; larkErrorCode: string | null; autoRecoveryCount: number; deadLetteredAt: string | null;
  nextAttemptAt: string; createdAt: string; updatedAt: string;
}

export interface OutboundFailureTransition { state: OutboundReplyState; action: OutboxQuarantineAction; laneClass: OutboxLaneClass; promptId: string | null; reply: OutboundReply }
export interface StaleOutboxQuarantineRecovery { retriedAnswerPromptIds: string[]; rolledBackAnswerPromptIds: string[]; dismissedNotices: number; terminalizedQuarantines: number }
export interface AnswerPage { promptId: string; pageIndex: number; messageId: string | null; cardId: string | null; elementId: string; sourceStart: number; sequence: number; state: AnswerPageState; deliveryMode: AnswerPageDeliveryMode; createdAt: string; updatedAt: string }
export interface AnswerPageDeliveryFacts { latestContent: { content: string; sequence: number; state: OutboundReplyState; sourceEnd?: number | null } | null; finishPending: boolean; continuationPending: boolean; finalUpdateState: OutboundReplyState | null }
