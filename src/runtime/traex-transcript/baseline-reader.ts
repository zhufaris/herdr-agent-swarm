import { open } from "node:fs/promises";
import type { AgentTranscriptObservation } from "../../domain/ports/external.js";
import {
  MAX_RECOVERY_RECORD_BYTES,
  RECOVERY_SCAN_CHUNK_BYTES,
  scanRecordsBackward,
} from "./boundary-scanner.js";
import {
  isBaselineEventRecord,
  parseEnvelope,
  reduceTurnLifecycle,
  taskCompleteEventSchema,
  taskStartedEventSchema,
  tokenCountEventSchema,
  turnAbortedEventSchema,
  type TraexTranscriptEnvelope,
} from "./record-codec.js";

export interface TranscriptBaseline {
  tokenCount: number | null;
  turnLifecycle: AgentTranscriptObservation["turnLifecycle"];
  replayOffset: number | null;
}

export async function latestTranscriptBaseline(
  path: string,
  end: number,
  maxBytes: number,
  maxRenderedDeltaChars: number,
): Promise<TranscriptBaseline> {
  if (end <= 0)
    return { tokenCount: null, turnLifecycle: undefined, replayOffset: null };
  const start = Math.max(0, end - maxBytes);
  const handle = await open(path, "r");
  try {
    let tokenCount: number | null = null;
    let turnLifecycle: AgentTranscriptObservation["turnLifecycle"];
    let activeTurnOffset: number | null = null;
    let activeTurnTokenBaseline: number | null = null;
    let readOffset = start;
    let carry = Buffer.alloc(0);
    let carryOffset = start;
    let skipPartialFirstRecord = start > 0;
    const inspect = (record: Buffer, offset: number) => {
      if (!isBaselineEventRecord(record)) return;
      const envelope = parseEnvelope(record.toString("utf8"));
      if (!envelope) return;
      if (envelope.type === "event_msg") {
        const started = taskStartedEventSchema.safeParse(envelope.payload);
        if (started.success) {
          activeTurnOffset = offset;
          activeTurnTokenBaseline = tokenCount;
        }
        const tokens = tokenCountEventSchema.safeParse(envelope.payload);
        if (tokens.success)
          tokenCount = tokens.data.info.total_token_usage.total_tokens;
      }
      turnLifecycle = reduceTurnLifecycle(
        turnLifecycle,
        envelope,
        maxRenderedDeltaChars,
      );
      if (turnLifecycle?.state !== "active") {
        activeTurnOffset = null;
        activeTurnTokenBaseline = null;
      }
    };
    while (readOffset < end) {
      const length = Math.min(RECOVERY_SCAN_CHUNK_BYTES, end - readOffset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, readOffset);
      if (bytesRead === 0) break;
      const source =
        carry.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const sourceOffset = carry.length === 0 ? readOffset : carryOffset;
      let recordStart = 0;
      while (true) {
        const newline = source.indexOf(0x0a, recordStart);
        if (newline < 0) break;
        if (skipPartialFirstRecord) skipPartialFirstRecord = false;
        else inspect(source.subarray(recordStart, newline), sourceOffset + recordStart);
        recordStart = newline + 1;
      }
      carry = source.subarray(recordStart);
      carryOffset = sourceOffset + recordStart;
      if (carry.length > MAX_RECOVERY_RECORD_BYTES)
        throw new Error("TraeX baseline record exceeds bounded size");
      readOffset += bytesRead;
    }
    if (!skipPartialFirstRecord && carry.length > 0) inspect(carry, carryOffset);
    return {
      tokenCount:
        activeTurnOffset === null ? tokenCount : activeTurnTokenBaseline,
      turnLifecycle,
      replayOffset:
        turnLifecycle?.state === "active" ? activeTurnOffset : null,
    };
  } finally {
    await handle.close();
  }
}

export async function latestActiveTranscriptBaseline(
  path: string,
  end: number,
  maxBytes: number,
  maxRenderedDeltaChars: number,
): Promise<TranscriptBaseline> {
  if (end <= 0)
    return { tokenCount: null, turnLifecycle: undefined, replayOffset: null };
  const lowerBound = Math.max(0, end - maxBytes);
  const handle = await open(path, "r");
  let latestTokenCount: number | null | undefined;
  let activeTurnTokenBaseline: number | null | undefined;
  let latestStartOffset: number | null = null;
  const laterLifecycle: TraexTranscriptEnvelope[] = [];
  let turnLifecycle: AgentTranscriptObservation["turnLifecycle"];
  try {
    await scanRecordsBackward(handle, lowerBound, end, (record, offset) => {
      if (!isBaselineEventRecord(record)) return false;
      const envelope = parseEnvelope(record.toString("utf8"));
      if (!envelope || envelope.type !== "event_msg") return false;
      const tokens = tokenCountEventSchema.safeParse(envelope.payload);
      if (tokens.success) {
        latestTokenCount ??= tokens.data.info.total_token_usage.total_tokens;
        if (
          latestStartOffset !== null &&
          activeTurnTokenBaseline === undefined
        )
          activeTurnTokenBaseline =
            tokens.data.info.total_token_usage.total_tokens;
      }
      if (latestStartOffset === null) {
        const started = taskStartedEventSchema.safeParse(envelope.payload);
        if (started.success) {
          latestStartOffset = offset;
          turnLifecycle = reduceTurnLifecycle(
            undefined,
            envelope,
            maxRenderedDeltaChars,
          );
          for (let index = laterLifecycle.length - 1; index >= 0; index -= 1) {
            turnLifecycle = reduceTurnLifecycle(
              turnLifecycle,
              laterLifecycle[index]!,
              maxRenderedDeltaChars,
            );
          }
        } else if (
          taskCompleteEventSchema.safeParse(envelope.payload).success ||
          turnAbortedEventSchema.safeParse(envelope.payload).success
        ) {
          laterLifecycle.push(envelope);
        }
      }
      if (latestStartOffset === null) return false;
      if (turnLifecycle?.state === "active")
        return activeTurnTokenBaseline !== undefined;
      return latestTokenCount !== undefined;
    });
    if (latestStartOffset === null)
      return {
        tokenCount: latestTokenCount ?? null,
        turnLifecycle: undefined,
        replayOffset: null,
      };
    return {
      tokenCount:
        turnLifecycle?.state === "active"
          ? activeTurnTokenBaseline ?? null
          : latestTokenCount ?? null,
      turnLifecycle,
      replayOffset:
        turnLifecycle?.state === "active" ? latestStartOffset : null,
    };
  } finally {
    await handle.close();
  }
}
