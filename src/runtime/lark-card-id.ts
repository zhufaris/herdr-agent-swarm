import { createHash } from "node:crypto";

const MAX_ELEMENT_ID_LENGTH = 20;

/** Returns a CardKit element_id: ASCII identifier, letter-prefixed, and at most 20 characters. */
export function normalizeLarkElementId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_");
  const prefixed = /^[a-zA-Z]/.test(normalized) ? normalized : `element_${normalized}`;
  if (prefixed.length <= MAX_ELEMENT_ID_LENGTH) return prefixed;
  return `element_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}
