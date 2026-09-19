import type { OutboundReplyKind } from "./types.js";

export const DELIVERY_INTENT_SCHEMA_VERSION = 2;
export const CARD_RENDERER_REVISION = 1;
export type DeliveryIntentKind = "text" | "card" | "group-card" | "stream-card" | "stream-content" | "stream-finish";
export interface MaterializedDeliveryIntentV1 { schemaVersion: 1; kind: DeliveryIntentKind; materializedPayload: string }
export interface DeliveryIntentV2 { schemaVersion: 2; kind: DeliveryIntentKind }
export type DeliveryIntent = MaterializedDeliveryIntentV1 | DeliveryIntentV2;

export function deliveryIntentKind(kind: OutboundReplyKind): DeliveryIntentKind {
  if (kind === "text") return "text";
  if (kind === "group_card_create") return "group-card";
  if (kind === "stream_card_create") return "stream-card";
  if (kind === "stream_content") return "stream-content";
  if (kind === "stream_finish") return "stream-finish";
  return "card";
}
export function materializedDeliveryIntent(kind: OutboundReplyKind, payload: string): MaterializedDeliveryIntentV1 { return { schemaVersion: 1, kind: deliveryIntentKind(kind), materializedPayload: payload }; }
export function encodeDeliveryIntent(kind: OutboundReplyKind, payload: string): { intentKind: DeliveryIntentKind; intentJson: string; rendererRevision: number } {
  const intent: DeliveryIntentV2 = { schemaVersion: DELIVERY_INTENT_SCHEMA_VERSION, kind: deliveryIntentKind(kind) };
  return { intentKind: intent.kind, intentJson: JSON.stringify(intent), rendererRevision: CARD_RENDERER_REVISION };
}
export function decodeDeliveryIntent(value: string | null): DeliveryIntent | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { schemaVersion?: unknown; kind?: unknown; materializedPayload?: unknown };
    if (!isDeliveryIntentKind(parsed.kind)) return null;
    if (parsed.schemaVersion === 2) return { schemaVersion: 2, kind: parsed.kind };
    return parsed.schemaVersion === 1 && typeof parsed.materializedPayload === "string" ? parsed as MaterializedDeliveryIntentV1 : null;
  }
  catch { return null; }
}

function isDeliveryIntentKind(value: unknown): value is DeliveryIntentKind {
  return value === "text" || value === "card" || value === "group-card" || value === "stream-card" || value === "stream-content" || value === "stream-finish";
}
