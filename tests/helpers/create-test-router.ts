import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BridgeConfig } from "../../src/config.js";
import { BindingProvisioningWorkflow } from "../../src/coordinator/binding-provisioning-workflow.js";
import { CardInteractionWorkflow } from "../../src/coordinator/card-interaction-workflow.js";
import { HerdrRuntimeReconciler } from "../../src/coordinator/herdr-runtime-reconciler.js";
import { InboundRouter } from "../../src/coordinator/inbound-router.js";
import { InboundMessageDispatcher } from "../../src/coordinator/inbound-message-dispatcher.js";
import { CardActionRouter } from "../../src/coordinator/card-action-router.js";
import { InboundMessageRoutingWorkflow } from "../../src/coordinator/inbound-message-routing-workflow.js";
import { ModelSelectionWorkflow } from "../../src/coordinator/model-selection-workflow.js";
import { PaneControlWorkflow } from "../../src/coordinator/pane-control-workflow.js";
import { OperationsQueryWorkflow } from "../../src/coordinator/operations-query-workflow.js";
import { SessionAdministrationWorkflow } from "../../src/coordinator/session-administration-workflow.js";
import { SessionOperationWorkflow } from "../../src/coordinator/session-operation-workflow.js";
import { DeliveryRecoveryWorkflow } from "../../src/coordinator/delivery-recovery-workflow.js";
import { ExternalTurnObserver } from "../../src/coordinator/external-turn-observer.js";
import { PaneClosureWorkflow } from "../../src/coordinator/pane-closure-workflow.js";
import { PromptRunWorkflow } from "../../src/coordinator/prompt-run-workflow.js";
import { RetiredPaneCleanupWorkflow } from "../../src/coordinator/retired-pane-cleanup-workflow.js";
import { StartupViewConverger } from "../../src/coordinator/startup-view-converger.js";
import { StartupRecoveryWorkflow } from "../../src/coordinator/startup-recovery-workflow.js";
import { TurnControlWorkflow } from "../../src/coordinator/turn-control-workflow.js";
import { SwarmCommandContextResolver } from "../../src/coordinator/swarm-command-context-resolver.js";
import { SwarmCommandGateway } from "../../src/coordinator/swarm-command-gateway.js";
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
  transcriptReader?: TraexTranscriptReaderPort,
  observeExternalTurns = false
): InboundRouter {
  const outboundWork = new InProcessOutboundWorkNotifier(logger);
  outboundWork.subscribe(() => outbound.requestScan());
  const writer = new OutboundIntentWriter(store, outboundWork);
  outbound.connectPromptScheduler(scheduler);
  let promptRun!: PromptRunWorkflow;
  const externalTurns = transcriptReader && observeExternalTurns ? new ExternalTurnObserver({
    store, transcriptReader, bus, outboundWork, logger,
    isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId),
    wakePrompt: (bindingId) => scheduler.wake({ kind: "prompt-ready", bindingId })
  }) : undefined;
  promptRun = new PromptRunWorkflow({
    store, herdr, bus, scheduler, outboundWork, logger, turnTimeoutMs: config.turnTimeoutMs, shutdownGraceMs, transcriptReader,
    handoffExternalTurns: externalTurns ? (bindingId) => externalTurns.handoff(bindingId) : undefined,
    observeSupersedingExternalTurn: externalTurns ? (binding, prompt, observation) => externalTurns.observeSupersedingTurn(binding, prompt, observation) : undefined,
    recoverExternalTurns: externalTurns ? (binding, prompt) => externalTurns.recoverAfterDetachedTurn(binding, prompt) : undefined
  });
  const retiredPaneCleanup = new RetiredPaneCleanupWorkflow({ store, herdr, logger });
  const primaryTools = {
    issueBinding: (bindingId: string, generation: number) => {
      const capability = `test-${bindingId}-${generation}`;
      store.setBindingPrimaryToolCapability({ bindingId, expectedGeneration: generation, capabilityHash: createHash("sha256").update(capability).digest("hex") });
      return { environment: { SWARM_PRIMARY_CAPABILITY: capability }, command: "node", args: ["primary-tools", "--binding", bindingId, "--generation", String(generation)] };
    },
    configurationForBinding: (bindingId: string, generation: number) => ({ environment: {}, command: "node", args: ["primary-tools", "--binding", bindingId, "--generation", String(generation)] })
  };
  const provisioning = new BindingProvisioningWorkflow({ config, store, herdr, lark, lifecycleEvents: bus, outbound: writer, outboundWork, immediateOutbound: outbound, scheduler, primaryTools, wakeRetiredPaneCleanup: () => void retiredPaneCleanup.requestScan(), logger });
  const modelSelection = new ModelSelectionWorkflow({ config, store, herdr, outbound: writer, outboundWork, scheduler, activeTurn: (bindingId) => promptRun.activeTurn(bindingId), logger });
  const turnControl = new TurnControlWorkflow({ store, herdr, idFactory: randomUUID });
  const paneControl = new PaneControlWorkflow({ store, herdr, outbound: writer, scheduler, model: modelSelection, turnControl, activeTurn: (bindingId) => promptRun.activeTurn(bindingId) });
  const operationsQuery = new OperationsQueryWorkflow({ config, store, herdr, outbound: writer, logger });
  const sessionAdministration = new SessionAdministrationWorkflow({ config, store, herdr, lifecycleEvents: bus, outbound: writer, outboundWork, scheduler, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId) });
  const deliveryRecovery = new DeliveryRecoveryWorkflow({ store, lark, outbound: writer, outboundWork, logger });
  const paneClosure = new PaneClosureWorkflow({ config, store, herdr, lifecycleEvents: bus, outbound: writer, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId) });
  const sessionOperations = new SessionOperationWorkflow({ store, sessionAdministration, provisioning, paneControl, paneClosure, logger });
  const cardInteractions = new CardInteractionWorkflow({ store, adminOpenIds: config.lark.adminOpenIds, sessionAdministration, sessionOperations, wakePrompt: (bindingId) => scheduler.wake({ kind: "prompt-ready", bindingId }), logger });
  const reconciler = new HerdrRuntimeReconciler({
    projects: config.projects, store, herdr, lifecycleEvents: bus, channelPublisher: writer, logger,
    discoverPane: (pane, project) => provisioning.discover(pane, project), scheduler,
    isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId), externalTurnObserver: externalTurns
  });
  const inboundDispatcher = new InboundMessageDispatcher({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, store, inboundWork, logger });
  const commandResolver = new SwarmCommandContextResolver({ config, store, activeTurn: (bindingId) => promptRun.activeTurn(bindingId) });
  const swarmCommands = new SwarmCommandGateway({ store, resolver: commandResolver, outbound: writer, logger, provisioning, modelSelection, paneControl, operationsQuery, sessionAdministration, paneClosure, promptRun, instanceControl: { createWorker: async () => { throw new Error("Worker creation is not configured in this test fixture"); }, inspect: () => { throw new Error("Worker inspection is not configured in this test fixture"); } } });
  const messageRouting = new InboundMessageRoutingWorkflow({ config, store, lifecycleEvents: bus, outbound: writer, outboundWork, logger, scheduler, promptRun, provisioning, swarmCommands });
  const cardActionRouter = new CardActionRouter({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, adminOpenIds: config.lark.adminOpenIds, projects: config.projects, store, provisioning, cardInteractions, modelSelection, deliveryRecovery, logger, enqueueInitialPrompt: (binding, selection) => messageRouting.enqueueInitialProjectPrompt(binding, selection) });
  const startupViews = new StartupViewConverger(config, store, writer, outboundWork, undefined, undefined, logger);
  const startupRecovery = new StartupRecoveryWorkflow({ config, store, herdr, lark, logger, scheduler, inboundWork, inboundDispatcher, cardActionRouter, messageRouting, promptRun, provisioning, paneControl, paneClosure, sessionOperations, swarmCommands, reconciler, retiredPaneCleanup, startupViews });
  const router = new InboundRouter({ lark, modelSelection, promptRun, reconciler, retiredPaneCleanup, sessionOperations, swarmCommands, inboundDispatcher, cardActionRouter, startupRecovery });
  return router;
}
