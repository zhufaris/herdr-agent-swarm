import type { BindingProvisioningStore, RetiredPaneCleanupStore, RuntimeReconciliationStore } from "../domain/ports/binding.js";
import type { CardContextProjectionStore } from "../domain/ports/card-context.js";
import type { HealthStore, LeaseStore } from "../domain/ports/health.js";
import type { InstanceLifecycleStore, InstanceStore, InstanceTurnStore } from "../domain/ports/instance.js";
import type { OutboundIntentStore, OutboxStore, PreparedDeliveryProducerConnector } from "../domain/ports/outbox.js";
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
import { SqliteContext, type SqliteContextOptions } from "./sqlite/context.js";
import type { SqliteLeaseStore } from "./sqlite/lease-store.js";
import type { WorkerSessionThreadApplicationStore } from "../domain/ports/worker-session-thread.js";
import type { RetentionStore } from "../domain/ports/retention.js";
import type { AuthoritativeTurnSnapshotStore, CoreEventInboxStore } from "../domain/core-event-inbox.js";
import type { OrchestratorClearStore } from "../domain/ports/orchestrator-clear.js";
import type { OrchestratorIdentityMigrationStore } from "../domain/ports/orchestrator-identity.js";
import type { PrimaryCardRedeliveryStore } from "../domain/ports/primary-card-redelivery.js";
import type { AgentInputStore } from "../domain/ports/agent-input.js";
import type { ConversationSegmentStore } from "../domain/ports/conversation-segment.js";
import type { LegacyInputCardRetirementStore } from "../domain/ports/legacy-input-card-retirement.js";
import type { CardDismissalStore } from "../domain/ports/card-dismissal.js";
import type { PreparedDeliveryStore } from "../domain/ports/prepared-delivery.js";
import type { DeliveryEngineRefillPort } from "../domain/delivery-engine.js";
import type { SqliteRuntimeDiagnostics } from "./sqlite/context.js";
import type { StaleDeliveryClaimBatchResult, StaleDeliveryClaimCursor } from "./sqlite/lease-store.js";
import type { ExclusiveMigrationLeaseAuthorization } from "./sqlite/exclusive-migration-lock.js";
import type { SessionActivityStore } from "../domain/ports/session-activity.js";
import type { DeliveryLatencyTrace } from "../domain/delivery-trace.js";
import type { PaneTopologyIntentStore } from "../domain/ports/pane-topology.js";
export type { StaleDeliveryClaimBatchResult, StaleDeliveryClaimCursor } from "./sqlite/lease-store.js";

export { classifySqliteFailure } from "./sqlite/context.js";

export interface SqliteStoreLifecycle {
  activateWriteFence(ownerId: string, fencingToken: number): void;
  recoverPriorOwnerClaimsBatch(ownerId: string, fencingToken: number, after: StaleDeliveryClaimCursor | null, limit?: number, occurredAt?: string): StaleDeliveryClaimBatchResult;
  deactivateWriteFence(): void;
  runtimeDiagnostics(): SqliteRuntimeDiagnostics;
  close(): void;
}

export interface SqliteStoreBundle {
  readonly deliveryTrace?: DeliveryLatencyTrace;
  readonly lifecycle: SqliteStoreLifecycle;
  readonly lease: LeaseStore;
  readonly health: HealthStore;
  readonly rolloutGuard: { assertSemanticDeliveryStartupSafe(): void };
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
  readonly primaryCardRedelivery: PrimaryCardRedeliveryStore;
  readonly mainCards: MainCardStore;
  readonly projection: ProjectionStore;
  readonly queueFeedback: QueueFeedbackStore;
  readonly cardContext: CardContextProjectionStore;
  readonly bindingProvisioning: BindingProvisioningStore;
  readonly runtimeReconciliation: RuntimeReconciliationStore;
  readonly retiredPaneCleanup: RetiredPaneCleanupStore;
  readonly paneControl: PaneControlStore;
  readonly paneTopology: PaneTopologyIntentStore;
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
  readonly agentInputs: AgentInputStore;
  readonly naturalLanguageCommandConfirmations: NaturalLanguageCommandConfirmationStore;
  readonly controllerInterpretations: ControllerInterpretationStore;
  readonly startupRecovery: StartupRecoveryStore;
  readonly startupViews: StartupViewStore;
  readonly retention: RetentionStore;
  readonly workerCardDisplay: WorkerCardDisplayStore;
  readonly workerSessionThreads: WorkerSessionThreadApplicationStore;
  readonly orchestratorClear: OrchestratorClearStore;
  readonly orchestratorIdentity: OrchestratorIdentityMigrationStore;
  readonly shortcutPanel: { reserve(chatId: string, card: object): "reserved" | "current" | "pending" };
  readonly coreEvents: CoreEventInboxStore;
  readonly turnSnapshots: AuthoritativeTurnSnapshotStore;
  readonly conversationSegments: ConversationSegmentStore;
  readonly sessionActivity: SessionActivityStore;
  readonly legacyInputCards: LegacyInputCardRetirementStore;
  readonly cardDismissals: CardDismissalStore;
  readonly preparedDeliveries: PreparedDeliveryStore & DeliveryEngineRefillPort;
  readonly preparedDeliveryProducers: PreparedDeliveryProducerConnector;
}

export function createSqliteStoreBundle(path: string, options: SqliteContextOptions): SqliteStoreBundle {
  return createSqliteStoreBundleFromGraph(new SqliteCapabilityGraph(new SqliteContext(path, options)));
}

export function createSqliteStoreBundleFromContext(context: SqliteContext, lease: SqliteLeaseStore, migrationLeaseAuthorization?: ExclusiveMigrationLeaseAuthorization): SqliteStoreBundle {
  return createSqliteStoreBundleFromGraph(new SqliteCapabilityGraph(context, lease, migrationLeaseAuthorization));
}

function createSqliteStoreBundleFromGraph(graph: SqliteCapabilityGraph): SqliteStoreBundle {
  const modules = graph.capabilityModules();
  return {
    deliveryTrace: modules.deliveryTrace, lifecycle: modules.lifecycle, lease: modules.lease, health: modules.health, rolloutGuard: modules.integrity, coreEvents: modules.coreEvents, turnSnapshots: modules.turnSnapshots, conversationSegments: modules.conversationSegments, sessionActivity: modules.sessionActivity, instance: modules.instance, instanceLifecycle: modules.instance, instanceTurns: modules.instance, turnControl: modules.turnControl,
    promptAcceptance: modules.promptAcceptance, promptDispatch: modules.promptDispatch, promptRecovery: modules.promptRecovery, promptSession: modules.promptSession, outboundIntent: modules.outbox, outbox: modules.outbox,
    answerPages: modules.answerPages, primaryCardRedelivery: modules.primaryCardRedelivery, mainCards: modules.mainCards, projection: modules.projection,
    queueFeedback: modules.queueFeedback, cardContext: modules.cardContext, bindingProvisioning: modules.bindingProvisioning,
    runtimeReconciliation: modules.runtimeReconciliation, retiredPaneCleanup: modules.retiredPaneCleanup, paneControl: modules.paneControl, paneTopology: modules.paneTopology,
    paneClose: modules.paneClose, inboundRouting: modules.inboundRouting, inboundDispatch: modules.inboundDispatch, operationsQuery: modules.operationsQuery,
    deliveryRecovery: modules.deliveryRecovery, cardInteraction: modules.cardInteraction, externalTurns: modules.externalTurns,
    sessionOperations: modules.sessionOperations, modelSelection: modules.modelSelection, sessionAdministration: modules.sessionAdministration,
    paneRetention: modules.paneRetention, commandIntents: modules.commandIntents, agentInputs: modules.agentInputs, naturalLanguageCommandConfirmations: modules.naturalLanguageCommandConfirmations, controllerInterpretations: modules.controllerInterpretations, orchestratorClear: modules.orchestratorClear, orchestratorIdentity: modules.orchestratorIdentity,
    startupRecovery: modules.startupRecovery, startupViews: modules.startupViews, retention: modules.retention, workerCardDisplay: modules.workerCardDisplay, workerSessionThreads: modules.workerSessionThreads,
    shortcutPanel: { reserve: (chatId, card) => graph.outbox.reserveShortcutPanel(chatId, card) },
    legacyInputCards: modules.legacyInputCards, cardDismissals: modules.cardDismissals, preparedDeliveries: modules.preparedDeliveries, preparedDeliveryProducers: modules.preparedDeliveryProducers
  };
}
