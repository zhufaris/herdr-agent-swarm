import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { feishuGatewayApplicationPresentation, feishuGatewayPanePresentation, feishuGatewayPrimaryPresentation } from "../gateways/feishu/presentation.js";
import type { TurnControlPort } from "../domain/ports/turn-control.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { createInfrastructureRuntime } from "./create-infrastructure-runtime.js";
import type { createOutboundRuntime } from "./create-outbound-runtime.js";
import type { createPrimaryRuntime } from "./create-primary-runtime.js";
import type { createWorkerRuntime } from "./create-worker-runtime.js";
import type { ApplicationPresentation, PanePresentation, PrimaryPresentation } from "../domain/ports/presentation.js";
import { createBindingSessionRuntime, type BindingSessionStores } from "./create-binding-session-runtime.js";
import { createCommandControlRuntime, type CommandControlStores } from "./create-command-control-runtime.js";
import { createIngressRecoveryRuntime, type IngressRecoveryStores } from "./create-ingress-recovery-runtime.js";
import type { NaturalLanguageCommandRuntime } from "../runtime/natural-language-command-runtime.js";

export interface ApplicationRuntimeStores extends BindingSessionStores, CommandControlStores, IngressRecoveryStores {}

export function createApplicationRuntime(options: {
  config: BridgeConfig; stores: ApplicationRuntimeStores; logger: Logger; turnControl: TurnControlPort;
  bus: LifecycleEventPublisher; scheduler: PromptWorkScheduler; inboundWork: InboundWorkNotifier;
  infrastructure: ReturnType<typeof createInfrastructureRuntime>; delivery: ReturnType<typeof createOutboundRuntime>;
  primary: ReturnType<typeof createPrimaryRuntime>; worker: ReturnType<typeof createWorkerRuntime>;
  presentation?: { application: ApplicationPresentation; primary: PrimaryPresentation; pane: PanePresentation };
  naturalLanguageCommands: NaturalLanguageCommandRuntime;
  runtimeEvents?: Pick<import("./runtime-event-integration.js").RuntimeEventIntegration, "onWork" | "wakeSwarmCommand">;
}) {
  const { config, stores, logger, turnControl, bus, scheduler, inboundWork, infrastructure, delivery, primary, worker } = options;
  const presentation = options.presentation ?? { application: feishuGatewayApplicationPresentation, primary: feishuGatewayPrimaryPresentation, pane: feishuGatewayPanePresentation };
  const shared = { config, stores, logger, scheduler, infrastructure, delivery, primary, worker, presentation };
  const bindingSession = createBindingSessionRuntime({ ...shared, bus });
  const runtimeCommandEvents = options.runtimeEvents ? { onWork: options.runtimeEvents.onWork.bind(options.runtimeEvents), wakeSwarmCommand: options.runtimeEvents.wakeSwarmCommand.bind(options.runtimeEvents) } : {};
  const commandControl = createCommandControlRuntime({ ...shared, turnControl, bindingSession, ...runtimeCommandEvents });
  const ingress = createIngressRecoveryRuntime({ ...shared, bus, inboundWork, bindingSession, commandControl, naturalLanguageCommands: options.naturalLanguageCommands });
  return { coordinator: ingress.coordinator, paneRetention: bindingSession.paneRetention, sessionOperations: commandControl.sessionOperations, reconciler: bindingSession.reconciler, retiredPaneCleanup: bindingSession.retiredPaneCleanup, herdrEventRouter: bindingSession.herdrEventRouter, swarmCommands: commandControl.swarmCommands, programmaticWorkerCreation: commandControl.programmaticWorkerCreation };
}
