import type { CoreEventEnvelope } from "../../domain/core-event-inbox.js";
import type { DatabaseSync } from "node:sqlite";

export interface CoreEventDiscriminators {
  eventType: string | null;
  submissionId: string | null;
  channel: string | null;
  callId: string | null;
}

export function coreEventDiscriminators(event: Pick<CoreEventEnvelope, "payload">): CoreEventDiscriminators {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return emptyDiscriminators();
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.type !== "string") return emptyDiscriminators();
  return {
    eventType: payload.type,
    submissionId: payload.type === "human_message" || payload.type === "submission_receipt" ? stringField(payload, "submission_id") : null,
    channel: payload.type === "message" ? stringField(payload, "channel") : null,
    callId: payload.type === "tool_call" || payload.type === "tool_result" ? stringField(payload, "call_id") : null
  };
}

export type CoreEventDiscriminatorColumn = "event_type" | "submission_id" | "channel" | "call_id";

export function coreEventDiscriminatorSql(database: DatabaseSync, alias: string, column: CoreEventDiscriminatorColumn): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid Core event SQL alias");
  const complete = database.prepare("SELECT state FROM core_event_discriminator_backfill WHERE singleton_id=1").get() as { state: string } | undefined;
  if (complete?.state === "complete") return `${alias}.${column}`;
  return `json_extract(${alias}.event_json, '$.payload.${column === "event_type" ? "type" : column}')`;
}

export function parseCoreEventDiscriminators(eventJson: string): CoreEventDiscriminators {
  let event: unknown;
  try {
    event = JSON.parse(eventJson);
  } catch {
    return emptyDiscriminators();
  }
  if (!event || typeof event !== "object" || Array.isArray(event) || !("payload" in event)) {
    return emptyDiscriminators();
  }
  return coreEventDiscriminators(event as Pick<CoreEventEnvelope, "payload">);
}

function stringField(payload: Record<string, unknown>, name: string): string | null {
  const value = payload[name];
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : null;
}

function emptyDiscriminators(): CoreEventDiscriminators {
  return { eventType: null, submissionId: null, channel: null, callId: null };
}
