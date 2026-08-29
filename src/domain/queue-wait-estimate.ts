export interface QueueWaitFeedback {
  aheadCount: number;
  activeElapsedSeconds: number | null;
  estimateLowerSeconds: number | null;
  estimateUpperSeconds: number | null;
  sampleCount: number;
  elapsedBucket: number | null;
}

export function estimateQueueWait(input: { queuePosition: number; activeStartedAt: string | null; now: string; completedDurationsMs: readonly number[] }): QueueWaitFeedback {
  const aheadCount = Math.max(0, Math.floor(input.queuePosition) - 1);
  const nowMs = Date.parse(input.now);
  const startedAtMs = input.activeStartedAt === null ? Number.NaN : Date.parse(input.activeStartedAt);
  const activeElapsedSeconds = Number.isFinite(nowMs) && Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000)) : null;
  const elapsedBucket = activeElapsedSeconds === null ? null : Math.floor(activeElapsedSeconds / 30);
  const samples = input.completedDurationsMs.filter((duration) => Number.isFinite(duration) && duration > 0).slice(0, 10);
  if (samples.length < 3) return { aheadCount, activeElapsedSeconds, estimateLowerSeconds: null, estimateUpperSeconds: null, sampleCount: samples.length, elapsedBucket };
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const activeRemainingMs = activeElapsedSeconds === null ? 0 : Math.max(0, medianMs - activeElapsedSeconds * 1_000);
  const estimateMs = activeRemainingMs + medianMs * aheadCount;
  const unitMs = 30_000;
  const lowerMs = Math.floor(estimateMs * 0.5 / unitMs) * unitMs;
  let upperMs = Math.ceil(estimateMs * 1.5 / unitMs) * unitMs;
  if (upperMs <= lowerMs) upperMs = lowerMs + unitMs;
  return { aheadCount, activeElapsedSeconds, estimateLowerSeconds: lowerMs / 1_000, estimateUpperSeconds: upperMs / 1_000, sampleCount: samples.length, elapsedBucket };
}
