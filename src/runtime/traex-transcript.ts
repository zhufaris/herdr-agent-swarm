import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HerdrAgentSession } from "../domain/types.js";
import type { TraexTranscriptCursorPort, TraexTranscriptMainStatus, TraexTranscriptObservation, TraexTranscriptOpenResult, TraexTranscriptPlanStep, TraexTranscriptReaderPort } from "../domain/ports.js";
import { projectToolCall, projectToolResult, type ToolActivityDescriptor } from "./tool-activity-projector.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_RENDERED_DELTA_CHARS = 64 * 1024;
const DEFAULT_MAX_DISCOVERY_ENTRIES = 100_000;
const DEFAULT_MAX_CACHED_PATHS = 256;
const SESSION_META_SCAN_BYTES = 256 * 1024;
const SESSION_META_MAX_BYTES = 4 * 1024 * 1024;
const MAX_EPOCH_SECONDS = 10_000_000_000;

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
const reasoningEventSchema = z.object({
  type: z.literal("agent_reasoning_raw_content"),
  text: z.string()
}).passthrough();
const tokenCountEventSchema = z.object({
  type: z.literal("token_count"),
  info: z.object({ total_token_usage: z.object({ total_tokens: z.number().int().nonnegative() }).passthrough() }).passthrough()
}).passthrough();
const taskStartedEventSchema = z.object({
  type: z.literal("task_started"),
  turn_id: z.string().regex(SESSION_ID),
  started_at: z.number().int().nonnegative().max(MAX_EPOCH_SECONDS)
}).passthrough();
const taskCompleteEventSchema = z.object({
  type: z.literal("task_complete"),
  turn_id: z.string().regex(SESSION_ID),
  started_at: z.number().int().nonnegative().max(MAX_EPOCH_SECONDS),
  last_agent_message: z.string().optional()
}).passthrough();
const planArgumentsSchema = z.object({
  plan: z.array(z.object({
    step: z.string(),
    status: z.enum(["pending", "in_progress", "completed"])
  })).max(100)
}).passthrough();
export interface TraexTranscriptReaderOptions {
  sessionsRoot?: string;
  maxReadBytes?: number;
  maxRenderedDeltaChars?: number;
  maxDiscoveryEntries?: number;
  maxCachedPaths?: number;
}

export class TraexTranscriptReader implements TraexTranscriptReaderPort {
  private readonly sessionsRoot: string;
  private readonly maxReadBytes: number;
  private readonly maxRenderedDeltaChars: number;
  private readonly maxDiscoveryEntries: number;
  private readonly maxCachedPaths: number;
  private readonly pathsBySessionId = new Map<string, string>();

  constructor(options: TraexTranscriptReaderOptions = {}) {
    this.sessionsRoot = resolve(options.sessionsRoot ?? resolve(homedir(), ".trae/cli/sessions"));
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxRenderedDeltaChars = options.maxRenderedDeltaChars ?? DEFAULT_MAX_RENDERED_DELTA_CHARS;
    this.maxDiscoveryEntries = options.maxDiscoveryEntries ?? DEFAULT_MAX_DISCOVERY_ENTRIES;
    this.maxCachedPaths = Math.max(1, Math.floor(options.maxCachedPaths ?? DEFAULT_MAX_CACHED_PATHS));
  }

  async open(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptOpenResult> {
    if (!session) return { mode: "unavailable", reason: "missing_session_identity" };
    if (session.agent !== "traex" || session.kind !== "id" || !SESSION_ID.test(session.value)) {
      return { mode: "unavailable", reason: "unsupported_session_identity" };
    }
    try {
      const cachedPath = this.pathsBySessionId.get(session.value);
      if (cachedPath) {
        if (await isValidTranscriptPath(this.sessionsRoot, cachedPath, session.value)) {
          this.pathsBySessionId.delete(session.value);
          this.pathsBySessionId.set(session.value, cachedPath);
          const file = await stat(cachedPath);
          return { mode: "typed", cursor: new FileTraexTranscriptCursor(cachedPath, file.size, this.maxReadBytes, this.maxRenderedDeltaChars, await latestTokenCount(cachedPath, file.size, this.maxReadBytes), await latestTurnLifecycle(cachedPath, file.size, this.maxReadBytes, this.maxRenderedDeltaChars)) };
        }
        this.pathsBySessionId.delete(session.value);
      }
      const discovery = await findExactTranscriptPaths(this.sessionsRoot, session.value, this.maxDiscoveryEntries);
      if (discovery.exhausted) return { mode: "unavailable", reason: "transcript_validation_failed" };
      const paths = discovery.paths;
      if (paths.length === 0) return { mode: "unavailable", reason: "transcript_not_found" };
      if (paths.length > 1) return { mode: "unavailable", reason: "ambiguous_transcript" };
      const path = paths[0]!;
      if (!await containsMatchingSessionMeta(path, session.value)) {
        return { mode: "unavailable", reason: "transcript_validation_failed" };
      }
      this.rememberPath(session.value, path);
      const file = await stat(path);
      return { mode: "typed", cursor: new FileTraexTranscriptCursor(path, file.size, this.maxReadBytes, this.maxRenderedDeltaChars, await latestTokenCount(path, file.size, this.maxReadBytes), await latestTurnLifecycle(path, file.size, this.maxReadBytes, this.maxRenderedDeltaChars)) };
    } catch {
      return { mode: "unavailable", reason: "transcript_validation_failed" };
    }
  }

  private rememberPath(sessionId: string, path: string): void {
    this.pathsBySessionId.delete(sessionId);
    this.pathsBySessionId.set(sessionId, path);
    while (this.pathsBySessionId.size > this.maxCachedPaths) {
      const oldest = this.pathsBySessionId.keys().next().value;
      if (oldest === undefined) break;
      this.pathsBySessionId.delete(oldest);
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
    private readonly maxRenderedDeltaChars: number,
    private readonly tokenBaseline: number | null,
    private turnLifecycle: TraexTranscriptObservation["turnLifecycle"]
  ) {}

  async readDelta(): Promise<string> {
    return (await this.readObservation()).answerDelta;
  }

  async readObservation(): Promise<TraexTranscriptObservation> {
    const file = await stat(this.path);
    if (file.size < this.offset) throw new Error("TraeX transcript was truncated");
    const available = file.size - this.offset;
    if (available === 0) return { answerDelta: "", ...(this.turnLifecycle ? { turnLifecycle: this.turnLifecycle } : {}) };
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
      return { answerDelta: "" };
    }
    const complete = chunk.subarray(0, lastNewline + 1);
    this.offset += complete.length;
    const blocks: string[] = [];
    let statusTitle: string | undefined;
    let planSteps: TraexTranscriptPlanStep[] | undefined;
    let tokenCount: number | undefined;
    for (const line of complete.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const envelope = envelopeSchema.parse(JSON.parse(line));
      if (envelope.type === "event_msg") {
        this.turnLifecycle = reduceTurnLifecycle(this.turnLifecycle, envelope, this.maxRenderedDeltaChars);
        const reasoning = reasoningEventSchema.safeParse(envelope.payload);
        if (reasoning.success) statusTitle = extractStatusTitle(reasoning.data.text) ?? statusTitle;
        const tokens = tokenCountEventSchema.safeParse(envelope.payload);
        if (tokens.success && this.tokenBaseline !== null && tokens.data.info.total_token_usage.total_tokens >= this.tokenBaseline) {
          tokenCount = tokens.data.info.total_token_usage.total_tokens - this.tokenBaseline;
        }
        continue;
      }
      if (envelope.type !== "history_mutation") continue;
      const mutation = historyMutationSchema.safeParse(envelope.payload);
      if (!mutation.success) continue;
      for (const item of mutation.data.items) {
        const plan = parsePlanSnapshot(item);
        if (plan) {
          planSteps = plan;
          const call = functionCallSchema.safeParse(item);
          if (call.success) this.emittedItemIds.add(call.data.id);
          continue;
        }
        const rendered = this.renderItem(item);
        if (rendered) blocks.push(rendered);
      }
    }
    const mainStatus: TraexTranscriptMainStatus = {
      ...(statusTitle ? { statusTitle } : {}),
      ...(planSteps ? { planSteps } : {}),
      ...(tokenCount !== undefined ? { tokenCount } : {})
    };
    return {
      answerDelta: boundMarkdown(redactSecrets(blocks.join("\n\n")), this.maxRenderedDeltaChars),
      ...(Object.keys(mainStatus).length ? { mainStatus } : {}),
      ...(this.turnLifecycle ? { turnLifecycle: this.turnLifecycle } : {})
    };
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
      if (call.data.name === "update_plan") return "";
      this.callsById.set(call.data.call_id, projected.descriptor);
      return projected.entry;
    }
    const result = functionOutputSchema.safeParse(item);
    if (!result.success || this.emittedItemIds.has(result.data.id) || !this.callsById.has(result.data.call_id)) return "";
    this.emittedItemIds.add(result.data.id);
    return projectToolResult(this.callsById.get(result.data.call_id)!, result.data.output);
  }
}

function reduceTurnLifecycle(
  current: TraexTranscriptObservation["turnLifecycle"],
  envelope: z.infer<typeof envelopeSchema>,
  maxRenderedDeltaChars: number
): TraexTranscriptObservation["turnLifecycle"] {
  if (envelope.type !== "event_msg") return current;
  const started = taskStartedEventSchema.safeParse(envelope.payload);
  if (started.success) return {
    turnId: started.data.turn_id,
    state: "active",
    startedAt: eventTime(started.data.started_at)
  };
  const completed = taskCompleteEventSchema.safeParse(envelope.payload);
  if (!completed.success) return current;
  if (current?.state !== "active" || current.turnId !== completed.data.turn_id) return current;
  const finalAnswer = completed.data.last_agent_message
    ? boundMarkdown(redactSecrets(completed.data.last_agent_message.trim()), maxRenderedDeltaChars)
    : "";
  return {
    turnId: completed.data.turn_id,
    state: "completed",
    startedAt: current.startedAt,
    ...(finalAnswer ? { finalAnswer } : {})
  };
}

function eventTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString();
}

function extractStatusTitle(text: string): string | null {
  const match = /^\s*\*\*([^*\n]+)\*\*/.exec(text);
  if (!match) return null;
  const title = match[1]!.replace(/\s+/g, " " ).trim();
  if (!title) return null;
  return title.slice(0, 160);
}

function parsePlanSnapshot(item: unknown): TraexTranscriptPlanStep[] | null {
  const call = functionCallSchema.safeParse(item);
  if (!call.success) return null;
  try {
    const outer = JSON.parse(call.data.arguments) as unknown;
    const parsed = call.data.name === "update_plan"
      ? planArgumentsSchema.safeParse(outer)
      : call.data.name === "exec" ? parseWrappedPlan(outer) : null;
    if (!parsed) return null;
    if (!parsed.success) return null;
    const states = { pending: "pending", in_progress: "active", completed: "done" } as const;
    return parsed.data.plan.map((step, index) => ({
      key: `plan:${index}`,
      label: step.step.replace(/\s+/g, " " ).trim().slice(0, 300) || "未命名步骤",
      state: states[step.status]
    }));
  } catch {
    return null;
  }
}

function parseWrappedPlan(value: unknown): ReturnType<typeof planArgumentsSchema.safeParse> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = (value as Record<string, unknown>).input;
  if (typeof input !== "string" || !/tools\.update_plan\s*\(/.test(input)) return null;
  const steps: Array<{ step: string; status: "pending" | "in_progress" | "completed" }> = [];
  const pattern = /step\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*status\s*:\s*"(pending|in_progress|completed)"/g;
  for (const match of input.matchAll(pattern)) {
    try { steps.push({ step: JSON.parse(match[1]!) as string, status: match[2]! as "pending" | "in_progress" | "completed" }); }
    catch { return null; }
  }
  return steps.length ? planArgumentsSchema.safeParse({ plan: steps }) : null;
}

async function latestTokenCount(path: string, end: number, maxBytes: number): Promise<number | null> {
  if (end <= 0) return null;
  const start = Math.max(0, end - maxBytes);
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(end - start);
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const source = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = source.split("\n");
    if (start > 0) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const envelope = envelopeSchema.safeParse(JSON.parse(lines[index]!));
        if (!envelope.success || envelope.data.type !== "event_msg") continue;
        const tokens = tokenCountEventSchema.safeParse(envelope.data.payload);
        if (tokens.success) return tokens.data.info.total_token_usage.total_tokens;
      } catch {}
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function latestTurnLifecycle(path: string, end: number, maxBytes: number, maxRenderedDeltaChars: number): Promise<TraexTranscriptObservation["turnLifecycle"]> {
  if (end <= 0) return undefined;
  const start = Math.max(0, end - maxBytes);
  const handle = await open(path, "r");
  const buffer = Buffer.alloc(end - start);
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    let lifecycle: TraexTranscriptObservation["turnLifecycle"];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const envelope = envelopeSchema.safeParse(JSON.parse(line));
        if (envelope.success) lifecycle = reduceTurnLifecycle(lifecycle, envelope.data, maxRenderedDeltaChars);
      } catch {}
    }
    return lifecycle;
  } finally {
    await handle.close();
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
