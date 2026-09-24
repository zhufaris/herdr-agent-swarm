import type { BindingProvisioningStore, RetiredPaneCleanupStore, RuntimeReconciliationStore } from "../domain/ports/binding.js";
import type { CardContextProjectionStore } from "../domain/ports/card-context.js";
import type { HealthStore, LeaseStore } from "../domain/ports/health.js";
import type { InstanceLifecycleStore, InstanceStore, InstanceTurnStore } from "../domain/ports/instance.js";
import type { OutboundIntentStore, OutboxStore } from "../domain/ports/outbox.js";
import type { PaneCloseStore, PaneControlStore } from "../domain/ports/pane-operations.js";
import type { PromptAcceptanceStore, PromptDispatchStore, PromptRecoveryStore, PromptSessionStore } from "../domain/ports/prompt.js";
import type { AnswerPageStore, MainCardStore, ProjectionStore, QueueFeedbackStore } from "../domain/ports/projection.js";
import type { CommandIntentWorkflowStore } from "../domain/ports/swarm-command.js";
import type { NaturalLanguageCommandConfirmationStore } from "../domain/ports/natural-language-command-confirmation.js";
import type { ControllerInterpretationStore } from "../domain/ports/controller-interpretation.js";
import type { TurnControlWorkflowStore } from "../domain/ports/turn-control.js";
import type { WorkerCardDisplayStore } from "../domain/ports/worker-card-display.js";
import type { CardInteractionStore, DeliveryRecoveryStore, ExternalTurnObservationStore, InboundMessageDispatchStore, InboundRoutingStore, ModelSelectionStore, OperationsQueryStore, PaneRetentionStore, SessionAdministrationStore, SessionOperationStore, StartupRecoveryStore, StartupViewStore } from "../domain/ports/workflow.js";
import { SqliteCapabilityGraph } from "./sqlite/capability-graph.js";
import type { SqliteContext } from "./sqlite/context.js";
import type { SqliteLeaseStore } from "./sqlite/lease-store.js";
import type { WorkerSessionThreadApplicationStore } from "../domain/ports/worker-session-thread.js";
import type { RetentionStore } from "../domain/ports/retention.js";

export interface SqliteStoreLifecycle {
  activateWriteFence(ownerId: string, fencingToken: number): void;
  deactivateWriteFence(): void;
  close(): void;
}

export interface SqliteStoreBundle {
  readonly lifecycle: SqliteStoreLifecycle;
  readonly lease: LeaseStore;
  readonly health: HealthStore;
  readonly instance: InstanceStore;
  readonly instanceLifecycle: InstanceLifecycleStore;
  readonly instanceTurns: InstanceTurnStore;
  readonly turnControl: TurnControlWorkflowStore;
  readonly promptAcceptance: PromptAcceptanceStore;
  readonly promptDispatch: PromptDispatchStore;
  readonly promptRecovery: PromptRecoveryStore;
  readonly promptSession: PromptSessionStore;
  readonly outboundIntent: OutboundIntentStore;
  readonly outbox: OutboxStore;
  readonly answerPages: AnswerPageStore;
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
  readonly commandIntents: CommandIntentWorkflowStore;
  readonly naturalLanguageCommandConfirmations: NaturalLanguageCommandConfirmationStore;
  readonly controllerInterpretations: ControllerInterpretationStore;
  readonly startupRecovery: StartupRecoveryStore;
  readonly startupViews: StartupViewStore;
  readonly retention: RetentionStore;
  readonly workerCardDisplay: WorkerCardDisplayStore;
  readonly workerSessionThreads: WorkerSessionThreadApplicationStore;
}

export function createSqliteStoreBundle(path: string): SqliteStoreBundle {
  return createSqliteStoreBundleFromGraph(new SqliteCapabilityGraph(path));
}

export function createSqliteStoreBundleFromContext(context: SqliteContext, lease: SqliteLeaseStore): SqliteStoreBundle {
  return createSqliteStoreBundleFromGraph(new SqliteCapabilityGraph(context, lease));
}

function createSqliteStoreBundleFromGraph(graph: SqliteCapabilityGraph): SqliteStoreBundle {
  const modules = graph.capabilityModules();
  return {
    lifecycle: modules.lifecycle, lease: modules.lease, health: modules.health, instance: modules.instance, instanceLifecycle: modules.instance, instanceTurns: modules.instance, turnControl: modules.turnControl,
    promptAcceptance: modules.promptAcceptance, promptDispatch: modules.promptDispatch, promptRecovery: modules.promptRecovery, promptSession: modules.promptSession, outboundIntent: modules.outbox, outbox: modules.outbox,
    answerPages: modules.answerPages, mainCards: modules.mainCards, projection: modules.projection,
    queueFeedback: modules.queueFeedback, cardContext: modules.cardContext, bindingProvisioning: modules.bindingProvisioning,
    runtimeReconciliation: modules.runtimeReconciliation, retiredPaneCleanup: modules.retiredPaneCleanup, paneControl: modules.paneControl,
    paneClose: modules.paneClose, inboundRouting: modules.inboundRouting, inboundDispatch: modules.inboundDispatch, operationsQuery: modules.operationsQuery,
    deliveryRecovery: modules.deliveryRecovery, cardInteraction: modules.cardInteraction, externalTurns: modules.externalTurns,
    sessionOperations: modules.sessionOperations, modelSelection: modules.modelSelection, sessionAdministration: modules.sessionAdministration,
    paneRetention: modules.paneRetention, commandIntents: modules.commandIntents, naturalLanguageCommandConfirmations: modules.naturalLanguageCommandConfirmations, controllerInterpretations: modules.controllerInterpretations,
    startupRecovery: modules.startupRecovery, startupViews: modules.startupViews, retention: modules.retention, workerCardDisplay: modules.workerCardDisplay, workerSessionThreads: modules.workerSessionThreads
  };
}
