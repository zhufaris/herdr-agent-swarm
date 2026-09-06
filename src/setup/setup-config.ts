import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { validateEnvironmentAndRegistry, validateProjectDirectories, validateProjectRegistry } from "../config.js";
import { readEnvironmentFile, serializeEnvironmentFile } from "../runtime/environment-file.js";
import type { SetupCheck, SetupConfigPort, SetupContext, SetupDraft } from "./setup-types.js";
import { defaultRuntimeTuning, loadRuntimeTuning, serializeRuntimeTuning, validateRuntimeTuning } from "../runtime-config.js";

export const setupEnvironmentOrder = [
  "LARK_APP_ID", "LARK_APP_SECRET", "LARK_CHAT_ID", "LARK_BOT_OPEN_ID", "LARK_ALLOWED_OPEN_IDS", "LARK_ADMIN_OPEN_IDS",
  "PROJECTS_CONFIG_PATH", "RUNTIME_CONFIG_PATH", "BRIDGE_DATABASE_PATH", "TRAEX_SESSIONS_ROOT",
  "HERDR_BIN", "TRAEX_BIN", "CODEX_BIN", "CLAUDE_CODE_BIN", "PI_BIN", "TRAEX_PERMISSION_MODE",
  "BRIDGE_HTTP_HOST", "BRIDGE_HTTP_PORT", "LOG_LEVEL",
  "COMMAND_TIMEOUT_MS", "LARK_REQUEST_TIMEOUT_MS", "TURN_TIMEOUT_MS", "RECONCILE_INTERVAL_MS",
  "OUTBOX_SAFETY_SCAN_INTERVAL_MS",
  "HERDR_CIRCUIT_FAILURE_THRESHOLD", "HERDR_CIRCUIT_OPEN_MS",
  "INSTANCE_LEASE_TTL_MS", "INSTANCE_LEASE_HEARTBEAT_MS", "MAX_QUEUE_DEPTH", "LARK_MESSAGE_CHUNK_SIZE",
  "OUTBOX_RETENTION_DAYS", "OUTBOX_RETENTION_BATCH_SIZE", "OUTBOX_RETENTION_MAX_BATCHES",
  "SQLITE_INTEGRITY_AUDIT_INTERVAL_MS"
] as const;

const processOnlyEnvironmentKeys = new Set([
  "PATH", "HOME",
  "SWARM_ROOT", "SWARM_CONFIG_DIR", "SWARM_STATE_DIR",
  "XDG_CONFIG_HOME", "XDG_STATE_HOME", "NODE_BIN"
]);

interface RepositoryOptions {
  now?: () => Date;
  replace?: (source: string, destination: string, replace: (source: string, destination: string) => Promise<void>) => Promise<void>;
}

interface ExistingPair {
  environmentFile: string;
  projectsFile: string;
  runtimeFile: string;
  exists: boolean;
}

export function renderSetupEnvironment(environment: Record<string, string>): string {
  const persisted = Object.fromEntries(Object.entries(environment).filter(([key]) => !processOnlyEnvironmentKeys.has(key)));
  return serializeEnvironmentFile(persisted, setupEnvironmentOrder);
}

export class FileSetupConfigRepository implements SetupConfigPort {
  private readonly now: () => Date;
  private readonly replace: NonNullable<RepositoryOptions["replace"]>;

  constructor(options: RepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.replace = options.replace ?? (async (source, destination, replace) => replace(source, destination));
  }

  async load(context: SetupContext): Promise<SetupDraft | null> {
    const existing = await this.inspectExistingPair(context);
    if (!existing.exists) return null;
    return this.readPair(existing);
  }

  async validate(draft: SetupDraft, context: SetupContext): Promise<SetupCheck[]> {
    const checks: SetupCheck[] = [];
    const ambiguity = await this.incompleteTransactionCheck(context);
    if (ambiguity) checks.push(ambiguity);

    try {
      validateEnvironmentAndRegistry(draft.environment, validateProjectRegistry(draft.registry));
      validateRuntimeTuning(draft.runtime ?? defaultRuntimeTuning());
      checks.push({ id: "config.schema", status: "pass", summary: "Configuration schema is valid" });
    } catch {
      checks.push({ id: "config.schema", status: "fail", summary: "Configuration does not satisfy the production schema", remediation: "Review the entered values and try again." });
    }

    try {
      validateProjectDirectories(draft.registry.projects);
      checks.push({ id: "config.directories", status: "pass", summary: "Project directories are accessible" });
    } catch {
      checks.push({ id: "config.directories", status: "fail", summary: "One or more project directories are inaccessible", remediation: "Choose accessible absolute project directories." });
    }

    try {
      const parent = await nearestExistingParent(context.configDirectory);
      await access(parent, constants.R_OK | constants.W_OK | constants.X_OK);
      checks.push({ id: "config.permissions", status: "pass", summary: "Private configuration permissions can be enforced" });
    } catch {
      checks.push({ id: "config.permissions", status: "fail", summary: "Private configuration permissions cannot be enforced", remediation: `Grant access to ${context.configDirectory}.` });
    }

    const host = draft.environment.BRIDGE_HTTP_HOST ?? "127.0.0.1";
    const port = Number(draft.environment.BRIDGE_HTTP_PORT ?? "8787");
    const validEndpoint = ["127.0.0.1", "localhost", "::1"].includes(host) && Number.isInteger(port) && port >= 1 && port <= 65535;
    checks.push(validEndpoint
      ? { id: "config.port", status: "pass", summary: `Loopback endpoint ${host}:${port} is valid` }
      : { id: "config.port", status: "fail", summary: "The HTTP endpoint is invalid or not loopback-only", remediation: "Choose a loopback host and a port from 1 to 65535." });

    if (!ambiguity && await pathExists(join(context.configDirectory, ".env")) && await pathExists(join(context.configDirectory, "projects.json"))) {
      try {
        await this.readPair(this.paths(context, true));
        checks.push({ id: "config.existing", status: "pass", summary: "Existing configuration is valid and can be backed up" });
      } catch {
        checks.push({ id: "config.existing", status: "fail", summary: "Existing configuration is invalid and will not be overwritten", remediation: `Repair or move the files in ${context.configDirectory}.` });
      }
    }
    return checks;
  }

  async commit(draft: SetupDraft, context: SetupContext) {
    await mkdir(context.configDirectory, { recursive: true, mode: 0o700 });
    await chmod(context.configDirectory, 0o700);
    const checks = await this.validate(draft, context);
    const incomplete = checks.find((check) => check.id === "config.incomplete-transaction" && check.status === "fail");
    if (incomplete) throw new Error(`Refusing to overwrite an incomplete configuration transaction. ${incomplete.remediation ?? ""}`.trim());
    if (checks.some((check) => check.status === "fail")) {
      const existingInvalid = checks.some((check) => check.id === "config.existing" && check.status === "fail");
      throw new Error(existingInvalid ? "Refusing to overwrite because existing configuration is invalid" : "Refusing to commit invalid setup configuration");
    }

    const paths = this.paths(context, false);
    const environmentDraft = join(context.configDirectory, ".setup-env.draft");
    const projectsDraft = join(context.configDirectory, ".setup-projects.draft");
    const runtimeDraft = join(context.configDirectory, ".setup-runtime.draft");
    const marker = join(context.configDirectory, ".setup-transaction.json");
    const existing = await this.inspectExistingPair(context);
    let backupDirectory: string | undefined;
    let markerWritten = false;
    let replacementStarted = false;
    try {
      await writePrivateFile(environmentDraft, renderSetupEnvironment(draft.environment));
      await writePrivateFile(projectsDraft, `${JSON.stringify(draft.registry, null, 2)}\n`);
      await writePrivateFile(runtimeDraft, serializeRuntimeTuning(validateRuntimeTuning(draft.runtime ?? defaultRuntimeTuning())));
      if (existing.exists) {
        backupDirectory = await this.createBackup(existing, context);
      }
      markerWritten = true;
      await writePrivateFile(marker, `${JSON.stringify({ backupDirectory: backupDirectory ?? null, environmentFile: paths.environmentFile, projectsFile: paths.projectsFile, runtimeFile: paths.runtimeFile }, null, 2)}\n`);
      replacementStarted = true;
      await this.replace(environmentDraft, paths.environmentFile, rename);
      await this.replace(projectsDraft, paths.projectsFile, rename);
      await this.replace(runtimeDraft, paths.runtimeFile, rename);
      await syncDirectory(context.configDirectory);
      await rm(marker, { force: true });
      markerWritten = false;
      await syncDirectory(context.configDirectory);
      return { ...paths, ...(backupDirectory ? { backupDirectory } : {}) };
    } catch (error) {
      let recovery: string;
      try {
        if (!replacementStarted) {
          recovery = existing.exists ? "left previous configuration unchanged" : "left configuration uncommitted";
        } else if (existing.exists && backupDirectory) {
          await copyPrivateFile(join(backupDirectory, ".env"), paths.environmentFile);
          await copyPrivateFile(join(backupDirectory, "projects.json"), paths.projectsFile);
          const backedUpRuntime = join(backupDirectory, "runtime.yaml");
          if (await pathExists(backedUpRuntime)) await copyPrivateFile(backedUpRuntime, paths.runtimeFile);
          else await rm(paths.runtimeFile, { force: true });
          recovery = "restored previous configuration";
        } else {
          await rm(paths.environmentFile, { force: true });
          await rm(paths.projectsFile, { force: true });
          await rm(paths.runtimeFile, { force: true });
          recovery = "removed incomplete configuration";
        }
        if (markerWritten) await rm(marker, { force: true });
        await syncDirectory(context.configDirectory);
      } catch {
        throw new Error(`Configuration commit failed and automatic recovery was incomplete. Inspect ${marker}${backupDirectory ? ` and ${backupDirectory}` : ""}.`, { cause: error });
      }
      throw new Error(`Configuration commit failed; ${recovery}.`, { cause: error });
    } finally {
      await rm(environmentDraft, { force: true });
      await rm(projectsDraft, { force: true });
      await rm(runtimeDraft, { force: true });
    }
  }

  private paths(context: SetupContext, exists: boolean): ExistingPair {
    return {
      environmentFile: context.environmentFile ?? join(context.configDirectory, ".env"),
      projectsFile: context.projectsFile ?? join(context.configDirectory, "projects.json"),
      runtimeFile: context.runtimeFile ?? join(context.configDirectory, "runtime.yaml"),
      exists
    };
  }

  private async inspectExistingPair(context: SetupContext): Promise<ExistingPair> {
    const paths = this.paths(context, false);
    const [environmentExists, projectsExist] = await Promise.all([pathExists(paths.environmentFile), pathExists(paths.projectsFile)]);
    if (environmentExists !== projectsExist) throw new Error(`Incomplete configuration transaction in ${context.configDirectory}; restore the private configuration set before continuing.`);
    if (await pathExists(join(context.configDirectory, ".setup-transaction.json"))) {
      throw new Error(`Incomplete configuration transaction marker at ${join(context.configDirectory, ".setup-transaction.json")}.`);
    }
    return { ...paths, exists: environmentExists };
  }

  private async incompleteTransactionCheck(context: SetupContext): Promise<SetupCheck | undefined> {
    const marker = join(context.configDirectory, ".setup-transaction.json");
    const { environmentFile, projectsFile } = this.paths(context, false);
    const [markerExists, environmentExists, projectsExist] = await Promise.all([pathExists(marker), pathExists(environmentFile), pathExists(projectsFile)]);
    if (!markerExists && environmentExists === projectsExist) return undefined;
    let backupPath = context.configDirectory;
    if (markerExists) {
      try {
        const parsed = JSON.parse(await readFile(marker, "utf8")) as { backupDirectory?: unknown };
        if (typeof parsed.backupDirectory === "string") backupPath = parsed.backupDirectory;
      } catch {}
    }
    return {
      id: "config.incomplete-transaction", status: "fail", summary: "A prior or partial configuration transaction requires recovery",
      remediation: `Inspect the private backup at ${backupPath} and restore a complete .env/projects.json set; runtime.yaml is optional for legacy installations.`
    };
  }

  private async readPair(pair: ExistingPair): Promise<SetupDraft> {
    const environment = Object.fromEntries(Object.entries(readEnvironmentFile(pair.environmentFile)).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const registry = validateProjectRegistry(JSON.parse(await readFile(pair.projectsFile, "utf8")));
    validateEnvironmentAndRegistry(environment, registry);
    const runtime = loadRuntimeTuning(pair.runtimeFile);
    return { environment, registry, runtime };
  }

  private async createBackup(existing: ExistingPair, context: SetupContext): Promise<string> {
    const timestamp = this.now().toISOString().replace(/:/g, "-");
    const backupDirectory = join(context.configDirectory, `backup-${timestamp}`);
    await mkdir(backupDirectory, { mode: 0o700 });
    await chmod(backupDirectory, 0o700);
    await copyPrivateFile(existing.environmentFile, join(backupDirectory, ".env"));
    await copyPrivateFile(existing.projectsFile, join(backupDirectory, "projects.json"));
    if (await pathExists(existing.runtimeFile)) await copyPrivateFile(existing.runtimeFile, join(backupDirectory, "runtime.yaml"));
    await syncDirectory(backupDirectory);
    return backupDirectory;
  }
}

async function writePrivateFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function copyPrivateFile(source: string, destination: string): Promise<void> {
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  const handle = await open(destination, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function nearestExistingParent(path: string): Promise<string> {
  let candidate = path;
  while (!(await pathExists(candidate))) {
    const parent = join(candidate, "..");
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}
