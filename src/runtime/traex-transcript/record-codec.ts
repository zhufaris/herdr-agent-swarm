import { z } from "zod";
import type { AgentTranscriptObservation } from "../../domain/ports/external.js";
import { AGENT_SESSION_ID, boundTranscriptMarkdown } from "../agent-transcript-codec.js";
import { redactSecrets } from "../redact-secrets.js";

export const MAX_EPOCH_SECONDS = 10_000_000_000;

export const envelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
}).passthrough();

export const sessionMetaSchema = z.object({
  id: z.string(),
}).passthrough();

export const tokenCountEventSchema = z.object({
  type: z.literal("token_count"),
  info: z.object({
    total_token_usage: z.object({
      total_tokens: z.number().int().nonnegative(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

export const taskStartedEventSchema = z.object({
  type: z.literal("task_started"),
  turn_id: z.string().regex(AGENT_SESSION_ID),
  started_at: z.number().int().nonnegative().max(MAX_EPOCH_SECONDS),
}).passthrough();

export const taskCompleteEventSchema = z.object({
  type: z.literal("task_complete"),
  turn_id: z.string().regex(AGENT_SESSION_ID),
  started_at: z.number().int().nonnegative().max(MAX_EPOCH_SECONDS),
  last_agent_message: z.string().nullable().optional(),
}).passthrough();

export const turnAbortedEventSchema = z.object({
  type: z.literal("turn_aborted"),
  turn_id: z.string().regex(AGENT_SESSION_ID),
  reason: z.string().min(1).optional(),
}).passthrough();

export type TraexTranscriptEnvelope = z.infer<typeof envelopeSchema>;
export type TraexTurnLifecycle = AgentTranscriptObservation["turnLifecycle"];

const BASELINE_EVENT_MARKERS = ["task_started", "task_complete", "turn_aborted", "token_count"]
  .map((value) => Buffer.from(value));

export function parseEnvelope(line: string): TraexTranscriptEnvelope | null {
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function reduceTurnLifecycle(
  current: TraexTurnLifecycle,
  envelope: TraexTranscriptEnvelope,
  maxRenderedDeltaChars: number,
): TraexTurnLifecycle {
  if (envelope.type !== "event_msg") return current;
  const started = taskStartedEventSchema.safeParse(envelope.payload);
  if (started.success) {
    return {
      turnId: started.data.turn_id,
      state: "active",
      startedAt: eventTime(started.data.started_at),
    };
  }
  const completed = taskCompleteEventSchema.safeParse(envelope.payload);
  if (completed.success) {
    if (current?.state !== "active" || current.turnId !== completed.data.turn_id) return current;
    const finalAnswer = completed.data.last_agent_message
      ? boundTranscriptMarkdown(redactSecrets(completed.data.last_agent_message.trim()), maxRenderedDeltaChars)
      : "";
    return {
      turnId: completed.data.turn_id,
      state: "completed",
      startedAt: current.startedAt,
      ...(finalAnswer ? { finalAnswer } : {}),
    };
  }
  const aborted = turnAbortedEventSchema.safeParse(envelope.payload);
  if (!aborted.success || current?.state !== "active" || current.turnId !== aborted.data.turn_id) return current;
  return {
    turnId: aborted.data.turn_id,
    state: "aborted",
    startedAt: current.startedAt,
    ...(aborted.data.reason
      ? { reason: boundTranscriptMarkdown(redactSecrets(aborted.data.reason), maxRenderedDeltaChars) }
      : {}),
  };
}

export function eventTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1_000).toISOString();
}

export function isBaselineEventRecord(record: Buffer): boolean {
  return BASELINE_EVENT_MARKERS.some((marker) => record.includes(marker));
}
