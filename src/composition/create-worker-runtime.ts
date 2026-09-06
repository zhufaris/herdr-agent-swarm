import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { InstanceControlWorkflow } from "../coordinator/instance-control-workflow.js";
import { InstanceMessagingWorkflow } from "../coordinator/instance-messaging-workflow.js";
import { InstanceRuntimeReconciler } from "../coordinator/instance-runtime-reconciler.js";
import { InstanceTurnSupervisor } from "../coordinator/instance-turn-supervisor.js";
import type { TurnControlWorkflow } from "../coordinator/turn-control-workflow.js";
import { WorkerTurnObserver } from "../coordinator/worker-turn-observer.js";
import { InstanceWorkScheduler } from "../events/instance-work-scheduler.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { PrimaryToolGateway } from "../runtime/primary-tool-gateway.js";
import type { SqliteBindingStore } from "../store/sqlite-store.js";
import type { WorktreeManager } from "../runtime/worktree-manager.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import type { HerdrPaneHost } from "../runtime/herdr/pane-host.js";
import type { TraexTranscriptReader } from "../runtime/traex-transcript.js";
import { RuntimeLink } from "./runtime-link.js";
import { cardKitWorkerPresentation } from "../cards/cardkit-worker-presentation.js";

export function createWorkerRuntime(options: {
  config: BridgeConfig; store: SqliteBindingStore; logger: Logger; turnControl: TurnControlWorkflow;
  paneHost: HerdrPaneHost; agentDrivers: AgentDriverRegistry; worktrees: WorktreeManager;
  transcriptReader: TraexTranscriptReader; outboundWork: OutboundWorkNotifier;
}) {
  const { config, store, logger, turnControl, paneHost, agentDrivers, worktrees, transcriptReader, outboundWork } = options;
  const instanceWorkLink = new RuntimeLink<InstanceWorkScheduler>("instance work scheduler");
  const workerTurns = new WorkerTurnObserver({ store, transcriptReader, wakeInstance: (instanceId) => instanceWorkLink.get().wake(instanceId), wakeOutbound: () => outboundWork.wake(), presentation: cardKitWorkerPresentation });
  const instanceWork = new InstanceWorkScheduler({ store, drivers: agentDrivers, observer: workerTurns, wakeOutbound: () => outboundWork.wake(), presentation: cardKitWorkerPresentation, logger });
  instanceWorkLink.connect(instanceWork);
  const instanceTurns = new InstanceTurnSupervisor({ store, paneHost, observer: workerTurns, wake: (instanceId) => instanceWork.wake(instanceId), wakeOutbound: () => outboundWork.wake(), presentation: cardKitWorkerPresentation, logger });
  const instanceRuntime = new InstanceRuntimeReconciler({ projects: config.projects, store, paneHost, wake: (instanceId) => instanceWork.wake(instanceId), wakeCardContext: () => outboundWork.wake(), logger });
  const instanceMessaging = new InstanceMessagingWorkflow({ store, turnControl, wake: (instanceId) => instanceWork.wake(instanceId), wakeOutbound: () => outboundWork.wake(), idFactory: randomUUID, presentation: cardKitWorkerPresentation, maxQueueDepth: config.maxQueueDepth });
  const primaryToolGateway = new PrimaryToolGateway(join(dirname(config.databasePath), "primary-tools.sock"), process.execPath, [fileURLToPath(new URL("../cli/primary-tools-mcp.js", import.meta.url))], store, instanceMessaging, logger);
  const instanceControl = new InstanceControlWorkflow({ projects: config.projects, store, paneHost, drivers: agentDrivers, worktrees, idFactory: randomUUID });
  return { workerTurns, instanceWork, instanceTurns, instanceRuntime, instanceMessaging, primaryToolGateway, instanceControl };
}
