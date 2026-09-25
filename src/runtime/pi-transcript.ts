import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentTranscriptCursorPort, AgentTranscriptObservation, AgentTranscriptOpenResult, AgentTranscriptReaderPort, AgentTranscriptSource } from "../domain/ports/external.js";
import { AGENT_SESSION_ID, boundTranscriptMarkdown } from "./agent-transcript-codec.js";
import { MAX_TURN_OUTPUT_CHARS } from "./bounded-turn-output.js";
import { redactSecrets } from "./redact-secrets.js";
import { piTranscriptDescriptor } from "./agents/pi-transcript-identity.js";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const toolCallBlockSchema = z.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.unknown().optional() }).passthrough();
const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.union([z.string(), z.array(z.unknown())]), timestamp: z.number().optional() }).passthrough(),
  z.object({ role: z.literal("assistant"), content: z.array(z.unknown()), stopReason: z.string().optional(), timestamp: z.number().optional(), usage: z.object({ totalTokens: z.number().int().nonnegative().optional() }).passthrough().optional() }).passthrough(),
  z.object({ role: z.literal("toolResult"), content: z.unknown(), toolCallId: z.string().optional(), toolName: z.string().optional(), isError: z.boolean().optional(), timestamp: z.number().optional() }).passthrough(),
  z.object({ role: z.literal("system"), content: z.unknown(), timestamp: z.number().optional() }).passthrough()
]);
const entrySchema = z.object({ type: z.literal("message"), id: z.string().min(1), parentId: z.string().nullable(), timestamp: z.string().datetime(), message: messageSchema }).passthrough();
const headerSchema = z.object({ type: z.literal("session"), id: z.string().regex(AGENT_SESSION_ID), timestamp: z.string().datetime(), cwd: z.string() }).passthrough();
type PiEntry = z.infer<typeof entrySchema>;

export interface PiTranscriptReaderOptions { root: string; maxRenderedDeltaChars?: number }

export class PiTranscriptReader implements AgentTranscriptReaderPort {
  private readonly maxRenderedDeltaChars: number;
  constructor(private readonly options: PiTranscriptReaderOptions) { this.maxRenderedDeltaChars = options.maxRenderedDeltaChars ?? MAX_TURN_OUTPUT_CHARS; }

  open(source: AgentTranscriptSource): Promise<AgentTranscriptOpenResult> { return this.openBoundary(source, { kind: "latest" }); }
  openActiveTurn(source: AgentTranscriptSource): Promise<AgentTranscriptOpenResult> { return this.openBoundary(source, { kind: "active" }); }
  openFirstTurn(source: AgentTranscriptSource): Promise<AgentTranscriptOpenResult> { return this.openBoundary(source, { kind: "first" }); }
  openAtTurn(source: AgentTranscriptSource, turnId: string, startedAt: string): Promise<AgentTranscriptOpenResult> { return this.openBoundary(source, { kind: "at", turnId, startedAt }); }
  openAfterTurn(source: AgentTranscriptSource, turnId: string, startedAt: string): Promise<AgentTranscriptOpenResult> { return this.openBoundary(source, { kind: "after", turnId, startedAt }); }

  private async openBoundary(source: AgentTranscriptSource, boundary: Boundary): Promise<AgentTranscriptOpenResult> {
    if (source.agentKind !== "pi" || !source.bindingId || !Number.isInteger(source.generation)) return unavailable("unsupported_session_identity");
    const descriptor = piTranscriptDescriptor(this.options.root, source.bindingId, source.generation);
    try {
      const paths = await readdir(descriptor.sessionDir).then(
        (names) => names.filter((name) => name.endsWith(`_${descriptor.sessionId}.jsonl`)),
        (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; }
      );
      if (paths.length === 0 && boundary.kind === "latest") return { mode: "typed", cursor: new PiTranscriptCursor(null, descriptor.sessionDir, descriptor.sessionId, 0, this.maxRenderedDeltaChars) };
      if (paths.length === 0) return unavailable("transcript_not_found");
      if (paths.length !== 1) return unavailable("ambiguous_transcript");
      const path = join(descriptor.sessionDir, paths[0]!);
      const snapshot = await loadSnapshot(path, descriptor.sessionId);
      if (!snapshot) return unavailable("transcript_validation_failed");
      const startIndex = boundaryIndex(snapshot.entries, boundary);
      if (startIndex === "missing") return unavailable("turn_boundary_not_found");
      if (startIndex === "incomplete") return unavailable("turn_boundary_incomplete");
      return { mode: "typed", cursor: new PiTranscriptCursor(path, descriptor.sessionDir, descriptor.sessionId, startIndex, this.maxRenderedDeltaChars) };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? unavailable("transcript_not_found") : unavailable("transcript_validation_failed");
    }
  }
}

type Boundary = { kind: "latest" | "active" | "first" } | { kind: "at" | "after"; turnId: string; startedAt: string };
interface Snapshot { entries: PiEntry[] }

class PiTranscriptCursor implements AgentTranscriptCursorPort {
  private index: number;
  private active: { id: string; startedAt: string; answer: string } | null = null;
  constructor(private path: string | null, private readonly sessionDir: string, private readonly sessionId: string, index: number, private readonly maxChars: number) { this.index = index; }
  async readDelta(): Promise<string> { return (await this.readObservation()).answerDelta; }
  async readObservation(): Promise<AgentTranscriptObservation> {
    if (!this.path) {
      try {
        const paths = (await readdir(this.sessionDir)).filter((name) => name.endsWith(`_${this.sessionId}.jsonl`));
        if (paths.length !== 1) return { answerDelta: "" };
        this.path = join(this.sessionDir, paths[0]!);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { answerDelta: "" };
        throw error;
      }
    }
    const snapshot = await loadSnapshot(this.path, this.sessionId);
    if (!snapshot || this.index >= snapshot.entries.length) return { answerDelta: "" };
    const entry = snapshot.entries[this.index++]!;
    const role = entry.message.role;
    if (role === "user") {
      const requestText = textContent(entry.message.content, this.maxChars);
      this.active = { id: entry.id, startedAt: entry.timestamp, answer: "" };
      return { turnId: entry.id, freshTurnStart: true, ...(requestText ? { requestText } : {}), answerDelta: "", turnLifecycle: { turnId: entry.id, state: "active", startedAt: entry.timestamp } };
    }
    if (!this.active) return { answerDelta: "" };
    if (role === "assistant") {
      const text = textContent(entry.message.content, this.maxChars);
      if (text) this.active.answer = boundTranscriptMarkdown([this.active.answer, text].filter(Boolean).join("\n\n"), this.maxChars);
      const tokenCount = entry.message.usage?.totalTokens;
      const base: AgentTranscriptObservation = { turnId: this.active.id, answerDelta: text, ...(tokenCount === undefined ? {} : { mainStatus: { tokenCount } }) };
      if (entry.message.stopReason === "stop") return { ...base, turnLifecycle: { turnId: this.active.id, state: "completed", startedAt: this.active.startedAt, ...(this.active.answer ? { finalAnswer: this.active.answer } : {}) } };
      if (entry.message.stopReason && entry.message.stopReason !== "toolUse") return { ...base, turnLifecycle: { turnId: this.active.id, state: "aborted", startedAt: this.active.startedAt, reason: safeText(entry.message.stopReason, 160) } };
      const tools = entry.message.content.map((part) => toolCallBlockSchema.safeParse(part)).filter((parsed) => parsed.success).map(({ data }) => ({ key: `tool:${data.id}`, kind: toolKind(data.name), label: safeText(`${data.name} · ${toolTarget(data.arguments)}`, 300), state: "active" as const }));
      return { ...base, ...(tools.length ? { toolActivities: tools } : {}), turnLifecycle: { turnId: this.active.id, state: "active", startedAt: this.active.startedAt } };
    }
    if (role === "toolResult" && entry.message.toolCallId) return { turnId: this.active.id, answerDelta: "", toolActivities: [{ key: `tool:${entry.message.toolCallId}`, kind: toolKind(entry.message.toolName ?? "tool"), label: safeText(entry.message.toolName ?? "tool", 300), state: entry.message.isError ? "failed" : "done" }], turnLifecycle: { turnId: this.active.id, state: "active", startedAt: this.active.startedAt } };
    return { answerDelta: "" };
  }
}

async function loadSnapshot(path: string, sessionId: string): Promise<Snapshot | null> {
  if ((await stat(path)).size > MAX_FILE_BYTES) return null;
  const content = await readFile(path, "utf8");
  const lines = content.split("\n");
  if (lines.at(-1) !== "") lines.pop();
  const raw = lines.filter(Boolean).map((line) => { try { return JSON.parse(line) as unknown; } catch { return null; } });
  const header = headerSchema.safeParse(raw[0]);
  if (!header.success || header.data.id !== sessionId) return null;
  const entries = raw.slice(1).map((value) => entrySchema.safeParse(value)).filter((parsed) => parsed.success).map(({ data }) => data);
  return { entries: selectedBranch(entries) };
}

function selectedBranch(entries: PiEntry[]): PiEntry[] {
  if (!entries.length) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const selected = new Set<string>();
  let current: PiEntry | undefined = entries.at(-1);
  while (current) { selected.add(current.id); current = current.parentId ? byId.get(current.parentId) : undefined; }
  return entries.filter((entry) => selected.has(entry.id));
}

function boundaryIndex(entries: PiEntry[], boundary: Boundary): number | "missing" | "incomplete" {
  if (boundary.kind === "first") return 0;
  if (boundary.kind === "latest") return entries.length;
  if (boundary.kind === "active") {
    const lastUser = entries.findLastIndex((entry) => entry.message.role === "user");
    if (lastUser < 0) return entries.length;
    const completed = entries.slice(lastUser + 1).some((entry) => entry.message.role === "assistant" && entry.message.stopReason === "stop");
    return completed ? entries.length : lastUser;
  }
  if (boundary.kind !== "at" && boundary.kind !== "after") return entries.length;
  const start = entries.findIndex((entry) => entry.id === boundary.turnId && entry.timestamp === boundary.startedAt && entry.message.role === "user");
  if (start < 0) return "missing";
  if (boundary.kind === "at") return start;
  const next = entries.findIndex((entry, index) => index > start && entry.message.role === "user");
  const end = next < 0 ? entries.length : next;
  const completed = entries.slice(start + 1, end).some((entry) => entry.message.role === "assistant" && entry.message.stopReason === "stop");
  return completed ? end : "incomplete";
}

function textContent(content: unknown, max: number): string {
  const blocks = Array.isArray(content) ? content.map((part) => textBlockSchema.safeParse(part)).filter((parsed) => parsed.success).map(({ data }) => data.text.trim()).filter(Boolean) : typeof content === "string" ? [content.trim()] : [];
  return boundTranscriptMarkdown(redactSecrets(blocks.join("\n\n")), max);
}
function safeText(value: string, max: number): string { return boundTranscriptMarkdown(redactSecrets(value), max); }
function toolTarget(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  for (const key of ["path", "file_path", "command", "cmd", "query"]) if (typeof record[key] === "string") return record[key] as string;
  return "";
}
function toolKind(name: string): "read" | "search" | "edit" | "test" | "step" {
  if (/read/i.test(name)) return "read";
  if (/grep|find|search/i.test(name)) return "search";
  if (/write|edit|patch/i.test(name)) return "edit";
  if (/test/i.test(name)) return "test";
  return "step";
}
function unavailable(reason: Extract<AgentTranscriptOpenResult, { mode: "unavailable" }>["reason"]): AgentTranscriptOpenResult { return { mode: "unavailable", reason }; }
