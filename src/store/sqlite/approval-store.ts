import type { ApprovalGrant, ApprovalIdentity, ApprovalRequest } from "../../domain/approval-policy.js";
import type { SqliteContext } from "./context.js";

export class SqliteApprovalStore {
  constructor(private readonly context: SqliteContext) {}

  createApprovalRequest(input: ApprovalIdentity & { id: string; expiresAt: string }): ApprovalRequest {
    const instance = this.context.database.prepare("SELECT project_id, generation FROM agent_instances WHERE id = ?").get(input.instanceId) as { project_id: string; generation: number } | undefined;
    if (!instance || instance.project_id !== input.projectId || instance.generation !== input.instanceGeneration) throw new Error("Instance generation changed before approval request");
    const timestamp = new Date().toISOString();
    this.context.database.prepare(`INSERT INTO approval_requests(id, actor_id, project_id, instance_id, instance_generation, action_fingerprint, resource_scope, policy_version, tier, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'remote-confirmation', 'pending', ?, ?)`)
      .run(input.id, input.actorId, input.projectId, input.instanceId, input.instanceGeneration, input.actionFingerprint, input.resourceScope, input.policyVersion, input.expiresAt, timestamp);
    return this.getApprovalRequest(input.id)!;
  }

  resolveApprovalRequest(input: { requestId: string; actorId: string; approved: boolean; now: string; grantId: string }): { outcome: "approved" | "rejected" | "missing" | "unauthorized" | "expired" | "duplicate"; request: ApprovalRequest | null; grant: ApprovalGrant | null } {
    return this.context.transaction(() => {
      const request = this.getApprovalRequest(input.requestId);
      if (!request) return { outcome: "missing", request: null, grant: null };
      if (request.actorId !== input.actorId) return { outcome: "unauthorized", request, grant: null };
      if (request.state !== "pending") return { outcome: "duplicate", request, grant: this.getApprovalGrantByRequest(request.id) };
      if (request.expiresAt <= input.now) {
        this.context.database.prepare("UPDATE approval_requests SET state = 'expired', resolved_at = ? WHERE id = ? AND state = 'pending'").run(input.now, request.id);
        return { outcome: "expired", request: this.getApprovalRequest(request.id), grant: null };
      }
      const state = input.approved ? "approved" : "rejected";
      this.context.database.prepare("UPDATE approval_requests SET state = ?, resolved_at = ? WHERE id = ? AND state = 'pending'").run(state, input.now, request.id);
      if (input.approved) this.context.database.prepare(`INSERT INTO approval_grants(id, request_id, actor_id, project_id, instance_id, instance_generation, action_fingerprint, resource_scope, policy_version, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.grantId, request.id, request.actorId, request.projectId, request.instanceId, request.instanceGeneration, request.actionFingerprint, request.resourceScope, request.policyVersion, request.expiresAt, input.now);
      return { outcome: state, request: this.getApprovalRequest(request.id), grant: input.approved ? this.getApprovalGrant(input.grantId) : null };
    });
  }

  consumeApprovalGrant(input: ApprovalIdentity & { grantId: string; now: string }): "consumed" | "missing" | "expired" | "used" | "mismatch" {
    return this.context.transaction(() => {
      const grant = this.getApprovalGrant(input.grantId);
      if (!grant) return "missing";
      if (grant.consumedAt) return "used";
      if (grant.expiresAt <= input.now) return "expired";
      if (!approvalIdentityMatches(grant, input)) return "mismatch";
      const instance = this.context.database.prepare("SELECT project_id, generation FROM agent_instances WHERE id = ?").get(input.instanceId) as { project_id: string; generation: number } | undefined;
      if (!instance || instance.project_id !== input.projectId || instance.generation !== input.instanceGeneration) return "mismatch";
      const changed = this.context.database.prepare("UPDATE approval_grants SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(input.now, grant.id);
      return changed.changes === 1 ? "consumed" : "used";
    });
  }

  private getApprovalRequest(id: string): ApprovalRequest | null {
    const row = this.context.database.prepare("SELECT * FROM approval_requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapApprovalRequest(row) : null;
  }

  private getApprovalGrant(id: string): ApprovalGrant | null {
    const row = this.context.database.prepare("SELECT * FROM approval_grants WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapApprovalGrant(row) : null;
  }

  private getApprovalGrantByRequest(requestId: string): ApprovalGrant | null {
    const row = this.context.database.prepare("SELECT * FROM approval_grants WHERE request_id = ?").get(requestId) as Record<string, unknown> | undefined;
    return row ? mapApprovalGrant(row) : null;
  }
}

function approvalIdentityMatches(left: ApprovalIdentity, right: ApprovalIdentity): boolean {
  return left.actorId === right.actorId && left.projectId === right.projectId && left.instanceId === right.instanceId
    && left.instanceGeneration === right.instanceGeneration && left.actionFingerprint === right.actionFingerprint
    && left.resourceScope === right.resourceScope && left.policyVersion === right.policyVersion;
}

function mapApprovalIdentity(row: Record<string, unknown>): ApprovalIdentity {
  return { actorId: String(row.actor_id), projectId: String(row.project_id), instanceId: String(row.instance_id), instanceGeneration: Number(row.instance_generation), actionFingerprint: String(row.action_fingerprint), resourceScope: String(row.resource_scope), policyVersion: String(row.policy_version) };
}

function mapApprovalRequest(row: Record<string, unknown>): ApprovalRequest {
  return { id: String(row.id), ...mapApprovalIdentity(row), tier: "remote-confirmation", state: String(row.state) as ApprovalRequest["state"], expiresAt: String(row.expires_at), createdAt: String(row.created_at), resolvedAt: row.resolved_at === null ? null : String(row.resolved_at) };
}

function mapApprovalGrant(row: Record<string, unknown>): ApprovalGrant {
  return { id: String(row.id), requestId: String(row.request_id), ...mapApprovalIdentity(row), expiresAt: String(row.expires_at), consumedAt: row.consumed_at === null ? null : String(row.consumed_at), createdAt: String(row.created_at) };
}
