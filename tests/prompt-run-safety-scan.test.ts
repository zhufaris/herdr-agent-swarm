import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptRunWorkflow } from "../src/coordinator/prompt-run-workflow.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";

describe("PromptRunWorkflow durable safety scan", () => {
  afterEach(() => vi.useRealTimers());

  it("scans immediately and backs idle scans off to the capped delay with one timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    const scan = vi.fn(() => ({ cancelled: 0, failedDetached: 0, hints: [] }));
    const workflow = createWorkflow({ scanDurablePromptWork: scan }, 100);

    workflow.start();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(workflow.snapshot()).toMatchObject({
      state: "running", lastScanOutcome: "idle", currentSafetyScanDelayMs: 100,
      nextSafetyScanAt: "2026-08-29T00:00:00.100Z"
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(workflow.snapshot()).toMatchObject({ currentSafetyScanDelayMs: 200, nextSafetyScanAt: "2026-08-29T00:00:00.300Z" });
    await vi.advanceTimersByTimeAsync(199);
    expect(scan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(3);
    expect(workflow.snapshot()).toMatchObject({ currentSafetyScanDelayMs: 400, nextSafetyScanAt: "2026-08-29T00:00:00.700Z" });
    await vi.advanceTimersByTimeAsync(400);
    expect(scan).toHaveBeenCalledTimes(4);
    expect(workflow.snapshot()).toMatchObject({ currentSafetyScanDelayMs: 600, nextSafetyScanAt: "2026-08-29T00:00:01.300Z" });
    await vi.advanceTimersByTimeAsync(600);
    expect(scan).toHaveBeenCalledTimes(5);
    expect(workflow.snapshot()).toMatchObject({ currentSafetyScanDelayMs: 600, nextSafetyScanAt: "2026-08-29T00:00:01.900Z" });
    expect(vi.getTimerCount()).toBe(1);
    await workflow.stop();
  });

  it("resets to the base delay when a safety scan finds work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    const scan = vi.fn()
      .mockReturnValueOnce({ cancelled: 0, failedDetached: 0, hints: [] })
      .mockReturnValueOnce({ cancelled: 0, failedDetached: 0, hints: [] })
      .mockReturnValueOnce({ cancelled: 0, failedDetached: 0, hints: [{ kind: "prompt-ready", bindingId: "b1" }] });
    const claim = vi.fn(() => null);
    const workflow = createWorkflow({ scanDurablePromptWork: scan, claimNextDispatchablePrompt: claim }, 100);

    workflow.start();
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();

    expect(scan).toHaveBeenCalledTimes(3);
    expect(claim).toHaveBeenCalledWith("b1");
    expect(workflow.snapshot()).toMatchObject({
      state: "running", lastScanOutcome: "work_found",
      lastDiscovered: { turns: 1, steering: 0, detached: 0, cancelled: 0, failedDetached: 0 },
      currentSafetyScanDelayMs: 100, nextSafetyScanAt: "2026-08-29T00:00:00.400Z"
    });
    await workflow.stop();
  });

  it("reports terminal detached convergence as discovered work without exposing prompt identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    const info = vi.fn();
    const scan = vi.fn(() => ({ cancelled: 0, failedDetached: 2, hints: [] }));
    const workflow = createWorkflow({ scanDurablePromptWork: scan }, 100, vi.fn(), info);

    workflow.start();

    expect(workflow.snapshot()).toMatchObject({
      state: "running", lastScanOutcome: "work_found",
      lastDiscovered: { turns: 0, steering: 0, detached: 0, cancelled: 0, failedDetached: 2 },
      currentSafetyScanDelayMs: 100, nextSafetyScanAt: "2026-08-29T00:00:00.100Z"
    });
    expect(info).toHaveBeenCalledWith({
      event: "prompt-backlog-converged", cancelled: 0, failedDetached: 2, outcome: "terminalized"
    }, "converged prompt work whose bindings can no longer dispatch or observe");
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/promptId|bindingId|private/);
    await workflow.stop();
  });

  it("retries a failed scan at the base delay without exposing its error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    const error = vi.fn();
    const scan = vi.fn()
      .mockReturnValueOnce({ cancelled: 0, failedDetached: 0, hints: [] })
      .mockReturnValueOnce({ cancelled: 0, failedDetached: 0, hints: [] })
      .mockImplementationOnce(() => { throw new Error("private database detail"); })
      .mockReturnValue({ cancelled: 0, failedDetached: 0, hints: [] });
    const workflow = createWorkflow({ scanDurablePromptWork: scan }, 100, error);

    workflow.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(workflow.snapshot()).toMatchObject({
      state: "running", lastScanAt: "2026-08-29T00:00:00.300Z",
      lastScanOutcome: "failed", lastScanFailureAt: "2026-08-29T00:00:00.300Z",
      currentSafetyScanDelayMs: 100, nextSafetyScanAt: "2026-08-29T00:00:00.400Z"
    });
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "prompt-safety-scan-failed", outcome: "deferred_to_next_scan" }), expect.any(String));
    await vi.advanceTimersByTimeAsync(100);
    expect(scan).toHaveBeenCalledTimes(4);
    expect(workflow.snapshot()).toMatchObject({ state: "running", lastScanOutcome: "idle" });
    expect(JSON.stringify(workflow.snapshot())).not.toContain("private database detail");
    await workflow.stop();
  });

  it("handles a wake immediately and replaces a long idle timeout with one base-delay scan", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T00:00:00.000Z"));
    const scan = vi.fn(() => ({ cancelled: 0, failedDetached: 0, hints: [] }));
    const claim = vi.fn(() => null);
    const workflow = createWorkflow({ scanDurablePromptWork: scan, claimNextDispatchablePrompt: claim }, 100);
    workflow.start();
    await vi.advanceTimersByTimeAsync(700);
    expect(workflow.snapshot()).toMatchObject({ currentSafetyScanDelayMs: 600, nextSafetyScanAt: "2026-08-29T00:00:01.300Z" });

    workflow.wake({ kind: "prompt-ready", bindingId: "b1" });
    expect(claim).toHaveBeenCalledWith("b1");
    expect(vi.getTimerCount()).toBe(1);
    expect(workflow.snapshot()).toMatchObject({ currentSafetyScanDelayMs: 100, nextSafetyScanAt: "2026-08-29T00:00:00.800Z" });
    await vi.advanceTimersByTimeAsync(99);
    expect(scan).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(1);
    await workflow.stop();
  });

  it("keeps one timer across repeated starts and wakes and never rearms after stop", async () => {
    vi.useFakeTimers();
    const scan = vi.fn(() => ({ cancelled: 0, failedDetached: 0, hints: [] }));
    const workflow = createWorkflow({ scanDurablePromptWork: scan, claimNextDispatchablePrompt: () => null }, 100);

    workflow.start();
    workflow.start();
    workflow.wake({ kind: "prompt-ready", bindingId: "b1" });
    workflow.wake({ kind: "control-ready", bindingId: "b1" });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await workflow.stop();
    expect(workflow.snapshot()).toMatchObject({ state: "stopping", currentSafetyScanDelayMs: null, nextSafetyScanAt: null });
    expect(vi.getTimerCount()).toBe(0);
    workflow.requestSafetyScan();
    workflow.wake({ kind: "prompt-ready", bindingId: "b1" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not immediately wake ordinary work when detached observation remains uncertain", async () => {
    const wake = vi.fn();
    const prompt = { id: "p1", bindingId: "b1", state: "running", observationState: "detached" };
    const workflow = new PromptRunWorkflow({
      store: {
        getPrompt: vi.fn(() => prompt),
        getBinding: vi.fn(() => null)
      } as never,
      scheduler: { subscribe: () => () => {}, wake },
      turnTimeoutMs: 1_000,
      herdr: {} as never, bus: { async publish() {} },
      outboundWork: { wake() {}, subscribe() { return () => {}; } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));

    expect(wake).not.toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    await workflow.stop();
  });
});

function createWorkflow(storeOverrides: Record<string, unknown>, safetyScanIntervalMs: number, error = vi.fn(), info = vi.fn()): PromptRunWorkflow {
  const scheduler = new InProcessPromptWorkScheduler();
  const store = { scanDurablePromptWork: () => ({ cancelled: 0, failedDetached: 0, hints: [] }), claimNextDispatchablePrompt: () => null, ...storeOverrides };
  return new PromptRunWorkflow({
    store: store as never, scheduler, safetyScanIntervalMs, turnTimeoutMs: 1_000,
    herdr: {} as never, bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
    logger: { info, warn: vi.fn(), error } as never
  });
}
