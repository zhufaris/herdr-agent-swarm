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

  it("promotes a delayed update to an earlier per-request budget and reports bounded diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00Z"));
    const delivered: Array<[string, number]> = [];
    const flushes: object[] = [];
    const scheduler = new CardUpdateScheduler(async (key, version) => { delivered.push([key, version]); }, 2_500, undefined, (result) => flushes.push(result));

    scheduler.schedule("main:b1", 1, { priority: "normal", delayMs: 2_500 });
    await vi.advanceTimersByTimeAsync(500);
    scheduler.schedule("main:b1", 2, { priority: "interactive", delayMs: 1_000 });

    expect(scheduler.diagnostics()).toMatchObject({ pending: 1, pendingByFamily: { answer: 0, main: 1, unknown: 0 }, inFlight: 0, coalesced: 1, failures: 0, oldestPendingAgeMs: 500 });
    await vi.advanceTimersByTimeAsync(999);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([["main:b1", 2]]);
    expect(scheduler.diagnostics()).toMatchObject({ pending: 0, coalesced: 1, failures: 0 });
    expect(scheduler.diagnostics().lastSuccessfulFlushAt).not.toBeNull();
    expect(flushes).toEqual([{ cardKey: "main:b1", desiredVersion: 2, priority: "interactive", latencyMs: 0, outcome: "succeeded" }]);
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

  it("runs a same-version checkpoint requested during an in-flight delivery", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered: number[] = [];
    const scheduler = new CardUpdateScheduler(async (_cardKey, version) => {
      delivered.push(version);
      if (delivered.length === 1) await gate;
    }, 100);

    scheduler.schedule("answer:p1", 3, true);
    await Promise.resolve();
    scheduler.schedule("answer:p1", 3, true);
    release();

    await vi.waitFor(() => expect(delivered).toEqual([3, 3]));
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
