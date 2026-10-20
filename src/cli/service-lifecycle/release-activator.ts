import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BuildIdentity } from "../../runtime/build-identity.js";

export interface ReleaseActivationPaths {
  root: string;
  releasesDirectory: string;
  currentLink: string;
  activationMarker: string;
  activationUnitBackup: string;
  activationRotationUnitBackup: string;
  activationRotationTimerBackup: string;
  unitFile: string;
  rotationUnitFile: string;
  rotationTimerFile: string;
  serviceName: string;
}

type PriorEnabledState = "enabled" | "disabled" | "absent";
type Rename = typeof renameSync;

export interface ReleaseActivationInput {
  paths: ReleaseActivationPaths;
  environment: NodeJS.ProcessEnv;
  identity: BuildIdentity;
  candidateValue: string;
  ownedPlugin?: { activate(): void; rollback(): void };
  writeUnits(): void;
  runSystemd(args: string[], tolerateFailure?: boolean): number;
  readEnabledState(): Exclude<PriorEnabledState, "absent">;
  renameCurrentLink?: Rename;
  writeStdout(message: string): void;
  writeStderr(message: string): void;
}

interface PriorUnit { content: string; mode: number }
interface UnitTransition { path: string; backup: string; prior: PriorUnit | null }

export class ReleaseActivator {
  activate(input: ReleaseActivationInput): number {
    const { paths } = input;
    const candidate = validateReleaseCandidate(paths, input.candidateValue, input.identity);
    const keepInactive = releaseRetention(input.environment);
    const priorCurrent = readPriorCurrent(paths);
    const priorUnit = readPriorUnit(paths.unitFile);
    const priorRotationUnit = readPriorUnit(paths.rotationUnitFile);
    const priorRotationTimer = readPriorUnit(paths.rotationTimerFile);
    const priorUnitRelease = priorUnit ? releaseWorkingDirectory(paths, priorUnit.content) : null;
    const priorEnabled = priorUnit ? input.readEnabledState() : "absent";
    const priorUnits: UnitTransition[] = [
      { path: paths.unitFile, backup: paths.activationUnitBackup, prior: priorUnit },
      { path: paths.rotationUnitFile, backup: paths.activationRotationUnitBackup, prior: priorRotationUnit },
      { path: paths.rotationTimerFile, backup: paths.activationRotationTimerBackup, prior: priorRotationTimer }
    ];
    for (const unit of priorUnits) if (lstatOptional(unit.backup)) throw new Error(`release activation backup already exists: ${unit.backup}`);
    atomicWrite(paths.activationMarker, JSON.stringify({
      version: 1, candidate, priorCurrent,
      priorUnits: priorUnits.map(({ path, backup, prior }) => ({ path, backup: prior ? backup : null, mode: prior?.mode ?? null })),
      priorEnabled, phase: "prepared"
    }) + "\n", 0o600);

    let serviceMutationAttempted = false;
    try {
      input.ownedPlugin?.activate();
      for (const unit of priorUnits) if (unit.prior) writeFileSync(unit.backup, unit.prior.content, { mode: unit.prior.mode, flag: "wx" });
      mkdirSync(dirname(paths.unitFile), { recursive: true, mode: 0o700 });
      serviceMutationAttempted = true;
      input.writeUnits();
      let failureCode = input.runSystemd(["--user", "daemon-reload"]);
      if (failureCode !== 0) throw new ReleaseActivationCommandError("daemon-reload", failureCode);
      failureCode = input.runSystemd(["--user", "enable", paths.serviceName]);
      if (failureCode !== 0) throw new ReleaseActivationCommandError("enable", failureCode);
      replaceCurrentLink(paths, candidate, input.renameCurrentLink);
    } catch (error) {
      const rollbackFailures: string[] = [];
      if (serviceMutationAttempted) {
        try { restoreActivation(input, priorCurrent, priorUnits, priorEnabled); }
        catch (rollbackError) { rollbackFailures.push(`service: ${safeMessage(rollbackError)}`); }
      }
      try { input.ownedPlugin?.rollback(); }
      catch (rollbackError) { rollbackFailures.push(`owned plugin: ${safeMessage(rollbackError)}`); }
      if (rollbackFailures.length > 0) throw new Error(`release activation failed (${safeMessage(error)}); rollback failed (${rollbackFailures.join("; ")}); recovery marker retained at ${paths.activationMarker}`);
      removeActivationEvidence(paths);
      if (error instanceof ReleaseActivationCommandError) return error.exitCode;
      throw error;
    }

    try { removeActivationEvidence(paths); } catch (error) {
      throw new Error(`release activation committed but recovery marker cleanup failed (${safeMessage(error)}); inspect ${paths.activationMarker}`);
    }
    try {
      pruneReleases(paths, new Set([candidate, priorCurrent, priorUnitRelease].filter((path): path is string => path !== null)), keepInactive);
    } catch (error) {
      input.writeStderr(`release activation committed but release pruning failed: ${safeMessage(error)}\n`);
    }
    input.writeStdout(`installed ${paths.serviceName} at ${paths.unitFile}; activated ${candidate}\n`);
    return 0;
  }
}

class ReleaseActivationCommandError extends Error {
  constructor(operation: string, readonly exitCode: number) { super(`${operation} failed with exit code ${exitCode}`); }
}

function validateReleaseCandidate(paths: ReleaseActivationPaths, value: string, identity: BuildIdentity): string {
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

function readPriorCurrent(paths: ReleaseActivationPaths): string | null {
  const status = lstatOptional(paths.currentLink);
  if (!status) return null;
  if (!status.isSymbolicLink()) throw new Error(`current release path must be a symlink: ${paths.currentLink}`);
  const target = realpathSync(paths.currentLink);
  if (dirname(target) !== realpathSync(paths.releasesDirectory)) throw new Error(`current release must resolve under ${paths.releasesDirectory}`);
  if (!statSync(target).isDirectory()) throw new Error(`current release must resolve to a directory: ${target}`);
  return target;
}

function readPriorUnit(path: string): PriorUnit | null {
  if (!existsSync(path)) return null;
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`service unit must be a regular file: ${path}`);
  return { content: readFileSync(path, "utf8"), mode: status.mode & 0o777 };
}

function releaseWorkingDirectory(paths: ReleaseActivationPaths, unit: string): string | null {
  const value = unit.split("\n").map((line) => line.trim()).find((line) => line.startsWith("WorkingDirectory="))?.slice("WorkingDirectory=".length);
  if (!value || !existsSync(value)) return null;
  const candidate = realpathSync(value);
  const releases = realpathSync(paths.releasesDirectory);
  const status = lstatSync(candidate);
  if (!status.isDirectory() || status.isSymbolicLink() || dirname(candidate) !== releases) return null;
  return /^[a-f0-9]{64}-[a-f0-9]{12}$/.test(candidate.slice(releases.length + 1)) ? candidate : null;
}

function replaceCurrentLink(paths: ReleaseActivationPaths, target: string | null, renameLink: Rename = renameSync): void {
  const temporary = `${paths.currentLink}.tmp-${process.pid}`;
  if (lstatOptional(temporary)) unlinkSync(temporary);
  if (target === null) {
    if (lstatOptional(paths.currentLink)) unlinkSync(paths.currentLink);
    return;
  }
  symlinkSync(target, temporary);
  try { renameLink(temporary, paths.currentLink); } catch (error) { unlinkSync(temporary); throw error; }
}

function restoreActivation(input: ReleaseActivationInput, priorCurrent: string | null, priorUnits: readonly UnitTransition[], priorEnabled: PriorEnabledState): void {
  replaceCurrentLink(input.paths, priorCurrent, input.renameCurrentLink);
  if (priorEnabled !== "enabled") {
    const disabled = input.runSystemd(["--user", "disable", input.paths.serviceName], true);
    if (disabled !== 0) throw new Error(`rollback disable failed with exit code ${disabled}`);
  }
  for (const unit of priorUnits) {
    if (unit.prior) atomicWrite(unit.path, unit.prior.content, unit.prior.mode);
    else if (existsSync(unit.path)) unlinkSync(unit.path);
  }
  const reload = input.runSystemd(["--user", "daemon-reload"], true);
  if (reload !== 0) throw new Error(`rollback daemon-reload failed with exit code ${reload}`);
  if (priorEnabled === "enabled") {
    const enabled = input.runSystemd(["--user", "enable", input.paths.serviceName], true);
    if (enabled !== 0) throw new Error(`rollback enable failed with exit code ${enabled}`);
  }
}

function removeActivationEvidence(paths: ReleaseActivationPaths): void {
  for (const backup of [paths.activationUnitBackup, paths.activationRotationUnitBackup, paths.activationRotationTimerBackup]) if (lstatOptional(backup)) unlinkSync(backup);
  if (lstatOptional(paths.activationMarker)) unlinkSync(paths.activationMarker);
}

function releaseRetention(environment: NodeJS.ProcessEnv): number {
  const value = environment.SWARM_RELEASE_RETENTION ?? "3";
  if (!/^\d+$/.test(value)) throw new Error("SWARM_RELEASE_RETENTION must be a non-negative integer");
  return Number(value);
}

function pruneReleases(paths: ReleaseActivationPaths, retained: ReadonlySet<string>, keepInactive: number): void {
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

function atomicWrite(path: string, content: string, mode: number): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode, flag: "wx" });
  renameSync(temporary, path);
}

function lstatOptional(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 500); }
