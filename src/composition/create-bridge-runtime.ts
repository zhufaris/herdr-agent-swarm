import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
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

export type { AgentRuntimeAvailability } from "./create-infrastructure-runtime.js";
export function createBridgeRuntime(config: BridgeConfig, stores: SqliteStoreBundle, logger: Logger, availability: AgentRuntimeAvailability) {
  const applicationPresentation = createFeishuGatewayApplicationPresentation(config.runtimeTuning.cards, config.projects);
  const presentation = { application: applicationPresentation, primary: applicationPresentation, pane: feishuGatewayPanePresentation };
  const events = new RuntimeEventIntegration(logger);
  const infrastructure = createInfrastructureRuntime(config, logger, availability, events.herdrHintConsumer);
  const { herdrSocketSubscriber, herdrCircuitBreaker, herdr, traexControl, paneHost, agentDrivers, worktrees, transcriptReader } = infrastructure;
  const turnControlDispatcher = new TurnControlDispatcher({ store: stores.turnControl, herdr, presentation: applicationPresentation, wakeOutbound: () => events.wakeOutbound(), logger });
  const turnControl = new TurnControlWorkflow({ store: stores.turnControl, herdr, idFactory: randomUUID, presentation: applicationPresentation, wakeOutbound: () => events.wakeOutbound(), wakePrimary: (bindingId) => events.wakePrimary(bindingId), wakeInstance: (instanceId) => events.wakeInstance(instanceId), wakeTurnControl: (owner) => events.wakeTurnControl(owner.kind, owner.id), maxQueueDepth: config.maxQueueDepth });
  events.onWork("turn-control-dispatcher", (hint) => { if (hint.kind === "turn-control-ready") turnControlDispatcher.wake({ kind: hint.ownerKind, id: hint.ownerId }); });
  const bus = events.lifecycle; const scheduler = events.promptWork; const inboundWork = events.inboundWork;
  const delivery = createOutboundRuntime(config, { ...stores, workerTurns: stores.instance }, infrastructure.gateway, bus, events.outboundWork, logger, presentation);
  const { outboundWork, channelPublisher, mainCards, projector, queueFeedbackProjector, cardContextRebuilder, outboxRetention } = delivery;
  const worker = createWorkerRuntime({ config, stores: { instance: stores.instance, instanceExecution: stores.instance, workerCardDisplay: stores.workerCardDisplay }, logger, turnControl, paneHost, agentDrivers, worktrees, transcriptReader, outboundWork, workerTurnCards: delivery.workerTurnCards, applicationPresentation });
  const { instanceWork, instanceTurns, instanceRuntime, primaryToolGateway, instanceWorker } = worker;
  events.registerInstanceWakeup((instanceId) => instanceWork.wake(instanceId));
  const sqliteIntegrity = new SqliteIntegrityAuditor(new WorkerDatabaseIntegrityStore(config.databasePath), config.sqliteIntegrityAudit, logger);
  channelPublisher.connectPromptScheduler(scheduler);
  const primary = createPrimaryRuntime({ config, stores, logger, herdr, traexControl, agentDrivers, bus, scheduler, outboundWork, transcriptReader, mainCards, presentation: applicationPresentation });
  const { externalTurns, promptRun } = primary;
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
  const { coordinator, paneRetention, sessionOperations, reconciler, herdrEventRouter, swarmCommands } = createApplicationRuntime({ config, stores, logger, turnControl, bus, scheduler, inboundWork, infrastructure, delivery, primary, worker, presentation, naturalLanguageCommands });
  primaryToolGateway.setWorkerCreation(swarmCommands);
  events.connectHerdrHints((hint, signal) => herdrEventRouter.handle(hint, signal));
  events.seal();
  const lifecycle = {
    primaryToolGateway, naturalLanguageCommands, sqliteIntegrity, instanceRuntime, instanceTurns,
    herdrSnapshotCache: herdr, instanceWork, turnControlDispatcher, runtimeEvents: events, channelPublisher, outboxRetention, projector,
    cardContextRebuilder, queueFeedbackProjector, bus, coordinator, paneRetention, externalTurns,
    ...(herdrSocketSubscriber ? { herdrSocketSubscriber } : {})
  };
  const health = {
    herdr, workspaceCache: herdr, herdrCircuitBreaker, startupRecovery: coordinator,
    inboundDispatcher: { snapshot: () => coordinator.inboundSnapshot() },
    sessionOperationDispatcher: sessionOperations, bindingRuntime: reconciler, instanceRuntime,
    instanceWorker, sqliteIntegrity, lifecycleEvents: bus, cardConvergence: projector,
    outboxDispatcher: channelPublisher, promptWorker: promptRun,
    ...(herdrSocketSubscriber ? { herdrSocket: herdrSocketSubscriber } : {})
  };
  const operations = { gateway: infrastructure.gateway };
  return { lifecycle, health, operations };
}
