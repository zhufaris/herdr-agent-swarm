import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { z } from "zod";

const MAX_INPUT_BYTES = 64 * 1024;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inputSchema = z.object({
  hook_event_name: z.literal("SessionStart"),
  session_id: z.string().regex(SESSION_ID),
  source: z.string().min(1).max(64).optional()
}).passthrough();

interface SessionReportRequest {
  id: string;
  method: "pane.report_agent_session";
  params: {
    pane_id: string; source: string; agent: string; seq: number;
    agent_session_id: string; session_start_source: string;
  };
}

type SocketSender = (socketPath: string, request: SessionReportRequest) => Promise<void>;

export async function reportTraexSession(
  rawInput: string,
  environment: NodeJS.ProcessEnv = process.env,
  send: SocketSender = sendSocketRequest
): Promise<"reported" | "dropped"> {
  if (Buffer.byteLength(rawInput) > MAX_INPUT_BYTES || environment.HERDR_ENV !== "1") return "dropped";
  const paneId = environment.HERDR_PANE_ID;
  const socketPath = environment.HERDR_SOCKET_PATH;
  if (!paneId || !socketPath) return "dropped";
  const parsed = inputSchema.safeParse(parseJson(rawInput));
  if (!parsed.success) return "dropped";
  await send(socketPath, {
    id: `herdr-lark-bridge:session:${randomUUID()}`,
    method: "pane.report_agent_session",
    params: {
      pane_id: paneId, source: "herdr-lark-bridge:traex", agent: "traex", seq: Date.now(),
      agent_session_id: parsed.data.session_id, session_start_source: parsed.data.source ?? "startup"
    }
  });
  return "reported";
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function sendSocketRequest(socketPath: string, request: SessionReportRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Herdr session report timed out")); }, 500);
    timer.unref();
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.once("data", () => finish());
    socket.once("error", finish);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_INPUT_BYTES) return "";
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  readStdin().then((input) => reportTraexSession(input)).catch(() => undefined);
}
