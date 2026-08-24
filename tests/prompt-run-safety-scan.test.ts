import { describe, expect, it, vi } from "vitest";
import { PromptRunWorkflow } from "../src/coordinator/prompt-run-workflow.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";

describe("PromptRunWorkflow durable safety scan", () => {
  it("finds durable work at startup and periodically after a lost wake", async () => {
    vi.useFakeTimers();
    const scan = vi.fn()
      .mockReturnValueOnce({ cancelled: 0, hints: [] })
      .mockReturnValueOnce({ cancelled: 0, hints: [{ kind: "prompt-ready", bindingId: "b1" }] })
      .mockReturnValue({ cancelled: 0, hints: [] });
    const claim = vi.fn(() => null);
    const workflow = createWorkflow({ scanDurablePromptWork: scan, claimNextDispatchablePrompt: claim }, 100);

    workflow.start();
    expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    expect(scan).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenCalledWith("b1");
    expect(workflow.snapshot()).toMatchObject({
      state: "running", lastScanOutcome: "work_found",
      lastDiscovered: { turns: 1, steering: 0, detached: 0, cancelled: 0 }
    });
    await workflow.stop();
    vi.useRealTimers();
  });

  it("isolates a failed scan, retries later, and stops future timer scans", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    const error = vi.fn();
    const scan = vi.fn()
      .mockImplementationOnce(() => { throw new Error("private database detail"); })
      .mockReturnValue({ cancelled: 0, hints: [] });
    const workflow = createWorkflow({ scanDurablePromptWork: scan }, 100, error);

    expect(workflow.snapshot()).toMatchObject({ state: "idle", lastScanAt: null, lastScanFailureAt: null });
    workflow.start();
    expect(workflow.snapshot()).toMatchObject({
      state: "running", lastScanAt: "2026-08-24T00:00:00.000Z",
      lastScanOutcome: "failed", lastScanFailureAt: "2026-08-24T00:00:00.000Z"
    });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "prompt-safety-scan-failed", outcome: "deferred_to_next_scan" }), expect.any(String));

    await vi.advanceTimersByTimeAsync(100);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(workflow.snapshot()).toMatchObject({ state: "running", lastScanOutcome: "idle" });
    await workflow.stop();
    expect(workflow.snapshot().state).toBe("stopping");
    await vi.advanceTimersByTimeAsync(500);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(workflow.snapshot())).not.toContain("private database detail");
    vi.useRealTimers();
  });
});

function createWorkflow(storeOverrides: Record<string, unknown>, safetyScanIntervalMs: number, error = vi.fn()): PromptRunWorkflow {
  const scheduler = new InProcessPromptWorkScheduler();
  const store = { scanDurablePromptWork: () => ({ cancelled: 0, hints: [] }), claimNextDispatchablePrompt: () => null, ...storeOverrides };
  return new PromptRunWorkflow({
    store: store as never, scheduler, safetyScanIntervalMs, turnTimeoutMs: 1_000,
    herdr: {} as never, bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
    logger: { info: vi.fn(), warn: vi.fn(), error } as never
  });
}
