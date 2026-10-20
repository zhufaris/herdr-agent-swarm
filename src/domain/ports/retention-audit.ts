import type { AuditSkeletonIdentity, AuditSkeletonInput, RetentionRefusalReason } from "../retention-barrier.js";
import type { DeliveryOwnerFence } from "../delivery-scope.js";

interface BaseRetentionCandidateIdentity {
  id: string;
  expectedPayloadHash?: string;
}

export interface DeliveryRetentionCandidateIdentity extends BaseRetentionCandidateIdentity {
  kind: "delivery";
  expectedOwnerFence?: DeliveryOwnerFence | null;
}

export interface CoreEventRetentionCandidateIdentity extends BaseRetentionCandidateIdentity {
  kind: "core_event";
  retentionWindowMs?: number;
}
export interface ConversationItemRetentionCandidateIdentity extends BaseRetentionCandidateIdentity { kind: "conversation_segment_item" }
export interface TimelineItemRetentionCandidateIdentity extends BaseRetentionCandidateIdentity { kind: "answer_timeline_item" }

export type RetentionCandidateIdentity = DeliveryRetentionCandidateIdentity | CoreEventRetentionCandidateIdentity
  | ConversationItemRetentionCandidateIdentity | TimelineItemRetentionCandidateIdentity;

export type RetentionAuditRecordResult =
  | { status: "recorded" | "existing"; skeleton: AuditSkeletonInput }
  | { status: "refused"; reason: RetentionRefusalReason }
  | { status: "missing" | "stale_owner" };

export interface RetentionAuditStore {
  prepare(candidate: RetentionCandidateIdentity, evaluatedAt: string): RetentionAuditRecordResult;
  load(identity: AuditSkeletonIdentity): AuditSkeletonInput | null;
}
