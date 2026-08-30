export type AgentKind = "pi" | "claude-code" | "codex" | "traex";
export type InstanceRole = "primary" | "worker";
export type DesiredInstanceState = "running" | "stopped";
export type ObservedInstanceState =
  | "unprovisioned"
  | "starting"
  | "idle"
  | "working"
  | "blocked"
  | "detached"
  | "stopped"
  | "failed";
export type InstanceProvisioningCheckpoint = "recorded" | "workspace-ready" | "pane-allocated" | "runtime-started" | "verified";

export interface AgentRuntimeRef {
  herdrWorkspaceId: string;
  paneId: string;
  nativeSessionId: string | null;
  generation: number;
}

export interface AgentInstance {
  id: string;
  projectId: string;
  name: string;
  role: InstanceRole;
  agentKind: AgentKind;
  model: string | null;
  desiredState: DesiredInstanceState;
  observedState: ObservedInstanceState;
  workspaceLeaseId: string;
  generation: number;
  runtimeRef: AgentRuntimeRef | null;
  pendingRuntimeRef: Omit<AgentRuntimeRef, "nativeSessionId"> | null;
  provisioningCheckpoint: InstanceProvisioningCheckpoint;
  lastError: string | null;
}

export type CreateWorkerResult =
  | { status: "created"; instance: AgentInstance }
  | { status: "created-start-failed"; instance: AgentInstance; error: string };

export type WorkspaceLeaseState =
  | "allocating"
  | "ready"
  | "dirty"
  | "committed"
  | "conflicted"
  | "release-requested"
  | "retained"
  | "released";

export interface WorkspaceLease {
  id: string;
  projectId: string;
  instanceId: string;
  kind: "main-checkout" | "git-worktree" | "shared-read-only";
  cwd: string;
  branch: string | null;
  baseCommit: string;
  state: WorkspaceLeaseState;
  generation: number;
}

export interface CreateAgentInstanceInput {
  id: string;
  projectId: string;
  name: string;
  role: InstanceRole;
  agentKind: AgentKind;
  model: string | null;
  desiredState: DesiredInstanceState;
  workspace: Omit<WorkspaceLease, "projectId" | "instanceId" | "state" | "generation">;
}

export interface InstanceRemovalPlan {
  id: string;
  instanceId: string;
  instanceGeneration: number;
  workspaceGeneration: number;
  worktreeFingerprint: string | null;
  safe: boolean;
  reason: "main-checkout" | "shared-read-only" | "clean" | "dirty" | "conflicted" | "ahead" | "uncertain";
  state: "pending" | "consumed" | "stale";
  createdAt: string;
}

export type InstanceTarget =
  | { kind: "primary" }
  | { kind: "instance"; instanceId: string; expectedGeneration?: number };

export type PrimaryAssignmentValidation =
  | { ok: true; primaryInstanceId: string | null }
  | { ok: false; reason: "project_has_multiple_primaries" };

export function validatePrimaryAssignment(instances: readonly AgentInstance[]): PrimaryAssignmentValidation {
  const primaryIds = instances.filter((instance) => instance.role === "primary").map((instance) => instance.id);
  if (primaryIds.length > 1) return { ok: false, reason: "project_has_multiple_primaries" };
  return { ok: true, primaryInstanceId: primaryIds[0] ?? null };
}

export type InstanceTargetResolution =
  | { ok: true; instance: AgentInstance }
  | { ok: false; reason: "primary_not_configured" | "instance_not_found" | "stale_instance_generation" };

export function resolveInstanceTarget(target: InstanceTarget, instances: readonly AgentInstance[]): InstanceTargetResolution {
  const instance = target.kind === "primary"
    ? instances.find((candidate) => candidate.role === "primary")
    : instances.find((candidate) => candidate.id === target.instanceId);
  if (!instance) return { ok: false, reason: target.kind === "primary" ? "primary_not_configured" : "instance_not_found" };
  if (target.kind === "instance" && target.expectedGeneration !== undefined && target.expectedGeneration !== instance.generation) {
    return { ok: false, reason: "stale_instance_generation" };
  }
  return { ok: true, instance };
}

export function matchesHerdrAgentKind(kind: AgentKind, observed: string): boolean {
  if (kind === "claude-code") return observed === "claude";
  if (kind === "traex") return observed === "traex" || observed === "codex";
  return observed === kind;
}
