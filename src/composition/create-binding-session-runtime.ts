import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { BindingProvisioningWorkflow } from "../coordinator/binding-provisioning-workflow.js";
import { DeliveryRecoveryWorkflow } from "../coordinator/delivery-recovery-workflow.js";
import { HerdrRuntimeReconciler } from "../coordinator/herdr-runtime-reconciler.js";
import { OperationsQueryWorkflow } from "../coordinator/operations-query-workflow.js";
import { PaneClosureWorkflow } from "../coordinator/pane-closure-workflow.js";
import { PaneRetentionWorkflow } from "../coordinator/pane-retention-workflow.js";
import { RetiredPaneCleanupWorkflow } from "../coordinator/retired-pane-cleanup-workflow.js";
import { SessionAdministrationWorkflow } from "../coordinator/session-administration-workflow.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { HerdrEventRouter } from "../runtime/herdr-event-router.js";
import type { createInfrastructureRuntime } from "./create-infrastructure-runtime.js";
import type { createOutboundRuntime } from "./create-outbound-runtime.js";
import type { createPrimaryRuntime } from "./create-primary-runtime.js";
import type { createWorkerRuntime } from "./create-worker-runtime.js";
import type { ApplicationPresentation, PanePresentation } from "../domain/ports/presentation.js";
import type { BindingProvisioningStore, RetiredPaneCleanupStore, RuntimeReconciliationStore } from "../domain/ports/binding.js";
import type { PaneCloseStore } from "../domain/ports/pane-operations.js";
import type { DeliveryRecoveryStore, OperationsQueryStore, PaneRetentionStore, SessionAdministrationStore } from "../domain/ports/workflow.js";
import type { OrchestratorClearStore } from "../domain/ports/orchestrator-clear.js";
import { OrchestratorClearWorkflow } from "../coordinator/orchestrator-clear-workflow.js";
import { OrchestratorIdentityMigrationWorkflow } from "../coordinator/orchestrator-identity-migration-workflow.js";
import type { OrchestratorIdentityMigrationStore } from "../domain/ports/orchestrator-identity.js";
import { primaryToolAgentArgs } from "../coordinator/binding-provisioning/managed-binding-lifecycle.js";
import { primaryManagedAgentName } from "../domain/managed-agent-name.js";

export interface BindingSessionStores {
  retiredPaneCleanup: RetiredPaneCleanupStore; bindingProvisioning: BindingProvisioningStore; operationsQuery: OperationsQueryStore;
  sessionAdministration: SessionAdministrationStore; deliveryRecovery: DeliveryRecoveryStore; paneClose: PaneCloseStore;
  paneRetention: PaneRetentionStore; runtimeReconciliation: RuntimeReconciliationStore;
  orchestratorClear: OrchestratorClearStore;
  orchestratorIdentity: OrchestratorIdentityMigrationStore;
}

export function createBindingSessionRuntime(options: {
  config: BridgeConfig; stores: BindingSessionStores; logger: Logger; bus: LifecycleEventPublisher; scheduler: PromptWorkScheduler;
  infrastructure: ReturnType<typeof createInfrastructureRuntime>; delivery: ReturnType<typeof createOutboundRuntime>;
  primary: ReturnType<typeof createPrimaryRuntime>; worker: ReturnType<typeof createWorkerRuntime>;
  presentation: { application: ApplicationPresentation; pane: PanePresentation };
}) {
  const { config, stores, logger, bus, scheduler, infrastructure, delivery, primary, worker, presentation } = options;
  const { herdr, gatewayEffects, worktreeNameResolver, agentDrivers } = infrastructure;
  const { outbound, outboundWork, answerPages } = delivery;
  const { primaryState, externalTurns, coreSessionIngestion } = primary;
  const { instanceRuntime, instanceTurns } = worker;
  const retiredPaneCleanup = new RetiredPaneCleanupWorkflow({ store: stores.retiredPaneCleanup, herdr, logger });
  const provisioning = new BindingProvisioningWorkflow({ config, store: stores.bindingProvisioning, herdr, agentDrivers, gatewayEffects, lifecycleEvents: bus, outbound, outboundWork, scheduler, primaryTools: worker.primaryToolGateway, wakeRetiredPaneCleanup: () => void retiredPaneCleanup.requestScan(), presentation: presentation.application, logger });
  const orchestratorClear = new OrchestratorClearWorkflow({
    store: stores.orchestratorClear, herdr, logger, presentation: presentation.application, wakeOutbound: () => outboundWork.wake(),
    launchFor: (binding) => ({
      name: primaryManagedAgentName(binding.projectId, binding.id, binding.generation), kind: "traex",
      args: ["--permission-mode", config.traex.permissionMode, ...primaryToolAgentArgs(worker.primaryToolGateway.configurationForBinding(binding.id, binding.generation))],
      timeoutMs: config.commandTimeoutMs
    })
  });
  const orchestratorIdentity = new OrchestratorIdentityMigrationWorkflow({ config, store: stores.orchestratorIdentity, herdr, logger });
  const operationsQuery = new OperationsQueryWorkflow({ config, store: stores.operationsQuery, herdr, outbound, presentation: presentation.application, logger });
  const sessionAdministration = new SessionAdministrationWorkflow({ config, store: stores.sessionAdministration, herdr, lifecycleEvents: bus, outbound, outboundWork, isBindingBusy: (bindingId) => primaryState.isBindingBusy(bindingId), presentation: presentation.application });
  const deliveryRecovery = new DeliveryRecoveryWorkflow({ store: stores.deliveryRecovery, gatewayEffects, outbound, outboundWork, presentation: presentation.application, logger });
  const paneClosure = new PaneClosureWorkflow({ config, store: stores.paneClose, herdr, lifecycleEvents: bus, outbound, presentation: presentation.pane, isBindingBusy: (bindingId) => primaryState.isBindingBusy(bindingId), confirmationTtlMs: config.runtimeTuning.paneClosure.confirmationTtlMs });
  const paneRetention = new PaneRetentionWorkflow({ projects: config.projects, store: stores.paneRetention, herdr, outbound, presentation: presentation.pane, isBindingBusy: (bindingId) => primaryState.isBindingBusy(bindingId), logger });
  const reconciler = new HerdrRuntimeReconciler({ projects: config.projects, store: stores.runtimeReconciliation, herdr, runtimeObservations: herdr, lifecycleEvents: bus, channelPublisher: outbound, logger, wakeOutbound: () => outboundWork.wake(), convergeAnswer: (promptId) => answerPages.converge(promptId), discoverPane: (pane, project) => provisioning.discover(pane, project), scheduler, isBindingBusy: (bindingId) => primaryState.isBindingBusy(bindingId), externalTurnObserver: externalTurns, worktreeNameFor: (cwd) => worktreeNameResolver.resolve(cwd), branchFor: (cwd) => worktreeNameResolver.resolveBranch(cwd), presentation: presentation.application });
  const herdrEventRouter = new HerdrEventRouter({ invalidateAll: () => herdr.invalidateAll(), invalidateWorkspace: (workspaceId) => herdr.invalidate(workspaceId), invalidatePanes: (paneIds) => herdr.invalidatePanes(paneIds), reconcileBindings: async (scope) => { if (scope?.paneIds) await reconciler.requestPaneReconciliation(scope.paneIds); else await reconciler.requestReconciliation(scope?.workspaceIds); }, reconcileInstances: (scope) => instanceRuntime.requestReconciliation(scope), observePrimaryTurns: async (paneIds) => { await coreSessionIngestion?.reconcile(); return paneIds ? externalTurns.observeByPane(paneIds) : externalTurns.scanActiveBindings(); }, observeInstanceTurns: (paneIds) => paneIds ? instanceTurns.requestObservationByPane(paneIds) : instanceTurns.reconcile(), retryRetiredPanes: (paneIds) => paneIds ? retiredPaneCleanup.requestPanes(paneIds) : retiredPaneCleanup.requestScan(), notifyCoreSources: async (sources) => { await coreSessionIngestion?.notifySources(sources); }, logger });
  return { retiredPaneCleanup, provisioning, orchestratorClear, orchestratorIdentity, operationsQuery, sessionAdministration, deliveryRecovery, paneClosure, paneRetention, reconciler, herdrEventRouter };
}
