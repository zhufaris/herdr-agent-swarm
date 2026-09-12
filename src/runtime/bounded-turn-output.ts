export const MAX_TURN_OUTPUT_CHARS = 64 * 1024;
export const TURN_OUTPUT_TRUNCATION_MARKER = "\n\n… output truncated";

export interface BoundedTurnOutput { text: string; truncated: boolean }

export function createBoundedTurnOutput(text = ""): BoundedTurnOutput {
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

function truncate(value: string): BoundedTurnOutput {
  const prefixLength = Math.max(0, MAX_TURN_OUTPUT_CHARS - TURN_OUTPUT_TRUNCATION_MARKER.length);
  return { text: `${value.slice(0, prefixLength).trimEnd()}${TURN_OUTPUT_TRUNCATION_MARKER}`.slice(0, MAX_TURN_OUTPUT_CHARS), truncated: true };
}
