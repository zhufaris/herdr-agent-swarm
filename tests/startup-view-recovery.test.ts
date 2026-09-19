import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupViewRecovery } from "../src/coordinator/startup-view-recovery.js";

afterEach(() => vi.useRealTimers());

describe("StartupViewRecovery", () => {
  it("retries failed binding IDs with backoff and clears degraded state after recovery", async () => {
    vi.useFakeTimers();
    const convergeBindings = vi.fn().mockResolvedValueOnce(["b1"]).mockResolvedValueOnce([]);
    const recovery = new StartupViewRecovery({ convergeAll: async () => [], convergeBindings, baseDelayMs: 100, maxDelayMs: 1_000 });

    recovery.add(["b1"]);
    recovery.start();
    expect(recovery.snapshot()).toMatchObject({ state: "retry_wait", pendingCount: 1, retryCount: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(convergeBindings).toHaveBeenCalledWith(["b1"]);
    expect(recovery.snapshot()).toMatchObject({ state: "retry_wait", pendingCount: 1, retryCount: 1 });
    await vi.advanceTimersByTimeAsync(200);
    expect(recovery.snapshot()).toMatchObject({ state: "idle", pendingCount: 0, recoveredCount: 1, retryCount: 2 });
    await recovery.stop();
  });

  it("keeps IDs bounded and falls back to a durable full rediscovery after overflow", async () => {
    vi.useFakeTimers();
    const convergeAll = vi.fn(async () => []);
    const recovery = new StartupViewRecovery({ convergeAll, convergeBindings: async () => [], maxPendingIds: 2, baseDelayMs: 10, maxDelayMs: 10 });

    recovery.add(["b1", "b2", "b3"]);
    expect(recovery.snapshot()).toMatchObject({ pendingCount: 2, fullRescanPending: true });
    recovery.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(convergeAll).toHaveBeenCalledOnce();
    expect(recovery.snapshot()).toMatchObject({ state: "idle", pendingCount: 0, fullRescanPending: false });
    await recovery.stop();
  });

  it("supports an explicit durable full rediscovery after discovery itself fails", async () => {
    vi.useFakeTimers();
    const convergeAll = vi.fn(async () => []);
    const recovery = new StartupViewRecovery({ convergeAll, convergeBindings: async () => [], baseDelayMs: 10, maxDelayMs: 10 });
    recovery.requestFullRescan();
    recovery.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(convergeAll).toHaveBeenCalledOnce();
    expect(recovery.snapshot()).toMatchObject({ state: "idle", fullRescanPending: false });
    await recovery.stop();
  });

  it("stops without launching queued retry work", async () => {
    vi.useFakeTimers();
    const convergeBindings = vi.fn(async () => []);
    const recovery = new StartupViewRecovery({ convergeAll: async () => [], convergeBindings, baseDelayMs: 10, maxDelayMs: 10 });
    recovery.add(["b1"]);
    recovery.start();
    await recovery.stop();
    await vi.advanceTimersByTimeAsync(20);
    expect(convergeBindings).not.toHaveBeenCalled();
    expect(recovery.snapshot().state).toBe("stopping");
  });
});
