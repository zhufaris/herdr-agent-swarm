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

  it("does not publish or coalesce onto a workspace refresh invalidated while in flight", async () => {
    const releases: Array<(panes: ReturnType<typeof pane>[]) => void> = [];
    const listPanes = vi.fn(() => new Promise<ReturnType<typeof pane>[]>((resolve) => { releases.push(resolve); }));
    const cache = new WorkspaceSnapshotCache(adapter({ listPanes }));

    const stale = cache.listPanes("w1");
    expect(listPanes).toHaveBeenCalledOnce();
    cache.invalidate("w1");
    const current = cache.listPanes("w1");
    expect(listPanes).toHaveBeenCalledTimes(2);

    releases[0]!([pane("w1", 1)]);
    expect((await stale)[0]?.label).toBe("v1");
    expect(cache.status().entries).toBe(0);
    const coalescedCurrent = cache.listPanes("w1");
    expect(listPanes).toHaveBeenCalledTimes(2);

    releases[1]!([pane("w1", 2)]);
    expect((await current)[0]?.label).toBe("v2");
    expect((await coalescedCurrent)[0]?.label).toBe("v2");
    expect((await cache.listPanes("w1"))[0]?.label).toBe("v2");
    expect(listPanes).toHaveBeenCalledTimes(2);
  });

  it("serves concurrent workspace cache misses from one all-workspace snapshot", async () => {
    const listAllPanes = vi.fn(async () => [pane("w1", 1), pane("w2", 2)]);
    const listPanes = vi.fn(async (workspaceId: string) => [pane(workspaceId, 99)]);
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes, listPanes }));

    const [w1, w2] = await Promise.all([cache.listPanes("w1"), cache.listPanes("w2")]);

    expect(w1[0]?.label).toBe("v1");
    expect(w2[0]?.label).toBe("v2");
    expect(listAllPanes).toHaveBeenCalledOnce();
    expect(listPanes).not.toHaveBeenCalled();
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

  it("invalidates mutations through the observed workspace identity instead of parsing the Pane ID", async () => {
    const unstructuredPane = { ...pane("workspace-alpha", 1), paneId: "opaque-pane-id" };
    const listPanes = vi.fn(async () => [unstructuredPane]);
    const delegate = adapter({ listPanes, async closePane() {} });
    const cache = new WorkspaceSnapshotCache(delegate);

    await cache.listPanes("workspace-alpha");
    expect(cache.status().entries).toBe(1);
    await cache.renamePane("opaque-pane-id", "renamed");
    expect(cache.status().entries).toBe(0);

    await cache.listPanes("workspace-alpha");
    expect(cache.status().entries).toBe(1);
    await cache.closePane("opaque-pane-id");
    expect(cache.status().entries).toBe(0);
  });

  it("invalidates all snapshots when a successful mutation has no observed workspace identity", async () => {
    const cache = new WorkspaceSnapshotCache(adapter({
      async listPanes(workspaceId) { return [pane(workspaceId, 1)]; }
    }));

    await cache.listPanes("w1");
    await cache.listPanes("w2");
    expect(cache.status().entries).toBe(2);

    await cache.renamePane("never-observed-pane", "renamed");
    expect(cache.status().entries).toBe(0);
  });

  it("forgets panes that disappear from a refreshed workspace snapshot", async () => {
    let workspaceOnePanes = [{ ...pane("w1", 1), paneId: "removed-pane" }];
    const cache = new WorkspaceSnapshotCache(adapter({
      async listPanes(workspaceId) { return workspaceId === "w1" ? workspaceOnePanes : [pane(workspaceId, 1)]; }
    }));

    await cache.listPanes("w1");
    await cache.listPanes("w2");
    workspaceOnePanes = [];
    await cache.listPanes("w1", { forceRefresh: true });
    expect(cache.status().entries).toBe(2);

    await cache.renamePane("removed-pane", "renamed");
    expect(cache.status().entries).toBe(0);
  });

  it("invalidates only known pane workspaces and clears all snapshots for an unknown pane", async () => {
    const cache = new WorkspaceSnapshotCache(adapter({
      async listPanes(workspaceId) { return [pane(workspaceId, 1)]; }
    }));

    await cache.listPanes("w1");
    await cache.listPanes("w2");
    cache.invalidatePanes(["w1:p1"]);
    expect(cache.status().entries).toBe(1);
    expect((await cache.listPanes("w2"))[0]?.label).toBe("v1");

    cache.invalidatePanes(["unknown-pane"]);
    expect(cache.status().entries).toBe(0);
  });

  it("signals that callers must use workspace fallback when the delegate has no all-pane snapshot", async () => {
    const cache = new WorkspaceSnapshotCache(adapter({ async listPanes(workspaceId) { return [pane(workspaceId, 1)]; } }));

    await expect(cache.listAllPanes()).rejects.toThrow(/does not support an all-workspace snapshot/);
  });

  it("coalesces and caches all-workspace snapshots until the TTL expires or a workspace is invalidated", async () => {
    let now = 0;
    let release!: (panes: ReturnType<typeof pane>[]) => void;
    const listAllPanes = vi.fn(() => new Promise<ReturnType<typeof pane>[]>((resolve) => { release = resolve; }));
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes }), 2_000, undefined, () => now);

    const first = cache.listAllPanes();
    const second = cache.listAllPanes();
    release([pane("w1", 1)]);
    const [a, b] = await Promise.all([first, second]);
    a[0]!.label = "mutated";
    expect(b[0]!.label).toBe("v1");
    expect((await cache.listAllPanes())[0]?.label).toBe("v1");
    expect(listAllPanes).toHaveBeenCalledOnce();
    cache.invalidate("w1");
    listAllPanes.mockResolvedValueOnce([pane("w1", 2)]);
    expect((await cache.listAllPanes())[0]?.label).toBe("v2");
    now = 2_001;
    listAllPanes.mockResolvedValueOnce([pane("w1", 3)]);
    expect((await cache.listAllPanes())[0]?.label).toBe("v3");
    expect(listAllPanes).toHaveBeenCalledTimes(3);
  });

  it("does not publish or coalesce onto an all-workspace refresh invalidated while in flight", async () => {
    const releases: Array<(panes: ReturnType<typeof pane>[]) => void> = [];
    const listAllPanes = vi.fn(() => new Promise<ReturnType<typeof pane>[]>((resolve) => { releases.push(resolve); }));
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes }));

    const stale = cache.listAllPanes();
    expect(listAllPanes).toHaveBeenCalledOnce();
    cache.invalidate("w1");
    const current = cache.listAllPanes();
    expect(listAllPanes).toHaveBeenCalledTimes(2);

    releases[0]!([pane("w1", 1)]);
    expect((await stale)[0]?.label).toBe("v1");
    expect(cache.status().entries).toBe(0);
    const coalescedCurrent = cache.listAllPanes();
    expect(listAllPanes).toHaveBeenCalledTimes(2);

    releases[1]!([pane("w1", 2), pane("w2", 3)]);
    expect((await current).map((item) => item.label)).toEqual(["v2", "v3"]);
    expect((await coalescedCurrent).map((item) => item.label)).toEqual(["v2", "v3"]);
    expect((await cache.listAllPanes()).map((item) => item.label)).toEqual(["v2", "v3"]);
    expect(listAllPanes).toHaveBeenCalledTimes(2);
  });

  it("forwards runtime observation and updates the cached pane without refreshing the workspace", async () => {
    const unknown = { ...pane("w1", 1), agentState: "unknown" as const, foregroundExecutables: [] };
    const observed = { ...unknown, agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const listPanes = vi.fn(async () => [unknown]);
    const observation = { pane: observed, traexProcess: true, composerReady: false, evidenceSource: "process" as const };
    const observeRuntime = vi.fn(async () => observation);
    const cache = new WorkspaceSnapshotCache(adapter({ listPanes, observeRuntime }));

    const initial = await cache.listPanes("w1");
    expect(initial[0]?.agentState).toBe("unknown");
    expect(await cache.observeRuntime("w1:p1")).toEqual(observation);
    expect(initial[0]?.agentState).toBe("unknown");
    expect((await cache.listPanes("w1"))[0]).toEqual(observed);
    expect(observeRuntime).toHaveBeenCalledWith("w1:p1");
    expect(listPanes).toHaveBeenCalledOnce();
  });

  it("returns an explicit missing observation from the runtime observer", async () => {
    const observeRuntime = vi.fn(async () => ({ pane: null, traexProcess: false, composerReady: false, evidenceSource: "none" as const }));
    const cache = new WorkspaceSnapshotCache(adapter({ observeRuntime }));

    expect(await cache.observeRuntime("w1:p1")).toEqual({ pane: null, traexProcess: false, composerReady: false, evidenceSource: "none" });
    expect(observeRuntime).toHaveBeenCalledWith("w1:p1");
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
    async observeRuntime() { return { pane: null, traexProcess: false, composerReady: false, evidenceSource: "none" }; },
    async createPane(workspaceId) { return pane(workspaceId, 99); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {}, ...overrides
  };
}
