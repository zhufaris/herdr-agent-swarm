import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { CardActionRouter } from "../coordinator/card-action-router.js";
import { DurableInboundPipeline } from "../coordinator/durable-inbound-pipeline.js";
import { InboundMessageRoutingWorkflow } from "../coordinator/inbound-message-routing-workflow.js";
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
import { renderFeishuShortcutPanelView } from "../gateways/feishu/presentation.js";
import type { InboundMessageDispatchStore, InboundRoutingStore, StartupRecoveryStore, StartupViewStore } from "../domain/ports/workflow.js";
import type { NaturalLanguageCommandConfirmationStore } from "../domain/ports/natural-language-command-confirmation.js";
import type { AgentInputWorkflowPort } from "../domain/ports/agent-input.js";
import type { LegacyInputCardRetirementStore } from "../domain/ports/legacy-input-card-retirement.js";
import type { SessionActivityStore } from "../domain/ports/session-activity.js";
import { InitialAgentInputWorkflow } from "../coordinator/initial-agent-input-workflow.js";
import type { DeliveryLatencyTrace } from "../domain/delivery-trace.js";

export interface IngressRecoveryStores {
  deliveryTrace: DeliveryLatencyTrace;
  inboundDispatch: InboundMessageDispatchStore; inboundRouting: InboundRoutingStore;
  startupRecovery: StartupRecoveryStore; startupViews: StartupViewStore;
  sessionActivity: Pick<SessionActivityStore, "recoverRetainedMultiAgentActivity">;
  naturalLanguageCommandConfirmations: NaturalLanguageCommandConfirmationStore;
  shortcutPanel: { reserve(chatId: string, card: object): "reserved" | "current" | "pending" };
  legacyInputCards: LegacyInputCardRetirementStore;
  rolloutGuard: { assertSemanticDeliveryStartupSafe(): void };
}

export function createIngressRecoveryRuntime(options: {
  config: BridgeConfig; stores: IngressRecoveryStores; logger: Logger; bus: LifecycleEventPublisher; scheduler: PromptWorkScheduler; inboundWork: InboundWorkNotifier;
  infrastructure: ReturnType<typeof createInfrastructureRuntime>; delivery: ReturnType<typeof createOutboundRuntime>; primary: ReturnType<typeof createPrimaryRuntime>;
  bindingSession: ReturnType<typeof createBindingSessionRuntime>; commandControl: ReturnType<typeof createCommandControlRuntime>;
  presentation: { application: ApplicationPresentation; primary: PrimaryPresentation };
  naturalLanguageCommands: NaturalLanguageCommandInterpreter;
  agentInput: AgentInputWorkflowPort;
}) {
  const { config, stores, logger, bus, scheduler, inboundWork, infrastructure, delivery, bindingSession, commandControl, presentation, agentInput } = options;
  const { herdr, gateway } = infrastructure; const { outbound, outboundWork, answerPages, mainCards, workerTurnCards } = delivery;
  const { provisioning, orchestratorClear, orchestratorIdentity, paneClosure, reconciler, retiredPaneCleanup } = bindingSession;
  const { paneControl, sessionOperations, cardInteractions, swarmCommands, instanceInteractions, workerSessionThreads, modelSelection } = commandControl;
  const startupViews = new StartupViewConverger({
    config,
    stores: { startupViews: stores.startupViews },
    outbound, outboundWork, presentation: presentation.primary, answerPages, mainCards, workerTurnCards, turnCards: delivery.turnCards, sessionActivity: stores.sessionActivity, rolloutGuard: stores.rolloutGuard, logger
  });
  const naturalLanguageWorkflow = new NaturalLanguageCommandWorkflow({ store: stores.naturalLanguageCommandConfirmations, outbound, outboundWork, presentation: presentation.application, swarmCommands, instanceInteractions });
  const initialAgentInput = new InitialAgentInputWorkflow({ agentInput, outbound, presentation: presentation.primary });
  const messageRouting = new InboundMessageRoutingWorkflow({ config, routing: stores.inboundRouting, agentInput, initialAgentInput, outbound, logger, presentation: presentation.primary, provisioning, swarmCommands, instanceInteractions, workerSessionThreads, naturalLanguage: { interpreter: options.naturalLanguageCommands, workflow: naturalLanguageWorkflow } });
  const inboundPipeline = new DurableInboundPipeline({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, store: stores.inboundDispatch, router: messageRouting, inboundWork, logger, deliveryTrace: stores.deliveryTrace });
  const cardActionRouter = new CardActionRouter({ chatId: config.lark.chatId, allowedOpenIds: config.lark.allowedOpenIds, adminOpenIds: config.lark.adminOpenIds, projects: config.projects, store: stores.inboundRouting, provisioning, cardInteractions, modelSelection, deliveryRecovery: bindingSession.deliveryRecovery, instanceInteractions, naturalLanguageCommands: naturalLanguageWorkflow, swarmCommands, logger, submitInitialAgentInput: (binding, selection) => initialAgentInput.submit(binding, selection) });
  const gatewaySink = createCompatibilityGatewayIngressSink({ receiveMessage: (message) => inboundPipeline.receive(message), handleAction: (action) => cardActionRouter.handle(action) });
  const startupRecovery = new StartupRecoveryWorkflow({ config, store: stores.startupRecovery, herdr, gatewayIngress: gateway.ingress, gatewaySink, logger, scheduler, inboundPipeline, cardActionRouter, initialAgentInput, provisioning, paneControl, paneClosure, sessionOperations, orchestratorClear, orchestratorIdentity, swarmCommands, reconciler, retiredPaneCleanup, startupViews, legacyInputCards: stores.legacyInputCards, shortcutPanel: { ensure: () => stores.shortcutPanel.reserve(config.lark.chatId, renderFeishuShortcutPanelView()) }, wakeOutbound: () => outboundWork.wake() });
  const coordinator = new InboundRouter({ gatewayIngress: gateway.ingress, reconciler, retiredPaneCleanup, sessionOperations, swarmCommands, inboundPipeline, cardActionRouter, startupRecovery });
  return { coordinator };
}
