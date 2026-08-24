import { createHash } from "node:crypto";

const MAX_ELEMENT_ID_LENGTH = 20;

/** Returns a CardKit element_id: ASCII identifier, letter-prefixed, and at most 20 characters. */
export function normalizeLarkElementId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_");
  const prefixed = /^[a-zA-Z]/.test(normalized) ? normalized : `element_${normalized}`;
  if (prefixed.length <= MAX_ELEMENT_ID_LENGTH) return prefixed;
  return `element_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
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
