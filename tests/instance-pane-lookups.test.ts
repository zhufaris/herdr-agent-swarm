import { afterEach, describe, expect, it } from "vitest";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe("instance Pane lookups", () => {
  it("finds only an instance with a current attached Pane runtime", () => {
    store = new SqliteBindingStore(":memory:");
    const attached = createAttachedInstance(store, "one", "w1:p1");
    store.createAgentInstance({ id: "detached", projectId: "p1", name: "detached", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-detached", kind: "shared-read-only", cwd: "/repo/detached", branch: null, baseCommit: "base" } });

    expect(store.findAgentInstanceByPane("w1:p1")).toMatchObject({ id: attached.id, generation: attached.generation });
    expect(store.findAgentInstanceByPane("w1:missing")).toBeNull();
  });

  it("returns observable current-generation turns only for requested Panes", () => {
    store = new SqliteBindingStore(":memory:");
    const first = createAttachedInstance(store, "one", "w1:p1");
    const second = createAttachedInstance(store, "two", "w1:p2");
    createRunningTurn(store, first.id, first.generation, "turn-one");
    createRunningTurn(store, second.id, second.generation, "turn-two");

    expect(store.listObservableInstanceTurnsByPaneIds(["w1:p2", "w1:p2"])).toMatchObject([{ id: "turn-two" }]);
    expect(store.listObservableInstanceTurnsByPaneIds([])).toEqual([]);
  });
});

function createAttachedInstance(store: SqliteBindingStore, id: string, paneId: string) {
  store.createAgentInstance({ id, projectId: "p1", name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: `/repo/${id}`, branch: null, baseCommit: "base" } });
  return store.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId, nativeSessionId: null })!;
}

function createRunningTurn(store: SqliteBindingStore, instanceId: string, generation: number, turnId: string): void {
  store.acceptInstanceTurn({ id: turnId, idempotencyKey: turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId, instanceGeneration: generation, kind: "turn", text: "work" });
  store.claimNextInstanceTurn(instanceId, generation);
  store.updateInstanceTurn({ turnId, expectedGeneration: generation, state: "running", eventKind: "turn.running" });
}
