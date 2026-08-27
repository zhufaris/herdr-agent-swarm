import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HerdrAgentSession } from "../domain/types.js";
import type { TraexTranscriptCursorPort, TraexTranscriptOpenResult, TraexTranscriptReaderPort } from "../domain/ports.js";
import { projectToolCall, projectToolResult, type ToolActivityDescriptor } from "./tool-activity-projector.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_RENDERED_DELTA_CHARS = 64 * 1024;
const DEFAULT_MAX_DISCOVERY_ENTRIES = 100_000;
const SESSION_META_SCAN_BYTES = 256 * 1024;
const SESSION_META_MAX_BYTES = 4 * 1024 * 1024;

const envelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown()
}).passthrough();
const sessionMetaSchema = z.object({ id: z.string() }).passthrough();
const historyMutationSchema = z.object({
  operation: z.literal("append"),
  items: z.array(z.unknown())
}).passthrough();
const messageItemSchema = z.object({
  type: z.literal("message"),
  id: z.string().min(1),
  role: z.string(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
}).passthrough();
const functionCallSchema = z.object({
  type: z.literal("function_call"),
  id: z.string().min(1),
  call_id: z.string().min(1),
  name: z.string(),
  arguments: z.string()
}).passthrough();
const functionOutputSchema = z.object({
  type: z.literal("function_call_output"),
  id: z.string().min(1),
  call_id: z.string().min(1),
  output: z.unknown()
}).passthrough();
export interface TraexTranscriptReaderOptions {
  sessionsRoot?: string;
  maxReadBytes?: number;
  maxRenderedDeltaChars?: number;
  maxDiscoveryEntries?: number;
}

export class TraexTranscriptReader implements TraexTranscriptReaderPort {
  private readonly sessionsRoot: string;
  private readonly maxReadBytes: number;
  private readonly maxRenderedDeltaChars: number;
  private readonly maxDiscoveryEntries: number;
  private readonly pathsBySessionId = new Map<string, string>();

  constructor(options: TraexTranscriptReaderOptions = {}) {
    this.sessionsRoot = resolve(options.sessionsRoot ?? resolve(homedir(), ".trae/cli/sessions"));
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxRenderedDeltaChars = options.maxRenderedDeltaChars ?? DEFAULT_MAX_RENDERED_DELTA_CHARS;
    this.maxDiscoveryEntries = options.maxDiscoveryEntries ?? DEFAULT_MAX_DISCOVERY_ENTRIES;
  }

  async open(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptOpenResult> {
    if (!session) return { mode: "terminal", reason: "missing_session_identity" };
    if (session.agent !== "traex" || session.kind !== "id" || !SESSION_ID.test(session.value)) {
      return { mode: "terminal", reason: "unsupported_session_identity" };
    }
    try {
      const cachedPath = this.pathsBySessionId.get(session.value);
      if (cachedPath) {
        if (await isValidTranscriptPath(this.sessionsRoot, cachedPath, session.value)) {
          const file = await stat(cachedPath);
          return { mode: "typed", cursor: new FileTraexTranscriptCursor(cachedPath, file.size, this.maxReadBytes, this.maxRenderedDeltaChars) };
        }
        this.pathsBySessionId.delete(session.value);
      }
      const discovery = await findExactTranscriptPaths(this.sessionsRoot, session.value, this.maxDiscoveryEntries);
      if (discovery.exhausted) return { mode: "terminal", reason: "transcript_validation_failed" };
      const paths = discovery.paths;
      if (paths.length === 0) return { mode: "terminal", reason: "transcript_not_found" };
      if (paths.length > 1) return { mode: "terminal", reason: "ambiguous_transcript" };
      const path = paths[0]!;
      if (!await containsMatchingSessionMeta(path, session.value)) {
        return { mode: "terminal", reason: "transcript_validation_failed" };
      }
      this.pathsBySessionId.set(session.value, path);
      const file = await stat(path);
      return { mode: "typed", cursor: new FileTraexTranscriptCursor(path, file.size, this.maxReadBytes, this.maxRenderedDeltaChars) };
    } catch {
      return { mode: "terminal", reason: "transcript_validation_failed" };
    }
  }
}

class FileTraexTranscriptCursor implements TraexTranscriptCursorPort {
  private readonly emittedItemIds = new Set<string>();
  private readonly callsById = new Map<string, ToolActivityDescriptor>();

  constructor(
    private readonly path: string,
    private offset: number,
    private readonly maxReadBytes: number,
    private readonly maxRenderedDeltaChars: number
  ) {}

  async readDelta(): Promise<string> {
    const file = await stat(this.path);
    if (file.size < this.offset) throw new Error("TraeX transcript was truncated");
    const available = file.size - this.offset;
    if (available === 0) return "";
    const length = Math.min(available, this.maxReadBytes);
    const handle = await open(this.path, "r");
    let bytesRead = 0;
    const buffer = Buffer.alloc(length);
    try {
      ({ bytesRead } = await handle.read(buffer, 0, length, this.offset));
    } finally {
      await handle.close();
    }
    const chunk = buffer.subarray(0, bytesRead);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      if (available > this.maxReadBytes) throw new Error("TraeX transcript record exceeds the read limit");
      return "";
    }
    const complete = chunk.subarray(0, lastNewline + 1);
    this.offset += complete.length;
    const blocks: string[] = [];
    for (const line of complete.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const envelope = envelopeSchema.parse(JSON.parse(line));
      if (envelope.type !== "history_mutation") continue;
      const mutation = historyMutationSchema.safeParse(envelope.payload);
      if (!mutation.success) continue;
      for (const item of mutation.data.items) {
        const rendered = this.renderItem(item);
        if (rendered) blocks.push(rendered);
      }
    }
    return boundMarkdown(redactSecrets(blocks.join("\n\n")), this.maxRenderedDeltaChars);
  }

  private renderItem(item: unknown): string {
    const message = messageItemSchema.safeParse(item);
    if (message.success) {
      if (message.data.role !== "assistant" || this.emittedItemIds.has(message.data.id)) return "";
      const output = message.data.content
        .filter((part) => part.type === "output_text" && part.text !== undefined)
        .map((part) => part.text!.trim())
        .filter(Boolean)
        .join("\n\n");
      if (!output) return "";
      this.emittedItemIds.add(message.data.id);
      return output;
    }
    const call = functionCallSchema.safeParse(item);
    if (call.success) {
      if (this.emittedItemIds.has(call.data.id) || this.callsById.has(call.data.call_id)) return "";
      const projected = projectToolCall(call.data.name, call.data.arguments);
      this.emittedItemIds.add(call.data.id);
      this.callsById.set(call.data.call_id, projected.descriptor);
      return projected.entry;
    }
    const result = functionOutputSchema.safeParse(item);
    if (!result.success || this.emittedItemIds.has(result.data.id) || !this.callsById.has(result.data.call_id)) return "";
    this.emittedItemIds.add(result.data.id);
    return projectToolResult(this.callsById.get(result.data.call_id)!, result.data.output);
  }
}

interface TranscriptDiscoveryResult {
  paths: string[];
  exhausted: boolean;
}

async function findExactTranscriptPaths(root: string, sessionId: string, maxEntries: number): Promise<TranscriptDiscoveryResult> {
  const rootPath = await realpath(root);
  const matches: string[] = [];
  const state = { visited: 0, stopped: false, exhausted: false };
  const visit = async (directory: string): Promise<void> => {
    if (state.stopped || state.exhausted) return;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (state.stopped || state.exhausted) break;
      if (state.visited >= maxEntries) { state.exhausted = true; break; }
      state.visited += 1;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && basename(path).endsWith(`-${sessionId}.jsonl`)) matches.push(path);
      if (matches.length > 1) state.stopped = true;
    }
  };
  await visit(rootPath);
  if (state.exhausted) return { paths: matches, exhausted: true };
  for (const path of matches) {
    const resolvedPath = await realpath(path);
    const child = relative(rootPath, resolvedPath);
    if (child.startsWith(`..${sep}`) || child === "..") return { paths: [], exhausted: false };
  }
  return { paths: matches, exhausted: false };
}

async function isValidTranscriptPath(root: string, path: string, sessionId: string): Promise<boolean> {
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

async function containsMatchingSessionMeta(path: string, sessionId: string): Promise<boolean> {
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
  return false;
}

async function readFirstJsonLine(handle: Awaited<ReturnType<typeof open>>): Promise<string | null> {
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

function redactSecrets(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s\"'&,;}]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[a-z0-9._~-]+/gi, "$1[REDACTED]")
    .replace(/((?:access[_-]?token|api[_-]?key|token|secret|password)\s*[=:]\s*[\"']?)([^\s\"'&,;}]+)/gi, "$1[REDACTED]")
    .replace(/([?&](?:access_token|api_key|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
}

function boundMarkdown(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = "\n\n… output truncated";
  const room = Math.max(0, maxLength - suffix.length - 4);
  let prefix = value.slice(0, room).trimEnd();
  if ((prefix.match(/```/g)?.length ?? 0) % 2 === 1) prefix += "\n```";
  return `${prefix}${suffix}`.slice(0, maxLength);
}
