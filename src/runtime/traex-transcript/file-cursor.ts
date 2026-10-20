import { open, stat } from "node:fs/promises";
import type { AgentTranscriptCursorPort, AgentTranscriptObservation } from "../../domain/ports/external.js";
import { TraexTranscriptProjector } from "../traex-transcript-projector.js";
import { parseEnvelope, taskCompleteEventSchema, taskStartedEventSchema, turnAbortedEventSchema } from "./record-codec.js";

export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

export class FileTraexTranscriptCursor implements AgentTranscriptCursorPort {
  private readonly projector: TraexTranscriptProjector;
  private pendingLines: string[] = [];
  private skippingOversizedRecord = false;

  constructor(
    private readonly path: string,
    private offset: number,
    private readonly maxReadBytes: number,
    private readonly maxRenderedDeltaChars: number,
    private readonly tokenBaseline: number | null,
    private turnLifecycle: AgentTranscriptObservation["turnLifecycle"],
    reasoningDisplay: "hidden" | "summary" | "visible" = "visible",
  ) { this.projector = new TraexTranscriptProjector(reasoningDisplay); }

  async readDelta(): Promise<string> {
    return (await this.readObservation()).answerDelta;
  }

  async readObservation(): Promise<AgentTranscriptObservation> {
    while (this.pendingLines.length === 0) {
      const file = await stat(this.path);
      if (file.size < this.offset) throw new Error("TraeX transcript was truncated");
      const available = file.size - this.offset;
      if (available === 0) {
        return {
          ...(this.turnLifecycle ? { turnId: this.turnLifecycle.turnId } : {}),
          answerDelta: "",
          ...(this.turnLifecycle ? { turnLifecycle: this.turnLifecycle } : {}),
        };
      }
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
    const projected = this.projector.project({
      lines,
      initialLifecycle: this.turnLifecycle,
      tokenBaseline: this.tokenBaseline,
      maxRenderedDeltaChars: this.maxRenderedDeltaChars,
    });
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
