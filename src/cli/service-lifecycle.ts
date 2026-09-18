import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, validateProjectDirectories } from "../config.js";
import { readEnvironmentFile } from "../runtime/environment-file.js";
import { AGENT_SWARM_SERVICE_ID, loadBuildIdentity, type BuildIdentity } from "../runtime/build-identity.js";
import type { SetupLifecyclePort } from "../setup/setup-types.js";

type Action = "install" | "uninstall" | "start" | "status" | "restart" | "stop" | "logs";
const SERVICE_NAME = "herdr-agent-swarm.service";
export interface LifecycleOptions {
  force?: boolean;
  requireReady?: boolean;
  renameLogFile?: (source: string, destination: string) => void;
  readLogChunk?: typeof readSync;
  logQuery?: LogQueryOptions;
  renameActivationLink?: typeof renameSync;
}

export interface LogQueryOptions {
  lines?: number; maxBytes?: number; includeRotated?: boolean; json?: boolean;
  level?: string; since?: string; component?: string; eventId?: string;
  bindingId?: string; promptId?: string; paneId?: string; replyId?: string;
}

export interface LifecycleInspection {
  installed: boolean;
  active: boolean;
  summary: string;
}

interface RuntimePaths {
  root: string;
  configDirectory: string;
  stateDirectory: string;
  logDirectory: string;
  logFile: string;
  rotatedLogFiles: string[];
  environmentFile: string;
  entrypoint: string;
  buildInfo: string;
  unitFile: string;
  serviceName: string;
  nodeExecutable: string;
  releasesDirectory: string;
  currentLink: string;
  activationMarker: string;
  activationUnitBackup: string;
}

export interface PrivateLogMetadata { kind: "directory" | "file"; uid: number | bigint; nlink: number | bigint }

export function resolveUserSystemdFallbackEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeBase = "/run/user",
  uid = process.getuid?.()
): NodeJS.ProcessEnv | null {
  if (uid === undefined || environment.XDG_RUNTIME_DIR || environment.DBUS_SESSION_BUS_ADDRESS) return null;
  const runtimeDirectory = resolve(runtimeBase, String(uid));
  const busPath = resolve(runtimeDirectory, "bus");
  try {
    const runtime = lstatSync(runtimeDirectory);
    const bus = lstatSync(busPath);
    if (!runtime.isDirectory() || !bus.isSocket()) return null;
    if (BigInt(runtime.uid) !== BigInt(uid) || BigInt(bus.uid) !== BigInt(uid)) return null;
  } catch { return null; }
  return { ...environment, XDG_RUNTIME_DIR: runtimeDirectory, DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath}` };
}

export function validatePrivateLogMetadata(path: string, metadata: PrivateLogMetadata): void {
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined) throw new Error(`effective UID is unavailable; refusing private log path: ${path}`);
  if (BigInt(metadata.uid) !== BigInt(effectiveUid)) throw new Error(`private log path must be owned by effective UID ${effectiveUid}: ${path}`);
  if (metadata.kind === "file" && BigInt(metadata.nlink) !== 1n) throw new Error(`private log file must have a single link: ${path}`);
}

export async function runServiceLifecycle(action: Action, environment: NodeJS.ProcessEnv = process.env, options: LifecycleOptions = {}): Promise<number> {
  if (options.force && action !== "restart") throw new Error("--force is supported only for restart");
  const paths = runtimePaths(environment);
  mkdirSync(paths.configDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  if (["install", "start", "restart"].includes(action) && lstatOptional(paths.activationMarker)) {
    throw new Error(`incomplete release activation at ${paths.activationMarker}; inspect and repair the unit and current release before retrying`);
  }
  if (action === "install") return install(paths, environment, options.renameLogFile ?? renameSync, options.renameActivationLink ?? renameSync);
  if (action === "uninstall") return uninstall(paths, environment);
  if (action === "logs") return printLogs(paths, options.readLogChunk ?? readSync, options.logQuery ?? {});
  if (action === "status") return printStatus(paths, environment);

  requireInstalled(paths);
  if (action === "restart") await assertRestartSafe(paths, environment, options.force ?? false);
  if (action === "restart") {
    const stopped = delegate("systemctl", ["--user", "stop", paths.serviceName], environment);
    if (stopped !== 0) return stopped;
    convergeLogPaths(paths);
    rotateLogs(paths, options.renameLogFile ?? renameSync);
    rewriteUnit(paths, environment);
    const reloaded = delegate("systemctl", ["--user", "daemon-reload"], environment);
    if (reloaded !== 0) return reloaded;
    const started = delegate("systemctl", ["--user", "start", "--no-block", paths.serviceName], environment);
    if (started !== 0) return started;
    return waitForStartupCompletion(paths, environment, action, restartTimeoutMs(environment), options.requireReady ?? false);
  }
  if (action === "start") {
    convergeLogPaths(paths);
    if (isUnitConfirmedInactive(paths.serviceName, environment)) rotateLogs(paths, options.renameLogFile ?? renameSync);
    rewriteUnit(paths, environment);
    const reload = delegate("systemctl", ["--user", "daemon-reload"], environment);
    if (reload !== 0) return reload;
  }
  const argumentsForAction = action === "start"
    ? ["--user", "enable", "--now", paths.serviceName]
    : ["--user", action, paths.serviceName];
  const result = delegate("systemctl", argumentsForAction, environment);
  if (result !== 0 || action === "stop") return result;
  return waitForStartupCompletion(paths, environment, action, startTimeoutMs(environment), options.requireReady ?? false);
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

async function assertRestartSafe(paths: RuntimePaths, base: NodeJS.ProcessEnv, force: boolean): Promise<void> {
  const activity = unitActivity(paths.serviceName, base);
  if (activity === "inactive") return;
  if (activity === "indeterminate") throw new Error(`restart blocked: cannot determine ${paths.serviceName} unit activity; refusing to stop`);
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
  const outboxWork = asRecord(operational?.outboxWork);
  const readyOutbox = nonNegativeInteger(outboxWork?.ready);
  const inFlightOutbox = nonNegativeInteger(outboxWork?.inFlight);
  const retryWaitOutbox = nonNegativeInteger(outboxWork?.retryWait);
  const cooldownWaitOutbox = nonNegativeInteger(outboxWork?.cooldownWait);
  const waitingBehindLaneOutbox = nonNegativeInteger(outboxWork?.waitingBehindLane);
  const outboxDispatcher = asRecord(record?.outboxDispatcher);
  const activeDeliveries = nonNegativeInteger(outboxDispatcher?.activeDeliveries);
  const startupRecovery = asRecord(record?.startupRecovery);
  const startupRecoveryState = typeof startupRecovery?.state === "string" ? startupRecovery.state : null;
  const sqliteIntegrity = asRecord(record?.sqliteIntegrity);
  const sqliteIntegrityState = typeof sqliteIntegrity?.state === "string" ? sqliteIntegrity.state : null;
  const sqliteQuickCheck = typeof sqliteIntegrity?.quickCheck === "string" ? sqliteIntegrity.quickCheck : null;
  if (!force) {
    if (running! > 0 || queued! > 0 || activeWorkers! > 0 || instanceDispatchers! > 0 || instanceObservers! > 0 || activeInstanceTurns! > 0 || uncertainInstanceTurns! > 0) throw new Error(`restart blocked: ${metric(running)} running prompts, ${metric(queued)} queued prompts, ${metric(activeWorkers)} active turn workers; instance work has ${metric(instanceDispatchers)} dispatchers, ${metric(instanceObservers)} observers, ${metric(activeInstanceTurns)} active turns, ${metric(uncertainInstanceTurns)} uncertain turns; wait for active work to drain or retry with --force`);
    if (readyOutbox! > 0 || inFlightOutbox! > 0 || retryWaitOutbox! > 0 || cooldownWaitOutbox! > 0) throw new Error(`restart blocked: outbox work has ${metric(readyOutbox)} ready, ${metric(inFlightOutbox)} in-flight, ${metric(retryWaitOutbox)} retry-wait, ${metric(cooldownWaitOutbox)} cooldown-wait, ${metric(waitingBehindLaneOutbox)} waiting behind lanes; wait for actionable delivery work to drain or retry with --force`);
    if (activeDeliveries! > 0) throw new Error(`restart blocked: ${activeDeliveries} active deliveries; wait for delivery to drain or retry with --force`);
  }
  if (startupRecoveryState !== null && startupRecoveryState !== "completed") throw new Error(`restart blocked: startup recovery is ${startupRecoveryState}, expected completed; wait for recovery or retry with --force`);
  if (sqliteIntegrityState !== null && sqliteIntegrityState !== "healthy" || sqliteQuickCheck !== null && sqliteQuickCheck !== "ok") throw new Error(`restart blocked: SQLite integrity is ${sqliteIntegrityState ?? "missing"} with quickCheck ${sqliteQuickCheck ?? "missing"}; repair integrity or retry with --force`);
  const workloadIncomplete = !force && [running, queued, activeWorkers, instanceDispatchers, instanceObservers, activeInstanceTurns, uncertainInstanceTurns, readyOutbox, inFlightOutbox, retryWaitOutbox, cooldownWaitOutbox, waitingBehindLaneOutbox, activeDeliveries].some((value) => value === null);
  if (workloadIncomplete || startupRecoveryState === null || sqliteIntegrityState === null || sqliteQuickCheck === null) throw new Error("restart blocked: active service status has incomplete restart safety metrics; verify the running unit or retry with --force");
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
  const logDirectory = resolve(stateDirectory, "logs");
  const logFile = resolve(logDirectory, "service.log");
  return {
    root, configDirectory, stateDirectory, logDirectory, logFile, rotatedLogFiles: [1, 2, 3].map((generation) => `${logFile}.${generation}`), serviceName: SERVICE_NAME,
    environmentFile: resolve(configDirectory, ".env"),
    entrypoint: resolve(root, "dist/main.js"), buildInfo: resolve(root, "dist/build-info.json"),
    unitFile: resolve(unitDirectory, SERVICE_NAME),
    nodeExecutable: resolve(environment.NODE_BIN || process.execPath),
    releasesDirectory: resolve(stateDirectory, "releases"),
    currentLink: resolve(stateDirectory, "current"),
    activationMarker: resolve(stateDirectory, ".release-activation.json"),
    activationUnitBackup: resolve(stateDirectory, ".release-activation.unit")
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
  environment.RUNTIME_CONFIG_PATH = resolve(paths.configDirectory, "runtime.yaml");
  environment.BRIDGE_DATABASE_PATH ||= resolve(paths.stateDirectory, "bridge.db");
  const config = loadConfig(environment);
  validateProjectDirectories(config.projects);
  return environment;
}

function install(paths: RuntimePaths, environment: NodeJS.ProcessEnv, renameFile: (source: string, destination: string) => void, renameActivationLink: typeof renameSync): number {
  if (!existsSync(paths.entrypoint)) throw new Error(`compiled service entrypoint not found: ${paths.entrypoint}; run npm run build first`);
  const identity = loadBuildIdentity(paths.buildInfo);
  const runtimeEnvironment = loadRuntimeEnvironment(paths, environment);
  convergeLogPaths(paths);
  if (unitActivity(paths.serviceName, environment) === "inactive") rotateLogs(paths, renameFile);
  const candidate = environment.SWARM_RELEASE_CANDIDATE;
  if (candidate) return activateRelease(paths, environment, identity, runtimeEnvironment, candidate, renameActivationLink);
  mkdirSync(dirname(paths.unitFile), { recursive: true, mode: 0o700 });
  atomicWrite(paths.unitFile, renderUnit(paths, identity, runtimeEnvironment), 0o600);
  let result = delegate("systemctl", ["--user", "daemon-reload"], environment);
  if (result === 0) result = delegate("systemctl", ["--user", "enable", paths.serviceName], environment);
  if (result === 0) process.stdout.write(`installed ${paths.serviceName} at ${paths.unitFile}\n`);
  return result;
}

type PriorEnabledState = "enabled" | "disabled" | "absent";

function activateRelease(paths: RuntimePaths, environment: NodeJS.ProcessEnv, identity: BuildIdentity, runtimeEnvironment: NodeJS.ProcessEnv, candidateValue: string, renameActivationLink: typeof renameSync): number {
  const candidate = validateReleaseCandidate(paths, candidateValue, identity);
  const keepInactive = releaseRetention(environment);
  const priorCurrent = readPriorCurrent(paths);
  const priorUnit = readPriorUnit(paths);
  const priorUnitRelease = priorUnit ? releaseWorkingDirectory(paths, priorUnit.content) : null;
  const priorEnabled = priorUnit ? readEnabledState(paths.serviceName, environment) : "absent";
  if (lstatOptional(paths.activationUnitBackup)) throw new Error(`release activation backup already exists: ${paths.activationUnitBackup}`);
  atomicWrite(paths.activationMarker, JSON.stringify({ version: 1, candidate, priorCurrent, priorUnit: priorUnit ? { backup: paths.activationUnitBackup, mode: priorUnit.mode } : null, priorEnabled, phase: "prepared" }) + "\n", 0o600);
  try {
    if (priorUnit) writeFileSync(paths.activationUnitBackup, priorUnit.content, { mode: priorUnit.mode, flag: "wx" });
    mkdirSync(dirname(paths.unitFile), { recursive: true, mode: 0o700 });
    atomicWrite(paths.unitFile, renderUnit(paths, identity, runtimeEnvironment), 0o600);
    let failureCode = delegate("systemctl", ["--user", "daemon-reload"], environment);
    if (failureCode !== 0) throw new ReleaseActivationCommandError("daemon-reload", failureCode);
    failureCode = delegate("systemctl", ["--user", "enable", paths.serviceName], environment);
    if (failureCode !== 0) throw new ReleaseActivationCommandError("enable", failureCode);
    replaceCurrentLink(paths, candidate, renameActivationLink);
  } catch (error) {
    try {
      restoreActivation(paths, environment, priorCurrent, priorUnit, priorEnabled, renameActivationLink);
      removeActivationEvidence(paths);
    } catch (rollbackError) {
      throw new Error(`release activation failed (${safeMessage(error)}); rollback failed (${safeMessage(rollbackError)}); recovery marker retained at ${paths.activationMarker}`);
    }
    if (error instanceof ReleaseActivationCommandError) return error.exitCode;
    throw error;
  }
  try { removeActivationEvidence(paths); } catch (error) {
    throw new Error(`release activation committed but recovery marker cleanup failed (${safeMessage(error)}); inspect ${paths.activationMarker}`);
  }
  try { pruneReleases(paths, new Set([candidate, priorCurrent, priorUnitRelease].filter((path): path is string => path !== null)), keepInactive); } catch (error) {
    process.stderr.write(`release activation committed but release pruning failed: ${safeMessage(error)}\n`);
  }
  process.stdout.write(`installed ${paths.serviceName} at ${paths.unitFile}; activated ${candidate}\n`);
  return 0;
}

class ReleaseActivationCommandError extends Error {
  constructor(operation: string, readonly exitCode: number) { super(`${operation} failed with exit code ${exitCode}`); }
}

function validateReleaseCandidate(paths: RuntimePaths, value: string, identity: BuildIdentity): string {
  const unresolvedCandidate = resolve(value);
  if (lstatSync(unresolvedCandidate).isSymbolicLink()) throw new Error("SWARM_RELEASE_CANDIDATE must not be a symlink");
  const candidate = realpathSync(unresolvedCandidate);
  const releases = realpathSync(paths.releasesDirectory);
  const status = lstatSync(candidate);
  if (!status.isDirectory() || status.isSymbolicLink() || dirname(candidate) !== releases) throw new Error(`SWARM_RELEASE_CANDIDATE must be a direct release directory under ${releases}`);
  const commit = identity.gitCommit;
  if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("release activation requires a build identity with a Git commit");
  const expectedName = `${identity.buildId.replace(/^sha256:/, "")}-${commit.slice(0, 12)}`;
  if (candidate !== resolve(releases, expectedName)) throw new Error(`release candidate identity mismatch: expected ${expectedName}`);
  if (candidate !== realpathSync(paths.root)) throw new Error("SWARM_RELEASE_CANDIDATE must resolve to SWARM_ROOT");
  return candidate;
}

function readPriorCurrent(paths: RuntimePaths): string | null {
  const status = lstatOptional(paths.currentLink);
  if (!status) return null;
  if (!status.isSymbolicLink()) throw new Error(`current release path must be a symlink: ${paths.currentLink}`);
  const target = realpathSync(paths.currentLink);
  if (dirname(target) !== realpathSync(paths.releasesDirectory)) throw new Error(`current release must resolve under ${paths.releasesDirectory}`);
  if (!statSync(target).isDirectory()) throw new Error(`current release must resolve to a directory: ${target}`);
  return target;
}

function readPriorUnit(paths: RuntimePaths): { content: string; mode: number } | null {
  if (!existsSync(paths.unitFile)) return null;
  const status = lstatSync(paths.unitFile);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`service unit must be a regular file: ${paths.unitFile}`);
  return { content: readFileSync(paths.unitFile, "utf8"), mode: status.mode & 0o777 };
}

function releaseWorkingDirectory(paths: RuntimePaths, unit: string): string | null {
  const value = unit.split("\n").map((line) => line.trim()).find((line) => line.startsWith("WorkingDirectory="))?.slice("WorkingDirectory=".length);
  if (!value || !existsSync(value)) return null;
  const candidate = realpathSync(value);
  const releases = realpathSync(paths.releasesDirectory);
  const status = lstatSync(candidate);
  if (!status.isDirectory() || status.isSymbolicLink() || dirname(candidate) !== releases) return null;
  return /^[a-f0-9]{64}-[a-f0-9]{12}$/.test(candidate.slice(releases.length + 1)) ? candidate : null;
}

function readEnabledState(serviceName: string, environment: NodeJS.ProcessEnv): Exclude<PriorEnabledState, "absent"> {
  const result = spawnSync("systemctl", ["--user", "is-enabled", serviceName], { env: userSystemdEnvironment(environment), encoding: "utf8", timeout: 5_000 });
  const state = result.stdout.trim();
  if (result.status === 0 && ["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"].includes(state)) return "enabled";
  if (result.status !== 0 && ["disabled", "static", "indirect", "masked", "masked-runtime"].includes(state)) return "disabled";
  throw new Error(`cannot determine whether ${serviceName} is enabled; refusing release activation`);
}

function replaceCurrentLink(paths: RuntimePaths, target: string | null, renameLink: typeof renameSync = renameSync): void {
  const temporary = `${paths.currentLink}.tmp-${process.pid}`;
  if (lstatOptional(temporary)) unlinkSync(temporary);
  if (target === null) {
    if (lstatOptional(paths.currentLink)) unlinkSync(paths.currentLink);
    return;
  }
  symlinkSync(target, temporary);
  try { renameLink(temporary, paths.currentLink); } catch (error) { unlinkSync(temporary); throw error; }
}

function restoreActivation(paths: RuntimePaths, environment: NodeJS.ProcessEnv, priorCurrent: string | null, priorUnit: { content: string; mode: number } | null, priorEnabled: PriorEnabledState, renameActivationLink: typeof renameSync): void {
  replaceCurrentLink(paths, priorCurrent, renameActivationLink);
  if (priorEnabled !== "enabled") {
    const disabled = delegate("systemctl", ["--user", "disable", paths.serviceName], environment, true);
    if (disabled !== 0) throw new Error(`rollback disable failed with exit code ${disabled}`);
  }
  if (priorUnit) atomicWrite(paths.unitFile, priorUnit.content, priorUnit.mode);
  else if (existsSync(paths.unitFile)) unlinkSync(paths.unitFile);
  const reload = delegate("systemctl", ["--user", "daemon-reload"], environment, true);
  if (reload !== 0) throw new Error(`rollback daemon-reload failed with exit code ${reload}`);
  if (priorEnabled === "enabled") {
    const enabled = delegate("systemctl", ["--user", "enable", paths.serviceName], environment, true);
    if (enabled !== 0) throw new Error(`rollback enable failed with exit code ${enabled}`);
  }
}

function removeActivationEvidence(paths: RuntimePaths): void {
  if (lstatOptional(paths.activationUnitBackup)) unlinkSync(paths.activationUnitBackup);
  if (lstatOptional(paths.activationMarker)) unlinkSync(paths.activationMarker);
}

function releaseRetention(environment: NodeJS.ProcessEnv): number {
  const value = environment.SWARM_RELEASE_RETENTION ?? "3";
  if (!/^\d+$/.test(value)) throw new Error("SWARM_RELEASE_RETENTION must be a non-negative integer");
  return Number(value);
}

function pruneReleases(paths: RuntimePaths, retained: ReadonlySet<string>, keepInactive: number): void {
  let kept = 0;
  const candidates = readdirSync(paths.releasesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}-[a-f0-9]{12}$/.test(entry.name))
    .map((entry) => resolve(paths.releasesDirectory, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  for (const candidate of candidates) {
    if (retained.has(candidate)) continue;
    if (kept++ < keepInactive) continue;
    rmSync(candidate, { recursive: true });
  }
}

function uninstall(paths: RuntimePaths, environment: NodeJS.ProcessEnv): number {
  delegate("systemctl", ["--user", "disable", "--now", paths.serviceName], environment, true);
  if (existsSync(paths.unitFile)) unlinkSync(paths.unitFile);
  const result = delegate("systemctl", ["--user", "daemon-reload"], environment);
  if (result === 0) process.stdout.write(`removed ${paths.serviceName}; configuration and state were preserved\n`);
  return result;
}

function renderUnit(paths: RuntimePaths, identity: BuildIdentity, environment: NodeJS.ProcessEnv): string {
  const requiredUnit = requiredUserUnit(environment.BRIDGE_REQUIRED_USER_UNIT);
  return [
    "[Unit]",
    "Description=Herdr Agent Swarm",
    ...(requiredUnit ? [`Requires=${requiredUnit}`] : []),
    `After=network-online.target${requiredUnit ? ` ${requiredUnit}` : ""}`,
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdEscape(paths.root)}`,
    `EnvironmentFile=${systemdEscape(paths.environmentFile)}`,
    `Environment=PROJECTS_CONFIG_PATH=${systemdEscape(resolve(paths.configDirectory, "projects.json"))}`,
    `Environment=RUNTIME_CONFIG_PATH=${systemdEscape(resolve(paths.configDirectory, "runtime.yaml"))}`,
    `Environment=BRIDGE_DATABASE_PATH=${systemdEscape(resolve(environment.BRIDGE_DATABASE_PATH || resolve(paths.stateDirectory, "bridge.db")))}`,
    ...(environment.HERDR_SOCKET_PATH ? [`Environment=HERDR_SOCKET_PATH=${systemdEscape(environment.HERDR_SOCKET_PATH)}`] : []),
    `Environment=BRIDGE_EXPECTED_BUILD_ID=${systemdEscape(identity.buildId)}`,
    `ExecStart=${systemdEscape(paths.nodeExecutable)} --enable-source-maps ${systemdEscape(paths.entrypoint)}`,
    `StandardOutput=append:${systemdEscape(paths.logFile)}`,
    `StandardError=append:${systemdEscape(paths.logFile)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "TimeoutStopSec=50",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

function requiredUserUnit(value: string | undefined): string | null {
  if (!value) return null;
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(value)) throw new Error("BRIDGE_REQUIRED_USER_UNIT must be one systemd .service unit name");
  return value;
}

function convergeLogPaths(paths: RuntimePaths): void {
  const existingDirectory = lstatOptional(paths.logDirectory);
  if (!existingDirectory) mkdirSync(paths.logDirectory, { mode: 0o700 });
  validateLogDirectory(paths.logDirectory);
  const directoryDescriptor = openSync(paths.logDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const openedDirectory = fstatSync(directoryDescriptor);
    if (!openedDirectory.isDirectory()) throw new Error(`private log directory must be a directory: ${paths.logDirectory}`);
    validatePrivateLogMetadata(paths.logDirectory, { kind: "directory", uid: openedDirectory.uid, nlink: openedDirectory.nlink });
    fchmodSync(directoryDescriptor, 0o700);
  } finally { closeSync(directoryDescriptor); }
  const descriptor = openRegularLogFile(paths.logFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
  try { fchmodSync(descriptor, 0o600); } finally { closeSync(descriptor); }
  for (const rotated of paths.rotatedLogFiles) validateOptionalRegularLogFile(rotated);
}

function rotateLogs(paths: RuntimePaths, renameFile: (source: string, destination: string) => void): void {
  const descriptor = openRegularLogFile(paths.logFile, constants.O_RDONLY);
  let size: number;
  try { size = fstatSync(descriptor).size; } finally { closeSync(descriptor); }
  if (size <= 16 * 1024 * 1024) return;
  for (const rotated of paths.rotatedLogFiles) validateOptionalRegularLogFile(rotated);
  const first = paths.rotatedLogFiles[0]!;
  const second = paths.rotatedLogFiles[1]!;
  const third = paths.rotatedLogFiles[2]!;
  const displaced = `${third}.pending-${process.pid}`;
  if (lstatOptional(displaced)) throw new Error(`stale log rotation file exists: ${displaced}`);
  const completed: Array<[string, string]> = [];
  try {
    const move = (source: string, destination: string) => { renameFile(source, destination); completed.push([source, destination]); };
    if (existsSync(third)) move(third, displaced);
    if (existsSync(second)) move(second, third);
    if (existsSync(first)) move(first, second);
    move(paths.logFile, first);
    const replacement = openRegularLogFile(paths.logFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL, 0o600);
    closeSync(replacement);
    if (existsSync(displaced)) unlinkSync(displaced);
  } catch (error) {
    for (const [source, destination] of completed.reverse()) {
      if (existsSync(destination)) renameFile(destination, source);
    }
    throw error;
  }
}

function openRegularLogFile(path: string, flags: number, mode?: number): number {
  const existing = lstatOptional(path);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error(`private log path must be a regular file without symlinks: ${path}`);
  if (existing) validatePrivateLogMetadata(path, { kind: "file", uid: existing.uid, nlink: existing.nlink });
  let descriptor: number;
  try { descriptor = openSync(path, flags | constants.O_NOFOLLOW, mode); } catch (error) {
    throw new Error(`private log path must be a regular file without symlinks: ${path} (${safeMessage(error)})`);
  }
  const opened = fstatSync(descriptor);
  if (!opened.isFile()) { closeSync(descriptor); throw new Error(`private log path must be a regular file: ${path}`); }
  try { validatePrivateLogMetadata(path, { kind: "file", uid: opened.uid, nlink: opened.nlink }); } catch (error) { closeSync(descriptor); throw error; }
  return descriptor;
}

function validateOptionalRegularLogFile(path: string): void {
  const status = lstatOptional(path);
  if (!status) return;
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`private log path must be a regular file without symlinks: ${path}`);
  validatePrivateLogMetadata(path, { kind: "file", uid: status.uid, nlink: status.nlink });
  const descriptor = openRegularLogFile(path, constants.O_RDONLY);
  closeSync(descriptor);
}

function validateLogDirectory(path: string): void {
  const directory = lstatSync(path);
  if (directory.isSymbolicLink()) throw new Error(`private log directory must not be a symlink: ${path}`);
  if (!directory.isDirectory()) throw new Error(`private log directory must be a directory: ${path}`);
  validatePrivateLogMetadata(path, { kind: "directory", uid: directory.uid, nlink: directory.nlink });
}

function lstatOptional(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function rewriteUnit(paths: RuntimePaths, environment: NodeJS.ProcessEnv): void {
  const runtimeEnvironment = loadRuntimeEnvironment(paths, environment);
  atomicWrite(paths.unitFile, renderUnit(paths, loadBuildIdentity(paths.buildInfo), runtimeEnvironment), 0o600);
}

function printLogs(paths: RuntimePaths, readChunk: typeof readSync, query: LogQueryOptions): number {
  validateLogDirectory(paths.logDirectory);
  if (!existsSync(paths.logFile)) throw new Error(`private service log is unavailable: ${paths.logFile}`);
  const linesLimit = boundedInteger(query.lines, 100, 1, 100_000, "--lines");
  const byteLimit = boundedInteger(query.maxBytes, 1024 * 1024, 1, 64 * 1024 * 1024, "--max-bytes");
  let remainingBytes = byteLimit;
  const files = query.includeRotated ? [...paths.rotatedLogFiles].reverse().concat(paths.logFile) : [paths.logFile];
  for (const path of files) validateOptionalRegularLogFile(path);
  const chunks: string[][] = [];
  for (const path of [...files].reverse()) {
    if (remainingBytes === 0 || !existsSync(path)) continue;
    const result = readLogTail(path, remainingBytes, readChunk);
    remainingBytes -= result.bytesRead;
    chunks.unshift(result.lines);
  }
  const filtered = chunks.flat().filter((line) => logLineMatches(line, query)).slice(-linesLimit);
  if (!query.json) {
    const bound = query.maxBytes === undefined ? "final 1 MiB maximum" : `final ${byteLimit} bytes maximum`;
    process.stdout.write(`private service log: ${paths.logFile} (final ${linesLimit} lines, ${bound}${query.includeRotated ? ", including rotated logs" : ""})\n`);
  }
  if (filtered.length > 0) process.stdout.write(`${filtered.join("\n")}\n`);
  return 0;
}

function readLogTail(path: string, maxBytes: number, readChunk: typeof readSync): { lines: string[]; bytesRead: number } {
  const descriptor = openRegularLogFile(path, constants.O_RDONLY);
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    const position = size - length;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readChunk(descriptor, buffer, bytesRead, length - bytesRead, position + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    let startsAtBoundary = position === 0;
    if (position > 0) {
      const preceding = Buffer.alloc(1);
      startsAtBoundary = readChunk(descriptor, preceding, 0, 1, position - 1) === 1 && preceding[0] === 0x0a;
    }
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (!startsAtBoundary) lines.shift();
    if (lines.at(-1) === "") lines.pop();
    return { lines, bytesRead };
  } finally { closeSync(descriptor); }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, option: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${option} must be an integer from ${minimum} to ${maximum}`);
  return result;
}

const LOG_LEVELS: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
function logLineMatches(line: string, query: LogQueryOptions): boolean {
  const structured = Boolean(query.json || query.level || query.since || query.component || query.eventId || query.bindingId || query.promptId || query.paneId || query.replyId);
  if (!structured) return true;
  let record: Record<string, unknown>;
  try { const parsed: unknown = JSON.parse(line); const normalized = asRecord(parsed); if (!normalized) return false; record = normalized; } catch { return false; }
  if (query.level) {
    const minimum = LOG_LEVELS[query.level];
    const actual = typeof record.level === "number" ? record.level : typeof record.level === "string" ? LOG_LEVELS[record.level] : undefined;
    if (minimum === undefined || actual === undefined || actual < minimum) return false;
  }
  if (query.since) {
    const since = Date.parse(query.since);
    const observed = typeof record.time === "number" ? record.time : typeof record.time === "string" ? Date.parse(record.time) : Number.NaN;
    if (!Number.isFinite(since) || !Number.isFinite(observed) || observed < since) return false;
  }
  const exact: Array<[keyof LogQueryOptions, string]> = [["component", "component"], ["eventId", "eventId"], ["bindingId", "bindingId"], ["promptId", "promptId"], ["paneId", "paneId"], ["replyId", "replyId"]];
  return exact.every(([option, field]) => query[option] === undefined || record[field] === query[option]);
}

export function parseLogQueryArgs(args: string[]): LogQueryOptions {
  const result: LogQueryOptions = {};
  const valueOptions: Record<string, keyof LogQueryOptions> = {
    "--lines": "lines", "--max-bytes": "maxBytes", "--level": "level", "--since": "since", "--component": "component",
    "--event-id": "eventId", "--binding-id": "bindingId", "--prompt-id": "promptId", "--pane-id": "paneId", "--reply-id": "replyId"
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--include-rotated") { result.includeRotated = true; continue; }
    if (option === "--json") { result.json = true; continue; }
    const key = valueOptions[option];
    const value = args[index + 1];
    if (!key || value === undefined || value.startsWith("--")) throw new Error(`invalid logs option: ${option}`);
    index += 1;
    if (key === "lines" || key === "maxBytes") (result as Record<string, unknown>)[key] = Number(value);
    else (result as Record<string, unknown>)[key] = value;
  }
  boundedInteger(result.lines, 100, 1, 100_000, "--lines");
  boundedInteger(result.maxBytes, 1024 * 1024, 1, 64 * 1024 * 1024, "--max-bytes");
  if (result.level && LOG_LEVELS[result.level] === undefined) throw new Error(`--level must be one of ${Object.keys(LOG_LEVELS).join(", ")}`);
  if (result.since && !Number.isFinite(Date.parse(result.since))) throw new Error("--since must be an ISO-8601 timestamp");
  return result;
}

function systemdEscape(value: string): string {
  if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("invalid systemd value");
  return value.replaceAll("%", "%%").replaceAll("\\", "\\x5c").replaceAll("\"", "\\x22").replaceAll(" ", "\\x20");
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
  let observedStatus = "unavailable";
  let observedBuildId = "unavailable";
  let observedStartupState = "unavailable";
  let observedOwnership = "unavailable";
  let unitState = "inactive";
  do {
    const active = isUnitActive(paths.serviceName, base);
    unitState = active ? "active" : "inactive";
    const startup = active ? await probeStartupStatus(config.http.host, config.http.port) : null;
    const ownership = active && startup?.connectedAddress ? probeListenerOwnership(paths.serviceName, startup.connectedAddress, config.http.port, base) : null;
    observedStatus = startup?.status ?? "unavailable";
    observedBuildId = startup?.buildId ?? "unavailable";
    observedStartupState = startup?.startupRecoveryState ?? "unavailable";
    observedOwnership = ownership?.detail ?? "unavailable";
    const healthy = (startup?.status === "ok" || startup?.status === "degraded") && startup.serviceId === AGENT_SWARM_SERVICE_ID
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
  throw new Error(`bridge ${action} did not complete startup with expected build ${expected.buildId} within ${timeoutMs}ms; unit ${unitState}; status ${observedStatus}; observed build ${observedBuildId}; startup ${observedStartupState}; listener ownership ${observedOwnership}; configured listener PID must belong to canonical unit MainPID; inspect systemctl --user status ${paths.serviceName}`);
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
  const unit = spawnSync("systemctl", ["--user", "show", serviceName, "--property", "MainPID", "--value"], { env: userSystemdEnvironment(environment), encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024 });
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
  const unit = spawnSync("systemctl", ["--user", "is-active", serviceName], { env: userSystemdEnvironment(environment), encoding: "utf8", timeout: 5_000 });
  return unit.status === 0 && unit.stdout.trim() === "active";
}

function userSystemdEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return resolveUserSystemdFallbackEnvironment(environment) ?? environment;
}

function isUnitConfirmedInactive(serviceName: string, environment: NodeJS.ProcessEnv): boolean {
  const activity = unitActivity(serviceName, environment);
  if (activity === "active") return false;
  if (activity === "inactive") return true;
  throw new Error(`cannot confirm ${serviceName} is inactive; refusing log rotation`);
}

function unitActivity(serviceName: string, environment: NodeJS.ProcessEnv): "active" | "inactive" | "indeterminate" {
  const unit = spawnSync("systemctl", ["--user", "is-active", serviceName], { env: userSystemdEnvironment(environment), encoding: "utf8", timeout: 5_000 });
  if (unit.status === 0 && unit.stdout.trim() === "active") return "active";
  if (unit.status === 3 && unit.stdout.trim() === "inactive") return "inactive";
  return "indeterminate";
}

function delegate(command: string, args: string[], environment: NodeJS.ProcessEnv, tolerateFailure = false): number {
  const commandEnvironment = command === "systemctl" && args[0] === "--user" ? userSystemdEnvironment(environment) : environment;
  const result = spawnSync(command, args, { env: commandEnvironment, encoding: "utf8", timeout: 30_000, stdio: "inherit" });
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
export function isServiceLifecycleEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath); } catch { return false; }
}

if (isServiceLifecycleEntrypoint(import.meta.url, process.argv[1])) {
  const validAction = action && ["install", "uninstall", "start", "status", "restart", "stop", "logs"].includes(action);
  const validRestart = action === "restart" && (flags.length === 0 || flags.length === 1 && flags[0] === "--force");
  const validLogs = action === "logs";
  const validPlain = action !== "restart" && action !== "logs" && flags.length === 0;
  if (!validAction || !(validRestart || validLogs || validPlain)) {
    process.stderr.write("usage: service-lifecycle <install|uninstall|start|status|restart|stop|logs> [--force for restart] [logs options]\n"); process.exitCode = 2;
  } else {
    let logQuery: LogQueryOptions | undefined;
    try { if (action === "logs") logQuery = parseLogQueryArgs(flags); } catch (error) { process.stderr.write(`service lifecycle failed: ${safeMessage(error)}\n`); process.exitCode = 2; }
    if (process.exitCode !== 2) runServiceLifecycle(action, process.env, { force: flags.includes("--force"), ...(logQuery ? { logQuery } : {}) }).then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`service lifecycle failed: ${safeMessage(error)}\n`); process.exitCode = 1; });
  }
}
