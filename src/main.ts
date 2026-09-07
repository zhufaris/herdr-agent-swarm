import pino from "pino";
import { fileURLToPath } from "node:url";
import { loadConfig, validateProjectDirectories } from "./config.js";
import { loadBuildIdentity } from "./runtime/build-identity.js";
import { safeLogError } from "./runtime/safe-error.js";
import { createManagedBridgeRuntime, type RuntimeStopReason } from "./composition/managed-bridge-runtime.js";

const buildIdentity = loadBuildIdentity(fileURLToPath(new URL("./build-info.json", import.meta.url)), process.env.BRIDGE_EXPECTED_BUILD_ID);
const config = loadConfig();
validateProjectDirectories(config.projects);
const logger = pino({ level: config.logLevel, serializers: { err: safeLogError }, redact: [
  "lark.appSecret", "appSecret", "*.appSecret", "token", "*.token", "authorization", "*.authorization",
  "cookie", "*.cookie", "password", "*.password", "privateKey", "*.privateKey"
] });
const startupStartedAt = Date.now();
try {
  const runtime = await createManagedBridgeRuntime({
    config, buildIdentity, logger,
    onFatalStop() { process.exitCode = 1; }
  });
  const stopRuntime = async (signal: RuntimeStopReason) => {
    const result = await runtime.stop(signal);
    if (result.outcome === "ownership_retained") process.exitCode = 1;
  };
  process.once("SIGINT", () => { void stopRuntime("SIGINT"); });
  process.once("SIGTERM", () => { void stopRuntime("SIGTERM"); });
  logger.info({ event: "bridge-startup-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], databasePath: config.databasePath, http: config.http, logLevel: config.logLevel }, "bridge startup started");
  await runtime.start();
  logger.info({ event: "bridge-started", projectCount: config.projects.length, workspaceIds: [...new Set(config.projects.map((project) => project.workspaceId))], http: config.http, durationMs: Date.now() - startupStartedAt, outcome: "ready" }, "bridge started");
} catch (error) {
  logger.fatal({ event: "bridge-startup-failed", err: safeLogError(error), durationMs: Date.now() - startupStartedAt, outcome: "failed" }, "bridge failed to start");
  process.exitCode = 1;
}
