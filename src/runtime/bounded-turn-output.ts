export const MAX_TURN_OUTPUT_CHARS = 512 * 1024;
export const TURN_OUTPUT_TRUNCATION_MARKER = "\n\n… output truncated";
const LEGACY_MAX_TURN_OUTPUT_CHARS = 64 * 1024;

export interface BoundedTurnOutput { text: string; truncated: boolean }

export function createBoundedTurnOutput(text = ""): BoundedTurnOutput {
  if (isPersistedTruncatedTurnOutput(text)) return { text, truncated: true };
  if (text.length <= MAX_TURN_OUTPUT_CHARS) return { text, truncated: false };
  return truncate(text);
}

export function appendTurnOutput(current: BoundedTurnOutput, fragment: string): BoundedTurnOutput {
  if (!fragment || current.truncated) return current;
  const separator = current.text ? "\n\n" : "";
  if (current.text.length + separator.length + fragment.length <= MAX_TURN_OUTPUT_CHARS) {
    return { text: `${current.text}${separator}${fragment}`, truncated: false };
  }
  return truncate(`${current.text}${separator}${fragment}`);
}

export function legacyTruncatedTurnOutputPrefix(text: string): string | null {
  return text.length === LEGACY_MAX_TURN_OUTPUT_CHARS && text.endsWith(TURN_OUTPUT_TRUNCATION_MARKER)
    ? text.slice(0, -TURN_OUTPUT_TRUNCATION_MARKER.length)
    : null;
}

function isPersistedTruncatedTurnOutput(text: string): boolean {
  return text.endsWith(TURN_OUTPUT_TRUNCATION_MARKER)
    && (text.length === LEGACY_MAX_TURN_OUTPUT_CHARS || text.length === MAX_TURN_OUTPUT_CHARS);
}

function truncate(value: string): BoundedTurnOutput {
  const prefixLength = Math.max(0, MAX_TURN_OUTPUT_CHARS - TURN_OUTPUT_TRUNCATION_MARKER.length);
  return { text: `${value.slice(0, prefixLength).trimEnd()}${TURN_OUTPUT_TRUNCATION_MARKER}`.slice(0, MAX_TURN_OUTPUT_CHARS), truncated: true };
}
