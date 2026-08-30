import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, validateProjectDirectories } from "../config.js";
import { readEnvironmentFile } from "../runtime/environment-file.js";
import { BRIDGE_SERVICE_ID, loadBuildIdentity, type BuildIdentity } from "../runtime/build-identity.js";

type Action = "install" | "uninstall" | "start" | "status" | "restart" | "stop" | "logs";
interface LifecycleOptions { force?: boolean }

interface RuntimePaths {
  root: string;
  configDirectory: string;
  stateDirectory: string;
  environmentFile: string;
  entrypoint: string;
  buildInfo: string;
  unitFile: string;
  serviceName: string;
  nodeExecutable: string;
}

export async function runPluginLifecycle(action: Action, environment: NodeJS.ProcessEnv = process.env, options: LifecycleOptions = {}): Promise<number> {
  if (options.force && action !== "restart") throw new Error("--force is supported only for restart");
  const paths = runtimePaths(environment);
  mkdirSync(paths.configDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  if (action === "install") return install(paths, environment);
  if (action === "uninstall") return uninstall(paths, environment);
  if (action === "logs") return delegate("journalctl", ["--user", "-u", paths.serviceName, "-n", "100", "--no-pager"], environment);
  if (action === "status") return printStatus(paths, environment);

  requireInstalled(paths);
  if (action === "restart" && !options.force) await assertRestartSafe(paths, environment);
  if (action === "start" || action === "restart") {
    const runtimeEnvironment = loadRuntimeEnvironment(paths, environment);
    atomicWrite(paths.unitFile, renderUnit(paths, loadBuildIdentity(paths.buildInfo), runtimeEnvironment), 0o600);
    const reload = delegate("systemctl", ["--user", "daemon-reload"], environment);
    if (reload !== 0) return reload;
  }
  const argumentsForAction = action === "restart"
    ? ["--user", "restart", "--no-block", paths.serviceName]
    : action === "start" && Boolean(environment.SWARM_ROOT)
      ? ["--user", "enable", "--now", paths.serviceName]
      : ["--user", action, paths.serviceName];
  const result = delegate("systemctl", argumentsForAction, environment);
  if (result !== 0 || action === "stop") return result;
  return waitForStartupCompletion(paths, environment, action, action === "restart" ? restartTimeoutMs(environment) : startTimeoutMs(environment));
}

async function assertRestartSafe(paths: RuntimePaths, base: NodeJS.ProcessEnv): Promise<void> {
  if (!isUnitActive(paths.serviceName, base)) return;
  let status: unknown;
  try {
    const config = loadConfig(loadRuntimeEnvironment(paths, base));
    status = await getJson(config.http.host, config.http.port, "/status", true);
  } catch { return; }
  const record = asRecord(status);
  const identity = asRecord(record?.identity);
  if (identity?.serviceId !== BRIDGE_SERVICE_ID) return;
  const operational = asRecord(record?.operational);
  const prompts = asRecord(operational?.prompts);
  const promptWorker = asRecord(record?.promptWorker);
  const running = nonNegativeInteger(prompts?.running);
  const queued = nonNegativeInteger(prompts?.queued) ?? 0;
  const activeWorkers = nonNegativeInteger(promptWorker?.activeTurnWorkers);
  const instanceWorker = asRecord(record?.instanceWorker);
  const instanceDispatchers = nonNegativeInteger(instanceWorker?.activeDispatchWorkers) ?? 0;
  const instanceObservers = nonNegativeInteger(instanceWorker?.activeObservers) ?? 0;
  const activeInstanceTurns = nonNegativeInteger(instanceWorker?.activeTurns) ?? 0;
  const uncertainInstanceTurns = nonNegativeInteger(instanceWorker?.uncertainTurns) ?? 0;
  if (running === null && activeWorkers === null && !instanceWorker) return;
  if ((running ?? 0) > 0 || (activeWorkers ?? 0) > 0 || instanceDispatchers > 0 || instanceObservers > 0 || activeInstanceTurns > 0 || uncertainInstanceTurns > 0) throw new Error(`restart blocked: ${running ?? "unknown"} running prompts, ${queued} queued prompts, ${activeWorkers ?? "unknown"} active turn workers; instance work has ${instanceDispatchers} dispatchers, ${instanceObservers} observers, ${activeInstanceTurns} active turns, ${uncertainInstanceTurns} uncertain turns; wait for active work to drain or retry with --force`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function runtimePaths(environment: NodeJS.ProcessEnv): RuntimePaths {
  const standalone = Boolean(environment.SWARM_ROOT);
  const root = requiredDirectory(environment.SWARM_ROOT || environment.HERDR_PLUGIN_ROOT, standalone ? "SWARM_ROOT" : "HERDR_PLUGIN_ROOT");
  const configDirectory = requiredDirectory(environment.SWARM_CONFIG_DIR || environment.HERDR_PLUGIN_CONFIG_DIR || (standalone ? `${environment.XDG_CONFIG_HOME || `${homedir()}/.config`}/herdr-agent-swarm` : undefined), standalone ? "SWARM_CONFIG_DIR" : "HERDR_PLUGIN_CONFIG_DIR", false);
  const stateDirectory = requiredDirectory(environment.SWARM_STATE_DIR || environment.HERDR_PLUGIN_STATE_DIR || (standalone ? `${environment.XDG_STATE_HOME || `${homedir()}/.local/state`}/herdr-agent-swarm` : undefined), standalone ? "SWARM_STATE_DIR" : "HERDR_PLUGIN_STATE_DIR", false);
  const serviceName = environment.BRIDGE_SYSTEMD_SERVICE_NAME || (standalone ? "herdr-agent-swarm.service" : "herdr-lark-bridge.service");
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(serviceName)) throw new Error(`invalid systemd service name: ${serviceName}`);
  const unitDirectory = resolve(environment.BRIDGE_SYSTEMD_UNIT_DIR || `${homedir()}/.config/systemd/user`);
  return {
    root, configDirectory, stateDirectory, serviceName,
    environmentFile: resolve(configDirectory, ".env"),
    entrypoint: resolve(root, "dist/main.js"), buildInfo: resolve(root, "dist/build-info.json"),
    unitFile: resolve(unitDirectory, serviceName),
    nodeExecutable: resolve(environment.NODE_BIN || process.execPath)
  };
}

function requiredDirectory(value: string | undefined, name: string, mustExist = true): string {
  if (!value) throw new Error(`${name} is required; invoke this command through Herdr`);
  const path = resolve(value);
  if (mustExist && (!existsSync(path) || !statSync(path).isDirectory())) throw new Error(`${name} is not an accessible directory: ${path}`);
  return path;
}

function loadRuntimeEnvironment(paths: RuntimePaths, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!existsSync(paths.environmentFile)) throw new Error(`configuration file not found: ${paths.environmentFile}; run the setup action first`);
  const environment = { ...readEnvironmentFile(paths.environmentFile), ...base };
  if (!base.SWARM_ROOT) {
    environment.HERDR_PLUGIN_ROOT = paths.root;
    environment.HERDR_PLUGIN_CONFIG_DIR = paths.configDirectory;
    environment.HERDR_PLUGIN_STATE_DIR = paths.stateDirectory;
  }
  environment.PROJECTS_CONFIG_PATH ||= resolve(paths.configDirectory, "projects.json");
  environment.BRIDGE_DATABASE_PATH ||= resolve(paths.stateDirectory, "bridge.db");
  const config = loadConfig(environment);
  validateProjectDirectories(config.projects);
  return environment;
}

function install(paths: RuntimePaths, environment: NodeJS.ProcessEnv): number {
  if (!existsSync(paths.entrypoint)) throw new Error(`compiled bridge entrypoint not found: ${paths.entrypoint}; run the plugin build first`);
  const identity = loadBuildIdentity(paths.buildInfo);
  const runtimeEnvironment = loadRuntimeEnvironment(paths, environment);
  mkdirSync(dirname(paths.unitFile), { recursive: true, mode: 0o700 });
  atomicWrite(paths.unitFile, renderUnit(paths, identity, runtimeEnvironment), 0o600);
  let result = delegate("systemctl", ["--user", "daemon-reload"], environment);
  if (result === 0) result = delegate("systemctl", ["--user", "enable", paths.serviceName], environment);
  if (result === 0) process.stdout.write(`installed ${paths.serviceName} at ${paths.unitFile}\n`);
  return result;
}

function uninstall(paths: RuntimePaths, environment: NodeJS.ProcessEnv): number {
  delegate("systemctl", ["--user", "disable", "--now", paths.serviceName], environment, true);
  if (existsSync(paths.unitFile)) unlinkSync(paths.unitFile);
  const result = delegate("systemctl", ["--user", "daemon-reload"], environment);
  if (result === 0) process.stdout.write(`removed ${paths.serviceName}; configuration and state were preserved\n`);
  return result;
}

function renderUnit(paths: RuntimePaths, identity: BuildIdentity, environment: NodeJS.ProcessEnv): string {
  const standalone = Boolean(environment.SWARM_ROOT);
  return [
    "[Unit]",
    `Description=${standalone ? "Herdr Agent Swarm" : "Herdr Lark Bridge"}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdEscape(paths.root)}`,
    `EnvironmentFile=${systemdEscape(paths.environmentFile)}`,
    ...(standalone ? [
      `Environment=PROJECTS_CONFIG_PATH=${systemdEscape(resolve(paths.configDirectory, "projects.json"))}`,
      `Environment=BRIDGE_DATABASE_PATH=${systemdEscape(resolve(environment.BRIDGE_DATABASE_PATH || resolve(paths.stateDirectory, "bridge.db")))}`
    ] : [
      `Environment=HERDR_PLUGIN_ROOT=${systemdEscape(paths.root)}`,
      `Environment=HERDR_PLUGIN_CONFIG_DIR=${systemdEscape(paths.configDirectory)}`,
      `Environment=HERDR_PLUGIN_STATE_DIR=${systemdEscape(paths.stateDirectory)}`
    ]),
    ...(environment.HERDR_SOCKET_PATH ? [`Environment=HERDR_SOCKET_PATH=${systemdEscape(environment.HERDR_SOCKET_PATH)}`] : []),
    `Environment=BRIDGE_EXPECTED_BUILD_ID=${systemdEscape(identity.buildId)}`,
    `ExecStart=${systemdEscape(paths.nodeExecutable)} ${systemdEscape(paths.entrypoint)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "TimeoutStopSec=50",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

function systemdEscape(value: string): string {
  if (!value || /[\r\n]/.test(value)) throw new Error("invalid systemd value");
  return value.replaceAll("%", "%%").replaceAll(" ", "\\x20");
}

function atomicWrite(path: string, content: string, mode: number): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode, flag: "wx" });
  renameSync(temporary, path);
}

function requireInstalled(paths: RuntimePaths): void {
  if (!existsSync(paths.unitFile)) throw new Error(`service is not installed: ${paths.unitFile}; run the setup action first`);
}

async function waitForStartupCompletion(paths: RuntimePaths, base: NodeJS.ProcessEnv, action: "start" | "restart", timeoutMs: number): Promise<number> {
  const expected = loadBuildIdentity(paths.buildInfo);
  const config = loadConfig(loadRuntimeEnvironment(paths, base));
  const deadline = Date.now() + timeoutMs;
  let consecutiveHealthyChecks = 0;
  let observedBuildId = "unavailable";
  let observedStartupState = "unavailable";
  let unitState = "inactive";
  do {
    const active = isUnitActive(paths.serviceName, base);
    unitState = active ? "active" : "inactive";
    const startup = active ? await probeStartupStatus(config.http.host, config.http.port) : null;
    observedBuildId = startup?.buildId ?? "unavailable";
    observedStartupState = startup?.startupRecoveryState ?? "unavailable";
    const healthy = startup?.status === "ok" && startup.serviceId === BRIDGE_SERVICE_ID
      && startup.buildId === expected.buildId && startup.startupRecoveryState === "completed";
    consecutiveHealthyChecks = healthy ? consecutiveHealthyChecks + 1 : 0;
    if (consecutiveHealthyChecks >= 2) {
      const readiness = await probeStatus(config.http.host, config.http.port, "/ready");
      process.stdout.write(`bridge startup completed (${paths.serviceName}); readiness=${readiness.status}\n`);
      if (readiness.status !== "ready") process.stdout.write(`bridge dependencies are degraded: ${readiness.detail}\n`);
      return 0;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(`bridge ${action} did not complete startup with expected build ${expected.buildId} within ${timeoutMs}ms; unit ${unitState}; observed build ${observedBuildId}; startup ${observedStartupState}; inspect systemctl --user status ${paths.serviceName}`);
}

function startTimeoutMs(environment: NodeJS.ProcessEnv): number { return positiveMilliseconds(environment.BRIDGE_PLUGIN_START_TIMEOUT_MS, 15_000); }

function restartTimeoutMs(environment: NodeJS.ProcessEnv): number { return positiveMilliseconds(environment.BRIDGE_PLUGIN_RESTART_TIMEOUT_MS, 90_000); }

async function printStatus(paths: RuntimePaths, base: NodeJS.ProcessEnv): Promise<number> {
  const expected = loadBuildIdentity(paths.buildInfo);
  const active = isUnitActive(paths.serviceName, base);
  let bridge: unknown = null;
  try {
    const config = loadConfig(loadRuntimeEnvironment(paths, base));
    bridge = await getJson(config.http.host, config.http.port, "/status");
  } catch (error) { bridge = { status: "unreachable", error: safeMessage(error) }; }
  const observed = bridge && typeof bridge === "object" && "identity" in bridge ? (bridge as { identity: unknown }).identity : null;
  process.stdout.write(JSON.stringify({ service: paths.serviceName, active, unitFile: paths.unitFile, expectedIdentity: expected, observedIdentity: observed, bridge }) + "\n");
  return active ? 0 : 1;
}

function isUnitActive(serviceName: string, environment: NodeJS.ProcessEnv): boolean {
  const unit = spawnSync("systemctl", ["--user", "is-active", serviceName], { env: environment, encoding: "utf8", timeout: 5_000 });
  return unit.status === 0 && unit.stdout.trim() === "active";
}

function delegate(command: string, args: string[], environment: NodeJS.ProcessEnv, tolerateFailure = false): number {
  const result = spawnSync(command, args, { env: environment, encoding: "utf8", timeout: 30_000, stdio: "inherit" });
  if (result.error) { if (tolerateFailure) return 1; throw result.error; }
  return result.status ?? 1;
}

async function probeStartupStatus(host: string, port: number): Promise<{ status?: string; serviceId?: string; buildId?: string; startupRecoveryState?: string } | null> {
  try {
    const record = asRecord(await getJson(host, port, "/status"));
    if (!record) return null;
    const identity = asRecord(record.identity);
    const startupRecovery = asRecord(record.startupRecovery);
    return {
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      ...(typeof identity?.serviceId === "string" ? { serviceId: identity.serviceId } : {}),
      ...(typeof identity?.buildId === "string" ? { buildId: identity.buildId } : {}),
      ...(typeof startupRecovery?.state === "string" ? { startupRecoveryState: startupRecovery.state } : {})
    };
  } catch { return null; }
}

function positiveMilliseconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function probeStatus(host: string, port: number, path: string): Promise<{ status: string; detail: string }> {
  try {
    const result = await getJson(host, port, path, true);
    const status = typeof result === "object" && result !== null && typeof (result as { status?: unknown }).status === "string"
      ? String((result as { status: string }).status) : "unknown";
    return { status, detail: JSON.stringify(result).slice(0, 1_000) };
  } catch (error) {
    return { status: "unreachable", detail: safeMessage(error) };
  }
}

function getJson(host: string, port: number, path: string, acceptErrorStatus = false): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const outgoing = request({ host, port, path, method: "GET", timeout: 1_500 }, (response) => {
      let body = ""; response.setEncoding("utf8"); response.on("data", (chunk: string) => { if (body.length < 1_000_000) body += chunk; });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode >= 400 && !acceptErrorStatus) { reject(new Error(`HTTP ${response.statusCode ?? "unknown"}`)); return; }
        try { resolvePromise(JSON.parse(body)); } catch { reject(new Error("invalid JSON response")); }
      });
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("request timed out"))); outgoing.on("error", reject); outgoing.end();
  });
}

function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }

const action = process.argv[2] as Action | undefined;
const flags = process.argv.slice(3);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!action || !["install", "uninstall", "start", "status", "restart", "stop", "logs"].includes(action) || flags.some((flag) => flag !== "--force") || flags.length > 1 || flags.includes("--force") && action !== "restart") {
    process.stderr.write("usage: plugin-lifecycle <install|uninstall|start|status|restart|stop|logs> [--force for restart]\n"); process.exitCode = 2;
  } else {
    runPluginLifecycle(action, process.env, { force: flags.includes("--force") }).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`plugin lifecycle failed: ${safeMessage(error)}\n`); process.exitCode = 1; });
  }
}
