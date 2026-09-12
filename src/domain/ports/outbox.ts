import type { AnswerPage, Binding, OutboundFailureTransition, OutboundReply, OutboxDispatcherDiagnostics, PromptJob, DeliveryFailureMetadata, LarkDeliveryCooldownSummary, OutboundWorkClass } from "../types.js";
import type { RunCardView } from "../run-card-view.js";
import type { WorkerTurnCardPage, WorkerTurnCardView } from "../worker-turn-card-view.js";

import type { OutboundDeliveryClaim } from "../delivery.js";

export interface OutboxStore {
  claimOutboundReply(id: string, dueAt: string | null): OutboundDeliveryClaim | null;
  checkpointOutboundReplyCard(claim: OutboundDeliveryClaim, cardId: string): OutboundReply | null;
  enqueueOutboundReply(input: Omit<OutboundReply, "gatewayId" | "gatewayProfileId" | "gatewayPlanJson" | "gatewayPlanHash" | "gatewayCheckpointJson" | "laneKey" | "workClass" | "threadAliasId" | "workerThreadId" | "targetChatId" | "promptId" | "workerTurnId" | "workerId" | "workerSessionGeneration" | "viewVersion" | "cardSequence" | "selectionId" | "cardRole" | "targetRole" | "intentKind" | "intentJson" | "rendererRevision" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "cardIdCheckpoint" | "failureClass" | "effectCertainty" | "httpStatus" | "larkErrorCode" | "autoRecoveryCount" | "deadLetteredAt" | "nextAttemptAt" | "createdAt" | "updatedAt"> & { gatewayId?: string; gatewayProfileId?: string; gatewayPlanJson?: string | null; gatewayPlanHash?: string | null; gatewayCheckpointJson?: string | null; threadAliasId?: string | null; workerThreadId?: string | null; targetChatId?: string | null; workClass?: OutboundWorkClass; promptId?: string | null; workerTurnId?: string | null; workerId?: string | null; workerSessionGeneration?: number | null; viewVersion?: number | null; cardSequence?: number | null; selectionId?: string | null; cardRole?: OutboundReply["cardRole"]; targetRole?: OutboundReply["targetRole"]; intentKind?: OutboundReply["intentKind"]; intentJson?: string | null; rendererRevision?: number | null }): OutboundReply;
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  getBinding(id: string): Binding | null;
  isActiveBindingThreadAlias(bindingId: string, rootMessageId: string): boolean;
  getNextOutboundLaneHeadAttemptAt(): string | null;
  getLarkDeliveryCooldown(): LarkDeliveryCooldownSummary;
  getPrompt(id: string): PromptJob | null;
  listOutboundLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys?: readonly string[], workClass?: OutboundWorkClass): OutboundReply[];
  loadRunCard(promptId: string): RunCardView | null;
  markOutboundReplyDelivered(claim: OutboundDeliveryClaim, messageId: string, cardId?: string, topicId?: string): boolean;
  markOutboundReplyFailedWithQuarantine(claim: OutboundDeliveryClaim, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number): OutboundFailureTransition | null;
  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[];
  recordBridgeMessage(messageId: string): void;
  dismissSupersededAnswerStream(replyId: string): boolean;
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
  loadWorkerMainView(workerId: string, workerSessionGeneration: number): import("../worker-main-view.js").WorkerMainView | null;
  listWorkerTurnCardPages(turnId: string): WorkerTurnCardPage[];
}

export interface OutboundIntentStore {
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0]): OutboundReply;
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
}

export interface OutboundCheckpointSubscriber {
  onAnswerCheckpoint(listener: (promptId: string, viewVersion: number) => void): () => void;
  onWorkerTurnCheckpoint(listener: (turnId: string, viewVersion: number) => void): () => void;
  onWorkerMainCheckpoint(listener: (workerId: string, workerSessionGeneration: number, viewVersion: number) => void): () => void;
  onMainCardCheckpoint(listener: (bindingId: string, viewVersion: number) => void): () => void;
  requestScan(force?: boolean): Promise<void>;
}
export interface ImmediateOutboundDispatcher { requestScan(force?: boolean): Promise<void>; }
export interface OutboxDispatcherControl { start(): () => void; stop(): Promise<void>; requestScan(force?: boolean): Promise<void>; snapshot(): OutboxDispatcherDiagnostics; }
