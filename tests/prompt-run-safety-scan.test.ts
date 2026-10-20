import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptRunWorkflow } from "../src/coordinator/prompt-run-workflow.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";
import { primaryPresentation } from "./helpers/presentation.js";

describe("PromptRunWorkflow durable safety scan", () => {
  afterEach(() => vi.useRealTimers());

  it("awaits recovered-prompt delivery convergence before awake reports execution recovery", async () => {
    let release!: () => void;
    const downstream = new Promise<void>((resolve) => { release = resolve; });
    const prompt = { id: "p1", bindingId: "b1", state: "recovering", observationState: "detached", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-10-02T00:00:00.000Z" };
    const binding = { id: "b1", generation: 1, paneId: "w1:p1", agentKind: "traex", state: "active", lifecycle: "active" };
    const onRecoveredPromptSettled = vi.fn(async () => downstream);
    const workflow = new PromptRunWorkflow({
      stores: promptStores({ listDetachedPrompts: vi.fn(() => [prompt]), getBinding: vi.fn(() => binding) }),
      scheduler: { subscribe: () => () => {}, wake: vi.fn() }, turnTimeoutMs: 1_000,
      herdr: {} as never, bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(),
      recoverExternalTurns: vi.fn(async () => ({ outcome: "recovered" as const, recoveredTurns: 1 })),
      onRecoveredPromptSettled,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    let returned = false;
    const awake = workflow.awake("b1").then((result) => { returned = true; return result; });
    await vi.waitFor(() => expect(onRecoveredPromptSettled).toHaveBeenCalledWith("p1"));
    expect(returned).toBe(false);
    release();
    await expect(awake).resolves.toEqual({ outcome: "recovered", recoveredTurns: 1 });
  });

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

  it("yields periodic cadence ownership while keeping explicit durable scans", async () => {
    vi.useFakeTimers();
    const scan = vi.fn(() => ({ cancelled: 0, failedDetached: 0, hints: [] }));
    const workflow = createWorkflow({ scanDurablePromptWork: scan }, 100, undefined, undefined, true);

    workflow.start();
    expect(scan).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(scan).toHaveBeenCalledOnce();
    workflow.requestSafetyScan();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(workflow.snapshot()).toMatchObject({ currentSafetyScanDelayMs: null, nextSafetyScanAt: null });
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
      lastDiscovered: { turns: 1, detached: 0, cancelled: 0, failedDetached: 0 },
      currentSafetyScanDelayMs: 100, nextSafetyScanAt: "2026-08-29T00:00:00.400Z"
    });
    await workflow.stop();
  });

  it("wakes a durable Native Input Batch exactly at its fixed deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T01:00:00.000Z"));
    const scheduler = new InProcessPromptWorkScheduler();
    const drainDueNativeInputBatch = vi.fn()
      .mockResolvedValueOnce({ outcome: "not_due", nextDueAt: "2026-10-02T01:00:02.000Z" })
      .mockResolvedValueOnce({ outcome: "formed", nextDueAt: null });
    const claim = vi.fn(() => null);
    const workflow = new PromptRunWorkflow({
      stores: promptStores({ claimNextDispatchablePrompt: claim }), scheduler, safetyScanIntervalMs: 30_000, turnTimeoutMs: 1_000,
      herdr: {} as never, bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation,
      bindingPrompts: { ...testBindingPrompts(), drainDueNativeInputBatch },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });
    workflow.start();

    scheduler.wake({ kind: "prompt-ready", bindingId: "b1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(drainDueNativeInputBatch).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(drainDueNativeInputBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(drainDueNativeInputBatch).toHaveBeenCalledTimes(2);
    await workflow.stop();
  });

  it("reconciles active-turn input without starting a parallel native submission worker", async () => {
    let releaseRecovery!: () => void;
    const recovery = new Promise<{ outcome: "none"; reason: string }>((resolve) => {
      releaseRecovery = () => resolve({ outcome: "none", reason: "settled" });
    });
    let releaseBatchReconciliation!: () => void;
    const blockedBatchReconciliation = new Promise<void>((resolve) => { releaseBatchReconciliation = resolve; });
    const drainDueNativeInputBatch = vi.fn(async () => {
      await blockedBatchReconciliation;
      return { outcome: "formed" as const, nextDueAt: null };
    });
    const prompt = { id: "p1", bindingId: "b1", state: "recovering", observationState: "detached" };
    const binding = { id: "b1", generation: 1, paneId: "w1:p1", state: "active", lifecycle: "active" };
    const workflow = new PromptRunWorkflow({
      stores: promptStores({ listDetachedPrompts: vi.fn(() => [prompt]), getBinding: vi.fn(() => binding) }),
      scheduler: { subscribe: () => () => {}, wake: vi.fn() }, turnTimeoutMs: 1_000,
      herdr: {} as never, bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: { ...testBindingPrompts(), drainDueNativeInputBatch },
      recoverExternalTurns: vi.fn(async () => recovery),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    const awake = workflow.awake("b1");
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(1));
    workflow.wake({ kind: "prompt-ready", bindingId: "b1" });
    await vi.waitFor(() => expect(drainDueNativeInputBatch).toHaveBeenCalledOnce());

    expect(workflow.snapshot().nativeSubmissionWorkers).toBe(0);

    releaseBatchReconciliation();
    releaseRecovery();
    await awake;
    await workflow.stop();
  });

  it("rechecks prompt work when batch reconciliation outlives the ordinary worker", async () => {
    let releasePaneObservation!: () => void;
    const paneObservation = new Promise<null>((resolve) => { releasePaneObservation = () => resolve(null); });
    let releaseBatchReconciliation!: () => void;
    const batchReconciliation = new Promise<void>((resolve) => { releaseBatchReconciliation = resolve; });
    const drainDueNativeInputBatch = vi.fn()
      .mockResolvedValueOnce({ outcome: "none" as const, nextDueAt: null })
      .mockImplementationOnce(async () => {
        await batchReconciliation;
        return { outcome: "formed" as const, nextDueAt: null };
      });
    const claimed = {
      binding: { id: "b1", generation: 1, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle" },
      prompt: { id: "p1", bindingId: "b1", body: "first", updatedAt: "claim-version" },
      executionBody: "first", model: null
    };
    const claim = vi.fn()
      .mockReturnValueOnce(claimed)
      .mockReturnValue(null);
    const getPane = vi.fn(async () => paneObservation);
    const workflow = new PromptRunWorkflow({
      stores: promptStores({ claimNextDispatchablePrompt: claim, releaseUndispatchedPromptClaim: vi.fn(() => true) }),
      scheduler: { subscribe: () => () => {}, wake: vi.fn() }, turnTimeoutMs: 1_000,
      herdr: { getPane } as never, bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: { ...testBindingPrompts(), drainDueNativeInputBatch },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    workflow.wake({ kind: "prompt-ready", bindingId: "b1" });
    await vi.waitFor(() => expect(getPane).toHaveBeenCalledOnce());
    workflow.wake({ kind: "prompt-ready", bindingId: "b1" });
    await vi.waitFor(() => expect(drainDueNativeInputBatch).toHaveBeenCalledTimes(2));

    releasePaneObservation();
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(1));
    expect(claim).toHaveBeenCalledOnce();
    releaseBatchReconciliation();

    await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
    await workflow.stop();
  });

  it("requeues an unowned stale pre-dispatch claim and wakes its FIFO", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T00:00:10.000Z"));
    const wake = vi.fn();
    const candidate = { promptId: "p1", bindingId: "b1", updatedAt: "2026-09-05T00:00:00.000Z" };
    const requeue = vi.fn(() => true);
    const workflow = new PromptRunWorkflow({
      stores: promptStores({
        scanDurablePromptWork: () => ({ cancelled: 0, failedDetached: 0, hints: [] }),
        listStaleUndispatchedPromptClaims: vi.fn(() => [candidate]),
        requeueStaleUndispatchedPromptClaim: requeue
      }),
      scheduler: { subscribe: () => () => {}, wake }, safetyScanIntervalMs: 100, staleClaimGraceMs: 1_000, turnTimeoutMs: 1_000,
      herdr: {} as never, bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    workflow.requestSafetyScan();

    expect(requeue).toHaveBeenCalledWith(candidate);
    expect(wake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    expect(workflow.snapshot()).toMatchObject({ lastScanOutcome: "work_found", lastDiscovered: { recoveredClaims: 1 } });
  });

  it("does not requeue a stale claim while its binding worker is still alive", async () => {
    const candidate = { promptId: "p1", bindingId: "b1", updatedAt: "2026-09-05T00:00:00.000Z" };
    const requeue = vi.fn(() => true);
    let claimCount = 0;
    const workflow = new PromptRunWorkflow({
      stores: promptStores({
        scanDurablePromptWork: () => ({ cancelled: 0, failedDetached: 0, hints: [] }),
        listStaleUndispatchedPromptClaims: vi.fn(() => [candidate]),
        requeueStaleUndispatchedPromptClaim: requeue,
        claimNextDispatchablePrompt: vi.fn(() => claimCount++ === 0 ? {
          binding: { id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle" },
          prompt: { id: "p1", bindingId: "b1", body: "work", state: "running", observationState: "not_started" },
          model: null
        } : null),
        countPendingPrompts: () => 1,
        getBinding: () => ({ id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle" })
      }),
      scheduler: { subscribe: () => () => {}, wake: vi.fn() }, safetyScanIntervalMs: 100, staleClaimGraceMs: 1_000, turnTimeoutMs: 1_000,
      transcriptReader: { async open() { return new Promise(() => undefined); } },
      herdr: { async getPane() { return { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"] }; } } as never, bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    workflow.wake({ kind: "prompt-ready", bindingId: "b1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(1));
    workflow.requestSafetyScan();

    expect(requeue).not.toHaveBeenCalled();
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
      lastDiscovered: { turns: 0, detached: 0, cancelled: 0, failedDetached: 2 },
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
    await vi.advanceTimersByTimeAsync(0);
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

  it("hands transcript ownership to external observation before claiming queued bridge work", async () => {
    const order: string[] = [];
    const handoff = vi.fn(async () => { order.push("handoff"); });
    const claim = vi.fn(() => { order.push("claim"); return null; });
    const workflow = new PromptRunWorkflow({
      stores: promptStores({ scanDurablePromptWork: () => ({ cancelled: 0, failedDetached: 0, hints: [] }), claimNextDispatchablePrompt: claim }),
      scheduler: new InProcessPromptWorkScheduler(), safetyScanIntervalMs: 100, turnTimeoutMs: 1_000,
      herdr: {} as never, bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, handoffExternalTurns: handoff
    });

    workflow.wake({ kind: "prompt-ready", bindingId: "b1" });
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());

    expect(handoff).toHaveBeenCalledWith("b1");
    expect(order).toEqual(["handoff", "claim"]);
    await workflow.stop();
  });

  it("releases a claimed prompt when an external turn starts before dispatch", async () => {
    const order: string[] = [];
    const runPrompt = vi.fn();
    const release = vi.fn(() => { order.push("release"); return true; });
    let claimCount = 0;
    const workflow = new PromptRunWorkflow({
      stores: promptStores({
        scanDurablePromptWork: () => ({ cancelled: 0, failedDetached: 0, hints: [] }),
        claimNextDispatchablePrompt: vi.fn(() => {
          order.push("claim");
          return claimCount++ === 0 ? {
            binding: { id: "b1", generation: 3, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" },
            prompt: { id: "p1", bindingId: "b1", body: "queued work", state: "running", observationState: "not_started", updatedAt: "claim-version" },
            model: null
          } : null;
        }),
        releaseUndispatchedPromptClaim: release,
        getBinding: vi.fn(() => null)
      }),
      scheduler: new InProcessPromptWorkScheduler(), turnTimeoutMs: 1_000,
      herdr: {
        getPane: vi.fn(async () => { order.push("observe"); return { paneId: "w1:p1", workspaceId: "w1", agentState: "working", activeTurnId: "external-turn", foregroundExecutables: ["traex"] }; }),
        runPrompt
      } as never,
      bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      handoffExternalTurns: vi.fn(async () => { order.push("handoff"); })
    });

    workflow.wake({ kind: "prompt-ready", bindingId: "b1" });
    await vi.waitFor(() => expect(order).toEqual(["handoff", "claim", "observe", "release", "handoff"]));

    expect(release).toHaveBeenCalledWith({ promptId: "p1", bindingId: "b1", updatedAt: "claim-version", bindingGeneration: 3, paneId: "w1:p1" });
    expect(runPrompt).not.toHaveBeenCalled();
    await workflow.stop();
  });

  it("requeues a prompt rejected by a concurrent Herdr turn before acceptance", async () => {
    const release = vi.fn(() => true);
    const failPrompt = vi.fn();
    let claimCount = 0;
    const handoff = vi.fn(async () => undefined);
    const workflow = new PromptRunWorkflow({
      stores: promptStores({
        scanDurablePromptWork: () => ({ cancelled: 0, failedDetached: 0, hints: [] }),
        claimNextDispatchablePrompt: vi.fn(() => claimCount++ === 0 ? {
          binding: { id: "b1", generation: 2, workspaceId: "w1", paneId: "w1:p1", state: "active", lifecycle: "active", agentKind: "traex", lastAgentState: "idle" },
          prompt: { id: "p1", bindingId: "b1", body: "queued work", state: "running", observationState: "not_started", updatedAt: "claim-version" },
          model: null
        } : null),
        releaseUndispatchedPromptClaim: release, failPrompt, countPendingPrompts: () => 1, getBinding: () => null
      }),
      scheduler: new InProcessPromptWorkScheduler(), turnTimeoutMs: 1_000,
      herdr: {
        async getPane() { return { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"] }; },
        async runPrompt() { throw new Error('{"error":{"code":"agent_not_ready","message":"another turn won"}}'); }
      } as never,
      bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, handoffExternalTurns: handoff
    });

    workflow.wake({ kind: "prompt-ready", bindingId: "b1" });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());

    expect(release).toHaveBeenCalledWith({ promptId: "p1", bindingId: "b1", updatedAt: "claim-version", bindingGeneration: 2, paneId: "w1:p1" });
    expect(failPrompt).not.toHaveBeenCalled();
    expect(handoff).toHaveBeenCalledTimes(2);
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
      stores: promptStores({
        getPrompt: vi.fn(() => prompt),
        getBinding: vi.fn(() => null)
      }),
      scheduler: { subscribe: () => () => {}, wake },
      turnTimeoutMs: 1_000,
      herdr: {} as never, bus: { async publish() {} },
      outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));

    expect(wake).not.toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    await workflow.stop();
  });

  it("advances bounded recovery for an identity-less recovering Prompt", async () => {
    const advanceDetachedPromptRecovery = vi.fn(() => ({ outcome: "observed" as const, attemptCount: 1, nextAttemptAt: "2026-10-01T00:01:00.000Z" }));
    const prompt = { id: "p1", bindingId: "b1", executionOrigin: "bridge", state: "recovering", observationState: "detached", transcriptTurnId: null, transcriptTurnStartedAt: null, dispatchedAt: "2026-09-30T23:00:00.000Z", createdAt: "2026-09-30T22:00:00.000Z" };
    const workflow = new PromptRunWorkflow({
      stores: promptStores({
        getPrompt: vi.fn(() => prompt),
        getBinding: vi.fn(() => ({ id: "b1", generation: 1, paneId: "w1:p1", agentSessionValue: "session-1" })),
        recoverProjectedBridgeTurn: vi.fn(() => ({ outcome: "not_found" as const })),
        advanceDetachedPromptRecovery
      }),
      scheduler: { subscribe: () => () => {}, wake: vi.fn() }, detachedPromptAutoSkipMs: 30 * 60_000, turnTimeoutMs: 1_000,
      herdr: { observeRuntime: vi.fn(async () => ({ pane: { paneId: "w1:p1", agentState: "idle", agentSession: { value: "session-1" } } })) } as never,
      bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(advanceDetachedPromptRecovery).toHaveBeenCalledOnce());
    await workflow.stop();
  });

  it("converges an accepted Core receipt after response loss without replay or exact turn identity", async () => {
    const applyPromptNativeSubmissionReceipt = vi.fn(() => true);
    const advanceDetachedPromptRecovery = vi.fn(() => ({ outcome: "observed" as const, attemptCount: 1, nextAttemptAt: "2026-10-01T00:01:00.000Z" }));
    const getNativeSubmissionReceipt = vi.fn(async () => ({
      submissionId: "p1", terminalId: "terminal-1", agentKind: "traex" as const,
      sessionId: "session-1", state: "accepted" as const, createdAt: 10, updatedAt: 11
    }));
    const { workflow } = detachedAutoSkipWorkflow({
      advanceDetachedPromptRecovery, getSubmissionReceipt: vi.fn(), getNativeSubmissionReceipt,
      applyPromptNativeSubmissionReceipt, observeRuntime: vi.fn(async () => ({
        pane: { paneId: "w1:p1", agentState: "idle", agentSession: { value: "session-1" } },
        traexProcess: true, composerReady: true, evidenceSource: "structured" as const
      })), detachedPromptAutoSkipMs: 30 * 60_000
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(applyPromptNativeSubmissionReceipt).toHaveBeenCalledOnce());
    expect(applyPromptNativeSubmissionReceipt).toHaveBeenCalledWith({
      promptId: "p1", bindingId: "b1", submissionId: "p1", dispatchedAt: "2026-09-30T00:00:00.000Z",
      state: "accepted", notice: "Core confirmed the native submission; observing execution without replay"
    });
    expect(advanceDetachedPromptRecovery).toHaveBeenCalledOnce();
    await workflow.stop();
  });

  it("releases a rejected durable Core receipt after reopen and schedules the queued Prompt", async () => {
    const releaseRejectedNativeSubmission = vi.fn(() => true);
    const schedulerWake = vi.fn();
    const { workflow } = detachedAutoSkipWorkflow({
      advanceDetachedPromptRecovery: vi.fn(), getSubmissionReceipt: vi.fn(),
      getNativeSubmissionReceipt: vi.fn(async () => ({
        submissionId: "p1", terminalId: "terminal-1", agentKind: "traex" as const,
        sessionId: "session-1", state: "rejected" as const, createdAt: 10, updatedAt: 11
      })),
      releaseRejectedNativeSubmission, observeRuntime: vi.fn(), detachedPromptAutoSkipMs: 30 * 60_000,
      schedulerWake
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(releaseRejectedNativeSubmission).toHaveBeenCalledOnce());
    expect(schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    await workflow.stop();
  });

  it("ignores detached-observer hints for Herdr-origin prompts", async () => {
    const getSubmissionReceipt = vi.fn();
    const workflow = new PromptRunWorkflow({
      stores: promptStores({
        getPrompt: vi.fn(() => ({
          id: "external-prompt", bindingId: "b1", executionOrigin: "herdr",
          state: "running", observationState: "detached"
        }))
      }),
      scheduler: { subscribe: () => () => {}, wake: vi.fn() },
      turnTimeoutMs: 1_000,
      transcriptReader: {
        getSubmissionReceipt,
        async open() { return { mode: "unavailable" as const, reason: "transcript_not_found" as const }; }
      },
      herdr: {} as never, bus: { async publish() {} },
      outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "external-prompt" });

    expect(workflow.snapshot().activeTurnWorkers).toBe(0);
    expect(getSubmissionReceipt).not.toHaveBeenCalled();
    await workflow.stop();
  });

  it("releases a detached worker when another observer terminalizes its prompt", async () => {
    const wake = vi.fn();
    const running = { id: "p1", bindingId: "b1", state: "running", observationState: "detached", nativeSubmissionId: "p1", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-08-29T00:00:00.000Z" };
    const delivered = { ...running, state: "delivered", observationState: "completed" };
    const getPrompt = vi.fn().mockReturnValueOnce(running).mockReturnValueOnce(running).mockReturnValue(delivered);
    const observeRuntime = vi.fn();
    const workflow = new PromptRunWorkflow({
      stores: promptStores({ getPrompt, getBinding: () => ({ id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "idle" }) }),
      scheduler: { subscribe: () => () => {}, wake },
      turnTimeoutMs: 1_000, transcriptReader: { async open() { return { mode: "unavailable" as const, reason: "transcript_not_found" as const }; } },
      herdr: { observeRuntime } as never, bus: { async publish() {} },
      outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));

    expect(observeRuntime).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    await workflow.stop();
  });

  it("does not let a detached observer overwrite an explicit skip after reading terminal output", async () => {
    const wake = vi.fn();
    const running = { id: "p1", bindingId: "b1", state: "running", observationState: "detached", nativeSubmissionId: "p1", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-08-29T00:00:00.000Z" };
    const skipped = { ...running, state: "failed", observationState: "completed" };
    let skippedAfterTerminalRead = false;
    const getPrompt = vi.fn(() => skippedAfterTerminalRead ? skipped : running);
    const settleDetachedPrompt = vi.fn(() => ({ settled: !skippedAfterTerminalRead, completionActionEligibility: { outcome: "skipped" as const, reason: "not-completion" as const } }));
    const workflow = new PromptRunWorkflow({
      stores: promptStores({
        getPrompt, settleDetachedPrompt, countPendingPrompts: () => 0,
        getBinding: () => ({ id: "b1", paneId: "w1:p1", state: "active", lifecycle: "active", lastAgentState: "working" })
      }),
      scheduler: { subscribe: () => () => {}, wake },
      turnTimeoutMs: 1_000,
      transcriptReader: { async open() { return { mode: "typed" as const, cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          skippedAfterTerminalRead = true;
          return {
            turnId: "turn-1", answerDelta: "late answer",
            turnLifecycle: { turnId: "turn-1", state: "completed" as const, startedAt: "2026-08-29T00:00:00.000Z", finalAnswer: "late answer" }
          };
        }
      } }; } },
      herdr: { async observeRuntime() { return { pane: { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }, traexProcess: true, composerReady: true, evidenceSource: "structured" }; } } as never,
      bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));

    expect(settleDetachedPrompt).toHaveBeenCalledWith(expect.objectContaining({
      promptId: "p1", bindingId: "b1", runtime: "idle", terminal: expect.objectContaining({ kind: "completed", answer: "late answer" })
    }));
    expect(wake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    await workflow.stop();
  });

  it("auto-skips an aged detached Prompt after a qualifying receipt outcome", async () => {
    const schedulerWake = vi.fn();
    const outboundWake = vi.fn();
    const advanceDetachedPromptRecovery = vi.fn(() => ({ outcome: "skipped" as const, promptId: "p1", outboxReserved: true, attemptCount: 3 }));
    const getSubmissionReceipt = vi.fn(async () => ({
      submissionId: "p1", state: "terminal" as const,
      agentKind: "traex" as const, sessionId: "session-1"
    }));
    const observeRuntime = vi.fn(async () => ({
      pane: {
        paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"],
        agentState: "idle" as const,
        agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
      },
      traexProcess: true, composerReady: true, evidenceSource: "structured" as const
    }));
    const { workflow, safetyScan } = detachedAutoSkipWorkflow({
      advanceDetachedPromptRecovery, getSubmissionReceipt, observeRuntime,
      schedulerWake, outboundWake, detachedPromptAutoSkipMs: 30 * 60_000
    });
    safetyScan.mockReturnValue({
      cancelled: 0, failedDetached: 0,
      hints: [{ kind: "detached-observer-ready" as const, bindingId: "b1", promptId: "p2" }]
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));

    expect(getSubmissionReceipt).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: "traex", bindingId: "b1", generation: 3, paneId: "w1:p1",
      nativeSession: expect.objectContaining({ value: "session-1" })
    }), "p1");
    expect(observeRuntime).toHaveBeenCalledWith("w1:p1");
    expect(advanceDetachedPromptRecovery).toHaveBeenCalledWith(expect.objectContaining({
      promptId: "p1", bindingId: "b1", expectedBindingGeneration: 3,
      expectedPaneId: "w1:p1", expectedNativeSessionId: "session-1",
      reason: "⚠ 无法确认该请求的最终执行结果，已跳过；请求不会自动重放，后续队列继续处理。",
      renderRunCard: expect.any(Function)
    }));
    expect(schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    expect(outboundWake).toHaveBeenCalledOnce();
    expect(safetyScan).toHaveBeenCalledOnce();
    expect(schedulerWake).toHaveBeenCalledWith({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p2" });
    await workflow.stop();
  });

  it("advances bounded recovery when projected Core evidence belongs to another Prompt", async () => {
    const advanceDetachedPromptRecovery = vi.fn(() => ({
      outcome: "observed" as const, attemptCount: 1, nextAttemptAt: "2026-09-30T00:10:30.000Z"
    }));
    const getSubmissionReceipt = vi.fn();
    const observeRuntime = vi.fn(async () => ({
      pane: {
        paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"],
        agentState: "idle" as const,
        agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
      },
      traexProcess: true, composerReady: true, evidenceSource: "structured" as const
    }));
    const { workflow, schedulerWake } = detachedAutoSkipWorkflow({
      advanceDetachedPromptRecovery, getSubmissionReceipt, observeRuntime,
      detachedPromptAutoSkipMs: 30 * 60_000,
      recoverProjectedBridgeTurn: vi.fn(() => ({ outcome: "turn_owned_by_other_prompt" as const }))
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));

    expect(getSubmissionReceipt).not.toHaveBeenCalled();
    expect(observeRuntime).toHaveBeenCalledOnce();
    expect(advanceDetachedPromptRecovery).toHaveBeenCalledOnce();
    expect(schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    await workflow.stop();
  });

  it("wakes delivery after exact projected Core evidence settles a detached Prompt", async () => {
    const wakeRecoveredPromptDelivery = vi.fn();
    const { workflow } = detachedAutoSkipWorkflow({
      advanceDetachedPromptRecovery: vi.fn(), getSubmissionReceipt: vi.fn(), observeRuntime: vi.fn(),
      detachedPromptAutoSkipMs: 30 * 60_000,
      recoverProjectedBridgeTurn: vi.fn(() => ({
        outcome: "recovered" as const, terminalState: "completed" as const, answer: "historical answer",
        turnId: "turn-1", recoveryMode: "late" as const, outboxReserved: true,
        completionActionEligibility: { outcome: "skipped" as const, reason: "historical-recovery" as const }
      })),
      wakeRecoveredPromptDelivery
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));

    expect(wakeRecoveredPromptDelivery).toHaveBeenCalledWith("p1");
    await workflow.stop();
  });

  it("stops detached observation and wakes durable delivery when projected Core evidence needs human", async () => {
    const wakeRecoveredPromptDelivery = vi.fn();
    const getSubmissionReceipt = vi.fn();
    const outboundWake = vi.fn();
    const { workflow } = detachedAutoSkipWorkflow({
      advanceDetachedPromptRecovery: vi.fn(), getSubmissionReceipt, observeRuntime: vi.fn(),
      detachedPromptAutoSkipMs: 30 * 60_000,
      recoverProjectedBridgeTurn: vi.fn(() => ({ outcome: "needs_human" as const, outboxReserved: true })),
      wakeRecoveredPromptDelivery, outboundWake
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));

    expect(getSubmissionReceipt).not.toHaveBeenCalled();
    expect(outboundWake).toHaveBeenCalledOnce();
    expect(wakeRecoveredPromptDelivery).toHaveBeenCalledWith("p1");
    await workflow.stop();
  });

  it("records a qualifying recovery observation while keeping ordinary FIFO runnable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T00:10:00.000Z"));
    const advanceDetachedPromptRecovery = vi.fn(() => ({
      outcome: "observed" as const, attemptCount: 1, nextAttemptAt: "2026-09-30T00:10:30.000Z"
    }));
    const getSubmissionReceipt = vi.fn(async () => ({
      submissionId: "p1", state: "legacy_unavailable" as const,
      agentKind: "traex" as const, sessionId: "session-1"
    }));
    const observeRuntime = vi.fn(async () => ({
      pane: {
        paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"],
        agentState: "idle" as const,
        agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
      },
      traexProcess: true, composerReady: true, evidenceSource: "structured" as const
    }));
    const { workflow, schedulerWake, outboundWake } = detachedAutoSkipWorkflow({
      advanceDetachedPromptRecovery, getSubmissionReceipt, observeRuntime, detachedPromptAutoSkipMs: 30 * 60_000
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));

    expect(advanceDetachedPromptRecovery).toHaveBeenCalledWith(expect.objectContaining({ promptId: "p1" }));
    const recoveryInput = advanceDetachedPromptRecovery.mock.calls[0]![0];
    expect(Date.parse(recoveryInput.occurredAt) - Date.parse(recoveryInput.expiredBefore)).toBe(30 * 60_000);
    expect(schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    expect(outboundWake).not.toHaveBeenCalled();
    await workflow.stop();
  });

  it.each([
    {
      name: "Core receipt is not yet available",
      receipt: null,
      runtimeState: "idle",
      runtimeSession: "session-1",
      timeoutMs: 30 * 60_000,
      expectsRuntimeRead: true,
      expectsRecoveryAdvance: true
    },
    {
      name: "Core receipt is still prepared",
      receipt: { submissionId: "p1", state: "prepared", agentKind: "traex", sessionId: "session-1" },
      runtimeState: "idle",
      runtimeSession: "session-1",
      timeoutMs: 30 * 60_000,
      expectsRuntimeRead: true,
      expectsRecoveryAdvance: true
    },
    {
      name: "the exact pane is blocked",
      receipt: { submissionId: "p1", state: "legacy_unavailable", agentKind: "traex", sessionId: "session-1" },
      runtimeState: "blocked",
      runtimeSession: "session-1",
      timeoutMs: 30 * 60_000,
      expectsRuntimeRead: true,
      expectsRecoveryAdvance: false
    },
    {
      name: "the native session changed",
      receipt: { submissionId: "p1", state: "legacy_unavailable", agentKind: "traex", sessionId: "session-1" },
      runtimeState: "idle",
      runtimeSession: "session-2",
      timeoutMs: 30 * 60_000,
      expectsRuntimeRead: true,
      expectsRecoveryAdvance: false
    },
    {
      name: "automatic skipping is disabled",
      receipt: { submissionId: "p1", state: "legacy_unavailable", agentKind: "traex", sessionId: "session-1" },
      runtimeState: "idle",
      runtimeSession: "session-1",
      timeoutMs: 0,
      expectsRuntimeRead: false,
      expectsRecoveryAdvance: false
    }
  ])("bounds recovery safely when $name", async ({ receipt, runtimeState, runtimeSession, timeoutMs, expectsRuntimeRead, expectsRecoveryAdvance }) => {
    const advanceDetachedPromptRecovery = vi.fn();
    const getSubmissionReceipt = vi.fn(async () => receipt as never);
    const observeRuntime = vi.fn(async () => ({
      pane: {
        paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"],
        agentState: runtimeState,
        agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: runtimeSession }
      },
      traexProcess: true, composerReady: true, evidenceSource: "structured"
    }));
    const { workflow, schedulerWake, outboundWake } = detachedAutoSkipWorkflow({
      advanceDetachedPromptRecovery, getSubmissionReceipt, observeRuntime, detachedPromptAutoSkipMs: timeoutMs
    });

    workflow.wake({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p1" });
    await vi.waitFor(() => expect(workflow.snapshot().activeTurnWorkers).toBe(0));

    expect(observeRuntime).toHaveBeenCalledTimes(expectsRuntimeRead ? 1 : 0);
    expect(advanceDetachedPromptRecovery).toHaveBeenCalledTimes(expectsRecoveryAdvance ? 1 : 0);
    expect(schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    expect(outboundWake).not.toHaveBeenCalled();
    await workflow.stop();
  });

  it("atomically skips one detached prompt before waking its FIFO and outbound delivery", () => {
    const schedulerWake = vi.fn();
    const outboundWake = vi.fn();
    const safetyScan = vi.fn(() => ({
      cancelled: 0, failedDetached: 0,
      hints: [{ kind: "detached-observer-ready" as const, bindingId: "b1", promptId: "p2" }]
    }));
    const skipOldestDetachedPrompt = vi.fn(() => ({ outcome: "skipped" as const, promptId: "p1", outboxReserved: true }));
    const workflow = new PromptRunWorkflow({
      stores: promptStores({ skipOldestDetachedPrompt, scanDurablePromptWork: safetyScan }),
      scheduler: { subscribe: () => () => {}, wake: schedulerWake },
      turnTimeoutMs: 1_000, herdr: {} as never, bus: { async publish() {} },
      outboundWork: { wake: outboundWake, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    expect(workflow.skipDetached("b1", 4, "creator", "skip-message", "root")).toEqual({ outcome: "skipped", promptId: "p1", outboxReserved: true });
    expect(skipOldestDetachedPrompt).toHaveBeenCalledWith(expect.objectContaining({
      bindingId: "b1", expectedBindingGeneration: 4, actorOpenId: "creator", sourceMessageId: "skip-message", rootMessageId: "root",
      reason: "人工跳过；此前执行结果不确定，任务不会自动重放。", renderRunCard: expect.any(Function)
    }));
    expect(schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    expect(schedulerWake).toHaveBeenCalledWith({ kind: "detached-observer-ready", bindingId: "b1", promptId: "p2" });
    expect(outboundWake).toHaveBeenCalledOnce();
    expect(safetyScan).toHaveBeenCalledOnce();
  });

  it("does not wake work when detached skip is stale or finds nothing", () => {
    const schedulerWake = vi.fn();
    const outboundWake = vi.fn();
    const skipOldestDetachedPrompt = vi.fn(() => ({ outcome: "none" as const }));
    const workflow = new PromptRunWorkflow({
      stores: promptStores({ skipOldestDetachedPrompt }), scheduler: { subscribe: () => () => {}, wake: schedulerWake },
      turnTimeoutMs: 1_000, herdr: {} as never, bus: { async publish() {} }, outboundWork: { wake: outboundWake, subscribe() { return () => {}; } },
      presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
    });

    expect(workflow.skipDetached("b1", 1, "creator", "skip-message", "root")).toEqual({ outcome: "none" });
    expect(schedulerWake).not.toHaveBeenCalled();
    expect(outboundWake).not.toHaveBeenCalled();
  });
});

function createWorkflow(storeOverrides: Record<string, unknown>, safetyScanIntervalMs: number, error = vi.fn(), info = vi.fn(), supervisedSafetyScan = false): PromptRunWorkflow {
  const scheduler = new InProcessPromptWorkScheduler();
  const store = { scanDurablePromptWork: () => ({ cancelled: 0, failedDetached: 0, hints: [] }), claimNextDispatchablePrompt: () => null, releaseUndispatchedPromptClaim: () => false, ...storeOverrides };
  return new PromptRunWorkflow({
    stores: promptStores(store), scheduler, safetyScanIntervalMs, supervisedSafetyScan, turnTimeoutMs: 1_000,
    herdr: {} as never, bus: { async publish() {} }, outboundWork: { wake() {}, subscribe() { return () => {}; } },
    presentation: primaryPresentation, bindingPrompts: testBindingPrompts(), logger: { info, warn: vi.fn(), error } as never
  });
}

function promptStores(store: Record<string, unknown>) {
  const compatible = {
    releaseUndispatchedPromptClaim: () => false,
    listStaleUndispatchedPromptClaims: () => [],
    scanDurablePromptWork: () => ({ cancelled: 0, failedDetached: 0, hints: [] }),
    ...store
  };
  return { dispatch: compatible, recovery: compatible, session: compatible } as never;
}

function testBindingPrompts() {
  return {
    applyCoreObservation: vi.fn(async () => ({ outcome: "ignored" as const, owned: false as const, terminal: null, prompt: null })),
    drainDueNativeInputBatch: vi.fn(async () => ({ outcome: "none" as const, nextDueAt: null }))
  };
}

function detachedAutoSkipWorkflow(input: {
  advanceDetachedPromptRecovery: ReturnType<typeof vi.fn>;
  getSubmissionReceipt: ReturnType<typeof vi.fn>;
  getNativeSubmissionReceipt?: ReturnType<typeof vi.fn>;
  markPromptNativeQueued?: ReturnType<typeof vi.fn>;
  applyPromptNativeSubmissionReceipt?: ReturnType<typeof vi.fn>;
  releaseRejectedNativeSubmission?: ReturnType<typeof vi.fn>;
  observeRuntime: ReturnType<typeof vi.fn>;
  detachedPromptAutoSkipMs: number;
  recoverProjectedBridgeTurn?: ReturnType<typeof vi.fn>;
  wakeRecoveredPromptDelivery?: ReturnType<typeof vi.fn>;
  schedulerWake?: ReturnType<typeof vi.fn>;
  outboundWake?: ReturnType<typeof vi.fn>;
}) {
  const schedulerWake = input.schedulerWake ?? vi.fn();
  const outboundWake = input.outboundWake ?? vi.fn();
  const safetyScan = vi.fn(() => ({ cancelled: 0, failedDetached: 0, hints: [] }));
  const prompt = {
    id: "p1", bindingId: "b1", body: "private", state: "recovering", observationState: "detached",
    nativeSubmissionId: "p1", transcriptTurnId: null, transcriptTurnStartedAt: null,
    dispatchedAt: "2026-09-30T00:00:00.000Z", createdAt: "2026-09-30T00:00:00.000Z"
  };
  const binding = {
    id: "b1", generation: 3, paneId: "w1:p1", workspaceId: "w1", agentKind: "traex",
    state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle",
    agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
  };
  const workflow = new PromptRunWorkflow({
    stores: promptStores({
      getPrompt: vi.fn(() => prompt), getBinding: vi.fn(() => binding),
      advanceDetachedPromptRecovery: input.advanceDetachedPromptRecovery,
      recoverProjectedBridgeTurn: input.recoverProjectedBridgeTurn,
      markPromptNativeQueued: input.markPromptNativeQueued,
      applyPromptNativeSubmissionReceipt: input.applyPromptNativeSubmissionReceipt,
      releaseRejectedNativeSubmission: input.releaseRejectedNativeSubmission,
      markPromptObservationDetached: vi.fn(),
      scanDurablePromptWork: safetyScan,
      listStaleUndispatchedPromptClaims: vi.fn(() => [])
    }),
    scheduler: { subscribe: () => () => {}, wake: schedulerWake },
    detachedPromptAutoSkipMs: input.detachedPromptAutoSkipMs,
    ...(input.wakeRecoveredPromptDelivery ? { onRecoveredPromptSettled: input.wakeRecoveredPromptDelivery } : {}),
    turnTimeoutMs: 1_000,
    transcriptReader: {
      getSubmissionReceipt: input.getSubmissionReceipt,
      ...(input.getNativeSubmissionReceipt ? { getNativeSubmissionReceipt: input.getNativeSubmissionReceipt } : {}),
      async open() { return { mode: "unavailable" as const, reason: "transcript_not_found" as const }; }
    },
    herdr: { observeRuntime: input.observeRuntime } as never,
    bus: { async publish() {} },
    outboundWork: { wake: outboundWake, subscribe() { return () => {}; } },
    presentation: primaryPresentation,
    bindingPrompts: testBindingPrompts(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never
  });
  return { workflow, schedulerWake, outboundWake, safetyScan };
}
