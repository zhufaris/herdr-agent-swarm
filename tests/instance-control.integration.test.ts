import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeDriver } from "../src/domain/agent-runtime.js";
import type { AgentKind } from "../src/domain/agent-instance.js";
import type { PaneHost } from "../src/runtime/herdr/pane-host.js";
import { AgentDriverRegistry } from "../src/runtime/agents/agent-driver.js";
import { InstanceControlWorkflow } from "../src/coordinator/instance-control-workflow.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import type { WorktreeManager } from "../src/runtime/worktree-manager.js";
import { primaryPaneToken } from "../src/domain/pane-title.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

const project = { id: "project-a", displayName: "Project A", description: "A", workspaceId: "herdr-a", cwd: "/repo", maxInstances: 4 };
const pane = { paneId: "herdr-a:p1", workspaceId: "herdr-a", cwd: "/repo", label: null, agentState: "idle" as const, foregroundExecutables: ["traex"], agentKind: "traex", terminalId: "term-1" };
const primaryPane = { ...pane, paneId: "herdr-a:primary", label: "lark_ilcs" };

function setup(overrides: { start?: () => Promise<void>; prepare?: WorktreeManager["prepare"]; primaryTools?: { issue: ReturnType<typeof vi.fn>; configuration: ReturnType<typeof vi.fn> }; agentKind?: AgentKind; observedAgentKind?: string } = {}) {
  store = new SqliteBindingStore(":memory:");
  let allocatedPane = pane;
  const paneHost = {
    ensureWorkspace: vi.fn(async () => undefined), allocatePane: vi.fn(async (_workspace: string, cwd: string) => { allocatedPane = { ...pane, cwd }; return allocatedPane; }),
    inspectPane: vi.fn(async (paneId: string) => paneId === primaryPane.paneId ? primaryPane : { ...allocatedPane, ...(overrides.observedAgentKind ? { agentKind: overrides.observedAgentKind } : {}) }), releasePane: vi.fn(async () => undefined)
  } as unknown as PaneHost;
  const driver: AgentRuntimeDriver = {
    kind: overrides.agentKind ?? "traex", describe: () => ({ available: true, structuredEvents: true, nativeResume: true, primaryTools: true, steering: "unsupported", interrupt: "native", approvals: "terminal", modelSelection: "startup-only", usageReporting: true }),
    start: vi.fn(overrides.start ?? (async () => undefined)), submit: vi.fn(async () => ({ status: "confirmed-delivered" }))
  };
  const worktrees = {
    prepare: vi.fn(overrides.prepare ?? (async (input) => ({ cwd: input.targetPath, branch: input.branch, baseCommit: "base-sha", headCommit: "base-sha" }))),
    planRemoval: vi.fn(async (input) => ({ ...input, safe: true, reason: "clean" as const, fingerprint: "fingerprint-1", inspection: null })), release: vi.fn(async () => undefined)
  } as unknown as WorktreeManager;
  store.createPendingBinding({ id: "binding-1", projectId: "project-a", workspaceId: "herdr-a", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1", title: "Primary task" });
  store.updateBinding("binding-1", { paneId: primaryPane.paneId, traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached" });
  const workflow = new InstanceControlWorkflow({ projects: [project], store, paneHost, drivers: new AgentDriverRegistry([driver]), worktrees, idFactory: (() => { let n = 0; return () => `id-${++n}`; })(), ...(overrides.primaryTools ? { primaryTools: overrides.primaryTools } : {}) });
  const createWorker = workflow.createWorker.bind(workflow);
  workflow.createWorker = (command) => createWorker({ ...command, bindingId: command.bindingId ?? "binding-1" });
  return { workflow, paneHost, driver, worktrees };
}

describe("InstanceControlWorkflow", () => {
  it("accepts Herdr's canonical claude kind for a Claude Code instance", async () => {
    const { workflow } = setup({ agentKind: "claude-code", observedAgentKind: "claude" });
    await expect(workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "claude-code", model: null, start: true, bindingId: "binding-1" })).resolves.toMatchObject({ status: "created", instance: { agentKind: "claude-code", observedState: "idle" } });
  });

  it("accepts Herdr's codex label for the TraeCode distribution", async () => {
    const { workflow } = setup({ observedAgentKind: "codex" });
    await expect(workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true, bindingId: "binding-1" })).resolves.toMatchObject({ status: "created", instance: { agentKind: "traex", observedState: "idle" } });
  });

  it("creates a Worker for a native TraeX Primary identity", async () => {
    const { workflow, paneHost } = setup();
    store!.updateBinding("binding-1", {
      traexSessionId: "term_65aa3500203c441", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "01a06b58-1cfd-7c81-b11e-afb1cd7c2cee"
    });
    vi.mocked(paneHost.inspectPane).mockResolvedValueOnce({
      ...primaryPane, terminalId: "term_65aa3500203c441",
      agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "01a06b58-1cfd-7c81-b11e-afb1cd7c2cee" }
    });

    await expect(workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: false, bindingId: "binding-1" }))
      .resolves.toMatchObject({ status: "created", instance: { parent: { nativeSessionId: "01a06b58-1cfd-7c81-b11e-afb1cd7c2cee" } } });
  });

  it("rejects genuine terminal and native Primary replacement", async () => {
    const { workflow, paneHost } = setup();
    store!.updateBinding("binding-1", { agentSessionSource: "herdr:codex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const command = { actor: { kind: "human" as const, userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex" as const, model: null, start: false, bindingId: "binding-1" };
    vi.mocked(paneHost.inspectPane).mockResolvedValueOnce({ ...primaryPane, terminalId: "terminal-replaced", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" } });
    await expect(workflow.createWorker(command)).rejects.toThrow("Worker parent pane identity changed");
    vi.mocked(paneHost.inspectPane).mockResolvedValueOnce({ ...primaryPane, terminalId: "term-1", agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-replaced" } });
    await expect(workflow.createWorker(command)).rejects.toThrow("Worker parent pane identity changed");
  });

  it("allocates a named branch and isolated worktree for an explicit worker", async () => {
    const { workflow, worktrees } = setup();
    const { instance } = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true });
    expect(worktrees.prepare).toHaveBeenCalledWith({ repositoryRoot: "/repo", targetPath: expect.stringMatching(/^\/repo\/.worktree\/lark-[a-f0-9]{10}-reviewer$/), branch: expect.stringMatching(/^swarm\/lark-[a-f0-9]{10}-reviewer$/), baseRef: "HEAD" });
    expect(workflow.inspect(instance.id).workspace).toMatchObject({ kind: "git-worktree", cwd: expect.stringMatching(/^\/repo\/.worktree\/lark-[a-f0-9]{10}-reviewer$/), branch: expect.stringMatching(/^swarm\/lark-[a-f0-9]{10}-reviewer$/), baseCommit: "base-sha", state: "ready" });
  });

  it("allows the same Worker name under different Primary panes with isolated resources", async () => {
    const { workflow, paneHost } = setup();
    store!.createPendingBinding({ id: "binding-2", projectId: "project-a", workspaceId: "herdr-a", chatId: "chat-1", topicId: "topic-2", rootMessageId: "root-2", title: "Primary two" });
    store!.updateBinding("binding-2", { paneId: "herdr-a:primary-2", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached" });
    vi.mocked(paneHost.inspectPane).mockImplementation(async (paneId: string) => paneId === primaryPane.paneId ? primaryPane : paneId === "herdr-a:primary-2" ? { ...primaryPane, paneId, label: "lark_task-two" } : pane);
    const first = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: false, bindingId: "binding-1" });
    const second = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: false, bindingId: "binding-2" });

    expect(first.instance.parent).toMatchObject({ bindingId: "binding-1", paneId: primaryPane.paneId });
    expect(second.instance.parent).toMatchObject({ bindingId: "binding-2", paneId: "herdr-a:primary-2" });
    expect(workflow.inspect(first.instance.id).workspace.cwd).not.toBe(workflow.inspect(second.instance.id).workspace.cwd);
    await expect(workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: false, bindingId: "binding-1" })).rejects.toThrow(/already exists in this Primary/);
  });

  it.each(["ilcs", "lark_ilcs", "LARK_ILCS", "lark_task-ilcs", "task-ilcs"])("reuses the Primary token from %s in the Worker pane title", async (label) => {
    const { workflow, paneHost } = setup();
    vi.mocked(paneHost.inspectPane).mockImplementation(async (paneId: string) => paneId === primaryPane.paneId ? { ...primaryPane, label } : pane);

    await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true, bindingId: "binding-1" });

    expect(paneHost.allocatePane).toHaveBeenLastCalledWith("herdr-a", expect.stringMatching(/^\/repo\/.worktree\/lark-[a-f0-9]{10}-reviewer$/), expect.objectContaining({ title: "lark_ilcs-reviewer", titlePolicy: "complete" }));
  });

  it("reuses one Primary token across sibling Worker pane titles", async () => {
    const { workflow, paneHost } = setup();

    await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true, bindingId: "binding-1" });
    await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "tester", agentKind: "traex", model: null, start: true, bindingId: "binding-1" });

    expect(vi.mocked(paneHost.allocatePane).mock.calls.map((call) => call[2]?.title)).toEqual(["lark_ilcs-reviewer", "lark_ilcs-tester"]);
  });

  it("scopes Herdr agent names to the parent Primary token", async () => {
    const { workflow, driver } = setup();

    await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "test", agentKind: "traex", model: null, start: true, bindingId: "binding-1" });

    expect(vi.mocked(driver.start)).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ managedName: "ilcs-test" }));
  });

  it.each(["task-reviewer", "lark_ops"])("preserves the validated Worker name %s in the pane title", async (name) => {
    const { workflow, paneHost } = setup();

    await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name, agentKind: "traex", model: null, start: true, bindingId: "binding-1" });

    expect(paneHost.allocatePane).toHaveBeenLastCalledWith("herdr-a", expect.any(String), expect.objectContaining({ title: `lark_ilcs-${name}`, titlePolicy: "complete" }));
  });

  it.each([null, "primary-ilcs", "prefix-lark_ilcs", "lark_ilcs-extra"])("uses the parent pane ID when the Primary label is noncanonical: %s", async (label) => {
    const { workflow, paneHost } = setup();
    vi.mocked(paneHost.inspectPane).mockImplementation(async (paneId: string) => paneId === primaryPane.paneId ? { ...primaryPane, label } : pane);

    await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true, bindingId: "binding-1" });

    const token = primaryPaneToken(label, primaryPane.paneId);
    expect(paneHost.allocatePane).toHaveBeenLastCalledWith("herdr-a", expect.any(String), expect.objectContaining({ title: `lark_${token}-reviewer`, titlePolicy: "complete" }));
  });

  it("persists the source Primary pane label in the first Worker pane title", async () => {
    const { workflow, paneHost } = setup();
    store!.updateBinding("binding-1", { paneId: "primary-pane-id", traexSessionId: "term-1" });
    vi.mocked(paneHost.inspectPane).mockImplementation(async (paneId: string) => paneId === "primary-pane-id"
      ? { ...pane, paneId, cwd: "/repo", label: "lark_ilcs" }
      : { ...pane, paneId, cwd: String(vi.mocked(paneHost.allocatePane).mock.calls.at(-1)?.[1]), label: null });

    const { instance } = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true, bindingId: "binding-1" });
    expect(paneHost.allocatePane).toHaveBeenLastCalledWith("herdr-a", expect.stringMatching(/^\/repo\/.worktree\/lark-[a-f0-9]{10}-reviewer$/), expect.objectContaining({ title: "lark_ilcs-reviewer", titlePolicy: "complete" }));
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ sourcePrimaryPaneLabel: "lark_ilcs", parent: { bindingId: "binding-1", paneId: "primary-pane-id" } });

    await workflow.stop({ actor: { kind: "human", userId: "u1" }, instanceId: instance.id });
    await expect(workflow.start({ actor: { kind: "human", userId: "u1" }, instanceId: instance.id })).rejects.toThrow(/cannot be restarted/);
  });

  it("requires a parent binding when the caller does not provide a binding context", async () => {
    const { workflow } = setup();
    const direct = Object.getPrototypeOf(workflow).createWorker.bind(workflow);
    await expect(direct({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true })).rejects.toThrow(/requires an active Primary pane/);
  });

  it("persists the workspace checkpoint when runtime launch fails", async () => {
    const { workflow } = setup({ start: async () => { throw new Error("launch failed Bearer live-secret"); } });
    await expect(workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true })).resolves.toMatchObject({ status: "created-start-failed", error: "launch failed Bearer [REDACTED]", instance: { observedState: "failed", lastError: "launch failed Bearer [REDACTED]" } });
    const [instance] = workflow.listWorkers("project-a");
    expect(instance).toMatchObject({ observedState: "failed", provisioningCheckpoint: "pane-allocated", lastError: "launch failed Bearer [REDACTED]" });
    expect(workflow.inspect(instance!.id).workspace).toMatchObject({ state: "ready" });
  });

  it("releases a pending pane before stopping a failed startup", async () => {
    const { workflow, paneHost } = setup({ start: async () => { throw new Error("launch failed"); } });
    const result = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true });
    expect(result).toMatchObject({ status: "created-start-failed", instance: { pendingRuntimeRef: { paneId: "herdr-a:p1" } } });

    await expect(workflow.stop({ actor: { kind: "human", userId: "u1" }, instanceId: result.instance.id })).resolves.toMatchObject({ desiredState: "stopped", pendingRuntimeRef: null });
    expect(paneHost.releasePane).toHaveBeenCalledWith("herdr-a:p1");
  });

  it("keeps pending pane ownership when release during stop fails", async () => {
    const { workflow, paneHost } = setup({ start: async () => { throw new Error("launch failed"); } });
    const result = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true });
    vi.mocked(paneHost.releasePane).mockRejectedValueOnce(new Error("release failed"));

    await expect(workflow.stop({ actor: { kind: "human", userId: "u1" }, instanceId: result.instance.id })).rejects.toThrow("release failed");
    expect(store!.getAgentInstance(result.instance.id)).toMatchObject({ desiredState: "running", observedState: "failed", pendingRuntimeRef: { paneId: "herdr-a:p1" }, lastError: "release failed" });
    await expect(workflow.planRemoval({ actor: { kind: "human", userId: "u1" }, instanceId: result.instance.id })).rejects.toThrow("stopped");
  });

  it("counts only Workers against the project limit and preserves legacy Primary rows", async () => {
    const { workflow } = setup();
    store!.createAgentInstance({ id: "legacy-primary", projectId: "project-a", name: "legacy", role: "primary", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "legacy-ws", kind: "main-checkout", cwd: "/repo", branch: null, baseCommit: "base" } });
    for (const name of ["one", "two", "three", "four"]) await expect(workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name, agentKind: "traex", model: null, start: false })).resolves.toMatchObject({ status: "created", instance: { role: "worker" } });
    await expect(workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "five", agentKind: "traex", model: null, start: false })).rejects.toThrow("Worker limit");
    expect(workflow.listWorkers("project-a")).toHaveLength(4);
    expect(store!.getAgentInstance("legacy-primary")).toMatchObject({ role: "primary" });
  });

  it("stops a running instance but retains its worktree", async () => {
    const { workflow, paneHost, worktrees } = setup();
    const { instance } = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true });
    await expect(workflow.stop({ actor: { kind: "human", userId: "u1" }, instanceId: instance.id })).resolves.toMatchObject({ desiredState: "stopped", observedState: "stopped", runtimeRef: null });
    expect(paneHost.releasePane).toHaveBeenCalledWith("herdr-a:p1");
    expect(worktrees.release).not.toHaveBeenCalled();
  });

  it("refuses to stop an instance with current-generation active work", async () => {
    const { workflow, paneHost } = setup();
    const { instance } = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true });
    store!.acceptInstanceTurn({ id: "turn", idempotencyKey: "turn", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "work" });
    store!.claimNextInstanceTurn(instance.id, instance.generation);
    await expect(workflow.stop({ actor: { kind: "human", userId: "u1" }, instanceId: instance.id })).rejects.toThrow(/active or uncertain turn/i);
    expect(paneHost.releasePane).not.toHaveBeenCalled();
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ desiredState: "running", runtimeRef: { paneId: "herdr-a:p1" } });
  });

  it("restores running intent when pane release fails", async () => {
    const { workflow, paneHost } = setup();
    const { instance } = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true });
    vi.mocked(paneHost.releasePane).mockRejectedValueOnce(new Error("close failed"));
    await expect(workflow.stop({ actor: { kind: "human", userId: "u1" }, instanceId: instance.id })).rejects.toThrow("close failed");
    expect(store!.getAgentInstance(instance.id)).toMatchObject({ desiredState: "running", runtimeRef: { paneId: "herdr-a:p1" }, lastError: "close failed" });
  });

  it("does not restart a stopped Worker in a replacement pane", async () => {
    const { workflow, paneHost, worktrees } = setup();
    const { instance: created } = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: true });
    await workflow.stop({ actor: { kind: "human", userId: "u1" }, instanceId: created.id });
    await expect(workflow.start({ actor: { kind: "human", userId: "u1" }, instanceId: created.id })).rejects.toThrow(/cannot be restarted/);
    expect(worktrees.prepare).toHaveBeenCalledTimes(1);
    expect(paneHost.allocatePane).toHaveBeenCalledTimes(1);
  });

  it("persists a removal plan and removes a stopped worker only after matching confirmation", async () => {
    const { workflow, worktrees } = setup();
    const { instance: created } = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: false });
    const plan = await workflow.planRemoval({ actor: { kind: "human", userId: "u1" }, instanceId: created.id });
    expect(plan).toMatchObject({ instanceId: created.id, safe: true, reason: "clean", state: "pending", worktreeFingerprint: "fingerprint-1" });
    await expect(workflow.confirmRemoval({ actor: { kind: "human", userId: "u1" }, planId: plan.id })).resolves.toBe(true);
    expect(worktrees.release).toHaveBeenCalledWith(expect.objectContaining({ fingerprint: "fingerprint-1" }), 1);
    expect(workflow.listWorkers("project-a")).toEqual([]);
  });

  it("retains unsafe worktrees and rejects stale removal confirmations", async () => {
    const { workflow, worktrees } = setup();
    vi.mocked(worktrees.planRemoval).mockResolvedValueOnce({ repositoryRoot: "/repo", targetPath: "/repo/.worktree/reviewer", baseCommit: "HEAD", leaseGeneration: 1, safe: false, reason: "dirty", fingerprint: "dirty-fp", inspection: null });
    const { instance: created } = await workflow.createWorker({ actor: { kind: "human", userId: "u1" }, projectId: "project-a", name: "reviewer", agentKind: "traex", model: null, start: false });
    const unsafe = await workflow.planRemoval({ actor: { kind: "human", userId: "u1" }, instanceId: created.id });
    expect(unsafe).toMatchObject({ safe: false, reason: "dirty" });
    await expect(workflow.confirmRemoval({ actor: { kind: "human", userId: "u1" }, planId: unsafe.id })).rejects.toThrow(/not safe/);
    expect(workflow.listWorkers("project-a")).toHaveLength(1);
  });

  it("never confirms a persisted removal plan for a legacy Primary", async () => {
    const { workflow, worktrees } = setup();
    const legacy = store!.createAgentInstance({ id: "legacy-primary", projectId: "project-a", name: "legacy", role: "primary", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "legacy-ws", kind: "main-checkout", cwd: "/repo", branch: null, baseCommit: "base" } });
    const workspace = store!.getWorkspaceLease(legacy.workspaceLeaseId)!;
    store!.createInstanceRemovalPlan({ id: "legacy-plan", instanceId: legacy.id, instanceGeneration: legacy.generation, workspaceGeneration: workspace.generation, worktreeFingerprint: null, safe: true, reason: "main-checkout", state: "pending", createdAt: "now" });

    await expect(workflow.confirmRemoval({ actor: { kind: "human", userId: "u1" }, planId: "legacy-plan" })).rejects.toThrow("Only Worker");
    expect(store!.getAgentInstance(legacy.id)).toMatchObject({ role: "primary" });
    expect(store!.getInstanceRemovalPlan("legacy-plan")).toMatchObject({ state: "pending" });
    expect(worktrees.release).not.toHaveBeenCalled();
  });
});
