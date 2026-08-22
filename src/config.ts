import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { ProjectConfig } from "./domain/types.js";

const projectSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/),
  displayName: z.string().trim().min(1),
  description: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  cwd: z.string().refine(isAbsolute, "cwd must be an absolute path")
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
  HERDR_WORKSPACE_ID: z.string().min(1).optional(),
  HERDR_WORKSPACE_CWD: z.string().min(1).optional(),
  PROJECTS_CONFIG_PATH: z.string().min(1).default("./config/projects.json"),
  BRIDGE_DATABASE_PATH: z.string().min(1).default("./var/bridge.db"),
  BRIDGE_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  BRIDGE_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HERDR_BIN: z.string().min(1).default("herdr"),
  TRAEX_BIN: z.string().min(1).default("traex"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(3_600_000),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  MAX_QUEUE_DEPTH: z.coerce.number().int().positive().default(20),
  LARK_MESSAGE_CHUNK_SIZE: z.coerce.number().int().min(500).max(20_000).default(3_500)
});

export type BridgeConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const value = environmentSchema.parse(environment);
  const registry = loadProjectRegistry(value.PROJECTS_CONFIG_PATH, value.HERDR_WORKSPACE_ID, value.HERDR_WORKSPACE_CWD);
  const defaultProject = registry.projects.find((project) => project.id === registry.defaultProjectId)!;
  return {
    lark: { appId: value.LARK_APP_ID, appSecret: value.LARK_APP_SECRET, chatId: value.LARK_CHAT_ID, botOpenId: value.LARK_BOT_OPEN_ID },
    herdr: { workspaceId: defaultProject.workspaceId, workspaceCwd: defaultProject.cwd, executable: value.HERDR_BIN },
    projects: registry.projects,
    defaultProjectId: registry.defaultProjectId,
    projectsConfigPath: value.PROJECTS_CONFIG_PATH,
    traex: { executable: value.TRAEX_BIN },
    databasePath: value.BRIDGE_DATABASE_PATH,
    http: { host: value.BRIDGE_HTTP_HOST, port: value.BRIDGE_HTTP_PORT },
    logLevel: value.LOG_LEVEL,
    commandTimeoutMs: value.COMMAND_TIMEOUT_MS,
    turnTimeoutMs: value.TURN_TIMEOUT_MS,
    reconcileIntervalMs: value.RECONCILE_INTERVAL_MS,
    maxQueueDepth: value.MAX_QUEUE_DEPTH,
    larkMessageChunkSize: value.LARK_MESSAGE_CHUNK_SIZE
  } as const;
}

function loadProjectRegistry(path: string, legacyWorkspaceId?: string, legacyCwd?: string): { defaultProjectId: string; projects: ProjectConfig[] } {
  if (existsSync(path)) {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    return projectRegistrySchema.parse(raw);
  }
  if (!legacyWorkspaceId || !legacyCwd) throw new Error(`Project registry not found at ${path} and legacy Herdr project is incomplete`);
  if (!isAbsolute(legacyCwd)) throw new Error("HERDR_WORKSPACE_CWD must be an absolute path");
  const registry = {
    defaultProjectId: "default",
    projects: [{ id: "default", displayName: "Default project", description: "Legacy Herdr workspace", workspaceId: legacyWorkspaceId, cwd: legacyCwd }]
  };
  return registry;
}

export function validateProjectDirectories(projects: readonly ProjectConfig[]): void {
  for (const project of projects) {
    let isDirectory = false;
    try { isDirectory = statSync(project.cwd).isDirectory(); } catch {}
    if (!isDirectory) throw new Error(`Project directory is not accessible: ${project.id} (${project.cwd})`);
  }
}
