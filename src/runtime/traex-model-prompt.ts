import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import type { TraexSessionPeer } from "./traex-session-peer.js";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 256 * 1024;

interface ModelPromptRecord {
  version: 1; operationId: string; target: string; threadId: string; socketPath: string; peerPid: number; peerStartedAtMs: number;
  model: string; revision: number; promptSha256: string; state: "prepared" | "dispatching" | "accepted" | "rejected" | "uncertain";
  turnId: string | null; detail: string | null; createdAt: string; updatedAt: string;
}
export interface ModelPromptResult { operationId: string; state: ModelPromptRecord["state"]; turnId: string | null; detail: string | null }
export interface ModelPromptOptions { operationDir: string; timeoutMs?: number; now?: () => Date; callTurnStart?: (peer: TraexSessionPeer, text: string, model: string, timeoutMs: number) => Promise<string> }

export async function prepareTraexModelPrompt(input: { peer: TraexSessionPeer; target: string; model: string; revision: number; promptSha256: string }, options: ModelPromptOptions): Promise<ModelPromptResult> {
  if (!input.target || !input.model || !Number.isInteger(input.revision) || input.revision < 1 || !HEX_SHA256.test(input.promptSha256)) throw new Error("Invalid model prompt prepare request");
  await mkdir(options.operationDir, { recursive: true, mode: 0o700 }); await chmod(options.operationDir, 0o700);
  const operationId = createHash("sha256").update(JSON.stringify([input.target, input.peer.threadId, input.model, input.revision, input.promptSha256])).digest("hex");
  const path = join(options.operationDir, `${operationId}.json`);
  const existing = await readRecord(path);
  if (existing) return result(existing);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const record: ModelPromptRecord = { version: 1, operationId, target: input.target, threadId: input.peer.threadId, socketPath: input.peer.socketPath, peerPid: input.peer.pid, peerStartedAtMs: input.peer.startedAtMs, model: input.model, revision: input.revision, promptSha256: input.promptSha256, state: "prepared", turnId: null, detail: null, createdAt: timestamp, updatedAt: timestamp };
  if (!await createRecord(path, record)) return result((await readRecord(path))!);
  return result(record);
}

export async function commitTraexModelPrompt(input: { operationId: string; text: string; promptSha256: string }, options: ModelPromptOptions): Promise<ModelPromptResult> {
  if (!HEX_SHA256.test(input.operationId) || !HEX_SHA256.test(input.promptSha256) || createHash("sha256").update(input.text).digest("hex") !== input.promptSha256) throw new Error("Model prompt digest mismatch");
  const path = join(options.operationDir, `${input.operationId}.json`);
  const record = await readRecord(path);
  if (!record) throw new Error("Prepared model prompt operation not found");
  if (record.promptSha256 !== input.promptSha256) throw new Error("Model prompt digest mismatch");
  if (record.state !== "prepared") return result(record);
  const claimPath = `${path}.dispatch`;
  const claim = await createDispatchClaim(claimPath);
  if (!claim) {
    const current = await readRecord(path);
    if (current?.state !== "prepared") return result(current!);
    return { operationId: record.operationId, state: "uncertain", turnId: null, detail: "Another commit owns the dispatch fence" };
  }
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const dispatching = { ...record, state: "dispatching" as const, updatedAt: timestamp };
  await replaceRecord(path, dispatching);
  try {
    const peer = { threadId: record.threadId, socketPath: record.socketPath, pid: record.peerPid, startedAtMs: record.peerStartedAtMs };
    const turnId = await (options.callTurnStart ?? callTurnStart)(peer, input.text, record.model, options.timeoutMs ?? 10_000);
    const accepted = { ...dispatching, state: "accepted" as const, turnId, updatedAt: (options.now ?? (() => new Date()))().toISOString() };
    await replaceRecord(path, accepted); return result(accepted);
  } catch (error) {
    const uncertain = { ...dispatching, state: "uncertain" as const, detail: boundedError(error), updatedAt: (options.now ?? (() => new Date()))().toISOString() };
    await replaceRecord(path, uncertain); return result(uncertain);
  }
}

export async function abortTraexModelPrompt(input: { operationId: string }, options: ModelPromptOptions): Promise<ModelPromptResult> {
  if (!HEX_SHA256.test(input.operationId)) throw new Error("Invalid model prompt operation identity");
  const path = join(options.operationDir, `${input.operationId}.json`);
  const record = await readRecord(path);
  if (!record) throw new Error("Prepared model prompt operation not found");
  if (record.state !== "prepared") return result(record);
  const claim = await createDispatchClaim(`${path}.dispatch`);
  if (!claim) return result((await readRecord(path))!);
  const rejected = { ...record, state: "rejected" as const, detail: "Aborted before dispatch", updatedAt: (options.now ?? (() => new Date()))().toISOString() };
  await replaceRecord(path, rejected);
  return result(rejected);
}

async function callTurnStart(peer: TraexSessionPeer, text: string, model: string, timeoutMs: number): Promise<string> {
  const metadata = await stat(peer.socketPath);
  if (!metadata.isSocket() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("TraeX session peer socket failed ownership or permission validation");
  const nonce = randomUUID(); const initId = `model-prompt:init:${nonce}`; const requestId = `model-prompt:turn:${nonce}`;
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ path: peer.socketPath });
    let buffer = ""; let bytes = 0; let initialized = false; let settled = false;
    const finish = (error?: Error, turnId?: string) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(turnId!); };
    const timer = setTimeout(() => finish(new Error("TraeX model prompt response timed out")), timeoutMs);
    socket.setEncoding("utf8"); socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk); if (bytes > MAX_RESPONSE_BYTES) return finish(new Error("TraeX model prompt response exceeded the byte limit")); buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
        let message: Record<string, unknown>; try { message = JSON.parse(line) as Record<string, unknown>; } catch { return finish(new Error("TraeX model prompt returned invalid JSON")); }
        if (message.id === initId) {
          if (message.error) return finish(rpcError(message.error)); initialized = true; socket.write(`${JSON.stringify({ method: "initialized" })}\n`);
          socket.write(`${JSON.stringify({ method: "turn/start", id: requestId, params: { threadId: peer.threadId, input: [{ type: "text", text, text_elements: [] }], model } })}\n`);
        } else if (message.id === requestId) {
          if (!initialized) return finish(new Error("TraeX model prompt response arrived before initialization")); if (message.error) return finish(rpcError(message.error));
          const turn = message.result && typeof message.result === "object" ? (message.result as Record<string, unknown>).turn : null;
          const turnId = turn && typeof turn === "object" ? (turn as Record<string, unknown>).id : null;
          if (typeof turnId !== "string" || !turnId) return finish(new Error("TraeX model prompt returned an invalid turn")); finish(undefined, turnId);
        }
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ method: "initialize", id: initId, params: { clientInfo: { name: "herdr-traex-shim", title: "Herdr TraeX shim", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } } })}\n`));
  });
}
function result(record: ModelPromptRecord): ModelPromptResult { return { operationId: record.operationId, state: record.state, turnId: record.turnId, detail: record.detail }; }
async function createRecord(path: string, record: ModelPromptRecord): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`; let handle;
  try { handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); await handle.close(); handle = undefined; try { await link(temporary, path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; } }
  finally { await handle?.close(); await unlink(temporary).catch(() => undefined); }
}
async function createDispatchClaim(path: string): Promise<boolean> { let handle; try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.writeFile(`${process.pid}\n`); await handle.sync(); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; } finally { await handle?.close(); } }
async function replaceRecord(path: string, record: ModelPromptRecord): Promise<void> { const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`; const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); } await rename(temporary, path); }
async function readRecord(path: string): Promise<ModelPromptRecord | null> { let handle; try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const metadata = await handle.stat(); if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0 || metadata.size > 16 * 1024) throw new Error("Invalid model prompt operation record"); return JSON.parse(await handle.readFile("utf8")) as ModelPromptRecord; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } finally { await handle?.close(); } }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " " ).slice(0, 500); }
function rpcError(value: unknown): Error { const record = value && typeof value === "object" ? value as Record<string, unknown> : {}; return new Error((typeof record.message === "string" ? record.message : "TraeX app-server request failed").slice(0, 500)); }
