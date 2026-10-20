import type { AuditSkeletonSourceKind, RetentionRefusalReason } from "../retention-barrier.js";

export const RETENTION_COMPACTION_PAGE_LIMIT = 64;

export interface CompactRetentionPageInput {
  kind: AuditSkeletonSourceKind;
  evaluatedAt: string;
  limit: number;
  retentionWindowMs?: number;
}

export interface CompactRetentionPageResult {
  source: AuditSkeletonSourceKind;
  scanned: number;
  compacted: number;
  alreadyCompacted: number;
  refusals: Partial<Record<RetentionRefusalReason, number>>;
  cursor: Readonly<object> | null;
  cycleComplete: boolean;
  eligibleBytes?: number;
}

export interface AuditCoreEventPageInput {
  kind: "core_event";
  evaluatedAt: string;
  retentionWindowMs: number;
  limit: number;
}

export interface AuditCoreEventPageResult {
  source: "core_event";
  scanned: number;
  eligible: number;
  alreadyVerified: number;
  eligibleBytes: number;
  refusals: Partial<Record<RetentionRefusalReason, number>>;
  cursor: Readonly<object> | null;
  cycleComplete: boolean;
}

export interface RetentionCompactionStore {
  auditPage(input: AuditCoreEventPageInput): AuditCoreEventPageResult;
  compactPage(input: CompactRetentionPageInput): CompactRetentionPageResult;
}
