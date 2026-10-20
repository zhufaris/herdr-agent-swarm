import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneTopologyReconciler } from "../src/coordinator/pane-topology-reconciler.js";
import type { HerdrPane, ProjectConfig } from "../src/domain/types.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

const project = { id: "p1", name: "Project", description: "test", workspaceId: "w1", cwd: "/repo" } as ProjectConfig;
const primaryPane = (): HerdrPane => ({
  paneId: "w1:p1", paneToken: "9e2u", tabId: "w1:t1", tabLabel: "9e2u", terminalId: "term-primary",
  agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-primary" },
  workspaceId: "w1", cwd: "/repo", label: "9e2u-main", agentKind: "traex", agentState: "idle", foregroundExecutables: ["traex"]
});
const workerPane = (patch: Partial<HerdrPane> = {}): HerdrPane => ({
  paneId: "w1:p2", paneToken: "wk42", tabId: "w1:t2", tabLabel: "old", terminalId: "term-worker",
  agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-worker" },
  workspaceId: "w1", cwd: "/repo/worker", label: "old-worker", agentKind: "traex", agentState: "idle", foregroundExecutables: ["traex"],
  ...patch
});

function setup(managedPrimary = true) {
  store = new SqliteBindingStore(":memory:");
  store.createPendingBinding({ id: "binding", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
  store.updateBinding("binding", { paneId: "w1:p1", paneToken: "9e2u", traexSessionId: "term-primary", state: "active", lifecycle: "active", attachment: "attached" });
  if (managedPrimary) store.setBindingPrimaryToolCapability({ bindingId: "binding", expectedGeneration: 1, capabilityHash: "managed-primary" });
  const created = store.createWorkerAgentInstance({
    id: "worker", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
    sourcePrimaryPaneLabel: "9e2u", parent: { bindingId: "binding", bindingGeneration: 1, paneId: "w1:p1", nativeSessionId: "session-primary" },
    workspace: { id: "worker-space", kind: "shared-read-only", cwd: "/repo/worker", branch: null, baseCommit: "base" }
  }, 4);
  if (created.outcome !== "created") throw new Error("worker fixture failed");
  const worker = store.attachAgentInstanceRuntime({
    instanceId: created.instance.id, expectedGeneration: created.instance.generation,
    herdrWorkspaceId: "w1", paneId: "w1:p2", paneToken: "wk42", nativeSessionId: "session-worker"
  })!;
  const movePane = vi.fn(async () => ({ previousPaneId: "w1:p2", paneId: "w1:p3", paneToken: "wk42", tabId: "w1:t1", workspaceId: "w1" }));
  const labelPane = vi.fn(async (input: { workspaceId: string; paneId: string; paneToken?: string | null; tabId: string }) => ({
    previousPaneId: input.paneId, paneId: input.paneId, paneToken: input.paneToken, tabId: input.tabId, workspaceId: input.workspaceId
  }));
  const reconciler = new PaneTopologyReconciler({ intents: store.paneTopology, instances: store, bindings: store, paneHost: { movePane, labelPane } });
  return { worker, movePane, labelPane, reconciler };
}

describe("Pane Topology reconciliation", () => {
  it("persists intent before moving one idle Worker and adopts the receipt Pane ID", async () => {
    const { worker, movePane, reconciler } = setup();

    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane()] });

    expect(movePane).toHaveBeenCalledWith({
      paneId: "w1:p2", targetTabId: "w1:t1", targetAnchorPaneId: "w1:p1",
      paneLabel: "9e2u-reviewer", tabLabel: "9e2u"
    });
    expect(store!.paneTopology.listRecoverable()).toEqual([]);
    expect(store!.database.prepare("SELECT state,result_pane_id FROM pane_topology_intents").get()).toEqual({ state: "succeeded", result_pane_id: "w1:p3" });
    expect(store!.getAgentInstance(worker.id)).toMatchObject({
      generation: worker.generation, workerSessionLifecycle: "active",
      runtimeRef: { paneId: "w1:p3", paneToken: "wk42", nativeSessionId: "session-worker" }
    });
  });

  it("defers an active Worker without reserving or moving topology", async () => {
    const { worker, movePane, reconciler } = setup();
    store!.acceptInstanceTurn({ id: "active", idempotencyKey: "active", actor: { kind: "human", userId: "u" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
    store!.claimNextInstanceTurn(worker.id, worker.generation);

    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane({ agentState: "working" })] });

    expect(movePane).not.toHaveBeenCalled();
    expect(store!.database.prepare("SELECT COUNT(*) AS count FROM pane_topology_intents").get()).toEqual({ count: 0 });
  });

  it("labels a directly created Primary as default-main without moving its pane", async () => {
    const { movePane, labelPane, reconciler } = setup(false);
    const direct = primaryPane();
    direct.label = "shell";
    direct.tabLabel = "shell";

    await reconciler.reconcileWorkspace({ project, panes: [direct, workerPane({ tabId: "w1:t1", tabLabel: "9e2u", label: "9e2u-reviewer" })] });

    expect(labelPane).toHaveBeenCalledWith({
      workspaceId: "w1", paneId: "w1:p1", paneToken: "9e2u", tabId: "w1:t1",
      paneLabel: "9e2u-default-main", tabLabel: "9e2u"
    });
    expect(movePane).not.toHaveBeenCalled();
    expect(store!.database.prepare("SELECT state,desired_pane_label FROM pane_topology_intents WHERE owner_kind='primary'").get())
      .toEqual({ state: "succeeded", desired_pane_label: "9e2u-default-main" });
  });

  it("adopts an exact target observation after an uncertain move without replaying the effect", async () => {
    const { worker, movePane, reconciler } = setup();
    movePane.mockRejectedValueOnce(new Error("socket disconnected"));
    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane()] });
    expect(store!.paneTopology.listRecoverable()).toEqual([expect.objectContaining({ state: "uncertain", attemptCount: 1 })]);

    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane({
      paneId: "w1:p3", tabId: "w1:t1", tabLabel: "9e2u", label: "9e2u-reviewer"
    })] });

    expect(movePane).toHaveBeenCalledTimes(1);
    expect(store!.paneTopology.listRecoverable()).toEqual([]);
    expect(store!.getAgentInstance(worker.id)).toMatchObject({ runtimeRef: { paneId: "w1:p3" } });
  });

  it("defers an uncertain Worker retry when the Worker becomes active", async () => {
    const { worker, movePane, reconciler } = setup();
    movePane.mockRejectedValueOnce(new Error("socket disconnected"));
    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane()] });
    store!.acceptInstanceTurn({
      id: "became-active", idempotencyKey: "became-active", actor: { kind: "human", userId: "u" },
      projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work"
    });
    store!.claimNextInstanceTurn(worker.id, worker.generation);

    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane()] });

    expect(movePane).toHaveBeenCalledTimes(1);
    expect(store!.paneTopology.listRecoverable()).toEqual([
      expect.objectContaining({ state: "uncertain", attemptCount: 1 })
    ]);
  });

  it("keeps an uncertain move unresolved when two panes match the frozen runtime", async () => {
    const { movePane, reconciler } = setup();
    movePane.mockRejectedValueOnce(new Error("socket disconnected"));
    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane()] });

    await reconciler.reconcileWorkspace({ project, panes: [
      primaryPane(),
      workerPane({ paneId: "w1:p3", tabId: "w1:t1", tabLabel: "9e2u", label: "9e2u-reviewer" }),
      workerPane({ paneId: "w1:p4", tabId: "w1:t1", tabLabel: "9e2u", label: "9e2u-reviewer" })
    ] });

    expect(movePane).toHaveBeenCalledTimes(1);
    expect(store!.paneTopology.listRecoverable()).toEqual([expect.objectContaining({ state: "uncertain", attemptCount: 1 })]);
  });

  it("does not replay a partially applied identity effect", async () => {
    const { movePane, reconciler } = setup();
    movePane.mockRejectedValueOnce(new Error("tab rename disconnected"));
    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane()] });

    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane({ label: "9e2u-reviewer", tabLabel: "old" })] });

    expect(movePane).toHaveBeenCalledTimes(1);
    expect(store!.paneTopology.listRecoverable()).toEqual([expect.objectContaining({ state: "uncertain", attemptCount: 1 })]);
  });

  it("does not execute a pending intent after its frozen source topology drifts", async () => {
    const { worker, movePane, reconciler } = setup();
    store!.paneTopology.reserve({
      id: "reserved-before-crash", idempotencyKey: "reserved-before-crash",
      owner: {
        kind: "worker", id: worker.id, generation: worker.generation, sessionGeneration: worker.workerSessionGeneration,
        parent: { id: "binding", generation: 1, sessionGeneration: 1, paneId: "w1:p1" }
      },
      expected: {
        workspaceId: "w1", paneId: "w1:p2", terminalId: "term-worker", agentSessionId: "session-worker",
        tabId: "w1:t2", paneLabel: "old-worker", tabLabel: "old"
      },
      desired: { tabId: "w1:t1", anchorPaneId: "w1:p1", paneLabel: "9e2u-reviewer", tabLabel: "9e2u" }
    });

    await reconciler.reconcileWorkspace({
      project,
      panes: [primaryPane(), workerPane({ label: "partially-renamed" })]
    });

    expect(movePane).not.toHaveBeenCalled();
    expect(store!.paneTopology.get("reserved-before-crash")).toMatchObject({ state: "pending", attemptCount: 0 });
  });

  it("rolls back intent settlement when the Worker generation fence changes after the move receipt", async () => {
    const { worker, movePane, reconciler } = setup();
    movePane.mockImplementationOnce(async () => {
      store!.database.prepare("UPDATE agent_instances SET generation=generation+1 WHERE id=?").run(worker.id);
      return { previousPaneId: "w1:p2", paneId: "w1:p3", paneToken: "wk42", tabId: "w1:t1", workspaceId: "w1" };
    });

    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane()] });

    expect(store!.paneTopology.listRecoverable()).toEqual([expect.objectContaining({ state: "uncertain", resultPaneId: null })]);
    expect(store!.database.prepare("SELECT pane_id FROM agent_instances WHERE id=?").get(worker.id)).toEqual({ pane_id: "w1:p2" });
  });

  it("creates a new identity intent for later label drift without moving an already grouped Worker", async () => {
    const { movePane, labelPane, reconciler } = setup();
    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane()] });

    await reconciler.reconcileWorkspace({ project, panes: [primaryPane(), workerPane({
      paneId: "w1:p3", tabId: "w1:t1", tabLabel: "9e2u", label: "renamed-by-user"
    })] });

    expect(movePane).toHaveBeenCalledTimes(1);
    expect(labelPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: "w1:p3", paneLabel: "9e2u-reviewer", tabLabel: "9e2u" }));
    expect(store!.database.prepare("SELECT COUNT(*) AS count FROM pane_topology_intents WHERE owner_kind='worker' AND state='succeeded'").get()).toEqual({ count: 2 });
  });
});
