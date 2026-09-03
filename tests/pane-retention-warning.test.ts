import { describe, expect, it, vi } from "vitest";
import { PaneRetentionWorkflow } from "../src/coordinator/pane-retention-workflow.js";
import type { Binding, HerdrPane, ProjectConfig } from "../src/domain/types.js";

const binding: Binding = { id: "b1", creatorOpenId: null, projectId: "p1", workspaceId: "w1", chatId: "c1", topicId: null, rootMessageId: "r1", retiredTopicId: null, retiredRootMessageId: null, reservedTopicId: null, reservedRootMessageId: null, resetMessageId: null, paneId: "w1:p1", traexSessionId: "t1", title: "test", runtime: "traex", state: "active", statusMessageId: null, statusCardSequence: 0, lastAgentState: "idle", lastOutputFingerprint: null, lifecycle: "active", attachment: "attached", generation: 1, provisioningCheckpoint: "activated", degradationCount: 0, hasCompletedTurn: true, lastObservedAt: null, archivedAt: null, lastActivityAt: "2026-08-27T00:00:00.000Z", createdAt: "2026-08-27T00:00:00.000Z", updatedAt: "2026-08-27T00:00:00.000Z" };
const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", terminalId: "t1", agentState: "idle", cwd: "/repo", label: null, foregroundExecutables: [] };
const project: ProjectConfig = { id: "p1", displayName: "p1", description: "test", workspaceId: "w1", cwd: "/repo", paneRetention: { mode: "ephemeral" } };

describe("PaneRetentionWorkflow warning", () => {
  it("enqueues one idempotent warning during the grace period", async () => {
    const enqueueCard = vi.fn(async () => undefined);
    const store = { listBindings: () => [binding], listUnresolvedPaneCloseOperations: () => [], countPendingPrompts: () => 0, getBinding: () => binding, createAutomaticPaneCloseOperation: vi.fn(), finishPaneCloseRequest: vi.fn(), transitionBinding: vi.fn() };
    const workflow = new PaneRetentionWorkflow({ projects: [project], store: store as never, herdr: { getPane: vi.fn(async () => pane), closePane: vi.fn() }, outbound: { enqueueCard }, isBindingBusy: () => false, logger: { info: vi.fn(), warn: vi.fn() } });
    await workflow.scan();
    expect(enqueueCard).toHaveBeenCalledWith("r1", expect.stringMatching(/^pane-retention-warning:b1:/), expect.any(Object), "b1", "operation_result");
  });
});
