import type { TraexSessionPeer } from "./traex-session-peer.js";
import type { TraexModelSummary } from "../domain/model-selection.js";
import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

const MAX_RESPONSE_BYTES = 256 * 1024;

interface ModelListParams { cursor: string | null; limit: number; includeHidden: false }
interface ModelListResponse { data: unknown[]; nextCursor: string | null }

export interface TraexModelListOptions {
  timeoutMs?: number;
  pageSize?: number;
  maxPages?: number;
  maxEntries?: number;
  callPage?: (peer: TraexSessionPeer, params: ModelListParams, timeoutMs: number) => Promise<ModelListResponse>;
}

export async function listTraexModels(peer: TraexSessionPeer, options: TraexModelListOptions = {}): Promise<TraexModelSummary[]> {
  const pageSize = boundedPositive(options.pageSize ?? 100, 100);
  const maxPages = boundedPositive(options.maxPages ?? 20, 100);
  const maxEntries = boundedPositive(options.maxEntries ?? 1_000, 5_000);
  const timeoutMs = boundedPositive(options.timeoutMs ?? 10_000, 300_000);
  const seenCursors = new Set<string>();
  const models: TraexModelSummary[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await (options.callPage ?? callModelListPage)(peer, { cursor, limit: pageSize, includeHidden: false }, timeoutMs);
    if (!response || !Array.isArray(response.data) || !(response.nextCursor === null || typeof response.nextCursor === "string")) throw new Error("TraeX model list returned an invalid page");
    for (const value of response.data) {
      const model = parseModel(value);
      if (!model.hidden) models.push({ id: model.id, name: model.model, displayName: model.displayName });
      if (models.length > maxEntries) throw new Error("TraeX model catalog exceeded the entry limit");
    }
    if (response.nextCursor === null) return models;
    if (!response.nextCursor || seenCursors.has(response.nextCursor)) throw new Error("TraeX model list returned a repeated cursor");
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  throw new Error("TraeX model catalog exceeded the page limit");
}

async function callModelListPage(peer: TraexSessionPeer, params: ModelListParams, timeoutMs: number): Promise<ModelListResponse> {
  const metadata = await stat(peer.socketPath);
  if (!metadata.isSocket() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0) throw new Error("TraeX session peer socket failed ownership or permission validation");
  const nonce = randomUUID();
  const initId = `model-list:init:${nonce}`;
  const requestId = `model-list:page:${nonce}`;
  return new Promise<ModelListResponse>((resolve, reject) => {
    const socket = createConnection({ path: peer.socketPath });
    let buffer = ""; let bytes = 0; let initialized = false; let settled = false;
    const finish = (error?: Error, result?: ModelListResponse) => {
      if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("TraeX model list response timed out")), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESPONSE_BYTES) return finish(new Error("TraeX model list response exceeded the byte limit"));
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { return finish(new Error("TraeX model list returned invalid JSON")); }
        if (message.id === initId) {
          if (message.error) return finish(rpcError(message.error));
          initialized = true;
          socket.write(`${JSON.stringify({ method: "initialized" })}\n`);
          socket.write(`${JSON.stringify({ method: "model/list", id: requestId, params })}\n`);
        } else if (message.id === requestId) {
          if (!initialized) return finish(new Error("TraeX model list response arrived before initialization"));
          if (message.error) return finish(rpcError(message.error));
          finish(undefined, message.result as ModelListResponse);
        }
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ method: "initialize", id: initId, params: { clientInfo: { name: "herdr-traex-shim", title: "Herdr TraeX shim", version: "1" }, capabilities: { experimentalApi: true, requestAttestation: false } } })}\n`));
  });
}

function parseModel(value: unknown): { id: string; model: string; displayName: string; hidden: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("TraeX model list contained an invalid entry");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || typeof record.model !== "string" || !record.model || typeof record.displayName !== "string" || typeof record.hidden !== "boolean") {
    throw new Error("TraeX model list contained an invalid entry");
  }
  return { id: record.id, model: record.model, displayName: record.displayName, hidden: record.hidden };
}

function boundedPositive(value: number, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error("Invalid TraeX model list limit");
  return value;
}

function rpcError(value: unknown): Error {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return new Error((typeof record.message === "string" ? record.message : "TraeX app-server request failed").slice(0, 500));
}
