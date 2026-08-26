import { afterEach, describe, expect, it, vi } from "vitest";
import { CardUpdateScheduler } from "../src/events/card-update-scheduler.js";

afterEach(() => vi.useRealTimers());

describe("card update scheduler", () => {
  it("coalesces ordinary updates briefly and flushes terminal updates immediately", async () => {
    vi.useFakeTimers();
    const delivered: number[] = [];
    const scheduler = new CardUpdateScheduler(async (_promptId, version) => { delivered.push(version); }, 1_500);
    scheduler.schedule("p1", 2, false);
    scheduler.schedule("p1", 3, false);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([3]);
    scheduler.schedule("p1", 4, true);
    await Promise.resolve();
    expect(delivered).toEqual([3, 4]);
    scheduler.stop();
  });

  it("sends a newer version after an in-flight update", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered: number[] = [];
    const scheduler = new CardUpdateScheduler(async (_promptId, version) => { delivered.push(version); if (version === 1) await gate; }, 0);
    scheduler.schedule("p1", 1, true);
    await Promise.resolve();
    scheduler.schedule("p1", 2, true);
    expect(delivered).toEqual([1]);
    release();
    await vi.waitFor(() => expect(delivered).toEqual([1, 2]));
    scheduler.stop();
  });
});
