import type { RetentionAuditStore } from "./retention-audit.js";
import type { RetentionCompactionStore } from "./retention-compaction.js";

export interface RetentionStore extends RetentionAuditStore, RetentionCompactionStore {
  backfillCoreEventDiscriminators?(limit: number): { state: "backfilling" | "complete"; processed: number; remaining: boolean };
  classifyHistoricalDeliveryDebt?(cutoff: string, limit: number): HistoricalDeliveryDebtMaintenance;
  compactDeliveryIntents?(limit: number): number;
  pruneCompensatedProjectionGaps?(cutoff: string, limit: number): number;
  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number;
  pruneAcceptedInboundMessages(cutoff: string, limit: number): number;
  pruneTerminalSessionOperations(cutoff: string, limit: number): number;
}

export interface HistoricalDeliveryDebtMaintenance {
  settledProjectionGaps: number;
  releasedQuarantines: number;
  classifiedDeliveryRecoveries: number;
  classifiedProjectionGaps: number;
}
