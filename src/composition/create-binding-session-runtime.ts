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
import type { SqliteStoreBundle } from "../store/sqlite-store-bundle.js";
import type { createInfrastructureRuntime } from "./create-infrastructure-runtime.js";
import type { createOutboundRuntime } from "./create-outbound-runtime.js";
import type { createPrimaryRuntime } from "./create-primary-runtime.js";
import type { createWorkerRuntime } from "./create-worker-runtime.js";
import type { ApplicationPresentation, PanePresentation } from "../domain/ports/presentation.js";

export type BindingSessionStores = Pick<SqliteStoreBundle, "retiredPaneCleanup" | "bindingProvisioning" | "operationsQuery" | "sessionAdministration" | "deliveryRecovery" | "paneClose" | "paneRetention" | "runtimeReconciliation">;

export function createBindingSessionRuntime(options: {
  config: BridgeConfig; stores: BindingSessionStores; logger: Logger; bus: LifecycleEventPublisher; scheduler: PromptWorkScheduler;
  infrastructure: ReturnType<typeof createInfrastructureRuntime>; delivery: ReturnType<typeof createOutboundRuntime>;
  primary: ReturnType<typeof createPrimaryRuntime>; worker: ReturnType<typeof createWorkerRuntime>;
  presentation: { application: ApplicationPresentation; pane: PanePresentation };
}) {
  const { config, stores, logger, bus, scheduler, infrastructure, delivery, primary, worker, presentation } = options;
  const { herdr, gatewayEffects, worktreeNameResolver, agentDrivers } = infrastructure;
  const { outbound, outboundWork, channelPublisher, answerPages } = delivery;
  const { promptRun, externalTurns } = primary;
  const { instanceRuntime, instanceTurns } = worker;
  const retiredPaneCleanup = new RetiredPaneCleanupWorkflow({ store: stores.retiredPaneCleanup, herdr, logger });
  const provisioning = new BindingProvisioningWorkflow({ config, store: stores.bindingProvisioning, herdr, agentDrivers, gatewayEffects, lifecycleEvents: bus, outbound, outboundWork, immediateOutbound: channelPublisher, scheduler, primaryTools: worker.primaryToolGateway, wakeRetiredPaneCleanup: () => void retiredPaneCleanup.requestScan(), presentation: presentation.application, logger });
  const operationsQuery = new OperationsQueryWorkflow({ config, store: stores.operationsQuery, herdr, outbound, presentation: presentation.application, logger });
  const sessionAdministration = new SessionAdministrationWorkflow({ config, store: stores.sessionAdministration, herdr, lifecycleEvents: bus, outbound, outboundWork, scheduler, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId), presentation: presentation.application });
  const deliveryRecovery = new DeliveryRecoveryWorkflow({ store: stores.deliveryRecovery, gatewayEffects, outbound, outboundWork, presentation: presentation.application, logger });
  const paneClosure = new PaneClosureWorkflow({ config, store: stores.paneClose, herdr, lifecycleEvents: bus, outbound, presentation: presentation.pane, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId), confirmationTtlMs: config.runtimeTuning.paneClosure.confirmationTtlMs });
  const paneRetention = new PaneRetentionWorkflow({ projects: config.projects, store: stores.paneRetention, herdr, outbound, presentation: presentation.pane, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId), logger });
  const reconciler = new HerdrRuntimeReconciler({ projects: config.projects, store: stores.runtimeReconciliation, herdr, lifecycleEvents: bus, channelPublisher: outbound, logger, wakeOutbound: () => outboundWork.wake(), convergeAnswer: (promptId) => answerPages.converge(promptId), discoverPane: (pane, project) => provisioning.discover(pane, project), scheduler, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId), externalTurnObserver: externalTurns, worktreeNameFor: (cwd) => worktreeNameResolver.resolve(cwd), presentation: presentation.application });
  const herdrEventRouter = new HerdrEventRouter({ invalidateAll: () => herdr.invalidateAll(), invalidateWorkspace: (workspaceId) => herdr.invalidate(workspaceId), invalidatePanes: (paneIds) => herdr.invalidatePanes(paneIds), reconcileBindings: async (scope) => { if (scope?.paneIds) await reconciler.requestPaneReconciliation(scope.paneIds); else await reconciler.requestReconciliation(scope?.workspaceIds); }, reconcileInstances: (scope) => instanceRuntime.requestReconciliation(scope), observePrimaryTurns: (paneIds) => paneIds ? externalTurns.observeByPane(paneIds) : externalTurns.scanActiveBindings(), observeInstanceTurns: (paneIds) => paneIds ? instanceTurns.requestObservationByPane(paneIds) : instanceTurns.reconcile(), retryRetiredPanes: (paneIds) => paneIds ? retiredPaneCleanup.requestPanes(paneIds) : retiredPaneCleanup.requestScan(), logger });
  return { retiredPaneCleanup, provisioning, operationsQuery, sessionAdministration, deliveryRecovery, paneClosure, paneRetention, reconciler, herdrEventRouter };
}
