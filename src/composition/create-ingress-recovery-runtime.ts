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

export type IngressRecoveryStores = Pick<SqliteStoreBundle, "inboundDispatch" | "inboundMessages" | "inboundRouting" | "startupRecovery" | "startupViews" | "answerPages" | "mainCards">;

export function createIngressRecoveryRuntime(options: {
  config: BridgeConfig; stores: IngressRecoveryStores; logger: Logger; bus: LifecycleEventPublisher; scheduler: PromptWorkScheduler; inboundWork: InboundWorkNotifier;
  infrastructure: ReturnType<typeof createInfrastructureRuntime>; delivery: ReturnType<typeof createOutboundRuntime>; primary: ReturnType<typeof createPrimaryRuntime>;
  bindingSession: ReturnType<typeof createBindingSessionRuntime>; commandControl: ReturnType<typeof createCommandControlRuntime>;
  presentation: { application: ApplicationPresentation; primary: PrimaryPresentation };
}) {
  const { config, stores, logger, bus, scheduler, inboundWork, infrastructure, delivery, primary, bindingSession, commandControl, presentation } = options;
  const { herdr, lark } = infrastructure; const { outbound, outboundWork, answerPages, mainCards } = delivery; const { promptRun } = primary;
  const { provisioning, paneClosure, reconciler, retiredPaneCleanup } = bindingSession;
  const { paneControl, sessionOperations, cardInteractions, swarmCommands, instanceInteractions, modelSelection } = commandControl;
  const startupViews = new StartupViewConverger({
    config,
    stores: { startupViews: stores.startupViews, answerPages: stores.answerPages, mainCards: stores.mainCards },
    outbound, outboundWork, presentation: presentation.primary,
    answerPageWorkflow: answerPages, mainCardWorkflow: mainCards, logger
  });
  const inboundDispatcher = new InboundMessageDispatcher({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, store: stores.inboundDispatch, inboundWork, logger });
  const messageRouting = new InboundMessageRoutingWorkflow({ config, store: stores.inboundMessages, lifecycleEvents: bus, outbound, outboundWork, logger, scheduler, presentation: presentation.primary, promptRun, provisioning, swarmCommands, instanceInteractions });
  const cardActionRouter = new CardActionRouter({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, adminOpenIds: config.lark.adminOpenIds, projects: config.projects, store: stores.inboundRouting, provisioning, cardInteractions, modelSelection, deliveryRecovery: bindingSession.deliveryRecovery, instanceInteractions, logger, enqueueInitialPrompt: (binding, selection) => messageRouting.enqueueInitialProjectPrompt(binding, selection) });
  const startupRecovery = new StartupRecoveryWorkflow({ config, store: stores.startupRecovery, herdr, lark, logger, scheduler, inboundWork, inboundDispatcher, cardActionRouter, messageRouting, promptRun, provisioning, paneControl, paneClosure, sessionOperations, swarmCommands, reconciler, retiredPaneCleanup, startupViews });
  const coordinator = new InboundRouter({ lark, promptRun, reconciler, retiredPaneCleanup, sessionOperations, swarmCommands, inboundDispatcher, cardActionRouter, startupRecovery });
  return { coordinator };
}
