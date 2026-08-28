import { join } from "node:path";
import type { CreateAgentInstanceInput, AgentInstance, InstanceRemovalPlan, WorkspaceLease } from "../domain/agent-instance.js";
import type { ControlActor, CreateInstanceCommand } from "../domain/commands.js";
import type { InstanceStore } from "../domain/ports.js";
import type { ProjectConfig } from "../domain/types.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import type { PaneHost } from "../runtime/herdr/pane-host.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { WorktreeManager } from "../runtime/worktree-manager.js";

interface Options {
  projects: readonly ProjectConfig[]; store: InstanceStore; paneHost: PaneHost; drivers: AgentDriverRegistry; worktrees: WorktreeManager; idFactory: () => string;
}

export class InstanceControlWorkflow {
  private readonly projects: ReadonlyMap<string, ProjectConfig>;
  constructor(private readonly options: Options) { this.projects = new Map(options.projects.map((project) => [project.id, project])); }

  async create(command: CreateInstanceCommand): Promise<AgentInstance> {
    this.requireHuman(command.actor);
    const project = this.requireProject(command.projectId);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(command.name)) throw new Error("Invalid instance name");
    if (this.list(project.id).length >= (project.maxInstances ?? 8)) throw new Error("Project instance limit reached");
    const driver = this.options.drivers.get(command.agentKind);
    if (!driver?.describe().available) throw new Error(`Agent adapter is unavailable: ${command.agentKind}`);
    if (command.role === "primary" && this.list(project.id).some(({ role }) => role === "primary")) throw new Error("Project already has a primary instance");
    const id = this.options.idFactory();
    const workspaceId = this.options.idFactory();
    const worker = command.role === "worker";
    const workspace: CreateAgentInstanceInput["workspace"] = worker
      ? { id: workspaceId, kind: "git-worktree", cwd: join(project.cwd, ".worktree", command.name), branch: `solo/${command.name}`, baseCommit: "HEAD" }
      : { id: workspaceId, kind: "main-checkout", cwd: project.cwd, branch: null, baseCommit: "HEAD" };
    const instance = this.options.store.createAgentInstance({ id, projectId: project.id, name: command.name, role: command.role, agentKind: command.agentKind, model: command.model, desiredState: command.start ? "running" : "stopped", workspace });
    return command.start ? this.start({ actor: command.actor, instanceId: instance.id }) : instance;
  }

  async start(input: { actor: ControlActor; instanceId: string }): Promise<AgentInstance> {
    this.requireHuman(input.actor);
    let instance = this.requireInstance(input.instanceId);
    if (instance.runtimeRef && instance.observedState !== "stopped") return instance;
    if (instance.desiredState !== "running") {
      const starting = this.options.store.updateAgentInstanceLifecycle({ instanceId: instance.id, expectedGeneration: instance.generation, desiredState: "running", observedState: "starting" });
      if (!starting) throw new Error("Instance generation changed while starting");
      instance = starting;
    }
    const project = this.requireProject(instance.projectId);
    const driver = this.options.drivers.get(instance.agentKind);
    if (!driver?.describe().available) throw new Error(`Agent adapter is unavailable: ${instance.agentKind}`);
    let workspace = this.requireWorkspace(instance.workspaceLeaseId);
    try {
      if (instance.provisioningCheckpoint === "verified" && !instance.runtimeRef) {
        instance = this.requireCheckpoint(instance, "workspace-ready", "starting");
      }
      if (instance.provisioningCheckpoint === "recorded") {
        if (workspace.kind === "git-worktree") {
          const prepared = await this.options.worktrees.prepare({ repositoryRoot: project.cwd, targetPath: workspace.cwd, branch: workspace.branch!, baseRef: workspace.baseCommit });
          workspace = this.requireUpdatedWorkspace({ id: workspace.id, expectedGeneration: workspace.generation, state: "ready", cwd: prepared.cwd, branch: prepared.branch, baseCommit: prepared.baseCommit });
        } else workspace = this.requireUpdatedWorkspace({ id: workspace.id, expectedGeneration: workspace.generation, state: "ready" });
        instance = this.requireCheckpoint(instance, "workspace-ready", "starting");
      }
      if (instance.provisioningCheckpoint === "workspace-ready") {
        await this.options.paneHost.ensureWorkspace(project.workspaceId);
        const pane = await this.options.paneHost.allocatePane(project.workspaceId, workspace.cwd, { bindingId: instance.id, generation: instance.generation, projectId: project.id, placement: "dedicated-tab", title: instance.name });
        instance = this.requireCheckpoint(instance, "pane-allocated", "starting", pane.paneId, project.workspaceId);
      }
      const pending = instance.pendingRuntimeRef;
      if (!pending) throw new Error("Provisioning pane checkpoint is missing");
      if (instance.provisioningCheckpoint === "pane-allocated") {
        await driver.start({ ...pending, nativeSessionId: null }, { projectId: instance.projectId, name: instance.name, model: instance.model });
        instance = this.requireCheckpoint(instance, "runtime-started", "starting");
      }
      if (instance.provisioningCheckpoint === "runtime-started") {
        const observed = await this.options.paneHost.inspectPane(pending.paneId);
        if (!observed || observed.workspaceId !== project.workspaceId || observed.cwd !== workspace.cwd) throw new Error("Started agent pane could not be verified");
        if (observed.agentKind && observed.agentKind !== instance.agentKind) throw new Error(`Started pane reported unexpected agent: ${observed.agentKind}`);
        const attached = this.options.store.attachAgentInstanceRuntime({ instanceId: instance.id, expectedGeneration: instance.generation, herdrWorkspaceId: project.workspaceId, paneId: pending.paneId, nativeSessionId: observed.agentSession?.value ?? observed.terminalId ?? null });
        if (!attached) throw new Error("Instance generation changed during runtime attachment");
        return attached;
      }
      return instance;
    } catch (error) {
      this.options.store.checkpointAgentInstance({ instanceId: instance.id, expectedGeneration: instance.generation, checkpoint: instance.provisioningCheckpoint, observedState: "failed", lastError: safeLogError(error).message });
      throw error;
    }
  }

  async stop(input: { actor: ControlActor; instanceId: string }): Promise<AgentInstance> {
    this.requireHuman(input.actor);
    const instance = this.requireInstance(input.instanceId);
    if (instance.runtimeRef) await this.options.paneHost.releasePane(instance.runtimeRef.paneId);
    const stopped = this.options.store.updateAgentInstanceLifecycle({ instanceId: instance.id, expectedGeneration: instance.generation, desiredState: "stopped", observedState: "stopped", clearRuntime: true });
    if (!stopped) throw new Error("Instance generation changed while stopping");
    return stopped;
  }

  setPrimary(input: { actor: ControlActor; projectId: string; instanceId: string }): { ok: true; instance: AgentInstance } | { ok: false; reason: "human_required" } {
    if (input.actor.kind !== "human") return { ok: false, reason: "human_required" };
    return { ok: true, instance: this.options.store.setPrimaryAgentInstance(input.projectId, input.instanceId) };
  }

  async planRemoval(input: { actor: ControlActor; instanceId: string }): Promise<InstanceRemovalPlan> {
    this.requireHuman(input.actor);
    const instance = this.requireInstance(input.instanceId);
    if (instance.desiredState !== "stopped" || instance.runtimeRef) throw new Error("Instance must be stopped before removal planning");
    const workspace = this.requireWorkspace(instance.workspaceLeaseId);
    const project = this.requireProject(instance.projectId);
    let safe = true;
    let reason: InstanceRemovalPlan["reason"] = workspace.kind === "main-checkout" ? "main-checkout" : "shared-read-only";
    let fingerprint: string | null = null;
    if (workspace.kind === "git-worktree") {
      const worktreePlan = await this.options.worktrees.planRemoval({ repositoryRoot: project.cwd, targetPath: workspace.cwd, baseCommit: workspace.baseCommit, leaseGeneration: workspace.generation });
      safe = worktreePlan.safe; reason = worktreePlan.reason; fingerprint = worktreePlan.fingerprint;
    }
    return this.options.store.createInstanceRemovalPlan({ id: this.options.idFactory(), instanceId: instance.id, instanceGeneration: instance.generation, workspaceGeneration: workspace.generation, worktreeFingerprint: fingerprint, safe, reason, state: "pending", createdAt: new Date().toISOString() });
  }

  async confirmRemoval(input: { actor: ControlActor; planId: string }): Promise<boolean> {
    this.requireHuman(input.actor);
    const plan = this.options.store.getInstanceRemovalPlan(input.planId);
    if (!plan) throw new Error("Removal plan not found");
    if (!plan.safe) throw new Error(`Removal plan is not safe: ${plan.reason}`);
    if (plan.state === "stale") throw new Error("Removal plan is stale");
    const instance = this.requireInstance(plan.instanceId);
    const workspace = this.requireWorkspace(instance.workspaceLeaseId);
    if (instance.generation !== plan.instanceGeneration || workspace.generation !== plan.workspaceGeneration) throw new Error("Removal plan is stale");
    if (plan.state === "pending") {
      const consumed = this.options.store.consumeInstanceRemovalPlan({ id: plan.id, instanceId: instance.id, instanceGeneration: instance.generation, workspaceGeneration: workspace.generation, worktreeFingerprint: plan.worktreeFingerprint });
      if (!consumed) throw new Error("Removal plan became stale");
    }
    const releasing = this.options.store.updateWorkspaceLease({ id: workspace.id, expectedGeneration: workspace.generation, state: "release-requested" });
    if (!releasing) throw new Error("Workspace lease generation changed during removal");
    if (workspace.kind === "git-worktree") {
      const project = this.requireProject(instance.projectId);
      await this.options.worktrees.release({ repositoryRoot: project.cwd, targetPath: workspace.cwd, baseCommit: workspace.baseCommit, leaseGeneration: workspace.generation, safe: true, reason: "clean", fingerprint: plan.worktreeFingerprint, inspection: null }, workspace.generation);
    }
    return this.options.store.removeAgentInstance({ instanceId: instance.id, expectedGeneration: instance.generation, expectedWorkspaceGeneration: workspace.generation });
  }

  inspect(instanceId: string): { instance: AgentInstance; workspace: WorkspaceLease } {
    const instance = this.requireInstance(instanceId);
    return { instance, workspace: this.requireWorkspace(instance.workspaceLeaseId) };
  }
  list(projectId: string): AgentInstance[] { return this.options.store.listAgentInstances(projectId); }

  private requireHuman(actor: ControlActor): void { if (actor.kind !== "human") throw new Error("Instance topology changes require a human actor"); }
  private requireProject(id: string): ProjectConfig { const value = this.projects.get(id); if (!value) throw new Error(`Project not found: ${id}`); return value; }
  private requireInstance(id: string): AgentInstance { const value = this.options.store.getAgentInstance(id); if (!value) throw new Error(`Agent instance not found: ${id}`); return value; }
  private requireWorkspace(id: string): WorkspaceLease { const value = this.options.store.getWorkspaceLease(id); if (!value) throw new Error(`Workspace lease not found: ${id}`); return value; }
  private requireUpdatedWorkspace(input: Parameters<InstanceStore["updateWorkspaceLease"]>[0]): WorkspaceLease { const value = this.options.store.updateWorkspaceLease(input); if (!value) throw new Error("Workspace lease generation changed"); return value; }
  private requireCheckpoint(instance: AgentInstance, checkpoint: AgentInstance["provisioningCheckpoint"], observedState: AgentInstance["observedState"], pendingPaneId?: string, pendingWorkspaceId?: string): AgentInstance {
    const value = this.options.store.checkpointAgentInstance({ instanceId: instance.id, expectedGeneration: instance.generation, checkpoint, observedState, ...(pendingPaneId ? { pendingPaneId } : {}), ...(pendingWorkspaceId ? { pendingWorkspaceId } : {}) });
    if (!value) throw new Error("Instance generation changed during provisioning");
    return value;
  }
}
