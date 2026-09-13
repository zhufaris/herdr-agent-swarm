import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import type { InstanceLifecycleStore, InstanceTurnStore } from "../domain/ports/instance.js";
import { InstanceControlWorkflow } from "../coordinator/instance-control-workflow.js";
import { InstanceMessagingWorkflow } from "../coordinator/instance-messaging-workflow.js";
import { WorkerCardDisplayWorkflow } from "../coordinator/worker-card-display-workflow.js";
import { InstanceRuntimeReconciler } from "../coordinator/instance-runtime-reconciler.js";
import { InstanceTurnSupervisor } from "../coordinator/instance-turn-supervisor.js";
import type { TurnControlWorkflow } from "../coordinator/turn-control-workflow.js";
import { WorkerTurnObserver } from "../coordinator/worker-turn-observer.js";
import { InstanceWorkScheduler } from "../events/instance-work-scheduler.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { PrimaryToolGateway } from "../runtime/primary-tool-gateway.js";
import type { SqliteStoreBundle } from "../store/sqlite-store-bundle.js";
import type { WorktreeManager } from "../runtime/worktree-manager.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import type { HerdrPaneHost } from "../runtime/herdr/pane-host.js";
import type { TraexTranscriptReader } from "../runtime/traex-transcript.js";
import { RuntimeLink } from "./runtime-link.js";
import { feishuGatewayWorkerPresentation } from "../gateways/feishu/presentation.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";

export type WorkerRuntimeStores = Pick<SqliteStoreBundle, "instance" | "instanceLifecycle" | "instanceTurns" | "workerCardDisplay">;

export function createWorkerRuntime(options: {
  config: BridgeConfig; stores: WorkerRuntimeStores; logger: Logger; turnControl: TurnControlWorkflow;
  paneHost: HerdrPaneHost; agentDrivers: AgentDriverRegistry; worktrees: WorktreeManager;
  transcriptReader: TraexTranscriptReader; outboundWork: OutboundWorkNotifier; applicationPresentation: ApplicationPresentation;
}) {
  const { config, stores, logger, turnControl, paneHost, agentDrivers, worktrees, transcriptReader, outboundWork, applicationPresentation } = options;
  const instanceWorkLink = new RuntimeLink<InstanceWorkScheduler>("instance work scheduler");
  if (stores.instanceLifecycle !== stores.instanceTurns as unknown) throw new Error("Instance lifecycle and turn capabilities must share one SQLite transaction context");
  const executionStore = stores.instanceLifecycle as InstanceLifecycleStore & InstanceTurnStore;
  const workerTurns = new WorkerTurnObserver({ store: executionStore, transcriptReader, wakeInstance: (instanceId) => instanceWorkLink.get().wake(instanceId), wakeOutbound: () => outboundWork.wake(), presentation: feishuGatewayWorkerPresentation, pollIntervalMs: config.runtimeTuning.polling.workerTurnMs });
  const instanceWork = new InstanceWorkScheduler({ store: executionStore, drivers: agentDrivers, observer: workerTurns, wakeOutbound: () => outboundWork.wake(), presentation: feishuGatewayWorkerPresentation, logger });
  instanceWorkLink.connect(instanceWork);
  const instanceTurns = new InstanceTurnSupervisor({ store: executionStore, paneHost, observer: workerTurns, wake: (instanceId) => instanceWork.wake(instanceId), wakeOutbound: () => outboundWork.wake(), presentation: feishuGatewayWorkerPresentation, logger });
  const instanceRuntime = new InstanceRuntimeReconciler({ projects: config.projects, store: executionStore, paneHost, wake: (instanceId) => instanceWork.wake(instanceId), wakeCardContext: () => outboundWork.wake(), logger });
  const instanceMessaging = new InstanceMessagingWorkflow({ store: stores.instance, turnControl, wake: (instanceId) => instanceWork.wake(instanceId), wakeOutbound: () => outboundWork.wake(), idFactory: randomUUID, presentation: feishuGatewayWorkerPresentation, maxQueueDepth: config.maxQueueDepth });
  const workerCardDisplay = new WorkerCardDisplayWorkflow(stores.workerCardDisplay, () => outboundWork.wake(), applicationPresentation);
  const primaryToolGateway = new PrimaryToolGateway(join(dirname(config.databasePath), "primary-tools.sock"), process.execPath, [fileURLToPath(new URL("../cli/primary-tools-mcp.js", import.meta.url))], stores.instance, instanceMessaging, logger, [], {}, workerCardDisplay);
  const instanceControl = new InstanceControlWorkflow({ projects: config.projects, store: stores.instance, paneHost, drivers: agentDrivers, worktrees, idFactory: randomUUID });
  return { workerTurns, instanceWork, instanceTurns, instanceRuntime, instanceMessaging, primaryToolGateway, instanceControl };
}
