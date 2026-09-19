import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceRuntimeReconciler } from "../src/coordinator/instance-runtime-reconciler.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import type { HerdrPane, ProjectConfig } from "../src/domain/types.js";
import type { PaneHost } from "../src/runtime/herdr/pane-host.js";
import { HerdrEventRouter } from "../src/runtime/herdr-event-router.js";
import { HerdrPaneHost } from "../src/runtime/herdr/pane-host.js";
import { WorkspaceSnapshotCache } from "../src/runtime/workspace-snapshot-cache.js";
import type { HerdrPort } from "../src/domain/ports.js";
import pino from "pino";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

const project = { id: "p1", name: "Project", description: "test", workspaceId: "herdr-w", cwd: "/repo" } as ProjectConfig;
function pane(overrides: Partial<HerdrPane> = {}): HerdrPane { return { paneId: "herdr-w:p1", workspaceId: "herdr-w", cwd: "/repo", label: "worker", agentKind: "codex", agentSession: { source: "herdr:codex", agent: "codex", kind: "id", value: "session-1" }, agentState: "idle", foregroundExecutables: ["codex"], ...overrides }; }
function setup(snapshot: HerdrPane[], options: { bulkSnapshot?: boolean } = {}) {
  store = new SqliteBindingStore(":memory:");
  store.createAgentInstance({ id: "i1", projectId: "p1", name: "worker", role: "worker", agentKind: "codex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
  const instance = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "herdr-w", paneId: "herdr-w:p1", nativeSessionId: null })!;
  const paneHost = {
    listPanes: vi.fn(async () => snapshot),
    inspectPane: vi.fn(async (paneId: string) => snapshot.find((candidate) => candidate.paneId === paneId) ?? null),
    ...(options.bulkSnapshot ? { snapshotPanes: vi.fn(async () => snapshot) } : {})
  } as unknown as PaneHost;
  const wake = vi.fn();
  const wakeCardContext = vi.fn();
  const reconciler = new InstanceRuntimeReconciler({ projects: [project], store, paneHost, wake, wakeCardContext });
  return { instance, reconciler, wake, wakeCardContext, paneHost };
}

function setupPending(snapshot: HerdrPane[]) {
  store = new SqliteBindingStore(":memory:");
  store.createAgentInstance({ id: "pending", projectId: "p1", name: "worker", role: "worker", agentKind: "traex", model: null, workerSessionLifecycle: "active", desiredState: "running", workspace: { id: "ws-pending", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
  const instance = store.checkpointAgentInstance({ instanceId: "pending", expectedGeneration: 1, checkpoint: "pane-allocated", observedState: "failed", pendingPaneId: "herdr-w:p1", pendingWorkspaceId: "herdr-w", lastError: "agent start result uncertain" })!;
  const paneHost = {
    listPanes: vi.fn(async () => snapshot),
    inspectPane: vi.fn(async (paneId: string) => snapshot.find((candidate) => candidate.paneId === paneId) ?? null)
  } as unknown as PaneHost;
  const wake = vi.fn();
  const wakeCardContext = vi.fn();
  const reconciler = new InstanceRuntimeReconciler({ projects: [project], store, paneHost, wake, wakeCardContext });
  return { instance, reconciler, wake, wakeCardContext, paneHost };
}

describe("instance runtime reconciliation", () => {
  it("reports bounded lifecycle and timing diagnostics for successful and coalesced scans", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { reconciler, paneHost } = setup([]);
    const listPanes = vi.spyOn(paneHost, "listPanes").mockImplementation(async () => { await blocked; return []; });

    expect(reconciler.snapshot()).toMatchObject({ state: "idle", runCount: 0, successCount: 0, failureCount: 0, coalescedRequestCount: 0, lastOutcome: null });
    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    await vi.waitFor(() => expect(listPanes).toHaveBeenCalledOnce());
    expect(reconciler.snapshot()).toMatchObject({ state: "running", runCount: 1, coalescedRequestCount: 1, lastStartedAt: expect.any(String), lastCompletedAt: null });
    release();
    await Promise.all([first, second]);

    expect(reconciler.snapshot()).toMatchObject({ state: "idle", runCount: 1, successCount: 1, failureCount: 0, coalescedRequestCount: 1, lastCompletedAt: expect.any(String), lastDurationMs: expect.any(Number), maxDurationMs: expect.any(Number), lastOutcome: "succeeded", ready: true, lastError: null });
  });

  it("serializes and merges scoped requests queued behind an active full scan", async () => {
    const target = pane({ agentState: "working" });
    const { reconciler, paneHost } = setup([target], { bulkSnapshot: true });
    let release!: () => void;
    let active = 0;
    let peak = 0;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(paneHost, "listPanes").mockImplementation(async () => { active += 1; peak = Math.max(peak, active); await blocked; active -= 1; return [target]; });
    vi.spyOn(paneHost, "snapshotPanes").mockImplementation(async () => { active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1; return [target]; });

    const full = reconciler.reconcile();
    await vi.waitFor(() => expect(paneHost.listPanes).toHaveBeenCalledOnce());
    const paneOne = reconciler.requestReconciliation({ paneIds: [target.paneId] });
    const paneTwo = reconciler.requestReconciliation({ paneIds: ["herdr-w:p2"] });
    release();
    await Promise.all([full, paneOne, paneTwo]);

    expect(peak).toBe(1);
    expect(paneHost.snapshotPanes).toHaveBeenCalledOnce();
    expect(reconciler.snapshot()).toMatchObject({ runCount: 2, successCount: 2, coalescedRequestCount: 2 });
  });

  it("prioritizes pane work ahead of workspace work queued behind a full scan", async () => {
    const target = pane({ agentState: "working" });
    const { reconciler, paneHost } = setup([target]);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    vi.spyOn(paneHost, "listPanes").mockImplementation(async () => {
      calls.push("workspace"); active += 1; peak = Math.max(peak, active);
      if (calls.length === 1) await blocked;
      active -= 1; return [target];
    });
    vi.spyOn(paneHost, "inspectPane").mockImplementation(async () => {
      calls.push("pane"); active += 1; peak = Math.max(peak, active); active -= 1; return target;
    });

    const full = reconciler.reconcile();
    await vi.waitFor(() => expect(calls).toEqual(["workspace"]));
    const workspace = reconciler.requestReconciliation({ workspaceIds: ["herdr-w"] });
    const targeted = reconciler.requestReconciliation({ paneIds: [target.paneId] });
    release();
    await Promise.all([full, workspace, targeted]);

    expect(calls).toEqual(["workspace", "pane", "workspace"]);
    expect(peak).toBe(1);
    expect(reconciler.snapshot()).toMatchObject({ runCount: 3, priorityPromotionCount: 1 });
  });

  it("does not start queued reconciliation work after stop begins", async () => {
    const target = pane({ agentState: "working" });
    const { reconciler, paneHost } = setup([target], { bulkSnapshot: true });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(paneHost, "listPanes").mockImplementation(async () => { await blocked; return [target]; });

    const full = reconciler.reconcile();
    await vi.waitFor(() => expect(paneHost.listPanes).toHaveBeenCalledOnce());
    const queued = reconciler.requestReconciliation({ paneIds: [target.paneId] });
    const stopping = reconciler.stop();
    release();
    await Promise.all([full, queued, stopping]);

    expect(paneHost.snapshotPanes).not.toHaveBeenCalled();
    expect(reconciler.snapshot().state).toBe("stopping");
  });

  it("records failed scans and reports stopping while waiting for an active scan", async () => {
    let reject!: (error: Error) => void;
    const blocked = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const { reconciler, paneHost } = setup([]);
    vi.spyOn(paneHost, "listPanes").mockImplementation(() => blocked);

    const running = reconciler.reconcile();
    await vi.waitFor(() => expect(reconciler.snapshot().state).toBe("running"));
    const stopping = reconciler.stop();
    expect(reconciler.snapshot().state).toBe("stopping");
    reject(new Error("runtime scan failed"));
    await expect(running).rejects.toThrow("runtime scan failed");
    await expect(stopping).rejects.toThrow("runtime scan failed");
    expect(reconciler.snapshot()).toMatchObject({ state: "stopping", runCount: 1, successCount: 0, failureCount: 1, lastOutcome: "failed", lastDurationMs: expect.any(Number) });
  });

  it("converges a matching runtime and wakes queued work only after an idle observation", async () => {
    const { instance, reconciler, wake, wakeCardContext } = setup([pane({ agentState: "idle" })]);
    store!.acceptInstanceTurn({ id: "queued", idempotencyKey: "queued", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
    await reconciler.reconcile();
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ generation: instance.generation, observedState: "idle", runtimeRef: { paneId: "herdr-w:p1" } });
    expect(wake).toHaveBeenCalledWith(instance.id);
    expect(wakeCardContext).toHaveBeenCalledOnce();
  });

  it("fails closed when process identity or workspace facts mismatch", async () => {
    const { instance, reconciler } = setup([pane({ agentKind: "claude", foregroundExecutables: ["claude"] })]);
    await reconciler.reconcile();
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ desiredState: "stopped", observedState: "stopped", generation: instance.generation + 1, runtimeRef: null, workerSessionLifecycle: "terminated", lastError: expect.stringMatching(/identity mismatch/) });
  });

  it("reconciles a TraeX instance reported under Herdr's codex label", async () => {
    const { instance, reconciler } = setup([pane({ agentKind: "codex", foregroundExecutables: ["traex"] })]);
    store!.database.prepare("UPDATE agent_instances SET agent_kind = 'traex' WHERE id = ?").run(instance.id);
    await reconciler.reconcile();
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ observedState: "idle", runtimeRef: { paneId: "herdr-w:p1" } });
  });

  it("refreshes only a matching Worker pane with its native TraeX session identity", async () => {
    const observed = pane({
      agentKind: "codex", foregroundExecutables: ["traex"],
      agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "native-traex-session" }
    });
    const { instance, reconciler, wakeCardContext } = setup([observed]);
    store!.database.prepare("UPDATE agent_instances SET agent_kind = ? WHERE id = ?").run("traex", instance.id);
    store!.database.prepare("UPDATE agent_instances SET native_session_id = ? WHERE id = ?").run("terminal-id", instance.id);

    await reconciler.reconcile();

    expect(store!.getAgentInstance(instance.id)).toMatchObject({
      generation: instance.generation, runtimeRef: { paneId: "herdr-w:p1", nativeSessionId: "native-traex-session" }
    });
    expect(wakeCardContext).toHaveBeenCalledTimes(2);
  });

  it("adopts a matching pending TraeX runtime without starting it again", async () => {
    const { instance, reconciler, wake, wakeCardContext, paneHost } = setupPending([pane()]);

    await reconciler.reconcile();

    expect(store!.getAgentInstance(instance.id)).toMatchObject({
      generation: instance.generation + 1,
      desiredState: "running",
      observedState: "idle",
      provisioningCheckpoint: "verified",
      pendingRuntimeRef: null,
      runtimeRef: { herdrWorkspaceId: "herdr-w", paneId: "herdr-w:p1", nativeSessionId: "session-1", generation: instance.generation + 1 },
      lastError: null
    });
    expect(paneHost.listPanes).toHaveBeenCalledOnce();
    expect(wake).not.toHaveBeenCalled();
    expect(wakeCardContext).toHaveBeenCalledOnce();
  });

  it("terminalizes a pending Worker whose allocated pane is absent", async () => {
    const { instance, reconciler, wake, wakeCardContext } = setupPending([]);

    await reconciler.reconcile();

    expect(store!.getAgentInstance(instance.id)).toMatchObject({
      generation: instance.generation + 1, desiredState: "stopped", observedState: "stopped",
      workerSessionLifecycle: "terminated", pendingRuntimeRef: null,
      lastError: "Herdr pending pane herdr-w:p1 is missing"
    });
    expect(wake).not.toHaveBeenCalled();
    expect(wakeCardContext).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing session identity", pane({ agentSession: null })],
    ["workspace mismatch", pane({ workspaceId: "other-w" })],
    ["cwd mismatch", pane({ cwd: "/other" })],
    ["agent mismatch", pane({ agentKind: "claude", foregroundExecutables: ["claude"] })]
  ])("leaves a pending runtime unchanged on %s", async (_reason, observedPane) => {
    const { instance, reconciler, wake, wakeCardContext } = setupPending([observedPane]);

    await reconciler.reconcile();

    expect(store!.getAgentInstance(instance.id)).toEqual(instance);
    expect(wake).not.toHaveBeenCalled();
    expect(wakeCardContext).not.toHaveBeenCalled();
  });

  it("terminalizes queued work when a Worker pane is missing", async () => {
    const { instance, reconciler, wake, wakeCardContext } = setup([]);
    store!.acceptInstanceTurn({ id: "not-started", idempotencyKey: "not-started", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "safe to run after explicit restart" });
    await reconciler.reconcile();
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ desiredState: "stopped", observedState: "stopped", generation: instance.generation + 1, runtimeRef: null, workerSessionLifecycle: "terminated" });
    expect(store!.getInstanceTurn("not-started")).toMatchObject({ state: "cancelled", instanceGeneration: instance.generation });
    expect(wake).not.toHaveBeenCalled();
    expect(wakeCardContext).toHaveBeenCalledOnce();
  });

  it("detaches missing active work as uncertain without replaying it", async () => {
    const { instance, reconciler, wake } = setup([]);
    store!.acceptInstanceTurn({ id: "active", idempotencyKey: "active", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "possibly sent" });
    store!.claimNextInstanceTurn(instance.id, instance.generation);
    store!.updateInstanceTurn({ turnId: "active", expectedGeneration: instance.generation, state: "dispatching", eventKind: "turn.dispatching" });
    await reconciler.reconcile();
    expect(store!.getInstanceTurn("active")).toMatchObject({ state: "dispatch-uncertain" });
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ observedState: "stopped", runtimeRef: null, workerSessionLifecycle: "terminated" });
    expect(store!.claimNextInstanceTurn(instance.id, instance.generation)).toBeNull();
    expect(wake).not.toHaveBeenCalled();
  });

  it("preserves an already uncertain dispatch and rejects stale-generation writes", async () => {
    const { instance, reconciler } = setup([]);
    store!.acceptInstanceTurn({ id: "uncertain", idempotencyKey: "uncertain", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "possibly sent" });
    store!.claimNextInstanceTurn(instance.id, instance.generation);
    store!.updateInstanceTurn({ turnId: "uncertain", expectedGeneration: instance.generation, state: "dispatch-uncertain", eventKind: "turn.dispatch-uncertain" });
    await reconciler.reconcile();
    expect(store!.getInstanceTurn("uncertain")).toMatchObject({ state: "dispatch-uncertain" });
    expect(store!.updateAgentInstanceLifecycle({ instanceId: instance.id, expectedGeneration: instance.generation, desiredState: "running", observedState: "idle" })).toBeNull();
  });

  it("never adopts an unrecorded pane", async () => {
    store = new SqliteBindingStore(":memory:");
    const paneHost = { listPanes: vi.fn(async () => [pane({ paneId: "herdr-w:orphan" })]) } as unknown as PaneHost;
    const reconciler = new InstanceRuntimeReconciler({ projects: [project], store, paneHost, wake: vi.fn() });
    await reconciler.reconcile();
    expect(store.listAgentInstances("p1")).toEqual([]);
  });

  it("reconciles only the instance attached to a targeted Pane", async () => {
    const target = pane({ agentState: "working" });
    const { instance, reconciler, paneHost } = setup([target]);

    await reconciler.requestReconciliation({ paneIds: [target.paneId] });

    expect(paneHost.inspectPane).toHaveBeenCalledWith(target.paneId);
    expect(paneHost.listPanes).not.toHaveBeenCalled();
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ observedState: "working" });
  });

  it("uses one bulk snapshot for a batch of targeted panes", async () => {
    const target = pane({ agentState: "working" });
    const { instance, reconciler, paneHost } = setup([target], { bulkSnapshot: true });

    await reconciler.requestReconciliation({ paneIds: [target.paneId, target.paneId] });

    expect(paneHost.snapshotPanes).toHaveBeenCalledOnce();
    expect(paneHost.inspectPane).not.toHaveBeenCalled();
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ observedState: "working" });
  });

  it("refreshes an idle cache before reconciling a pane-status event and does not wake a busy Worker", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "p1", name: "worker", role: "worker", agentKind: "codex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const instance = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "herdr-w", paneId: "herdr-w:p1", nativeSessionId: null })!;
    store.acceptInstanceTurn({ id: "queued", idempotencyKey: "queued", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
    let state: HerdrPane["agentState"] = "idle";
    const listAllPanes = vi.fn(async () => [pane({ agentState: state })]);
    const delegate = {
      async assertWorkspace() {}, async listPanes() { return [pane({ agentState: state })]; }, listAllPanes,
      async getPane() { return pane({ agentState: state }); }, async observeRuntime() { return { pane: pane({ agentState: state }), traexProcess: true, composerReady: state === "idle", evidenceSource: "structured" as const }; },
      async createPane() { return pane({ agentState: state }); }, async startTraex() {}, async runPrompt() { return "done" as const; }, async renamePane() {}
    } satisfies HerdrPort;
    const cache = new WorkspaceSnapshotCache(delegate);
    const paneHost = new HerdrPaneHost(cache);
    const wake = vi.fn();
    const reconciler = new InstanceRuntimeReconciler({ projects: [project], store, paneHost, wake });
    await cache.listAllPanes();
    state = "working";
    const router = new HerdrEventRouter({
      invalidateAll: () => cache.invalidateAll(), invalidateWorkspace: (workspaceId) => cache.invalidate(workspaceId), invalidatePanes: (paneIds) => cache.invalidatePanes(paneIds),
      reconcileBindings: async () => undefined, reconcileInstances: (scope) => reconciler.requestReconciliation(scope),
      observePrimaryTurns: async () => undefined,
      observeInstanceTurns: async () => undefined, retryRetiredPanes: async () => undefined, logger: pino({ enabled: false })
    });

    await router.handle({ kind: "agent-status", scope: "panes", workspaceIds: ["herdr-w"], paneIds: ["herdr-w:p1"] });

    expect(listAllPanes).toHaveBeenCalledTimes(2);
    expect(store.getAgentInstance(instance.id)).toMatchObject({ observedState: "working" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("contains periodic reconciliation failures and retries on the next interval", async () => {
    vi.useFakeTimers();
    const { reconciler, paneHost } = setup([]);
    const warn = vi.fn();
    const periodic = new InstanceRuntimeReconciler({ projects: [project], store: store!, paneHost, wake: vi.fn(), logger: { warn } });
    vi.spyOn(paneHost, "listPanes").mockRejectedValueOnce(new Error("snapshot unavailable")).mockResolvedValue([]);

    periodic.start(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(periodic.snapshot()).toMatchObject({ failureCount: 1, lastOutcome: "failed", lastError: "snapshot unavailable" });

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(periodic.snapshot()).toMatchObject({ successCount: 1, lastOutcome: "succeeded", lastError: null }));
    await periodic.stop();
    vi.useRealTimers();
  });
});
