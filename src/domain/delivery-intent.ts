import { createHash } from "node:crypto";
import type { OutboundReplyKind } from "./types.js";
import type { DeliverySubject, PresentationJsonValue, PresentationSnapshot, SemanticSnapshotDeliveryInput } from "./delivery.js";

export const DELIVERY_INTENT_SCHEMA_VERSION = 2;
export const CARD_RENDERER_REVISION = 1;
export type DeliveryIntentKind = "text" | "card" | "group-card" | "stream-card" | "stream-content" | "stream-finish" | "message-delete";
export interface MaterializedDeliveryIntentV1 { schemaVersion: 1; kind: DeliveryIntentKind; materializedPayload: string }
export interface DeliveryIntentV2 { schemaVersion: 2; kind: DeliveryIntentKind }
export type DeliveryIntent = MaterializedDeliveryIntentV1 | DeliveryIntentV2;

export function primaryAnswerCreateIdempotencyKey(promptId: string): string {
  return `run-card:create:${promptId}:answer`;
}

export function deliveryIntentKind(kind: OutboundReplyKind): DeliveryIntentKind {
  if (kind === "message_delete") return "message-delete";
  if (kind === "text") return "text";
  if (kind === "group_card_create") return "group-card";
  if (kind === "stream_card_create") return "stream-card";
  if (kind === "stream_content") return "stream-content";
  if (kind === "stream_finish") return "stream-finish";
  return "card";
}
export function materializedDeliveryIntent(kind: OutboundReplyKind, payload: string): MaterializedDeliveryIntentV1 { return { schemaVersion: 1, kind: deliveryIntentKind(kind), materializedPayload: payload }; }
export function encodeDeliveryIntent(kind: OutboundReplyKind, payload: string, override?: DeliveryIntentKind): { intentKind: DeliveryIntentKind; intentJson: string; rendererRevision: number } {
  const intent: DeliveryIntentV2 = { schemaVersion: DELIVERY_INTENT_SCHEMA_VERSION, kind: override ?? deliveryIntentKind(kind) };
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

export function encodeDeliverySubject(subject: DeliverySubject): string {
  if (!validConversationPageSubject(subject)) throw new Error("invalid_delivery_subject");
  return JSON.stringify(subject);
}

export function decodeDeliverySubject(kind: string, value: string): DeliverySubject | null {
  if (kind !== "conversation-page") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return validConversationPageSubject(parsed) ? Object.freeze({ ...parsed }) : null;
  } catch { return null; }
}

export function encodePresentationSnapshot(snapshot: PresentationSnapshot): string {
  if (!validPresentationSnapshot(snapshot)) throw new Error("invalid_presentation_snapshot");
  return JSON.stringify(snapshot);
}

export function decodePresentationSnapshot(value: string): PresentationSnapshot | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return validPresentationSnapshot(parsed) ? deepFreezeJson(parsed) as PresentationSnapshot : null;
  } catch { return null; }
}

export function presentationSnapshotHash(encodedSnapshot: string): string {
  return createHash("sha256").update(encodedSnapshot).digest("hex");
}

export function decodeSemanticSnapshotDeliveryInput(input: {
  subjectKind: string;
  subjectJson: string;
  subjectRevision: number;
  presentationSnapshotJson: string;
  presentationSnapshotHash: string;
  plannerPolicyVersion: number;
  rendererPolicyVersion: number;
  gatewayProfileVersion: number;
}): SemanticSnapshotDeliveryInput | null {
  const subject = decodeDeliverySubject(input.subjectKind, input.subjectJson);
  const snapshot = decodePresentationSnapshot(input.presentationSnapshotJson);
  if (!subject || !snapshot || subject.revision !== input.subjectRevision) return null;
  if (!isPositiveInteger(input.plannerPolicyVersion) || !isPositiveInteger(input.rendererPolicyVersion)
    || !isPositiveInteger(input.gatewayProfileVersion)) return null;
  if (!/^[a-f0-9]{64}$/.test(input.presentationSnapshotHash)
    || presentationSnapshotHash(input.presentationSnapshotJson) !== input.presentationSnapshotHash) return null;
  return Object.freeze({
    kind: "semantic-snapshot",
    subject,
    snapshot,
    snapshotHash: input.presentationSnapshotHash,
    plannerPolicyVersion: input.plannerPolicyVersion,
    rendererPolicyVersion: input.rendererPolicyVersion,
    gatewayProfileVersion: input.gatewayProfileVersion
  });
}

function isDeliveryIntentKind(value: unknown): value is DeliveryIntentKind {
  return value === "text" || value === "card" || value === "group-card" || value === "stream-card" || value === "stream-content" || value === "stream-finish" || value === "message-delete";
}

function validConversationPageSubject(value: unknown): value is DeliverySubject {
  if (!isRecord(value) || Object.keys(value).some((key) => !["kind", "segmentId", "pageIndex", "revision"].includes(key))) return false;
  return value.kind === "conversation-page" && typeof value.segmentId === "string" && value.segmentId.length > 0
    && Number.isSafeInteger(value.pageIndex) && Number(value.pageIndex) >= 0
    && isPositiveInteger(value.revision);
}

function validPresentationSnapshot(value: unknown): value is PresentationSnapshot {
  return isRecord(value) && isPositiveInteger(value.schemaVersion) && validPresentationJsonValue(value);
}

function validPresentationJsonValue(value: unknown): value is PresentationJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validPresentationJsonValue);
  return isRecord(value) && Object.values(value).every(validPresentationJsonValue);
}

function deepFreezeJson(value: PresentationJsonValue): PresentationJsonValue {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) deepFreezeJson(item as PresentationJsonValue);
    return Object.freeze(value) as PresentationJsonValue;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}
