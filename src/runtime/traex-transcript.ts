import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HerdrAgentSession } from "../domain/types.js";
import type { TraexTranscriptCursorPort, TraexTranscriptObservation, TraexTranscriptOpenResult, TraexTranscriptReaderPort } from "../domain/ports/external.js";
import { redactSecrets } from "./redact-secrets.js";
import { TraexTranscriptProjector } from "./traex-transcript-projector.js";
import { MAX_TURN_OUTPUT_CHARS } from "./bounded-turn-output.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_RENDERED_DELTA_CHARS = MAX_TURN_OUTPUT_CHARS;
const DEFAULT_MAX_DISCOVERY_ENTRIES = 100_000;
const DEFAULT_MAX_CACHED_PATHS = 256;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 250;
const SESSION_META_SCAN_BYTES = 256 * 1024;
const SESSION_META_MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECOVERY_SCAN_BYTES = 64 * 1024 * 1024;
const RECOVERY_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_RECOVERY_RECORD_BYTES = SESSION_META_MAX_BYTES;
const MAX_EPOCH_SECONDS = 10_000_000_000;

const envelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown()
}).passthrough();
const sessionMetaSchema = z.object({ id: z.string() }).passthrough();
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
  last_agent_message: z.string().nullable().optional()
}).passthrough();
const turnAbortedEventSchema = z.object({
  type: z.literal("turn_aborted"),
  turn_id: z.string().regex(SESSION_ID),
  reason: z.string().min(1).optional()
}).passthrough();
export interface TraexTranscriptReaderOptions {
  sessionsRoot?: string;
  maxReadBytes?: number;
  maxRenderedDeltaChars?: number;
  maxDiscoveryEntries?: number;
  maxCachedPaths?: number;
  negativeCacheTtlMs?: number;
  now?: () => number;
  discover?: (root: string, sessionId: string, maxEntries: number) => Promise<TranscriptDiscoveryResult>;
}

export class TraexTranscriptReader implements TraexTranscriptReaderPort {
  private readonly sessionsRoot: string;
  private readonly maxReadBytes: number;
  private readonly maxRenderedDeltaChars: number;
  private readonly maxDiscoveryEntries: number;
  private readonly maxCachedPaths: number;
  private readonly negativeCacheTtlMs: number;
  private readonly now: () => number;
  private readonly discover: (root: string, sessionId: string, maxEntries: number) => Promise<TranscriptDiscoveryResult>;
  private readonly pathsBySessionId = new Map<string, string>();
  private readonly missingUntilBySessionId = new Map<string, number>();
  private readonly discoveryBySessionId = new Map<string, Promise<TranscriptDiscoveryResult>>();

  constructor(options: TraexTranscriptReaderOptions = {}) {
    this.sessionsRoot = resolve(options.sessionsRoot ?? resolve(homedir(), ".trae/cli/sessions"));
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxRenderedDeltaChars = options.maxRenderedDeltaChars ?? DEFAULT_MAX_RENDERED_DELTA_CHARS;
    this.maxDiscoveryEntries = options.maxDiscoveryEntries ?? DEFAULT_MAX_DISCOVERY_ENTRIES;
    this.maxCachedPaths = Math.max(1, Math.floor(options.maxCachedPaths ?? DEFAULT_MAX_CACHED_PATHS));
    this.negativeCacheTtlMs = Math.max(0, options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS);
    this.now = options.now ?? Date.now;
    this.discover = options.discover ?? findExactTranscriptPaths;
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
          const baseline = await latestTranscriptBaseline(cachedPath, file.size, this.maxReadBytes, this.maxRenderedDeltaChars);
          return { mode: "typed", cursor: new FileTraexTranscriptCursor(cachedPath, file.size, this.maxReadBytes, this.maxRenderedDeltaChars, baseline.tokenCount, baseline.turnLifecycle) };
        }
        this.pathsBySessionId.delete(session.value);
      }
      const missingUntil = this.missingUntilBySessionId.get(session.value);
      if (missingUntil !== undefined && missingUntil > this.now()) return { mode: "unavailable", reason: "transcript_not_found" };
      if (missingUntil !== undefined) this.missingUntilBySessionId.delete(session.value);
      const discovery = await this.discoverOnce(session.value);
      const paths = discovery.paths;
      if (paths.length > 1) return { mode: "unavailable", reason: "ambiguous_transcript" };
      if (discovery.exhausted) return { mode: "unavailable", reason: "transcript_validation_failed" };
      if (paths.length === 0) { this.rememberMissing(session.value); return { mode: "unavailable", reason: "transcript_not_found" }; }
      const path = paths[0]!;
      if (!await containsMatchingSessionMeta(path, session.value)) {
        return { mode: "unavailable", reason: "transcript_validation_failed" };
      }
      this.rememberPath(session.value, path);
      const file = await stat(path);
      const baseline = await latestTranscriptBaseline(path, file.size, this.maxReadBytes, this.maxRenderedDeltaChars);
      return { mode: "typed", cursor: new FileTraexTranscriptCursor(path, file.size, this.maxReadBytes, this.maxRenderedDeltaChars, baseline.tokenCount, baseline.turnLifecycle) };
    } catch {
      return { mode: "unavailable", reason: "transcript_validation_failed" };
    }
  }

  async openActiveTurn(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptOpenResult> {
    if (!session) return { mode: "unavailable", reason: "missing_session_identity" };
    if (session.agent !== "traex" || session.kind !== "id" || !SESSION_ID.test(session.value)) return { mode: "unavailable", reason: "unsupported_session_identity" };
    try {
      const path = await this.resolveTranscriptPath(session.value);
      if (!path) return { mode: "unavailable", reason: "transcript_not_found" };
      const file = await stat(path);
      const baseline = await latestTranscriptBaseline(path, file.size, MAX_RECOVERY_SCAN_BYTES, this.maxRenderedDeltaChars);
      return { mode: "typed", cursor: new FileTraexTranscriptCursor(path, baseline.replayOffset ?? file.size, this.maxReadBytes, this.maxRenderedDeltaChars, baseline.tokenCount, baseline.replayOffset === null ? baseline.turnLifecycle : undefined) };
    } catch {
      return { mode: "unavailable", reason: "transcript_validation_failed" };
    }
  }

  async openFirstTurn(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptOpenResult> {
    if (!session) return { mode: "unavailable", reason: "missing_session_identity" };
    if (session.agent !== "traex" || session.kind !== "id" || !SESSION_ID.test(session.value)) {
      return { mode: "unavailable", reason: "unsupported_session_identity" };
    }
    try {
      const path = await this.resolveTranscriptPath(session.value);
      if (!path) return { mode: "unavailable", reason: "transcript_not_found" };
      return { mode: "typed", cursor: new FileTraexTranscriptCursor(path, 0, this.maxReadBytes, this.maxRenderedDeltaChars, 0, undefined) };
    } catch {
      return { mode: "unavailable", reason: "transcript_validation_failed" };
    }
  }

  async openAfterTurn(session: HerdrAgentSession | null | undefined, turnId: string, startedAt: string): Promise<TraexTranscriptOpenResult> {
    if (!session) return { mode: "unavailable", reason: "missing_session_identity" };
    if (session.agent !== "traex" || session.kind !== "id" || !SESSION_ID.test(session.value) || !SESSION_ID.test(turnId)) {
      return { mode: "unavailable", reason: "unsupported_session_identity" };
    }
    try {
      const path = await this.resolveTranscriptPath(session.value);
      if (!path) return { mode: "unavailable", reason: "transcript_not_found" };
      const file = await stat(path);
      if (file.size > MAX_RECOVERY_SCAN_BYTES) return { mode: "unavailable", reason: "transcript_validation_failed" };
      const boundary = await findCompletedTurnBoundary(path, file.size, turnId, startedAt);
      if (boundary === "missing") return { mode: "unavailable", reason: "turn_boundary_not_found" };
      if (boundary === "incomplete") return { mode: "unavailable", reason: "turn_boundary_incomplete" };
      const baseline = await latestTranscriptBaseline(path, boundary, this.maxReadBytes, this.maxRenderedDeltaChars);
      return { mode: "typed", cursor: new FileTraexTranscriptCursor(path, boundary, this.maxReadBytes, this.maxRenderedDeltaChars, baseline.tokenCount, undefined) };
    } catch {
      return { mode: "unavailable", reason: "transcript_validation_failed" };
    }
  }

  async openAtTurn(session: HerdrAgentSession | null | undefined, turnId: string, startedAt: string): Promise<TraexTranscriptOpenResult> {
    if (!session) return { mode: "unavailable", reason: "missing_session_identity" };
    if (session.agent !== "traex" || session.kind !== "id" || !SESSION_ID.test(session.value) || !SESSION_ID.test(turnId)) {
      return { mode: "unavailable", reason: "unsupported_session_identity" };
    }
    try {
      const path = await this.resolveTranscriptPath(session.value);
      if (!path) return { mode: "unavailable", reason: "transcript_not_found" };
      const file = await stat(path);
      const boundary = await findTurnStartBoundary(path, file.size, turnId, startedAt, Math.max(0, file.size - MAX_RECOVERY_SCAN_BYTES));
      if (boundary === "missing") return { mode: "unavailable", reason: "turn_boundary_not_found" };
      const baseline = await latestTranscriptBaseline(path, boundary, this.maxReadBytes, this.maxRenderedDeltaChars);
      return { mode: "typed", cursor: new FileTraexTranscriptCursor(path, boundary, this.maxReadBytes, this.maxRenderedDeltaChars, baseline.tokenCount, undefined) };
    } catch {
      return { mode: "unavailable", reason: "transcript_validation_failed" };
    }
  }

  private async resolveTranscriptPath(sessionId: string): Promise<string | null> {
    const cachedPath = this.pathsBySessionId.get(sessionId);
    if (cachedPath && await isValidTranscriptPath(this.sessionsRoot, cachedPath, sessionId)) {
      this.pathsBySessionId.delete(sessionId);
      this.pathsBySessionId.set(sessionId, cachedPath);
      return cachedPath;
    }
    if (cachedPath) this.pathsBySessionId.delete(sessionId);
    const discovery = await this.discoverOnce(sessionId);
    if (discovery.exhausted || discovery.paths.length !== 1) return null;
    const path = discovery.paths[0]!;
    if (!await containsMatchingSessionMeta(path, sessionId)) return null;
    this.rememberPath(sessionId, path);
    return path;
  }

  private rememberPath(sessionId: string, path: string): void {
    this.missingUntilBySessionId.delete(sessionId);
    this.pathsBySessionId.delete(sessionId);
    this.pathsBySessionId.set(sessionId, path);
    while (this.pathsBySessionId.size > this.maxCachedPaths) {
      const oldest = this.pathsBySessionId.keys().next().value;
      if (oldest === undefined) break;
      this.pathsBySessionId.delete(oldest);
    }
  }

  private discoverOnce(sessionId: string): Promise<TranscriptDiscoveryResult> {
    const existing = this.discoveryBySessionId.get(sessionId);
    if (existing) return existing;
    const discovery = this.discover(this.sessionsRoot, sessionId, this.maxDiscoveryEntries);
    this.discoveryBySessionId.set(sessionId, discovery);
    void discovery.finally(() => { if (this.discoveryBySessionId.get(sessionId) === discovery) this.discoveryBySessionId.delete(sessionId); });
    return discovery;
  }

  private rememberMissing(sessionId: string): void {
    this.missingUntilBySessionId.delete(sessionId);
    this.missingUntilBySessionId.set(sessionId, this.now() + this.negativeCacheTtlMs);
    while (this.missingUntilBySessionId.size > this.maxCachedPaths) {
      const oldest = this.missingUntilBySessionId.keys().next().value;
      if (oldest === undefined) break;
      this.missingUntilBySessionId.delete(oldest);
    }
  }
}

class FileTraexTranscriptCursor implements TraexTranscriptCursorPort {
  private readonly projector = new TraexTranscriptProjector();
  private pendingLines: string[] = [];
  private skippingOversizedRecord = false;

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
    while (this.pendingLines.length === 0) {
      const file = await stat(this.path);
      if (file.size < this.offset) throw new Error("TraeX transcript was truncated");
      const available = file.size - this.offset;
      if (available === 0) return {
        ...(this.turnLifecycle ? { turnId: this.turnLifecycle.turnId } : {}),
        answerDelta: "",
        ...(this.turnLifecycle ? { turnLifecycle: this.turnLifecycle } : {})
      };
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
      if (this.skippingOversizedRecord) {
        const firstNewline = chunk.indexOf(0x0a);
        if (firstNewline < 0) {
          this.offset += bytesRead;
          continue;
        }
        this.offset += firstNewline + 1;
        this.skippingOversizedRecord = false;
        continue;
      }
      if (lastNewline < 0) {
        if (available > this.maxReadBytes) {
          this.offset += bytesRead;
          this.skippingOversizedRecord = true;
          continue;
        }
        return { answerDelta: "" };
      }
      const complete = chunk.subarray(0, lastNewline + 1);
      this.offset += complete.length;
      this.pendingLines = complete.toString("utf8").split("\n").filter((line) => line.trim());
    }
    const batchLength = this.nextBatchLength();
    const lines = this.pendingLines.splice(0, batchLength);
    const projected = this.projector.project({ lines, initialLifecycle: this.turnLifecycle, tokenBaseline: this.tokenBaseline, maxRenderedDeltaChars: this.maxRenderedDeltaChars });
    this.turnLifecycle = projected.lifecycle;
    return projected.observation;
  }

  private nextBatchLength(): number {
    let scopedTurnId = this.turnLifecycle?.state === "active" ? this.turnLifecycle.turnId : undefined;
    for (let index = 0; index < this.pendingLines.length; index += 1) {
      const line = this.pendingLines[index]!;
      const envelope = parseEnvelope(line);
      if (!envelope) continue;
      const started = envelope.type === "event_msg" ? taskStartedEventSchema.safeParse(envelope.payload) : null;
      const completed = envelope.type === "event_msg" ? taskCompleteEventSchema.safeParse(envelope.payload) : null;
      const aborted = envelope.type === "event_msg" ? turnAbortedEventSchema.safeParse(envelope.payload) : null;
      if (started?.success) {
        if (index === 0) {
          scopedTurnId = started.data.turn_id;
          continue;
        }
        if (!scopedTurnId || started.data.turn_id !== scopedTurnId) return index;
      }
      if (completed?.success && scopedTurnId && completed.data.turn_id === scopedTurnId) return index + 1;
      if (aborted?.success && scopedTurnId && aborted.data.turn_id === scopedTurnId) return index + 1;
    }
    return this.pendingLines.length;
  }

}

function parseEnvelope(line: string): z.infer<typeof envelopeSchema> | null {
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
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
  if (completed.success) {
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
  const aborted = turnAbortedEventSchema.safeParse(envelope.payload);
  if (!aborted.success || current?.state !== "active" || current.turnId !== aborted.data.turn_id) return current;
  return {
    turnId: aborted.data.turn_id,
    state: "aborted",
    startedAt: current.startedAt,
    ...(aborted.data.reason ? { reason: boundMarkdown(redactSecrets(aborted.data.reason), maxRenderedDeltaChars) } : {})
  };
}

function eventTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString();
}

interface TranscriptBaseline {
  tokenCount: number | null;
  turnLifecycle: TraexTranscriptObservation["turnLifecycle"];
  replayOffset: number | null;
}

async function latestTranscriptBaseline(path: string, end: number, maxBytes: number, maxRenderedDeltaChars: number): Promise<TranscriptBaseline> {
  if (end <= 0) return { tokenCount: null, turnLifecycle: undefined, replayOffset: null };
  const start = Math.max(0, end - maxBytes);
  const handle = await open(path, "r");
  try {
    let tokenCount: number | null = null;
    let turnLifecycle: TraexTranscriptObservation["turnLifecycle"];
    let activeTurnOffset: number | null = null;
    let activeTurnTokenBaseline: number | null = null;
    let readOffset = start;
    let carry = Buffer.alloc(0);
    let carryOffset = start;
    let skipPartialFirstRecord = start > 0;
    const inspect = (line: string, offset: number) => {
      const envelope = parseEnvelope(line);
      if (!envelope) return;
      if (envelope.type === "event_msg") {
        const started = taskStartedEventSchema.safeParse(envelope.payload);
        if (started.success) { activeTurnOffset = offset; activeTurnTokenBaseline = tokenCount; }
        const tokens = tokenCountEventSchema.safeParse(envelope.payload);
        if (tokens.success) tokenCount = tokens.data.info.total_token_usage.total_tokens;
      }
      turnLifecycle = reduceTurnLifecycle(turnLifecycle, envelope, maxRenderedDeltaChars);
      if (turnLifecycle?.state !== "active") { activeTurnOffset = null; activeTurnTokenBaseline = null; }
    };
    while (readOffset < end) {
      const length = Math.min(RECOVERY_SCAN_CHUNK_BYTES, end - readOffset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, readOffset);
      if (bytesRead === 0) break;
      const source = carry.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const sourceOffset = carry.length === 0 ? readOffset : carryOffset;
      let recordStart = 0;
      while (true) {
        const newline = source.indexOf(0x0a, recordStart);
        if (newline < 0) break;
        if (skipPartialFirstRecord) skipPartialFirstRecord = false;
        else inspect(source.subarray(recordStart, newline).toString("utf8"), sourceOffset + recordStart);
        recordStart = newline + 1;
      }
      carry = source.subarray(recordStart);
      carryOffset = sourceOffset + recordStart;
      if (carry.length > MAX_RECOVERY_RECORD_BYTES) throw new Error("TraeX baseline record exceeds bounded size");
      readOffset += bytesRead;
    }
    if (!skipPartialFirstRecord && carry.length > 0) inspect(carry.toString("utf8"), carryOffset);
    return { tokenCount: activeTurnOffset === null ? tokenCount : activeTurnTokenBaseline, turnLifecycle, replayOffset: turnLifecycle?.state === "active" ? activeTurnOffset : null };
  } finally {
    await handle.close();
  }
}

async function findCompletedTurnBoundary(path: string, end: number, turnId: string, startedAt: string): Promise<number | "missing" | "incomplete"> {
  const expectedStartedAt = Date.parse(startedAt);
  if (!Number.isFinite(expectedStartedAt)) return "missing";
  const handle = await open(path, "r");
  try {
    let matchedStart = false;
    const inspectRecord = (record: Buffer, offset: number, nextOffset: number): number | undefined => {
      const envelope = parseEnvelope(record.toString("utf8").trimEnd());
      if (envelope?.type === "event_msg") {
        const started = taskStartedEventSchema.safeParse(envelope.payload);
        if (started.success) {
          if (started.data.turn_id === turnId && eventTime(started.data.started_at) === startedAt) matchedStart = true;
          else if (matchedStart && started.data.turn_id !== turnId) return offset;
        }
        const completed = taskCompleteEventSchema.safeParse(envelope.payload);
        if (matchedStart && completed.success && completed.data.turn_id === turnId && eventTime(completed.data.started_at) === startedAt) return nextOffset;
        const aborted = turnAbortedEventSchema.safeParse(envelope.payload);
        if (matchedStart && aborted.success && aborted.data.turn_id === turnId) return nextOffset;
      }
      return undefined;
    };

    let readOffset = 0;
    let carry = Buffer.alloc(0);
    let carryOffset = 0;
    while (readOffset < end) {
      const length = Math.min(RECOVERY_SCAN_CHUNK_BYTES, end - readOffset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, readOffset);
      if (bytesRead === 0) break;
      const source = carry.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const sourceOffset = carry.length === 0 ? readOffset : carryOffset;
      let recordStart = 0;
      while (true) {
        const newline = source.indexOf(0x0a, recordStart);
        if (newline < 0) break;
        const nextOffset = sourceOffset + newline + 1;
        const boundary = inspectRecord(source.subarray(recordStart, newline + 1), sourceOffset + recordStart, nextOffset);
        if (boundary !== undefined) return boundary;
        recordStart = newline + 1;
      }
      carry = source.subarray(recordStart);
      carryOffset = sourceOffset + recordStart;
      if (carry.length > MAX_RECOVERY_RECORD_BYTES) throw new Error("TraeX recovery record exceeds bounded size");
      readOffset += bytesRead;
    }
    if (carry.length > 0) {
      const boundary = inspectRecord(carry, carryOffset, carryOffset + carry.length);
      if (boundary !== undefined) return boundary;
    }
    return matchedStart ? "incomplete" : "missing";
  } finally {
    await handle.close();
  }
}

async function findTurnStartBoundary(path: string, end: number, turnId: string, startedAt: string, start = 0): Promise<number | "missing"> {
  const expectedStartedAt = Date.parse(startedAt);
  if (!Number.isFinite(expectedStartedAt)) return "missing";
  const handle = await open(path, "r");
  try {
    let readOffset = start;
    let carry = Buffer.alloc(0);
    let carryOffset = start;
    let skipPartialFirstRecord = start > 0;
    while (readOffset < end) {
      const length = Math.min(RECOVERY_SCAN_CHUNK_BYTES, end - readOffset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, readOffset);
      if (bytesRead === 0) break;
      const source = carry.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const sourceOffset = carry.length === 0 ? readOffset : carryOffset;
      let recordStart = 0;
      while (true) {
        const newline = source.indexOf(0x0a, recordStart);
        if (newline < 0) break;
        if (skipPartialFirstRecord) { skipPartialFirstRecord = false; recordStart = newline + 1; continue; }
        const envelope = parseEnvelope(source.subarray(recordStart, newline + 1).toString("utf8").trimEnd());
        const started = envelope?.type === "event_msg" ? taskStartedEventSchema.safeParse(envelope.payload) : null;
        if (started?.success && started.data.turn_id === turnId && eventTime(started.data.started_at) === startedAt) return sourceOffset + recordStart;
        recordStart = newline + 1;
      }
      carry = skipPartialFirstRecord ? Buffer.alloc(0) : source.subarray(recordStart);
      carryOffset = skipPartialFirstRecord ? readOffset + bytesRead : sourceOffset + recordStart;
      if (carry.length > MAX_RECOVERY_RECORD_BYTES) throw new Error("TraeX recovery record exceeds bounded size");
      readOffset += bytesRead;
    }
    if (carry.length > 0) {
      const envelope = parseEnvelope(carry.toString("utf8").trimEnd());
      const started = envelope?.type === "event_msg" ? taskStartedEventSchema.safeParse(envelope.payload) : null;
      if (started?.success && started.data.turn_id === turnId && eventTime(started.data.started_at) === startedAt) return carryOffset;
    }
    return "missing";
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

function boundMarkdown(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = "\n\n… output truncated";
  const room = Math.max(0, maxLength - suffix.length - 4);
  let prefix = value.slice(0, room).trimEnd();
  if ((prefix.match(/```/g)?.length ?? 0) % 2 === 1) prefix += "\n```";
  return `${prefix}${suffix}`.slice(0, maxLength);
}
