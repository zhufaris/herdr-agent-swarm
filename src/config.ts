import { z } from "zod";

const environmentSchema = z.object({
  LARK_APP_ID: z.string().min(1),
  LARK_APP_SECRET: z.string().min(1),
  LARK_CHAT_ID: z.string().min(1),
  LARK_BOT_OPEN_ID: z.string().min(1),
  HERDR_WORKSPACE_ID: z.string().min(1),
  HERDR_WORKSPACE_CWD: z.string().min(1).default(process.cwd()),
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
  return {
    lark: { appId: value.LARK_APP_ID, appSecret: value.LARK_APP_SECRET, chatId: value.LARK_CHAT_ID, botOpenId: value.LARK_BOT_OPEN_ID },
    herdr: { workspaceId: value.HERDR_WORKSPACE_ID, workspaceCwd: value.HERDR_WORKSPACE_CWD, executable: value.HERDR_BIN },
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
