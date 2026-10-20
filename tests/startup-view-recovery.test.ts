import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupViewRecovery } from "../src/coordinator/startup-view-recovery.js";

afterEach(() => vi.useRealTimers());

describe("StartupViewRecovery", () => {
  it("retries failed binding IDs with backoff and clears degraded state after recovery", async () => {
    vi.useFakeTimers();
    const convergeBindings = vi.fn().mockResolvedValueOnce(["b1"]).mockResolvedValueOnce([]);
    const recovery = new StartupViewRecovery({ convergeAll: async () => ({ failedBindingIds: [], fullRescanRequired: false }), convergeBindings, baseDelayMs: 100, maxDelayMs: 1_000 });

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
    const convergeAll = vi.fn(async () => ({ failedBindingIds: [], fullRescanRequired: false }));
    const recovery = new StartupViewRecovery({ convergeAll, convergeBindings: async () => [], maxPendingIds: 2, baseDelayMs: 10, maxDelayMs: 10 });

    recovery.add(["b1", "b2", "b3"]);
    expect(recovery.snapshot()).toMatchObject({ pendingCount: 2, fullRescanPending: true, continuationPending: false });
    recovery.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(convergeAll).toHaveBeenCalledOnce();
    expect(recovery.snapshot()).toMatchObject({ state: "idle", pendingCount: 0, fullRescanPending: false, continuationPending: false });
    await recovery.stop();
  });

  it("supports an explicit durable full rediscovery after discovery itself fails", async () => {
    vi.useFakeTimers();
    const convergeAll = vi.fn(async () => ({ failedBindingIds: [], fullRescanRequired: false }));
    const recovery = new StartupViewRecovery({ convergeAll, convergeBindings: async () => [], baseDelayMs: 10, maxDelayMs: 10 });
    recovery.requestFullRescan();
    recovery.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(convergeAll).toHaveBeenCalledOnce();
    expect(recovery.snapshot()).toMatchObject({ state: "idle", fullRescanPending: false, continuationPending: false });
    await recovery.stop();
  });

  it("runs an explicit full rescan before retained continuation without losing either lane", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const convergeAll = vi.fn(async () => { calls.push("full"); return { failedBindingIds: [], fullRescanRequired: false }; });
    const continueRetainedActivity = vi.fn(async () => { calls.push("continuation"); return { failedBindingIds: [], fullRescanRequired: false }; });
    const recovery = new StartupViewRecovery({
      convergeAll, continueRetainedActivity, convergeBindings: async () => [], baseDelayMs: 10, maxDelayMs: 10
    });

    recovery.requestRetainedContinuation();
    recovery.requestFullRescan();
    recovery.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(["full"]);
    expect(recovery.snapshot()).toMatchObject({ state: "retry_wait", fullRescanPending: false, continuationPending: true, retryCount: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(["full", "continuation"]);
    expect(recovery.snapshot()).toMatchObject({ state: "idle", fullRescanPending: false, continuationPending: false, retryCount: 2 });
    await recovery.stop();
  });

  it("requeues only retained continuation after its own failure", async () => {
    vi.useFakeTimers();
    const continueRetainedActivity = vi.fn()
      .mockRejectedValueOnce(new Error("retained page unavailable"))
      .mockResolvedValueOnce({ failedBindingIds: [], fullRescanRequired: false });
    const convergeAll = vi.fn(async () => ({ failedBindingIds: [], fullRescanRequired: false }));
    const recovery = new StartupViewRecovery({
      convergeAll, continueRetainedActivity, convergeBindings: async () => [], baseDelayMs: 10, maxDelayMs: 100
    });

    recovery.requestRetainedContinuation();
    recovery.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(recovery.snapshot()).toMatchObject({
      state: "retry_wait", fullRescanPending: false, continuationPending: true, retryCount: 1,
      lastFailure: "retained page unavailable", lastFailureAt: expect.any(String)
    });
    expect(convergeAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(continueRetainedActivity).toHaveBeenCalledTimes(2);
    expect(convergeAll).not.toHaveBeenCalled();
    expect(recovery.snapshot()).toMatchObject({ state: "idle", fullRescanPending: false, continuationPending: false, retryCount: 2, lastFailure: null });
    await recovery.stop();
  });

  it("stops without launching queued retry work", async () => {
    vi.useFakeTimers();
    const convergeBindings = vi.fn(async () => []);
    const recovery = new StartupViewRecovery({ convergeAll: async () => ({ failedBindingIds: [], fullRescanRequired: false }), convergeBindings, baseDelayMs: 10, maxDelayMs: 10 });
    recovery.add(["b1"]);
    recovery.start();
    await recovery.stop();
    await vi.advanceTimersByTimeAsync(20);
    expect(convergeBindings).not.toHaveBeenCalled();
    expect(recovery.snapshot().state).toBe("stopping");
  });

  it("continues a bounded full rescan without reporting expected progress as failure", async () => {
    vi.useFakeTimers();
    const convergeAll = vi.fn().mockResolvedValueOnce({ failedBindingIds: [], fullRescanRequired: true });
    const continueRetainedActivity = vi.fn().mockResolvedValueOnce({ failedBindingIds: [], fullRescanRequired: false });
    const recovery = new StartupViewRecovery({ convergeAll, continueRetainedActivity, convergeBindings: async () => [], baseDelayMs: 10, maxDelayMs: 100 });

    recovery.requestFullRescan();
    recovery.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(recovery.snapshot()).toMatchObject({
      state: "retry_wait", fullRescanPending: false, continuationPending: true, retryCount: 1, lastFailure: null, lastFailureAt: null
    });
    await vi.advanceTimersByTimeAsync(9);
    expect(convergeAll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(continueRetainedActivity).toHaveBeenCalledOnce();
    expect(recovery.snapshot()).toMatchObject({
      state: "idle", fullRescanPending: false, continuationPending: false, retryCount: 2, lastFailure: null, lastFailureAt: null
    });
    await recovery.stop();
  });

  it("retains failure diagnostics when a full rescan throws", async () => {
    vi.useFakeTimers();
    const convergeAll = vi.fn()
      .mockRejectedValueOnce(new Error("startup view unavailable"))
      .mockResolvedValueOnce({ failedBindingIds: [], fullRescanRequired: false });
    const recovery = new StartupViewRecovery({ convergeAll, convergeBindings: async () => [], baseDelayMs: 10, maxDelayMs: 100 });

    recovery.requestFullRescan();
    recovery.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(recovery.snapshot()).toMatchObject({
      state: "retry_wait", fullRescanPending: true, continuationPending: false, retryCount: 1, lastFailure: "startup view unavailable", lastFailureAt: expect.any(String)
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(recovery.snapshot()).toMatchObject({ state: "idle", fullRescanPending: false, continuationPending: false, retryCount: 2, lastFailure: null });
    await recovery.stop();
  });

  it("preserves a real failure across successful bounded continuation until convergence completes", async () => {
    vi.useFakeTimers();
    const convergeAll = vi.fn()
      .mockRejectedValueOnce(new Error("startup view unavailable"))
      .mockResolvedValueOnce({ failedBindingIds: [], fullRescanRequired: true });
    const continueRetainedActivity = vi.fn().mockResolvedValueOnce({ failedBindingIds: [], fullRescanRequired: false });
    const recovery = new StartupViewRecovery({ convergeAll, continueRetainedActivity, convergeBindings: async () => [], baseDelayMs: 10, maxDelayMs: 100 });

    recovery.requestFullRescan();
    recovery.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    expect(recovery.snapshot()).toMatchObject({
      state: "retry_wait", fullRescanPending: false, continuationPending: true, retryCount: 2,
      lastFailure: "startup view unavailable", lastFailureAt: expect.any(String)
    });
    await vi.advanceTimersByTimeAsync(19);
    expect(convergeAll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(continueRetainedActivity).toHaveBeenCalledOnce();
    expect(recovery.snapshot()).toMatchObject({
      state: "idle", fullRescanPending: false, continuationPending: false, retryCount: 3, lastFailure: null, lastFailureAt: null
    });
    await recovery.stop();
  });

  it("retains a full request that arrives while retained continuation is active", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<{ failedBindingIds: readonly string[]; fullRescanRequired: boolean }>((resolve) => {
      release = () => resolve({ failedBindingIds: [], fullRescanRequired: false });
    });
    const continueRetainedActivity = vi.fn(() => blocked);
    const convergeAll = vi.fn(async () => ({ failedBindingIds: [], fullRescanRequired: false }));
    const recovery = new StartupViewRecovery({
      convergeAll, continueRetainedActivity, convergeBindings: async () => [], baseDelayMs: 10, maxDelayMs: 10
    });

    recovery.requestRetainedContinuation();
    recovery.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(recovery.snapshot()).toMatchObject({ state: "running", fullRescanPending: false, continuationPending: false });
    recovery.requestFullRescan();
    expect(recovery.snapshot()).toMatchObject({ state: "running", fullRescanPending: true, continuationPending: false });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.snapshot()).toMatchObject({ state: "retry_wait", fullRescanPending: true, continuationPending: false });
    await vi.advanceTimersByTimeAsync(10);
    expect(convergeAll).toHaveBeenCalledOnce();
    expect(recovery.snapshot()).toMatchObject({ state: "idle", fullRescanPending: false, continuationPending: false });
    await recovery.stop();
  });
});
