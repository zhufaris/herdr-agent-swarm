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
import { SqliteBindingStore } from "./store/sqlite-store.js";

const config = loadConfig();
validateProjectDirectories(config.projects);
const logger = pino({ level: config.logLevel, redact: [
  "lark.appSecret", "appSecret", "*.appSecret", "token", "*.token", "authorization", "*.authorization",
  "cookie", "*.cookie", "password", "*.password", "privateKey", "*.privateKey"
] });
const startupStartedAt = Date.now();
const store = new SqliteBindingStore(config.databasePath);
const runner = new ExecFileCommandRunner(config.commandTimeoutMs);
const herdr = new HerdrCliAdapter(runner, config.herdr.executable, config.commandTimeoutMs);
const lark = new LarkSdkAdapter(config.lark, logger);
const bus = new BridgeEventBus();
const channelPublisher = new LarkChannelPublisher(bus, store, lark, logger);
channelPublisher.start();
const projector = new CardProjector(bus, store, channelPublisher, logger);
projector.start();
const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, channelPublisher, logger);
const healthServer = await startHealthServer({ ...config.http, store, herdr, lark, projects: config.projects });
const runtimeShutdown = new BridgeRuntimeShutdown({ coordinator, projector, publisher: channelPublisher, healthServer, store, logger });

process.once("SIGINT", () => void runtimeShutdown.shutdown("SIGINT"));
process.once("SIGTERM", () => void runtimeShutdown.shutdown("SIGTERM"));

try {
  logger.info({ event: "bridge-startup-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], databasePath: config.databasePath, http: config.http, logLevel: config.logLevel }, "bridge startup started");
  await coordinator.start();
  logger.info({ event: "bridge-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], http: config.http, durationMs: Date.now() - startupStartedAt, outcome: "ready" }, "bridge started");
} catch (error) {
  logger.fatal({ event: "bridge-startup-failed", err: error, durationMs: Date.now() - startupStartedAt, outcome: "failed" }, "bridge failed to start");
  await runtimeShutdown.shutdown("startup-failure");
  process.exitCode = 1;
}
