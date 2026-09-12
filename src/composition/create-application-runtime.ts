import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { cardKitPanePresentation } from "../cards/cardkit-pane-presentation.js";
import { cardKitPrimaryPresentation } from "../cards/cardkit-primary-presentation.js";
import { cardKitApplicationPresentation } from "../cards/cardkit-application-presentation.js";
import type { TurnControlWorkflow } from "../coordinator/turn-control-workflow.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import type { SqliteStoreBundle } from "../store/sqlite-store-bundle.js";
import type { createInfrastructureRuntime } from "./create-infrastructure-runtime.js";
import type { createOutboundRuntime } from "./create-outbound-runtime.js";
import type { createPrimaryRuntime } from "./create-primary-runtime.js";
import type { createWorkerRuntime } from "./create-worker-runtime.js";
import type { ApplicationPresentation, PanePresentation, PrimaryPresentation } from "../domain/ports/presentation.js";
import { createBindingSessionRuntime } from "./create-binding-session-runtime.js";
import { createCommandControlRuntime } from "./create-command-control-runtime.js";
import { createIngressRecoveryRuntime } from "./create-ingress-recovery-runtime.js";

export type ApplicationRuntimeStores = Pick<SqliteStoreBundle,
  | "retiredPaneCleanup" | "bindingProvisioning" | "modelSelection" | "paneControl"
  | "operationsQuery" | "sessionAdministration" | "deliveryRecovery" | "paneClose"
  | "paneRetention" | "sessionOperations" | "cardInteraction" | "runtimeReconciliation"
  | "inboundRouting" | "commandIntents" | "instance" | "workerSessionThreads"
  | "inboundDispatch" | "inboundMessages" | "startupRecovery" | "startupViews"
  | "answerPages" | "mainCards">;

export function createApplicationRuntime(options: {
  config: BridgeConfig; stores: ApplicationRuntimeStores; logger: Logger; turnControl: TurnControlWorkflow;
  bus: LifecycleEventPublisher; scheduler: PromptWorkScheduler; inboundWork: InboundWorkNotifier;
  infrastructure: ReturnType<typeof createInfrastructureRuntime>; delivery: ReturnType<typeof createOutboundRuntime>;
  primary: ReturnType<typeof createPrimaryRuntime>; worker: ReturnType<typeof createWorkerRuntime>;
  presentation?: { application: ApplicationPresentation; primary: PrimaryPresentation; pane: PanePresentation };
}) {
  const { config, stores, logger, turnControl, bus, scheduler, inboundWork, infrastructure, delivery, primary, worker } = options;
  const presentation = options.presentation ?? { application: cardKitApplicationPresentation, primary: cardKitPrimaryPresentation, pane: cardKitPanePresentation };
  const shared = { config, stores, logger, scheduler, infrastructure, delivery, primary, worker, presentation };
  const bindingSession = createBindingSessionRuntime({ ...shared, bus });
  const commandControl = createCommandControlRuntime({ ...shared, turnControl, bindingSession });
  const ingress = createIngressRecoveryRuntime({ ...shared, bus, inboundWork, bindingSession, commandControl });
  return { coordinator: ingress.coordinator, paneRetention: bindingSession.paneRetention, sessionOperations: commandControl.sessionOperations, reconciler: bindingSession.reconciler, retiredPaneCleanup: bindingSession.retiredPaneCleanup, herdrEventRouter: bindingSession.herdrEventRouter };
}
