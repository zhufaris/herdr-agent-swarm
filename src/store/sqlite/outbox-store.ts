import type { OutboundDeliveryClaim, PreparedDeliveryPlan } from "../../domain/delivery.js";
import type { AnswerPage, Binding, DeadLetterActionOutcome, DeliveryFailureMetadata, OutboundFailureTransition, OutboundReply, StaleOutboxQuarantineRecovery } from "../../domain/types.js";
import type { DeliveryReservationIdentity, PreparedDeliveryConsumer, PreparedDeliveryReservation, SemanticDeliveryReservationInput } from "../../domain/ports/outbox.js";
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
import { SqliteShortcutPanelStore } from "./shortcut-panel-store.js";
import { SqlitePreparedDeliveryStore } from "./prepared-delivery-store.js";
import type { ReserveValidatedCardDismissalInput } from "../../domain/ports/card-dismissal.js";
import type { RejectedTurnCardRootRecovery } from "../../domain/ports/conversation-segment.js";

type Dependencies = {
  getBinding(id: string): Binding | null;
  getAgentInstance(id: string): import("../../domain/agent-instance.js").AgentInstance | null;
  loadRunCard(promptId: string): RunCardView | null;
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
  listWorkerTurnCardPages(turnId: string): import("../../domain/worker-turn-card-view.js").WorkerTurnCardPage[];
  loadWorkerMainView(workerId: string, workerSessionGeneration: number): WorkerMainView | null;
  saveRunCard(view: RunCardView): RunCardView;
  persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
  invalidateCardContexts(targets: readonly (CardContextTarget & { reason: string })[]): unknown;
  settleMessageDeletion?(input: { outboundReplyId: string; outcome: "deleted" | "already_absent" | "failed"; detail?: string | null }): unknown;
  reserveCardDismissal(input: ReserveValidatedCardDismissalInput): unknown;
  reconcileExpiredMessageDeletion(outboundReplyId: string): boolean;
  rebuildRejectedTurnCardRoot(failedReplyId: string, recoveredAt: string): RejectedTurnCardRootRecovery | null;
};

export class SqliteOutboxStore {
  private readonly queue: SqliteOutboxQueueStore;
  private readonly delivery: SqliteOutboxDeliveryStore;
  private readonly recovery: SqliteOutboxRecoveryStore;
  private readonly retention: SqliteOutboxRetentionStore;
  private readonly shortcutPanel: SqliteShortcutPanelStore;
  readonly preparedDelivery: SqlitePreparedDeliveryStore;
  readonly cooldown: SqliteLarkDeliveryCooldownStore;

  constructor(private readonly context: SqliteContext, private readonly dependencies: Dependencies, private readonly threadAliases = new SqliteBindingThreadAliasStore(context), private readonly workerThreads = new SqliteWorkerSessionThreadStore(context)) {
    this.cooldown = new SqliteLarkDeliveryCooldownStore(context);
    this.queue = new SqliteOutboxQueueStore(context, dependencies);
    this.delivery = new SqliteOutboxDeliveryStore(context, this.queue, dependencies, this.workerThreads, this.cooldown);
    this.recovery = new SqliteOutboxRecoveryStore(context, this.queue, this.delivery, dependencies, this.threadAliases);
    this.retention = new SqliteOutboxRetentionStore(context);
    this.preparedDelivery = new SqlitePreparedDeliveryStore(context, this.queue, this.delivery, this.recovery, dependencies.settleMessageDeletion);
    this.shortcutPanel = new SqliteShortcutPanelStore(this.context, this.queue);
  }

  enqueueOutboundReply(input: EnqueueOutboundReplyInput): OutboundReply { return this.queue.enqueue(input); }
  setGatewayPlanPreparer(preparer: (reply: OutboundReply) => PreparedDeliveryPlan): void { this.preparedDelivery.setGatewayPlanPreparer(preparer); }
  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.delivery.setPreparedDeliveryReservation(reservation, consumer);
    this.recovery.setPreparedDeliveryReservation(reservation, consumer);
    this.shortcutPanel.setPreparedDeliveryReservation(reservation, consumer);
  }
  reservePreparedOutboundReply(input: EnqueueOutboundReplyInput): ReturnType<SqlitePreparedDeliveryStore["reserve"]> { return this.preparedDelivery.reserve(input); }
  reserveSemanticOutboundReply(input: SemanticDeliveryReservationInput): ReturnType<SqlitePreparedDeliveryStore["reserveSemantic"]> { return this.preparedDelivery.reserveSemantic(input); }
  previewSemanticOutboundReply(input: SemanticDeliveryReservationInput): DeliveryReservationIdentity { return this.queue.preview(input as EnqueueOutboundReplyInput); }
  getReservedDeliveryIdentity(replyId: string): DeliveryReservationIdentity | null { return this.queue.getReservationIdentity(replyId); }
  listPendingOutboundReplies(limit?: number): OutboundReply[] { return this.queue.listPending(limit); }
  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean { return this.queue.hasPendingForWorkerTurn(turnId); }
  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean { return this.queue.hasPendingAnswerContinuation(promptId, pageIndex); }
  dismissSupersededAnswerStream(replyId: string): boolean { return this.queue.dismissSupersededAnswerStream(replyId); }
  getLarkDeliveryCooldown(): import("../../domain/types.js").LarkDeliveryCooldownSummary { return this.cooldown.snapshot(); }
  getOutboundReply(id: string): OutboundReply | null { return this.queue.get(id); }
  getWorkerThreadTarget(threadId: string): import("../../domain/ports/outbox.js").WorkerThreadDeliveryTarget | null { return this.workerThreads.getDeliveryTarget(threadId); }
  reservePaneThreadAlias(input: ReservePaneThreadAliasInput): "reserved" | "duplicate" | "stale" { return this.threadAliases.reserve(input, this.queue); }
  reserveShortcutPanel(chatId: string, card: object): "reserved" | "current" | "pending" { return this.shortcutPanel.reserve(chatId, card); }

  prepareOutboundGatewayPlan(id: string, input: { gatewayId: string; gatewayProfileId: string; gatewayPlanJson: string }): OutboundReply | null { return this.queue.prepareGatewayPlan(id, input); }
  claimOutboundReply(id: string, dueAt: string | null): OutboundDeliveryClaim | null { return this.queue.claim(id, dueAt); }
  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string, claim?: OutboundDeliveryClaim, topicId?: string, messageDeleteOutcome?: "deleted" | "already_absent"): boolean { return this.delivery.markDelivered(id, messageId, cardId, claim, topicId, messageDeleteOutcome); }
  dismissEligibleLegacyCompletionNotifications(bindingIds?: readonly string[]): number { return this.delivery.dismissEligibleLegacyCompletionNotifications(bindingIds); }
  checkpointOutboundReplyCard(id: string, cardId: string, claim?: OutboundDeliveryClaim): OutboundReply | null { return this.delivery.checkpointCard(id, cardId, claim); }
  markOutboundReplyFailed(id: string, error: string, retryDelayMs?: number, metadata?: DeliveryFailureMetadata): OutboundReply | null { return this.delivery.markFailed(id, error, retryDelayMs, metadata); }
  markOutboundReplyDeadLetter(id: string, error: string, metadata?: DeliveryFailureMetadata): OutboundReply | null { const reply = this.delivery.markDeadLetter(id, error, metadata); if (reply?.kind === "message_delete") this.dependencies.settleMessageDeletion?.({ outboundReplyId: reply.id, outcome: "failed", detail: error }); return reply; }

  markOutboundReplyFailedWithQuarantine(id: string, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number, claim?: OutboundDeliveryClaim): OutboundFailureTransition | null { const transition = this.recovery.markOutboundReplyFailedWithQuarantine(id, error, metadata, retryDelayMs, claim); if (transition?.reply.kind === "message_delete" && (transition.reply.state === "dead_letter" || transition.reply.state === "dismissed")) this.dependencies.settleMessageDeletion?.({ outboundReplyId: transition.reply.id, outcome: "failed", detail: error }); return transition; }
  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] { return this.recovery.recoverEligibleDeadLetters(cutoff, limit); }
  retireUndeliveredWorkerTaskCardIntents(): number { return this.recovery.retireUndeliveredWorkerTaskCardIntents(); }
  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery { return this.recovery.recoverStaleOutboxQuarantines(); }
  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome { return this.recovery.retryDeadLetter(id, chatId, actorOpenId); }
  dismissDeadLetter(id: string, chatId: string, actorOpenId: string, sourceMessageId?: string): DeadLetterActionOutcome { return this.recovery.dismissDeadLetter(id, chatId, actorOpenId, sourceMessageId); }

  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number { return this.retention.pruneDelivered(cutoff, limit); }
  compactDeliveryIntents(limit: number): number { return this.retention.compactDeliveryIntents(limit); }
  classifyHistoricalDeliveryDebt(cutoff: string, limit: number): import("../../domain/ports/retention.js").HistoricalDeliveryDebtMaintenance { return this.retention.classifyHistoricalDeliveryDebt(cutoff, limit); }
}
