import { describe, expect, it } from "vitest";
import { estimateQueueWait } from "../src/domain/queue-wait-estimate.js";

const now = "2026-08-29T12:00:20.000Z";

describe("queue wait estimate", () => {
  it("reports durable queue facts without an estimate when fewer than three samples exist", () => {
    expect(estimateQueueWait({ queuePosition: 3, activeStartedAt: "2026-08-29T12:00:00.000Z", now, completedDurationsMs: [] })).toEqual({ aheadCount: 2, activeElapsedSeconds: 20, estimateLowerSeconds: null, estimateUpperSeconds: null, sampleCount: 0, elapsedBucket: 0 });
    expect(estimateQueueWait({ queuePosition: 1, activeStartedAt: null, now, completedDurationsMs: [60_000, 90_000] })).toEqual({ aheadCount: 0, activeElapsedSeconds: null, estimateLowerSeconds: null, estimateUpperSeconds: null, sampleCount: 2, elapsedBucket: null });
  });

  it("uses odd and even medians and adds active remaining time to waiting FIFO work", () => {
    expect(estimateQueueWait({ queuePosition: 3, activeStartedAt: "2026-08-29T12:00:00.000Z", now, completedDurationsMs: [30_000, 60_000, 90_000] })).toMatchObject({ aheadCount: 2, activeElapsedSeconds: 20, estimateLowerSeconds: 60, estimateUpperSeconds: 240, sampleCount: 3 });
    expect(estimateQueueWait({ queuePosition: 2, activeStartedAt: null, now, completedDurationsMs: [30_000, 60_000, 90_000, 120_000] })).toMatchObject({ aheadCount: 1, activeElapsedSeconds: null, estimateLowerSeconds: 30, estimateUpperSeconds: 120, sampleCount: 4 });
  });

  it("clamps exhausted active work to zero and keeps a non-empty outward-rounded range", () => {
    expect(estimateQueueWait({ queuePosition: 1, activeStartedAt: "2026-08-29T11:58:00.000Z", now, completedDurationsMs: [60_000, 60_000, 60_000] })).toMatchObject({ aheadCount: 0, activeElapsedSeconds: 140, estimateLowerSeconds: 0, estimateUpperSeconds: 30, elapsedBucket: 4 });
  });

  it("filters invalid durations and keeps only the latest ten supplied samples", () => {
    const samples = [Number.NaN, -1, 0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000, 70_000, 80_000, 90_000, 100_000, 1_000_000];
    expect(estimateQueueWait({ queuePosition: 2, activeStartedAt: null, now, completedDurationsMs: samples })).toMatchObject({ sampleCount: 10, estimateLowerSeconds: 0, estimateUpperSeconds: 90 });
  });

  it("rounds the lower bound down and upper bound up to 30-second units", () => {
    expect(estimateQueueWait({ queuePosition: 2, activeStartedAt: null, now, completedDurationsMs: [61_000, 61_000, 61_000] })).toMatchObject({ estimateLowerSeconds: 30, estimateUpperSeconds: 120 });
  });
});
