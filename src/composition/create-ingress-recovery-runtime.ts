import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { CardActionRouter } from "../coordinator/card-action-router.js";
import { InboundMessageDispatcher } from "../coordinator/inbound-message-dispatcher.js";
import { InboundMessageRoutingWorkflow } from "../coordinator/inbound-message-routing-workflow.js";
import { InboundRouter } from "../coordinator/inbound-router.js";
import { StartupRecoveryWorkflow } from "../coordinator/startup-recovery-workflow.js";
import { StartupViewConverger } from "../coordinator/startup-view-converger.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { SqliteStoreBundle } from "../store/sqlite-store-bundle.js";
import type { createBindingSessionRuntime } from "./create-binding-session-runtime.js";
import type { createCommandControlRuntime } from "./create-command-control-runtime.js";
import type { createInfrastructureRuntime } from "./create-infrastructure-runtime.js";
import type { createOutboundRuntime } from "./create-outbound-runtime.js";
import type { createPrimaryRuntime } from "./create-primary-runtime.js";
import type { ApplicationPresentation, PrimaryPresentation } from "../domain/ports/presentation.js";
import { createCompatibilityGatewayIngressSink } from "../gateways/compatibility-ingress.js";
import type { NaturalLanguageCommandInterpreter } from "../domain/natural-language-command.js";
import { NaturalLanguageCommandWorkflow } from "../coordinator/natural-language-command-workflow.js";

export type IngressRecoveryStores = Pick<SqliteStoreBundle, "inboundDispatch" | "promptAcceptance" | "inboundRouting" | "startupRecovery" | "startupViews" | "answerPages" | "mainCards" | "naturalLanguageCommandConfirmations">;

export function createIngressRecoveryRuntime(options: {
  config: BridgeConfig; stores: IngressRecoveryStores; logger: Logger; bus: LifecycleEventPublisher; scheduler: PromptWorkScheduler; inboundWork: InboundWorkNotifier;
  infrastructure: ReturnType<typeof createInfrastructureRuntime>; delivery: ReturnType<typeof createOutboundRuntime>; primary: ReturnType<typeof createPrimaryRuntime>;
  bindingSession: ReturnType<typeof createBindingSessionRuntime>; commandControl: ReturnType<typeof createCommandControlRuntime>;
  presentation: { application: ApplicationPresentation; primary: PrimaryPresentation };
  naturalLanguageCommands: NaturalLanguageCommandInterpreter;
}) {
  const { config, stores, logger, bus, scheduler, inboundWork, infrastructure, delivery, primary, bindingSession, commandControl, presentation } = options;
  const { herdr, gateway } = infrastructure; const { outbound, outboundWork } = delivery; const { promptRun } = primary;
  const { provisioning, paneClosure, reconciler, retiredPaneCleanup } = bindingSession;
  const { paneControl, sessionOperations, cardInteractions, swarmCommands, instanceInteractions, workerSessionThreads, modelSelection } = commandControl;
  const startupViews = new StartupViewConverger({
    config,
    stores: { startupViews: stores.startupViews, answerPages: stores.answerPages, mainCards: stores.mainCards },
    outbound, outboundWork, presentation: presentation.primary, logger
  });
  const inboundDispatcher = new InboundMessageDispatcher({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, store: stores.inboundDispatch, inboundWork, logger });
  const naturalLanguageWorkflow = new NaturalLanguageCommandWorkflow({ store: stores.naturalLanguageCommandConfirmations, outbound, outboundWork, presentation: presentation.application, swarmCommands, instanceInteractions });
  const messageRouting = new InboundMessageRoutingWorkflow({ config, stores: { routing: stores.inboundRouting, promptAcceptance: stores.promptAcceptance }, lifecycleEvents: bus, outbound, outboundWork, logger, scheduler, presentation: presentation.primary, promptRun, provisioning, swarmCommands, instanceInteractions, workerSessionThreads, naturalLanguage: { interpreter: options.naturalLanguageCommands, workflow: naturalLanguageWorkflow } });
  const cardActionRouter = new CardActionRouter({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, adminOpenIds: config.lark.adminOpenIds, projects: config.projects, store: stores.inboundRouting, provisioning, cardInteractions, modelSelection, deliveryRecovery: bindingSession.deliveryRecovery, instanceInteractions, naturalLanguageCommands: naturalLanguageWorkflow, logger, enqueueInitialPrompt: (binding, selection) => messageRouting.enqueueInitialProjectPrompt(binding, selection) });
  const gatewaySink = createCompatibilityGatewayIngressSink({ receiveMessage: (message) => inboundDispatcher.receiveMessage(message), handleAction: (action) => cardActionRouter.handle(action) });
  const startupRecovery = new StartupRecoveryWorkflow({ config, store: stores.startupRecovery, herdr, gatewayIngress: gateway.ingress, gatewaySink, logger, scheduler, inboundWork, inboundDispatcher, cardActionRouter, messageRouting, promptRun, provisioning, paneControl, paneClosure, sessionOperations, swarmCommands, reconciler, retiredPaneCleanup, startupViews });
  const coordinator = new InboundRouter({ gatewayIngress: gateway.ingress, promptRun, reconciler, retiredPaneCleanup, sessionOperations, swarmCommands, inboundDispatcher, cardActionRouter, startupRecovery });
  return { coordinator };
}
