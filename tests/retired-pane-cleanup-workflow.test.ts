import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { RetiredPaneCleanupWorkflow } from "../src/coordinator/retired-pane-cleanup-workflow.js";
import type { HerdrPane, RuntimeObservation } from "../src/domain/types.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

describe("RetiredPaneCleanupWorkflow", () => {
  it("retries only cleanup operations for targeted Panes", async () => {
    const operations = [cleanupOperation("one", "w1:p1"), cleanupOperation("two", "w1:p2")];
    const getBinding = vi.fn(() => null);
    const workflow = new RetiredPaneCleanupWorkflow({
      store: { listRetiredPaneCleanupOperations: () => operations, getBinding } as never,
      herdr: { observeRuntime: vi.fn(), closePane: vi.fn() },
      logger: pino({ enabled: false })
    });

    await workflow.requestPanes(["w1:p2"]);

    expect(getBinding.mock.calls.map(([bindingId]) => bindingId)).toEqual(["old-two", "new-two"]);
  });

  it("waits while durable work or the runtime is busy", async () => {
    const { store, pane } = resetStore();
    store.enqueuePrompt({ id: "running", bindingId: "old", larkMessageId: "message", actorOpenId: "user", body: "work" });
    const closePane = vi.fn(async () => undefined);
    const workflow = cleanup(store, async () => observation({ ...pane, agentState: "working" }), closePane);

    await workflow.recover();

    expect(closePane).not.toHaveBeenCalled();
    expect(store.listRetiredPaneCleanupOperations(["waiting_busy"])).toMatchObject([{ id: "cleanup", state: "waiting_busy", attemptCount: 0 }]);
    store.close();
  });

  it("retains a pane whose terminal identity does not match", async () => {
    const { store, pane } = resetStore();
    const closePane = vi.fn(async () => undefined);
    const workflow = cleanup(store, async () => observation({ ...pane, terminalId: "other-terminal" }), closePane);

    await workflow.recover();

    expect(closePane).not.toHaveBeenCalled();
    expect(store.listRetiredPaneCleanupOperations(["retained"])).toMatchObject([{ id: "cleanup", state: "retained", detail: expect.stringContaining("identity") }]);
    store.close();
  });

  it("recovers an executing close from observed pane absence without replay", async () => {
    const { store } = resetStore();
    expect(store.claimRetiredPaneCleanup("cleanup")?.state).toBe("executing");
    const closePane = vi.fn(async () => undefined);
    const workflow = cleanup(store, async () => observation(null), closePane);

    await workflow.recover();

    expect(closePane).not.toHaveBeenCalled();
    expect(store.getBinding("old")).toMatchObject({ lifecycle: "closed", attachment: "unattached" });
    expect(store.listRetiredPaneCleanupOperations(["succeeded"])).toMatchObject([{ id: "cleanup", state: "succeeded", attemptCount: 1 }]);
    store.close();
  });

  it("keeps an uncertain close executing until a later observation proves absence", async () => {
    const { store, pane } = resetStore();
    let present = true;
    const closePane = vi.fn(async () => { throw new Error("timeout"); });
    const workflow = cleanup(store, async () => observation(present ? pane : null), closePane);

    await workflow.recover();
    expect(store.listRetiredPaneCleanupOperations(["executing"])).toMatchObject([{ id: "cleanup", state: "executing", detail: expect.stringContaining("timeout") }]);

    present = false;
    await workflow.requestScan();
    expect(closePane).toHaveBeenCalledTimes(1);
    expect(store.listRetiredPaneCleanupOperations(["succeeded"])).toHaveLength(1);
    store.close();
  });
});

function cleanupOperation(id: string, paneId: string) {
  return {
    id, oldBindingId: `old-${id}`, replacementBindingId: `new-${id}`, paneId, expectedWorkspaceId: "w1", expectedProjectId: "repo",
    expectedCwd: "/repo", expectedTerminalId: `term-${id}`, actorOpenId: "user", state: "waiting_busy" as const, attemptCount: 0, detail: null, createdAt: "now", updatedAt: "now"
  };
}

function resetStore() {
  const store = new SqliteBindingStore(":memory:");
  const pane: HerdrPane = { paneId: "w1:old", terminalId: "term-old", workspaceId: "w1", cwd: "/repo", label: "old", agentState: "idle", foregroundExecutables: ["traex"] };
  store.createPendingBinding({ id: "old", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Old" });
  store.updateBinding("old", { paneId: pane.paneId, traexSessionId: pane.terminalId, state: "active", lifecycle: "active", attachment: "attached" });
  store.createResetCandidate({ oldBindingId: "old", newBindingId: "new", title: "New", actorOpenId: "user", resetMessageId: "reset" });
  store.updateBinding("new", { paneId: "w1:new", traexSessionId: "term-new" });
  store.transitionBinding("new", { type: "pane_created" });
  store.transitionBinding("new", { type: "runtime_started" });
  store.cutoverResetCandidate({ oldBindingId: "old", newBindingId: "new", cleanupOperationId: "cleanup", actorOpenId: "user", expectedCwd: "/repo" });
  return { store, pane };
}

function cleanup(store: SqliteBindingStore, observeRuntime: () => Promise<RuntimeObservation>, closePane: (paneId: string) => Promise<void>) {
  return new RetiredPaneCleanupWorkflow({ store, herdr: { observeRuntime, closePane }, logger: pino({ enabled: false }) });
}

function observation(pane: HerdrPane | null): RuntimeObservation {
  return { pane, traexProcess: Boolean(pane), composerReady: pane?.agentState === "idle", evidenceSource: pane ? "structured" : "none" };
}
