import { describe, expect, it, vi } from "vitest";
import type { HerdrPort } from "../src/domain/ports.js";
import { WorkspaceSnapshotCache } from "../src/runtime/workspace-snapshot-cache.js";

describe("workspace snapshot cache", () => {
  it("reuses snapshots for two seconds and force-refreshes mutations", async () => {
    let now = 0;
    let version = 0;
    const listPanes = vi.fn(async (workspaceId: string) => [pane(workspaceId, ++version)]);
    const cache = new WorkspaceSnapshotCache(adapter({ listPanes }), 2_000, undefined, () => now);

    expect((await cache.listPanes("w1"))[0]?.label).toBe("v1");
    now = 1_999;
    expect((await cache.listPanes("w1"))[0]?.label).toBe("v1");
    expect((await cache.listPanes("w1", { forceRefresh: true }))[0]?.label).toBe("v2");
    now = 4_000;
    expect((await cache.listPanes("w1"))[0]?.label).toBe("v3");
    expect(cache.status()).toMatchObject({ hits: 1, misses: 3, entries: 1, refreshFailures: 0 });
  });

  it("coalesces concurrent refreshes and returns defensive copies", async () => {
    let release!: (value: ReturnType<typeof pane>[]) => void;
    const listPanes = vi.fn(() => new Promise<ReturnType<typeof pane>[]>((resolve) => { release = resolve; }));
    const cache = new WorkspaceSnapshotCache(adapter({ listPanes }));
    const first = cache.listPanes("w1");
    const second = cache.listPanes("w1");
    release([pane("w1", 1)]);
    const [a, b] = await Promise.all([first, second]);
    a[0]!.label = "mutated";
    expect(b[0]!.label).toBe("v1");
    expect(listPanes).toHaveBeenCalledOnce();
    expect(cache.status().coalescedRefreshes).toBe(1);
  });

  it("does not extend a snapshot after refresh failure and invalidates after create and rename", async () => {
    let calls = 0;
    const listPanes = vi.fn(async () => { if (++calls === 2) throw new Error("offline"); return [pane("w1", calls)]; });
    const delegate = adapter({ listPanes });
    const cache = new WorkspaceSnapshotCache(delegate, 2_000);
    await cache.listPanes("w1");
    await expect(cache.listPanes("w1", { forceRefresh: true })).rejects.toThrow("offline");
    expect(cache.status().refreshFailures).toBe(1);
    await cache.createPane("w1", "/repo");
    expect(cache.status().entries).toBe(0);
    await cache.listPanes("w1");
    await cache.renamePane("w1:p1", "new");
    expect(cache.status().entries).toBe(0);
  });

  it("signals that callers must use workspace fallback when the delegate has no all-pane snapshot", async () => {
    const cache = new WorkspaceSnapshotCache(adapter({ async listPanes(workspaceId) { return [pane(workspaceId, 1)]; } }));

    await expect(cache.listAllPanes()).rejects.toThrow(/does not support an all-workspace snapshot/);
  });

  it("forwards runtime observation and updates the cached pane without refreshing the workspace", async () => {
    const unknown = { ...pane("w1", 1), agentState: "unknown" as const, foregroundExecutables: [] };
    const observed = { ...unknown, agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const listPanes = vi.fn(async () => [unknown]);
    const observation = { pane: observed, state: "idle" as const, traexProcess: true, composerReady: true, evidenceSource: "visible" as const };
    const observeRuntime = vi.fn(async () => observation);
    const cache = new WorkspaceSnapshotCache(adapter({ listPanes, observeRuntime }));

    expect((await cache.listPanes("w1"))[0]?.agentState).toBe("unknown");
    expect(await cache.observeRuntime("w1:p1")).toEqual(observation);
    expect((await cache.listPanes("w1"))[0]).toEqual(observed);
    expect(observeRuntime).toHaveBeenCalledWith("w1:p1");
    expect(listPanes).toHaveBeenCalledOnce();
  });

  it("preserves pane evidence when runtime observation is unsupported", async () => {
    const getPane = vi.fn(async () => pane("w1", 1));
    const cache = new WorkspaceSnapshotCache(adapter({ getPane }));

    expect(await cache.observeRuntime("w1:p1")).toEqual({
      pane: pane("w1", 1), state: "idle", traexProcess: true, composerReady: false, evidenceSource: "structured"
    });
    expect(getPane).toHaveBeenCalledWith("w1:p1");
  });

  it("preserves validation semantics and forwards pane close while invalidating the snapshot", async () => {
    const assertWorkspace = vi.fn(async () => { throw new Error("workspace missing"); });
    const closePane = vi.fn(async () => undefined);
    const listPanes = vi.fn(async (workspaceId: string) => [pane(workspaceId, 1)]);
    const cache = new WorkspaceSnapshotCache(adapter({ assertWorkspace, closePane, listPanes }));

    await cache.listPanes("w1");
    await expect(cache.assertWorkspace("w1")).rejects.toThrow("workspace missing");
    await cache.closePane("w1:p1");

    expect(assertWorkspace).toHaveBeenCalledWith("w1");
    expect(closePane).toHaveBeenCalledWith("w1:p1");
    expect(cache.status().entries).toBe(0);
  });
});

function pane(workspaceId: string, version: number) {
  return { paneId: `${workspaceId}:p1`, workspaceId, cwd: "/repo", label: `v${version}`, agentState: "idle" as const, foregroundExecutables: ["traex"] };
}
function adapter(overrides: Partial<HerdrPort>): HerdrPort {
  return {
    async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
    async createPane(workspaceId) { return pane(workspaceId, 99); }, async startTraex() {}, async runPrompt() { return "done"; },
    async readOutput() { return ""; }, async renamePane() {}, ...overrides
  };
}
