import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HerdrAgentSession } from "../domain/types.js";
import type { TraexTranscriptCursorPort, TraexTranscriptOpenResult, TraexTranscriptReaderPort } from "../domain/ports.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_RENDERED_DELTA_CHARS = 64 * 1024;
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
const functionOutputPartSchema = z.object({
  type: z.enum(["input_text", "output_text"]),
  text: z.string()
}).passthrough();

export interface TraexTranscriptReaderOptions {
  sessionsRoot?: string;
  maxReadBytes?: number;
  maxRenderedDeltaChars?: number;
}

export class TraexTranscriptReader implements TraexTranscriptReaderPort {
  private readonly sessionsRoot: string;
  private readonly maxReadBytes: number;
  private readonly maxRenderedDeltaChars: number;

  constructor(options: TraexTranscriptReaderOptions = {}) {
    this.sessionsRoot = resolve(options.sessionsRoot ?? resolve(homedir(), ".trae/cli/sessions"));
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxRenderedDeltaChars = options.maxRenderedDeltaChars ?? DEFAULT_MAX_RENDERED_DELTA_CHARS;
  }

  async open(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptOpenResult> {
    if (!session) return { mode: "terminal", reason: "missing_session_identity" };
    if (session.agent !== "traex" || session.kind !== "id" || !SESSION_ID.test(session.value)) {
      return { mode: "terminal", reason: "unsupported_session_identity" };
    }
    try {
      const paths = await findExactTranscriptPaths(this.sessionsRoot, session.value);
      if (paths.length === 0) return { mode: "terminal", reason: "transcript_not_found" };
      if (paths.length > 1) return { mode: "terminal", reason: "ambiguous_transcript" };
      const path = paths[0]!;
      if (!await containsMatchingSessionMeta(path, session.value)) {
        return { mode: "terminal", reason: "transcript_validation_failed" };
      }
      const file = await stat(path);
      return { mode: "typed", cursor: new FileTraexTranscriptCursor(path, file.size, this.maxReadBytes, this.maxRenderedDeltaChars) };
    } catch {
      return { mode: "terminal", reason: "transcript_validation_failed" };
    }
  }
}

class FileTraexTranscriptCursor implements TraexTranscriptCursorPort {
  private readonly emittedItemIds = new Set<string>();
  private readonly callsById = new Map<string, { name: string }>();

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
      this.emittedItemIds.add(call.data.id);
      this.callsById.set(call.data.call_id, { name: call.data.name });
      return renderFunctionCall(call.data.name, call.data.arguments);
    }
    const result = functionOutputSchema.safeParse(item);
    if (!result.success || this.emittedItemIds.has(result.data.id) || !this.callsById.has(result.data.call_id)) return "";
    const output = renderFunctionOutput(result.data.output);
    if (!output) return "";
    this.emittedItemIds.add(result.data.id);
    return `执行结果：\n\n${fence(output.includes("diff --git") || output.includes("@@ ") ? "diff" : "text", output)}`;
  }
}

async function findExactTranscriptPaths(root: string, sessionId: string): Promise<string[]> {
  const rootPath = await realpath(root);
  const matches: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && basename(path).endsWith(`-${sessionId}.jsonl`)) matches.push(path);
      if (matches.length > 1) return;
    }
  };
  await visit(rootPath);
  for (const path of matches) {
    const resolvedPath = await realpath(path);
    const child = relative(rootPath, resolvedPath);
    if (child.startsWith(`..${sep}`) || child === "..") return [];
  }
  return matches;
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

function renderFunctionOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (!Array.isArray(output)) return "";
  return output
    .map((part) => functionOutputPartSchema.safeParse(part))
    .filter((part) => part.success)
    .map((part) => part.data.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function renderFunctionCall(name: string, argumentsJson: string): string {
  const parsed = parseArguments(argumentsJson);
  const command = name === "exec" && parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? firstString(parsed as Record<string, unknown>, ["command", "cmd"])
    : null;
  if (command) return `工具调用：\`${name}\`\n\n${fence("bash", command)}`;
  const formatted = parsed === null ? argumentsJson.trim() : JSON.stringify(parsed, null, 2);
  return `工具调用：\`${name}\`\n\n${fence("json", formatted)}`;
}

function parseArguments(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  }
  return null;
}

function fence(language: string, value: string): string {
  const safe = value.replaceAll("```", "` ` `");
  return `\`\`\`${language}\n${safe}\n\`\`\``;
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
