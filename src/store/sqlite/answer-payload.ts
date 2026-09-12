import { answerElementId } from "../../domain/run-card-view.js";
import { normalizeLarkCardElementIds } from "../../runtime/lark-card-id.js";

export function canonicalizeAnswerPayload(kind: string, payload: string, promptId: string, fallbackElementId: string): string {
  try {
    const decoded = JSON.parse(payload) as unknown;
    const pageIndex = isRecord(decoded) && isRecord(decoded.stream) && Number.isInteger(decoded.stream.pageIndex)
      ? Number(decoded.stream.pageIndex) : null;
    const elementId = pageIndex === null ? fallbackElementId : answerElementId(promptId, pageIndex);
    const normalized = replaceCardElementIds(normalizeLarkCardElementIds(decoded), elementId);
    if (!isRecord(normalized)) return payload;
    if ((kind === "stream_card_create" || kind === "stream_content") && isRecord(normalized.stream) && typeof normalized.stream.elementId === "string") {
      normalized.stream.elementId = elementId;
    }
    if (kind === "stream_content" && typeof normalized.elementId === "string") normalized.elementId = elementId;
    return JSON.stringify(normalized);
  } catch {
    return payload;
  }
}

function replaceCardElementIds(value: unknown, elementId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceCardElementIds(item, elementId));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, (key === "element_id" || key === "slot") && typeof item === "string" ? elementId : replaceCardElementIds(item, elementId)
  ]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
