import { afterEach, describe, expect, it, vi } from "vitest";
import { PriorityReconciliationRunner, type PriorityReconciliationScope } from "../src/runtime/priority-reconciliation-runner.js";

describe("PriorityReconciliationRunner", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("runs pane work before pending workspace and full work without concurrent executors", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const scopes: PriorityReconciliationScope[] = [];
    let active = 0;
    let peak = 0;
    const execute = vi.fn(async (scope: PriorityReconciliationScope) => {
      scopes.push(scope);
      active += 1;
      peak = Math.max(peak, active);
      if (scopes.length === 1) await blocked;
      active -= 1;
    });
    const runner = new PriorityReconciliationRunner({ execute });

    const first = runner.request({ kind: "all" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const workspace = runner.request({ kind: "workspaces", ids: ["w1"] });
    const full = runner.request({ kind: "all" });
    const pane = runner.request({ kind: "panes", ids: ["w1:p1"] });
    release();
    await Promise.all([first, workspace, full, pane]);

    expect(scopes).toEqual([
      { kind: "all" },
      { kind: "panes", ids: ["w1:p1"] },
      { kind: "workspaces", ids: ["w1"] },
      { kind: "all" }
    ]);
    expect(peak).toBe(1);
    expect(runner.snapshot()).toMatchObject({ state: "idle", activeScopeKind: null, pendingPaneCount: 0, pendingWorkspaceCount: 0, fullPending: false, priorityPromotionCount: 2 });
  });

  it("coalesces duplicate identifiers into one pending pass and settles every requester", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const scopes: PriorityReconciliationScope[] = [];
    const runner = new PriorityReconciliationRunner({ execute: async (scope) => { scopes.push(scope); if (scopes.length === 1) await blocked; } });

    const active = runner.request({ kind: "all" });
    const first = runner.request({ kind: "panes", ids: ["p1", "p1"] });
    const second = runner.request({ kind: "panes", ids: ["p2", "p1"] });
    release();
    await Promise.all([active, first, second]);

    expect(scopes).toEqual([{ kind: "all" }, { kind: "panes", ids: ["p1", "p2"] }]);
    expect(runner.snapshot().coalescedRequestCount).toBe(2);
  });

  it("rejects only the failed batch and continues with later pending work", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const scopes: PriorityReconciliationScope[] = [];
    const runner = new PriorityReconciliationRunner({ execute: async (scope) => {
      scopes.push(scope);
      if (scope.kind === "all") await blocked;
      if (scope.kind === "panes") throw new Error("pane failed");
    } });

    const active = runner.request({ kind: "all" });
    const failed = runner.request({ kind: "panes", ids: ["p1"] });
    const later = runner.request({ kind: "workspaces", ids: ["w1"] });
    release();

    await expect(failed).rejects.toThrow("pane failed");
    await expect(Promise.all([active, later])).resolves.toBeDefined();
    expect(scopes).toEqual([{ kind: "all" }, { kind: "panes", ids: ["p1"] }, { kind: "workspaces", ids: ["w1"] }]);
    expect(runner.snapshot()).toMatchObject({ state: "idle", runCount: 3, successCount: 2, failureCount: 1, lastOutcome: "succeeded" });
  });

  it("stops accepting work, discards pending hints, and waits for the active pass", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => { await blocked; });
    const runner = new PriorityReconciliationRunner({ execute });

    const active = runner.request({ kind: "all" });
    const queued = runner.request({ kind: "panes", ids: ["p1"] });
    const stopping = runner.stop();
    expect(runner.snapshot()).toMatchObject({ state: "stopping", pendingPaneCount: 0 });
    await expect(queued).resolves.toBeUndefined();
    await expect(runner.request({ kind: "workspaces", ids: ["w1"] })).resolves.toBeUndefined();
    release();
    await Promise.all([active, stopping]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("requests periodic full reconciliation and reports bounded queue delay diagnostics", async () => {
    vi.useFakeTimers();
    let now = 10;
    const execute = vi.fn(async () => { now = 25; });
    const runner = new PriorityReconciliationRunner({ execute, clock: () => now });
    runner.start(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith({ kind: "all" }));
    expect(runner.snapshot()).toMatchObject({ lastAcceptedToStartMs: { panes: null, workspaces: null, all: 0 }, maxAcceptedToStartMs: { panes: null, workspaces: null, all: 0 } });
    await runner.stop();
  });
});
