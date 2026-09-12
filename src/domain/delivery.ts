import type { DeliveryIntentKind } from "./delivery-intent.js";

export type OutboundReplyState = "pending" | "delivered" | "dead_letter" | "dismissed";
export type OutboundWorkClass = "live" | "history";
export type DeliveryFailureClass = "transient" | "permanent" | "unknown";
export type DeliveryEffectCertainty = "not-started" | "rejected" | "uncertain";
export type GatewayRecoveryKind = "closed_answer_stream" | "stale_main_card" | "expired_view_target";
export interface DeliveryFailureMetadata {
  failureClass: DeliveryFailureClass; httpStatus: number | null; larkErrorCode: string | null;
  effectCertainty?: DeliveryEffectCertainty;
  recoveryKind?: GatewayRecoveryKind;
}
export type OutboxLaneClass = "answer_stream" | "main_card" | "replaceable_card" | "immutable";
export type OutboxQuarantineAction = "retry" | "blocked" | "rebuild_answer" | "rebuild_main" | "released_newer_snapshot" | "expired_view_target" | "startup_rebuild" | "startup_rollback" | "startup_dismiss" | "startup_terminalized";
export type OutboundReplyKind = "text" | "card_reply" | "card_update" | "group_card_create" | "stream_card_create" | "stream_content" | "stream_finish";
export type RequestCardRole = "task" | "answer";
export type OutboundTargetRole = "session_status" | "operation_result";
export type AnswerPageState = "creating" | "active" | "frozen" | "finished";
export type AnswerPageDeliveryMode = "streaming" | "static";
export type MainCardReservationOutcome = "reserved" | "waiting" | "current";
export type AnswerPageReservationOutcome = "reserved" | "waiting" | "stale";
export type DeadLetterActionOutcome = "retried" | "dismissed" | "missing" | "unauthorized" | "stale";

export interface OutboundReply {
  id: string; gatewayId: string; gatewayProfileId: string; gatewayPlanJson: string | null; gatewayPlanHash: string | null; gatewayCheckpointJson: string | null; idempotencyKey: string; bindingId: string | null; promptId: string | null; workerTurnId: string | null;
  workerId: string | null; workerSessionGeneration: number | null; viewVersion: number | null; cardSequence: number | null;
  selectionId: string | null; cardRole: RequestCardRole | null; targetRole: OutboundTargetRole | null; threadAliasId: string | null; workerThreadId: string | null; targetChatId: string | null; laneKey: string;
  workClass: OutboundWorkClass;
  rootMessageId: string | null; kind: OutboundReplyKind; payload: string; intentKind: DeliveryIntentKind | null; intentJson: string | null;
  rendererRevision: number | null; state: OutboundReplyState; attemptCount: number; error: string | null;
  deliveredMessageId: string | null; cardIdCheckpoint: string | null; failureClass: DeliveryFailureClass | null; effectCertainty: DeliveryEffectCertainty | null;
  httpStatus: number | null; larkErrorCode: string | null; autoRecoveryCount: number; deadLetteredAt: string | null;
  nextAttemptAt: string; createdAt: string; updatedAt: string;
}

export interface OutboundDeliveryClaim {
  reply: OutboundReply;
  attemptId: string;
  fencingToken: number | null;
  payloadHash: string;
  snapshotRevision: number;
}

export interface BindingThreadAlias {
  id: string; publicationKey: string; bindingId: string; bindingGeneration: number; chatId: string; paneId: string; sourceMainMessageId: string;
  actionMessageId: string; topicId: string | null; rootMessageId: string | null; state: "reserving" | "active" | "stale"; createdAt: string; updatedAt: string;
}

export interface OutboundFailureTransition { state: OutboundReplyState; action: OutboxQuarantineAction; laneClass: OutboxLaneClass; promptId: string | null; reply: OutboundReply }
export interface StaleOutboxQuarantineRecovery { retriedAnswerPromptIds: string[]; rolledBackAnswerPromptIds: string[]; dismissedNotices: number; terminalizedQuarantines: number }
export interface AnswerPage { promptId: string; pageIndex: number; messageId: string | null; cardId: string | null; elementId: string; sourceStart: number; sequence: number; state: AnswerPageState; deliveryMode: AnswerPageDeliveryMode; createdAt: string; updatedAt: string }
export interface AnswerPageDeliveryFacts { latestContent: { content: string; sequence: number; state: OutboundReplyState; sourceEnd?: number | null } | null; finishPending: boolean; continuationPending: boolean; finalUpdateState: OutboundReplyState | null }
