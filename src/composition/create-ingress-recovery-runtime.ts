import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { CardActionRouter } from "../coordinator/card-action-router.js";
import { DurableInboundPipeline } from "../coordinator/durable-inbound-pipeline.js";
import { InboundMessageRoutingWorkflow } from "../coordinator/inbound-message-routing-workflow.js";
import { PromptAdmissionWorkflow } from "../coordinator/prompt-admission-workflow.js";
import { InboundRouter } from "../coordinator/inbound-router.js";
import { StartupRecoveryWorkflow } from "../coordinator/startup-recovery-workflow.js";
import { StartupViewConverger } from "../coordinator/startup-view-converger.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { createBindingSessionRuntime } from "./create-binding-session-runtime.js";
import type { createCommandControlRuntime } from "./create-command-control-runtime.js";
import type { createInfrastructureRuntime } from "./create-infrastructure-runtime.js";
import type { createOutboundRuntime } from "./create-outbound-runtime.js";
import type { createPrimaryRuntime } from "./create-primary-runtime.js";
import type { ApplicationPresentation, PrimaryPresentation } from "../domain/ports/presentation.js";
import { createCompatibilityGatewayIngressSink } from "../gateways/compatibility-ingress.js";
import type { NaturalLanguageCommandInterpreter } from "../domain/natural-language-command.js";
import { NaturalLanguageCommandWorkflow } from "../coordinator/natural-language-command-workflow.js";
import type { PromptAcceptanceStore } from "../domain/ports/prompt.js";
import type { InboundMessageDispatchStore, InboundRoutingStore, StartupRecoveryStore, StartupViewStore } from "../domain/ports/workflow.js";
import type { NaturalLanguageCommandConfirmationStore } from "../domain/ports/natural-language-command-confirmation.js";

export interface IngressRecoveryStores {
  inboundDispatch: InboundMessageDispatchStore; promptAcceptance: PromptAcceptanceStore; inboundRouting: InboundRoutingStore;
  startupRecovery: StartupRecoveryStore; startupViews: StartupViewStore;
  naturalLanguageCommandConfirmations: NaturalLanguageCommandConfirmationStore;
}

export function createIngressRecoveryRuntime(options: {
  config: BridgeConfig; stores: IngressRecoveryStores; logger: Logger; bus: LifecycleEventPublisher; scheduler: PromptWorkScheduler; inboundWork: InboundWorkNotifier;
  infrastructure: ReturnType<typeof createInfrastructureRuntime>; delivery: ReturnType<typeof createOutboundRuntime>; primary: ReturnType<typeof createPrimaryRuntime>;
  bindingSession: ReturnType<typeof createBindingSessionRuntime>; commandControl: ReturnType<typeof createCommandControlRuntime>;
  presentation: { application: ApplicationPresentation; primary: PrimaryPresentation };
  naturalLanguageCommands: NaturalLanguageCommandInterpreter;
}) {
  const { config, stores, logger, bus, scheduler, inboundWork, infrastructure, delivery, primary, bindingSession, commandControl, presentation } = options;
  const { herdr, gateway } = infrastructure; const { outbound, outboundWork, answerPages, mainCards } = delivery; const { promptRun, primaryState } = primary;
  const { provisioning, paneClosure, reconciler, retiredPaneCleanup } = bindingSession;
  const { paneControl, sessionOperations, cardInteractions, swarmCommands, instanceInteractions, workerSessionThreads, modelSelection } = commandControl;
  const startupViews = new StartupViewConverger({
    config,
    stores: { startupViews: stores.startupViews },
    outbound, outboundWork, presentation: presentation.primary, answerPages, mainCards, logger
  });
  const naturalLanguageWorkflow = new NaturalLanguageCommandWorkflow({ store: stores.naturalLanguageCommandConfirmations, outbound, outboundWork, presentation: presentation.application, swarmCommands, instanceInteractions });
  const promptAdmission = new PromptAdmissionWorkflow({ config, store: stores.promptAcceptance, routing: stores.inboundRouting, primaryState, lifecycleEvents: bus, outbound, outboundWork, scheduler, presentation: presentation.primary });
  const messageRouting = new InboundMessageRoutingWorkflow({ config, routing: stores.inboundRouting, promptAdmission, outbound, logger, presentation: presentation.primary, provisioning, swarmCommands, instanceInteractions, workerSessionThreads, naturalLanguage: { interpreter: options.naturalLanguageCommands, workflow: naturalLanguageWorkflow } });
  const inboundPipeline = new DurableInboundPipeline({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, store: stores.inboundDispatch, router: messageRouting, inboundWork, logger });
  const cardActionRouter = new CardActionRouter({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, adminOpenIds: config.lark.adminOpenIds, projects: config.projects, store: stores.inboundRouting, provisioning, cardInteractions, modelSelection, deliveryRecovery: bindingSession.deliveryRecovery, instanceInteractions, naturalLanguageCommands: naturalLanguageWorkflow, logger, enqueueInitialPrompt: async (binding, selection) => { await promptAdmission.acceptInitial(binding, selection); } });
  const gatewaySink = createCompatibilityGatewayIngressSink({ receiveMessage: (message) => inboundPipeline.receive(message), handleAction: (action) => cardActionRouter.handle(action) });
  const startupRecovery = new StartupRecoveryWorkflow({ config, store: stores.startupRecovery, herdr, gatewayIngress: gateway.ingress, gatewaySink, logger, scheduler, inboundPipeline, cardActionRouter, promptAdmission, promptRun, provisioning, paneControl, paneClosure, sessionOperations, swarmCommands, reconciler, retiredPaneCleanup, startupViews });
  const coordinator = new InboundRouter({ gatewayIngress: gateway.ingress, promptRun, reconciler, retiredPaneCleanup, sessionOperations, swarmCommands, inboundPipeline, cardActionRouter, startupRecovery });
  return { coordinator };
}
