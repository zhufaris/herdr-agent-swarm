import type { OutboundDeliveryClaim } from "../../domain/delivery.js";
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
import { SqliteBindingThreadAliasStore, type ReservePaneThreadAliasInput } from "./binding-thread-alias-store.js";
import { SqliteWorkerSessionThreadStore } from "./worker-session-thread-store.js";
import { SqliteLarkDeliveryCooldownStore } from "./lark-delivery-cooldown-store.js";

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
  readonly cooldown: SqliteLarkDeliveryCooldownStore;

  constructor(context: SqliteContext, dependencies: Dependencies, private readonly threadAliases = new SqliteBindingThreadAliasStore(context), private readonly workerThreads = new SqliteWorkerSessionThreadStore(context)) {
    this.cooldown = new SqliteLarkDeliveryCooldownStore(context);
    this.queue = new SqliteOutboxQueueStore(context, dependencies, this.cooldown);
    this.workerThreads.connectOutbox((input) => this.queue.enqueue(input));
    this.delivery = new SqliteOutboxDeliveryStore(context, this.queue, dependencies, this.workerThreads, this.cooldown);
    this.recovery = new SqliteOutboxRecoveryStore(context, this.queue, this.delivery, dependencies);
    this.retention = new SqliteOutboxRetentionStore(context);
  }

  enqueueOutboundReply(input: EnqueueOutboundReplyInput): OutboundReply { return this.queue.enqueue(input); }
  listPendingOutboundReplies(): OutboundReply[] { return this.queue.listPending(); }
  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean { return this.queue.hasPendingForWorkerTurn(turnId); }
  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean { return this.queue.hasPendingAnswerContinuation(promptId, pageIndex); }
  dismissSupersededAnswerStream(replyId: string): boolean { return this.queue.dismissSupersededAnswerStream(replyId); }
  listOutboundLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys: readonly string[] = [], workClass?: import("../../domain/types.js").OutboundWorkClass): OutboundReply[] { return this.queue.listLaneHeads(limit, dueAt, excludedLaneKeys, workClass); }
  getNextOutboundLaneHeadAttemptAt(): string | null { return this.queue.getNextLaneHeadAttemptAt(); }
  getLarkDeliveryCooldown(): import("../../domain/types.js").LarkDeliveryCooldownSummary { return this.cooldown.snapshot(); }
  refreshOutboxLaneHead(laneKey: string): void { this.queue.refreshLaneHead(laneKey); }
  getOutboundReply(id: string): OutboundReply | null { return this.queue.get(id); }
  reservePaneThreadAlias(input: ReservePaneThreadAliasInput): "reserved" | "duplicate" | "stale" { return this.threadAliases.reserve(input, this.queue); }

  prepareOutboundGatewayPlan(id: string, input: { gatewayId: string; gatewayProfileId: string; gatewayPlanJson: string }): OutboundReply | null { return this.queue.prepareGatewayPlan(id, input); }
  claimOutboundReply(id: string, dueAt: string | null): OutboundDeliveryClaim | null { return this.queue.claim(id, dueAt); }
  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string, claim?: OutboundDeliveryClaim, topicId?: string): boolean { return this.delivery.markDelivered(id, messageId, cardId, claim, topicId); }
  checkpointOutboundReplyCard(id: string, cardId: string, claim?: OutboundDeliveryClaim): OutboundReply | null { return this.delivery.checkpointCard(id, cardId, claim); }
  markOutboundReplyFailed(id: string, error: string, retryDelayMs?: number, metadata?: DeliveryFailureMetadata): OutboundReply | null { return this.delivery.markFailed(id, error, retryDelayMs, metadata); }
  markOutboundReplyDeadLetter(id: string, error: string, metadata?: DeliveryFailureMetadata): OutboundReply | null { return this.delivery.markDeadLetter(id, error, metadata); }

  markOutboundReplyFailedWithQuarantine(id: string, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number, claim?: OutboundDeliveryClaim): OutboundFailureTransition | null { return this.recovery.markOutboundReplyFailedWithQuarantine(id, error, metadata, retryDelayMs, claim); }
  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] { return this.recovery.recoverEligibleDeadLetters(cutoff, limit); }
  retireUndeliveredWorkerTaskCardIntents(): number { return this.recovery.retireUndeliveredWorkerTaskCardIntents(); }
  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery { return this.recovery.recoverStaleOutboxQuarantines(); }
  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome { return this.recovery.retryDeadLetter(id, chatId, actorOpenId); }
  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome { return this.recovery.dismissDeadLetter(id, chatId, actorOpenId); }

  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number { return this.retention.pruneDelivered(cutoff, limit); }
}
