import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceTurnSupervisor } from "../src/coordinator/instance-turn-supervisor.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import type { PaneHost } from "../src/runtime/herdr/pane-host.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

function setup(state: "dispatching" | "running") {
  store = new SqliteBindingStore(":memory:");
  store.createAgentInstance({ id: "worker", projectId: "p1", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
  const instance = store.attachAgentInstanceRuntime({ instanceId: "worker", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: null })!;
  store.acceptInstanceTurn({ id: "turn", idempotencyKey: "turn", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
  store.claimNextInstanceTurn(instance.id, instance.generation);
  store.updateInstanceTurn({ turnId: "turn", expectedGeneration: instance.generation, state, eventKind: `turn.${state}` });
  const inspectPane = vi.fn(async () => ({ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle" as const, foregroundExecutables: ["traex"], agentKind: "traex", terminalId: "term" }));
  const wake = vi.fn();
  const supervisor = new InstanceTurnSupervisor({ store, paneHost: { inspectPane } as unknown as PaneHost, wake });
  return { supervisor, inspectPane, wake };
}

describe("InstanceTurnSupervisor", () => {
  it("observes a proven running turn to completion without dispatching it again", async () => {
    const { supervisor, wake } = setup("running");
    supervisor.prepareRecovery();
    await supervisor.reconcile();
    expect(store!.getInstanceTurn("turn")).toMatchObject({ state: "completed" });
    expect(wake).toHaveBeenCalledWith("worker");
  });

  it("keeps an ambiguous dispatch uncertain when the pane is idle", async () => {
    const { supervisor, wake } = setup("dispatching");
    supervisor.prepareRecovery();
    await supervisor.reconcile();
    expect(store!.getInstanceTurn("turn")).toMatchObject({ state: "dispatch-uncertain" });
    expect(wake).not.toHaveBeenCalled();
  });

  it("isolates one pane observation failure and still converges another instance", async () => {
    store = new SqliteBindingStore(":memory:");
    const actor = { kind: "human" as const, userId: "u1" };
    for (const id of ["broken", "healthy"]) {
      store.createAgentInstance({ id, projectId: "p1", name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: `/repo/${id}`, branch: null, baseCommit: "base" } });
      const instance = store.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: `w1:${id}`, nativeSessionId: null })!;
      store.acceptInstanceTurn({ id: `turn-${id}`, idempotencyKey: `turn-${id}`, actor, projectId: "p1", instanceId: id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
      store.claimNextInstanceTurn(id, instance.generation);
      store.updateInstanceTurn({ turnId: `turn-${id}`, expectedGeneration: instance.generation, state: "running", eventKind: "turn.running" });
    }
    const inspectPane = vi.fn(async (paneId: string) => {
      if (paneId === "w1:broken") throw new Error("temporary Herdr failure");
      return { paneId, workspaceId: "w1", cwd: "/repo/healthy", label: null, agentState: "idle" as const, foregroundExecutables: ["traex"], agentKind: "traex", terminalId: "term" };
    });
    const supervisor = new InstanceTurnSupervisor({ store, paneHost: { inspectPane } as unknown as PaneHost, wake: vi.fn() });
    supervisor.prepareRecovery();
    await supervisor.reconcile();
    expect(store.getInstanceTurn("turn-broken")).toMatchObject({ state: "running" });
    expect(store.getInstanceTurn("turn-healthy")).toMatchObject({ state: "completed" });
    expect(supervisor.snapshot()).toMatchObject({ lastFailure: "temporary Herdr failure" });
  });
});
