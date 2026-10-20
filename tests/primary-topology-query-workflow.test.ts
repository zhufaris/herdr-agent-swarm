import { describe, expect, it, vi } from "vitest";
import { PrimaryTopologyQueryWorkflow } from "../src/coordinator/primary-topology-query-workflow.js";
import type { Binding, ProjectConfig } from "../src/domain/types.js";

const project: ProjectConfig = { id: "project", displayName: "Project", description: "Managed project", spaceName: "team", workspaceId: "workspace", cwd: "/project", orchestrator: { enabled: true, cwd: "/orchestrator" } };
const binding = (overrides: Partial<Binding> = {}): Binding => ({ id: "binding", kind: "task", gatewayId: "feishu", projectId: "project", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", statusMessageId: "status", title: "Task", creatorOpenId: "user", state: "active", lifecycle: "active", attachment: "attached", generation: 1, paneId: "task-pane", terminalId: null, paneToken: "task", primaryToolCapabilityHash: null, cwd: "/project", lastAgentState: "idle", agentKind: "traex", agentModel: null, provisioningCheckpoint: "ready", lastError: null, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", ...overrides });

describe("PrimaryTopologyQueryWorkflow", () => {
  it("returns normalized configured Spaces and managed/discoverable same-project Panes", async () => {
    const listPanes = vi.fn(async () => [
      { paneId: "task-pane", paneToken: "task", workspaceId: "workspace", cwd: "/project", label: "Task", agentKind: "traex", agentState: "idle" as const, foregroundExecutables: ["traex"] },
      { paneId: "worker-pane", paneToken: "work", workspaceId: "workspace", cwd: "/worker", label: "Worker", agentKind: "codex", agentState: "busy" as const, foregroundExecutables: ["codex"] },
      { paneId: "discoverable-pane", paneToken: "disc", workspaceId: "workspace", cwd: "/orchestrator", label: "Manual", agentKind: null, agentState: "idle" as const, foregroundExecutables: ["bash"] },
      { paneId: "unrelated-pane", paneToken: "nope", workspaceId: "workspace", cwd: "/elsewhere", label: "Other", agentState: "idle" as const, foregroundExecutables: ["bash"] }
    ]);
    const store = {
      listBindings: () => [binding(), binding({ id: "other", projectId: "other", paneId: "unrelated-pane" })],
      listAgentInstances: () => [{ id: "worker", projectId: "project", name: "reviewer", role: "worker", generation: 2, runtimeRef: { paneId: "worker-pane" } }]
    } as never;
    const workflow = new PrimaryTopologyQueryWorkflow({ projects: [project], store, herdr: { listPanes } });

    expect(workflow.listSpaces("project")).toEqual([{ projectId: "project", displayName: "Project", description: "Managed project", spaceName: "team", workspaceId: "workspace", directories: ["/project", "/orchestrator"] }]);
    await expect(workflow.listPanes("project")).resolves.toEqual([
      expect.objectContaining({ paneId: "discoverable-pane", name: "Manual", cwd: "/orchestrator", ownership: null }),
      expect.objectContaining({ paneId: "task-pane", ownership: { kind: "binding", bindingId: "binding", bindingKind: "task", generation: 1 } }),
      expect.objectContaining({ paneId: "worker-pane", ownership: { kind: "worker", instanceId: "worker", workerName: "reviewer", generation: 2 } })
    ]);
    expect(listPanes).toHaveBeenCalledWith("workspace");
  });

  it("rejects an unknown project instead of widening scope", async () => {
    const workflow = new PrimaryTopologyQueryWorkflow({ projects: [project], store: { listBindings: () => [], listAgentInstances: () => [] } as never, herdr: { listPanes: vi.fn() } as never });
    expect(() => workflow.listSpaces("other")).toThrow(/not configured/);
    await expect(workflow.listPanes("other")).rejects.toThrow(/not configured/);
  });
});
