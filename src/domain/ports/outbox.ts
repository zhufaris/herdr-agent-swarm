import type { AnswerPage, Binding, OutboundFailureTransition, OutboundReply, PromptJob, DeliveryFailureMetadata, LarkDeliveryCooldownSummary, OutboundWorkClass } from "../types.js";
import type { RunCardView } from "../run-card-view.js";
import type { WorkerTurnCardPage, WorkerTurnCardView } from "../worker-turn-card-view.js";

import type { DeliveryRingWork, DeliverySubject, OutboundDeliveryClaim, PreparedDeliveryPlan, PresentationSnapshot } from "../delivery.js";
import type { AnswerTimelinePageCheckpoint } from "../delivery.js";
import type { DeliveryOwnerFence, DeliveryScope } from "../delivery-scope.js";

export interface DeliveryReservationIdentity {
  readonly deliveryTarget: { gatewayId: string; kind: OutboundReply["kind"]; rootMessageId: string | null; targetChatId: string | null };
  readonly scope: DeliveryScope | null;
  readonly ownerFence: DeliveryOwnerFence | null;
  readonly parentPaneId: string | null;
  readonly laneKey: string;
  readonly conflictKey: string;
  readonly orderingIdentity: string;
  readonly idempotencyKey: string;
}

export interface PreparedDeliveryReceipt {
  readonly commitState: "pending" | "committed" | "rolled_back";
  readonly result: OutboundReply;
  consumeEffects(): readonly DeliveryRingWork[];
}

export type PreparedDeliveryReservationInput = Parameters<OutboxStore["enqueueOutboundReply"]>[0] & {
  laneKeyOverride?: string;
  bindingGeneration?: number | null;
  globalDelivery?: true;
};

export type SemanticDeliveryReservationInput = PreparedDeliveryReservationInput & {
  projectionKey: string;
  snapshotRevision: number;
  subject: DeliverySubject;
  snapshot: PresentationSnapshot;
  plannerPolicyVersion: number;
  rendererPolicyVersion: number;
  gatewayProfileVersion: number;
};

export interface PreparedDeliveryReservation {
  reservePreparedOutboundReply(input: PreparedDeliveryReservationInput): PreparedDeliveryReceipt;
  reserveSemanticOutboundReply(input: SemanticDeliveryReservationInput): PreparedDeliveryReceipt;
  previewSemanticOutboundReply(input: SemanticDeliveryReservationInput): DeliveryReservationIdentity;
  getReservedDeliveryIdentity(replyId: string): DeliveryReservationIdentity | null;
}

export interface PreparedDeliveryConsumer {
  enqueuePreparedDelivery(delivery: DeliveryRingWork): void;
}

export interface PreparedDeliveryProducerConnector {
  connectPreparedDeliveryProducers(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void;
}

export interface GatewayPlanPreparerConnector {
  setGatewayPlanPreparer(preparer: (reply: OutboundReply) => PreparedDeliveryPlan): void;
}

export interface WorkerThreadDeliveryTarget {
  threadId: string;
  workerId: string;
  workerSessionGeneration: number;
  chatId: string;
  topicId: string | null;
  rootMessageId: string | null;
  state: "reserving" | "active" | "stale";
}

export interface OutboxStore extends PreparedDeliveryReservation, GatewayPlanPreparerConnector {
  prepareOutboundGatewayPlan(id: string, input: { gatewayId: string; gatewayProfileId: string; gatewayPlanJson: string }): OutboundReply | null;
  checkpointOutboundReplyCard(claim: OutboundDeliveryClaim, cardId: string): OutboundReply | null;
  enqueueOutboundReply(input: Omit<OutboundReply, "gatewayId" | "gatewayProfileId" | "gatewayPlanJson" | "gatewayPlanHash" | "gatewayCheckpointJson" | "laneKey" | "conflictKey" | "projectionKey" | "workClass" | "threadAliasId" | "workerThreadId" | "shortcutPanelId" | "targetChatId" | "promptId" | "workerTurnId" | "workerId" | "workerSessionGeneration" | "viewVersion" | "cardSequence" | "selectionId" | "streamPageIndex" | "streamElementId" | "cardRole" | "targetRole" | "intentKind" | "intentJson" | "rendererRevision" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "cardIdCheckpoint" | "failureClass" | "effectCertainty" | "httpStatus" | "larkErrorCode" | "autoRecoveryCount" | "deadLetteredAt" | "nextAttemptAt" | "createdAt" | "updatedAt" | "deliveryScope" | "deliveryOwnerFence" | "deliveryParentPaneId"> & { gatewayId?: string; gatewayProfileId?: string; gatewayPlanJson?: string | null; gatewayPlanHash?: string | null; gatewayCheckpointJson?: string | null; threadAliasId?: string | null; workerThreadId?: string | null; shortcutPanelId?: string | null; targetChatId?: string | null; workClass?: OutboundWorkClass; promptId?: string | null; workerTurnId?: string | null; workerId?: string | null; workerSessionGeneration?: number | null; viewVersion?: number | null; cardSequence?: number | null; selectionId?: string | null; streamPageIndex?: number | null; streamElementId?: string | null; cardRole?: OutboundReply["cardRole"]; targetRole?: OutboundReply["targetRole"]; intentKind?: OutboundReply["intentKind"]; intentJson?: string | null; rendererRevision?: number | null; globalDelivery?: true }): OutboundReply;
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  getAnswerPage(promptId: string, pageIndex: number): AnswerPage | null;
  getAnswerTimelinePage(promptId: string, pageIndex: number): AnswerTimelinePageCheckpoint;
  getWorkerAnswerTimelinePage(turnId: string, pageIndex: number): AnswerTimelinePageCheckpoint;
  getBinding(id: string): Binding | null;
  getOutboundReply(id: string): OutboundReply | null;
  isActiveBindingThreadAlias(bindingId: string, rootMessageId: string): boolean;
  getLarkDeliveryCooldown(): LarkDeliveryCooldownSummary;
  getPrompt(id: string): PromptJob | null;
  loadRunCard(promptId: string): RunCardView | null;
  markOutboundReplyDelivered(claim: OutboundDeliveryClaim, messageId: string, cardId?: string, topicId?: string, messageDeleteOutcome?: "deleted" | "already_absent"): boolean;
  markOutboundReplyFailedWithQuarantine(claim: OutboundDeliveryClaim, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number): OutboundFailureTransition | null;
  rejectUnclaimedOutboundReply(id: string, error: string, metadata: DeliveryFailureMetadata): OutboundFailureTransition | null;
  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[];
  recordBridgeMessage(messageId: string): void;
  dismissSupersededAnswerStream(replyId: string): boolean;
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
  loadWorkerMainView(workerId: string, workerSessionGeneration: number): import("../worker-main-view.js").WorkerMainView | null;
  listWorkerTurnCardPages(turnId: string): WorkerTurnCardPage[];
  getWorkerThreadTarget(threadId: string): WorkerThreadDeliveryTarget | null;
}

export type GatewayIntentPreparationStore = Pick<OutboxStore,
  "getActiveAnswerPage" | "getAnswerPage" | "getBinding" | "getWorkerThreadTarget" |
  "getAnswerTimelinePage" | "getWorkerAnswerTimelinePage" | "getPrompt" | "isActiveBindingThreadAlias" |
  "listWorkerTurnCardPages" | "loadRunCard" | "loadWorkerMainView" | "loadWorkerTurnCard"
>;

export interface OutboundIntentStore extends PreparedDeliveryReservation {
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  getBinding(id: string): Binding | null;
  loadRunCard(promptId: string): RunCardView | null;
}

export interface OutboundIntentPort {
  enqueueCard(rootMessageId: string, idempotencyKey: string, card: object, bindingId?: string | null, targetRole?: OutboundReply["targetRole"]): Promise<void>;
  enqueueCardUpdate(bindingId: string | null, messageId: string, eventId: string, card: object): Promise<void>;
  enqueueRunCardUpdate(bindingId: string, promptId: string, messageId: string, viewVersion: number, cardRole: "task" | "answer", card: object, workClass?: OutboundWorkClass): Promise<void>;
  enqueueStreamContent(bindingId: string, promptId: string, cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  enqueueStreamCardCreate(input: { bindingId: string; promptId: string; rootMessageId: string; card: object; pageIndex: number; pageStart: number; elementId: string; viewVersion: number }): Promise<void>;
  enqueueStreamFinish(bindingId: string, promptId: string, cardId: string, summary: string, sequence: number): Promise<void>;
  enqueueMessageDelete(bindingId: string | null, messageId: string, idempotencyKey: string): Promise<void>;
}

export interface OutboundCheckpointSubscriber {
  onTurnCardCheckpoint?(listener: (segmentId: string, pageIndex: number, replyId: string, messageId: string, cardId: string | null) => void): () => void;
  onTurnCardRecoveryCheckpoint?(listener: (segmentId: string) => void): () => void;
  onAnswerCheckpoint(listener: (promptId: string, viewVersion: number) => void): () => void;
  onWorkerTurnCheckpoint(listener: (turnId: string, viewVersion: number) => void): () => void;
  onWorkerMainCheckpoint(listener: (workerId: string, workerSessionGeneration: number, viewVersion: number) => void): () => void;
  onMainCardCheckpoint(listener: (bindingId: string, viewVersion: number) => void): () => void;
}
