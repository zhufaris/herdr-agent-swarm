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

  it("reports a failed flush and retries the latest desired version", async () => {
    vi.useFakeTimers();
    const delivered: number[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const scheduler = new CardUpdateScheduler(async (_promptId, version) => {
      delivered.push(version);
      if (fail) { fail = false; throw new Error("Lark unavailable"); }
    }, 100, (error) => errors.push(error));

    scheduler.schedule("p1", 1, true);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    scheduler.schedule("p1", 2, false);
    await vi.advanceTimersByTimeAsync(99);
    expect(delivered).toEqual([1]);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(delivered).toEqual([1, 2]));
    scheduler.stop();
  });

  it("cancels a pending retry when stopped", async () => {
    vi.useFakeTimers();
    const delivered = vi.fn(async () => { throw new Error("Lark unavailable"); });
    const scheduler = new CardUpdateScheduler(delivered, 100, () => undefined);

    scheduler.schedule("p1", 1, true);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledOnce());
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(delivered).toHaveBeenCalledOnce();
  });
});
