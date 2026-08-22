import pino from "pino";
import { HerdrCliAdapter } from "./adapters/herdr-adapter.js";
import { LarkSdkAdapter } from "./adapters/lark-adapter.js";
import { loadConfig, validateProjectDirectories } from "./config.js";
import { SyncCoordinator } from "./coordinator/sync-coordinator.js";
import { BridgeEventBus } from "./events/bridge-event-bus.js";
import { CardProjector } from "./events/card-projector.js";
import { LarkChannelPublisher } from "./events/lark-channel-publisher.js";
import { startHealthServer } from "./health/server.js";
import { ExecFileCommandRunner } from "./infra/command-runner.js";
import { BridgeRuntimeShutdown } from "./runtime/shutdown.js";
import { InstanceLeaseController } from "./runtime/instance-lease.js";
import { WorkspaceSnapshotCache } from "./runtime/workspace-snapshot-cache.js";
import { safeLogError } from "./runtime/safe-error.js";
import { SqliteBindingStore } from "./store/sqlite-store.js";

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
const rawHerdr = new HerdrCliAdapter(runner, config.herdr.executable, config.commandTimeoutMs);
const herdr = new WorkspaceSnapshotCache(rawHerdr, 2_000, logger);
const lark = new LarkSdkAdapter(config.lark, logger);
const bus = new BridgeEventBus();
const channelPublisher = new LarkChannelPublisher(bus, store, lark, logger);
const projector = new CardProjector(bus, store, channelPublisher, logger);
const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, channelPublisher, logger);
let runtimeShutdown: BridgeRuntimeShutdown | null = null;

try {
  lease.acquire();
  const healthServer = await startHealthServer({ ...config.http, store, herdr, lark, projects: config.projects, lease, workspaceCache: herdr });
  runtimeShutdown = new BridgeRuntimeShutdown({ coordinator, projector, publisher: channelPublisher, healthServer, lease, store, logger });
  const shutdown = runtimeShutdown;
  lease.start(() => shutdown.shutdown("lease-lost").then(() => { process.exitCode = 1; }));
  channelPublisher.start();
  projector.start();
  process.once("SIGINT", () => void shutdown.shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown.shutdown("SIGTERM"));
  logger.info({ event: "bridge-startup-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], databasePath: config.databasePath, http: config.http, logLevel: config.logLevel }, "bridge startup started");
  await coordinator.start();
  logger.info({ event: "bridge-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], http: config.http, durationMs: Date.now() - startupStartedAt, outcome: "ready" }, "bridge started");
} catch (error) {
  logger.fatal({ event: "bridge-startup-failed", err: safeLogError(error), durationMs: Date.now() - startupStartedAt, outcome: "failed" }, "bridge failed to start");
  if (runtimeShutdown) await runtimeShutdown.shutdown("startup-failure");
  else { lease.release(); store.close(); }
  process.exitCode = 1;
}
