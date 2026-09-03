import { stableElementId } from "../domain/stable-element-id.js";

/** Returns a CardKit element_id: ASCII identifier, letter-prefixed, and at most 20 characters. */
export function normalizeLarkElementId(value: string): string {
  return stableElementId(value);
}

/** Normalizes every CardKit element_id in an arbitrary card payload. */
export function normalizeLarkCardElementIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLarkCardElementIds);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "element_id" && typeof item === "string" ? normalizeLarkElementId(item) : normalizeLarkCardElementIds(item)
  ]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
