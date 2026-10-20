import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { AgentTranscriptSource } from "../domain/ports/external.js";
import type { DescriptorAwareTranscriptReader } from "./agent-transcript-reader.js";
import { AGENT_SESSION_ID } from "./agent-transcript-codec.js";
import { eventTime, parseEnvelope, taskStartedEventSchema } from "./traex-transcript.js";

// A lineage proof needs to see every earlier turn in the session, but it must
// never load a whole long-running transcript into memory. This is deliberately
// a byte budget rather than an answer/output budget: only small JSONL records
// are decoded and the result contains metadata only.
const DEFAULT_MAX_SCAN_BYTES = 128 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_METADATA_RECORD_BYTES = 256 * 1024;
const MAX_OBJECTIVE_CHARS = 16 * 1024;
const CONTINUATION_PREFIX = "Continue working toward the active thread goal.";

export interface TraexTurnLineage {
  turnId: string;
  startedAt: string;
  origin: "prompt" | "runtime_continuation" | "unknown";
  parentTurnId: string | null;
  chainId: string | null;
}

export interface TraexTurnLineageProbeOptions { maxScanBytes?: number; }

interface TurnState {
  turnId: string;
  startedAt: string;
  terminal: "completed" | "aborted" | null;
  input: { role: "user" | "developer"; text: string } | null;
  mixedInput: boolean;
}

interface GoalEnvelope { fingerprint: string; elapsed: number; tokens: number; }

/**
 * Derives only turn lineage from an already validated TraeX JSONL path. It is
 * deliberately not an answer reader: no assistant, tool, or reasoning record
 * is returned or persisted.
 */
export class TraexTurnLineageProbe {
  private readonly maxScanBytes: number;

  constructor(private readonly reader: DescriptorAwareTranscriptReader, options: TraexTurnLineageProbeOptions = {}) {
    this.maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  }

  async inspect(source: AgentTranscriptSource): Promise<TraexTurnLineage[]> {
    try {
      const descriptor = await this.reader.resolveTranscriptDescriptor?.(source);
      if (!descriptor) return [];
      const info = await stat(descriptor.path);
      if (!info.isFile() || info.size > this.maxScanBytes) return [];
      const lines = await readMetadataLines(descriptor.path, info.size, this.maxScanBytes);
      if (!lines) return [];
      const unchanged = await stat(descriptor.path);
      if (!unchanged.isFile() || unchanged.size !== info.size) return [];
      return classify(lines);
    } catch {
      return [];
    }
  }
}

function classify(lines: readonly string[]): TraexTurnLineage[] {
  const turns: TurnState[] = [];
  const byId = new Map<string, TurnState>();
  for (const line of lines) {
    if (!line) continue;
    const envelope = parseEnvelope(line);
    if (!envelope) return [];
    if (envelope.type === "event_msg") {
      const started = taskStartedEventSchema.safeParse(envelope.payload);
      if (started.success) {
        if (byId.has(started.data.turn_id)) return [];
        const turn = { turnId: started.data.turn_id, startedAt: eventTime(started.data.started_at), terminal: null, input: null, mixedInput: false } satisfies TurnState;
        byId.set(turn.turnId, turn);
        turns.push(turn);
        continue;
      }
      const completeTurnId = terminalTurnId(envelope.payload, "task_complete");
      if (completeTurnId) {
        const turn = byId.get(completeTurnId);
        if (!turn || turn.terminal) return [];
        turn.terminal = "completed";
        continue;
      }
      const abortedTurnId = terminalTurnId(envelope.payload, "turn_aborted");
      if (abortedTurnId) {
        const turn = byId.get(abortedTurnId);
        if (!turn || turn.terminal) return [];
        turn.terminal = "aborted";
      }
      continue;
    }
    if (envelope.type !== "history_mutation") continue;
    observeMutation(envelope.payload, byId);
  }

  const classified: TraexTurnLineage[] = [];
  let activeFingerprint: string | null = null;
  let activeChainId: string | null = null;
  let previousCounters: { elapsed: number; tokens: number } | null = null;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    const parent = index === 0 ? null : turns[index - 1]!;
    const base = { turnId: turn.turnId, startedAt: turn.startedAt };
    if (turn.input?.role === "user" && !turn.mixedInput) {
      // A goal continuation can be approved by a short user reply (for
      // example, "确认"). Its objective is introduced only by the first
      // proven developer envelope, never inferred from the prompt body.
      activeFingerprint = null;
      activeChainId = turn.turnId;
      previousCounters = null;
      classified.push({ ...base, origin: "prompt", parentTurnId: null, chainId: turn.turnId });
      continue;
    }
    const goal = turn.input?.role === "developer" && !turn.mixedInput ? parseGoalEnvelope(turn.input.text) : null;
    // A dispatched Prompt can begin on a runtime continuation after TraeX
    // compacted the thread. That first developer envelope is not itself
    // sufficient to claim ownership, so it remains unknown; however it can
    // establish the objective fingerprint needed to prove its direct child.
    // The observer still adopts only a child whose exact parent is already
    // durably owned by the Prompt.
    if (goal && (!activeChainId || (activeFingerprint !== null && activeFingerprint !== goal.fingerprint))) {
      classified.push({ ...base, origin: "unknown", parentTurnId: null, chainId: null });
      activeFingerprint = goal.fingerprint;
      activeChainId = turn.turnId;
      previousCounters = { elapsed: goal.elapsed, tokens: goal.tokens };
      continue;
    }
    if (goal && parent?.terminal === "completed" && activeChainId &&
      (activeFingerprint === null || activeFingerprint === goal.fingerprint) &&
      (!previousCounters || (goal.elapsed >= previousCounters.elapsed && goal.tokens >= previousCounters.tokens))) {
      classified.push({ ...base, origin: "runtime_continuation", parentTurnId: parent.turnId, chainId: activeChainId });
      activeFingerprint = goal.fingerprint;
      previousCounters = { elapsed: goal.elapsed, tokens: goal.tokens };
      continue;
    }
    classified.push({ ...base, origin: "unknown", parentTurnId: null, chainId: null });
    activeFingerprint = null;
    activeChainId = null;
    previousCounters = null;
  }
  return classified;
}

// Core lifecycle records are allowed to omit fields used only for rendering
// (notably task_complete.started_at). The lineage proof needs solely the event
// kind and a syntactically valid turn ID; it never reads final-answer text.
function terminalTurnId(payload: unknown, type: "task_complete" | "turn_aborted"): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as { type?: unknown; turn_id?: unknown };
  return value.type === type && typeof value.turn_id === "string" && AGENT_SESSION_ID.test(value.turn_id) ? value.turn_id : null;
}

/**
 * Reads JSONL incrementally, retaining only records small enough to contain
 * lifecycle or prompt metadata. Large tool/output records are discarded before
 * decoding; this can only make a lineage proof unavailable, never invent one.
 */
async function readMetadataLines(path: string, expectedSize: number, maxBytes: number): Promise<string[] | null> {
  if (expectedSize > maxBytes) return null;
  const handle = await open(path, "r");
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const lines: string[] = [];
  let position = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  try {
    while (position < expectedSize) {
      const length = Math.min(buffer.length, expectedSize - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) return null;
      position += bytesRead;
      let start = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        if (!discarding) {
          // The read buffer is reused for the next chunk, so pending fragments
          // must own their bytes.
          const tail = Buffer.from(buffer.subarray(start, index));
          pending.push(tail);
          pendingBytes += tail.length;
          if (pendingBytes <= MAX_METADATA_RECORD_BYTES) {
            const line = Buffer.concat(pending, pendingBytes).toString("utf8");
            if (line.trim()) lines.push(line);
          }
        }
        pending = [];
        pendingBytes = 0;
        discarding = false;
        start = index + 1;
      }
      if (start === bytesRead) continue;
      if (discarding) continue;
      const tail = Buffer.from(buffer.subarray(start, bytesRead));
      pending.push(tail);
      pendingBytes += tail.length;
      if (pendingBytes > MAX_METADATA_RECORD_BYTES) {
        pending = [];
        pendingBytes = 0;
        discarding = true;
      }
    }
    // A partial final line is an unstable transcript snapshot. Fail closed.
    return pendingBytes === 0 && !discarding ? lines : null;
  } finally {
    await handle.close();
  }
}

function observeMutation(payload: unknown, byId: ReadonlyMap<string, TurnState>): void {
  if (!payload || typeof payload !== "object") return;
  const raw = payload as { turn_id?: unknown; operation?: unknown; items?: unknown };
  if (typeof raw.turn_id !== "string" || raw.operation !== "append" || !Array.isArray(raw.items)) return;
  const turn = byId.get(raw.turn_id);
  if (!turn) return;
  for (const item of raw.items) {
    const input = readInput(item);
    if (!input) continue;
    // TraeX can append further developer context to the same runtime turn
    // (for example compaction or environment context). It does not change
    // the already validated continuation envelope. A role change, however,
    // means a human input may have been interleaved, so that remains
    // deliberately unprovable.
    if (turn.input) {
      if (turn.input.role !== input.role) turn.mixedInput = true;
      continue;
    }
    turn.input = input;
  }
}

function readInput(item: unknown): { role: "user" | "developer"; text: string } | null {
  if (!item || typeof item !== "object") return null;
  const record = item as { type?: unknown; role?: unknown; content?: unknown };
  if (record.type !== "message" || (record.role !== "user" && record.role !== "developer") || !Array.isArray(record.content)) return null;
  const texts = record.content
    .filter((part): part is { type: "input_text"; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "input_text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text);
  return texts.length === 1 && texts[0]!.length <= MAX_OBJECTIVE_CHARS ? { role: record.role, text: texts[0]! } : null;
}

function parseGoalEnvelope(text: string): GoalEnvelope | null {
  if (text.length > MAX_OBJECTIVE_CHARS || !text.startsWith(CONTINUATION_PREFIX)) return null;
  const objective = text.match(/<untrusted_objective>\n([\s\S]*?)\n<\/untrusted_objective>/);
  const elapsed = text.match(/^- Time spent pursuing goal: (\d+) seconds$/m);
  const tokens = text.match(/^- Tokens used: (\d+)$/m);
  if (!objective || objective[1] === undefined || !elapsed || !tokens || !text.includes("Budget:") || !text.includes("Avoid repeating work that is already done.")) return null;
  const normalized = objective[1].trim().replace(/\s+/g, " " );
  const elapsedValue = Number(elapsed[1]);
  const tokenValue = Number(tokens[1]);
  if (!normalized || !Number.isSafeInteger(elapsedValue) || !Number.isSafeInteger(tokenValue)) return null;
  return { fingerprint: fingerprint(normalized), elapsed: elapsedValue, tokens: tokenValue };
}

function fingerprint(text: string): string { return createHash("sha256").update(text.trim().replace(/\s+/g, " " )).digest("hex"); }
