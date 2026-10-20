import { createHash } from "node:crypto";
import type { CoreEventEnvelope } from "../../domain/core-event-inbox.js";
import { snakeCaseAgentEventPayloadSchema } from "../../domain/herdr-event-payload-schema.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const INVALID_JSON = Symbol("invalid-core-event-json");

export function coreEventSemanticHash(event: CoreEventEnvelope): string | null {
  const identity = semanticIdentity(event);
  return identity === null ? null : createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function sameCoreEventSemantics(left: CoreEventEnvelope, right: CoreEventEnvelope): boolean {
  const leftHash = coreEventSemanticHash(left);
  return leftHash !== null && leftHash === coreEventSemanticHash(right);
}

function semanticIdentity(event: CoreEventEnvelope): JsonValue | null {
  if (event.schemaVersion !== 1 || !event.eventId || (event.agentKind !== "traex" && event.agentKind !== "pi")
    || !event.sessionId || (event.turnId !== null && event.turnId !== undefined && typeof event.turnId !== "string")
    || typeof event.occurredAt !== "string" || !isRecord(event.payload)
    || !snakeCaseAgentEventPayloadSchema.safeParse(event.payload).success) return null;
  const payload = canonicalJson(event.payload);
  if (payload === INVALID_JSON) return null;
  const identity = canonicalJson({
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    agentKind: event.agentKind,
    sessionId: event.sessionId,
    turnId: event.turnId ?? null,
    occurredAt: event.payload.type === "record_skipped" ? null : event.occurredAt,
    payload
  });
  return identity === INVALID_JSON ? null : identity;
}

function canonicalJson(value: unknown): JsonValue | typeof INVALID_JSON {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_JSON;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const normalized = canonicalJson(item);
      if (normalized === INVALID_JSON) return INVALID_JSON;
      items.push(normalized);
    }
    return items;
  }
  if (!isRecord(value)) return INVALID_JSON;
  const normalized: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value).sort()) {
    const child = canonicalJson(value[key]);
    if (child === INVALID_JSON) return INVALID_JSON;
    normalized[key] = child;
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
