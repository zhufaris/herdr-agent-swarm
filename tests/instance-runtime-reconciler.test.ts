import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceRuntimeReconciler } from "../src/coordinator/instance-runtime-reconciler.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import type { HerdrPane, ProjectConfig } from "../src/domain/types.js";
import type { PaneHost } from "../src/runtime/herdr/pane-host.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

const project = { id: "p1", name: "Project", description: "test", workspaceId: "herdr-w", cwd: "/repo" } as ProjectConfig;
function pane(overrides: Partial<HerdrPane> = {}): HerdrPane { return { paneId: "herdr-w:p1", workspaceId: "herdr-w", cwd: "/repo", label: "worker", agentKind: "codex", agentState: "idle", foregroundExecutables: ["codex"], ...overrides }; }
function setup(snapshot: HerdrPane[]) {
  store = new SqliteBindingStore(":memory:");
  store.createAgentInstance({ id: "i1", projectId: "p1", name: "worker", role: "worker", agentKind: "codex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
  const instance = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "herdr-w", paneId: "herdr-w:p1", nativeSessionId: null })!;
  const paneHost = { listPanes: vi.fn(async () => snapshot) } as unknown as PaneHost;
  const wake = vi.fn();
  const reconciler = new InstanceRuntimeReconciler({ projects: [project], store, paneHost, wake });
  return { instance, reconciler, wake };
}

describe("instance runtime reconciliation", () => {
  it("converges a matching runtime and wakes queued work only after an idle observation", async () => {
    const { instance, reconciler, wake } = setup([pane({ agentState: "idle" })]);
    store!.acceptInstanceTurn({ id: "queued", idempotencyKey: "queued", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
    await reconciler.reconcile();
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ generation: instance.generation, observedState: "idle", runtimeRef: { paneId: "herdr-w:p1" } });
    expect(wake).toHaveBeenCalledWith(instance.id);
  });

  it("fails closed when process identity or workspace facts mismatch", async () => {
    const { instance, reconciler } = setup([pane({ agentKind: "claude", foregroundExecutables: ["claude"] })]);
    await reconciler.reconcile();
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ desiredState: "running", observedState: "detached", generation: instance.generation + 1, runtimeRef: null, lastError: expect.stringMatching(/identity mismatch/) });
  });

  it("retains desired-running state when an idle pane is missing", async () => {
    const { instance, reconciler, wake } = setup([]);
    store!.acceptInstanceTurn({ id: "not-started", idempotencyKey: "not-started", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "safe to run after explicit restart" });
    await reconciler.reconcile();
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ desiredState: "running", observedState: "detached", generation: instance.generation + 1, runtimeRef: null });
    expect(store!.getInstanceTurn("not-started")).toMatchObject({ state: "queued", instanceGeneration: instance.generation + 1 });
    expect(wake).not.toHaveBeenCalled();
  });

  it("detaches missing active work as uncertain without replaying it", async () => {
    const { instance, reconciler, wake } = setup([]);
    store!.acceptInstanceTurn({ id: "active", idempotencyKey: "active", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "possibly sent" });
    store!.claimNextInstanceTurn(instance.id, instance.generation);
    store!.updateInstanceTurn({ turnId: "active", expectedGeneration: instance.generation, state: "dispatching", eventKind: "turn.dispatching" });
    await reconciler.reconcile();
    expect(store!.getInstanceTurn("active")).toMatchObject({ state: "dispatch-uncertain" });
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ observedState: "detached", runtimeRef: null });
    expect(store!.claimNextInstanceTurn(instance.id, instance.generation + 1)).toBeNull();
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
});
