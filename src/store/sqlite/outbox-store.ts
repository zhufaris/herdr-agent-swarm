import type { AnswerPage, Binding, DeadLetterActionOutcome, DeliveryFailureMetadata, OutboundFailureTransition, OutboundReply, StaleOutboxQuarantineRecovery } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import type { WorkerMainView } from "../../domain/worker-main-view.js";
import type { CardContextTarget } from "../../domain/card-context-invalidation.js";
import type { SqliteContext } from "./context.js";
import { SqliteOutboxQueueStore, type EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import { SqliteOutboxDeliveryStore } from "./outbox-delivery-store.js";
import { SqliteOutboxRecoveryStore } from "./outbox-recovery-store.js";
import { SqliteOutboxRetentionStore } from "./outbox-retention-store.js";

type Dependencies = {
  getBinding(id: string): Binding | null;
  loadRunCard(promptId: string): RunCardView | null;
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
  listWorkerTurnCardPages(turnId: string): import("../../domain/worker-turn-card-view.js").WorkerTurnCardPage[];
  loadWorkerMainView(workerId: string, workerSessionGeneration: number): WorkerMainView | null;
  saveRunCard(view: RunCardView): RunCardView;
  persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
  invalidateCardContexts(targets: readonly (CardContextTarget & { reason: string })[]): unknown;
};

export class SqliteOutboxStore {
  private readonly queue: SqliteOutboxQueueStore;
  private readonly delivery: SqliteOutboxDeliveryStore;
  private readonly recovery: SqliteOutboxRecoveryStore;
  private readonly retention: SqliteOutboxRetentionStore;

  constructor(context: SqliteContext, dependencies: Dependencies) {
    this.queue = new SqliteOutboxQueueStore(context, dependencies);
    this.delivery = new SqliteOutboxDeliveryStore(context, this.queue, dependencies);
    this.recovery = new SqliteOutboxRecoveryStore(context, this.queue, this.delivery, dependencies);
    this.retention = new SqliteOutboxRetentionStore(context);
  }

  enqueueOutboundReply(input: EnqueueOutboundReplyInput): OutboundReply { return this.queue.enqueue(input); }
  listPendingOutboundReplies(): OutboundReply[] { return this.queue.listPending(); }
  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean { return this.queue.hasPendingForWorkerTurn(turnId); }
  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean { return this.queue.hasPendingAnswerContinuation(promptId, pageIndex); }
  dismissSupersededAnswerStream(replyId: string): boolean { return this.queue.dismissSupersededAnswerStream(replyId); }
  listOutboundLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys: readonly string[] = []): OutboundReply[] { return this.queue.listLaneHeads(limit, dueAt, excludedLaneKeys); }
  getNextOutboundLaneHeadAttemptAt(): string | null { return this.queue.getNextLaneHeadAttemptAt(); }
  refreshOutboxLaneHead(laneKey: string): void { this.queue.refreshLaneHead(laneKey); }
  getOutboundReply(id: string): OutboundReply | null { return this.queue.get(id); }

  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string): void { this.delivery.markDelivered(id, messageId, cardId); }
  checkpointOutboundReplyCard(id: string, cardId: string): OutboundReply | null { return this.delivery.checkpointCard(id, cardId); }
  markOutboundReplyFailed(id: string, error: string, retryDelayMs?: number, metadata?: DeliveryFailureMetadata): OutboundReply | null { return this.delivery.markFailed(id, error, retryDelayMs, metadata); }
  markOutboundReplyDeadLetter(id: string, error: string, metadata?: DeliveryFailureMetadata): OutboundReply | null { return this.delivery.markDeadLetter(id, error, metadata); }

  markOutboundReplyFailedWithQuarantine(id: string, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number): OutboundFailureTransition | null { return this.recovery.markOutboundReplyFailedWithQuarantine(id, error, metadata, retryDelayMs); }
  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] { return this.recovery.recoverEligibleDeadLetters(cutoff, limit); }
  recoverUnsupportedWorkerCardCreates(render: (view: WorkerTurnCardView) => object): string[] { return this.recovery.recoverUnsupportedWorkerCardCreates(render); }
  convergeWorkerTaskCardRenderer(revision: string, render: (view: WorkerTurnCardView, page?: import("../../domain/worker-turn-card-view.js").WorkerTurnCardPage) => object): string[] { return this.recovery.convergeWorkerTaskCardRenderer(revision, render); }
  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery { return this.recovery.recoverStaleOutboxQuarantines(); }
  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome { return this.recovery.retryDeadLetter(id, chatId, actorOpenId); }
  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome { return this.recovery.dismissDeadLetter(id, chatId, actorOpenId); }

  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number { return this.retention.pruneDelivered(cutoff, limit); }
}
