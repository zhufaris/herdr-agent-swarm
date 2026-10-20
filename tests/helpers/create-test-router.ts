import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Logger } from "pino";
import type { BridgeConfig } from "../../src/config.js";
import { BindingProvisioningWorkflow } from "../../src/coordinator/binding-provisioning-workflow.js";
import { CardInteractionWorkflow } from "../../src/coordinator/card-interaction-workflow.js";
import { HerdrRuntimeReconciler } from "../../src/coordinator/herdr-runtime-reconciler.js";
import { InboundRouter } from "../../src/coordinator/inbound-router.js";
import { DurableInboundPipeline } from "../../src/coordinator/durable-inbound-pipeline.js";
import { CardActionRouter } from "../../src/coordinator/card-action-router.js";
import { InboundMessageRoutingWorkflow } from "../../src/coordinator/inbound-message-routing-workflow.js";
import { BindingPromptWorkflow } from "../../src/coordinator/binding-prompt-workflow.js";
import { ModelSelectionWorkflow } from "../../src/coordinator/model-selection-workflow.js";
import { PaneControlWorkflow } from "../../src/coordinator/pane-control-workflow.js";
import { OperationsQueryWorkflow } from "../../src/coordinator/operations-query-workflow.js";
import { SessionAdministrationWorkflow } from "../../src/coordinator/session-administration-workflow.js";
import { SessionOperationWorkflow } from "../../src/coordinator/session-operation-workflow.js";
import { DeliveryRecoveryWorkflow } from "../../src/coordinator/delivery-recovery-workflow.js";
import { ExternalTurnObserver } from "../../src/coordinator/external-turn-observer.js";
import { PaneClosureWorkflow } from "../../src/coordinator/pane-closure-workflow.js";
import { PromptRunWorkflow } from "../../src/coordinator/prompt-run-workflow.js";
import { RecoverySupervisor } from "../../src/coordinator/recovery-supervisor.js";
import { RetiredPaneCleanupWorkflow } from "../../src/coordinator/retired-pane-cleanup-workflow.js";
import { StartupViewConverger } from "../../src/coordinator/startup-view-converger.js";
import { StartupRecoveryWorkflow } from "../../src/coordinator/startup-recovery-workflow.js";
import { TurnControlWorkflow } from "../../src/coordinator/turn-control-workflow.js";
import { TurnControlDispatcher } from "../../src/coordinator/turn-control-dispatcher.js";
import { AgentInputDrainer } from "../../src/coordinator/agent-input-drainer.js";
import { AgentInputWorkflow } from "../../src/coordinator/agent-input-workflow.js";
import { InitialAgentInputWorkflow } from "../../src/coordinator/initial-agent-input-workflow.js";
import { SwarmCommandContextResolver } from "../../src/coordinator/swarm-command-context-resolver.js";
import { SwarmCommandGateway } from "../../src/coordinator/swarm-command-gateway.js";
import { MainCardWorkflow } from "../../src/coordinator/main-card-workflow.js";
import { AnswerPageWorkflow } from "../../src/coordinator/answer-page-workflow.js";
import type { HerdrPort, LarkPort, TraexControlPort, AgentTranscriptReaderPort } from "../../src/domain/ports.js";
import { cardKitPanePresentation } from "../../src/cards/cardkit-pane-presentation.js";
import { cardKitPrimaryPresentation } from "../../src/cards/cardkit-primary-presentation.js";
import { cardKitApplicationPresentation } from "../../src/cards/cardkit-application-presentation.js";
import type { BridgeEventBus } from "../../src/events/bridge-event-bus.js";
import { InProcessInboundWorkNotifier, type InboundWorkNotifier } from "../../src/events/inbound-work-notifier.js";
import type { TestOutbound } from "./create-test-outbound.js";
import { InProcessOutboundWorkNotifier } from "../../src/events/outbound-work-notifier.js";
import { InProcessPromptWorkScheduler, type PromptWorkScheduler } from "../../src/events/prompt-work-scheduler.js";
import type { SqliteBindingStore } from "./sqlite-binding-store.js";
import { createFeishuGatewayPlugin } from "../../src/gateways/feishu/plugin.js";
import { GatewayEffectClient } from "../../src/gateways/effect-client.js";
import { createFeishuCompatibilityDelivery } from "../../src/gateways/feishu/plugin.js";
import { createCompatibilityGatewayIngressSink } from "../../src/gateways/compatibility-ingress.js";
import { AgentDriverRegistry } from "../../src/runtime/agents/agent-driver.js";
import { TraexDriver } from "../../src/runtime/agents/traex-driver.js";
import { CodexDriver } from "../../src/runtime/agents/codex-driver.js";
import { ClaudeCodeDriver } from "../../src/runtime/agents/claude-code-driver.js";
import { PiDriver } from "../../src/runtime/agents/pi-driver.js";
import { createQueuedRunCard } from "../../src/domain/run-card-view.js";
import { formatNativeInputBatch } from "../../src/domain/native-input-batch.js";
import type { IncomingLarkMessage } from "../../src/domain/types.js";

const legacyPromptSchedulers = new WeakMap<SqliteBindingStore, PromptWorkScheduler>();
const legacyPromptOutbounds = new WeakMap<SqliteBindingStore, TestOutbound>();

export function createTestRouter(
  config: BridgeConfig,
  store: SqliteBindingStore,
  herdr: HerdrPort,
  lark: LarkPort,
  bus: BridgeEventBus,
  outbound: TestOutbound,
  logger: Logger,
  shutdownGraceMs = 30_000,
  scheduler: PromptWorkScheduler = new InProcessPromptWorkScheduler(logger),
  inboundWork: InboundWorkNotifier = new InProcessInboundWorkNotifier(),
  transcriptReader?: AgentTranscriptReaderPort,
  observeExternalTurns = false,
  traexControl: TraexControlPort = { async listModels() { throw new Error("TraeX model control is not configured"); } },
  piTranscriptRoot?: string
): InboundRouter {
  legacyPromptSchedulers.set(store, scheduler);
  legacyPromptOutbounds.set(store, outbound);
  const promptHerdr: HerdrPort = {
    ...herdr,
    getPane: async (paneId) => await herdr.getPane(paneId)
      ?? (await herdr.listPanes(paneId.split(":")[0] ?? "w1")).find((pane) => pane.paneId === paneId)
      ?? fallbackPromptPane(store.findBindingByPane(paneId), paneId)
  };
  const agentDrivers = new AgentDriverRegistry([
    new TraexDriver(promptHerdr, config.traex.executable, config.turnTimeoutMs),
    new CodexDriver(promptHerdr, config.agents?.codex ?? "codex", config.turnTimeoutMs, true),
    new ClaudeCodeDriver(promptHerdr, config.agents?.claudeCode ?? "claude", config.turnTimeoutMs, true),
    new PiDriver(promptHerdr, config.agents?.pi ?? "pi", config.turnTimeoutMs, true, piTranscriptRoot)
  ]);
  const outboundWork = new InProcessOutboundWorkNotifier(logger);
  const gatewayEffects = new GatewayEffectClient(createFeishuCompatibilityDelivery(lark, config.gateway?.id ?? "feishu:primary"));
  outboundWork.subscribe(() => outbound.requestScan());
  const writer = outbound;
  const mainCards = new MainCardWorkflow(store, () => outboundWork.wake(), cardKitPrimaryPresentation, logger);
  outbound.connectPromptScheduler(scheduler);
  let promptRun!: PromptRunWorkflow;
  const bindingPrompts = new BindingPromptWorkflow({ config, store, lifecycleEvents: bus, outboundWork, scheduler, presentation: cardKitPrimaryPresentation });
  const externalTurns = transcriptReader && observeExternalTurns ? new ExternalTurnObserver({
    store, transcriptReader, bus, outboundWork, logger, presentation: cardKitPrimaryPresentation,
    workflow: bindingPrompts,
    wakePrompt: (bindingId) => scheduler.wake({ kind: "prompt-ready", bindingId })
  }) : undefined;
  promptRun = new PromptRunWorkflow({
    stores: { dispatch: store, recovery: store, session: store }, herdr: promptHerdr, agentDrivers, bus, scheduler, outboundWork, logger, presentation: cardKitPrimaryPresentation, turnTimeoutMs: config.turnTimeoutMs, shutdownGraceMs, transcriptReader, mainCards,
    bindingPrompts,
    adoptRuntimeIdentity: (input) => store.applyRuntimeObservation(input),
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
  const provisioning = new BindingProvisioningWorkflow({ config, store, herdr, agentDrivers, gatewayEffects, lifecycleEvents: bus, outbound: writer, outboundWork, scheduler, primaryTools, wakeRetiredPaneCleanup: () => void retiredPaneCleanup.requestScan(), presentation: cardKitApplicationPresentation, logger });
  const modelSelection = new ModelSelectionWorkflow({ config, store, traexControl, outbound: writer, outboundWork, scheduler, mainCards, activeTurn: (bindingId) => promptRun.activeTurn(bindingId), presentation: cardKitApplicationPresentation, logger });
  const turnControlDispatcher = new TurnControlDispatcher({ store, herdr, presentation: cardKitApplicationPresentation, wakeOutbound: () => outboundWork.wake(), logger });
  const turnControl = new TurnControlWorkflow({ store, herdr, projects: config.projects, idFactory: randomUUID, bindingPrompts, wakePrimary: (bindingId) => scheduler.wake({ kind: "prompt-ready", bindingId }), wakeTurnControl: (owner) => turnControlDispatcher.wake(owner), presentation: cardKitApplicationPresentation });
  const paneControl = new PaneControlWorkflow({ store, outbound: writer, presentation: cardKitPanePresentation, scheduler, model: modelSelection, turnControl, activeTurn: (bindingId) => promptRun.activeTurn(bindingId) });
  const operationsQuery = new OperationsQueryWorkflow({ config, store, herdr, outbound: writer, presentation: cardKitApplicationPresentation, logger });
  const sessionAdministration = new SessionAdministrationWorkflow({ config, store, herdr, lifecycleEvents: bus, outbound: writer, outboundWork, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId), presentation: cardKitApplicationPresentation });
  const deliveryRecovery = new DeliveryRecoveryWorkflow({ store, gatewayEffects, outbound: writer, outboundWork, presentation: cardKitApplicationPresentation, logger });
  const paneClosure = new PaneClosureWorkflow({ config, store, herdr, lifecycleEvents: bus, outbound: writer, presentation: cardKitPanePresentation, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId) });
  const sessionOperations = new SessionOperationWorkflow({ store, sessionAdministration, provisioning, paneControl, paneClosure, logger });
  const reconciler = new HerdrRuntimeReconciler({
    projects: config.projects, store, herdr, lifecycleEvents: bus, channelPublisher: writer, logger,
    discoverPane: (pane, project) => provisioning.discover(pane, project), scheduler,
    isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId), externalTurnObserver: externalTurns, presentation: cardKitApplicationPresentation
  });
  const commandResolver = new SwarmCommandContextResolver({ config, store, activeTurn: (bindingId) => promptRun.activeTurn(bindingId) });
  const recoverySupervisor = new RecoverySupervisor({
    execution: { scan: () => promptRun.requestSafetyScan() },
    conversationProjection: { catchUp: (bindingId) => externalTurns?.catchUp(bindingId) ?? Promise.resolve() },
    deliveryDebt: {
      listPromptIds: (bindingId, limit) => store.listRecoverablePrimaryAnswerPromptIdsForBinding(bindingId, limit),
      listWorkerTurnIds: (bindingId, limit) => store.listRecoverableWorkerTurnIdsForBinding(bindingId, limit),
      getBindingStage: (bindingId) => store.getRecoveryStageForBinding(bindingId)
    },
    diagnostics: { snapshot: () => store.getRecoveryDurableEvidence() },
    delivery: { scan: async () => undefined, requestPrompt: async () => undefined, requestWorkerTurn: async () => undefined, stop: async () => undefined },
    logger
  });
  const swarmCommands = new SwarmCommandGateway({ store, primaryPrompts: store, resolver: commandResolver, outbound: writer, logger, provisioning, modelSelection, paneControl, operationsQuery, sessionAdministration, paneClosure, promptRun, recoverySupervisor, instanceControl: { createWorker: async () => { throw new Error("Worker creation is not configured in this test fixture"); }, inspect: () => { throw new Error("Worker inspection is not configured in this test fixture"); } }, wakeCardContext: () => {}, presentation: cardKitApplicationPresentation });
  const cardInteractions = new CardInteractionWorkflow({ store, projects: config.projects, adminOpenIds: config.lark.adminOpenIds, sessionAdministration, commands: swarmCommands, bindingPrompts, presentation: cardKitApplicationPresentation, logger });
  const agentInputCore = {
    async capabilities() { return { agentInputSubmissionV2: true, agentInputSubmissionV3: true }; },
    async submit(input: import("../../src/domain/ports/agent-input.js").SubmitAgentInputRequest) {
      return { outcome: "receipt" as const, receipt: {
        submissionId: input.submissionId, paneId: input.paneId, terminalId: input.terminalId,
        agentKind: input.agentKind, sessionId: input.sessionId, state: "prepared" as const,
        turnId: null, startedAt: null, terminalState: null, createdAt: Date.now(), updatedAt: Date.now()
      } };
    },
    async queryReceipt() { return { outcome: "absent" as const }; }
  };
  const agentInputDrainer = new AgentInputDrainer({ store: store.agentInputs, core: agentInputCore });
  const agentInput = new AgentInputWorkflow({
    store: store.agentInputs,
    drainer: agentInputDrainer,
    capability: { snapshot: () => ({ required: true, detected: true, supported: true, ready: true, error: null }) }
  });
  const initialAgentInput = new InitialAgentInputWorkflow({ agentInput, outbound: writer, presentation: cardKitPrimaryPresentation });
  const messageRouting = new InboundMessageRoutingWorkflow({ config, routing: store, agentInput, initialAgentInput, outbound: writer, logger, presentation: cardKitPrimaryPresentation, provisioning, swarmCommands });
  const inboundPipeline = new DurableInboundPipeline({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, store, router: messageRouting, inboundWork, logger });
  const cardActionRouter = new CardActionRouter({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, adminOpenIds: config.lark.adminOpenIds, projects: config.projects, store, provisioning, cardInteractions, modelSelection, deliveryRecovery, logger, submitInitialAgentInput: (binding, selection) => initialAgentInput.submit(binding, selection) });
  const startupViews = new StartupViewConverger({
    config, stores: { startupViews: store },
    outbound: writer, outboundWork, presentation: cardKitPrimaryPresentation,
    answerPages: new AnswerPageWorkflow(store, () => outboundWork.wake(), cardKitPrimaryPresentation, logger),
    mainCards: new MainCardWorkflow(store, () => outboundWork.wake(), cardKitPrimaryPresentation, logger),
    logger
  });
  const gateway = createFeishuGatewayPlugin({ createTransport: () => lark }).create({ gatewayId: config.gateway?.id ?? "feishu:primary", ...config.lark }, { logger });
  const gatewaySink = createCompatibilityGatewayIngressSink({ receiveMessage: (message) => inboundPipeline.receive(message), handleAction: (action) => cardActionRouter.handle(action) });
  const startupRecovery = new StartupRecoveryWorkflow({ config, store, herdr, gatewayIngress: gateway.ingress, gatewaySink, logger, scheduler, inboundPipeline, cardActionRouter, initialAgentInput, promptRun, provisioning, paneControl, paneClosure, sessionOperations, swarmCommands, reconciler, retiredPaneCleanup, startupViews });
  const router = new InboundRouter({ gatewayIngress: gateway.ingress, promptRun, reconciler, retiredPaneCleanup, sessionOperations, swarmCommands, inboundPipeline, cardActionRouter, startupRecovery });
  const start = router.start.bind(router);
  router.start = async () => {
    promptRun.start();
    try { await start(); }
    catch (error) { await promptRun.stop(); throw error; }
  };
  const stop = router.stop.bind(router);
  router.stop = async (context) => {
    await stop(context);
    await promptRun.stop(context);
  };
  const receive = router.handleMessage.bind(router);
  router.handleMessage = async (message) => {
    await receive(message);
    await waitForAcceptedInbound(store, message.eventId);
  };
  return router;
}

export function queueLegacyPromptForTest(store: SqliteBindingStore, message: IncomingLarkMessage): string {
  const scheduler = legacyPromptSchedulers.get(store);
  if (!scheduler) throw new Error("createTestRouter must register the Prompt scheduler before seeding legacy work");
  const binding = store.findBindingByLarkScope(message.topicId, message.rootMessageId);
  if (!binding?.paneId) throw new Error("Legacy Prompt test input requires an active bound Pane");
  const promptId = message.messageId;
  const body = message.text;
  const combinedBody = formatNativeInputBatch([body]);
  const view = createQueuedRunCard({
    promptId,
    bindingId: binding.id,
    bindingGeneration: binding.generation,
    title: body,
    sessionTitle: binding.title,
    agentKind: binding.agentKind,
    workspaceId: binding.workspaceId,
    paneId: binding.paneId,
    requestText: combinedBody,
    replyContext: body,
    queuePosition: store.countPendingPrompts(binding.id) + 1,
    occurredAt: new Date().toISOString()
  });
  store.acceptImmediateNativeInputBatch({
    input: {
      id: `${promptId}:input`,
      bindingId: binding.id,
      bindingGeneration: binding.generation,
      ingressSource: "feishu",
      sourceMessageKey: message.messageId,
      larkMessageId: message.messageId,
      actorOpenId: message.actorOpenId,
      body,
      rootMessageId: message.rootMessageId ?? message.messageId,
      parentPromptId: null
    },
    batchId: promptId,
    combinedBody,
    occurredAt: new Date().toISOString(),
    view,
    answerCard: cardKitPrimaryPresentation.answerCard(view),
    maxQueueDepth: 100
  });
  scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
  legacyPromptOutbounds.get(store)?.requestScan();
  return promptId;
}

export function queueLegacyCollectedBatchForTest(store: SqliteBindingStore, messages: readonly IncomingLarkMessage[]): void {
  const scheduler = legacyPromptSchedulers.get(store);
  if (!scheduler) throw new Error("createTestRouter must register the Prompt scheduler before seeding legacy work");
  if (messages.length === 0) throw new Error("Legacy collected batch requires at least one message");
  const binding = store.findBindingByLarkScope(messages[0]!.topicId, messages[0]!.rootMessageId);
  if (!binding?.paneId) throw new Error("Legacy Prompt test input requires an active bound Pane");
  const occurredAt = new Date(Date.now() - 5).toISOString();
  for (const message of messages) {
    store.acceptCollectingNativeInput({
      input: {
        id: `${message.messageId}:input`, bindingId: binding.id, bindingGeneration: binding.generation,
        ingressSource: "feishu", sourceMessageKey: message.messageId, larkMessageId: message.messageId,
        actorOpenId: message.actorOpenId, body: message.text, rootMessageId: message.rootMessageId ?? message.messageId,
        parentPromptId: null
      },
      batchId: `${messages[0]!.messageId}:batch`, occurredAt, windowMs: 1, maxQueueDepth: 100
    });
  }
  scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
}

async function waitForAcceptedInbound(store: SqliteBindingStore, eventId: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const row = store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = ?").get(eventId) as { state: string } | undefined;
    if (!row || row.state === "accepted") return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for inbound acceptance: ${eventId}`);
}

function fallbackPromptPane(binding: ReturnType<SqliteBindingStore["findBindingByPane"]>, paneId: string): NonNullable<Awaited<ReturnType<HerdrPort["getPane"]>>> {
  return { paneId, workspaceId: binding?.workspaceId ?? paneId.split(":")[0] ?? "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"],
    ...(binding?.traexSessionId ? { terminalId: binding.traexSessionId } : {}),
    ...(binding?.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue ? { agentSession: { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } } : {}) };
}
