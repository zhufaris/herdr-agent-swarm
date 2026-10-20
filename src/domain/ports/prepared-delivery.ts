import type { DeliveryPreparationState, DeliveryRingWork, PreparedDelivery, PreparedDeliveryAck, PreparedDeliveryCheckpoint, PreparedDeliveryClaim, PreparedDeliveryFailure, PreparedDeliveryPlan, PreparedEffectDeliveryInput, SemanticDeliveryWork, SemanticSnapshotDeliveryInput } from "../delivery.js";
import type { DeliveryRingCheckpoint } from "../checkpoint.js";
import type { DeliveryScope } from "../delivery-scope.js";
import type { DeliveryQuarantineReviewInput } from "../delivery-quarantine-review.js";

export type PreparedDeliveryHeadStatus =
  | "ready"
  | "future_due"
  | "cooldown_blocked"
  | "claimed"
  | "quarantined"
  | "prerequisite_blocked"
  | "dead_letter"
  | "unprepared"
  | "invalid";

export type PreparedDeliveryHydration =
  | { status: "prepared"; delivery: PreparedDelivery }
  | { status: "unprepared" }
  | { status: "invalid"; reason: string }
  | { status: "missing" };

export type DeliveryInputHydration =
  | { status: "semantic-snapshot"; input: SemanticSnapshotDeliveryInput; preparationState: DeliveryPreparationState; preparedDelivery: PreparedDelivery | null }
  | { status: "prepared-effect"; input: PreparedEffectDeliveryInput; delivery: PreparedDelivery }
  | { status: "legacy-unprepared" }
  | { status: "invalid"; reason: string }
  | { status: "missing" };

export type DeliveryWorkHydration =
  | { status: "ready"; work: DeliveryRingWork }
  | { status: "unprepared" | "missing" }
  | { status: "invalid"; reason: string };

export interface PreparedDeliveryScopeHead {
  replyId: string;
  scopeKey: string;
  deliveryOrder: number;
  status: PreparedDeliveryHeadStatus;
  nextAttemptAt: string;
  delivery: DeliveryRingWork | null;
}

export interface PreparedDeliveryHeadPage {
  items: PreparedDeliveryScopeHead[];
  nextCursor: string | null;
}

export interface PreparedDeliveryScopePageItem {
  scope: DeliveryScope;
  scopeKey: string;
  priorCommittedOrder: number | null;
  safeCommittedOrder: number;
  maximumDeliveryOrder: number;
  authoritativeBlocker: { replyId: string; deliveryOrder: number } | null;
  head: PreparedDeliveryScopeHead | null;
  checkpointChanged: boolean;
}

export interface PreparedDeliveryScopePage {
  items: PreparedDeliveryScopePageItem[];
  nextCursor: string | null;
  nextRetryAt: string | null;
  recoveryBlocked: boolean;
}

export type PreparedDeliveryHeadAdvance =
  | { outcome: "advanced"; scopeKey: string; replacementReplyId: string }
  | { outcome: "blocked" };

export type SemanticDeliveryFreeze =
  | { outcome: "prepared"; delivery: PreparedDelivery }
  | { outcome: "stale" };

export interface QuarantinedRingHeadMaintenance {
  transitionedScopeKeys: string[];
  nextCursor: string | null;
}

export interface GlobalRingMaintenance {
  affectedScopeKeys: string[];
}

export type PreparedDeliveryProjectionRecoveryHint =
  | { kind: "card-context"; targetKind: "primary-session" | "worker-session" | "primary-turn"; targetId: string; targetGeneration: number }
  | { kind: "primary-answer"; promptId: string }
  | { kind: "worker-turn"; turnId: string }
  | { kind: "turn-card"; segmentId: string };

export interface ReconstructibleInvalidOwnerMaintenance {
  transitionedScopeKeys: string[];
  projectionRecoveryHints: PreparedDeliveryProjectionRecoveryHint[];
}

export interface OrphanedPrimaryMainPendingMaintenance {
  transitionedScopeKeys: string[];
}

export interface PreparedDeliveryStore {
  setQuarantineReviewRenderer(renderer: (input: DeliveryQuarantineReviewInput) => object): void;
  backfillLegacyConflictKeys?(limit: number): { processedCount: number; hasMore: boolean };
  loadOrInitializeCheckpoint(input: { scope: DeliveryScope; at: string }): DeliveryRingCheckpoint;
  loadScopePage(input: { scope: DeliveryScope | null; afterScopeKey: string | null; limit: number; at: string }): PreparedDeliveryScopePage;
  listScopeHeads(input: { afterScopeKey: string | null; limit: number; at: string }): PreparedDeliveryHeadPage;
  hydratePreparedDelivery(replyId: string): PreparedDeliveryHydration;
  hydrateDeliveryInput(replyId: string): DeliveryInputHydration;
  hydrateDeliveryWork(replyId: string): DeliveryWorkHydration;
  freezeSemanticDelivery(input: { work: SemanticDeliveryWork; preparedPlan: PreparedDeliveryPlan }): SemanticDeliveryFreeze;
  failSemanticDeliveryPreparation(input: { work: SemanticDeliveryWork; error: string }): "failed" | "stale";
  getNextScopeHeadEligibility(at: string): string | null;
  addPrerequisite(input: { dependentReplyId: string; prerequisiteReplyId: string; requiredState: "delivered" | "dismissed" }): void;
  listDependentScopeKeys(prerequisiteReplyId: string, limit: number): string[];
  runGlobalRingMaintenance?(input: { at: string; limit: number }): GlobalRingMaintenance;
  recoverExpiredRingClaims(at: string, limit: number): string[];
  dismissRejectedQuarantineReviewBatch?(input: { at: string; limit: number }): string[];
  coalesceHistoricalPrimaryMainSnapshots?(input: { at: string; limit: number }): string[];
  retireReconstructibleInvalidOwnerHeads?(input: { at: string; limit: number }): ReconstructibleInvalidOwnerMaintenance;
  retireOrphanedPrimaryMainPendingDeliveries?(input: { at: string; limit: number }): OrphanedPrimaryMainPendingMaintenance;
  recoverQuarantinedRingHeads(input: { afterScopeKey: string | null; limit: number; at: string; skipGlobalMaintenance?: boolean }): QuarantinedRingHeadMaintenance;
  advanceSupersededHead(input: { delivery: PreparedDelivery; at: string }): PreparedDeliveryHeadAdvance;
  claimPreparedDelivery(input: { delivery: PreparedDelivery; at: string; expiresAt: string }): PreparedDeliveryClaim | null;
  renewPreparedDeliveryClaim(input: { claim: PreparedDeliveryClaim; at: string; expiresAt: string }): boolean;
  checkpointPreparedDelivery(claim: PreparedDeliveryClaim, checkpoint: PreparedDeliveryCheckpoint): boolean;
  acknowledgePreparedDelivery(claim: PreparedDeliveryClaim, ack: PreparedDeliveryAck): boolean;
  failPreparedDelivery(claim: PreparedDeliveryClaim, failure: PreparedDeliveryFailure): "retry" | "dead_letter" | "stale";
  claimConversationPageDelivery(input: {
    delivery: PreparedDelivery; at: string; expiresAt: string; unclaimedCreateNotBefore?: string;
  }): PreparedDeliveryClaim | null;
  checkpointConversationPageDelivery(claim: PreparedDeliveryClaim, checkpoint: PreparedDeliveryCheckpoint): boolean;
  acknowledgeConversationPageDelivery(claim: PreparedDeliveryClaim, ack: PreparedDeliveryAck): boolean;
  failConversationPageDelivery(claim: PreparedDeliveryClaim, failure: PreparedDeliveryFailure): "retry" | "dead_letter" | "stale";
}
