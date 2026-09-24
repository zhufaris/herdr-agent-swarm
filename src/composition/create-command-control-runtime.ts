import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { CardInteractionWorkflow } from "../coordinator/card-interaction-workflow.js";
import { InstanceInteractionWorkflow } from "../coordinator/instance-interaction-workflow.js";
import { ModelSelectionWorkflow } from "../coordinator/model-selection-workflow.js";
import { PaneControlWorkflow } from "../coordinator/pane-control-workflow.js";
import { SessionOperationWorkflow } from "../coordinator/session-operation-workflow.js";
import { SwarmCommandContextResolver } from "../coordinator/swarm-command-context-resolver.js";
import { SwarmCommandGateway } from "../coordinator/swarm-command-gateway.js";
import { ProgrammaticWorkerCreation } from "../coordinator/programmatic-worker-creation.js";
import type { TurnControlPort } from "../domain/ports/turn-control.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { createBindingSessionRuntime } from "./create-binding-session-runtime.js";
import type { createInfrastructureRuntime } from "./create-infrastructure-runtime.js";
import type { createOutboundRuntime } from "./create-outbound-runtime.js";
import type { createPrimaryRuntime } from "./create-primary-runtime.js";
import type { createWorkerRuntime } from "./create-worker-runtime.js";
import type { ApplicationPresentation, PanePresentation } from "../domain/ports/presentation.js";
import { WorkerSessionThreadWorkflow } from "../coordinator/worker-session-thread-workflow.js";
import type { PaneControlStore } from "../domain/ports/pane-operations.js";
import type { CommandIntentWorkflowStore } from "../domain/ports/swarm-command.js";
import type { CardInteractionStore, InboundRoutingStore, ModelSelectionStore, SessionOperationStore } from "../domain/ports/workflow.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { WorkerSessionThreadApplicationStore } from "../domain/ports/worker-session-thread.js";

export interface CommandControlStores {
  modelSelection: ModelSelectionStore; paneControl: PaneControlStore; sessionOperations: SessionOperationStore; cardInteraction: CardInteractionStore;
  inboundRouting: InboundRoutingStore; commandIntents: CommandIntentWorkflowStore; instance: InstanceStore; workerSessionThreads: WorkerSessionThreadApplicationStore;
}

export function createCommandControlRuntime(options: {
  config: BridgeConfig; stores: CommandControlStores; logger: Logger; turnControl: TurnControlPort; scheduler: PromptWorkScheduler;
  infrastructure: ReturnType<typeof createInfrastructureRuntime>; delivery: ReturnType<typeof createOutboundRuntime>;
  primary: ReturnType<typeof createPrimaryRuntime>; worker: ReturnType<typeof createWorkerRuntime>;
  bindingSession: ReturnType<typeof createBindingSessionRuntime>; presentation: { application: ApplicationPresentation; pane: PanePresentation };
  onWork?(name: string, listener: (hint: import("../events/runtime-event-bus.js").RuntimeWorkHint) => void | Promise<void>): () => void;
  wakeSwarmCommand?(intentId: string): void;
}) {
  const { config, stores, logger, turnControl, scheduler, infrastructure, delivery, primary, worker, bindingSession, presentation } = options;
  const { traexControl, agentDrivers } = infrastructure; const { outbound, outboundWork, mainCards } = delivery; const { promptRun, primaryState } = primary;
  const { provisioning, operationsQuery, sessionAdministration, deliveryRecovery, paneClosure } = bindingSession;
  const modelSelection = new ModelSelectionWorkflow({ config, store: stores.modelSelection, traexControl, outbound, outboundWork, scheduler, mainCards, activeTurn: (bindingId) => primaryState.activeTurn(bindingId), presentation: presentation.application, logger });
  const paneControl = new PaneControlWorkflow({ store: stores.paneControl, outbound, presentation: presentation.pane, scheduler, model: modelSelection, turnControl, activeTurn: (bindingId) => primaryState.activeTurn(bindingId) });
  const sessionOperations = new SessionOperationWorkflow({ store: stores.sessionOperations, sessionAdministration, provisioning, paneControl, paneClosure, logger });
  const cardInteractions = new CardInteractionWorkflow({ store: stores.cardInteraction, adminOpenIds: config.lark.adminOpenIds, sessionAdministration, sessionOperations, wakePrompt: (bindingId) => scheduler.wake({ kind: "prompt-ready", bindingId }), presentation: presentation.application, logger });
  const commandResolver = new SwarmCommandContextResolver({ config, store: stores.inboundRouting, activeTurn: (bindingId) => primaryState.activeTurn(bindingId) });
  const commandWake = options.wakeSwarmCommand ? { wakeCommand: options.wakeSwarmCommand } : {};
  const swarmCommands = new SwarmCommandGateway({ store: stores.commandIntents, primaryPrompts: stores.instance, resolver: commandResolver, outbound, logger, provisioning, modelSelection, paneControl, operationsQuery, sessionAdministration, paneClosure, promptRun, instanceControl: worker.instanceControl, wakeCardContext: () => outboundWork.wake(), wakeOutbound: () => outboundWork.wake(), ...commandWake, presentation: presentation.application });
  options.onWork?.("swarm-command-dispatcher", (hint) => { if (hint.kind === "swarm-command-ready") swarmCommands.wakeAcceptedIntent({ id: hint.intentId }); });
  const programmaticWorkerCreation = new ProgrammaticWorkerCreation(swarmCommands, config.commandTimeoutMs);
  const workerSessionThreads = new WorkerSessionThreadWorkflow({ adminOpenIds: config.lark.adminOpenIds, store: stores.workerSessionThreads, messaging: worker.instanceMessaging, outbound, wakeOutbound: () => outboundWork.wake(), gatewayEffects: infrastructure.gatewayEffects, presentation: presentation.application });
  const instanceInteractions = new InstanceInteractionWorkflow({ projects: config.projects, adminOpenIds: config.lark.adminOpenIds, store: stores.instance, control: worker.instanceControl, messaging: worker.instanceMessaging, drivers: agentDrivers, outbound, wakeOutbound: () => outboundWork.wake(), workerCreation: programmaticWorkerCreation, presentation: presentation.application, workerSessionThreads });
  return { modelSelection, paneControl, sessionOperations, cardInteractions, swarmCommands, programmaticWorkerCreation, instanceInteractions, workerSessionThreads, deliveryRecovery };
}
