/**
 * Core event timestamps are canonical to seconds, while older Swarm rows may
 * retain subsecond precision. Exact-turn ownership therefore compares the
 * represented UTC second, while still failing closed for malformed values.
 */
export function sameCanonicalTurnStart(left: string, right: string): boolean {
  const leftEpoch = Date.parse(left);
  const rightEpoch = Date.parse(right);
  return Number.isFinite(leftEpoch) && Number.isFinite(rightEpoch)
    && Math.floor(leftEpoch / 1_000) === Math.floor(rightEpoch / 1_000);
}
