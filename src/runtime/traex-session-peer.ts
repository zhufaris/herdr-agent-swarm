import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_BYTES = 4 * 1024;

interface TraexSessionPeerRecord {
  protocolVersion: 1;
  threadName: string;
  threadId: string;
  location: "local";
  socketPath: string;
  pid: number;
  startedAtMs: number;
}

export interface TraexSessionPeer {
  threadId: string;
  socketPath: string;
  pid: number;
  startedAtMs: number;
}

export interface TraexSessionPeerOptions {
  maxBytes?: number;
}

export async function findTraexSessionPeer(
  peersDir: string,
  threadId: string,
  options: Pick<TraexSessionPeerOptions, "maxBytes"> = {}
): Promise<TraexSessionPeer | null> {
  if (!SESSION_ID.test(threadId)) return null;
  const path = join(peersDir, `${threadId.replaceAll("-", "").toLowerCase()}.json`);
  const peer = await readPeer(path, options.maxBytes ?? DEFAULT_MAX_BYTES);
  if (!peer || peer.threadId.toLowerCase() !== threadId.toLowerCase()) return null;
  return { threadId: peer.threadId, socketPath: peer.socketPath, pid: peer.pid, startedAtMs: peer.startedAtMs };
}

async function readPeer(path: string, maxBytes: number): Promise<TraexSessionPeerRecord | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > maxBytes) return null;
    const raw = await handle.readFile("utf8");
    const parsed: unknown = JSON.parse(raw);
    return isPeerRecord(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isPeerRecord(value: unknown): value is TraexSessionPeerRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const peer = value as Record<string, unknown>;
  return peer.protocolVersion === 1
    && peer.location === "local"
    && typeof peer.threadName === "string"
    && typeof peer.threadId === "string"
    && typeof peer.socketPath === "string"
    && peer.socketPath.startsWith("/")
    && typeof peer.pid === "number"
    && Number.isInteger(peer.pid)
    && peer.pid > 0
    && typeof peer.startedAtMs === "number"
    && Number.isSafeInteger(peer.startedAtMs)
    && peer.startedAtMs > 0;
}
