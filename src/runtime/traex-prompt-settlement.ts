import { open, opendir, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { TraexTranscriptOpenResult, TraexTranscriptObservation } from "../domain/ports/external.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DISCOVERY_ENTRIES = 100_000;
const MAX_META_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 1024 * 1024;

export class TraexPromptTranscriptReader {
  constructor(private readonly sessionsRoot: string) {}

  async open(session: { source: string; agent: string; kind: "id"; value: string }, expectedPrompt?: string): Promise<TraexTranscriptOpenResult> {
    if (session.agent !== "traex" || session.kind !== "id" || !SESSION_ID.test(session.value)) return { mode: "unavailable", reason: "unsupported_session_identity" };
    try {
      const paths = await findExactPaths(this.sessionsRoot, session.value);
      if (paths === "exhausted") return { mode: "unavailable", reason: "transcript_validation_failed" };
      if (paths.length > 1) return { mode: "unavailable", reason: "ambiguous_transcript" };
      if (paths.length === 0) return { mode: "unavailable", reason: "transcript_not_found" };
      const path = paths[0]!;
      if (!await hasSessionMeta(path, session.value)) return { mode: "unavailable", reason: "transcript_validation_failed" };
      return { mode: "typed", cursor: new SettlementCursor(path, (await stat(path)).size, expectedPrompt) };
    } catch {
      return { mode: "unavailable", reason: "transcript_validation_failed" };
    }
  }
}

class SettlementCursor {
  private carry = Buffer.alloc(0);
  private pendingLines: string[] = [];
  private lifecycle: TraexTranscriptObservation["turnLifecycle"];

  constructor(private readonly path: string, private offset: number, private readonly expectedPrompt?: string) {}

  async readDelta(): Promise<string> { return ""; }

  async readObservation(): Promise<TraexTranscriptObservation> {
    if (this.pendingLines.length === 0) {
      const file = await stat(this.path);
      if (file.size < this.offset) throw new Error("TraeX transcript was truncated");
      const available = file.size - this.offset;
      if (available === 0) return this.current();
      if (available > MAX_READ_BYTES) throw new Error("TraeX settlement read exceeds limit");
      const handle = await open(this.path, "r");
      const buffer = Buffer.alloc(available);
      let bytesRead = 0;
      try { ({ bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset)); } finally { await handle.close(); }
      this.offset += bytesRead;
      const source = this.carry.length ? Buffer.concat([this.carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      const lastNewline = source.lastIndexOf(0x0a);
      if (lastNewline < 0) { this.carry = source; return this.current(); }
      this.carry = source.subarray(lastNewline + 1);
      this.pendingLines = source.subarray(0, lastNewline + 1).toString("utf8").split("\n").filter((line) => line.trim());
    }
    const batchLength = this.nextBatchLength();
    const lines = this.pendingLines.splice(0, batchLength);
    let freshTurnStart = false;
    let observationTurnId: string | undefined;
    for (const line of lines) {
      const event = lifecycleEvent(line, this.expectedPrompt);
      if (!event) continue;
      if (event.type === "task_started") {
        this.lifecycle = { turnId: event.turnId, state: "active", startedAt: event.startedAt };
        observationTurnId = event.turnId; freshTurnStart = true;
      } else if (this.lifecycle?.state === "active" && this.lifecycle.turnId === event.turnId) {
        this.lifecycle = event.type === "task_complete"
          ? { turnId: event.turnId, state: "completed", startedAt: this.lifecycle.startedAt }
          : { turnId: event.turnId, state: "aborted", startedAt: this.lifecycle.startedAt };
        observationTurnId = event.turnId;
      }
    }
    return { ...(observationTurnId ? { turnId: observationTurnId } : {}), ...(freshTurnStart ? { freshTurnStart: true } : {}), answerDelta: "", ...(observationTurnId && this.lifecycle?.turnId === observationTurnId ? { turnLifecycle: this.lifecycle } : {}) };
  }

  private nextBatchLength(): number {
    let scopedTurnId = this.lifecycle?.state === "active" ? this.lifecycle.turnId : undefined;
    for (let index = 0; index < this.pendingLines.length; index += 1) {
      const event = lifecycleEvent(this.pendingLines[index]!, this.expectedPrompt);
      if (!event) continue;
      if (event.type === "task_started") {
        if (!scopedTurnId) { scopedTurnId = event.turnId; continue; }
        if (event.turnId !== scopedTurnId) return index;
      }
      if (event.type !== "task_started" && scopedTurnId === event.turnId) return index + 1;
    }
    return this.pendingLines.length;
  }

  private current(): TraexTranscriptObservation {
    return { ...(this.lifecycle ? { turnId: this.lifecycle.turnId, turnLifecycle: this.lifecycle } : {}), answerDelta: "" };
  }
}

type LifecycleEvent = { type: "task_started" | "task_complete" | "turn_aborted"; turnId: string; startedAt: string };
function lifecycleEvent(line: string, expectedPrompt?: string): LifecycleEvent | null {
  if (!line.trim()) return null;
  try {
    const envelope = JSON.parse(line) as { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> };
    const mutationStart = historyMutationStart(envelope, expectedPrompt);
    if (mutationStart) return mutationStart;
    const payload = envelope.type === "event_msg" ? envelope.payload : null;
    if (!payload || !["task_started", "task_complete", "turn_aborted"].includes(String(payload.type)) || typeof payload.turn_id !== "string" || !SESSION_ID.test(payload.turn_id)) return null;
    const seconds = payload.started_at;
    if (payload.type !== "turn_aborted" && (!Number.isInteger(seconds) || Number(seconds) < 0 || Number(seconds) > 10_000_000_000)) return null;
    return { type: payload.type as LifecycleEvent["type"], turnId: payload.turn_id, startedAt: new Date(Number(seconds ?? 0) * 1_000).toISOString() };
  } catch { return null; }
}

function historyMutationStart(
  envelope: { timestamp?: unknown; type?: unknown; payload?: Record<string, unknown> },
  expectedPrompt?: string
): LifecycleEvent | null {
  if (expectedPrompt === undefined || envelope.type !== "history_mutation" || typeof envelope.timestamp !== "string") return null;
  const payload = envelope.payload;
  if (payload?.operation !== "append" || typeof payload.turn_id !== "string" || !SESSION_ID.test(payload.turn_id) || !Array.isArray(payload.items)) return null;
  const matches = payload.items.some((item) => {
    if (!item || typeof item !== "object") return false;
    const message = item as { type?: unknown; role?: unknown; content?: unknown };
    if (message.type !== "message" || message.role !== "user" || !Array.isArray(message.content)) return false;
    return message.content.some((content) => {
      if (!content || typeof content !== "object") return false;
      const part = content as { type?: unknown; text?: unknown };
      return part.type === "input_text" && part.text === expectedPrompt;
    });
  });
  const startedAt = Date.parse(envelope.timestamp);
  return matches && Number.isFinite(startedAt)
    ? { type: "task_started", turnId: payload.turn_id, startedAt: new Date(startedAt).toISOString() }
    : null;
}

async function findExactPaths(root: string, sessionId: string): Promise<string[] | "exhausted"> {
  const rootPath = await realpath(root);
  const matches: string[] = []; let visited = 0; let exhausted = false;
  const visit = async (directory: string): Promise<void> => {
    if (matches.length > 1 || exhausted) return;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (++visited > MAX_DISCOVERY_ENTRIES) { exhausted = true; break; }
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && basename(path).endsWith(`-${sessionId}.jsonl`)) matches.push(path);
      if (matches.length > 1 || exhausted) break;
    }
  };
  await visit(rootPath);
  if (exhausted) return "exhausted";
  for (const path of matches) {
    const child = relative(rootPath, await realpath(path));
    if (child === ".." || child.startsWith(`..${sep}`)) return [];
  }
  return matches;
}

async function hasSessionMeta(path: string, sessionId: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_META_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return false;
    const envelope = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as { type?: unknown; payload?: { id?: unknown } };
    return envelope.type === "session_meta" && envelope.payload?.id === sessionId;
  } catch { return false; } finally { await handle.close(); }
}
