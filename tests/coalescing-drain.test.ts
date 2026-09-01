import { describe, expect, it, vi } from "vitest";
import { CoalescingDrain } from "../src/runtime/coalescing-drain.js";

describe("CoalescingDrain", () => {
  it("coalesces wake-ups during one drain into one follow-up pass", async () => {
    let release!: () => void;
    const drain = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    const runtime = new CoalescingDrain({ drain, onError: vi.fn() });
    runtime.start();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    runtime.wake();
    runtime.wake();
    release();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(2));
    await runtime.stop();
  });

  it("reports failures and accepts a later wake-up", async () => {
    const onError = vi.fn();
    const drain = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
    const runtime = new CoalescingDrain({ drain, onError });
    runtime.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "busy" })));
    runtime.wake();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledTimes(2));
    await runtime.stop();
  });

  it("periodically wakes and ignores wake-ups after stop", async () => {
    vi.useFakeTimers();
    const drain = vi.fn(async () => {});
    const runtime = new CoalescingDrain({ drain, onError: vi.fn() });
    runtime.start(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drain).toHaveBeenCalledTimes(2);
    await runtime.stop();
    runtime.wake();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(drain).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("waits for the active pass without starting queued work after stop", async () => {
    let release!: () => void;
    const drain = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const runtime = new CoalescingDrain({ drain, onError: vi.fn() });
    runtime.start();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    runtime.wake();
    const stopping = runtime.stop();
    release();
    await stopping;
    expect(drain).toHaveBeenCalledOnce();
    expect(runtime.snapshot()).toEqual({ state: "stopping", requested: true });
  });
});
