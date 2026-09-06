import { describe, expect, it, vi } from "vitest";
import { PaneRetentionWorkflow } from "../src/coordinator/pane-retention-workflow.js";
import type { Binding, HerdrPane, ProjectConfig } from "../src/domain/types.js";

const pane: HerdrPane = { paneId: "w1:p1", workspaceId: "w1", terminalId: "t1", agentState: "idle", cwd: "/repo", label: null, foregroundExecutables: [] };
const project: ProjectConfig = { id: "p1", displayName: "p1", description: "test", workspaceId: "w1", cwd: "/repo", paneRetention: { mode: "ephemeral" } };

describe("PaneRetentionWorkflow warning", () => {
  it("enqueues one idempotent warning during the grace period", async () => {
    const lastActivityAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
    const binding: Binding = { id: "b1", creatorOpenId: null, projectId: "p1", workspaceId: "w1", chatId: "c1", topicId: null, rootMessageId: "r1", retiredTopicId: null, retiredRootMessageId: null, reservedTopicId: null, reservedRootMessageId: null, resetMessageId: null, paneId: "w1:p1", traexSessionId: "t1", title: "test", runtime: "traex", state: "active", statusMessageId: null, statusCardSequence: 0, lastAgentState: "idle", lastOutputFingerprint: null, lifecycle: "active", attachment: "attached", generation: 1, provisioningCheckpoint: "activated", degradationCount: 0, hasCompletedTurn: true, lastObservedAt: null, archivedAt: null, lastActivityAt, createdAt: lastActivityAt, updatedAt: lastActivityAt };
    const enqueueCard = vi.fn(async () => undefined);
    const paneRetentionWarning = vi.fn(() => ({ rendered: "warning" }));
    const store = { listBindings: () => [binding], listUnresolvedPaneCloseOperations: () => [], countPendingPrompts: () => 0, getBinding: () => binding, createAutomaticPaneCloseOperation: vi.fn(), finishPaneCloseRequest: vi.fn(), transitionBinding: vi.fn() };
    const workflow = new PaneRetentionWorkflow({ projects: [project], store: store as never, herdr: { getPane: vi.fn(async () => pane), closePane: vi.fn() }, outbound: { enqueueCard }, presentation: { paneRetentionWarning }, isBindingBusy: () => false, logger: { info: vi.fn(), warn: vi.fn() } });
    await workflow.scan();
    expect(paneRetentionWarning).toHaveBeenCalledWith({ paneId: "w1:p1", warningAt: expect.any(String), closeAt: expect.any(String) });
    expect(enqueueCard).toHaveBeenCalledWith("r1", expect.stringMatching(/^pane-retention-warning:b1:/), { rendered: "warning" }, "b1", "operation_result");
  });
});
