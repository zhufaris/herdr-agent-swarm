import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const OWNED_TRAEX_CHOICE_PLUGIN_NAME = "herdr-choice-list";
export const OWNED_TRAEX_CHOICE_PLUGIN_VERSION = "1.0.0";

export type TraexPluginCommandRunner = (args: string[], tolerateFailure?: boolean) => number;

export interface OwnedTraexChoicePluginOptions {
  releaseRoot: string;
  stateDirectory: string;
  traeHome: string;
  buildId: string;
  run: TraexPluginCommandRunner;
}

interface ActivationRecord {
  schemaVersion: 1;
  pluginName: typeof OWNED_TRAEX_CHOICE_PLUGIN_NAME;
  pluginVersion: typeof OWNED_TRAEX_CHOICE_PLUGIN_VERSION;
  buildId: string;
  sourcePath: string;
  helperPath: string;
  socketPath: string;
}

export class OwnedTraexChoicePluginActivation {
  private prior: { record: ActivationRecord; content: string } | null | undefined;
  private mutationAttempted = false;
  private rolledBack = false;

  constructor(private readonly options: OwnedTraexChoicePluginOptions) {}

  activate(): void {
    const candidate = candidateRecord(this.options);
    validateCandidateFiles(candidate);
    requireCommand(this.options.run, ["plugin", "validate", "--path", candidate.sourcePath], "candidate plugin validation");
    this.prior = readOwnedActivation(this.options);
    if (!this.prior && this.options.run(["plugin", "validate", OWNED_TRAEX_CHOICE_PLUGIN_NAME], true) === 0) {
      throw new Error(`installed plugin ${OWNED_TRAEX_CHOICE_PLUGIN_NAME} is not owned by ${OWNED_TRAEX_CHOICE_PLUGIN_NAME} activation data`);
    }

    this.mutationAttempted = true;
    requireInstall(this.options.run, candidate.sourcePath);
    requireCommand(this.options.run, ["plugin", "enable", OWNED_TRAEX_CHOICE_PLUGIN_NAME], "plugin enable");
    requireCommand(this.options.run, ["plugin", "validate", OWNED_TRAEX_CHOICE_PLUGIN_NAME], "installed plugin validation");
    writeActivation(this.options, candidate);
  }

  rollback(): void {
    if (this.rolledBack || !this.mutationAttempted) return;
    this.rolledBack = true;
    if (this.prior) {
      validateCandidateFiles(this.prior.record);
      requireCommand(this.options.run, ["plugin", "validate", "--path", this.prior.record.sourcePath], "previous plugin validation");
      requireInstall(this.options.run, this.prior.record.sourcePath);
      requireCommand(this.options.run, ["plugin", "enable", OWNED_TRAEX_CHOICE_PLUGIN_NAME], "previous plugin enable");
      requireCommand(this.options.run, ["plugin", "validate", OWNED_TRAEX_CHOICE_PLUGIN_NAME], "restored plugin validation");
      writeActivationContent(this.options, this.prior.content);
      return;
    }
    const result = this.options.run(["plugin", "uninstall", OWNED_TRAEX_CHOICE_PLUGIN_NAME], true);
    if (result !== 0) throw new Error(`plugin rollback uninstall failed with exit code ${result}`);
    removeOwnedActivation(this.options);
  }
}

export function uninstallOwnedTraexChoicePlugin(options: OwnedTraexChoicePluginOptions): number {
  const prior = readOwnedActivation(options);
  if (!prior) return 0;
  const result = options.run(["plugin", "uninstall", OWNED_TRAEX_CHOICE_PLUGIN_NAME], true);
  if (result !== 0) return result;
  removeOwnedActivation(options);
  return 0;
}

function candidateRecord(options: OwnedTraexChoicePluginOptions): ActivationRecord {
  const releaseRoot = resolve(options.releaseRoot);
  return {
    schemaVersion: 1,
    pluginName: OWNED_TRAEX_CHOICE_PLUGIN_NAME,
    pluginVersion: OWNED_TRAEX_CHOICE_PLUGIN_VERSION,
    buildId: options.buildId,
    sourcePath: join(releaseRoot, "plugins", OWNED_TRAEX_CHOICE_PLUGIN_NAME),
    helperPath: join(releaseRoot, "dist/cli/completion-choice-stop-hook.js"),
    socketPath: join(resolve(options.stateDirectory), "completion-choice-eligibility.sock")
  };
}

function validateCandidateFiles(record: ActivationRecord): void {
  requireRegularDirectory(record.sourcePath, "choice plugin source");
  requireRegularFile(join(record.sourcePath, ".codex-plugin/plugin.json"), "choice plugin manifest");
  requireRegularFile(join(record.sourcePath, "hooks/hooks.json"), "choice plugin Hook config");
  requireRegularFile(join(record.sourcePath, "skills/herdr-choice-list/SKILL.md"), "choice plugin Skill");
  requireRegularFile(join(record.sourcePath, "scripts/herdr-choice-stop-hook.mjs"), "choice plugin wrapper");
  requireRegularFile(record.helperPath, "choice Hook helper");
  const manifest = parseObject(readFileSync(join(record.sourcePath, ".codex-plugin/plugin.json"), "utf8"), "choice plugin manifest");
  if (manifest.name !== OWNED_TRAEX_CHOICE_PLUGIN_NAME || manifest.version !== OWNED_TRAEX_CHOICE_PLUGIN_VERSION) {
    throw new Error("choice plugin manifest identity is incompatible with the service lifecycle");
  }
}

function readOwnedActivation(options: OwnedTraexChoicePluginOptions): { record: ActivationRecord; content: string } | null {
  const path = activationPath(options);
  if (!existsSync(path)) return null;
  requireRegularFile(path, "choice plugin activation data");
  const content = readFileSync(path, "utf8");
  const value = parseObject(content, "choice plugin activation data");
  if (
    value.schemaVersion !== 1
    || value.pluginName !== OWNED_TRAEX_CHOICE_PLUGIN_NAME
    || value.pluginVersion !== OWNED_TRAEX_CHOICE_PLUGIN_VERSION
    || typeof value.buildId !== "string"
    || typeof value.sourcePath !== "string" || !value.sourcePath.startsWith("/")
    || typeof value.helperPath !== "string" || !value.helperPath.startsWith("/")
    || typeof value.socketPath !== "string" || !value.socketPath.startsWith("/")
  ) throw new Error(`choice plugin activation data is malformed or unowned: ${path}`);
  return { record: value as unknown as ActivationRecord, content };
}

function writeActivation(options: OwnedTraexChoicePluginOptions, record: ActivationRecord): void {
  writeActivationContent(options, `${JSON.stringify(record)}\n`);
}

function writeActivationContent(options: OwnedTraexChoicePluginOptions, content: string): void {
  const directory = pluginDataDirectory(options);
  ensurePrivateDirectory(directory);
  atomicWrite(activationPath(options), content, 0o600);
}

function removeOwnedActivation(options: OwnedTraexChoicePluginOptions): void {
  const path = activationPath(options);
  if (existsSync(path)) unlinkSync(path);
  const directory = pluginDataDirectory(options);
  if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory);
}

function pluginDataDirectory(options: OwnedTraexChoicePluginOptions): string {
  return join(resolve(options.traeHome), "plugins", "data", OWNED_TRAEX_CHOICE_PLUGIN_NAME);
}

function activationPath(options: OwnedTraexChoicePluginOptions): string {
  return join(pluginDataDirectory(options), "activation.json");
}

function requireInstall(run: TraexPluginCommandRunner, sourcePath: string): void {
  requireCommand(run, ["plugin", "install", sourcePath, "--type", "local", "--name", OWNED_TRAEX_CHOICE_PLUGIN_NAME, "--yes"], "plugin install");
}

function requireCommand(run: TraexPluginCommandRunner, args: string[], operation: string): void {
  const result = run(args);
  if (result !== 0) throw new Error(`${operation} failed with exit code ${result}`);
}

function ensurePrivateDirectory(path: string): void {
  if (existsSync(path)) {
    const status = lstatSync(path);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`refusing unsafe choice plugin data directory: ${path}`);
  } else mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function requireRegularDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`${label} must be a regular directory: ${path}`);
}

function requireRegularFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`${label} must be a regular file: ${path}`);
}

function parseObject(content: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new Error(`${label} is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode, flag: "wx" });
  renameSync(temporary, path);
}
