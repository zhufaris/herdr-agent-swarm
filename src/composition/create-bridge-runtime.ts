import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { TurnControlWorkflow } from "../coordinator/turn-control-workflow.js";
import { BridgeEventBus } from "../events/bridge-event-bus.js";
import { InProcessPromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { InProcessInboundWorkNotifier } from "../events/inbound-work-notifier.js";
import { SqliteIntegrityAuditor } from "../runtime/sqlite-integrity-auditor.js";
import { WorkerDatabaseIntegrityStore } from "../runtime/sqlite-integrity-worker.js";
import type { SqliteBindingStore } from "../store/sqlite-store.js";
import { RuntimeLink } from "./runtime-link.js";
import { WorkWakeupHub } from "./work-wakeup-hub.js";
import { createInfrastructureRuntime } from "./create-infrastructure-runtime.js";
import { createOutboundRuntime } from "./create-outbound-runtime.js";
import { createWorkerRuntime } from "./create-worker-runtime.js";
import { createPrimaryRuntime } from "./create-primary-runtime.js";
import { createApplicationRuntime } from "./create-application-runtime.js";
import type { AgentRuntimeAvailability } from "./create-infrastructure-runtime.js";

export type { AgentRuntimeAvailability } from "./create-infrastructure-runtime.js";
type RuntimeWakeups = { outbound: undefined; primary: string; instance: string };

export function createBridgeRuntime(config: BridgeConfig, store: SqliteBindingStore, logger: Logger, availability: AgentRuntimeAvailability) {
  const herdrEventRouterLink = new RuntimeLink<{ handle(hint: import("../runtime/herdr-event-hint.js").HerdrRuntimeHint): Promise<void> }>("Herdr event router");
  const wakeups = new WorkWakeupHub<RuntimeWakeups>(["outbound", "primary", "instance"]);
  const infrastructure = createInfrastructureRuntime(config, logger, availability, (hint) => herdrEventRouterLink.get().handle(hint));
  const { herdrSocketSubscriber, herdrCircuitBreaker, herdr, paneHost, agentDrivers, worktrees, lark, transcriptReader } = infrastructure;
  const turnControl = new TurnControlWorkflow({ store, herdr, idFactory: randomUUID, wakeOutbound: () => wakeups.wake("outbound", undefined), wakePrimary: (bindingId) => wakeups.wake("primary", bindingId), wakeInstance: (instanceId) => wakeups.wake("instance", instanceId), maxQueueDepth: config.maxQueueDepth });
  const bus = new BridgeEventBus(logger); const scheduler = new InProcessPromptWorkScheduler(logger); const inboundWork = new InProcessInboundWorkNotifier();
  const delivery = createOutboundRuntime(config, store, lark, bus, logger);
  const { outboundWork, channelPublisher, mainCards, projector, queueFeedbackProjector, cardContextRebuilder, outboxRetention } = delivery;
  wakeups.register("outbound", () => outboundWork.wake()); wakeups.register("primary", (bindingId) => scheduler.wake({ kind: "prompt-ready", bindingId }), (bindingId) => bindingId);
  const worker = createWorkerRuntime({ config, store, logger, turnControl, paneHost, agentDrivers, worktrees, transcriptReader, outboundWork });
  const { instanceWork, instanceTurns, instanceRuntime, primaryToolGateway } = worker;
  wakeups.register("instance", (instanceId) => instanceWork.wake(instanceId), (instanceId) => instanceId);
  const sqliteIntegrity = new SqliteIntegrityAuditor(new WorkerDatabaseIntegrityStore(config.databasePath), config.sqliteIntegrityAudit, logger);
  channelPublisher.connectPromptScheduler(scheduler);
  const primary = createPrimaryRuntime({ config, store, logger, herdr, bus, scheduler, outboundWork, transcriptReader, mainCards });
  const { externalTurns, promptRun } = primary;
  const { coordinator, paneRetention, sessionOperations, reconciler, herdrEventRouter } = createApplicationRuntime({ config, store, logger, turnControl, bus, scheduler, inboundWork, infrastructure, delivery, primary, worker });
  herdrEventRouterLink.connect(herdrEventRouter);
  wakeups.seal();
  const instanceWorker = { snapshot() { const dispatch = instanceWork.snapshot(); const observe = instanceTurns.snapshot(); return { state: dispatch.state, activeDispatchWorkers: dispatch.activeDispatchWorkers, activeObservers: observe.activeObservers, queuedTurns: observe.queuedTurns, activeTurns: observe.activeTurns, uncertainTurns: observe.uncertainTurns, lastScanAt: observe.lastScanAt, lastFailureAt: dispatch.lastFailureAt ?? observe.lastFailureAt, lastFailure: dispatch.lastFailure ?? observe.lastFailure }; } };
  return { herdr, herdrCircuitBreaker, herdrSocketSubscriber, instanceRuntime, instanceTurns, instanceWork, primaryToolGateway, sqliteIntegrity, coordinator, queueFeedbackProjector, cardContextRebuilder, projector, channelPublisher, outboxRetention, paneRetention, externalTurns, instanceWorker, lark, bus, sessionOperations, reconciler, promptRun };
}
