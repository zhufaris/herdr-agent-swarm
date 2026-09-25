import { open } from "node:fs/promises";
import {
  eventTime,
  parseEnvelope,
  taskCompleteEventSchema,
  taskStartedEventSchema,
  turnAbortedEventSchema,
} from "./record-codec.js";

export const MAX_RECOVERY_SCAN_BYTES = 64 * 1024 * 1024;
export const RECOVERY_SCAN_CHUNK_BYTES = 1024 * 1024;
export const MAX_RECOVERY_RECORD_BYTES = 4 * 1024 * 1024;

export async function scanRecordsBackward(
  handle: Awaited<ReturnType<typeof open>>,
  lowerBound: number,
  end: number,
  inspect: (record: Buffer, offset: number) => boolean,
): Promise<void> {
  let position = end;
  let carry = Buffer.alloc(0);
  while (position > lowerBound) {
    const start = Math.max(lowerBound, position - RECOVERY_SCAN_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(position - start);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
    if (bytesRead === 0) break;
    const source =
      carry.length === 0
        ? chunk.subarray(0, bytesRead)
        : Buffer.concat([chunk.subarray(0, bytesRead), carry]);
    const firstNewline = source.indexOf(0x0a);
    if (firstNewline < 0) {
      carry = source;
      if (carry.length > MAX_RECOVERY_RECORD_BYTES)
        throw new Error("TraeX baseline record exceeds bounded size");
      position = start;
      continue;
    }
    let recordEnd = source.length;
    while (recordEnd > firstNewline) {
      const newline = source.lastIndexOf(0x0a, recordEnd - 1);
      const recordStart = newline + 1;
      if (
        recordEnd > recordStart &&
        inspect(source.subarray(recordStart, recordEnd), start + recordStart)
      )
        return;
      recordEnd = newline;
    }
    carry = source.subarray(0, firstNewline);
    if (carry.length > MAX_RECOVERY_RECORD_BYTES)
      throw new Error("TraeX baseline record exceeds bounded size");
    position = start;
  }
  if (lowerBound === 0 && carry.length > 0) inspect(carry, 0);
}

export async function findCompletedTurnBoundary(
  path: string,
  end: number,
  turnId: string,
  startedAt: string,
): Promise<number | "missing" | "incomplete"> {
  const expectedStartedAt = Date.parse(startedAt);
  if (!Number.isFinite(expectedStartedAt)) return "missing";
  const handle = await open(path, "r");
  try {
    let matchedStart = false;
    const inspectRecord = (
      record: Buffer,
      offset: number,
      nextOffset: number,
    ): number | undefined => {
      const envelope = parseEnvelope(record.toString("utf8").trimEnd());
      if (envelope?.type === "event_msg") {
        const started = taskStartedEventSchema.safeParse(envelope.payload);
        if (started.success) {
          if (
            started.data.turn_id === turnId &&
            eventTime(started.data.started_at) === startedAt
          )
            matchedStart = true;
          else if (matchedStart && started.data.turn_id !== turnId) return offset;
        }
        const completed = taskCompleteEventSchema.safeParse(envelope.payload);
        if (
          matchedStart &&
          completed.success &&
          completed.data.turn_id === turnId &&
          eventTime(completed.data.started_at) === startedAt
        )
          return nextOffset;
        const aborted = turnAbortedEventSchema.safeParse(envelope.payload);
        if (
          matchedStart &&
          aborted.success &&
          aborted.data.turn_id === turnId
        )
          return nextOffset;
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
      const source =
        carry.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const sourceOffset = carry.length === 0 ? readOffset : carryOffset;
      let recordStart = 0;
      while (true) {
        const newline = source.indexOf(0x0a, recordStart);
        if (newline < 0) break;
        const nextOffset = sourceOffset + newline + 1;
        const boundary = inspectRecord(
          source.subarray(recordStart, newline + 1),
          sourceOffset + recordStart,
          nextOffset,
        );
        if (boundary !== undefined) return boundary;
        recordStart = newline + 1;
      }
      carry = source.subarray(recordStart);
      carryOffset = sourceOffset + recordStart;
      if (carry.length > MAX_RECOVERY_RECORD_BYTES)
        throw new Error("TraeX recovery record exceeds bounded size");
      readOffset += bytesRead;
    }
    if (carry.length > 0) {
      const boundary = inspectRecord(
        carry,
        carryOffset,
        carryOffset + carry.length,
      );
      if (boundary !== undefined) return boundary;
    }
    return matchedStart ? "incomplete" : "missing";
  } finally {
    await handle.close();
  }
}

export async function findTurnStartBoundary(
  path: string,
  end: number,
  turnId: string,
  startedAt: string,
  start = 0,
): Promise<number | "missing"> {
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
      const source =
        carry.length === 0
          ? chunk.subarray(0, bytesRead)
          : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const sourceOffset = carry.length === 0 ? readOffset : carryOffset;
      let recordStart = 0;
      while (true) {
        const newline = source.indexOf(0x0a, recordStart);
        if (newline < 0) break;
        if (skipPartialFirstRecord) {
          skipPartialFirstRecord = false;
          recordStart = newline + 1;
          continue;
        }
        const envelope = parseEnvelope(
          source
            .subarray(recordStart, newline + 1)
            .toString("utf8")
            .trimEnd(),
        );
        const started =
          envelope?.type === "event_msg"
            ? taskStartedEventSchema.safeParse(envelope.payload)
            : null;
        if (
          started?.success &&
          started.data.turn_id === turnId &&
          eventTime(started.data.started_at) === startedAt
        )
          return sourceOffset + recordStart;
        recordStart = newline + 1;
      }
      carry = skipPartialFirstRecord
        ? Buffer.alloc(0)
        : source.subarray(recordStart);
      carryOffset = skipPartialFirstRecord
        ? readOffset + bytesRead
        : sourceOffset + recordStart;
      if (carry.length > MAX_RECOVERY_RECORD_BYTES)
        throw new Error("TraeX recovery record exceeds bounded size");
      readOffset += bytesRead;
    }
    if (carry.length > 0) {
      const envelope = parseEnvelope(carry.toString("utf8").trimEnd());
      const started =
        envelope?.type === "event_msg"
          ? taskStartedEventSchema.safeParse(envelope.payload)
          : null;
      if (
        started?.success &&
        started.data.turn_id === turnId &&
        eventTime(started.data.started_at) === startedAt
      )
        return carryOffset;
    }
    return "missing";
  } finally {
    await handle.close();
  }
}
