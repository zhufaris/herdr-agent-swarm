import { describe, expect, it, vi } from "vitest";
import type { HerdrPort } from "../src/domain/ports.js";
import { WorkspaceSnapshotCache } from "../src/runtime/workspace-snapshot-cache.js";

describe("workspace snapshot cache", () => {
  it("publishes one cold semantic generation and keeps idle reads current without TTL scans", async () => {
    const panes = [pane("w1", 1)];
    const listAllPanes = vi.fn(async () => panes);
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes }), 1);

    const cold = await cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1"] });
    expect(cold).toMatchObject({ kind: "rebuild-required", cursor: { epoch: 0, generation: 1 }, panes });
    expect(await cache.readSemanticSnapshot({ cursor: cold.cursor, workspaceIds: ["w1"] })).toEqual({ kind: "current", cursor: cold.cursor });
    expect(listAllPanes).toHaveBeenCalledOnce();
  });

  it("publishes one immutable Pane delta to independent consumers", async () => {
    let panes = [pane("w1", 1)];
    const listAllPanes = vi.fn(async () => panes);
    const listPanes = vi.fn(async (workspaceId: string) => panes.filter((candidate) => candidate.workspaceId === workspaceId));
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes, listPanes }));
    const cold = await cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1"] });
    if (cold.kind !== "rebuild-required") throw new Error("expected cold rebuild");
    panes = [{ ...pane("w1", 2), agentState: "working" as const }];
    cache.invalidatePanes(["w1:p1"]);

    const bindingRead = await cache.readSemanticSnapshot({ cursor: cold.cursor, workspaceIds: ["w1"] });
    const workerRead = await cache.readSemanticSnapshot({ cursor: cold.cursor, workspaceIds: ["w1"] });

    expect(bindingRead).toMatchObject({ kind: "delta", cursor: { epoch: 0, generation: 2 }, added: [], changed: panes, removed: [] });
    expect(workerRead).toEqual(bindingRead);
    expect(listAllPanes).toHaveBeenCalledOnce();
    expect(listPanes).toHaveBeenCalledOnce();
    expect(cache.canAcknowledgeSemanticGeneration(bindingRead.cursor)).toBe(true);
  });

  it("refreshes only invalidated workspaces and excludes unrelated simultaneous changes", async () => {
    let panes = [pane("w1", 1), pane("w2", 1)];
    const listAllPanes = vi.fn(async () => panes);
    const listPanes = vi.fn(async (workspaceId: string) => panes.filter((candidate) => candidate.workspaceId === workspaceId));
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes, listPanes }));
    const cold = await cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1", "w2"] });
    if (cold.kind !== "rebuild-required") throw new Error("expected cold rebuild");
    panes = [{ ...pane("w1", 2), paneId: "w1:p2" }, { ...pane("w2", 2), agentState: "working" }];
    cache.invalidate("w1");

    expect(await cache.readSemanticSnapshot({ cursor: cold.cursor, workspaceIds: ["w1", "w2"] })).toMatchObject({
      kind: "delta",
      added: [{ paneId: "w1:p2", workspaceId: "w1" }],
      changed: [],
      removed: [{ paneId: "w1:p1", workspaceId: "w1" }]
    });
    expect(listAllPanes).toHaveBeenCalledOnce();
    expect(listPanes).toHaveBeenCalledOnce();
    expect(listPanes).toHaveBeenCalledWith("w1", { forceRefresh: true, skipAllWorkspaceSnapshot: true });
  });

  it("uses a bounded authoritative watchdog refresh when an invalidation hint is lost", async () => {
    let now = 0;
    let panes = [pane("w1", 1)];
    const listAllPanes = vi.fn(async () => panes);
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes }), 2_000, undefined, () => now);
    const cold = await cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1"] });
    if (cold.kind !== "rebuild-required") throw new Error("expected cold rebuild");

    panes = [{ ...pane("w1", 2), agentState: "working" }];
    now = 60_000;

    expect(await cache.readSemanticSnapshot({ cursor: cold.cursor, workspaceIds: ["w1"] })).toMatchObject({
      kind: "delta", changed: [{ paneId: "w1:p1", agentState: "working" }]
    });
    expect(listAllPanes).toHaveBeenCalledTimes(2);
  });

  it("does not let targeted refreshes postpone the lost-hint watchdog", async () => {
    let now = 0;
    let panes = [pane("w1", 1), pane("w2", 1)];
    const listAllPanes = vi.fn(async () => panes);
    const listPanes = vi.fn(async (workspaceId: string) => panes.filter((candidate) => candidate.workspaceId === workspaceId));
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes, listPanes }), 2_000, undefined, () => now);
    const cold = await cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1", "w2"] });
    if (cold.kind !== "rebuild-required") throw new Error("expected cold rebuild");

    now = 59_000;
    panes = [pane("w1", 2), pane("w2", 1)];
    cache.invalidate("w1");
    const targeted = await cache.readSemanticSnapshot({ cursor: cold.cursor, workspaceIds: ["w1", "w2"] });
    expect(targeted).toMatchObject({ kind: "delta", changed: [{ paneId: "w1:p1", label: "v2" }] });

    now = 60_000;
    panes = [pane("w1", 2), { ...pane("w2", 2), agentState: "working" }];
    expect(await cache.readSemanticSnapshot({ cursor: targeted.cursor, workspaceIds: ["w1", "w2"] })).toMatchObject({
      kind: "delta", changed: [{ paneId: "w2:p1", agentState: "working" }]
    });
    expect(listAllPanes).toHaveBeenCalledTimes(2);
    expect(listPanes).toHaveBeenCalledOnce();
  });

  it("keeps semantic generation stable when invalidated evidence is equal", async () => {
    const panes = [pane("w1", 1)];
    const listAllPanes = vi.fn(async () => panes);
    const listPanes = vi.fn(async (workspaceId: string) => panes.filter((candidate) => candidate.workspaceId === workspaceId));
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes, listPanes }));
    const cold = await cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1"] });
    cache.invalidate("w1");

    expect(await cache.readSemanticSnapshot({ cursor: cold.cursor, workspaceIds: ["w1"] })).toEqual({ kind: "current", cursor: cold.cursor });
    expect(listAllPanes).toHaveBeenCalledOnce();
    expect(listPanes).toHaveBeenCalledOnce();
  });

  it("forces an explicit rebuild after authoritative invalidation and fences stale acknowledgements", async () => {
    const panes = [pane("w1", 1)];
    const cache = new WorkspaceSnapshotCache(adapter({ async listAllPanes() { return panes; } }));
    const cold = await cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1"] });
    cache.invalidateAll();

    expect(cache.canAcknowledgeSemanticGeneration(cold.cursor)).toBe(false);
    const rebuilt = await cache.readSemanticSnapshot({ cursor: cold.cursor, workspaceIds: ["w1"] });
    expect(rebuilt).toMatchObject({ kind: "rebuild-required", cursor: { epoch: 1, generation: 1 }, panes });
    expect(cache.canAcknowledgeSemanticGeneration(rebuilt.cursor)).toBe(true);
  });

  it("invalidates semantic evidence after successful and uncertain topology mutations", async () => {
    let panes = [pane("w1", 1)];
    const movePane = vi.fn(async () => {
      panes = [{ ...pane("w1", 2), paneId: "w1:p2" }];
      return { previousPaneId: "w1:p1", paneId: "w1:p2", paneToken: null, tabId: "w1:t2", workspaceId: "w1" };
    });
    const labelPane = vi.fn(async () => {
      panes = [{ ...panes[0]!, label: "renamed" }];
      throw new Error("label receipt unavailable");
    });
    const cache = new WorkspaceSnapshotCache(adapter({
      async listAllPanes() { return panes; },
      async listPanes(workspaceId) { return panes.filter((candidate) => candidate.workspaceId === workspaceId); },
      movePane, labelPane
    }));
    const cold = await cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1"] });

    await cache.movePane({ paneId: "w1:p1", targetTabId: "w1:t2", targetAnchorPaneId: "w1:p2", paneLabel: "worker", tabLabel: "group" });

    expect(cache.canAcknowledgeSemanticGeneration(cold.cursor)).toBe(false);
    const moved = await cache.readSemanticSnapshot({ cursor: cold.cursor, workspaceIds: ["w1"] });
    expect(moved).toMatchObject({
      kind: "delta", added: [{ paneId: "w1:p2" }], removed: [{ paneId: "w1:p1", workspaceId: "w1" }]
    });

    await expect(cache.labelPane({ workspaceId: "w1", paneId: "w1:p2", tabId: "w1:t2", paneLabel: "renamed", tabLabel: "group" }))
      .rejects.toThrow("label receipt unavailable");

    expect(cache.canAcknowledgeSemanticGeneration(moved.cursor)).toBe(false);
    await expect(cache.readSemanticSnapshot({ cursor: moved.cursor, workspaceIds: ["w1"] }))
      .resolves.toMatchObject({ kind: "delta", changed: [{ paneId: "w1:p2", label: "renamed" }] });
  });

  it("coalesces semantic readers through an invalidation that arrives during refresh", async () => {
    const releases: Array<(panes: ReturnType<typeof pane>[]) => void> = [];
    const listAllPanes = vi.fn(() => new Promise<ReturnType<typeof pane>[]>((resolve) => { releases.push(resolve); }));
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes }));
    const first = cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1"] });
    cache.invalidateAll();
    const second = cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1"] });

    releases[0]!([pane("w1", 1)]);
    await vi.waitFor(() => expect(listAllPanes).toHaveBeenCalledTimes(2));
    releases[1]!([pane("w1", 2)]);

    await expect(first).resolves.toMatchObject({ kind: "rebuild-required", panes: [{ label: "v2" }] });
    await expect(second).resolves.toMatchObject({ kind: "rebuild-required", panes: [{ label: "v2" }] });
  });

  it("returns rebuild-required when a consumer falls behind bounded delta history", async () => {
    let version = 1;
    const cache = new WorkspaceSnapshotCache(adapter({
      async listAllPanes() { return [pane("w1", version)]; },
      async listPanes(workspaceId) { return [pane(workspaceId, version)]; }
    }));
    const cold = await cache.readSemanticSnapshot({ cursor: null, workspaceIds: ["w1"] });
    let cursor = cold.cursor;
    for (let index = 0; index < 33; index += 1) {
      version += 1;
      cache.invalidate("w1");
      cursor = (await cache.readSemanticSnapshot({ cursor, workspaceIds: ["w1"] })).cursor;
    }

    expect(await cache.readSemanticSnapshot({ cursor: cold.cursor, workspaceIds: ["w1"] })).toMatchObject({
      kind: "rebuild-required", cursor: { generation: 34 }, panes: [{ label: "v34" }]
    });
  });

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

  it("reuses a snapshot beyond its TTL inside an explicit startup scope", async () => {
    let now = 0;
    let version = 0;
    const listPanes = vi.fn(async (workspaceId: string) => [pane(workspaceId, ++version)]);
    const cache = new WorkspaceSnapshotCache(adapter({ listPanes }), 2_000, undefined, () => now);

    expect((await cache.listPanes("w1"))[0]?.label).toBe("v1");
    await cache.withStartupSnapshotReuse(async () => {
      expect((await cache.listPanes("w1"))[0]?.label).toBe("v2");
      now = 9_999;
      expect((await cache.listPanes("w1"))[0]?.label).toBe("v2");
    });
    expect((await cache.listPanes("w1"))[0]?.label).toBe("v3");
    expect(listPanes).toHaveBeenCalledTimes(3);
  });

  it("honors mutation invalidation and forced reads inside an extended reuse scope", async () => {
    let version = 0;
    const listPanes = vi.fn(async (workspaceId: string) => [pane(workspaceId, ++version)]);
    const cache = new WorkspaceSnapshotCache(adapter({ listPanes }), 2_000);

    await cache.withStartupSnapshotReuse(async () => {
      expect((await cache.listPanes("w1"))[0]?.label).toBe("v1");
      await cache.renamePane("w1:p1", "renamed");
      expect((await cache.listPanes("w1"))[0]?.label).toBe("v2");
      expect((await cache.listPanes("w1", { forceRefresh: true }))[0]?.label).toBe("v3");
    });
    expect(listPanes).toHaveBeenCalledTimes(3);
  });

  it("bounds startup reuse when topology events are not subscribed yet", async () => {
    let now = 0;
    let version = 0;
    const listPanes = vi.fn(async (workspaceId: string) => [pane(workspaceId, ++version)]);
    const cache = new WorkspaceSnapshotCache(adapter({ listPanes }), 60_000, undefined, () => now);

    await cache.withStartupSnapshotReuse(async () => {
      expect((await cache.listPanes("w1"))[0]?.label).toBe("v1");
      now = 9_999;
      expect((await cache.listPanes("w1"))[0]?.label).toBe("v1");
      now = 10_000;
      expect((await cache.listPanes("w1"))[0]?.label).toBe("v2");
    });
    expect(listPanes).toHaveBeenCalledTimes(2);
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

  it("coalesces concurrent targeted pane reads without caching completed results", async () => {
    let release!: (value: ReturnType<typeof pane>) => void;
    const getPane = vi.fn(() => new Promise<ReturnType<typeof pane>>((resolve) => { release = resolve; }));
    const cache = new WorkspaceSnapshotCache(adapter({ getPane }));

    const first = cache.getPane("w1:p1");
    const second = cache.getPane("w1:p1");
    release(pane("w1", 1));
    const [a, b] = await Promise.all([first, second]);
    a!.label = "mutated";

    expect(b?.label).toBe("v1");
    expect(getPane).toHaveBeenCalledOnce();
    getPane.mockResolvedValueOnce(pane("w1", 2));
    expect((await cache.getPane("w1:p1"))?.label).toBe("v2");
    expect(getPane).toHaveBeenCalledTimes(2);
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

  it("preserves direct-workspace fallback through the cache", async () => {
    const listAllPanes = vi.fn(async () => [pane("w1", 1)]);
    const listPanes = vi.fn(async (workspaceId: string) => [pane(workspaceId, 2)]);
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes, listPanes }));

    expect((await cache.listPanes("w1", { skipAllWorkspaceSnapshot: true }))[0]?.label).toBe("v2");

    expect(listAllPanes).not.toHaveBeenCalled();
    expect(listPanes).toHaveBeenCalledWith("w1", { forceRefresh: true, skipAllWorkspaceSnapshot: true });
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

  it("keeps a newer direct workspace snapshot when an older all-workspace refresh completes later", async () => {
    let releaseAll!: (panes: ReturnType<typeof pane>[]) => void;
    let releaseCurrentAll!: (panes: ReturnType<typeof pane>[]) => void;
    const listAllPanes = vi.fn()
      .mockImplementationOnce(() => new Promise<ReturnType<typeof pane>[]>((resolve) => { releaseAll = resolve; }))
      .mockImplementationOnce(() => new Promise<ReturnType<typeof pane>[]>((resolve) => { releaseCurrentAll = resolve; }));
    const listPanes = vi.fn(async () => [pane("w1", 2)]);
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes, listPanes }));

    const staleAll = cache.listAllPanes();
    expect((await cache.listPanes("w1", { forceRefresh: true, skipAllWorkspaceSnapshot: true }))[0]?.label).toBe("v2");
    const currentAll = cache.listAllPanes();
    expect(listAllPanes).toHaveBeenCalledTimes(2);
    releaseAll([pane("w1", 1), pane("w2", 1)]);
    expect((await staleAll).map(({ label }) => label)).toEqual(["v1", "v1"]);

    expect((await cache.listPanes("w1"))[0]?.label).toBe("v2");
    releaseCurrentAll([pane("w1", 3), pane("w2", 4)]);
    expect((await currentAll).map(({ label }) => label)).toEqual(["v3", "v4"]);
    expect((await cache.listAllPanes()).map(({ label }) => label)).toEqual(["v3", "v4"]);
    expect(listAllPanes).toHaveBeenCalledTimes(2);
    expect(listPanes).toHaveBeenCalledOnce();
  });

  it("invalidates every cached and in-flight snapshot after full-scope uncertainty", async () => {
    const releases: Array<(panes: ReturnType<typeof pane>[]) => void> = [];
    const listAllPanes = vi.fn(() => new Promise<ReturnType<typeof pane>[]>((resolve) => { releases.push(resolve); }));
    const cache = new WorkspaceSnapshotCache(adapter({ listAllPanes }));

    const stale = cache.listAllPanes();
    cache.invalidateAll();
    const current = cache.listAllPanes();
    expect(listAllPanes).toHaveBeenCalledTimes(2);

    releases[0]!([pane("w1", 1)]);
    await stale;
    expect(cache.status().entries).toBe(0);
    releases[1]!([pane("w1", 2)]);
    expect((await current)[0]?.label).toBe("v2");
    expect((await cache.listAllPanes())[0]?.label).toBe("v2");
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

  it("bounds fallback runtime observations when the delegate has no bulk API", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const observeRuntime = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { pane: null, traexProcess: false, composerReady: false, evidenceSource: "none" as const };
    });
    const cache = new WorkspaceSnapshotCache(adapter({ observeRuntime }));
    const work = cache.observeRuntimes(["w1:p1", "w1:p2", "w1:p3", "w1:p4", "w1:p5", "w1:p6"]);

    await Promise.resolve();
    expect(active).toBe(4);
    releases.splice(0).forEach((release) => release());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(active).toBe(2);
    releases.splice(0).forEach((release) => release());

    await expect(work).resolves.toHaveProperty("size", 6);
    expect(maximumActive).toBe(4);
    expect(observeRuntime).toHaveBeenCalledTimes(6);
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

  it("forwards native prompt queue capability and fenced submission without snapshot caching", async () => {
    const supportsPromptQueue = vi.fn(async () => true);
    const queuePrompt = vi.fn(async () => ({ submissionId: "prompt-1" }));
    const cache = new WorkspaceSnapshotCache(adapter({ supportsPromptQueue, queuePrompt }));

    await expect(cache.supportsPromptQueue()).resolves.toBe(true);
    await expect(cache.queuePrompt("w1:p1", "next", { submissionId: "prompt-1", expectedSessionId: "session-1" })).resolves.toEqual({ submissionId: "prompt-1" });
    expect(queuePrompt).toHaveBeenCalledWith("w1:p1", "next", { submissionId: "prompt-1", expectedSessionId: "session-1" }, undefined);
  });

  it("forwards every Workspace directory read without caching it", async () => {
    const listWorkspaces = vi.fn(async () => [{ workspaceId: "w4", label: "herdr" }]);
    const cache = new WorkspaceSnapshotCache(adapter({ listWorkspaces }));

    await expect(cache.listWorkspaces()).resolves.toEqual([{ workspaceId: "w4", label: "herdr" }]);
    await expect(cache.listWorkspaces()).resolves.toEqual([{ workspaceId: "w4", label: "herdr" }]);
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("forwards native model prompt capability and fenced submission without snapshot caching", async () => {
    const supportsModelPrompt = vi.fn(async () => true);
    const queueModelPrompt = vi.fn(async () => ({ submissionId: "prompt-1" }));
    const cache = new WorkspaceSnapshotCache(adapter({ supportsModelPrompt, queueModelPrompt }));

    await expect(cache.supportsModelPrompt()).resolves.toBe(true);
    await expect(cache.queueModelPrompt("w1:p1", "next", {
      model: "openai/gpt-5.4",
      submissionId: "prompt-1",
      expectedSessionId: "session-1"
    })).resolves.toEqual({ submissionId: "prompt-1" });
    expect(queueModelPrompt).toHaveBeenCalledWith("w1:p1", "next", {
      model: "openai/gpt-5.4",
      submissionId: "prompt-1",
      expectedSessionId: "session-1"
    }, undefined);
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
