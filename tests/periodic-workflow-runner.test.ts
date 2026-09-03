import { describe, expect, it, vi } from "vitest";
import { PeriodicWorkflowRunner } from "../src/runtime/periodic-workflow-runner.js";

describe("PeriodicWorkflowRunner", () => {
  it("coalesces concurrent requests and waits for the active pass during stop", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const runner = new PeriodicWorkflowRunner({ run, onError: vi.fn() });

    const first = runner.request();
    const second = runner.request();
    expect(run).toHaveBeenCalledOnce();
    const stopping = runner.stop();
    release();
    await Promise.all([first, second, stopping]);
    await runner.request();
    expect(run).toHaveBeenCalledOnce();
  });

  it("schedules future passes without an eager start pass", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    const runner = new PeriodicWorkflowRunner({ run, onError: vi.fn() });
    runner.start(100);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledOnce();
    await runner.stop();
    vi.useRealTimers();
  });
});
