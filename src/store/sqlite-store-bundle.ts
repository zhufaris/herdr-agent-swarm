import type { BindingProvisioningStore, RetiredPaneCleanupStore, RuntimeReconciliationStore } from "../domain/ports/binding.js";
import type { CardContextProjectionStore } from "../domain/ports/card-context.js";
import type { HealthStore, LeaseStore } from "../domain/ports/health.js";
import type { InstanceLifecycleStore, InstanceStore, InstanceTurnStore } from "../domain/ports/instance.js";
import type { OutboundIntentStore, OutboxStore } from "../domain/ports/outbox.js";
import type { PaneCloseStore, PaneControlStore } from "../domain/ports/pane-operations.js";
import type { PromptAcceptanceStore, PromptRunStore } from "../domain/ports/prompt.js";
import type { AnswerPageStore, MainCardStore, ProjectionStore, QueueFeedbackStore, WorkerTurnCardStore } from "../domain/ports/projection.js";
import type { CommandIntentStore } from "../domain/ports/swarm-command.js";
import type { TurnControlStore } from "../domain/ports/turn-control.js";
import type { WorkerCardDisplayStore } from "../domain/ports/worker-card-display.js";
import type { CardInteractionStore, DeliveryRecoveryStore, ExternalTurnObservationStore, InboundMessageDispatchStore, InboundRoutingStore, ModelSelectionStore, OperationsQueryStore, PaneRetentionStore, SessionAdministrationStore, SessionOperationStore } from "../domain/ports/workflow.js";
import { SqliteStoreKernel } from "./sqlite-store-kernel.js";

export interface SqliteStoreLifecycle {
  activateWriteFence(ownerId: string, fencingToken: number): void;
  deactivateWriteFence(): void;
  close(): void;
}

export interface SqliteRetentionStore {
  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number;
  pruneAcceptedInboundMessages(cutoff: string, limit: number): number;
  pruneTerminalSessionOperations(cutoff: string, limit: number): number;
}

export interface SqliteStoreBundle {
  readonly lifecycle: SqliteStoreLifecycle;
  readonly lease: LeaseStore;
  readonly health: HealthStore;
  readonly instance: InstanceStore;
  readonly instanceLifecycle: InstanceLifecycleStore;
  readonly instanceTurns: InstanceTurnStore;
  readonly turnControl: TurnControlStore & Pick<InstanceStore, "getBinding" | "getActiveOrdinaryPrompt" | "getAgentInstance" | "getActiveInstanceTurn" | "acceptInstanceTurn" | "acceptInstanceTurnWithCard" | "countPendingInstanceTurns"> & Pick<PromptAcceptanceStore, "acceptPrompt" | "countPendingPrompts">;
  readonly promptAcceptance: PromptAcceptanceStore;
  readonly promptRun: PromptRunStore;
  readonly outboundIntent: OutboundIntentStore;
  readonly outbox: OutboxStore;
  readonly answerPages: AnswerPageStore;
  readonly workerTurnCards: WorkerTurnCardStore;
  readonly mainCards: MainCardStore;
  readonly projection: ProjectionStore;
  readonly queueFeedback: QueueFeedbackStore;
  readonly cardContext: CardContextProjectionStore;
  readonly bindingProvisioning: BindingProvisioningStore;
  readonly runtimeReconciliation: RuntimeReconciliationStore;
  readonly retiredPaneCleanup: RetiredPaneCleanupStore;
  readonly paneControl: PaneControlStore;
  readonly paneClose: PaneCloseStore;
  readonly inboundRouting: InboundRoutingStore;
  readonly inboundDispatch: InboundMessageDispatchStore;
  readonly operationsQuery: OperationsQueryStore;
  readonly deliveryRecovery: DeliveryRecoveryStore;
  readonly cardInteraction: CardInteractionStore;
  readonly externalTurns: ExternalTurnObservationStore;
  readonly sessionOperations: SessionOperationStore;
  readonly modelSelection: ModelSelectionStore;
  readonly sessionAdministration: SessionAdministrationStore;
  readonly paneRetention: PaneRetentionStore;
  readonly commandIntents: CommandIntentStore & Pick<DeliveryRecoveryStore, "audit" | "getBinding">;
  readonly inboundMessages: InboundRoutingStore & PromptAcceptanceStore;
  readonly startupRecovery: InboundRoutingStore & PromptAcceptanceStore;
  readonly retention: SqliteRetentionStore;
  readonly workerCardDisplay: WorkerCardDisplayStore;
}

export function createSqliteStoreBundle(path: string): SqliteStoreBundle {
  const store = new SqliteStoreKernel(path);
  const modules = store.capabilityModules();
  return {
    lifecycle: modules.lifecycle, lease: modules.lease, health: modules.health, instance: modules.instance, instanceLifecycle: modules.instance, instanceTurns: modules.instance, turnControl: store,
    promptAcceptance: modules.promptAcceptance, promptRun: modules.promptRun, outboundIntent: modules.outbox, outbox: modules.outbox,
    answerPages: modules.answerPages, workerTurnCards: modules.workerTurnCards, mainCards: modules.mainCards, projection: modules.projection,
    queueFeedback: modules.queueFeedback, cardContext: modules.cardContext, bindingProvisioning: store,
    runtimeReconciliation: store, retiredPaneCleanup: store, paneControl: store,
    paneClose: store, inboundRouting: store, inboundDispatch: modules.inboundDispatch, operationsQuery: modules.operationsQuery,
    deliveryRecovery: store, cardInteraction: store, externalTurns: store,
    sessionOperations: modules.sessionOperations, modelSelection: store, sessionAdministration: store,
    paneRetention: store, commandIntents: modules.commandIntents, inboundMessages: store,
    startupRecovery: store, retention: modules.retention, workerCardDisplay: modules.workerCardDisplay
  };
}
