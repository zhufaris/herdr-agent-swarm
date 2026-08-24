import pino from "pino";
import { fileURLToPath } from "node:url";
import { HerdrCliAdapter } from "./adapters/herdr-adapter.js";
import { LarkSdkAdapter } from "./adapters/lark-adapter.js";
import { loadConfig, validateProjectDirectories } from "./config.js";
import { InboundRouter } from "./coordinator/inbound-router.js";
import { BindingProvisioningWorkflow } from "./coordinator/binding-provisioning-workflow.js";
import { HerdrRuntimeReconciler } from "./coordinator/herdr-runtime-reconciler.js";
import { OperationsWorkflow } from "./coordinator/operations-workflow.js";
import { PromptRunWorkflow } from "./coordinator/prompt-run-workflow.js";
import { StartupViewConverger } from "./coordinator/startup-view-converger.js";
import { BridgeEventBus } from "./events/bridge-event-bus.js";
import { InProcessPromptWorkScheduler } from "./events/prompt-work-scheduler.js";
import { InProcessInboundWorkNotifier } from "./events/inbound-work-notifier.js";
import { ConversationViewProjector } from "./events/conversation-view-projector.js";
import { LarkOutboxDispatcher } from "./events/lark-outbox-dispatcher.js";
import { startHealthServer } from "./health/server.js";
import { ExecFileCommandRunner } from "./infra/command-runner.js";
import { BridgeRuntimeShutdown } from "./runtime/shutdown.js";
import { InstanceLeaseController } from "./runtime/instance-lease.js";
import { WorkspaceSnapshotCache } from "./runtime/workspace-snapshot-cache.js";
import { loadBuildIdentity } from "./runtime/build-identity.js";
import { HerdrEventInbox } from "./runtime/herdr-event-inbox.js";
import { safeLogError } from "./runtime/safe-error.js";
import { SqliteBindingStore } from "./store/sqlite-store.js";

const buildIdentity = loadBuildIdentity(fileURLToPath(new URL("./build-info.json", import.meta.url)), process.env.BRIDGE_EXPECTED_BUILD_ID);
const config = loadConfig();
validateProjectDirectories(config.projects);
const logger = pino({ level: config.logLevel, serializers: { err: safeLogError }, redact: [
  "lark.appSecret", "appSecret", "*.appSecret", "token", "*.token", "authorization", "*.authorization",
  "cookie", "*.cookie", "password", "*.password", "privateKey", "*.privateKey"
] });
const startupStartedAt = Date.now();
const store = new SqliteBindingStore(config.databasePath);
const lease = new InstanceLeaseController(store, config.instanceLease, logger);
const runner = new ExecFileCommandRunner(config.commandTimeoutMs);
const rawHerdr = new HerdrCliAdapter(runner, config.herdr.executable, config.commandTimeoutMs, config.traex.permissionMode);
const herdr = new WorkspaceSnapshotCache(rawHerdr, 2_000, logger);
const lark = new LarkSdkAdapter(config.lark, logger);
const bus = new BridgeEventBus();
const scheduler = new InProcessPromptWorkScheduler(logger);
const inboundWork = new InProcessInboundWorkNotifier();
const channelPublisher = new LarkOutboxDispatcher(store, lark, logger);
const projector = new ConversationViewProjector(bus, store, channelPublisher, logger);
channelPublisher.connectPromptScheduler(scheduler);
const promptRun = new PromptRunWorkflow({ store, herdr, bus, scheduler, channelPublisher, logger, turnTimeoutMs: config.turnTimeoutMs });
const provisioning = new BindingProvisioningWorkflow({ config, store, herdr, lark, lifecycleEvents: bus, outbound: channelPublisher, scheduler, logger });
const operations = new OperationsWorkflow({ config, store, herdr, lark, lifecycleEvents: bus, outbound: channelPublisher, scheduler, isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId), logger });
const reconciler = new HerdrRuntimeReconciler({
  projects: config.projects, store, herdr, lifecycleEvents: bus, channelPublisher, logger,
  discoverPane: (pane, project) => provisioning.discover(pane, project), scheduler,
  isBindingBusy: (bindingId) => promptRun.isBindingBusy(bindingId)
});
const startupViews = new StartupViewConverger(config, store, channelPublisher);
const coordinator = new InboundRouter({ config, store, herdr, lark, lifecycleEvents: bus, outbound: channelPublisher, logger, scheduler, inboundWork, promptRun, provisioning, operations, reconciler, startupViews });
let runtimeShutdown: BridgeRuntimeShutdown | null = null;
const herdrEventInbox = process.env.HERDR_PLUGIN_ROOT
  ? new HerdrEventInbox(Number(process.env.HERDR_BRIDGE_EVENT_PORT || "18787"), (workspaceIds) => coordinator.reconcileHerdrWorkspaces(workspaceIds), logger)
  : null;

try {
  await herdrEventInbox?.start();
  lease.acquire();
  const writeFence = lease.writeFence();
  store.activateWriteFence(writeFence.ownerId, writeFence.fencingToken);
  const healthServer = await startHealthServer({ ...config.http, store, herdr, lark, projects: config.projects, lease, workspaceCache: herdr, buildIdentity });
  runtimeShutdown = new BridgeRuntimeShutdown({ ...(herdrEventInbox ? { herdrEventInbox } : {}), coordinator, projector, publisher: channelPublisher, healthServer, lease, store, logger });
  const shutdown = runtimeShutdown;
  lease.start(() => shutdown.shutdown("lease-lost").then(() => { process.exitCode = 1; }));
  channelPublisher.start();
  projector.start();
  process.once("SIGINT", () => void shutdown.shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown.shutdown("SIGTERM"));
  logger.info({ event: "bridge-startup-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], databasePath: config.databasePath, http: config.http, logLevel: config.logLevel }, "bridge startup started");
  await coordinator.start();
  herdrEventInbox?.activate();
  logger.info({ event: "bridge-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], http: config.http, durationMs: Date.now() - startupStartedAt, outcome: "ready" }, "bridge started");
} catch (error) {
  logger.fatal({ event: "bridge-startup-failed", err: safeLogError(error), durationMs: Date.now() - startupStartedAt, outcome: "failed" }, "bridge failed to start");
  if (runtimeShutdown) await runtimeShutdown.shutdown("startup-failure");
  else { await herdrEventInbox?.stop(); lease.release(); store.close(); }
  process.exitCode = 1;
}
