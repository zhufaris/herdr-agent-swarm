import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, validateProjectDirectories } from "../config.js";
import { readEnvironmentFile } from "../runtime/environment-file.js";
import { BRIDGE_SERVICE_ID, loadBuildIdentity, type BuildIdentity } from "../runtime/build-identity.js";

type Action = "install" | "uninstall" | "start" | "status" | "restart" | "stop" | "logs";

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

export async function runPluginLifecycle(action: Action, environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  const paths = runtimePaths(environment);
  mkdirSync(paths.configDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  if (action === "install") return install(paths, environment);
  if (action === "uninstall") return uninstall(paths, environment);
  if (action === "logs") return delegate("journalctl", ["--user", "-u", paths.serviceName, "-n", "100", "--no-pager"], environment);
  if (action === "status") return printStatus(paths, environment);

  requireInstalled(paths);
  if (action === "start" || action === "restart") {
    loadRuntimeEnvironment(paths, environment);
    atomicWrite(paths.unitFile, renderUnit(paths, loadBuildIdentity(paths.buildInfo), environment), 0o600);
    const reload = delegate("systemctl", ["--user", "daemon-reload"], environment);
    if (reload !== 0) return reload;
  }
  const result = delegate("systemctl", ["--user", action, paths.serviceName], environment);
  if (result !== 0 || action === "stop") return result;
  return waitForHealth(paths, environment);
}

function runtimePaths(environment: NodeJS.ProcessEnv): RuntimePaths {
  const root = requiredDirectory(environment.HERDR_PLUGIN_ROOT, "HERDR_PLUGIN_ROOT");
  const configDirectory = requiredDirectory(environment.HERDR_PLUGIN_CONFIG_DIR, "HERDR_PLUGIN_CONFIG_DIR", false);
  const stateDirectory = requiredDirectory(environment.HERDR_PLUGIN_STATE_DIR, "HERDR_PLUGIN_STATE_DIR", false);
  const serviceName = environment.BRIDGE_SYSTEMD_SERVICE_NAME || "herdr-lark-bridge.service";
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
  environment.HERDR_PLUGIN_ROOT = paths.root;
  environment.HERDR_PLUGIN_CONFIG_DIR = paths.configDirectory;
  environment.HERDR_PLUGIN_STATE_DIR = paths.stateDirectory;
  environment.PROJECTS_CONFIG_PATH ||= resolve(paths.configDirectory, "projects.json");
  environment.BRIDGE_DATABASE_PATH ||= resolve(paths.stateDirectory, "bridge.db");
  const config = loadConfig(environment);
  validateProjectDirectories(config.projects);
  return environment;
}

function install(paths: RuntimePaths, environment: NodeJS.ProcessEnv): number {
  if (!existsSync(paths.entrypoint)) throw new Error(`compiled bridge entrypoint not found: ${paths.entrypoint}; run the plugin build first`);
  const identity = loadBuildIdentity(paths.buildInfo);
  loadRuntimeEnvironment(paths, environment);
  mkdirSync(dirname(paths.unitFile), { recursive: true, mode: 0o700 });
  atomicWrite(paths.unitFile, renderUnit(paths, identity, environment), 0o600);
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
    "Description=Herdr Lark Bridge",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdEscape(paths.root)}`,
    `EnvironmentFile=${systemdEscape(paths.environmentFile)}`,
    `Environment=HERDR_PLUGIN_ROOT=${systemdEscape(paths.root)}`,
    `Environment=HERDR_PLUGIN_CONFIG_DIR=${systemdEscape(paths.configDirectory)}`,
    `Environment=HERDR_PLUGIN_STATE_DIR=${systemdEscape(paths.stateDirectory)}`,
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

async function waitForHealth(paths: RuntimePaths, base: NodeJS.ProcessEnv): Promise<number> {
  const expected = loadBuildIdentity(paths.buildInfo);
  const config = loadConfig(loadRuntimeEnvironment(paths, base));
  const timeoutMs = positiveMilliseconds(base.BRIDGE_PLUGIN_START_TIMEOUT_MS, 15_000);
  const deadline = Date.now() + timeoutMs;
  let consecutiveHealthyChecks = 0;
  let observedBuildId = "unavailable";
  do {
    const active = isUnitActive(paths.serviceName, base);
    const health = active ? await probeHealthIdentity(config.http.host, config.http.port) : null;
    observedBuildId = health?.buildId ?? "unavailable";
    const healthy = health?.status === "ok" && health.serviceId === BRIDGE_SERVICE_ID && health.buildId === expected.buildId;
    consecutiveHealthyChecks = healthy ? consecutiveHealthyChecks + 1 : 0;
    if (consecutiveHealthyChecks >= 2) {
      const readiness = await probeStatus(config.http.host, config.http.port, "/ready");
      process.stdout.write(`bridge service is healthy (${paths.serviceName}); readiness=${readiness.status}\n`);
      if (readiness.status !== "ready") process.stdout.write(`bridge dependencies are degraded: ${readiness.detail}\n`);
      return 0;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  } while (Date.now() < deadline);
  throw new Error(`bridge service did not become active with expected build ${expected.buildId} within ${timeoutMs}ms; observed ${observedBuildId}; inspect systemctl --user status ${paths.serviceName}`);
}

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

async function probeHealthIdentity(host: string, port: number): Promise<{ status?: unknown; serviceId?: unknown; buildId?: string } | null> {
  try {
    const result = await getJson(host, port, "/health");
    if (!result || typeof result !== "object") return null;
    const record = result as Record<string, unknown>;
    return { status: record.status, serviceId: record.serviceId, ...(typeof record.buildId === "string" ? { buildId: record.buildId } : {}) };
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
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!action || !["install", "uninstall", "start", "status", "restart", "stop", "logs"].includes(action)) {
    process.stderr.write("usage: plugin-lifecycle <install|uninstall|start|status|restart|stop|logs>\n"); process.exitCode = 2;
  } else {
    runPluginLifecycle(action).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`plugin lifecycle failed: ${safeMessage(error)}\n`); process.exitCode = 1; });
  }
}
