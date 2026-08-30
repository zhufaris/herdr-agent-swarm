import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, validateProjectDirectories } from "../config.js";
import { readEnvironmentFile } from "../runtime/environment-file.js";
import { AGENT_SWARM_SERVICE_ID, loadBuildIdentity, type BuildIdentity } from "../runtime/build-identity.js";
import type { SetupLifecyclePort } from "../setup/setup-types.js";

type Action = "install" | "uninstall" | "start" | "status" | "restart" | "stop" | "logs";
const SERVICE_NAME = "herdr-agent-swarm.service";
export interface LifecycleOptions { force?: boolean; requireReady?: boolean }

export interface LifecycleInspection {
  installed: boolean;
  active: boolean;
  summary: string;
}

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

export async function runServiceLifecycle(action: Action, environment: NodeJS.ProcessEnv = process.env, options: LifecycleOptions = {}): Promise<number> {
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
    : action === "start"
      ? ["--user", "enable", "--now", paths.serviceName]
      : ["--user", action, paths.serviceName];
  const result = delegate("systemctl", argumentsForAction, environment);
  if (result !== 0 || action === "stop") return result;
  return waitForStartupCompletion(paths, environment, action, action === "restart" ? restartTimeoutMs(environment) : startTimeoutMs(environment), options.requireReady ?? false);
}

export async function inspectServiceLifecycle(environment: NodeJS.ProcessEnv = process.env): Promise<LifecycleInspection> {
  const paths = runtimePaths(environment);
  const installed = existsSync(paths.unitFile);
  const active = isUnitActive(paths.serviceName, environment);
  return {
    installed, active,
    summary: `${paths.serviceName} is ${installed ? "installed" : "not installed"} and ${active ? "active" : "inactive"}`
  };
}

export function createSetupLifecycleAdapter(environment: NodeJS.ProcessEnv = process.env): SetupLifecyclePort {
  const successful = async (action: "install" | "start" | "restart", options: LifecycleOptions = {}) => {
    const result = await runServiceLifecycle(action, environment, options);
    if (result !== 0) throw new Error(`Service ${action} failed with exit code ${result}`);
  };
  return {
    inspect: async () => inspectServiceLifecycle(environment),
    install: async () => successful("install"),
    start: async () => successful("start", { requireReady: true }),
    restart: async () => successful("restart", { requireReady: true })
  };
}

async function assertRestartSafe(paths: RuntimePaths, base: NodeJS.ProcessEnv): Promise<void> {
  if (!isUnitActive(paths.serviceName, base)) return;
  let status: unknown;
  try {
    const config = loadConfig(loadRuntimeEnvironment(paths, base));
    status = await getJson(config.http.host, config.http.port, "/status", true);
  } catch (error) {
    throw new Error(`restart blocked: active service status is unreachable (${safeMessage(error)}); verify the running unit or retry with --force`);
  }
  const record = asRecord(status);
  const identity = asRecord(record?.identity);
  if (identity?.serviceId !== AGENT_SWARM_SERVICE_ID) throw new Error(`restart blocked: active service identity is ${typeof identity?.serviceId === "string" ? identity.serviceId : "missing"}, expected ${AGENT_SWARM_SERVICE_ID}; verify the endpoint or retry with --force`);
  const operational = asRecord(record?.operational);
  const prompts = asRecord(operational?.prompts);
  const promptWorker = asRecord(record?.promptWorker);
  const running = nonNegativeInteger(prompts?.running);
  const queued = nonNegativeInteger(prompts?.queued);
  const activeWorkers = nonNegativeInteger(promptWorker?.activeTurnWorkers);
  const instanceWorker = asRecord(record?.instanceWorker);
  const instanceDispatchers = nonNegativeInteger(instanceWorker?.activeDispatchWorkers);
  const instanceObservers = nonNegativeInteger(instanceWorker?.activeObservers);
  const activeInstanceTurns = nonNegativeInteger(instanceWorker?.activeTurns);
  const uncertainInstanceTurns = nonNegativeInteger(instanceWorker?.uncertainTurns);
  const pendingOutbox = nonNegativeInteger(operational?.pendingOutbox);
  const outboxDispatcher = asRecord(record?.outboxDispatcher);
  const activeDeliveries = nonNegativeInteger(outboxDispatcher?.activeDeliveries);
  const startupRecovery = asRecord(record?.startupRecovery);
  const startupRecoveryState = typeof startupRecovery?.state === "string" ? startupRecovery.state : null;
  const sqliteIntegrity = asRecord(record?.sqliteIntegrity);
  const sqliteIntegrityState = typeof sqliteIntegrity?.state === "string" ? sqliteIntegrity.state : null;
  const sqliteQuickCheck = typeof sqliteIntegrity?.quickCheck === "string" ? sqliteIntegrity.quickCheck : null;
  if (running! > 0 || queued! > 0 || activeWorkers! > 0 || instanceDispatchers! > 0 || instanceObservers! > 0 || activeInstanceTurns! > 0 || uncertainInstanceTurns! > 0) throw new Error(`restart blocked: ${metric(running)} running prompts, ${metric(queued)} queued prompts, ${metric(activeWorkers)} active turn workers; instance work has ${metric(instanceDispatchers)} dispatchers, ${metric(instanceObservers)} observers, ${metric(activeInstanceTurns)} active turns, ${metric(uncertainInstanceTurns)} uncertain turns; wait for active work to drain or retry with --force`);
  if (pendingOutbox! > 0) throw new Error(`restart blocked: ${pendingOutbox} pending outbox items; wait for delivery to drain or retry with --force`);
  if (activeDeliveries! > 0) throw new Error(`restart blocked: ${activeDeliveries} active deliveries; wait for delivery to drain or retry with --force`);
  if (startupRecoveryState !== null && startupRecoveryState !== "completed") throw new Error(`restart blocked: startup recovery is ${startupRecoveryState}, expected completed; wait for recovery or retry with --force`);
  if (sqliteIntegrityState !== null && sqliteIntegrityState !== "healthy" || sqliteQuickCheck !== null && sqliteQuickCheck !== "ok") throw new Error(`restart blocked: SQLite integrity is ${sqliteIntegrityState ?? "missing"} with quickCheck ${sqliteQuickCheck ?? "missing"}; repair integrity or retry with --force`);
  if ([running, queued, activeWorkers, instanceDispatchers, instanceObservers, activeInstanceTurns, uncertainInstanceTurns, pendingOutbox, activeDeliveries].some((value) => value === null) || startupRecoveryState === null || sqliteIntegrityState === null || sqliteQuickCheck === null) throw new Error("restart blocked: active service status has incomplete restart safety metrics; verify the running unit or retry with --force");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function metric(value: number | null): number | "unknown" { return value ?? "unknown"; }

function runtimePaths(environment: NodeJS.ProcessEnv): RuntimePaths {
  const root = requiredDirectory(environment.SWARM_ROOT, "SWARM_ROOT");
  const configDirectory = requiredDirectory(environment.SWARM_CONFIG_DIR || `${environment.XDG_CONFIG_HOME || `${homedir()}/.config`}/herdr-agent-swarm`, "SWARM_CONFIG_DIR", false);
  const stateDirectory = requiredDirectory(environment.SWARM_STATE_DIR || `${environment.XDG_STATE_HOME || `${homedir()}/.local/state`}/herdr-agent-swarm`, "SWARM_STATE_DIR", false);
  const unitDirectory = resolve(environment.BRIDGE_SYSTEMD_UNIT_DIR || `${homedir()}/.config/systemd/user`);
  return {
    root, configDirectory, stateDirectory, serviceName: SERVICE_NAME,
    environmentFile: resolve(configDirectory, ".env"),
    entrypoint: resolve(root, "dist/main.js"), buildInfo: resolve(root, "dist/build-info.json"),
    unitFile: resolve(unitDirectory, SERVICE_NAME),
    nodeExecutable: resolve(environment.NODE_BIN || process.execPath)
  };
}

function requiredDirectory(value: string | undefined, name: string, mustExist = true): string {
  if (!value) throw new Error(`${name} is required`);
  const path = resolve(value);
  if (mustExist && (!existsSync(path) || !statSync(path).isDirectory())) throw new Error(`${name} is not an accessible directory: ${path}`);
  return path;
}

function loadRuntimeEnvironment(paths: RuntimePaths, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!existsSync(paths.environmentFile)) throw new Error(`configuration file not found: ${paths.environmentFile}; run the setup action first`);
  const environment = { ...base, ...readEnvironmentFile(paths.environmentFile) };
  if (base.HERDR_SOCKET_PATH) environment.HERDR_SOCKET_PATH = base.HERDR_SOCKET_PATH;
  environment.PROJECTS_CONFIG_PATH = resolve(paths.configDirectory, "projects.json");
  environment.BRIDGE_DATABASE_PATH ||= resolve(paths.stateDirectory, "bridge.db");
  const config = loadConfig(environment);
  validateProjectDirectories(config.projects);
  return environment;
}

function install(paths: RuntimePaths, environment: NodeJS.ProcessEnv): number {
  if (!existsSync(paths.entrypoint)) throw new Error(`compiled service entrypoint not found: ${paths.entrypoint}; run npm run build first`);
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
  return [
    "[Unit]",
    "Description=Herdr Agent Swarm",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdEscape(paths.root)}`,
    `EnvironmentFile=${systemdEscape(paths.environmentFile)}`,
    `Environment=PROJECTS_CONFIG_PATH=${systemdEscape(resolve(paths.configDirectory, "projects.json"))}`,
    `Environment=BRIDGE_DATABASE_PATH=${systemdEscape(resolve(environment.BRIDGE_DATABASE_PATH || resolve(paths.stateDirectory, "bridge.db")))}`,
    ...(environment.HERDR_SOCKET_PATH ? [`Environment=HERDR_SOCKET_PATH=${systemdEscape(environment.HERDR_SOCKET_PATH)}`] : []),
    `Environment=BRIDGE_EXPECTED_BUILD_ID=${systemdEscape(identity.buildId)}`,
    `ExecStart=${systemdEscape(paths.nodeExecutable)} --enable-source-maps ${systemdEscape(paths.entrypoint)}`,
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

async function waitForStartupCompletion(paths: RuntimePaths, base: NodeJS.ProcessEnv, action: "start" | "restart", timeoutMs: number, requireReady: boolean): Promise<number> {
  const expected = loadBuildIdentity(paths.buildInfo);
  const config = loadConfig(loadRuntimeEnvironment(paths, base));
  const deadline = Date.now() + timeoutMs;
  let consecutiveHealthyChecks = 0;
  let observedBuildId = "unavailable";
  let observedStartupState = "unavailable";
  let observedOwnership = "unavailable";
  let unitState = "inactive";
  do {
    const active = isUnitActive(paths.serviceName, base);
    unitState = active ? "active" : "inactive";
    const startup = active ? await probeStartupStatus(config.http.host, config.http.port) : null;
    const ownership = active && startup?.connectedAddress ? probeListenerOwnership(paths.serviceName, startup.connectedAddress, config.http.port, base) : null;
    observedBuildId = startup?.buildId ?? "unavailable";
    observedStartupState = startup?.startupRecoveryState ?? "unavailable";
    observedOwnership = ownership?.detail ?? "unavailable";
    const healthy = startup?.status === "ok" && startup.serviceId === AGENT_SWARM_SERVICE_ID
      && startup.buildId === expected.buildId && startup.startupRecoveryState === "completed" && ownership?.matches === true;
    consecutiveHealthyChecks = healthy ? consecutiveHealthyChecks + 1 : 0;
    if (consecutiveHealthyChecks >= 2) {
      const readiness = await probeStatus(config.http.host, config.http.port, "/ready");
      process.stdout.write(`bridge startup completed (${paths.serviceName}); readiness=${readiness.status}\n`);
      if (readiness.status !== "ready") process.stdout.write(`bridge dependencies are degraded: ${readiness.detail}\n`);
      if (requireReady && readiness.status !== "ready") throw new Error(`bridge ${action} completed but readiness is ${readiness.status}; inspect swarm:status and swarm:logs`);
      return 0;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(`bridge ${action} did not complete startup with expected build ${expected.buildId} within ${timeoutMs}ms; unit ${unitState}; observed build ${observedBuildId}; startup ${observedStartupState}; listener ownership ${observedOwnership}; configured listener PID must belong to canonical unit MainPID; inspect systemctl --user status ${paths.serviceName}`);
}

function startTimeoutMs(environment: NodeJS.ProcessEnv): number { return positiveMilliseconds(environment.SWARM_SERVICE_START_TIMEOUT_MS, 15_000); }

function restartTimeoutMs(environment: NodeJS.ProcessEnv): number { return positiveMilliseconds(environment.SWARM_SERVICE_RESTART_TIMEOUT_MS, 90_000); }

async function printStatus(paths: RuntimePaths, base: NodeJS.ProcessEnv): Promise<number> {
  const expected = loadBuildIdentity(paths.buildInfo);
  const active = isUnitActive(paths.serviceName, base);
  let bridge: unknown = null;
  let ownership: ListenerOwnership | null = null;
  try {
    const config = loadConfig(loadRuntimeEnvironment(paths, base));
    const response = await getJsonResponse(config.http.host, config.http.port, "/status");
    bridge = response.body;
    ownership = probeListenerOwnership(paths.serviceName, response.connectedAddress, config.http.port, base);
  } catch (error) { bridge = { status: "unreachable", error: safeMessage(error) }; }
  const observed = bridge && typeof bridge === "object" && "identity" in bridge ? (bridge as { identity: unknown }).identity : null;
  const observedIdentity = asRecord(observed);
  const identityMatches = observedIdentity?.serviceId === expected.serviceId && observedIdentity?.buildId === expected.buildId;
  process.stdout.write(JSON.stringify({ service: paths.serviceName, active, unitFile: paths.unitFile, expectedIdentity: expected, observedIdentity: observed, ownership, bridge }) + "\n");
  return active && identityMatches && ownership?.matches === true ? 0 : 1;
}

interface ListenerOwnership {
  matches: boolean;
  mainPid: number | null;
  listenerPids: number[];
  detail: string;
}

function probeListenerOwnership(serviceName: string, host: string, port: number, environment: NodeJS.ProcessEnv): ListenerOwnership {
  const unit = spawnSync("systemctl", ["--user", "show", serviceName, "--property", "MainPID", "--value"], { env: environment, encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024 });
  const parsedMainPid = Number(unit.stdout.trim());
  const mainPid = unit.status === 0 && Number.isSafeInteger(parsedMainPid) && parsedMainPid > 0 ? parsedMainPid : null;
  const sockets = spawnSync("ss", ["-H", "-ltnp"], { env: environment, encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
  const listenerPids = sockets.status === 0 ? listenerPidsForEndpoint(sockets.stdout, host, port) : [];
  const matches = mainPid !== null && listenerPids.includes(mainPid);
  const detail = `MainPID=${mainPid ?? "unavailable"}, listenerPIDs=${listenerPids.length > 0 ? listenerPids.join(",") : "unavailable"}`;
  return { matches, mainPid, listenerPids, detail };
}

function listenerPidsForEndpoint(output: string, host: string, port: number): number[] {
  const pids = new Set<number>();
  const expected = normalizeIpAddress(host);
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const localAddress = fields[3];
    const endpoint = localAddress ? parseLocalEndpoint(localAddress) : null;
    if (!endpoint || endpoint.port !== port || normalizeIpAddress(endpoint.host) !== expected) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
  }
  return [...pids];
}

function parseLocalEndpoint(value: string): { host: string; port: number } | null {
  const bracketed = /^\[([^\]]+)]:(\d+)$/.exec(value);
  const plain = /^([^:]+):(\d+)$/.exec(value);
  const match = bracketed ?? plain;
  if (!match?.[1] || !match[2]) return null;
  const port = Number(match[2]);
  return Number.isSafeInteger(port) && port > 0 ? { host: match[1], port } : null;
}

function normalizeIpAddress(value: string): string {
  return value.startsWith("::ffff:") ? value.slice(7) : value;
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

async function probeStartupStatus(host: string, port: number): Promise<{ status?: string; serviceId?: string; buildId?: string; startupRecoveryState?: string; connectedAddress?: string } | null> {
  try {
    const response = await getJsonResponse(host, port, "/status");
    const record = asRecord(response.body);
    if (!record) return null;
    const identity = asRecord(record.identity);
    const startupRecovery = asRecord(record.startupRecovery);
    return {
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      ...(typeof identity?.serviceId === "string" ? { serviceId: identity.serviceId } : {}),
      ...(typeof identity?.buildId === "string" ? { buildId: identity.buildId } : {}),
      ...(typeof startupRecovery?.state === "string" ? { startupRecoveryState: startupRecovery.state } : {}),
      connectedAddress: response.connectedAddress
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
  return getJsonResponse(host, port, path, acceptErrorStatus).then((response) => response.body);
}

function getJsonResponse(host: string, port: number, path: string, acceptErrorStatus = false): Promise<{ body: unknown; connectedAddress: string }> {
  return new Promise((resolvePromise, reject) => {
    const outgoing = request({ host, port, path, method: "GET", timeout: 1_500 }, (response) => {
      const connectedAddress = response.socket.remoteAddress;
      let body = ""; response.setEncoding("utf8"); response.on("data", (chunk: string) => { if (body.length < 1_000_000) body += chunk; });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode >= 400 && !acceptErrorStatus) { reject(new Error(`HTTP ${response.statusCode ?? "unknown"}`)); return; }
        if (!connectedAddress) { reject(new Error("connected address unavailable")); return; }
        try { resolvePromise({ body: JSON.parse(body), connectedAddress: normalizeIpAddress(connectedAddress) }); } catch { reject(new Error("invalid JSON response")); }
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
    process.stderr.write("usage: service-lifecycle <install|uninstall|start|status|restart|stop|logs> [--force for restart]\n"); process.exitCode = 2;
  } else {
    runServiceLifecycle(action, process.env, { force: flags.includes("--force") }).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`service lifecycle failed: ${safeMessage(error)}\n`); process.exitCode = 1; });
  }
}
