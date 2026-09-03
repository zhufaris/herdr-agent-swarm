import { createHash } from "node:crypto";

const MAX_ELEMENT_ID_LENGTH = 20;

/** Creates a deterministic transport-neutral identifier for a projected element. */
export function stableElementId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_");
  const prefixed = /^[a-zA-Z]/.test(normalized) ? normalized : `element_${normalized}`;
  return prefixed.length <= MAX_ELEMENT_ID_LENGTH
    ? prefixed
    : `element_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}
