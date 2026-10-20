import type { DeliveryIntentKind } from "./delivery-intent.js";
import type { DeliveryOwnerFence, DeliveryScope } from "./delivery-scope.js";
export type { AnswerSegment, AnswerSegmentBoundary } from "./answer-segment.js";

export interface PreparedDeliveryPlan {
  protocolVersion: 1;
  gatewayId: string;
  profileId: string;
  rendererRevision: number;
  operation: string;
  intent: object & { kind: string };
}

export type PresentationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly PresentationJsonValue[]
  | Readonly<{ [key: string]: PresentationJsonValue }>;

export type ConversationPageSubject = Readonly<{
  kind: "conversation-page";
  segmentId: string;
  pageIndex: number;
  revision: number;
}>;

export type DeliverySubject = ConversationPageSubject;

export type PresentationSnapshot = Readonly<{
  schemaVersion: number;
  [key: string]: PresentationJsonValue;
}>;

export type SemanticSnapshotDeliveryInput = Readonly<{
  kind: "semantic-snapshot";
  subject: DeliverySubject;
  snapshot: PresentationSnapshot;
  snapshotHash: string;
  plannerPolicyVersion: number;
  rendererPolicyVersion: number;
  gatewayProfileVersion: number;
}>;

export type PreparedEffectDeliveryInput = Readonly<{
  kind: "prepared-effect";
  effect: PreparedDeliveryPlan;
}>;

export type DeliveryInput = SemanticSnapshotDeliveryInput | PreparedEffectDeliveryInput;
export type DeliveryPreparationState = "reserved" | "preparing" | "prepared";

export interface PreparedDeliveryCheckpoint {
  kind: "surface";
  ref: { gatewayId: string; kind: "surface"; opaqueId: string };
}

export type OutboundReplyState = "pending" | "delivered" | "dead_letter" | "dismissed";
export type OutboundWorkClass = "live" | "history";
export type DeliveryFailureClass = "transient" | "permanent" | "unknown";
export type DeliveryEffectCertainty = "not-started" | "rejected" | "uncertain";
export type GatewayRecoveryKind = "closed_answer_stream" | "stale_main_card" | "expired_view_target" | "expired_worker_view_target" | "message_edit_limit" | "defunct_target";
export interface DeliveryFailureMetadata {
  failureClass: DeliveryFailureClass; httpStatus: number | null; larkErrorCode: string | null;
  effectCertainty?: DeliveryEffectCertainty;
  recoveryKind?: GatewayRecoveryKind;
  providerOperation?: string;
}
export type OutboxLaneClass = "answer_stream" | "main_card" | "replaceable_card" | "immutable";
export type OutboxQuarantineAction = "retry" | "blocked" | "dismiss_attempt_budget" | "rebuild_answer" | "rebuild_worker_task" | "create_recovery_conversation" | "refuse_recovery_conversation" | "rebuild_main" | "released_newer_snapshot" | "released_worker_turn_snapshot" | "expired_view_target" | "dismiss_expired_worker_target" | "dismiss_defunct_target" | "replace_expired_worker_target" | "replace_human_review_target" | "dismiss_human_review_target" | "startup_rebuild" | "startup_rollback" | "startup_dismiss" | "startup_dismiss_rejected" | "startup_dismiss_defunct_target" | "startup_retire_expired_message_delete" | "startup_dismiss_expired_worker_target" | "startup_replace_expired_worker_target" | "startup_superseded_answer" | "startup_terminalized";
export type OutboundReplyKind = "text" | "card_reply" | "card_update" | "group_card_create" | "stream_card_create" | "stream_content" | "stream_finish" | "message_delete";
export type RequestCardRole = "task" | "answer";
export type OutboundTargetRole = "session_status" | "operation_result";
export type AnswerPageState = "creating" | "active" | "frozen" | "finished";
export type AnswerPageDeliveryMode = "streaming" | "static";
export type MainCardReservationOutcome = "reserved" | "waiting" | "current";
export type AnswerPageReservationOutcome = "reserved" | "waiting" | "stale";
export type DeadLetterActionOutcome = "retried" | "dismissed" | "missing" | "unauthorized" | "stale" | "unsafe";

export interface OutboundReply {
  id: string; gatewayId: string; gatewayProfileId: string; gatewayPlanJson: string | null; gatewayPlanHash: string | null; gatewayCheckpointJson: string | null; idempotencyKey: string; bindingId: string | null; promptId: string | null; workerTurnId: string | null;
  workerId: string | null; workerSessionGeneration: number | null; viewVersion: number | null; cardSequence: number | null;
  selectionId: string | null; streamPageIndex: number | null; streamElementId: string | null; cardRole: RequestCardRole | null; targetRole: OutboundTargetRole | null; threadAliasId: string | null; workerThreadId: string | null; shortcutPanelId: string | null; targetChatId: string | null; laneKey: string; conflictKey: string; projectionKey?: string | null;
  workClass: OutboundWorkClass;
  rootMessageId: string | null; kind: OutboundReplyKind; payload: string; intentKind: DeliveryIntentKind | null; intentJson: string | null;
  rendererRevision: number | null; state: OutboundReplyState; attemptCount: number; error: string | null;
  deliveredMessageId: string | null; cardIdCheckpoint: string | null; failureClass: DeliveryFailureClass | null; effectCertainty: DeliveryEffectCertainty | null;
  httpStatus: number | null; larkErrorCode: string | null; autoRecoveryCount: number; deadLetteredAt: string | null;
  nextAttemptAt: string; createdAt: string; updatedAt: string;
  deliveryScope: DeliveryScope | null; deliveryOwnerFence: DeliveryOwnerFence | null; deliveryParentPaneId: string | null;
}

export interface OutboundDeliveryClaim {
  reply: OutboundReply;
  attemptId: string;
  fencingToken: number | null;
  payloadHash: string;
  snapshotRevision: number;
}

export type PreparedDelivery = Readonly<{
  replyId: string;
  scope: DeliveryScope;
  ownerFence: DeliveryOwnerFence | null;
  parentPaneId: string | null;
  deliveryOrder: number;
  workClass: OutboundWorkClass;
  idempotencyKey: string;
  gatewayId: string;
  gatewayProfileId: string;
  preparedPlan: PreparedDeliveryPlan;
  planHash: string;
  conflictKey: string;
  projectionKey: string | null;
  snapshotRevision: number;
  rendererRevision: number;
  cardSequence: number | null;
  priorCheckpoints: readonly PreparedDeliveryCheckpoint[];
  nextAttemptAt: string;
  estimatedBytes: number;
}>;

/** Complete provider-neutral Ring work persisted before Gateway preparation. */
export type SemanticDeliveryWork = Readonly<{
  replyId: string;
  scope: DeliveryScope;
  ownerFence: DeliveryOwnerFence | null;
  parentPaneId: string | null;
  deliveryOrder: number;
  workClass: OutboundWorkClass;
  idempotencyKey: string;
  gatewayId: string;
  gatewayProfileId: string;
  deliveryKind: "card_reply" | "card_update";
  rootMessageId: string;
  cardSequence: number | null;
  conflictKey: string;
  projectionKey: string | null;
  snapshotRevision: number;
  priorCheckpoints: readonly PreparedDeliveryCheckpoint[];
  nextAttemptAt: string;
  estimatedBytes: number;
  input: SemanticSnapshotDeliveryInput;
  preparationState: Exclude<DeliveryPreparationState, "prepared">;
}>;

export type DeliveryRingWork = PreparedDelivery | SemanticDeliveryWork;

export type PreparedDeliveryClaim = Readonly<{
  replyId: string;
  attemptId: string;
  ownerId: string;
  fencingToken: number;
  planHash: string;
  snapshotRevision: number;
}>;

export type PreparedDeliveryAck = Readonly<{
  messageId: string;
  surfaceId: string | null;
  threadId: string | null;
  messageDeleteOutcome?: "deleted" | "already_absent";
}>;

export type PreparedDeliveryFailure = Readonly<{
  error: string;
  metadata: DeliveryFailureMetadata;
  retryAt: string;
}>;

export class PreparedDeliveryPoisonError extends Error {
  readonly name = "PreparedDeliveryPoisonError";
}

export interface BindingThreadAlias {
  id: string; publicationKey: string; bindingId: string; bindingGeneration: number; chatId: string; paneId: string; sourceMainMessageId: string;
  actionMessageId: string; topicId: string | null; rootMessageId: string | null; state: "reserving" | "active" | "stale"; createdAt: string; updatedAt: string;
}

export interface OutboundFailureTransition { state: OutboundReplyState; action: OutboxQuarantineAction; laneClass: OutboxLaneClass; promptId: string | null; reply: OutboundReply }
export interface StaleOutboxQuarantineRecovery {
  retriedAnswerPromptIds: string[];
  rolledBackAnswerPromptIds: string[];
  dismissedNotices: number;
  dismissedRejectedImmutableEffects: number;
  dismissedExpiredWorkerTargets?: number;
  dismissedDefunctTargets?: number;
  retiredExpiredMessageDeletes?: number;
  resolvedSupersededAnswerTargets: number;
  releasedSupersededWorkerMainUpdates: number;
  releasedSupersededPrimaryMainUpdates?: number;
  releasedSupersededPaneEntryUpdates?: number;
  releasedRejectedWorkerTurnFinalizers?: number;
  releasedAuthoritativeWorkerTurnSnapshots?: number;
  terminalizedQuarantines: number;
}
export interface AnswerPage { promptId: string; pageIndex: number; messageId: string | null; cardId: string | null; elementId: string; sourceStart: number; sequence: number; state: AnswerPageState; deliveryMode: AnswerPageDeliveryMode; createdAt: string; updatedAt: string }
export interface AnswerPageDeliveryFacts { latestContent: { content: string; sequence: number; state: OutboundReplyState; sourceEnd?: number | null } | null; finishPending: boolean; continuationPending: boolean; finalUpdateState: OutboundReplyState | null }
export interface AnswerTimelineCursor {
  itemIndex: number;
  /** Legacy message offset retained for durable checkpoint compatibility. */
  markdownOffset: number;
  section?: "message" | "command" | "result";
  offset?: number;
}
export interface AnswerTimelinePageCheckpoint {
  startCursor: AnswerTimelineCursor;
  deliveredCursor: AnswerTimelineCursor | null;
  deliveredItems: Array<{ id: string; fingerprint: string }>;
  pending: boolean;
}
export interface AnswerTimelineFrozenItem { pageIndex: number; id: string; fingerprint: string }
