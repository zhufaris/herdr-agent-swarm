import { join } from "node:path";
import { createHash } from "node:crypto";
import { matchesHerdrAgentKind, type AgentInstance, type CreateWorkerResult, type InstanceRemovalPlan, type WorkspaceLease } from "../domain/agent-instance.js";
import type { ControlActor, CreateWorkerCommand } from "../domain/commands.js";
import { primaryPaneToken } from "../domain/pane-title.js";
import type { InstanceControlStore } from "../domain/ports/instance.js";
import type { ProjectConfig } from "../domain/types.js";
import type { AgentDriverCatalog } from "../domain/agent-runtime.js";
import type { PaneHost } from "../domain/ports/pane-host.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { WorktreePort } from "../domain/ports/worktree.js";
import type { InstanceControlPort } from "../domain/ports/instance-workflows.js";
import { preferredRuntimeSessionId, requireMatchingRuntimeIdentity } from "./pane-runtime-identity.js";

interface Options {
  projects: readonly ProjectConfig[]; store: InstanceControlStore; paneHost: PaneHost; drivers: AgentDriverCatalog; worktrees: WorktreePort; idFactory: () => string;
}

export class InstanceControlWorkflow implements InstanceControlPort {
  private readonly projects: ReadonlyMap<string, ProjectConfig>;
  constructor(private readonly options: Options) { this.projects = new Map(options.projects.map((project) => [project.id, project])); }

  async createWorker(command: CreateWorkerCommand): Promise<CreateWorkerResult> {
    this.requireHuman(command.actor);
    const project = this.requireProject(command.projectId);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(command.name)) throw new Error("Invalid instance name");
    const driver = this.options.drivers.get(command.agentKind);
    if (!driver?.describe().available) throw new Error(`Agent adapter is unavailable: ${command.agentKind}`);
    const parent = await this.resolveWorkerParent(project, command.bindingId);
    const id = this.options.idFactory();
    const workspaceId = this.options.idFactory();
    const resourceName = workerResourceName(parent.identity, command.name);
    const workspace = { id: workspaceId, kind: "git-worktree" as const, cwd: join(project.cwd, ".worktree", resourceName), branch: `swarm/${resourceName}`, baseCommit: "HEAD" };
    const created = this.options.store.createWorkerAgentInstance({ id, projectId: project.id, name: command.name, role: "worker", agentKind: command.agentKind, model: command.model, sourcePrimaryPaneLabel: parent.label, parent: parent.identity, desiredState: command.start ? "running" : "stopped", workspace }, project.maxInstances ?? 8);
    if (created.outcome === "limit-reached") throw new Error("Project Worker limit reached");
    if (created.outcome === "duplicate-name") throw new Error(`Worker already exists in this Primary: ${command.name}`);
    const instance = created.instance;
    if (!command.start) return { status: "created", instance };
    try {
      return { status: "created", instance: await this.start({ actor: command.actor, instanceId: instance.id }) };
    } catch (error) {
      const failed = this.options.store.getAgentInstance(instance.id) ?? instance;
      return { status: "created-start-failed", instance: failed, error: failed.lastError ?? safeLogError(error).message };
    }
  }

  async start(input: { actor: ControlActor; instanceId: string }): Promise<AgentInstance> {
    this.requireHuman(input.actor);
    let instance = this.requireInstance(input.instanceId);
    this.requireWorker(instance);
    if (instance.workerSessionLifecycle !== "active" || !instance.parent) throw new Error("Worker session is not startable");
    const parent = instance.parent;
    if (instance.runtimeRef && instance.observedState !== "stopped") return instance;
    if (instance.provisioningCheckpoint === "verified" && !instance.runtimeRef) throw new Error("Worker session cannot be restarted in a replacement pane");
    if (instance.desiredState !== "running") {
      const starting = this.options.store.updateAgentInstanceLifecycle({ instanceId: instance.id, expectedGeneration: instance.generation, desiredState: "running", observedState: "starting" });
      if (!starting) throw new Error("Instance generation changed while starting");
      instance = starting;
    }
    const project = this.requireProject(instance.projectId);
    await this.requireLiveParent(project, parent);
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
        const pane = await this.options.paneHost.allocatePane(project.workspaceId, workspace.cwd, { bindingId: instance.id, generation: instance.generation, projectId: project.id, placement: "dedicated-tab", title: workerPaneTitle(instance), titlePolicy: "complete" });
        instance = this.requireCheckpoint(instance, "pane-allocated", "starting", pane.paneId, project.workspaceId);
      }
      const pending = instance.pendingRuntimeRef;
      if (!pending) throw new Error("Provisioning pane checkpoint is missing");
      if (instance.provisioningCheckpoint === "pane-allocated") {
        await driver.start({ ...pending, nativeSessionId: null }, { projectId: instance.projectId, name: instance.name, managedName: workerAgentName(instance), model: instance.model });
        instance = this.requireCheckpoint(instance, "runtime-started", "starting");
      }
      if (instance.provisioningCheckpoint === "runtime-started") {
        const observed = await this.options.paneHost.inspectPane(pending.paneId);
        if (!observed || observed.workspaceId !== project.workspaceId || observed.cwd !== workspace.cwd) throw new Error("Started agent pane could not be verified");
        if (observed.agentKind && !matchesHerdrAgentKind(instance.agentKind, observed.agentKind)) throw new Error(`Started pane reported unexpected agent: ${observed.agentKind}`);
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
    this.requireWorker(instance);
    const reservation = this.options.store.reserveAgentInstanceStop(instance.id, instance.generation);
    if (reservation.outcome === "busy") throw new Error("Instance has an active or uncertain turn; interrupt it or wait for durable completion before stopping");
    if (reservation.outcome !== "reserved") throw new Error("Instance generation changed while stopping");
    try {
      const ownedPaneId = reservation.instance.runtimeRef?.paneId ?? reservation.instance.pendingRuntimeRef?.paneId;
      if (ownedPaneId) await this.options.paneHost.releasePane(ownedPaneId);
    }
    catch (error) { this.options.store.rollbackAgentInstanceStop(instance.id, instance.generation, safeLogError(error).message); throw error; }
    const stopped = this.options.store.finishAgentInstanceStop(instance.id, instance.generation);
    if (!stopped) throw new Error("Instance generation changed while stopping");
    return stopped;
  }

  async planRemoval(input: { actor: ControlActor; instanceId: string }): Promise<InstanceRemovalPlan> {
    this.requireHuman(input.actor);
    const instance = this.requireInstance(input.instanceId);
    this.requireWorker(instance);
    if (instance.desiredState !== "stopped" || instance.runtimeRef || instance.pendingRuntimeRef) throw new Error("Instance must be stopped before removal planning");
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
    this.requireWorker(instance);
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
  listWorkers(projectId: string): AgentInstance[] { return this.options.store.listAgentInstances(projectId).filter(({ role }) => role === "worker"); }
  listWorkersForParent(parent: { bindingId: string; paneId: string }): AgentInstance[] { return this.options.store.listWorkerInstancesByParent(parent); }

  private requireHuman(actor: ControlActor): void { if (actor.kind !== "human") throw new Error("Instance topology changes require a human actor"); }
  private requireProject(id: string): ProjectConfig { const value = this.projects.get(id); if (!value) throw new Error(`Project not found: ${id}`); return value; }
  private requireInstance(id: string): AgentInstance { const value = this.options.store.getAgentInstance(id); if (!value) throw new Error(`Agent instance not found: ${id}`); return value; }
  private requireWorker(instance: AgentInstance): void { if (instance.role !== "worker") throw new Error("Only Worker instances can be controlled"); }
  private requireWorkspace(id: string): WorkspaceLease { const value = this.options.store.getWorkspaceLease(id); if (!value) throw new Error(`Workspace lease not found: ${id}`); return value; }
  private requireUpdatedWorkspace(input: Parameters<InstanceControlStore["updateWorkspaceLease"]>[0]): WorkspaceLease { const value = this.options.store.updateWorkspaceLease(input); if (!value) throw new Error("Workspace lease generation changed"); return value; }
  private async resolveWorkerParent(project: ProjectConfig, bindingId: string | null | undefined): Promise<{ identity: NonNullable<AgentInstance["parent"]>; label: string | null }> {
    if (!bindingId) throw new Error("Worker creation requires an active Primary pane");
    const binding = this.options.store.getBinding(bindingId);
    if (!binding || binding.projectId !== project.id || binding.workspaceId !== project.workspaceId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached" || !binding.paneId) throw new Error("Worker parent binding is not active");
    const pane = await this.options.paneHost.inspectPane(binding.paneId);
    if (!pane || pane.workspaceId !== project.workspaceId || pane.cwd !== project.cwd) throw new Error("Worker parent pane could not be verified");
    let nativeSessionId: string | null;
    try { nativeSessionId = preferredRuntimeSessionId(binding, pane); }
    catch { throw new Error("Worker parent pane identity changed"); }
    return { identity: { bindingId: binding.id, bindingGeneration: binding.generation, paneId: pane.paneId, nativeSessionId }, label: pane.label };
  }
  private async requireLiveParent(project: ProjectConfig, parent: NonNullable<AgentInstance["parent"]>): Promise<void> {
    const binding = this.options.store.getBinding(parent.bindingId);
    if (!binding || binding.projectId !== project.id || binding.workspaceId !== project.workspaceId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached" || binding.paneId !== parent.paneId || (parent.bindingGeneration !== undefined && binding.generation !== parent.bindingGeneration)) throw new Error("Worker parent binding is no longer active");
    const pane = await this.options.paneHost.inspectPane(parent.paneId);
    if (!pane || pane.workspaceId !== project.workspaceId || pane.cwd !== project.cwd) throw new Error("Worker parent pane could not be verified");
    try { requireMatchingRuntimeIdentity(binding, pane); }
    catch { throw new Error("Worker parent pane identity changed"); }
    const nativeSessionId = pane.agentSession?.value ?? pane.terminalId ?? null;
    if (parent.nativeSessionId && parent.nativeSessionId !== nativeSessionId) throw new Error("Worker parent pane identity changed");
  }
  private requireCheckpoint(instance: AgentInstance, checkpoint: AgentInstance["provisioningCheckpoint"], observedState: AgentInstance["observedState"], pendingPaneId?: string, pendingWorkspaceId?: string): AgentInstance {
    const value = this.options.store.checkpointAgentInstance({ instanceId: instance.id, expectedGeneration: instance.generation, checkpoint, observedState, ...(pendingPaneId ? { pendingPaneId } : {}), ...(pendingWorkspaceId ? { pendingWorkspaceId } : {}) });
    if (!value) throw new Error("Instance generation changed during provisioning");
    return value;
  }
}

function workerPaneTitle(instance: AgentInstance): string {
  if (!instance.parent) throw new Error("Worker parent identity is missing");
  const primary = primaryPaneToken(instance.sourcePrimaryPaneLabel, instance.parent.paneId);
  return `lark_${primary}-${instance.name}`;
}

function workerAgentName(instance: AgentInstance): string {
  if (!instance.parent) throw new Error("Worker parent identity is missing");
  return `${primaryPaneToken(instance.sourcePrimaryPaneLabel, instance.parent.paneId)}-${instance.name}`;
}

function paneTitleSegment(value: string): string {
  return value.trim().replace(/^(?:(?:lark|task)[-_]+)+/i, "").replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "parent";
}

function workerResourceName(parent: NonNullable<AgentInstance["parent"]>, workerName: string): string {
  const scope = createHash("sha256").update(`${parent.bindingId}\0${parent.paneId}`).digest("hex").slice(0, 10);
  return `lark-${scope}-${paneTitleSegment(workerName).slice(0, 32)}`;
}
