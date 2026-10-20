import { createHash } from "node:crypto";

export type RuntimeIdentityClaimState = "current" | "unclaimed" | "conflicted" | "released";
export type RuntimeIdentityAttachmentState = "attached" | "orphaned";

export interface RuntimeIdentityOwner {
  bindingId: string;
  bindingGeneration: number;
  sessionEpoch: number;
}

export interface NativeRuntimeIdentity {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
}

export interface RuntimeIdentityAttachment {
  state: RuntimeIdentityAttachmentState;
  workspaceId: string;
  paneId: string;
  terminalId: string;
}

export interface RuntimeIdentityEvidence {
  workspaceId: string;
  paneId: string;
  terminalId: string | null;
  agentKind: string | null;
  agentSession: NativeRuntimeIdentity | null;
  paneToken?: string | null;
  observedAt?: string | null;
}

interface RuntimeIdentityClaimBase {
  owner: RuntimeIdentityOwner;
  state: RuntimeIdentityClaimState;
  lastRejectedEvidenceFingerprint: string | null;
  lastRejectedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CurrentRuntimeIdentityClaim extends RuntimeIdentityClaimBase {
  state: "current";
  nativeIdentity: NativeRuntimeIdentity;
  attachment: RuntimeIdentityAttachment;
}

export interface UnclaimedRuntimeIdentityClaim extends RuntimeIdentityClaimBase {
  state: "unclaimed";
  nativeIdentity: null;
  attachment: null;
}

export interface ConflictedRuntimeIdentityClaim extends RuntimeIdentityClaimBase {
  state: "conflicted";
  nativeIdentity: NativeRuntimeIdentity | null;
  attachment: RuntimeIdentityAttachment | null;
}

export interface ReleasedRuntimeIdentityClaim extends RuntimeIdentityClaimBase {
  state: "released";
  nativeIdentity: NativeRuntimeIdentity | null;
  attachment: RuntimeIdentityAttachment | null;
}

export type RuntimeIdentityClaim = CurrentRuntimeIdentityClaim | UnclaimedRuntimeIdentityClaim | ConflictedRuntimeIdentityClaim | ReleasedRuntimeIdentityClaim;

export function normalizeNativeRuntimeIdentity(identity: NativeRuntimeIdentity): NativeRuntimeIdentity {
  const normalized = {
    source: identity.source.trim(),
    agent: identity.agent.trim(),
    kind: identity.kind,
    value: identity.value.trim()
  };
  if (!normalized.source || !normalized.agent || !normalized.value) throw new Error("Runtime identity must be complete");
  return normalized;
}

export function sameNativeRuntimeIdentity(left: NativeRuntimeIdentity, right: NativeRuntimeIdentity): boolean {
  const normalizedLeft = normalizeNativeRuntimeIdentity(left);
  const normalizedRight = normalizeNativeRuntimeIdentity(right);
  return normalizedLeft.source === normalizedRight.source
    && normalizedLeft.agent === normalizedRight.agent
    && normalizedLeft.kind === normalizedRight.kind
    && normalizedLeft.value === normalizedRight.value;
}

export function fingerprintRuntimeIdentityEvidence(evidence: RuntimeIdentityEvidence): string {
  const identity = evidence.agentSession === null ? null : normalizeNativeRuntimeIdentity(evidence.agentSession);
  return createHash("sha256").update(JSON.stringify({
    workspaceId: evidence.workspaceId,
    paneId: evidence.paneId,
    terminalId: evidence.terminalId,
    agentKind: evidence.agentKind,
    agentSession: identity
  })).digest("hex");
}

export function createCurrentRuntimeIdentityClaim(input: Omit<CurrentRuntimeIdentityClaim, "state" | "nativeIdentity" | "attachment"> & {
  nativeIdentity: NativeRuntimeIdentity;
  attachment: RuntimeIdentityAttachment;
}): CurrentRuntimeIdentityClaim {
  assertRuntimeIdentityOwner(input.owner);
  if (!input.attachment.workspaceId.trim() || !input.attachment.paneId.trim() || !input.attachment.terminalId.trim()) throw new Error("Current RuntimeIdentityClaim requires a complete attachment");
  return {
    ...input,
    state: "current",
    nativeIdentity: normalizeNativeRuntimeIdentity(input.nativeIdentity),
    attachment: { ...input.attachment }
  };
}

export function createUnclaimedRuntimeIdentityClaim(input: Omit<UnclaimedRuntimeIdentityClaim, "state" | "nativeIdentity" | "attachment">): UnclaimedRuntimeIdentityClaim {
  assertRuntimeIdentityOwner(input.owner);
  return { ...input, state: "unclaimed", nativeIdentity: null, attachment: null };
}

function assertRuntimeIdentityOwner(owner: RuntimeIdentityOwner): void {
  if (!owner.bindingId.trim() || !Number.isInteger(owner.bindingGeneration) || owner.bindingGeneration < 1 || !Number.isInteger(owner.sessionEpoch) || owner.sessionEpoch < 1) {
    throw new Error("RuntimeIdentityClaim owner must include a binding ID, positive generation, and positive session epoch");
  }
}
