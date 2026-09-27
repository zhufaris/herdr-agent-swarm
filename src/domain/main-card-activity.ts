import type { RunProgressEvent } from "./run-card-view.js";

/** Selects the single activity summary shown outside the canonical Answer timeline. */
export function currentMainCardActivity(events: readonly RunProgressEvent[], excludedKeys: ReadonlySet<string> = new Set(), visibleLabels: readonly string[] = []): RunProgressEvent[] {
  const normalizedLabels = visibleLabels.map(normalizeComparableLabel).filter(Boolean);
  const candidates = events.filter((event) => !excludedKeys.has(event.key) && !duplicatesVisibleLabel(event.label, normalizedLabels));
  const current = candidates.findLast(({ state }) => state === "active") ?? candidates.at(-1);
  return current ? [current] : [];
}

function duplicatesVisibleLabel(label: string, visibleLabels: readonly string[]): boolean {
  const candidate = normalizeComparableLabel(label);
  return Boolean(candidate) && visibleLabels.some((visible) => candidate === visible || candidate.includes(visible) || visible.includes(candidate));
}

function normalizeComparableLabel(label: string): string {
  return label.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
