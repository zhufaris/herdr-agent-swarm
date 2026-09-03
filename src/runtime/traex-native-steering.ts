import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { TraexSessionPeer } from "./traex-session-peer.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;

export type NativeSteerResult =
  | { status: "delivered"; operationId: string; turnId: string }
  | { status: "not-active"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "unsupported"; reason: string }
  | { status: "delivery-uncertain"; operationId: string; reason: string };

interface OperationRecord {
  version: 1;
  operationId: string;
  fingerprint: string;
  state: "dispatching" | "delivered" | "rejected" | "uncertain";
  result: NativeSteerResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface NativeSteerInput {
  peer: TraexSessionPeer;
  expectedTurnId: string;
  text: string;
  idempotencyKey: string;
}

export interface NativeSteeringOptions {
  operationDir: string;
  timeoutMs?: number;
  callPeer?: (peer: TraexSessionPeer, expectedTurnId: string, text: string, timeoutMs: number) => Promise<string>;
  now?: () => Date;
}

export async function steerTraexTurn(input: NativeSteerInput, options: NativeSteeringOptions): Promise<NativeSteerResult> {
  validate(input);
  const operationId = createHash("sha256").update(input.idempotencyKey).digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify([input.peer.threadId, input.expectedTurnId, input.text])).digest("hex");
  await mkdir(options.operationDir, { recursive: true, mode: 0o700 });
  await chmod(options.operationDir, 0o700);
  const path = join(options.operationDir, `${operationId}.json`);
  const existing = await readRecord(path);
  if (existing) return replay(existing, fingerprint);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const dispatching: OperationRecord = { version: 1, operationId, fingerprint, state: "dispatching", result: null, createdAt: timestamp, updatedAt: timestamp };
  if (!await createRecord(path, dispatching)) return replayRequired(path, fingerprint);
  try {
    const turnId = await (options.callPeer ?? callTraexPeer)(input.peer, input.expectedTurnId, input.text, options.timeoutMs ?? 10_000);
    const result: NativeSteerResult = turnId === input.expectedTurnId
      ? { status: "delivered", operationId, turnId }
      : { status: "delivery-uncertain", operationId, reason: "TraeX returned a different runtime turn ID" };
    await replaceRecord(path, { ...dispatching, state: result.status === "delivered" ? "delivered" : "uncertain", result, updatedAt: (options.now ?? (() => new Date()))().toISOString() });
    return result;
  } catch (error) {
    const explicit = classifyExplicitError(error);
    const result: NativeSteerResult = explicit ?? { status: "delivery-uncertain", operationId, reason: boundedError(error) };
    await replaceRecord(path, { ...dispatching, state: explicit ? "rejected" : "uncertain", result, updatedAt: (options.now ?? (() => new Date()))().toISOString() });
    return result;
  }
}

async function callTraexPeer(peer: TraexSessionPeer, expectedTurnId: string, text: string, timeoutMs: number): Promise<string> {
  const metadata = await stat(peer.socketPath);
  if (!metadata.isSocket() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("TraeX session peer socket failed ownership or permission validation");
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path: peer.socketPath });
    let buffer = "";
    let bytes = 0;
    let initialized = false;
    let settled = false;
    const finish = (error?: Error, turnId?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(turnId!);
    };
    const timer = setTimeout(() => finish(new Error("TraeX steering response timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESPONSE_BYTES) return finish(new Error("TraeX steering response exceeded the byte limit"));
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { return finish(new Error("TraeX steering returned invalid JSON")); }
        if (message.id === "native-steer:init") {
          if (message.error) return finish(rpcError(message.error));
          initialized = true;
          socket.write(`${JSON.stringify({ method: "initialized" })}\n`);
          socket.write(`${JSON.stringify({ method: "turn/steer", id: "native-steer:dispatch", params: { threadId: peer.threadId, expectedTurnId, input: [{ type: "text", text, text_elements: [] }] } })}\n`);
        } else if (message.id === "native-steer:dispatch") {
          if (!initialized) return finish(new Error("TraeX steering response arrived before initialization"));
          if (message.error) return finish(rpcError(message.error));
          const result = message.result as Record<string, unknown> | undefined;
          if (!result || typeof result.turnId !== "string") return finish(new Error("TraeX steering returned an invalid result"));
          finish(undefined, result.turnId);
        }
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ method: "initialize", id: "native-steer:init", params: { clientInfo: { name: "herdr-traex-shim", title: "Herdr TraeX shim", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } } })}\n`));
  });
}

function validate(input: NativeSteerInput): void {
  if (!SAFE_ID.test(input.expectedTurnId)) throw new Error("Invalid expected runtime turn ID");
  if (!input.text.trim()) throw new Error("Steering text must not be empty");
  if (!input.idempotencyKey || input.idempotencyKey.length > 512 || input.idempotencyKey.includes("\0")) throw new Error("Invalid steering idempotency key");
}

function classifyExplicitError(error: unknown): NativeSteerResult | null {
  const message = boundedError(error);
  if (/activeTurnNotSteerable|not steerable|approval|elicitation/i.test(message)) return { status: "blocked", reason: message };
  if (/expected.?turn|no active turn|turn (?:is )?(?:not active|not found)|thread (?:is )?(?:not active|not found)/i.test(message)) return { status: "not-active", reason: message };
  if (/method not found|unsupported|experimentalApi/i.test(message)) return { status: "unsupported", reason: message };
  return null;
}

function rpcError(value: unknown): Error {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const details = record.data === undefined ? "" : ` ${JSON.stringify(record.data)}`;
  return new Error(`${typeof record.message === "string" ? record.message : "TraeX app-server request failed"}${details}`.slice(0, 1000));
}

async function createRecord(path: string, record: OperationRecord): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try { await link(temporary, path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  } catch (error) {
    throw error;
  } finally { await handle?.close(); await unlink(temporary).catch(() => undefined); }
}

async function replaceRecord(path: string, record: OperationRecord): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

async function readRecord(path: string): Promise<OperationRecord | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0 || metadata.size > 16 * 1024) throw new Error("Invalid native steering operation record");
    return JSON.parse(await handle.readFile("utf8")) as OperationRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally { await handle?.close(); }
}

async function replayRequired(path: string, fingerprint: string): Promise<NativeSteerResult> {
  const record = await readRecord(path);
  if (!record) throw new Error("Native steering operation record disappeared");
  return replay(record, fingerprint);
}

function replay(record: OperationRecord, fingerprint: string): NativeSteerResult {
  if (record.fingerprint !== fingerprint) throw new Error("Steering idempotency key was reused for a different request");
  if (record.result) return record.result;
  return { status: "delivery-uncertain", operationId: record.operationId, reason: "A previous steering dispatch did not persist a terminal receipt" };
}

function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " " ).slice(0, 500); }
