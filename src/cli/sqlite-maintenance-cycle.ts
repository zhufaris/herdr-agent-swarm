import { createHash, randomUUID } from "node:crypto";
import { createReadStream, chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvironmentFile } from "../runtime/environment-file.js";
import { backupSqliteDatabase, drainSqliteRetention, proveSqliteLeaseReleased, validateSqliteMaintenanceDatabase, vacuumSqliteDatabase } from "../store/sqlite-maintenance.js";
import { inspectServiceLifecycle, runServiceLifecycle } from "./service-lifecycle.js";

export interface SqliteMaintenanceValidation {
  path: string;
  quickCheck: "ok" | "failed";
  foreignKeyIssues: number;
  semanticIssues: number;
  schemaValid: boolean;
}

export interface SqliteMaintenanceSmoke {
  health: string;
  readiness: string;
  status: string;
}

export interface SqliteMaintenanceDependencies {
  now(): number;
  createCycleId(): string;
  stopAdmission(): Promise<void>;
  stopService(): Promise<void>;
  proveLeaseReleased(databasePath: string): void;
  backupDatabase(source: string, destination: string): Promise<void>;
  drainRetention(databasePath: string, deadlineAt: number): Promise<{ compacted: number; refusals: Record<string, number> }>;
  vacuumInto(source: string, destination: string): Promise<void>;
  validateDatabase(path: string, role: "backup" | "candidate"): SqliteMaintenanceValidation;
  startService(): Promise<void>;
  smoke(): Promise<SqliteMaintenanceSmoke>;
}

export interface SqliteMaintenanceInput {
  databasePath: string;
  stateDirectory: string;
  serviceName: string;
  deadlineMs?: number;
  resumeCycleId?: string;
}

const CANONICAL_SERVICE_NAME = "herdr-agent-swarm.service";

interface FileIdentity { path: string; size: number; mtimeMs: number; sha256: string }

export interface SqliteMaintenanceResult {
  cycleId: string;
  outcome: "completed" | "rolled_back";
  completedPhase: string;
  backup: FileIdentity;
  candidate: FileIdentity;
  original: FileIdentity;
  validations: SqliteMaintenanceValidation[];
  retention: { compacted: number; refusals: Record<string, number> };
  smoke: SqliteMaintenanceSmoke | null;
  activated: boolean;
  rolledBack: boolean;
}

interface CycleRecord extends Omit<SqliteMaintenanceResult, "outcome"> {
  schemaVersion: 1;
  outcome: "running" | SqliteMaintenanceResult["outcome"];
  databasePath: string;
  deadlineAt: number;
  updatedAt: string;
  sourceIdentity?: FileIdentity;
}

export async function runSqliteMaintenanceCycle(input: SqliteMaintenanceInput, overrides: Partial<SqliteMaintenanceDependencies> = {}): Promise<SqliteMaintenanceResult> {
  const dependencies = resolveDependencies(overrides);
  if (input.serviceName !== CANONICAL_SERVICE_NAME) throw new Error(`unsupported SQLite maintenance service: ${input.serviceName}`);
  const databasePath = resolve(input.databasePath);
  const stateDirectory = resolve(input.stateDirectory);
  const deadlineMs = input.deadlineMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 15 * 60_000) throw new Error("maintenance deadline must be between 1 and 900000 milliseconds");
  if (!input.resumeCycleId || existsSync(databasePath)) validatePrivateDatabase(databasePath);
  else ensurePrivateDirectory(dirname(databasePath));
  ensurePrivateDirectory(stateDirectory);
  const journalDirectory = join(stateDirectory, "sqlite-maintenance");
  ensurePrivateDirectory(journalDirectory);
  const cycleId = input.resumeCycleId ?? dependencies.createCycleId();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(cycleId)) throw new Error("invalid SQLite maintenance cycle id");
  const stem = `${databasePath}.maintenance-${cycleId}`;
  const backupPath = `${stem}.backup`;
  const candidatePath = `${stem}.candidate`;
  const originalPath = `${stem}.original`;
  const failedCandidatePath = `${stem}.failed`;
  const journalPath = join(journalDirectory, `${cycleId}.json`);
  const emptyIdentity = (path: string): FileIdentity => ({ path, size: 0, mtimeMs: 0, sha256: "" });
  let record: CycleRecord;
  if (input.resumeCycleId) {
    record = loadJournal(journalPath);
    validateResumeJournal(record, { cycleId, databasePath, backupPath, candidatePath, originalPath, journalPath });
    record.deadlineAt = dependencies.now() + deadlineMs;
    record.updatedAt = iso(dependencies.now());
  } else {
    for (const path of [backupPath, candidatePath, originalPath, `${originalPath}-wal`, `${originalPath}-shm`, failedCandidatePath, journalPath]) {
      if (existsSync(path)) throw new Error(`maintenance cycle path already exists: ${path}`);
    }
    record = {
      schemaVersion: 1, cycleId, outcome: "running", completedPhase: "preflight", databasePath,
      deadlineAt: dependencies.now() + deadlineMs, updatedAt: iso(dependencies.now()),
      backup: emptyIdentity(backupPath), candidate: emptyIdentity(candidatePath), original: emptyIdentity(originalPath),
      validations: [], retention: { compacted: 0, refusals: {} }, smoke: null, activated: false, rolledBack: false
    };
  }
  writeJournal(journalPath, record);
  let serviceStopped = phaseReached(record.completedPhase, "service_stopped") && !phaseReached(record.completedPhase, "service_started");
  try {
    if (record.completedPhase === "candidate_validated") {
      await reconcileInterruptedActivation(databasePath, candidatePath, originalPath, journalPath, record, dependencies.now());
      validatePrivateDatabase(databasePath);
    }
    if (!phaseReached(record.completedPhase, "admission_stopped")) {
      await dependencies.stopAdmission();
      assertDeadline(record, dependencies.now());
      savePhase(journalPath, record, "admission_stopped", dependencies.now());
    }
    if (!phaseReached(record.completedPhase, "service_stopped")) {
      assertDeadline(record, dependencies.now());
      await dependencies.stopService();
      serviceStopped = true;
      assertDeadline(record, dependencies.now());
      savePhase(journalPath, record, "service_stopped", dependencies.now());
    }
    if (!phaseReached(record.completedPhase, "lease_released")) {
      dependencies.proveLeaseReleased(databasePath);
      savePhase(journalPath, record, "lease_released", dependencies.now());
    }
    if (!phaseReached(record.completedPhase, "backup_created")) {
      assertDeadline(record, dependencies.now());
      await dependencies.backupDatabase(databasePath, backupPath);
      assertDeadline(record, dependencies.now());
      chmodSync(backupPath, 0o600);
      record.backup = await identifyFile(backupPath);
      savePhase(journalPath, record, "backup_created", dependencies.now());
    } else assertSameIdentity(record.backup, await identifyFile(record.backup.path), "maintenance backup identity changed");
    if (!phaseReached(record.completedPhase, "backup_validated")) {
      const backupValidation = dependencies.validateDatabase(record.backup.path, "backup");
      assertValidation(backupValidation, "backup");
      record.validations.push(backupValidation);
      savePhase(journalPath, record, "backup_validated", dependencies.now());
    }
    if (!phaseReached(record.completedPhase, "retention_drained")) {
      record.retention = await dependencies.drainRetention(databasePath, record.deadlineAt);
      assertDeadline(record, dependencies.now());
      savePhase(journalPath, record, "retention_drained", dependencies.now());
    }
    if (!phaseReached(record.completedPhase, "candidate_created")) {
      assertDeadline(record, dependencies.now());
      const sourceIdentity = await identifyFile(databasePath);
      await dependencies.vacuumInto(databasePath, candidatePath);
      assertDeadline(record, dependencies.now());
      chmodSync(candidatePath, 0o600);
      record.candidate = await identifyFile(candidatePath);
      record.sourceIdentity = sourceIdentity;
      savePhase(journalPath, record, "candidate_created", dependencies.now());
    } else if (!phaseReached(record.completedPhase, "activated")) {
      assertSameIdentity(record.candidate, await identifyFile(record.candidate.path), "maintenance candidate identity changed");
    }
    if (!phaseReached(record.completedPhase, "candidate_validated")) {
      const candidateValidation = dependencies.validateDatabase(record.candidate.path, "candidate");
      assertValidation(candidateValidation, "candidate");
      record.validations.push(candidateValidation);
      savePhase(journalPath, record, "candidate_validated", dependencies.now());
    }
    if (!phaseReached(record.completedPhase, "activated")) {
      const sourceIdentity = record.sourceIdentity;
      if (!sourceIdentity) throw new Error("maintenance source identity is missing");
      assertSameIdentity(sourceIdentity, await identifyFile(databasePath), "active database changed after candidate creation");
      assertDeadline(record, dependencies.now());
      activateCandidate(databasePath, candidatePath, originalPath);
      record.original = await identifyFile(originalPath);
      record.activated = true;
      savePhase(journalPath, record, "activated", dependencies.now());
    }
    if (!phaseReached(record.completedPhase, "service_started")) {
      await dependencies.startService();
      serviceStopped = false;
      assertDeadline(record, dependencies.now());
      savePhase(journalPath, record, "service_started", dependencies.now());
    }
    if (!phaseReached(record.completedPhase, "smoke_passed")) {
      record.smoke = await dependencies.smoke();
      assertDeadline(record, dependencies.now());
      assertSmoke(record.smoke);
    }
    record.outcome = "completed";
    savePhase(journalPath, record, "smoke_passed", dependencies.now());
    return publicResult(record);
  } catch (error) {
    if (record.activated) {
      try {
        await dependencies.stopService();
        serviceStopped = true;
        restoreOriginal(databasePath, originalPath, failedCandidatePath);
        record.rolledBack = true;
        record.activated = false;
      } catch (rollbackError) {
        savePhase(journalPath, record, "rollback_failed", dependencies.now());
        throw new AggregateError([error, rollbackError], "SQLite maintenance failed and rollback was incomplete");
      }
    }
    try { await dependencies.startService(); serviceStopped = false; } catch (startError) {
      savePhase(journalPath, record, "restart_failed", dependencies.now());
      throw new AggregateError([error, startError], "SQLite maintenance failed and service restart was unsuccessful");
    }
    record.outcome = "rolled_back";
    record.rolledBack = true;
    savePhase(journalPath, record, "rolled_back", dependencies.now());
    throw new Error(`SQLite maintenance rolled back: ${safeMessage(error)}`, { cause: error });
  }
}

async function reconcileInterruptedActivation(
  databasePath: string,
  candidatePath: string,
  originalPath: string,
  journalPath: string,
  record: CycleRecord,
  now: number
): Promise<void> {
  const activeExists = existsSync(databasePath);
  const candidateExists = existsSync(candidatePath);
  const originalExists = existsSync(originalPath);
  if (activeExists && candidateExists && !originalExists) {
    validatePrivateRegularFile(candidatePath, "maintenance candidate");
    return;
  }
  if (activeExists && !candidateExists && originalExists) {
    validatePrivateRegularFile(originalPath, "maintenance original");
    if (!record.sourceIdentity) throw new Error("maintenance source identity is missing");
    assertSameIdentity(record.candidate, await identifyFile(databasePath), "activated candidate identity does not match journal");
    assertSameIdentity(record.sourceIdentity, await identifyFile(originalPath), "preserved original identity does not match journal");
    record.original = await identifyFile(originalPath);
    record.activated = true;
    savePhase(journalPath, record, "activated", now);
    return;
  }
  if (!activeExists && candidateExists && originalExists) {
    validatePrivateRegularFile(candidatePath, "maintenance candidate");
    validatePrivateRegularFile(originalPath, "maintenance original");
    renameSync(originalPath, databasePath);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(`${originalPath}${suffix}`)) {
      renameSync(`${originalPath}${suffix}`, `${databasePath}${suffix}`);
    }
    syncDirectory(dirname(databasePath));
    return;
  }
  throw new Error("maintenance activation filesystem state is inconsistent with journal");
}

export async function runSqliteMaintenanceCommand(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<SqliteMaintenanceDependencies>
): Promise<SqliteMaintenanceResult> {
  const previousUmask = process.umask(0o077);
  try {
    const options = parseCommandArguments(args);
    const stateDirectory = resolve(environment.SWARM_STATE_DIR
      || `${environment.XDG_STATE_HOME || `${homedir()}/.local/state`}/herdr-agent-swarm`);
    const configDirectory = resolve(environment.SWARM_CONFIG_DIR
      || `${environment.XDG_CONFIG_HOME || `${homedir()}/.config`}/herdr-agent-swarm`);
    const configured = loadMaintenanceEnvironment(environment, configDirectory, stateDirectory);
    const databasePath = resolve(configured.BRIDGE_DATABASE_PATH || join(stateDirectory, "bridge.db"));
    const input: SqliteMaintenanceInput = {
      databasePath,
      stateDirectory,
      serviceName: CANONICAL_SERVICE_NAME,
      deadlineMs: options.deadlineMs,
      ...(options.resumeCycleId ? { resumeCycleId: options.resumeCycleId } : {})
    };
    return await runSqliteMaintenanceCycle(input, overrides ?? operatorDependencies(configured, CANONICAL_SERVICE_NAME));
  } finally {
    process.umask(previousUmask);
  }
}

function parseCommandArguments(args: readonly string[]): { deadlineMs: number; resumeCycleId?: string } {
  let deadlineMs = 15 * 60_000;
  let resumeCycleId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--deadline-ms" && value !== undefined) {
      deadlineMs = Number(value);
      index += 1;
    } else if (argument === "--resume" && value !== undefined) {
      resumeCycleId = value;
      index += 1;
    } else {
      throw new Error("usage: sqlite-maintenance-cycle [--deadline-ms 1..900000] [--resume cycle-id]");
    }
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 15 * 60_000) {
    throw new Error("maintenance deadline must be between 1 and 900000 milliseconds");
  }
  if (resumeCycleId !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(resumeCycleId)) throw new Error("invalid SQLite maintenance cycle id");
  return { deadlineMs, ...(resumeCycleId ? { resumeCycleId } : {}) };
}

function loadMaintenanceEnvironment(base: NodeJS.ProcessEnv, configDirectory: string, stateDirectory: string): NodeJS.ProcessEnv {
  const environmentFile = join(configDirectory, ".env");
  const configured = existsSync(environmentFile) ? readEnvironmentFile(environmentFile) : {};
  return { ...base, ...configured, SWARM_CONFIG_DIR: configDirectory, SWARM_STATE_DIR: stateDirectory };
}

function operatorDependencies(environment: NodeJS.ProcessEnv, serviceName: string): Partial<SqliteMaintenanceDependencies> {
  if (serviceName !== CANONICAL_SERVICE_NAME) throw new Error(`unsupported SQLite maintenance service: ${serviceName}`);
  return {
    stopAdmission: async () => {
      const code = await runServiceLifecycle("stop", environment);
      if (code !== 0) throw new Error(`failed to stop admission through ${serviceName}`);
    },
    stopService: async () => {
      const code = await runServiceLifecycle("stop", environment);
      if (code !== 0) throw new Error(`failed to stop ${serviceName}`);
      const state = await inspectServiceLifecycle(environment);
      if (state.active) throw new Error(`${serviceName} remains active after graceful stop`);
    },
    startService: async () => {
      const code = await runServiceLifecycle("start", environment, { requireReady: true });
      if (code !== 0) throw new Error(`failed to start ${serviceName}`);
    },
    smoke: () => smokeMaintenanceEndpoints(environment)
  };
}

async function smokeMaintenanceEndpoints(environment: NodeJS.ProcessEnv): Promise<SqliteMaintenanceSmoke> {
  const host = environment.BRIDGE_HTTP_HOST || "127.0.0.1";
  const port = Number(environment.BRIDGE_HTTP_PORT || "8788");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("invalid BRIDGE_HTTP_PORT for maintenance smoke");
  const [health, readiness, status] = await Promise.all([
    readEndpointStatus(host, port, "/health"),
    readEndpointStatus(host, port, "/ready"),
    readEndpointStatus(host, port, "/status")
  ]);
  return { health, readiness, status };
}

async function readEndpointStatus(host: string, port: number, path: string): Promise<string> {
  const response = await fetch(`http://${host}:${port}${path}`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`maintenance smoke ${path} returned HTTP ${response.status}`);
  const body = await response.json() as { status?: unknown };
  if (typeof body.status !== "string") throw new Error(`maintenance smoke ${path} omitted status`);
  return body.status;
}

function activateCandidate(databasePath: string, candidatePath: string, originalPath: string): void {
  renameSync(databasePath, originalPath);
  const movedSidecars: string[] = [];
  let candidateActivated = false;
  try {
    for (const suffix of ["-wal", "-shm"]) {
      const source = `${databasePath}${suffix}`;
      if (!existsSync(source)) continue;
      const destination = `${originalPath}${suffix}`;
      renameSync(source, destination);
      chmodSync(destination, 0o600);
      movedSidecars.push(suffix);
    }
    renameSync(candidatePath, databasePath);
    candidateActivated = true;
    chmodSync(databasePath, 0o600);
    syncDirectory(dirname(databasePath));
  } catch (error) {
    if (candidateActivated && existsSync(databasePath)) renameSync(databasePath, candidatePath);
    for (const suffix of movedSidecars.reverse()) {
      if (existsSync(`${originalPath}${suffix}`)) renameSync(`${originalPath}${suffix}`, `${databasePath}${suffix}`);
    }
    if (existsSync(originalPath)) renameSync(originalPath, databasePath);
    syncDirectory(dirname(databasePath));
    throw error;
  }
}

function restoreOriginal(databasePath: string, originalPath: string, failedCandidatePath: string): void {
  if (existsSync(databasePath)) renameSync(databasePath, failedCandidatePath);
  if (existsSync(originalPath)) renameSync(originalPath, databasePath);
  for (const suffix of ["-wal", "-shm"]) {
    const preserved = `${originalPath}${suffix}`;
    if (existsSync(preserved)) renameSync(preserved, `${databasePath}${suffix}`);
  }
  chmodSync(databasePath, 0o600);
  for (const suffix of ["-wal", "-shm"]) if (existsSync(`${databasePath}${suffix}`)) chmodSync(`${databasePath}${suffix}`, 0o600);
  syncDirectory(dirname(databasePath));
}

function resolveDependencies(overrides: Partial<SqliteMaintenanceDependencies>): SqliteMaintenanceDependencies {
  const unavailable = (operation: string) => async (): Promise<never> => { throw new Error(`SQLite maintenance ${operation} adapter is unavailable`); };
  const clock = overrides.now ?? Date.now;
  return {
    now: clock,
    createCycleId: randomUUID,
    stopAdmission: unavailable("admission stop"),
    stopService: unavailable("service stop"),
    proveLeaseReleased: proveSqliteLeaseReleased,
    backupDatabase: backupSqliteDatabase,
    drainRetention: (path, deadlineAt) => drainSqliteRetention(path, deadlineAt, clock),
    vacuumInto: vacuumSqliteDatabase,
    validateDatabase: validateSqliteMaintenanceDatabase,
    startService: unavailable("service start"),
    smoke: unavailable("smoke"),
    ...overrides
  };
}

const PHASES = ["preflight", "admission_stopped", "service_stopped", "lease_released", "backup_created", "backup_validated", "retention_drained", "candidate_created", "candidate_validated", "activated", "service_started", "smoke_passed"] as const;
function phaseReached(actual: string, expected: typeof PHASES[number]): boolean {
  const actualIndex = PHASES.indexOf(actual as typeof PHASES[number]);
  return actualIndex >= PHASES.indexOf(expected);
}

function loadJournal(path: string): CycleRecord {
  validatePrivateRegularFile(path, "maintenance journal");
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`maintenance journal is unreadable: ${path}`, { cause: error }); }
  if (!parsed || typeof parsed !== "object" || (parsed as Partial<CycleRecord>).schemaVersion !== 1) throw new Error(`maintenance journal is invalid: ${path}`);
  return parsed as CycleRecord;
}

function validateResumeJournal(record: CycleRecord, expected: {
  cycleId: string; databasePath: string; backupPath: string; candidatePath: string; originalPath: string; journalPath: string;
}): void {
  const phaseIndex = PHASES.indexOf(record.completedPhase as typeof PHASES[number]);
  const invalid = record.cycleId !== expected.cycleId
    || resolve(record.databasePath) !== expected.databasePath
    || record.outcome !== "running"
    || phaseIndex < 0
    || !Number.isSafeInteger(record.deadlineAt)
    || Number.isNaN(Date.parse(record.updatedAt))
    || !isFileIdentity(record.backup, expected.backupPath)
    || !isFileIdentity(record.candidate, expected.candidatePath)
    || !isFileIdentity(record.original, expected.originalPath)
    || !Array.isArray(record.validations)
    || !record.retention || typeof record.retention.compacted !== "number" || !record.retention.refusals || typeof record.retention.refusals !== "object"
    || record.rolledBack !== false
    || (phaseIndex >= PHASES.indexOf("activated") ? record.activated !== true : record.activated !== false)
    || (phaseIndex >= PHASES.indexOf("candidate_created") && !isFileIdentity(record.sourceIdentity, expected.databasePath));
  if (invalid) throw new Error(`maintenance journal is invalid and cannot be resumed: ${expected.journalPath}`);
}

function isFileIdentity(value: unknown, expectedPath: string): value is FileIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<FileIdentity>;
  return identity.path === expectedPath
    && typeof identity.size === "number" && Number.isSafeInteger(identity.size) && identity.size >= 0
    && typeof identity.mtimeMs === "number" && Number.isFinite(identity.mtimeMs) && identity.mtimeMs >= 0
    && typeof identity.sha256 === "string" && (identity.sha256 === "" || /^[a-f0-9]{64}$/.test(identity.sha256));
}

function validatePrivateDatabase(path: string): void {
  const metadata = lstatSync(path);
  const uid = process.geteuid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error(`database must be a single-link regular file without symlinks: ${path}`);
  if (uid === undefined || metadata.uid !== uid) throw new Error(`database must be owned by the effective user: ${path}`);
  if ((metadata.mode & 0o777) !== 0o600) throw new Error(`database must already have mode 0600: ${path}`);
  ensurePrivateDirectory(dirname(path));
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) if (existsSync(sidecar)) {
    const sidecarMetadata = lstatSync(sidecar);
    if (!sidecarMetadata.isFile() || sidecarMetadata.isSymbolicLink() || sidecarMetadata.uid !== uid || sidecarMetadata.nlink !== 1) throw new Error(`database sidecar must be a same-user single-link regular file: ${sidecar}`);
    if ((sidecarMetadata.mode & 0o777) !== 0o600) throw new Error(`database sidecar must already have mode 0600: ${sidecar}`);
  }
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  const uid = process.geteuid?.();
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`maintenance directory must be a real directory: ${path}`);
  if (uid === undefined || metadata.uid !== uid) throw new Error(`maintenance directory must be owned by the effective user: ${path}`);
  if ((metadata.mode & 0o777) !== 0o700) throw new Error(`maintenance directory must already have mode 0700: ${path}`);
}

function validatePrivateRegularFile(path: string, description: string): void {
  const metadata = lstatSync(path);
  const uid = process.geteuid?.();
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error(`${description} must be a single-link regular file without symlinks: ${path}`);
  if (uid === undefined || metadata.uid !== uid) throw new Error(`${description} must be owned by the effective user: ${path}`);
  if ((metadata.mode & 0o777) !== 0o600) throw new Error(`${description} must have mode 0600: ${path}`);
}

async function identifyFile(path: string): Promise<FileIdentity> {
  const metadata = statSync(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return { path, size: metadata.size, mtimeMs: metadata.mtimeMs, sha256: hash.digest("hex") };
}

function assertSameIdentity(expected: FileIdentity, actual: FileIdentity, message: string): void {
  if (expected.size !== actual.size || expected.mtimeMs !== actual.mtimeMs || expected.sha256 !== actual.sha256) throw new Error(message);
}

function assertValidation(validation: SqliteMaintenanceValidation, role: string): void {
  if (validation.quickCheck !== "ok" || validation.foreignKeyIssues !== 0 || validation.semanticIssues !== 0 || !validation.schemaValid) {
    throw new Error(`${role} database validation failed`);
  }
}

function assertSmoke(smoke: SqliteMaintenanceSmoke): void {
  if (smoke.health !== "ok" || smoke.readiness !== "ready" || !["ok", "degraded"].includes(smoke.status)) throw new Error("maintenance smoke check failed");
}

function assertDeadline(record: CycleRecord, now: number): void {
  if (now >= record.deadlineAt) throw new Error("maintenance deadline exhausted");
}

function savePhase(path: string, record: CycleRecord, phase: string, now: number): void {
  record.completedPhase = phase;
  record.updatedAt = iso(now);
  writeJournal(path, record);
}

function writeJournal(path: string, record: CycleRecord): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function publicResult(record: CycleRecord): SqliteMaintenanceResult {
  return {
    cycleId: record.cycleId, outcome: record.outcome as SqliteMaintenanceResult["outcome"], completedPhase: record.completedPhase,
    backup: record.backup, candidate: record.candidate, original: record.original, validations: record.validations,
    retention: record.retention, smoke: record.smoke, activated: record.activated, rolledBack: record.rolledBack
  };
}

function iso(value: number): string { return new Date(value).toISOString(); }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function isEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath); } catch { return false; }
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  runSqliteMaintenanceCommand(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`SQLite maintenance failed: ${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}
