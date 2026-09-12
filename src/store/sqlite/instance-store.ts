import type { AgentInstance, CreateAgentInstanceInput, InstanceProvisioningCheckpoint, InstanceRemovalPlan, WorkspaceLease, WorkspaceLeaseState } from "../../domain/agent-instance.js";
import { mapAgentInstance, mapWorkspaceLease, type AgentInstanceRow, type WorkspaceLeaseRow } from "../instance-records.js";
import type { SqliteContext } from "./context.js";

export interface SqliteInstanceStoreDependencies {
  invalidateWorkerInstanceContexts(instance: AgentInstance, reason: string): void;
  retireWorkerSession(workerId: string, workerSessionGeneration: number, occurredAt: string): void;
}

export class SqliteInstanceStore {
  constructor(private readonly context: SqliteContext, private readonly dependencies: SqliteInstanceStoreDependencies) {}

  private get database() { return this.context.database; }

  createAgentInstance(input: CreateAgentInstanceInput): AgentInstance {
    const timestamp = now();
    return this.context.transaction(() => {
      this.database.prepare(`
        INSERT INTO agent_instances(
          id, project_id, name, role, agent_kind, model, source_primary_pane_label, parent_binding_id, parent_binding_generation, parent_pane_id, parent_native_session_id, worker_session_lifecycle, desired_state, observed_state, workspace_lease_id, generation, created_at, updated_at,
          provisioning_checkpoint, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unprovisioned', ?, 1, ?, ?, 'recorded', NULL)
      `).run(input.id, input.projectId, input.name, input.role, input.agentKind, input.model, input.sourcePrimaryPaneLabel ?? null, input.parent?.bindingId ?? null, input.parent?.bindingGeneration ?? null, input.parent?.paneId ?? null, input.parent?.nativeSessionId ?? null, input.workerSessionLifecycle ?? (input.role === "worker" ? "legacy" : null), input.desiredState, input.workspace.id, timestamp, timestamp);
      this.database.prepare(`
        INSERT INTO workspace_leases(id, project_id, instance_id, kind, cwd, branch, base_commit, state, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'allocating', 1, ?, ?)
      `).run(input.workspace.id, input.projectId, input.id, input.workspace.kind, input.workspace.cwd, input.workspace.branch, input.workspace.baseCommit, timestamp, timestamp);
      return this.getAgentInstance(input.id)!;
    });
  }

  createWorkerAgentInstance(input: CreateAgentInstanceInput & { role: "worker" }, maxWorkers: number): { outcome: "created"; instance: AgentInstance } | { outcome: "limit-reached" } | { outcome: "duplicate-name" } {
    if (!input.parent) throw new Error("Worker parent identity is required");
    const parent = input.parent;
    const timestamp = now();
    return this.context.transaction(() => {
      const count = this.database.prepare("SELECT COUNT(*) AS count FROM agent_instances WHERE project_id = ? AND role = 'worker' AND worker_session_lifecycle = 'active'").get(input.projectId) as { count: number };
      if (count.count >= maxWorkers) return { outcome: "limit-reached" };
      const duplicate = this.database.prepare("SELECT 1 FROM agent_instances WHERE role = 'worker' AND worker_session_lifecycle = 'active' AND parent_binding_id = ? AND parent_pane_id = ? AND name = ? LIMIT 1").get(parent.bindingId, parent.paneId, input.name);
      if (duplicate) return { outcome: "duplicate-name" };
      this.database.prepare(`
        INSERT INTO agent_instances(
          id, project_id, name, role, agent_kind, model, source_primary_pane_label, parent_binding_id, parent_binding_generation, parent_pane_id, parent_native_session_id, worker_session_lifecycle, desired_state, observed_state, workspace_lease_id, generation, created_at, updated_at,
          provisioning_checkpoint, last_error
        ) VALUES (?, ?, ?, 'worker', ?, ?, ?, ?, ?, ?, ?, 'active', ?, 'unprovisioned', ?, 1, ?, ?, 'recorded', NULL)
      `).run(input.id, input.projectId, input.name, input.agentKind, input.model, input.sourcePrimaryPaneLabel ?? null, parent.bindingId, parent.bindingGeneration ?? null, parent.paneId, parent.nativeSessionId, input.desiredState, input.workspace.id, timestamp, timestamp);
      this.database.prepare(`
        INSERT INTO workspace_leases(id, project_id, instance_id, kind, cwd, branch, base_commit, state, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'allocating', 1, ?, ?)
      `).run(input.workspace.id, input.projectId, input.id, input.workspace.kind, input.workspace.cwd, input.workspace.branch, input.workspace.baseCommit, timestamp, timestamp);
      const instance = this.getAgentInstance(input.id)!;
      this.dependencies.invalidateWorkerInstanceContexts(instance, "worker.created");
      return { outcome: "created", instance };
    });
  }

  getAgentInstance(id: string): AgentInstance | null {
    const row = this.database.prepare("SELECT * FROM agent_instances WHERE id = ?").get(id) as AgentInstanceRow | undefined;
    return row ? mapAgentInstance(row) : null;
  }

  findAgentInstanceByPane(paneId: string): AgentInstance | null {
    const row = this.database.prepare(`
      SELECT * FROM agent_instances
      WHERE pane_id = ? OR (
        pane_id IS NULL AND pending_pane_id = ? AND role = 'worker'
        AND worker_session_lifecycle = 'active' AND desired_state = 'running'
        AND provisioning_checkpoint IN ('pane-allocated', 'runtime-started')
      )
      ORDER BY CASE WHEN pane_id = ? THEN 0 ELSE 1 END, created_at, id
      LIMIT 1
    `).get(paneId, paneId, paneId) as AgentInstanceRow | undefined;
    return row ? mapAgentInstance(row) : null;
  }

  listWorkerInstancesByParent(input: { bindingId: string; paneId: string }): AgentInstance[] {
    return (this.database.prepare("SELECT * FROM agent_instances WHERE role = 'worker' AND worker_session_lifecycle = 'active' AND parent_binding_id = ? AND parent_pane_id = ? ORDER BY created_at, id").all(input.bindingId, input.paneId) as AgentInstanceRow[]).map(mapAgentInstance);
  }

  listAgentInstances(projectId: string): AgentInstance[] {
    return (this.database.prepare("SELECT * FROM agent_instances WHERE project_id = ? ORDER BY created_at, id").all(projectId) as AgentInstanceRow[]).map(mapAgentInstance);
  }

  setPrimaryAgentInstance(projectId: string, instanceId: string): AgentInstance {
    return this.context.transaction(() => {
      const target = this.database.prepare("SELECT project_id FROM agent_instances WHERE id = ?").get(instanceId) as { project_id: string } | undefined;
      if (!target || target.project_id !== projectId) throw new Error(`Agent instance not found in project: ${instanceId}`);
      const timestamp = now();
      this.database.prepare("UPDATE agent_instances SET role = 'worker', updated_at = ? WHERE project_id = ? AND role = 'primary' AND id <> ?").run(timestamp, projectId, instanceId);
      this.database.prepare("UPDATE agent_instances SET role = 'primary', updated_at = ? WHERE id = ? AND project_id = ?").run(timestamp, instanceId, projectId);
      return this.getAgentInstance(instanceId)!;
    });
  }

  attachAgentInstanceRuntime(input: { instanceId: string; expectedGeneration: number; herdrWorkspaceId: string; paneId: string; nativeSessionId: string | null }): AgentInstance | null {
    const nextGeneration = input.expectedGeneration + 1;
    return this.context.transaction(() => {
      const result = this.database.prepare(`UPDATE agent_instances SET herdr_workspace_id = ?, pane_id = ?, native_session_id = ?, pending_herdr_workspace_id = NULL, pending_pane_id = NULL, generation = ?, observed_state = 'idle', provisioning_checkpoint = 'verified', last_error = NULL, updated_at = ? WHERE id = ? AND generation = ?`)
        .run(input.herdrWorkspaceId, input.paneId, input.nativeSessionId, nextGeneration, now(), input.instanceId, input.expectedGeneration);
      return this.invalidateChanged(result.changes === 1 ? this.getAgentInstance(input.instanceId) : null, "worker.runtime-attached");
    });
  }

  checkpointAgentInstance(input: { instanceId: string; expectedGeneration: number; checkpoint: InstanceProvisioningCheckpoint; observedState?: AgentInstance["observedState"]; pendingPaneId?: string | null; pendingWorkspaceId?: string | null; lastError?: string | null }): AgentInstance | null {
    return this.context.transaction(() => {
      const result = this.database.prepare(`UPDATE agent_instances SET provisioning_checkpoint = ?, observed_state = COALESCE(?, observed_state), pending_pane_id = COALESCE(?, pending_pane_id), pending_herdr_workspace_id = COALESCE(?, pending_herdr_workspace_id), last_error = ?, updated_at = ? WHERE id = ? AND generation = ?`)
        .run(input.checkpoint, input.observedState ?? null, input.pendingPaneId ?? null, input.pendingWorkspaceId ?? null, input.lastError ?? null, now(), input.instanceId, input.expectedGeneration);
      return this.invalidateChanged(result.changes === 1 ? this.getAgentInstance(input.instanceId) : null, "worker.provisioning-changed");
    });
  }

  updateAgentInstanceLifecycle(input: { instanceId: string; expectedGeneration: number; desiredState: AgentInstance["desiredState"]; observedState: AgentInstance["observedState"]; clearRuntime?: boolean; lastError?: string | null }): AgentInstance | null {
    return this.context.transaction(() => {
      const clear = input.clearRuntime ? 1 : 0;
      const result = this.database.prepare(`UPDATE agent_instances SET desired_state = ?, observed_state = ?, herdr_workspace_id = CASE WHEN ? THEN NULL ELSE herdr_workspace_id END, pane_id = CASE WHEN ? THEN NULL ELSE pane_id END, native_session_id = CASE WHEN ? THEN NULL ELSE native_session_id END, pending_herdr_workspace_id = CASE WHEN ? THEN NULL ELSE pending_herdr_workspace_id END, pending_pane_id = CASE WHEN ? THEN NULL ELSE pending_pane_id END, last_error = ?, updated_at = ? WHERE id = ? AND generation = ?`)
        .run(input.desiredState, input.observedState, clear, clear, clear, clear, clear, input.lastError ?? null, now(), input.instanceId, input.expectedGeneration);
      return this.invalidateChanged(result.changes === 1 ? this.getAgentInstance(input.instanceId) : null, "worker.lifecycle-changed");
    });
  }

  updateAgentInstanceObservation(input: { instanceId: string; expectedGeneration: number; observedState: AgentInstance["observedState"]; lastError?: string | null }): AgentInstance | null {
    return this.context.transaction(() => {
      const result = this.database.prepare("UPDATE agent_instances SET observed_state = ?, last_error = ?, updated_at = ? WHERE id = ? AND generation = ?").run(input.observedState, input.lastError ?? null, now(), input.instanceId, input.expectedGeneration);
      return this.invalidateChanged(result.changes === 1 ? this.getAgentInstance(input.instanceId) : null, "worker.runtime-observed");
    });
  }

  reserveAgentInstanceStop(instanceId: string, expectedGeneration: number): { outcome: "reserved"; instance: AgentInstance } | { outcome: "busy" | "stale" } {
    return this.context.transaction(() => {
      const instance = this.getAgentInstance(instanceId);
      if (!instance || instance.generation !== expectedGeneration) return { outcome: "stale" };
      const active = this.database.prepare("SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked','dispatch-uncertain') LIMIT 1").get(instanceId, expectedGeneration);
      if (active) return { outcome: "busy" };
      const changed = this.database.prepare("UPDATE agent_instances SET desired_state = 'stopped', last_error = NULL, updated_at = ? WHERE id = ? AND generation = ?").run(now(), instanceId, expectedGeneration);
      const reserved = changed.changes === 1 ? this.getAgentInstance(instanceId) : null;
      return reserved ? { outcome: "reserved", instance: reserved } : { outcome: "stale" };
    });
  }

  finishAgentInstanceStop(instanceId: string, expectedGeneration: number): AgentInstance | null {
    return this.context.transaction(() => {
      const result = this.database.prepare(`UPDATE agent_instances SET observed_state = 'stopped', herdr_workspace_id = NULL, pane_id = NULL, native_session_id = NULL, pending_herdr_workspace_id = NULL, pending_pane_id = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND generation = ? AND desired_state = 'stopped'`).run(now(), instanceId, expectedGeneration);
      return this.invalidateChanged(result.changes === 1 ? this.getAgentInstance(instanceId) : null, "worker.stopped");
    });
  }

  rollbackAgentInstanceStop(instanceId: string, expectedGeneration: number, error: string): AgentInstance | null {
    const result = this.database.prepare("UPDATE agent_instances SET desired_state = 'running', last_error = ?, updated_at = ? WHERE id = ? AND generation = ? AND desired_state = 'stopped' AND (pane_id IS NOT NULL OR pending_pane_id IS NOT NULL)").run(error, now(), instanceId, expectedGeneration);
    return result.changes === 1 ? this.getAgentInstance(instanceId) : null;
  }

  detachAgentInstanceRuntime(input: { instanceId: string; expectedGeneration: number; reason: string }): AgentInstance | null {
    return this.context.transaction(() => {
      const instance = this.getAgentInstance(input.instanceId);
      if (!instance || instance.generation !== input.expectedGeneration) return null;
      const nextGeneration = input.expectedGeneration + 1;
      this.database.prepare(`UPDATE instance_turns SET state = 'dispatch-uncertain', error = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked')`).run(input.reason, now(), instance.id, input.expectedGeneration);
      this.database.prepare(`UPDATE instance_turns SET instance_generation = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state = 'queued'`).run(nextGeneration, now(), instance.id, input.expectedGeneration);
      const changed = this.database.prepare(`UPDATE agent_instances SET generation = ?, observed_state = 'detached', herdr_workspace_id = NULL, pane_id = NULL, native_session_id = NULL, pending_herdr_workspace_id = NULL, pending_pane_id = NULL, last_error = ?, updated_at = ? WHERE id = ? AND generation = ?`).run(nextGeneration, input.reason, now(), instance.id, input.expectedGeneration);
      return this.invalidateChanged(changed.changes === 1 ? this.getAgentInstance(instance.id) : null, "worker.runtime-detached");
    });
  }

  terminateWorkerSession(input: { instanceId: string; expectedGeneration: number; reason: string }): { instance: AgentInstance; cancelledTurnIds: string[]; uncertainTurnIds: string[] } | null {
    return this.context.transaction(() => {
      const instance = this.getAgentInstance(input.instanceId);
      if (!instance || instance.role !== "worker" || instance.generation !== input.expectedGeneration) return null;
      const turns = this.database.prepare("SELECT id, state FROM instance_turns WHERE instance_id = ? AND instance_generation = ? ORDER BY created_at, rowid").all(instance.id, instance.generation) as Array<{ id: string; state: string }>;
      const cancelledTurnIds = turns.filter(({ state }) => state === "queued").map(({ id }) => id);
      const uncertainTurnIds = turns.filter(({ state }) => ["claimed", "dispatching", "running", "blocked"].includes(state)).map(({ id }) => id);
      const timestamp = now();
      const nextGeneration = instance.generation + 1;
      this.database.prepare("UPDATE instance_turns SET state = 'cancelled', error = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state = 'queued'").run(input.reason, timestamp, instance.id, instance.generation);
      this.database.prepare("UPDATE instance_turns SET state = 'dispatch-uncertain', error = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked')").run(input.reason, timestamp, instance.id, instance.generation);
      const changed = this.database.prepare("UPDATE agent_instances SET desired_state = 'stopped', observed_state = 'stopped', worker_session_lifecycle = 'terminated', generation = ?, herdr_workspace_id = NULL, pane_id = NULL, native_session_id = NULL, pending_herdr_workspace_id = NULL, pending_pane_id = NULL, last_error = ?, updated_at = ? WHERE id = ? AND generation = ?").run(nextGeneration, input.reason, timestamp, instance.id, instance.generation);
      if (changed.changes === 1) this.dependencies.retireWorkerSession(instance.id, instance.workerSessionGeneration, timestamp);
      const terminated = this.invalidateChanged(changed.changes === 1 ? this.getAgentInstance(instance.id) : null, "worker.terminated");
      return terminated ? { instance: terminated, cancelledTurnIds, uncertainTurnIds } : null;
    });
  }

  getWorkspaceLease(id: string): WorkspaceLease | null {
    const row = this.database.prepare("SELECT * FROM workspace_leases WHERE id = ?").get(id) as WorkspaceLeaseRow | undefined;
    return row ? mapWorkspaceLease(row) : null;
  }

  updateWorkspaceLease(input: { id: string; expectedGeneration: number; state: WorkspaceLeaseState; cwd?: string; branch?: string | null; baseCommit?: string }): WorkspaceLease | null {
    const current = this.getWorkspaceLease(input.id);
    if (!current || current.generation !== input.expectedGeneration) return null;
    const result = this.database.prepare(`UPDATE workspace_leases SET state = ?, cwd = ?, branch = ?, base_commit = ?, updated_at = ? WHERE id = ? AND generation = ?`).run(input.state, input.cwd ?? current.cwd, input.branch === undefined ? current.branch : input.branch, input.baseCommit ?? current.baseCommit, now(), input.id, input.expectedGeneration);
    return result.changes === 1 ? this.getWorkspaceLease(input.id) : null;
  }

  createInstanceRemovalPlan(plan: InstanceRemovalPlan): InstanceRemovalPlan {
    this.database.prepare(`INSERT INTO instance_removal_plans(id, instance_id, instance_generation, workspace_generation, worktree_fingerprint, safe, reason, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(plan.id, plan.instanceId, plan.instanceGeneration, plan.workspaceGeneration, plan.worktreeFingerprint, plan.safe ? 1 : 0, plan.reason, plan.state, plan.createdAt);
    return this.getInstanceRemovalPlan(plan.id)!;
  }

  getInstanceRemovalPlan(id: string): InstanceRemovalPlan | null {
    const row = this.database.prepare("SELECT * FROM instance_removal_plans WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), instanceId: String(row.instance_id), instanceGeneration: Number(row.instance_generation), workspaceGeneration: Number(row.workspace_generation), worktreeFingerprint: row.worktree_fingerprint === null ? null : String(row.worktree_fingerprint), safe: Number(row.safe) === 1, reason: String(row.reason) as InstanceRemovalPlan["reason"], state: String(row.state) as InstanceRemovalPlan["state"], createdAt: String(row.created_at) } : null;
  }

  consumeInstanceRemovalPlan(input: { id: string; instanceId: string; instanceGeneration: number; workspaceGeneration: number; worktreeFingerprint: string | null }): InstanceRemovalPlan | null {
    const result = this.database.prepare(`UPDATE instance_removal_plans SET state = 'consumed' WHERE id = ? AND state = 'pending' AND safe = 1 AND instance_id = ? AND instance_generation = ? AND workspace_generation = ? AND worktree_fingerprint IS ?`).run(input.id, input.instanceId, input.instanceGeneration, input.workspaceGeneration, input.worktreeFingerprint);
    return result.changes === 1 ? this.getInstanceRemovalPlan(input.id) : null;
  }

  removeAgentInstance(input: { instanceId: string; expectedGeneration: number; expectedWorkspaceGeneration: number }): boolean {
    return this.context.transaction(() => {
      const instance = this.getAgentInstance(input.instanceId);
      if (!instance || instance.generation !== input.expectedGeneration || instance.desiredState !== "stopped" || instance.runtimeRef || instance.pendingRuntimeRef) return false;
      const lease = this.getWorkspaceLease(instance.workspaceLeaseId);
      if (!lease || lease.generation !== input.expectedWorkspaceGeneration) return false;
      const timestamp = now();
      this.dependencies.retireWorkerSession(instance.id, instance.workerSessionGeneration, timestamp);
      this.database.prepare("DELETE FROM workspace_leases WHERE id = ? AND generation = ?").run(lease.id, lease.generation);
      return this.database.prepare("DELETE FROM agent_instances WHERE id = ? AND generation = ?").run(instance.id, instance.generation).changes === 1;
    });
  }

  private invalidateChanged(instance: AgentInstance | null, reason: string): AgentInstance | null {
    if (instance) this.dependencies.invalidateWorkerInstanceContexts(instance, reason);
    return instance;
  }
}

function now(): string { return new Date().toISOString(); }
