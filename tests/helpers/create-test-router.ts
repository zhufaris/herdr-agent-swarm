import type { Logger } from "pino";
import type { BridgeConfig } from "../../src/config.js";
import { BindingProvisioningWorkflow } from "../../src/coordinator/binding-provisioning-workflow.js";
import { CardInteractionWorkflow } from "../../src/coordinator/card-interaction-workflow.js";
import { HerdrRuntimeReconciler } from "../../src/coordinator/herdr-runtime-reconciler.js";
import { InboundRouter } from "../../src/coordinator/inbound-router.js";
import { ModelSelectionWorkflow } from "../../src/coordinator/model-selection-workflow.js";
import { PaneControlWorkflow } from "../../src/coordinator/pane-control-workflow.js";
import { OperationsQueryWorkflow } from "../../src/coordinator/operations-query-workflow.js";
import { SessionAdministrationWorkflow } from "../../src/coordinator/session-administration-workflow.js";
import { DeliveryRecoveryWorkflow } from "../../src/coordinator/delivery-recovery-workflow.js";
import { PaneClosureWorkflow } from "../../src/coordinator/pane-closure-workflow.js";
import { PromptRunWorkflow } from "../../src/coordinator/prompt-run-workflow.js";
import { RetiredPaneCleanupWorkflow } from "../../src/coordinator/retired-pane-cleanup-workflow.js";
import { StartupViewConverger } from "../../src/coordinator/startup-view-converger.js";
import type { HerdrPort, LarkPort, TraexTranscriptReaderPort } from "../../src/domain/ports.js";
import type { BridgeEventBus } from "../../src/events/bridge-event-bus.js";
import { InProcessInboundWorkNotifier, type InboundWorkNotifier } from "../../src/events/inbound-work-notifier.js";
import type { LarkOutboxDispatcher } from "../../src/events/lark-outbox-dispatcher.js";
import { OutboundIntentWriter } from "../../src/events/outbound-intent-writer.js";
import { InProcessOutboundWorkNotifier } from "../../src/events/outbound-work-notifier.js";
import { InProcessPromptWorkScheduler, type PromptWorkScheduler } from "../../src/events/prompt-work-scheduler.js";
import type { SqliteBindingStore } from "../../src/store/sqlite-store.js";

export function createTestRouter(
  config: BridgeConfig,
  store: SqliteBindingStore,
  herdr: HerdrPort,
  lark: LarkPort,
  bus: BridgeEventBus,
  outbound: LarkOutboxDispatcher,
  logger: Logger,
  shutdownGraceMs = 30_000,
  scheduler: PromptWorkScheduler = new InProcessPromptWorkScheduler(logger),
  inboundWork: InboundWorkNotifier = new InProcessInboundWorkNotifier(),
  transcriptReader?: TraexTranscriptReaderPort
): InboundRouter {
  const outboundWork = new InProcessOutboundWorkNotifier(logger);
  outboundWork.subscribe(() => outbound.requestScan());
  const writer = new OutboundIntentWriter(store, outboundWork);
  outbound.connectPromptScheduler(scheduler);
  const promptRun = new PromptRunWorkflow({ store, herdr, bus, scheduler, outboundWork, logger, turnTimeoutMs: config.turnTimeoutMs, shutdownGraceMs, transcriptReader });
  const retiredPaneCleanup = new RetiredPaneCleanupWorkflow({ store, herdr, logger });
  const provisioning = new BindingProvisioningWorkflow({ config, store, herdr, lark, lifecycleEvents: bus, outbound: writer, outboundWork, scheduler, wakeRetiredPaneCleanup: () => void retiredPaneCleanup.requestScan(), logger });
  const modelSelection = new ModelSelectionWorkflow({ config, store, herdr, outbound: writer, outboundWork, scheduler, activeTurn: (bindingId) => promptRun.activeTurn(bindingId), logger });
  const paneControl = new PaneControlWorkflow({ store, herdr, outbound: writer, scheduler, model: modelSelection, activeTurn: (bindingId) => promptRun.activeTurn(bindingId) });
  const operationsQuery = new OperationsQueryWorkflow({ config, store, herdr, outbound: writer, logger });
  const sessionAdministration = new SessionAdministrationWorkflow({ config, store, herdr, lifecycleEvents: bus, outbound: writer, outboundWork, scheduler, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId) });
  const deliveryRecovery = new DeliveryRecoveryWorkflow({ store, lark, outbound: writer, outboundWork, logger });
  const paneClosure = new PaneClosureWorkflow({ config, store, herdr, lifecycleEvents: bus, outbound: writer, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId) });
  const cardInteractions = new CardInteractionWorkflow({ store, paneControl, sessionAdministration, provisioning, paneClosure, modelSelection, activeTurn: (bindingId) => promptRun.activeTurn(bindingId), isSteerable: async (turn) => {
    const observation = await herdr.observeRuntime(turn.paneId);
    return observation.pane?.agentState === "working" || observation.pane?.agentState === "blocked";
  }, wakeSteering: (bindingId, parentPromptId) => scheduler.wake({ kind: "steering-ready", bindingId, parentPromptId }) });
  const reconciler = new HerdrRuntimeReconciler({
    projects: config.projects, store, herdr, lifecycleEvents: bus, channelPublisher: writer, logger,
    discoverPane: (pane, project) => provisioning.discover(pane, project), scheduler,
    isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId)
  });
  return new InboundRouter({
    config, store, herdr, lark, lifecycleEvents: bus, outbound: writer, outboundWork, logger, scheduler, inboundWork,
    promptRun, automaticSteeringTarget: (bindingId) => {
      const turn = promptRun.activeTurn(bindingId);
      return turn && (turn.state === "working" || turn.state === "blocked") ? { promptId: turn.promptId, paneId: turn.paneId, state: turn.state } : null;
    }, provisioning, cardInteractions, modelSelection, paneControl, operationsQuery, sessionAdministration, deliveryRecovery, paneClosure, reconciler, retiredPaneCleanup, startupViews: new StartupViewConverger(config, store, writer, outboundWork, undefined, undefined, logger)
  });
}
