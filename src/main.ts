import pino from "pino";
import { HerdrCliAdapter } from "./adapters/herdr-adapter.js";
import { LarkSdkAdapter } from "./adapters/lark-adapter.js";
import { loadConfig } from "./config.js";
import { SyncCoordinator } from "./coordinator/sync-coordinator.js";
import { BridgeEventBus } from "./events/bridge-event-bus.js";
import { CardProjector } from "./events/card-projector.js";
import { startHealthServer } from "./health/server.js";
import { ExecFileCommandRunner } from "./infra/command-runner.js";
import { SqliteBindingStore } from "./store/sqlite-store.js";

const config = loadConfig();
const logger = pino({ level: config.logLevel, redact: ["lark.appSecret", "appSecret", "*.appSecret"] });
const store = new SqliteBindingStore(config.databasePath);
const runner = new ExecFileCommandRunner(config.commandTimeoutMs);
const herdr = new HerdrCliAdapter(runner, config.herdr.executable, config.commandTimeoutMs);
const lark = new LarkSdkAdapter(config.lark);
const bus = new BridgeEventBus();
const projector = new CardProjector(bus, store, lark, logger);
const stopProjector = projector.start();
const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, logger);
const healthServer = await startHealthServer({ ...config.http, store, herdr, lark, workspaceId: config.herdr.workspaceId });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "shutting down");
  stopProjector();
  healthServer.close();
  await coordinator.stop();
  store.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await coordinator.start();
  logger.info({ workspaceId: config.herdr.workspaceId, chatId: config.lark.chatId, http: config.http }, "bridge started");
} catch (error) {
  logger.fatal({ err: error }, "bridge failed to start");
  await shutdown("startup-failure");
  process.exitCode = 1;
}
