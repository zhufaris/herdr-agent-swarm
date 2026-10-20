import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { BindingPromptWorkflow } from "../coordinator/binding-prompt-workflow.js";
import { TurnControlWorkflow } from "../coordinator/turn-control-workflow.js";
import { TurnControlDispatcher } from "../coordinator/turn-control-dispatcher.js";
import { SqliteIntegrityAuditor } from "../runtime/sqlite-integrity-auditor.js";
import { WorkerDatabaseIntegrityStore } from "../runtime/sqlite-integrity-worker.js";
import type { SqliteStoreBundle } from "../store/sqlite-store-bundle.js";
import { RuntimeEventIntegration } from "./runtime-event-integration.js";
import { createInfrastructureRuntime } from "./create-infrastructure-runtime.js";
import { createOutboundRuntime } from "./create-outbound-runtime.js";
import { createWorkerRuntime } from "./create-worker-runtime.js";
import { createPrimaryRuntime } from "./create-primary-runtime.js";
import { createApplicationRuntime } from "./create-application-runtime.js";
import type { AgentRuntimeAvailability } from "./create-infrastructure-runtime.js";
import { createFeishuGatewayApplicationPresentation, feishuGatewayPanePresentation } from "../gateways/feishu/presentation.js";
import { createNaturalLanguageCommandRuntime } from "../runtime/natural-language-command-runtime.js";
import type { AdoptExternalTurnInput } from "../domain/ports/workflow.js";
import { CompletionChoiceEligibility } from "../runtime/completion-choice-eligibility.js";
import { CompletionChoiceEligibilityGateway } from "../runtime/completion-choice-eligibility-gateway.js";
import { RecoverySupervisor, type RecoverySupervisorPort } from "../coordinator/recovery-supervisor.js";
import { RuntimeLink } from "./runtime-link.js";
import { AgentInputDrainer } from "../coordinator/agent-input-drainer.js";
import { AgentInputWorkflow } from "../coordinator/agent-input-workflow.js";
import { resolvePrimarySessionIngestionSource, resolveWorkerSessionIngestionSource } from "../coordinator/core-session-ingestion-supervisor.js";
import { recoverPendingCanonicalTurns } from "../coordinator/canonical-input-recovery-workflow.js";
import { attachDeliveryLatencyLogging } from "../runtime/service-logger.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import { HistoricalRecoveryWorkflow } from "../coordinator/historical-recovery-workflow.js";

export type { AgentRuntimeAvailability } from "./create-infrastructure-runtime.js";
export function createBridgeRuntime(config: BridgeConfig, stores: SqliteStoreBundle, logger: Logger, availability: AgentRuntimeAvailability, buildIdentity?: Pick<BuildIdentity, "gitBranch" | "gitCommit">) {
  const deliveryTrace = stores.deliveryTrace;
  if (!deliveryTrace) throw new Error("Delivery latency trace capability is unavailable");
  const tracedStores = { ...stores, deliveryTrace };
  attachDeliveryLatencyLogging(deliveryTrace, logger);
  const applicationPresentation = createFeishuGatewayApplicationPresentation(config.runtimeTuning.cards, config.projects, {
    branch: buildIdentity?.gitBranch ?? null, gitCommit: buildIdentity?.gitCommit ?? null
  });
  const presentation = { application: applicationPresentation, primary: applicationPresentation, pane: feishuGatewayPanePresentation };
  const events = new RuntimeEventIntegration(logger);
  const infrastructure = createInfrastructureRuntime(config, logger, availability, events.herdrHintConsumer, stores.coreEvents, stores.turnSnapshots);
  const agentInputDrainer = new AgentInputDrainer({ store: stores.agentInputs, core: infrastructure.agentInputCore, logger });
  const agentInput = new AgentInputWorkflow({ store: stores.agentInputs, drainer: agentInputDrainer, capability: infrastructure.agentInputCapability });
  const { herdrSocketSubscriber, herdrCircuitBreaker, herdr, traexControl, paneHost, agentDrivers, worktrees, transcriptReader } = infrastructure;
  const completionChoiceEligibilityGateway = new CompletionChoiceEligibilityGateway(
    join(dirname(config.databasePath), "completion-choice-eligibility.sock"),
    new CompletionChoiceEligibility(stores.instance, paneHost),
    logger
  );
  const bus = events.lifecycle; const scheduler = events.promptWork; const inboundWork = events.inboundWork;
  const delivery = createOutboundRuntime(config, { ...tracedStores, workerTurns: stores.instance }, infrastructure.gateway, bus, events.outboundWork, logger, presentation);
  const { outboundWork, checkpoints, ringDeliveryEngine, projector, projectionDeliveryRecoveryWatchdog, cardContextRebuilder, outboxRetention, turnCards } = delivery;
  const bindingPrompts = new BindingPromptWorkflow({
    config,
    store: Object.assign({}, stores.promptAcceptance, stores.promptDispatch, stores.externalTurns, {
      loadConversationTurnProjection: (identity: Parameters<typeof stores.externalTurns.loadConversationTurnProjection>[0]) => stores.externalTurns.loadConversationTurnProjection(identity),
      projectConversationTurn: (input: Parameters<typeof stores.externalTurns.projectConversationTurn>[0]) => stores.externalTurns.projectConversationTurn(input),
      adoptNativeTurn: (input: AdoptExternalTurnInput) => stores.externalTurns.adoptExternalTurn(input)
    }),
    lifecycleEvents: bus,
    outboundWork,
    scheduler,
    convergeAnswer: (promptId) => delivery.answerPages.converge(promptId),
    presentation: applicationPresentation,
    logger
  });
  const turnControlDispatcher = new TurnControlDispatcher({ store: stores.turnControl, herdr, presentation: applicationPresentation, wakeOutbound: () => events.wakeOutbound(), logger });
  const turnControl = new TurnControlWorkflow({ store: stores.turnControl, herdr, projects: config.projects, idFactory: randomUUID, presentation: applicationPresentation, agentInput, wakeOutbound: () => events.wakeOutbound(), wakePrimary: (bindingId) => events.wakePrimary(bindingId), wakeInstance: (instanceId) => events.wakeInstance(instanceId), wakeTurnControl: (owner) => events.wakeTurnControl(owner.kind, owner.id), maxQueueDepth: config.maxQueueDepth });
  events.onWork("turn-control-dispatcher", (hint) => { if (hint.kind === "turn-control-ready") turnControlDispatcher.wake({ kind: hint.ownerKind, id: hint.ownerId }); });
  const worker = createWorkerRuntime({ config, stores: { instance: stores.instance, instanceExecution: stores.instance, workerCardDisplay: stores.workerCardDisplay, paneTopology: stores.paneTopology, topology: Object.assign({}, stores.operationsQuery, { listAgentInstances: (projectId: string) => stores.instance.listAgentInstances(projectId) }) }, logger, turnControl, paneHost, herdr, agentDrivers, worktrees, transcriptReader, outboundWork, workerTurnCards: delivery.workerTurnCards, applicationPresentation });
  const { instanceWork, instanceTurns, instanceRuntime, primaryToolGateway, instanceWorker } = worker;
  events.registerInstanceWakeup((instanceId) => instanceWork.wake(instanceId));
  const sqliteDiagnostics = new WorkerDatabaseIntegrityStore(config.databasePath, { busyTimeoutMs: config.sqlite.busyTimeoutMs });
  const sqliteIntegrity = new SqliteIntegrityAuditor(sqliteDiagnostics, config.sqliteIntegrityAudit, logger);
  const recoveredPromptDelivery = new RuntimeLink<Pick<RecoverySupervisorPort, "requestPrompt">>("Recovered prompt delivery");
  const sessionEventMultiplex = infrastructure.herdrSessionEventSubscriber ? {
    replaceTargets: async (targets: Parameters<typeof infrastructure.herdrSessionEventSubscriber.replaceTargets>[0]) => {
      await infrastructure.herdrSessionEventSubscriber!.replaceTargets(targets);
      return infrastructure.herdrSessionEventSubscriber!.status().generation;
    },
    clearTargets: () => infrastructure.herdrSessionEventSubscriber!.clearTargets(),
    connectFrames: infrastructure.connectSessionEventFrames,
    connectActivation: infrastructure.connectSessionEventActivation,
    connectTargetRefresh: infrastructure.connectSessionEventTargetRefresh,
    connectTransportState: infrastructure.connectSessionEventTransport
  } : undefined;
  const primary = createPrimaryRuntime({
    config, stores, logger, bus, scheduler, outboundWork, transcriptReader, sessionIngestor: infrastructure.coreSessionIngestor,
    resolveSessionSource: (candidate) => resolvePrimarySessionIngestionSource(candidate, {
      getBinding: (id) => stores.externalTurns.getBinding(id),
      getPane: (paneId) => infrastructure.herdr.getPane(paneId)
    }),
    workerSessions: {
      listWorkerSessions: () => [...new Map(config.projects.flatMap((project) => stores.instance.listAgentInstances(project.id))
        .filter((instance) => instance.role === "worker").map((instance) => [instance.id, instance])).values()]
    },
    resolveWorkerSessionSource: (candidate) => resolveWorkerSessionIngestionSource(candidate, {
      getAgentInstance: (id) => stores.instance.getAgentInstance(id),
      getBinding: (id) => stores.externalTurns.getBinding(id),
      getPane: (paneId) => infrastructure.herdr.getPane(paneId)
    }),
    onWorkerSessionIngested: (_instanceId, paneId) => instanceTurns.requestObservationByPane([paneId]),
    recoverCanonicalTurns: () => recoverPendingCanonicalTurns({
      store: stores.agentInputs,
      recover: async (intent, receipt) => infrastructure.coreSessionIngestor ? infrastructure.coreSessionIngestor.recoverCanonicalTurn({
        agentKind: intent.expectedAgentKind, bindingId: intent.owner.id, generation: intent.owner.generation,
        paneId: intent.paneId, terminalId: intent.terminalId,
        nativeSession: receipt.sessionId ? { source: `herdr:${intent.expectedAgentKind}`, agent: intent.expectedAgentKind, kind: "id", value: receipt.sessionId } : null
      }, receipt.turnId, receipt.startedAt) : "unavailable",
      logger
    }),
    reconcileCanonicalHumanMessages: () => stores.agentInputs.reconcileCanonicalHumanMessages(100),
    retireLegacyInputCards: (limit) => stores.legacyInputCards.scan(limit),
    requiresSessionIngestion: (ownerKind, ownerId, generation) => stores.agentInputs.hasPendingInputCards(ownerKind, ownerId, generation),
    presentation: applicationPresentation, bindingPrompts,
    ...(sessionEventMultiplex ? { sessionEventMultiplex } : {})
  });
  const { externalTurns, coreSessionIngestion } = primary;
  const historicalRecovery = new HistoricalRecoveryWorkflow(stores.coreEvents, {
    cards: turnCards,
    wakeOutbound: () => outboundWork.wake()
  });
  const recoverySupervisor = new RecoverySupervisor({
    conversationProjection: { catchUp: (bindingId) => externalTurns.catchUp(bindingId) },
    deliveryDebt: {
      listPromptIds: (bindingId, limit) => stores.answerPages.listRecoverablePrimaryAnswerPromptIdsForBinding(bindingId, limit),
      listWorkerTurnIds: (bindingId, limit) => stores.instance.listRecoverableWorkerTurnIdsForBinding(bindingId, limit),
      getBindingStage: (bindingId) => stores.health.getRecoveryStageForBinding(bindingId)
    },
    diagnostics: { snapshot: () => stores.health.getRecoveryDurableEvidence() },
    delivery: projectionDeliveryRecoveryWatchdog,
    historical: historicalRecovery,
    logger
  });
  stores.coreEvents.onPendingWorkCommitted?.(() => { void recoverySupervisor.requestHistoricalRecovery(); });
  recoveredPromptDelivery.connect(recoverySupervisor);
  checkpoints.onAnswerCheckpoint((promptId) => { void recoverySupervisor.requestPrompt(promptId); });
  checkpoints.onWorkerTurnCheckpoint((turnId) => { void recoverySupervisor.requestWorkerTurn(turnId); });
  const defaultProject = config.projects.find((project) => project.id === config.defaultProjectId)!;
  const socketPath = join(dirname(config.databasePath), "controller-tools.sock");
  const naturalLanguageCommands = createNaturalLanguageCommandRuntime({
    projects: config.projects,
    ...(config.controller.enabled ? { controller: {
      store: stores.controllerInterpretations, herdr, project: defaultProject, socketPath, traexExecutable: config.traex.executable,
      mcpCommand: process.execPath, mcpArgs: [fileURLToPath(new URL("../cli/controller-tools-mcp.js", import.meta.url)), "--socket", socketPath],
      turnTimeoutMs: config.controller.timeoutMs, model: config.controller.model, logger,
      context: { findBindingByLarkScope: (topicId, rootMessageId) => stores.inboundRouting.findBindingByLarkScope(topicId, rootMessageId), listAgentInstances: (projectId) => stores.instance.listAgentInstances(projectId) }
    } } : {})
  });
  const { coordinator, paneRetention, sessionOperations, reconciler, herdrEventRouter, swarmCommands, programmaticWorkerCreation } = createApplicationRuntime({ config, stores: tracedStores, logger, turnControl, bus, scheduler, inboundWork, infrastructure, delivery, primary, worker, presentation, naturalLanguageCommands, agentInput, recoverySupervisor, runtimeEvents: events });
  primaryToolGateway.setWorkerCreation(programmaticWorkerCreation);
  events.connectHerdrHints((hint, signal) => herdrEventRouter.handle(hint, signal));
  events.seal();
  const lifecycle = {
    primaryToolGateway, completionChoiceEligibilityGateway, naturalLanguageCommands, sqliteIntegrity, instanceRuntime, instanceTurns,
    agentInput: {
      detect: () => infrastructure.agentInputCapability.detect(),
      migrate: () => stores.agentInputs.migrateLegacyNeverAttempted(new Date().toISOString()),
      recover: () => agentInputDrainer.startRecovery(),
      stop: () => agentInputDrainer.stopRecovery()
    },
    herdrSnapshotCache: herdr, instanceWork, turnControlDispatcher, runtimeEvents: events, ringDeliveryEngine, outboxRetention, projector, recoverySupervisor,
    cardContextRebuilder, turnCards, bus, coordinator, paneRetention, externalTurns,
    ...(coreSessionIngestion ? { coreSessionIngestion } : {}),
    ...(infrastructure.herdrSessionEventSubscriber ? { herdrSessionEventSubscriber: infrastructure.herdrSessionEventSubscriber } : {}),
    ...(herdrSocketSubscriber ? { herdrSocketSubscriber } : {})
  };
  const health = {
    herdr, workspaceCache: herdr, herdrCircuitBreaker, startupRecovery: coordinator,
    agentInputCapability: infrastructure.agentInputCapability,
    ...(coreSessionIngestion ? { coreSessionIngestion } : {}),
    inboundDispatcher: { snapshot: () => coordinator.inboundSnapshot() },
    sessionOperationDispatcher: sessionOperations, bindingRuntime: reconciler, instanceRuntime,
    instanceWorker, sqliteIntegrity, diagnostics: sqliteDiagnostics,
    diagnosticsIssueLimit: config.sqliteIntegrityAudit.issueLimit,
    lifecycleEvents: bus, cardConvergence: projector,
    deliveryEngine: ringDeliveryEngine, recoverySupervisor,
    ...(herdrSocketSubscriber ? { herdrSocket: herdrSocketSubscriber } : {})
  };
  const operations = { gateway: infrastructure.gateway };
  return { lifecycle, health, operations };
}
