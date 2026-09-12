import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { CardInteractionWorkflow } from "../coordinator/card-interaction-workflow.js";
import { InstanceInteractionWorkflow } from "../coordinator/instance-interaction-workflow.js";
import { ModelSelectionWorkflow } from "../coordinator/model-selection-workflow.js";
import { PaneControlWorkflow } from "../coordinator/pane-control-workflow.js";
import { SessionOperationWorkflow } from "../coordinator/session-operation-workflow.js";
import { SwarmCommandContextResolver } from "../coordinator/swarm-command-context-resolver.js";
import { SwarmCommandGateway } from "../coordinator/swarm-command-gateway.js";
import type { TurnControlWorkflow } from "../coordinator/turn-control-workflow.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { SqliteStoreBundle } from "../store/sqlite-store-bundle.js";
import type { createBindingSessionRuntime } from "./create-binding-session-runtime.js";
import type { createInfrastructureRuntime } from "./create-infrastructure-runtime.js";
import type { createOutboundRuntime } from "./create-outbound-runtime.js";
import type { createPrimaryRuntime } from "./create-primary-runtime.js";
import type { createWorkerRuntime } from "./create-worker-runtime.js";
import type { ApplicationPresentation, PanePresentation } from "../domain/ports/presentation.js";
import { WorkerSessionThreadWorkflow } from "../coordinator/worker-session-thread-workflow.js";

export type CommandControlStores = Pick<SqliteStoreBundle, "modelSelection" | "paneControl" | "sessionOperations" | "cardInteraction" | "inboundRouting" | "commandIntents" | "instance" | "workerSessionThreads">;

export function createCommandControlRuntime(options: {
  config: BridgeConfig; stores: CommandControlStores; logger: Logger; turnControl: TurnControlWorkflow; scheduler: PromptWorkScheduler;
  infrastructure: ReturnType<typeof createInfrastructureRuntime>; delivery: ReturnType<typeof createOutboundRuntime>;
  primary: ReturnType<typeof createPrimaryRuntime>; worker: ReturnType<typeof createWorkerRuntime>;
  bindingSession: ReturnType<typeof createBindingSessionRuntime>; presentation: { application: ApplicationPresentation; pane: PanePresentation };
}) {
  const { config, stores, logger, turnControl, scheduler, infrastructure, delivery, primary, worker, bindingSession, presentation } = options;
  const { traexControl, agentDrivers } = infrastructure; const { outbound, outboundWork, mainCards } = delivery; const { promptRun } = primary;
  const { provisioning, operationsQuery, sessionAdministration, deliveryRecovery, paneClosure } = bindingSession;
  const modelSelection = new ModelSelectionWorkflow({ config, store: stores.modelSelection, traexControl, outbound, outboundWork, scheduler, mainCards, activeTurn: (bindingId) => promptRun.activeTurn(bindingId), presentation: presentation.application, logger });
  const paneControl = new PaneControlWorkflow({ store: stores.paneControl, outbound, presentation: presentation.pane, scheduler, model: modelSelection, turnControl, activeTurn: (bindingId) => promptRun.activeTurn(bindingId) });
  const sessionOperations = new SessionOperationWorkflow({ store: stores.sessionOperations, sessionAdministration, provisioning, paneControl, paneClosure, logger });
  const cardInteractions = new CardInteractionWorkflow({ store: stores.cardInteraction, adminOpenIds: config.lark.adminOpenIds, sessionAdministration, sessionOperations, wakePrompt: (bindingId) => scheduler.wake({ kind: "prompt-ready", bindingId }), presentation: presentation.application, logger });
  const commandResolver = new SwarmCommandContextResolver({ config, store: stores.inboundRouting, activeTurn: (bindingId) => promptRun.activeTurn(bindingId) });
  const swarmCommands = new SwarmCommandGateway({ store: stores.commandIntents, resolver: commandResolver, outbound, logger, provisioning, modelSelection, paneControl, operationsQuery, sessionAdministration, paneClosure, promptRun, instanceControl: worker.instanceControl, presentation: presentation.application });
  const workerSessionThreads = new WorkerSessionThreadWorkflow({ adminOpenIds: config.lark.adminOpenIds, store: stores.workerSessionThreads, messaging: worker.instanceMessaging, outbound, wakeOutbound: () => outboundWork.wake(), presentation: presentation.application });
  const instanceInteractions = new InstanceInteractionWorkflow({ projects: config.projects, adminOpenIds: config.lark.adminOpenIds, store: stores.instance, control: worker.instanceControl, messaging: worker.instanceMessaging, drivers: agentDrivers, outbound, wakeOutbound: () => outboundWork.wake(), workerCreation: swarmCommands, presentation: presentation.application, workerSessionThreads });
  return { modelSelection, paneControl, sessionOperations, cardInteractions, swarmCommands, instanceInteractions, workerSessionThreads, deliveryRecovery };
}
