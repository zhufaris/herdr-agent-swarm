const maximumAttempts = 3;
const maximumExponentialDelayMs = 60_000;
const maximumExplicitDelayMs = 3_600_000;

export function planDeliveryRetry(input: {
  previousAttemptCount: number;
  explicitDelayMs?: number;
  nowMs: number;
  random?: () => number;
}): { attemptCount: number; exhausted: boolean; nextAttemptAt: string } {
  const attemptCount = input.previousAttemptCount + 1;
  const exponentialDelayMs = Math.min(maximumExponentialDelayMs, 1_000 * 2 ** (attemptCount - 1));
  const delayMs = input.explicitDelayMs === undefined
    ? Math.round(exponentialDelayMs * (0.8 + (input.random ?? Math.random)() * 0.4))
    : Math.max(exponentialDelayMs, Math.min(maximumExplicitDelayMs, input.explicitDelayMs));
  return {
    attemptCount,
    exhausted: attemptCount >= maximumAttempts,
    nextAttemptAt: new Date(input.nowMs + delayMs).toISOString()
  };
}
