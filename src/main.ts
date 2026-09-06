import pino from "pino";
import { fileURLToPath } from "node:url";
import { loadConfig, validateProjectDirectories } from "./config.js";
import { startHealthServer } from "./health/server.js";
import { ExecFileCommandRunner } from "./infra/command-runner.js";
import { BridgeRuntimeShutdown, cleanupStartupFailure } from "./runtime/shutdown.js";
import { InstanceLeaseController } from "./runtime/instance-lease.js";
import { loadBuildIdentity } from "./runtime/build-identity.js";
import { detectAgentRuntimeAvailability } from "./runtime/agents/agent-availability.js";
import { safeLogError } from "./runtime/safe-error.js";
import { createSqliteStoreBundle } from "./store/sqlite-store-bundle.js";
import { createBridgeRuntime } from "./composition/create-bridge-runtime.js";

const buildIdentity = loadBuildIdentity(fileURLToPath(new URL("./build-info.json", import.meta.url)), process.env.BRIDGE_EXPECTED_BUILD_ID);
const config = loadConfig();
validateProjectDirectories(config.projects);
const logger = pino({ level: config.logLevel, serializers: { err: safeLogError }, redact: [
  "lark.appSecret", "appSecret", "*.appSecret", "token", "*.token", "authorization", "*.authorization",
  "cookie", "*.cookie", "password", "*.password", "privateKey", "*.privateKey"
] });
const startupStartedAt = Date.now();
const stores = createSqliteStoreBundle(config.databasePath);
const lease = new InstanceLeaseController(stores.lease, config.instanceLease, logger);
const availabilityRunner = new ExecFileCommandRunner(config.commandTimeoutMs);
const [codex, claude, pi] = await Promise.all([
  detectAgentRuntimeAvailability({ runner: availabilityRunner, herdrExecutable: config.herdr.executable, agentExecutable: config.agents.codex, herdrKind: "codex" }),
  detectAgentRuntimeAvailability({ runner: availabilityRunner, herdrExecutable: config.herdr.executable, agentExecutable: config.agents.claudeCode, herdrKind: "claude" }),
  detectAgentRuntimeAvailability({ runner: availabilityRunner, herdrExecutable: config.herdr.executable, agentExecutable: config.agents.pi, herdrKind: "pi" })
]);
const runtime = createBridgeRuntime(config, stores, logger, { codex, claude, pi });
const { herdr, herdrCircuitBreaker, herdrSocketSubscriber, instanceRuntime, instanceTurns, instanceWork, primaryToolGateway, sqliteIntegrity, coordinator, queueFeedbackProjector, cardContextRebuilder, projector, channelPublisher, outboxRetention, paneRetention, externalTurns, instanceWorker, lark, bus, sessionOperations, reconciler, promptRun } = runtime;
let runtimeShutdown: BridgeRuntimeShutdown | null = null;
try {
  lease.acquire();
  const writeFence = lease.writeFence();
  stores.lifecycle.activateWriteFence(writeFence.ownerId, writeFence.fencingToken);
  lease.start(() => {
    if (runtimeShutdown) return runtimeShutdown.shutdown("lease-lost").then(() => undefined).finally(() => { process.exitCode = 1; });
    process.kill(process.pid, "SIGTERM");
  });
  instanceTurns.prepareRecovery();
  await primaryToolGateway.start();
  sqliteIntegrity.start();
  await sqliteIntegrity.run();
  await instanceRuntime.reconcile();
  await instanceTurns.reconcile();
  const healthServer = await startHealthServer({ ...config.http, store: stores.health, herdr, lark, projects: config.projects, lease, workspaceCache: herdr, herdrCircuitBreaker, startupRecovery: coordinator, inboundDispatcher: { snapshot: () => coordinator.inboundSnapshot() }, sessionOperationDispatcher: sessionOperations, bindingRuntime: reconciler, instanceRuntime, instanceWorker, sqliteIntegrity, lifecycleEvents: bus, cardConvergence: projector, outboxDispatcher: channelPublisher, promptWorker: promptRun, ...(herdrSocketSubscriber ? { herdrSocket: herdrSocketSubscriber } : {}), buildIdentity });
  runtimeShutdown = new BridgeRuntimeShutdown({ ...(herdrSocketSubscriber ? { herdrSocketSubscriber } : {}), primaryToolGateway, instanceRuntime, instanceWorker: { async stop(context) { await Promise.all([instanceTurns.stop(), instanceWork.stop(context)]); } }, integrityAuditor: sqliteIntegrity, coordinator, queueFeedbackProjector, cardContextRebuilder, projector, publisher: channelPublisher, healthServer, lease, store: stores.lifecycle, logger });
  const shutdown = runtimeShutdown;
  const stopRuntime = async (signal: string) => {
    await paneRetention.stop();
    outboxRetention.stop();
    const result = await shutdown.shutdown(signal);
    if (result.outcome === "ownership_retained") process.exitCode = 1;
    return result;
  };
  channelPublisher.start();
  outboxRetention.start();
  projector.start();
  cardContextRebuilder.start(config.reconcileIntervalMs);
  queueFeedbackProjector.start(bus);
  await queueFeedbackProjector.converge();
  process.once("SIGINT", () => { void stopRuntime("SIGINT"); });
  process.once("SIGTERM", () => { void stopRuntime("SIGTERM"); });
  logger.info({ event: "bridge-startup-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], databasePath: config.databasePath, http: config.http, logLevel: config.logLevel }, "bridge startup started");
  await coordinator.start();
  await paneRetention.scan();
  paneRetention.start(config.reconcileIntervalMs);
  externalTurns.start();
  instanceRuntime.start(config.reconcileIntervalMs);
  instanceTurns.start(config.reconcileIntervalMs);
  herdrSocketSubscriber?.startEvents();
  logger.info({ event: "bridge-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], http: config.http, durationMs: Date.now() - startupStartedAt, outcome: "ready" }, "bridge started");
} catch (error) {
  logger.fatal({ event: "bridge-startup-failed", err: safeLogError(error), durationMs: Date.now() - startupStartedAt, outcome: "failed" }, "bridge failed to start");
  outboxRetention.stop();
  if (runtimeShutdown) await runtimeShutdown.shutdown("startup-failure");
  else {
    await cleanupStartupFailure({ integrityAuditor: sqliteIntegrity, ...(herdrSocketSubscriber ? { herdrSocketSubscriber } : {}), primaryToolGateway, lease, store: stores.lifecycle, logger });
  }
  process.exitCode = 1;
}
