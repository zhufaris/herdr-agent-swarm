import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export const APPROVAL_POLICY_VERSION = "solo-agent-v1";

export type ApprovalTier = "routine" | "remote-confirmation" | "local-only";

export type ApprovalAction =
  | { kind: "workspace-read" | "workspace-write"; path: string }
  | { kind: "local-test"; cwd: string; argv: readonly string[] }
  | { kind: "git-commit"; cwd: string; paths: readonly string[] }
  | { kind: "primary-worker-call"; projectId: string; workerProjectId: string; workerInstanceId: string }
  | { kind: "external-effect"; effect: string; resource: string; parameters?: unknown }
  | { kind: "git-push"; remote: string; branch: string }
  | { kind: "deploy"; environment: string }
  | { kind: "delete"; path: string }
  | { kind: "credential-access"; resource: string }
  | { kind: "permission-bypass"; mechanism: string }
  | { kind: "destructive-command"; argv: readonly string[] }
  | { kind: "native-approval"; prompt: string };

export interface ApprovalPolicyConfig {
  workspaceRoots: readonly string[];
  remotelyApprovableEffects: readonly string[];
}

export interface ApprovalIdentity {
  actorId: string;
  projectId: string;
  instanceId: string;
  instanceGeneration: number;
  actionFingerprint: string;
  resourceScope: string;
  policyVersion: string;
}

export interface ApprovalRequest extends ApprovalIdentity {
  id: string;
  tier: "remote-confirmation";
  state: "pending" | "approved" | "rejected" | "expired";
  expiresAt: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ApprovalGrant extends ApprovalIdentity {
  id: string;
  requestId: string;
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export function classifyAction(action: ApprovalAction, policy: ApprovalPolicyConfig): ApprovalTier {
  switch (action.kind) {
    case "workspace-read":
    case "workspace-write":
      return isInConfiguredWorkspace(action.path, policy.workspaceRoots) ? "routine" : "local-only";
    case "local-test":
    case "git-commit":
      return isInConfiguredWorkspace(action.cwd, policy.workspaceRoots) ? "routine" : "local-only";
    case "primary-worker-call":
      return action.projectId === action.workerProjectId ? "routine" : "local-only";
    case "external-effect":
      return policy.remotelyApprovableEffects.includes(action.effect) ? "remote-confirmation" : "local-only";
    default:
      return "local-only";
  }
}

export function fingerprintAction(action: ApprovalAction): string {
  const canonical = canonicalJson(action);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function isInConfiguredWorkspace(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false;
  const candidate = resolve(path);
  return roots.some((root) => {
    if (!isAbsolute(root)) return false;
    const relation = relative(resolve(root), candidate);
    return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
