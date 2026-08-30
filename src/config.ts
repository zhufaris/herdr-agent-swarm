import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { ProjectConfig } from "./domain/types.js";

const projectInstanceSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  role: z.enum(["primary", "worker"]),
  agent: z.enum(["pi", "claude-code", "codex", "traex"]),
  model: z.string().trim().min(1).optional(),
  workspace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("main-checkout") }),
    z.object({ kind: z.literal("git-worktree"), baseRef: z.string().trim().min(1), branchName: z.string().trim().min(1).optional() }),
    z.object({ kind: z.literal("shared-read-only") })
  ])
});
const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  displayName: z.string().trim().min(1),
  spaceName: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  cwd: z.string().refine(isAbsolute, "cwd must be an absolute path"),
  maxInstances: z.number().int().min(1).max(64).default(8),
  instances: z.array(projectInstanceSchema).default([])
}).superRefine((project, context) => {
  const names = new Set<string>();
  let primaryCount = 0;
  for (const instance of project.instances) {
    if (names.has(instance.name)) context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate instance name: ${instance.name}` });
    names.add(instance.name);
    if (instance.role === "primary") primaryCount += 1;
    if (instance.role === "worker" && instance.workspace.kind === "main-checkout") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `worker instance cannot use main checkout: ${instance.name}` });
    }
  }
  if (primaryCount > 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "project has multiple primary instances" });
  if (project.instances.length > project.maxInstances) context.addIssue({ code: z.ZodIssueCode.custom, message: "project exceeds maxInstances" });
});
const projectRegistrySchema = z.object({
  defaultProjectId: z.string().min(1),
  projects: z.array(projectSchema).min(1)
}).superRefine((registry, context) => {
  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const project of registry.projects) {
    if (ids.has(project.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate project id: ${project.id}` });
    ids.add(project.id);
    const route = `${project.workspaceId}\0${project.cwd}`;
    if (routes.has(route)) context.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate project route: ${project.workspaceId} ${project.cwd}` });
    routes.add(route);
  }
  if (!ids.has(registry.defaultProjectId)) context.addIssue({ code: z.ZodIssueCode.custom, message: "defaultProjectId must reference a configured project" });
});

const environmentSchema = z.object({
  LARK_APP_ID: z.string().min(1),
  LARK_APP_SECRET: z.string().min(1),
  LARK_CHAT_ID: z.string().min(1),
  LARK_BOT_OPEN_ID: z.string().min(1),
  LARK_OPERATOR_OPEN_IDS: z.string().default(""),
  PROJECTS_CONFIG_PATH: z.string().min(1).default("./config/projects.json"),
  BRIDGE_DATABASE_PATH: z.string().min(1).default("./var/bridge.db"),
  BRIDGE_HTTP_HOST: z.enum(["127.0.0.1", "localhost", "::1"]).default("127.0.0.1"),
  BRIDGE_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HERDR_BIN: z.string().min(1).default("herdr"),
  TRAEX_BIN: z.string().min(1).default("traex"),
  TRAEX_PERMISSION_MODE: z.enum(["default", "bypass_permissions", "auto"]).default("auto"),
  TRAEX_SESSIONS_ROOT: z.string().min(1).default(resolve(homedir(), ".trae/cli/sessions")),
  CODEX_BIN: z.string().min(1).default("codex"),
  CLAUDE_CODE_BIN: z.string().min(1).default("claude"),
  PI_BIN: z.string().min(1).default("pi"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  LARK_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(3_600_000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  HERDR_SNAPSHOT_CACHE_TTL_MS: z.coerce.number().int().min(0).max(60_000).default(2_000),
  OUTBOX_SAFETY_SCAN_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  CARD_UPDATE_DEBOUNCE_MS: z.coerce.number().int().min(0).max(10_000).default(500),
  HERDR_EVENT_DEBOUNCE_MS: z.coerce.number().int().min(0).max(5_000).default(100),
  HERDR_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(3),
  HERDR_CIRCUIT_OPEN_MS: z.coerce.number().int().min(100).max(300_000).default(15_000),
  INSTANCE_LEASE_TTL_MS: z.coerce.number().int().min(3_000).default(15_000),
  INSTANCE_LEASE_HEARTBEAT_MS: z.coerce.number().int().min(500).default(5_000),
  MAX_QUEUE_DEPTH: z.coerce.number().int().positive().default(20),
  LARK_MESSAGE_CHUNK_SIZE: z.coerce.number().int().min(500).max(20_000).default(3_500),
  OUTBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  OUTBOX_RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(500),
  OUTBOX_RETENTION_MAX_BATCHES: z.coerce.number().int().min(1).max(100).default(20),
  SQLITE_INTEGRITY_AUDIT_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000)
});

export type BridgeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = environmentSchema.parse(withPluginDefaults(environment));
  const registry = loadProjectRegistry(value.PROJECTS_CONFIG_PATH);
  return buildConfig(value, registry);
}

function buildConfig(
  value: z.infer<typeof environmentSchema>,
  registry: { defaultProjectId: string; projects: ProjectConfig[] }
) {
  if (value.INSTANCE_LEASE_HEARTBEAT_MS * 2 >= value.INSTANCE_LEASE_TTL_MS) {
    throw new Error("INSTANCE_LEASE_HEARTBEAT_MS must be less than half of INSTANCE_LEASE_TTL_MS");
  }
  const defaultProject = registry.projects.find((project) => project.id === registry.defaultProjectId)!;
  return {
    lark: { appId: value.LARK_APP_ID, appSecret: value.LARK_APP_SECRET, chatId: value.LARK_CHAT_ID, botOpenId: value.LARK_BOT_OPEN_ID, requestTimeoutMs: value.LARK_REQUEST_TIMEOUT_MS, operatorOpenIds: [...new Set(value.LARK_OPERATOR_OPEN_IDS.split(",").map((item) => item.trim()).filter(Boolean))] },
    herdr: { workspaceId: defaultProject.workspaceId, workspaceCwd: defaultProject.cwd, executable: value.HERDR_BIN },
    projects: registry.projects,
    defaultProjectId: registry.defaultProjectId,
    projectsConfigPath: value.PROJECTS_CONFIG_PATH,
    traex: { executable: value.TRAEX_BIN, permissionMode: value.TRAEX_PERMISSION_MODE, sessionsRoot: value.TRAEX_SESSIONS_ROOT },
    agents: { codex: value.CODEX_BIN, claudeCode: value.CLAUDE_CODE_BIN, pi: value.PI_BIN },
    databasePath: value.BRIDGE_DATABASE_PATH,
    http: { host: value.BRIDGE_HTTP_HOST, port: value.BRIDGE_HTTP_PORT },
    logLevel: value.LOG_LEVEL,
    commandTimeoutMs: value.COMMAND_TIMEOUT_MS,
    turnTimeoutMs: value.TURN_TIMEOUT_MS,
    reconcileIntervalMs: value.RECONCILE_INTERVAL_MS,
    runtimeTuning: {
      herdrSnapshotCacheTtlMs: value.HERDR_SNAPSHOT_CACHE_TTL_MS,
      outboxSafetyScanIntervalMs: value.OUTBOX_SAFETY_SCAN_INTERVAL_MS,
      cardUpdateDebounceMs: value.CARD_UPDATE_DEBOUNCE_MS,
      herdrEventDebounceMs: value.HERDR_EVENT_DEBOUNCE_MS
    },
    herdrCircuitBreaker: { failureThreshold: value.HERDR_CIRCUIT_FAILURE_THRESHOLD, openMs: value.HERDR_CIRCUIT_OPEN_MS },
    instanceLease: { ttlMs: value.INSTANCE_LEASE_TTL_MS, heartbeatMs: value.INSTANCE_LEASE_HEARTBEAT_MS },
    maxQueueDepth: value.MAX_QUEUE_DEPTH,
    larkMessageChunkSize: value.LARK_MESSAGE_CHUNK_SIZE,
    outboxRetention: { days: value.OUTBOX_RETENTION_DAYS, batchSize: value.OUTBOX_RETENTION_BATCH_SIZE, maxBatches: value.OUTBOX_RETENTION_MAX_BATCHES },
    sqliteIntegrityAudit: { intervalMs: value.SQLITE_INTEGRITY_AUDIT_INTERVAL_MS, issueLimit: 20 }
  } as const;
}

export function withPluginDefaults(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const configDirectory = environment.HERDR_PLUGIN_CONFIG_DIR;
  const stateDirectory = environment.HERDR_PLUGIN_STATE_DIR;
  return {
    ...environment,
    ...(!environment.PROJECTS_CONFIG_PATH && configDirectory ? { PROJECTS_CONFIG_PATH: `${configDirectory}/projects.json` } : {}),
    ...(!environment.BRIDGE_DATABASE_PATH && stateDirectory ? { BRIDGE_DATABASE_PATH: `${stateDirectory}/bridge.db` } : {})
  };
}

function loadProjectRegistry(path: string): { defaultProjectId: string; projects: ProjectConfig[] } {
  if (!existsSync(path)) throw new Error(`Project registry not found at ${path}`);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return validateProjectRegistry(raw);
}

export function validateProjectRegistry(raw: unknown) {
  return projectRegistrySchema.parse(raw);
}

export function validateEnvironmentAndRegistry(
  environment: NodeJS.ProcessEnv,
  registry: { defaultProjectId: string; projects: ProjectConfig[] }
) {
  return buildConfig(environmentSchema.parse(withPluginDefaults(environment)), registry);
}

export function validateProjectRegistryFile(path: string): void {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  validateProjectRegistry(raw);
}

export function validateProjectDirectories(projects: readonly ProjectConfig[]): void {
  for (const project of projects) {
    let isDirectory = false;
    try { isDirectory = statSync(project.cwd).isDirectory(); } catch {}
    if (!isDirectory) throw new Error(`Project directory is not accessible: ${project.id} (${project.cwd})`);
  }
}

export function projectSpaceName(project: ProjectConfig): string {
  return project.spaceName?.trim() || basename(project.cwd) || project.displayName;
}
