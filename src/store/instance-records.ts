import type { AgentInstance, AgentKind, AgentRuntimeRef, DesiredInstanceState, InstanceRole, ObservedInstanceState, WorkerParentIdentity, WorkerSessionLifecycle, WorkspaceLease, WorkspaceLeaseState } from "../domain/agent-instance.js";
import type { SqlValue } from "./sqlite-records.js";

export type AgentInstanceRow = Record<string, SqlValue> & {
  id: string; project_id: string; name: string; role: string; agent_kind: string; model: string | null; source_primary_pane_label: string | null;
  parent_binding_id: string | null; parent_pane_id: string | null; parent_native_session_id: string | null; worker_session_lifecycle: string | null;
  worker_session_generation: number; desired_state: string; observed_state: string; workspace_lease_id: string; generation: number;
  herdr_workspace_id: string | null; pane_id: string | null; native_session_id: string | null;
  provisioning_checkpoint: string; last_error: string | null; pending_herdr_workspace_id: string | null; pending_pane_id: string | null;
};

export type WorkspaceLeaseRow = Record<string, SqlValue> & {
  id: string; project_id: string; instance_id: string; kind: string; cwd: string; branch: string | null;
  base_commit: string; state: string; generation: number;
};

export function mapAgentInstance(row: AgentInstanceRow): AgentInstance {
  const generation = Number(row.generation);
  const runtimeRef: AgentRuntimeRef | null = row.pane_id && row.herdr_workspace_id
    ? { herdrWorkspaceId: row.herdr_workspace_id, paneId: row.pane_id, nativeSessionId: row.native_session_id, generation }
    : null;
  const pendingRuntimeRef = row.pending_pane_id && row.pending_herdr_workspace_id
    ? { herdrWorkspaceId: row.pending_herdr_workspace_id, paneId: row.pending_pane_id, generation } : null;
  const parent: WorkerParentIdentity | null = row.parent_binding_id && row.parent_pane_id
    ? { bindingId: row.parent_binding_id, paneId: row.parent_pane_id, nativeSessionId: row.parent_native_session_id } : null;
  return {
    id: row.id, projectId: row.project_id, name: row.name, role: row.role as InstanceRole, agentKind: row.agent_kind as AgentKind,
    model: row.model, sourcePrimaryPaneLabel: row.source_primary_pane_label, parent, workerSessionLifecycle: row.worker_session_lifecycle as WorkerSessionLifecycle | null, workerSessionGeneration: Number(row.worker_session_generation ?? 1), desiredState: row.desired_state as DesiredInstanceState, observedState: row.observed_state as ObservedInstanceState,
    workspaceLeaseId: row.workspace_lease_id, generation, runtimeRef, pendingRuntimeRef, provisioningCheckpoint: row.provisioning_checkpoint as AgentInstance["provisioningCheckpoint"], lastError: row.last_error
  };
}

export function mapWorkspaceLease(row: WorkspaceLeaseRow): WorkspaceLease {
  return {
    id: row.id, projectId: row.project_id, instanceId: row.instance_id, kind: row.kind as WorkspaceLease["kind"], cwd: row.cwd,
    branch: row.branch, baseCommit: row.base_commit, state: row.state as WorkspaceLeaseState, generation: Number(row.generation)
  };
}
