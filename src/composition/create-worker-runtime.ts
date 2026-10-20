import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import type { InstanceLifecycleStore, InstanceStore, InstanceTurnStore } from "../domain/ports/instance.js";
import { InstanceControlWorkflow } from "../coordinator/instance-control-workflow.js";
import { InstanceMessagingWorkflow } from "../coordinator/instance-messaging-workflow.js";
import { WorkerCardDisplayWorkflow } from "../coordinator/worker-card-display-workflow.js";
import { InstanceRuntimeReconciler } from "../coordinator/instance-runtime-reconciler.js";
import { InstanceTurnSupervisor } from "../coordinator/instance-turn-supervisor.js";
import type { TurnControlPort } from "../domain/ports/turn-control.js";
import { WorkerTurnObserver } from "../coordinator/worker-turn-observer.js";
import { WorkerTurnDispatcher } from "../coordinator/worker-turn-dispatcher.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { PrimaryToolGateway } from "../runtime/primary-tool-gateway.js";
import type { WorktreePort } from "../domain/ports/worktree.js";
import type { AgentDriverCatalog } from "../domain/agent-runtime.js";
import type { PaneHost } from "../domain/ports/pane-host.js";
import type { AgentTranscriptReaderPort } from "../domain/ports/external.js";
import { RuntimeLink } from "./runtime-link.js";
import { feishuGatewayWorkerPresentation } from "../gateways/feishu/presentation.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { WorkerCardDisplayStore } from "../domain/ports/worker-card-display.js";
import type { WorkerTurnCardConvergencePort } from "../domain/ports/card-convergence.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { RuntimeObservationPort } from "../domain/ports/runtime-observation.js";
import type { OperationsQueryStore } from "../domain/ports/workflow.js";
import { PrimaryTopologyQueryWorkflow } from "../coordinator/primary-topology-query-workflow.js";
import { PaneTopologyReconciler } from "../coordinator/pane-topology-reconciler.js";
import type { PaneTopologyIntentStore } from "../domain/ports/pane-topology.js";

export interface WorkerRuntimeStores {
  instance: InstanceStore; instanceExecution: InstanceLifecycleStore & InstanceTurnStore; workerCardDisplay: WorkerCardDisplayStore;
  topology: Pick<OperationsQueryStore, "listBindings"> & Pick<InstanceStore, "listAgentInstances">;
  paneTopology: PaneTopologyIntentStore;
}

export function createWorkerRuntime(options: {
  config: BridgeConfig; stores: WorkerRuntimeStores; logger: Logger; turnControl: TurnControlPort;
  paneHost: PaneHost; agentDrivers: AgentDriverCatalog; worktrees: WorktreePort;
  herdr: Pick<HerdrPort, "listPanes">;
  transcriptReader: AgentTranscriptReaderPort; outboundWork: OutboundWorkNotifier; applicationPresentation: ApplicationPresentation;
  workerTurnCards: WorkerTurnCardConvergencePort;
}) {
  const { config, stores, logger, turnControl, paneHost, agentDrivers, worktrees, herdr, transcriptReader, outboundWork, workerTurnCards, applicationPresentation } = options;
  const runtimeObservations = isRuntimeObservationPort(herdr) ? herdr : undefined;
  const instanceWorkLink = new RuntimeLink<WorkerTurnDispatcher>("Worker turn dispatcher");
  const executionStore = stores.instanceExecution;
  const convergeWorkerTurn = (turnId: string) => { void workerTurnCards.converge(turnId).catch((error) => logger.warn({ event: "worker-turn-card-convergence-failed", turnId, err: safeLogError(error), outcome: "retry_on_checkpoint_or_recovery" }, "Worker Task Card convergence failed")); };
  const workerTurns = new WorkerTurnObserver({ store: executionStore, transcriptReader, wakeInstance: (instanceId) => instanceWorkLink.get().wake(instanceId), wakeOutbound: () => outboundWork.wake(), convergeWorkerTurn, presentation: feishuGatewayWorkerPresentation, logger, pollIntervalMs: config.runtimeTuning.polling.workerTurnMs });
  const instanceWork = new WorkerTurnDispatcher({ store: executionStore, drivers: agentDrivers, observer: workerTurns, wakeOutbound: () => outboundWork.wake(), convergeWorkerTurn, presentation: feishuGatewayWorkerPresentation, logger });
  instanceWorkLink.connect(instanceWork);
  const instanceTurns = new InstanceTurnSupervisor({ store: executionStore, paneHost, observer: workerTurns, wake: (instanceId) => instanceWork.wake(instanceId), wakeOutbound: () => outboundWork.wake(), convergeWorkerTurn, presentation: feishuGatewayWorkerPresentation, logger });
  const paneTopology = new PaneTopologyReconciler({ intents: stores.paneTopology, instances: stores.instance, bindings: stores.topology, paneHost, logger });
  const instanceRuntime = new InstanceRuntimeReconciler({ projects: config.projects, store: executionStore, paneHost, ...(runtimeObservations ? { runtimeObservations } : {}), topology: paneTopology, wake: (instanceId) => instanceWork.wake(instanceId), wakeCardContext: () => outboundWork.wake(), logger });
  const instanceMessaging = new InstanceMessagingWorkflow({ store: stores.instance, turnControl, wake: (instanceId) => instanceWork.wake(instanceId), wakeOutbound: () => outboundWork.wake(), convergeWorkerTurn, idFactory: randomUUID, presentation: feishuGatewayWorkerPresentation, maxQueueDepth: config.maxQueueDepth });
  const workerCardDisplay = new WorkerCardDisplayWorkflow(stores.workerCardDisplay, () => outboundWork.wake(), applicationPresentation);
  const topology = new PrimaryTopologyQueryWorkflow({ projects: config.projects, store: stores.topology, herdr });
  const primaryToolGateway = new PrimaryToolGateway(join(dirname(config.databasePath), "primary-tools.sock"), process.execPath, [fileURLToPath(new URL("../cli/primary-tools-mcp.js", import.meta.url))], stores.instance, instanceMessaging, logger, [], {}, workerCardDisplay, topology);
  const instanceControl = new InstanceControlWorkflow({ projects: config.projects, store: stores.instance, paneHost, drivers: agentDrivers, worktrees, idFactory: randomUUID });
  const instanceWorker = {
    snapshot() {
      const dispatch = instanceWork.snapshot();
      const observe = instanceTurns.snapshot();
      return {
        state: dispatch.state,
        activeDispatchWorkers: dispatch.activeDispatchWorkers,
        activeObservers: observe.activeObservers,
        queuedTurns: observe.queuedTurns,
        activeTurns: observe.activeTurns,
        uncertainTurns: observe.uncertainTurns,
        lastScanAt: observe.lastScanAt,
        lastFailureAt: dispatch.lastFailureAt ?? observe.lastFailureAt,
        lastFailure: dispatch.lastFailure ?? observe.lastFailure
      };
    }
  };
  return { workerTurns, instanceWork, instanceTurns, instanceRuntime, instanceMessaging, primaryToolGateway, instanceControl, instanceWorker };
}

function isRuntimeObservationPort(value: Pick<HerdrPort, "listPanes">): value is Pick<HerdrPort, "listPanes"> & RuntimeObservationPort {
  const candidate = value as Partial<RuntimeObservationPort>;
  return typeof candidate.readSemanticSnapshot === "function" && typeof candidate.canAcknowledgeSemanticGeneration === "function";
}
