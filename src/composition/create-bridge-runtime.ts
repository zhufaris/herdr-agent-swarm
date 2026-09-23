import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { TurnControlWorkflow } from "../coordinator/turn-control-workflow.js";
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
  const infrastructure = createInfrastructureRuntime(config, logger, availability, (hint, signal) => events.handleHerdrHint(hint, signal));
  const { herdrSocketSubscriber, herdrCircuitBreaker, herdr, traexControl, paneHost, agentDrivers, worktrees, transcriptReader } = infrastructure;
  const turnControl = new TurnControlWorkflow({ store: stores.turnControl, herdr, idFactory: randomUUID, presentation: applicationPresentation, wakeOutbound: () => events.wakeOutbound(), wakePrimary: (bindingId) => events.wakePrimary(bindingId), wakeInstance: (instanceId) => events.wakeInstance(instanceId), maxQueueDepth: config.maxQueueDepth });
  const bus = events.lifecycle; const scheduler = events.promptWork; const inboundWork = events.inboundWork;
  const delivery = createOutboundRuntime(config, stores, infrastructure.gateway, bus, events.outboundWork, logger, presentation);
  const { outboundWork, channelPublisher, mainCards, projector, queueFeedbackProjector, cardContextRebuilder, outboxRetention } = delivery;
  const worker = createWorkerRuntime({ config, stores, logger, turnControl, paneHost, agentDrivers, worktrees, transcriptReader, outboundWork, applicationPresentation });
  const { instanceWork, instanceTurns, instanceRuntime, primaryToolGateway } = worker;
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
  events.connectHerdrHints(herdrEventRouter);
  events.seal();
  const instanceWorker = { snapshot() { const dispatch = instanceWork.snapshot(); const observe = instanceTurns.snapshot(); return { state: dispatch.state, activeDispatchWorkers: dispatch.activeDispatchWorkers, activeObservers: observe.activeObservers, queuedTurns: observe.queuedTurns, activeTurns: observe.activeTurns, uncertainTurns: observe.uncertainTurns, lastScanAt: observe.lastScanAt, lastFailureAt: dispatch.lastFailureAt ?? observe.lastFailureAt, lastFailure: dispatch.lastFailure ?? observe.lastFailure }; } };
  return { herdr, herdrCircuitBreaker, herdrSocketSubscriber, instanceRuntime, instanceTurns, instanceWork, primaryToolGateway, naturalLanguageCommands, sqliteIntegrity, coordinator, queueFeedbackProjector, cardContextRebuilder, projector, channelPublisher, outboxRetention, paneRetention, externalTurns, instanceWorker, gateway: infrastructure.gateway, bus, sessionOperations, reconciler, promptRun };
}
