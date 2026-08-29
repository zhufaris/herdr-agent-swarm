import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEER_FILENAME = /^[0-9a-f]{32}.json$/i;
const DEFAULT_MAX_BYTES = 4 * 1024;
const DEFAULT_MAX_ENTRIES = 10_000;

const peerSchema = z.object({
  protocolVersion: z.literal(1),
  threadName: z.string(),
  threadId: z.string(),
  location: z.literal("local"),
  pid: z.number().int().positive()
}).passthrough();

export type TraexSessionPeerResolution =
  | { status: "resolved"; threadId: string }
  | { status: "pending" }
  | { status: "ambiguous" };

export interface TraexSessionPeerOptions {
  maxBytes?: number;
  maxEntries?: number;
}

export async function resolveTraexSessionPeer(
  peersDir: string,
  pid: number,
  launchCorrelationId: string,
  options: TraexSessionPeerOptions = {}
): Promise<TraexSessionPeerResolution> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const matches = new Set<string>();
  let entries = 0;
  let directory;
  try {
    directory = await opendir(peersDir);
  } catch {
    return { status: "pending" };
  }
  try {
    for await (const entry of directory) {
      entries += 1;
      if (entries > maxEntries) return { status: "ambiguous" };
      if (!entry.isFile() || !PEER_FILENAME.test(entry.name)) continue;
      const peer = await readPeer(join(peersDir, entry.name), maxBytes);
      if (!peer || peer.pid !== pid || peer.threadName !== launchCorrelationId) continue;
      if (!SESSION_ID.test(peer.threadId) || basename(entry.name, ".json").toLowerCase() !== peer.threadId.replaceAll("-", "").toLowerCase()) continue;
      matches.add(peer.threadId);
      if (matches.size > 1) return { status: "ambiguous" };
    }
  } catch {
    return { status: "ambiguous" };
  } finally {
    await directory.close().catch(() => undefined);
  }
  const threadId = matches.values().next().value;
  return threadId ? { status: "resolved", threadId } : { status: "pending" };
}

async function readPeer(path: string, maxBytes: number): Promise<z.infer<typeof peerSchema> | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > maxBytes) return null;
    const raw = await handle.readFile("utf8");
    const parsed = peerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
