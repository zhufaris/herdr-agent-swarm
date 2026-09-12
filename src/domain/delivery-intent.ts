import type { OutboundReplyKind } from "./types.js";

export const DELIVERY_INTENT_SCHEMA_VERSION = 1;
export const CARD_RENDERER_REVISION = 1;
export type DeliveryIntentKind = "text" | "card" | "group-card" | "stream-card" | "stream-content" | "stream-finish";
export interface MaterializedDeliveryIntent { schemaVersion: 1; kind: DeliveryIntentKind; materializedPayload: string }

export function deliveryIntentKind(kind: OutboundReplyKind): DeliveryIntentKind {
  if (kind === "text") return "text";
  if (kind === "group_card_create") return "group-card";
  if (kind === "stream_card_create") return "stream-card";
  if (kind === "stream_content") return "stream-content";
  if (kind === "stream_finish") return "stream-finish";
  return "card";
}
export function materializedDeliveryIntent(kind: OutboundReplyKind, payload: string): MaterializedDeliveryIntent { return { schemaVersion: DELIVERY_INTENT_SCHEMA_VERSION, kind: deliveryIntentKind(kind), materializedPayload: payload }; }
export function encodeDeliveryIntent(kind: OutboundReplyKind, payload: string): { intentKind: DeliveryIntentKind; intentJson: string; rendererRevision: number } {
  const intent = materializedDeliveryIntent(kind, payload);
  return { intentKind: intent.kind, intentJson: JSON.stringify(intent), rendererRevision: CARD_RENDERER_REVISION };
}
export function decodeDeliveryIntent(value: string | null): MaterializedDeliveryIntent | null {
  if (!value) return null;
  try { const parsed = JSON.parse(value) as Partial<MaterializedDeliveryIntent>; return parsed.schemaVersion === 1 && isDeliveryIntentKind(parsed.kind) && typeof parsed.materializedPayload === "string" ? parsed as MaterializedDeliveryIntent : null; }
  catch { return null; }
}

function isDeliveryIntentKind(value: unknown): value is DeliveryIntentKind {
  return value === "text" || value === "card" || value === "group-card" || value === "stream-card" || value === "stream-content" || value === "stream-finish";
}
