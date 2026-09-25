import { open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import { envelopeSchema, sessionMetaSchema } from "./record-codec.js";

const DEFAULT_MAX_DISCOVERY_ENTRIES = 100_000;
const DEFAULT_MAX_CACHED_PATHS = 256;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 250;
const DEFAULT_DISCOVERY_INDEX_TTL_MS = 1_000;
const SESSION_META_SCAN_BYTES = 256 * 1024;
const SESSION_META_MAX_BYTES = 4 * 1024 * 1024;

export interface TranscriptDiscoveryResult {
  paths: string[];
  exhausted: boolean;
}

export interface TranscriptPathIndex {
  pathsBySessionId: Map<string, string[]>;
  exhausted: boolean;
}

export interface TranscriptLocatorOptions {
  sessionsRoot?: string;
  maxDiscoveryEntries?: number;
  maxCachedPaths?: number;
  negativeCacheTtlMs?: number;
  discoveryIndexTtlMs?: number;
  now?: () => number;
  discover?: (root: string, sessionId: string, maxEntries: number) => Promise<TranscriptDiscoveryResult>;
  scan?: (root: string, maxEntries: number) => Promise<TranscriptPathIndex>;
}

export class TranscriptLocator {
  readonly sessionsRoot: string;
  private readonly maxDiscoveryEntries: number;
  private readonly maxCachedPaths: number;
  private readonly negativeCacheTtlMs: number;
  private readonly discoveryIndexTtlMs: number;
  private readonly now: () => number;
  private readonly discover: ((root: string, sessionId: string, maxEntries: number) => Promise<TranscriptDiscoveryResult>) | undefined;
  private readonly scan: (root: string, maxEntries: number) => Promise<TranscriptPathIndex>;
  private readonly pathsBySessionId = new Map<string, string>();
  private readonly missingUntilBySessionId = new Map<string, number>();
  private readonly discoveryBySessionId = new Map<string, Promise<TranscriptDiscoveryResult>>();
  private discoveryIndex: { value: TranscriptPathIndex; expiresAt: number } | null = null;
  private discoveryIndexInFlight: Promise<TranscriptPathIndex> | null = null;

  constructor(options: TranscriptLocatorOptions = {}) {
    this.sessionsRoot = resolve(options.sessionsRoot ?? resolve(homedir(), ".trae/cli/sessions"));
    this.maxDiscoveryEntries = options.maxDiscoveryEntries ?? DEFAULT_MAX_DISCOVERY_ENTRIES;
    this.maxCachedPaths = Math.max(1, Math.floor(options.maxCachedPaths ?? DEFAULT_MAX_CACHED_PATHS));
    this.negativeCacheTtlMs = Math.max(0, options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS);
    this.discoveryIndexTtlMs = Math.max(0, options.discoveryIndexTtlMs ?? DEFAULT_DISCOVERY_INDEX_TTL_MS);
    this.now = options.now ?? Date.now;
    this.discover = options.discover;
    this.scan = options.scan ?? scanTranscriptPaths;
  }

  async cachedPath(sessionId: string): Promise<string | null> {
    const cachedPath = this.pathsBySessionId.get(sessionId);
    if (!cachedPath) return null;
    if (await isValidTranscriptPath(this.sessionsRoot, cachedPath, sessionId)) {
      this.pathsBySessionId.delete(sessionId);
      this.pathsBySessionId.set(sessionId, cachedPath);
      return cachedPath;
    }
    this.pathsBySessionId.delete(sessionId);
    return null;
  }

  isMissingCached(sessionId: string): boolean {
    const missingUntil = this.missingUntilBySessionId.get(sessionId);
    if (missingUntil !== undefined && missingUntil > this.now()) return true;
    if (missingUntil !== undefined) this.missingUntilBySessionId.delete(sessionId);
    return false;
  }

  async resolveTranscriptPath(sessionId: string): Promise<string | null> {
    const cachedPath = await this.cachedPath(sessionId);
    if (cachedPath) return cachedPath;
    const discovery = await this.discoverOnce(sessionId);
    if (discovery.exhausted || discovery.paths.length !== 1) return null;
    return await this.acceptDiscoveredPath(sessionId, discovery.paths[0]!);
  }

  async acceptDiscoveredPath(sessionId: string, path: string): Promise<string | null> {
    if (!await containsMatchingSessionMeta(path, sessionId)) return null;
    this.rememberPath(sessionId, path);
    return path;
  }

  discoverOnce(sessionId: string): Promise<TranscriptDiscoveryResult> {
    const existing = this.discoveryBySessionId.get(sessionId);
    if (existing) return existing;
    const discovery = this.discover
      ? this.discover(this.sessionsRoot, sessionId, this.maxDiscoveryEntries)
      : this.discoverFromIndex(sessionId);
    this.discoveryBySessionId.set(sessionId, discovery);
    void discovery.finally(() => {
      if (this.discoveryBySessionId.get(sessionId) === discovery) this.discoveryBySessionId.delete(sessionId);
    });
    return discovery;
  }

  rememberPath(sessionId: string, path: string): void {
    this.missingUntilBySessionId.delete(sessionId);
    this.pathsBySessionId.delete(sessionId);
    this.pathsBySessionId.set(sessionId, path);
    while (this.pathsBySessionId.size > this.maxCachedPaths) {
      const oldest = this.pathsBySessionId.keys().next().value;
      if (oldest === undefined) break;
      this.pathsBySessionId.delete(oldest);
    }
  }

  rememberMissing(sessionId: string): void {
    this.missingUntilBySessionId.delete(sessionId);
    this.missingUntilBySessionId.set(sessionId, this.now() + this.negativeCacheTtlMs);
    while (this.missingUntilBySessionId.size > this.maxCachedPaths) {
      const oldest = this.missingUntilBySessionId.keys().next().value;
      if (oldest === undefined) break;
      this.missingUntilBySessionId.delete(oldest);
    }
  }

  private async discoverFromIndex(sessionId: string): Promise<TranscriptDiscoveryResult> {
    const timestamp = this.now();
    if (this.discoveryIndex && this.discoveryIndex.expiresAt > timestamp) {
      return { paths: this.discoveryIndex.value.pathsBySessionId.get(sessionId) ?? [], exhausted: this.discoveryIndex.value.exhausted };
    }
    if (!this.discoveryIndexInFlight) {
      const scan = this.scan(this.sessionsRoot, this.maxDiscoveryEntries);
      this.discoveryIndexInFlight = scan;
      void scan.then((value) => {
        this.discoveryIndex = { value, expiresAt: this.now() + this.discoveryIndexTtlMs };
      }).finally(() => {
        if (this.discoveryIndexInFlight === scan) this.discoveryIndexInFlight = null;
      });
    }
    const index = await this.discoveryIndexInFlight;
    return { paths: index.pathsBySessionId.get(sessionId) ?? [], exhausted: index.exhausted };
  }
}

export async function scanTranscriptPaths(root: string, maxEntries: number): Promise<TranscriptPathIndex> {
  const rootPath = await realpath(root);
  const pathsBySessionId = new Map<string, string[]>();
  const state = { visited: 0, exhausted: false };
  const visit = async (directory: string): Promise<void> => {
    if (state.exhausted) return;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (state.exhausted) break;
      if (state.visited >= maxEntries) { state.exhausted = true; break; }
      state.visited += 1;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const match = basename(path).match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
        if (match) {
          const paths = pathsBySessionId.get(match[1]!) ?? [];
          paths.push(path);
          pathsBySessionId.set(match[1]!, paths);
        }
      }
    }
  };
  await visit(rootPath);
  return { pathsBySessionId, exhausted: state.exhausted };
}

export async function isValidTranscriptPath(root: string, path: string, sessionId: string): Promise<boolean> {
  try {
    const rootPath = await realpath(root);
    const resolvedPath = await realpath(path);
    const child = relative(rootPath, resolvedPath);
    if (child.startsWith(`..${sep}`) || child === ".." || !basename(resolvedPath).endsWith(`-${sessionId}.jsonl`)) return false;
    return await containsMatchingSessionMeta(resolvedPath, sessionId);
  } catch {
    return false;
  }
}

export async function containsMatchingSessionMeta(path: string, sessionId: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const content = await readFirstJsonLine(handle);
    if (!content) return false;
    const envelope = envelopeSchema.safeParse(JSON.parse(content));
    if (!envelope.success || envelope.data.type !== "session_meta") return false;
    const metadata = sessionMetaSchema.safeParse(envelope.data.payload);
    return metadata.success && metadata.data.id === sessionId;
  } finally {
    await handle.close();
  }
}

export async function readFirstJsonLine(handle: Awaited<ReturnType<typeof open>>): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  let position = 0;
  while (total < SESSION_META_MAX_BYTES) {
    const buffer = Buffer.alloc(Math.min(SESSION_META_SCAN_BYTES, SESSION_META_MAX_BYTES - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const chunk = buffer.subarray(0, bytesRead);
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0) {
      chunks.push(chunk.subarray(0, newline));
      return Buffer.concat(chunks).toString("utf8").trim();
    }
    chunks.push(chunk);
    total += bytesRead;
    position += bytesRead;
  }
  return null;
}
