import { describe, expect, it, vi } from "vitest";
import { PaneRetentionWorkflow } from "../src/coordinator/pane-retention-workflow.js";
import { cardKitPanePresentation } from "../src/cards/cardkit-pane-presentation.js";
import type { Binding, HerdrPane, ProjectConfig } from "../src/domain/types.js";

const binding = (lastActivityAt = "2020-01-01T00:00:00.000Z"): Binding => ({ id: "b1", creatorOpenId: null, projectId: "p1", workspaceId: "w1", chatId: "c1", topicId: null, rootMessageId: "r1", retiredTopicId: null, retiredRootMessageId: null, replacesBindingId: null, reservedTopicId: null, reservedRootMessageId: null, resetMessageId: null, paneId: "w1:p1", traexSessionId: "t1", title: "test", runtime: "traex", state: "active", statusMessageId: null, statusCardSequence: 0, lastAgentState: "idle", lastOutputFingerprint: null, lifecycle: "active", attachment: "attached", generation: 1, provisioningCheckpoint: "activated", degradationCount: 0, hasCompletedTurn: true, lastObservedAt: null, archivedAt: null, lastActivityAt, createdAt: lastActivityAt, updatedAt: lastActivityAt });
const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", terminalId: "t1", agentState: "idle", cwd: "/repo", label: null, foregroundExecutables: [] };
const project: ProjectConfig = { id: "p1", displayName: "p1", description: "test", workspaceId: "w1", cwd: "/repo", paneRetention: { mode: "ephemeral" } };

describe("PaneRetentionWorkflow", () => {
  it("closes an eligible opted-in pane and persists the operation", async () => {
    let present = true;
    const close = vi.fn(async () => { present = false; });
    const store = { listBindings: () => [binding()], listUnresolvedPaneCloseOperations: () => [], countPendingPrompts: () => 0, getBinding: () => binding(), createAutomaticPaneCloseOperation: vi.fn(), finishPaneCloseRequest: vi.fn(), transitionBinding: vi.fn((id: string, transition: { type: string }) => ({ ...binding(), id, lifecycle: transition.type === "closed" ? "closed" : "draining" })) };
    const workflow = new PaneRetentionWorkflow({ projects: [project], store: store as never, herdr: { getPane: vi.fn(async () => present ? pane : null), closePane: close }, presentation: cardKitPanePresentation, isBindingBusy: () => false, logger: { info: vi.fn(), warn: vi.fn() } });
    await workflow.scan();
    expect(store.createAutomaticPaneCloseOperation).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith("w1:p1");
    expect(store.finishPaneCloseRequest).toHaveBeenCalledWith(expect.any(String), "succeeded", expect.any(String));
  });

  it("does not repeat an unresolved automatic close", async () => {
    const store = { listBindings: () => [binding()], listUnresolvedPaneCloseOperations: () => [{ bindingId: "b1" }], countPendingPrompts: () => 0, getBinding: () => binding(), createAutomaticPaneCloseOperation: vi.fn(), finishPaneCloseRequest: vi.fn(), transitionBinding: vi.fn() };
    const close = vi.fn(async () => undefined);
    const workflow = new PaneRetentionWorkflow({ projects: [project], store: store as never, herdr: { getPane: vi.fn(async () => pane), closePane: close }, presentation: cardKitPanePresentation, isBindingBusy: () => false, logger: { info: vi.fn(), warn: vi.fn() } });
    await workflow.scan();
    expect(close).not.toHaveBeenCalled();
    expect(store.createAutomaticPaneCloseOperation).not.toHaveBeenCalled();
  });

  it("does not close when runtime identity no longer matches the binding", async () => {
    const store = { listBindings: () => [binding()], listUnresolvedPaneCloseOperations: () => [], countPendingPrompts: () => 0, getBinding: () => binding(), createAutomaticPaneCloseOperation: vi.fn(), finishPaneCloseRequest: vi.fn(), transitionBinding: vi.fn() };
    const close = vi.fn(async () => undefined);
    const workflow = new PaneRetentionWorkflow({ projects: [project], store: store as never, herdr: { getPane: vi.fn(async () => ({ ...pane, terminalId: "different-session" })), closePane: close }, outbound: { enqueueCard: vi.fn(async () => undefined) }, presentation: cardKitPanePresentation, isBindingBusy: () => false, logger: { info: vi.fn(), warn: vi.fn() } });
    await workflow.scan();
    expect(close).not.toHaveBeenCalled();
    expect(store.createAutomaticPaneCloseOperation).not.toHaveBeenCalled();
  });

  it("uses one bulk snapshot for multiple candidates and refreshes only before close", async () => {
    const second = { ...binding(), id: "b2", paneId: "w1:p2", topicId: "t2", rootMessageId: "r2" };
    const paneTwo = { ...pane, paneId: "w1:p2" };
    const listAllPanes = vi.fn(async () => [pane, paneTwo]);
    const getPane = vi.fn(async (paneId: string) => paneId === "w1:p1" ? pane : paneTwo);
    const store = { listBindings: () => [binding(), second], listUnresolvedPaneCloseOperations: () => [], countPendingPrompts: () => 0, getBinding: (id: string) => id === "b1" ? binding() : second, createAutomaticPaneCloseOperation: vi.fn(), finishPaneCloseRequest: vi.fn(), transitionBinding: vi.fn((id: string, transition: { type: string }) => ({ ...(id === "b1" ? binding() : second), id, lifecycle: transition.type === "closed" ? "closed" : "draining" })) };
    const workflow = new PaneRetentionWorkflow({ projects: [project], store: store as never, herdr: { listAllPanes, getPane, closePane: vi.fn() }, presentation: cardKitPanePresentation, isBindingBusy: () => false, logger: { info: vi.fn(), warn: vi.fn() } });

    await workflow.scan();

    expect(listAllPanes).toHaveBeenCalledOnce();
    expect(getPane).toHaveBeenCalledTimes(4);
  });
});
