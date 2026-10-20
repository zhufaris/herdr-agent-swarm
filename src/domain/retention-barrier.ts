export const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const CORE_EVENT_RETENTION_WINDOW_MS = 24 * 60 * 60 * 1_000;
const CANONICAL_RETENTION_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type RetentionRefusalReason =
  | "invalid_evidence"
  | "not_terminal"
  | "retention_window_open"
  | "referenced"
  | "checkpoint_incomplete"
  | "open_gap"
  | "uncertain_effect"
  | "quarantined"
  | "unresolved_recovery"
  | "pending_prerequisite"
  | "replacement_incomplete"
  | "projection_not_reconstructible"
  | "human_input_retained";

export interface RetentionBarrierFacts {
  terminal: boolean;
  terminalAt: string;
  now: string;
  referenceCount: number;
  checkpointSettled: boolean;
  openGapCount: number;
  effect: "certain" | "uncertain";
  activeQuarantineCount: number;
  unresolvedRecoveryCount: number;
  pendingPrerequisiteCount: number;
  replacement: "not-required" | "complete" | "incomplete";
  projectionReconstructible: boolean;
  retentionWindowMs?: number;
}

export type RetentionBarrierDecision =
  | { status: "eligible" }
  | { status: "refused"; reason: RetentionRefusalReason };

export type AuditSkeletonSourceKind = "core_event" | "conversation_segment_item" | "answer_timeline_item" | "delivery";
export type AuditSkeletonLinkKind = "checkpoint" | "gap" | "recovery" | "prerequisite" | "replacement" | "projection" | "owner";

export interface AuditSkeletonIdentity {
  kind: AuditSkeletonSourceKind;
  id: string;
}

export interface AuditSkeletonLink {
  kind: AuditSkeletonLinkKind;
  id: string;
  state: string;
}

export interface AuditSkeletonInput {
  identity: AuditSkeletonIdentity;
  payloadHash: string;
  payloadBytes: number;
  lifecycleState: string;
  owner: {
    kind: string;
    id: string;
    generation: number | null;
    sessionGeneration: number | null;
    parent: { id: string; generation: number; sessionGeneration: number } | null;
    scopeKey: string | null;
  };
  bindingId: string | null;
  promptId: string | null;
  createdAt: string;
  terminalAt: string;
  barrierVersion: number;
  state: "verified" | "compacted";
  verifiedAt: string;
  compactedAt: string | null;
  links: readonly AuditSkeletonLink[];
}

export function evaluateRetentionBarrier(facts: RetentionBarrierFacts): RetentionBarrierDecision {
  const terminalAtMs = parseRetentionTimestampMs(facts.terminalAt);
  const nowMs = parseRetentionTimestampMs(facts.now);
  if (terminalAtMs === null || nowMs === null || !validFacts(facts)) return { status: "refused", reason: "invalid_evidence" };
  if (!facts.terminal) return { status: "refused", reason: "not_terminal" };
  const retentionWindowMs = facts.retentionWindowMs ?? RETENTION_WINDOW_MS;
  if (!Number.isSafeInteger(retentionWindowMs) || retentionWindowMs < 0) return { status: "refused", reason: "invalid_evidence" };
  if (nowMs - terminalAtMs <= retentionWindowMs) return { status: "refused", reason: "retention_window_open" };
  if (facts.referenceCount > 0) return { status: "refused", reason: "referenced" };
  if (!facts.checkpointSettled) return { status: "refused", reason: "checkpoint_incomplete" };
  if (facts.openGapCount > 0) return { status: "refused", reason: "open_gap" };
  if (facts.effect === "uncertain") return { status: "refused", reason: "uncertain_effect" };
  if (facts.activeQuarantineCount > 0) return { status: "refused", reason: "quarantined" };
  if (facts.unresolvedRecoveryCount > 0) return { status: "refused", reason: "unresolved_recovery" };
  if (facts.pendingPrerequisiteCount > 0) return { status: "refused", reason: "pending_prerequisite" };
  if (facts.replacement === "incomplete") return { status: "refused", reason: "replacement_incomplete" };
  if (!facts.projectionReconstructible) return { status: "refused", reason: "projection_not_reconstructible" };
  return { status: "eligible" };
}

function validFacts(facts: RetentionBarrierFacts): boolean {
  return [facts.referenceCount, facts.openGapCount, facts.activeQuarantineCount, facts.unresolvedRecoveryCount, facts.pendingPrerequisiteCount]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
}

export function parseRetentionTimestampMs(value: string): number | null {
  if (!CANONICAL_RETENTION_TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return new Date(parsed).toISOString() === value ? parsed : null;
}
