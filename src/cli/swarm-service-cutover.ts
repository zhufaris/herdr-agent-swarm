import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, validateProjectDirectories } from "../config.js";
import { readEnvironmentFile } from "../runtime/environment-file.js";
import { runPluginLifecycle } from "./plugin-lifecycle.js";

export interface CutoverStatus {
  status?: string;
  identity?: { serviceId?: string; buildId?: string };
  readiness?: { status?: string };
  startupRecovery?: { state?: string };
  sqliteIntegrity?: { state?: string; quickCheck?: string };
  lease?: { held?: boolean };
  operational?: { prompts?: { running?: number; queued?: number }; pendingOutbox?: number };
  promptWorker?: { activeTurnWorkers?: number; activeSteeringWorkers?: number };
  instanceWorker?: { activeDispatchWorkers?: number; activeObservers?: number; activeTurns?: number; uncertainTurns?: number };
  outboxDispatcher?: { activeDeliveries?: number };
}

export interface CutoverDependencies {
  validateConfiguration(environment: NodeJS.ProcessEnv): void | Promise<void>;
  readStatus(environment: NodeJS.ProcessEnv): Promise<CutoverStatus>;
  serviceState(name: string): Promise<{ active: boolean; enabled: boolean }>;
  runLifecycle(action: "install" | "start", environment: NodeJS.ProcessEnv): Promise<number>;
  stopService(name: string): Promise<void>;
  startService(name: string): Promise<void>;
  enableService(name: string): Promise<void>;
  disableService(name: string): Promise<void>;
}

export async function runStandaloneCutover(environment: NodeJS.ProcessEnv = process.env, dependencies: CutoverDependencies = systemDependencies): Promise<number> {
  const paths = cutoverPaths(environment);
  prepareConfiguration(paths);
  const standaloneEnvironment = { ...environment, SWARM_CONFIG_DIR: paths.swarmConfig, SWARM_STATE_DIR: paths.swarmState, BRIDGE_SYSTEMD_SERVICE_NAME: paths.standaloneService };
  await dependencies.validateConfiguration(standaloneEnvironment);

  const previous = await dependencies.serviceState(paths.compatibilityService);
  const standalone = await dependencies.serviceState(paths.standaloneService);
  if (standalone.active && !previous.active) {
    await dependencies.runLifecycle("start", standaloneEnvironment);
    requireHealthy(await dependencies.readStatus(standaloneEnvironment));
    await dependencies.disableService(paths.compatibilityService);
    return 0;
  }
  if (standalone.active) throw new Error("cutover blocked: standalone and compatibility services are both active");

  const currentStatus = await dependencies.readStatus(standaloneEnvironment);
  requireDrained(currentStatus);
  let compatibilityStopped = false;
  try {
    if (previous.active) {
      await dependencies.stopService(paths.compatibilityService);
      compatibilityStopped = true;
      if ((await dependencies.serviceState(paths.compatibilityService)).active) throw new Error("compatibility service remained active after stop");
    }
    await dependencies.runLifecycle("install", standaloneEnvironment);
    await dependencies.runLifecycle("start", standaloneEnvironment);
    requireHealthy(await dependencies.readStatus(standaloneEnvironment));
    await dependencies.disableService(paths.compatibilityService);
    return 0;
  } catch (error) {
    if (compatibilityStopped) await rollback(paths, previous, standaloneEnvironment, dependencies);
    throw error;
  }
}

function cutoverPaths(environment: NodeJS.ProcessEnv) {
  const configBase = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  const stateBase = environment.XDG_STATE_HOME || join(homedir(), ".local/state");
  return {
    compatibilityConfig: resolve(environment.SWARM_COMPAT_CONFIG_DIR || join(configBase, "herdr/plugins/config/herdr-lark-bridge")),
    swarmConfig: resolve(environment.SWARM_CONFIG_DIR || join(configBase, "herdr-agent-swarm")),
    swarmState: resolve(environment.SWARM_STATE_DIR || join(stateBase, "herdr-agent-swarm")),
    compatibilityService: environment.SWARM_COMPAT_SERVICE_NAME || "herdr-lark-bridge.service",
    standaloneService: environment.BRIDGE_SYSTEMD_SERVICE_NAME || "herdr-agent-swarm.service"
  };
}

function prepareConfiguration(paths: ReturnType<typeof cutoverPaths>): void {
  const sourceEnvironment = join(paths.compatibilityConfig, ".env");
  const sourceProjects = join(paths.compatibilityConfig, "projects.json");
  if (!existsSync(sourceEnvironment) || !existsSync(sourceProjects)) throw new Error("compatibility configuration is incomplete");
  mkdirSync(paths.swarmConfig, { recursive: true, mode: 0o700 });
  mkdirSync(paths.swarmState, { recursive: true, mode: 0o700 });
  chmodSync(paths.swarmConfig, 0o700);
  chmodSync(paths.swarmState, 0o700);
  copyPrivateIfMissing(sourceEnvironment, join(paths.swarmConfig, ".env"));
  copyPrivateIfMissing(sourceProjects, join(paths.swarmConfig, "projects.json"));
  const sourceDatabase = readEnvironmentFile(sourceEnvironment).BRIDGE_DATABASE_PATH;
  const targetDatabase = readEnvironmentFile(join(paths.swarmConfig, ".env")).BRIDGE_DATABASE_PATH;
  if (sourceDatabase && targetDatabase !== sourceDatabase) throw new Error("standalone BRIDGE_DATABASE_PATH differs from compatibility configuration");
}

function copyPrivateIfMissing(source: string, target: string): void {
  if (!existsSync(target)) copyFileSync(source, target);
  chmodSync(target, 0o600);
}

function requireDrained(status: CutoverStatus): void {
  const values = {
    runningPrompts: status.operational?.prompts?.running,
    queuedPrompts: status.operational?.prompts?.queued,
    pendingOutbox: status.operational?.pendingOutbox,
    activeTurnWorkers: status.promptWorker?.activeTurnWorkers,
    activeSteeringWorkers: status.promptWorker?.activeSteeringWorkers ?? 0,
    activeDispatchWorkers: status.instanceWorker?.activeDispatchWorkers,
    activeObservers: status.instanceWorker?.activeObservers,
    activeInstanceTurns: status.instanceWorker?.activeTurns,
    uncertainInstanceTurns: status.instanceWorker?.uncertainTurns,
    activeDeliveries: status.outboxDispatcher?.activeDeliveries
  };
  if (Object.values(values).some((value) => typeof value !== "number" || value !== 0)) {
    throw new Error("cutover blocked: compatibility service has active, uncertain, or unverified work");
  }
}

function requireHealthy(status: CutoverStatus): void {
  if (status.status !== "ok" || status.startupRecovery?.state !== "completed" || status.readiness?.status !== "ready"
    || status.sqliteIntegrity?.state !== "healthy" || status.sqliteIntegrity.quickCheck !== "ok" || status.lease?.held !== true) {
    throw new Error("standalone service failed post-start verification");
  }
}

async function rollback(paths: ReturnType<typeof cutoverPaths>, previous: { active: boolean; enabled: boolean }, environment: NodeJS.ProcessEnv, dependencies: CutoverDependencies): Promise<void> {
  if ((await dependencies.serviceState(paths.standaloneService)).active) await dependencies.stopService(paths.standaloneService);
  if ((await dependencies.serviceState(paths.standaloneService)).active) throw new Error("rollback failed: standalone service remained active");
  if (previous.enabled) await dependencies.enableService(paths.compatibilityService);
  if (previous.active) {
    await dependencies.startService(paths.compatibilityService);
    requireHealthy(await dependencies.readStatus(environment));
  }
}

const systemDependencies: CutoverDependencies = {
  validateConfiguration(environment) {
    const configDirectory = environment.SWARM_CONFIG_DIR!;
    const loaded = { ...readEnvironmentFile(join(configDirectory, ".env")), ...environment, PROJECTS_CONFIG_PATH: join(configDirectory, "projects.json") };
    const config = loadConfig(loaded);
    validateProjectDirectories(config.projects);
  },
  async readStatus(environment) {
    const configDirectory = environment.SWARM_CONFIG_DIR!;
    const loaded = { ...readEnvironmentFile(join(configDirectory, ".env")), ...environment, PROJECTS_CONFIG_PATH: join(configDirectory, "projects.json") };
    const config = loadConfig(loaded);
    return await getJson(config.http.host, config.http.port, "/status") as CutoverStatus;
  },
  async serviceState(name) {
    return { active: systemctl(["--user", "is-active", name], true) === 0, enabled: systemctl(["--user", "is-enabled", name], true) === 0 };
  },
  runLifecycle,
  async stopService(name) { requireSystemctl(["--user", "stop", name]); },
  async startService(name) { requireSystemctl(["--user", "start", name]); },
  async enableService(name) { requireSystemctl(["--user", "enable", name]); },
  async disableService(name) { requireSystemctl(["--user", "disable", name]); }
};

async function runLifecycle(action: "install" | "start", environment: NodeJS.ProcessEnv): Promise<number> {
  return await runPluginLifecycle(action, environment);
}

function systemctl(arguments_: string[], quiet = false): number {
  const result = spawnSync("systemctl", arguments_, { encoding: "utf8", stdio: quiet ? "ignore" : "inherit", timeout: 30_000 });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function requireSystemctl(arguments_: string[]): void {
  const result = systemctl(arguments_);
  if (result !== 0) throw new Error("systemctl command failed: " + arguments_.join(" "));
}

function getJson(host: string, port: number, path: string): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const outgoing = request({ host, port, path, method: "GET", timeout: 1_500 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { if (body.length < 1_000_000) body += chunk; });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode >= 400) { reject(new Error("HTTP " + (response.statusCode ?? "unknown"))); return; }
        try { resolvePromise(JSON.parse(body)); } catch { reject(new Error("invalid JSON response")); }
      });
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("request timed out")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStandaloneCutover().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write("standalone cutover failed: " + (error instanceof Error ? error.message : String(error)).slice(0, 500) + "\n");
    process.exitCode = 1;
  });
}
