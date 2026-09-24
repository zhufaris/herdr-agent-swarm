import type { RunProgressEvent } from "./run-card-view.js";

/** Selects the single activity summary shown outside the canonical Answer timeline. */
export function currentMainCardActivity(events: readonly RunProgressEvent[], excludedKeys: ReadonlySet<string> = new Set()): RunProgressEvent[] {
  const candidates = events.filter((event) => !excludedKeys.has(event.key));
  const current = candidates.findLast(({ state }) => state === "active") ?? candidates.at(-1);
  return current ? [current] : [];
}
