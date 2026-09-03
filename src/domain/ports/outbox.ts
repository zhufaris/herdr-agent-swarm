import type { InstanceStore } from "./instance.js";
import type { AnswerPage, Binding, OutboundFailureTransition, OutboundReply, OutboxDispatcherDiagnostics, PromptJob, DeliveryFailureMetadata } from "../types.js";
import type { RunCardView } from "../run-card-view.js";
import type { WorkerTurnCardPage, WorkerTurnCardView } from "../worker-turn-card-view.js";

export interface OutboxStore {
  checkpointOutboundReplyCard(id: string, cardId: string): OutboundReply | null;
  enqueueOutboundReply(input: Omit<OutboundReply, "promptId" | "workerTurnId" | "viewVersion" | "cardSequence" | "selectionId" | "cardRole" | "targetRole" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "cardIdCheckpoint" | "failureClass" | "httpStatus" | "larkErrorCode" | "autoRecoveryCount" | "deadLetteredAt" | "nextAttemptAt" | "createdAt" | "updatedAt"> & { promptId?: string | null; workerTurnId?: string | null; viewVersion?: number | null; cardSequence?: number | null; selectionId?: string | null; cardRole?: OutboundReply["cardRole"]; targetRole?: OutboundReply["targetRole"] }): OutboundReply;
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  getBinding(id: string): Binding | null;
  getNextOutboundLaneHeadAttemptAt(): string | null;
  getPrompt(id: string): PromptJob | null;
  listOutboundLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys?: readonly string[]): OutboundReply[];
  loadRunCard(promptId: string): RunCardView | null;
  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string): void;
  markOutboundReplyFailedWithQuarantine(id: string, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number): OutboundFailureTransition | null;
  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[];
  recordBridgeMessage(messageId: string): void;
  dismissSupersededAnswerStream(replyId: string): boolean;
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
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
  enqueueRunCardUpdate(bindingId: string, promptId: string, messageId: string, viewVersion: number, cardRole: "task" | "answer", card: object): Promise<void>;
  enqueueStreamContent(bindingId: string, promptId: string, cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  enqueueStreamCardCreate(input: { bindingId: string; promptId: string; rootMessageId: string; card: object; pageIndex: number; pageStart: number; elementId: string; viewVersion: number }): Promise<void>;
  enqueueStreamFinish(bindingId: string, promptId: string, cardId: string, summary: string, sequence: number): Promise<void>;
}

export interface OutboundCheckpointSubscriber {
  onAnswerCheckpoint(listener: (promptId: string, viewVersion: number) => void): () => void;
  onWorkerTurnCheckpoint(listener: (turnId: string, viewVersion: number) => void): () => void;
  onMainCardCheckpoint(listener: (bindingId: string, viewVersion: number) => void): () => void;
  requestScan(force?: boolean): Promise<void>;
}
export interface ImmediateOutboundDispatcher { requestScan(force?: boolean): Promise<void>; }
export interface OutboxDispatcherControl { start(): () => void; stop(): Promise<void>; requestScan(force?: boolean): Promise<void>; snapshot(): OutboxDispatcherDiagnostics; }
