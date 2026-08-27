import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HerdrAgentSession } from "../domain/types.js";
import type { TraexTranscriptCursorPort, TraexTranscriptReaderPort } from "../domain/ports.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_RENDERED_DELTA_CHARS = 64 * 1024;
const SESSION_META_SCAN_BYTES = 256 * 1024;

const envelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown()
}).passthrough();
const sessionMetaSchema = z.object({ id: z.string() }).passthrough();
const agentMessageSchema = z.object({
  type: z.literal("agent_message"),
  message: z.string(),
  phase: z.string().optional()
}).passthrough();
const commandEndSchema = z.object({
  type: z.literal("exec_command_end"),
  command: z.array(z.string()).min(1),
  stdout: z.string().optional().default(""),
  stderr: z.string().optional().default("")
}).passthrough();
const patchChangeSchema = z.object({
  type: z.enum(["add", "update", "delete"]),
  content: z.string().optional(),
  unified_diff: z.string().optional(),
  move_path: z.string().nullable().optional()
}).passthrough();
const patchEndSchema = z.object({
  type: z.literal("patch_apply_end"),
  changes: z.record(patchChangeSchema)
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

  async open(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptCursorPort | null> {
    if (!session || session.agent !== "traex" || session.kind !== "id" || !SESSION_ID.test(session.value)) return null;
    try {
      const paths = await findExactTranscriptPaths(this.sessionsRoot, session.value);
      if (paths.length !== 1) return null;
      const path = paths[0]!;
      if (!await containsMatchingSessionMeta(path, session.value)) return null;
      const file = await stat(path);
      return new FileTraexTranscriptCursor(path, file.size, this.maxReadBytes, this.maxRenderedDeltaChars);
    } catch {
      return null;
    }
  }
}

class FileTraexTranscriptCursor implements TraexTranscriptCursorPort {
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
      if (envelope.type !== "event_msg") continue;
      const rendered = renderEvent(envelope.payload);
      if (rendered) blocks.push(rendered);
    }
    return boundMarkdown(blocks.join("\n\n"), this.maxRenderedDeltaChars);
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
  let content: Buffer;
  try {
    const file = await handle.stat();
    const buffer = Buffer.alloc(Math.min(file.size, SESSION_META_SCAN_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    content = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  for (const line of content.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { return false; }
    const envelope = envelopeSchema.safeParse(record);
    if (!envelope.success) return false;
    if (envelope.data.type !== "session_meta") continue;
    const metadata = sessionMetaSchema.safeParse(envelope.data.payload);
    return metadata.success && metadata.data.id === sessionId;
  }
  return false;
}

function renderEvent(payload: unknown): string {
  const assistant = agentMessageSchema.safeParse(payload);
  if (assistant.success) return redactSecrets(assistant.data.message.trim());
  const command = commandEndSchema.safeParse(payload);
  if (command.success) {
    const blocks = [fence("bash", renderCommand(command.data.command))];
    if (command.data.stdout.trim()) blocks.push(fence("text", redactSecrets(command.data.stdout.trimEnd())));
    if (command.data.stderr.trim()) blocks.push(fence("text", redactSecrets(command.data.stderr.trimEnd())));
    return blocks.join("\n\n");
  }
  const patch = patchEndSchema.safeParse(payload);
  if (patch.success) {
    const changes = Object.entries(patch.data.changes).map(([path, change]) => renderPatch(path, change)).filter(Boolean);
    return changes.length > 0 ? fence("diff", redactSecrets(changes.join("\n"))) : "";
  }
  return "";
}

function renderCommand(argv: string[]): string {
  if (argv.length >= 3 && (argv[0] === "/bin/bash" || argv[0] === "bash" || argv[0] === "/bin/sh" || argv[0] === "sh") && argv[1] === "-lc") return redactSecrets(argv[2]!);
  return redactSecrets(argv.map(shellQuote).join(" "));
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function renderPatch(path: string, change: z.infer<typeof patchChangeSchema>): string {
  if (change.unified_diff?.trim()) {
    const diff = change.unified_diff.trimEnd();
    return /^(?:---|diff --git) /m.test(diff) ? diff : `--- a/${path}\n+++ b/${change.move_path ?? path}\n${diff}`;
  }
  if (change.type === "add" && change.content !== undefined) return `--- /dev/null\n+++ b/${path}\n${prefixLines(change.content, "+")}`;
  if (change.type === "delete" && change.content !== undefined) return `--- a/${path}\n+++ /dev/null\n${prefixLines(change.content, "-")}`;
  return "";
}

function prefixLines(value: string, prefix: string): string {
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
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
