import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeDriver } from "../src/domain/agent-runtime.js";
import type { PaneHost } from "../src/runtime/herdr/pane-host.js";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import { InstanceControlWorkflow } from "../src/coordinator/instance-control-workflow.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import type { WorktreeManager } from "../src/runtime/worktree-manager.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

const project = { id: "project-a", displayName: "Project A", description: "A", workspaceId: "herdr-a", cwd: "/repo", maxInstances: 4, instances: [] };
const pane = { paneId: "herdr-a:p1", workspaceId: "herdr-a", cwd: "/repo", label: null, agentState: "idle" as const, foregroundExecutables: ["traex"], agentKind: "traex", terminalId: "term-1" };

function setup(overrides: { start?: () => Promise<void>; prepare?: WorktreeManager["prepare"] } = {}) {
  store = new SqliteBindingStore(":memory:");
  let allocatedPane = pane;
  const paneHost = {
    ensureWorkspace: vi.fn(async () => undefined), allocatePane: vi.fn(async (_workspace: string, cwd: string) => { allocatedPane = { ...pane, cwd }; return allocatedPane; }),
    inspectPane: vi.fn(async () => allocatedPane), releasePane: vi.fn(async () => undefined)
  } as unknown as PaneHost;
  const driver: AgentRuntimeDriver = {
    kind: "traex", describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "terminal-input", interrupt: "terminal-signal", approvals: "terminal", modelSelection: "runtime", usageReporting: true }),
    start: vi.fn(overrides.start ?? (async () => undefined)), submit: vi.fn(async () => ({ status: "confirmed-delivered" }))
  };
  const worktrees = {
    prepare: vi.fn(overrides.prepare ?? (async (input) => ({ cwd: input.targetPath, branch: input.branch, baseCommit: "base-sha", headCommit: "base-sha" }))),
    planRemoval: vi.fn(async (input) => ({ ...input, safe: true, reason: "clean" as const, fingerprint: "fingerprint-1", inspection: null })), release: vi.fn(async () => undefined)
  } as unknown as WorktreeManager;
  const workflow = new InstanceControlWorkflow({ projects: [project], store, paneHost, drivers: new AgentDriverRegistry([driver]), worktrees, idFactory: (() => { let n = 0; return () => `id-${++n}`; })() });
  return { workflow, paneHost, driver, worktrees };
}

describe("InstanceControlWorkflow", () => {
  it("creates and starts a primary in the main checkout without creating a worktree", async () => {
    const { workflow, worktrees, paneHost } = setup();
    const instance = await workflow.create({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "primary", role: "primary", agentKind: "traex", model: null, start: true });
    expect(instance).toMatchObject({ role: "primary", desiredState: "running", observedState: "idle", generation: 2, provisioningCheckpoint: "verified", runtimeRef: { paneId: "herdr-a:p1" } });
    expect(workflow.inspect(instance.id).workspace).toMatchObject({ kind: "main-checkout", cwd: "/repo", state: "ready" });
    expect(worktrees.prepare).not.toHaveBeenCalled();
    expect(paneHost.allocatePane).toHaveBeenCalledWith("herdr-a", "/repo", expect.objectContaining({ bindingId: instance.id, projectId: "project-a" }));
  });

  it("allocates a named branch and isolated worktree for an explicit worker", async () => {
    const { workflow, worktrees } = setup();
    const instance = await workflow.create({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", role: "worker", agentKind: "traex", model: null, start: true });
    expect(worktrees.prepare).toHaveBeenCalledWith({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/reviewer", branch: "solo/reviewer", baseRef: "HEAD" });
    expect(workflow.inspect(instance.id).workspace).toMatchObject({ kind: "git-worktree", cwd: "/repo/.worktree/reviewer", branch: "solo/reviewer", baseCommit: "base-sha", state: "ready" });
  });

  it("persists the workspace checkpoint when runtime launch fails", async () => {
    const { workflow } = setup({ start: async () => { throw new Error("launch failed"); } });
    await expect(workflow.create({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", role: "worker", agentKind: "traex", model: null, start: true })).rejects.toThrow("launch failed");
    const [instance] = workflow.list("project-a");
    expect(instance).toMatchObject({ observedState: "failed", provisioningCheckpoint: "pane-allocated", lastError: "launch failed" });
    expect(workflow.inspect(instance!.id).workspace).toMatchObject({ state: "ready" });
  });

  it("switches the sole primary only through a human control request", async () => {
    const { workflow } = setup();
    const first = await workflow.create({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "one", role: "primary", agentKind: "traex", model: null, start: false });
    const second = await workflow.create({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "two", role: "worker", agentKind: "traex", model: null, start: false });
    expect(workflow.setPrimary({ actor: { kind: "primary-agent", projectId: "project-a", instanceId: first.id, generation: 1 }, projectId: "project-a", instanceId: second.id })).toMatchObject({ ok: false, reason: "human_required" });
    expect(workflow.setPrimary({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: second.id })).toMatchObject({ ok: true, instance: { role: "primary" } });
    expect(workflow.list("project-a").filter(({ role }) => role === "primary")).toHaveLength(1);
  });

  it("stops a running instance but retains its worktree", async () => {
    const { workflow, paneHost, worktrees } = setup();
    const instance = await workflow.create({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", role: "worker", agentKind: "traex", model: null, start: true });
    await expect(workflow.stop({ actor: { kind: "human", userId: "u1" }, instanceId: instance.id })).resolves.toMatchObject({ desiredState: "stopped", observedState: "stopped", runtimeRef: null });
    expect(paneHost.releasePane).toHaveBeenCalledWith("herdr-a:p1");
    expect(worktrees.release).not.toHaveBeenCalled();
  });

  it("starts a stopped instance in a fresh pane generation while retaining its workspace", async () => {
    const { workflow, paneHost, worktrees } = setup();
    const created = await workflow.create({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", role: "worker", agentKind: "traex", model: null, start: true });
    await workflow.stop({ actor: { kind: "human", userId: "u1" }, instanceId: created.id });
    const restarted = await workflow.start({ actor: { kind: "human", userId: "u1" }, instanceId: created.id });
    expect(restarted).toMatchObject({ desiredState: "running", observedState: "idle", generation: 3, provisioningCheckpoint: "verified" });
    expect(worktrees.prepare).toHaveBeenCalledTimes(1);
    expect(paneHost.allocatePane).toHaveBeenCalledTimes(2);
  });

  it("persists a removal plan and removes a stopped worker only after matching confirmation", async () => {
    const { workflow, worktrees } = setup();
    const created = await workflow.create({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", role: "worker", agentKind: "traex", model: null, start: false });
    const plan = await workflow.planRemoval({ actor: { kind: "human", userId: "u1" }, instanceId: created.id });
    expect(plan).toMatchObject({ instanceId: created.id, safe: true, reason: "clean", state: "pending", worktreeFingerprint: "fingerprint-1" });
    await expect(workflow.confirmRemoval({ actor: { kind: "human", userId: "u1" }, planId: plan.id })).resolves.toBe(true);
    expect(worktrees.release).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: "fingerprint-1" }), 1);
    expect(workflow.list("project-a")).toEqual([]);
  });

  it("retains unsafe worktrees and rejects stale removal confirmations", async () => {
    const { workflow, worktrees } = setup();
    vi.mocked(worktrees.planRemoval).mockResolvedValueOnce({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/reviewer", baseCommit: "HEAD", leaseGeneration: 1, safe: false, reason: "dirty", fingerprint: "dirty-fp", inspection: null });
    const created = await workflow.create({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", role: "worker", agentKind: "traex", model: null, start: false });
    const unsafe = await workflow.planRemoval({ actor: { kind: "human", userId: "u1" }, instanceId: created.id });
    expect(unsafe).toMatchObject({ safe: false, reason: "dirty" });
    await expect(workflow.confirmRemoval({ actor: { kind: "human", userId: "u1" }, planId: unsafe.id })).rejects.toThrow(/not safe/);
    expect(workflow.list("project-a")).toHaveLength(1);
  });
});
