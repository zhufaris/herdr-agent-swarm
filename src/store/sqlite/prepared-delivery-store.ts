import { createHash, randomUUID } from "node:crypto";
import { PreparedDeliveryPoisonError, type DeliveryPreparationState, type DeliveryRingWork, type PreparedDelivery, type PreparedDeliveryAck, type PreparedDeliveryCheckpoint, type PreparedDeliveryClaim, type PreparedDeliveryFailure, type PreparedDeliveryPlan, type SemanticDeliveryWork } from "../../domain/delivery.js";
import { decodeDeliverySubject, decodeSemanticSnapshotDeliveryInput, encodePresentationSnapshot, encodeDeliverySubject, presentationSnapshotHash } from "../../domain/delivery-intent.js";
import { deliveryRingCheckpoint, type DeliveryRingCheckpoint } from "../../domain/checkpoint.js";
import { deliveryScopeKey } from "../../domain/delivery-scope.js";
import type { DeliveryInputHydration, DeliveryWorkHydration, GlobalRingMaintenance, OrphanedPrimaryMainPendingMaintenance, PreparedDeliveryHeadAdvance, PreparedDeliveryHeadPage, PreparedDeliveryHydration, PreparedDeliveryProjectionRecoveryHint, PreparedDeliveryScopeHead, PreparedDeliveryScopePage, PreparedDeliveryScopePageItem, PreparedDeliveryStore, QuarantinedRingHeadMaintenance, ReconstructibleInvalidOwnerMaintenance } from "../../domain/ports/prepared-delivery.js";
import type { DeliveryEngineRefillPort, DeliveryEngineRefillResult } from "../../domain/delivery-engine.js";
import type { DeliveryScope } from "../../domain/delivery-scope.js";
import type { OutboundReply } from "../../domain/types.js";
import { mapOutboundReply, type OutboundReplyRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { EnqueueOutboundReplyInput, SqliteOutboxQueueStore } from "./outbox-queue-store.js";
import type { SqliteOutboxRecoveryStore } from "./outbox-recovery-store.js";
import type { SqliteOutboxDeliveryStore } from "./outbox-delivery-store.js";
import type { PostCommitReceipt } from "./post-commit-receipt.js";
import { exactReplaceableCardTargetSql } from "./replaceable-card-policy.js";
import { parseLeaseTimestampMs } from "./lease-time.js";
import { deliveryConflictKey, deliveryDegradationBudget } from "../../domain/delivery-conflict.js";
import { planDeliveryRetry } from "../../domain/delivery-retry-policy.js";
import { isDirectDeliveryRetryAllowed, isReplaySafeSupersession } from "../../domain/delivery-replay-safety.js";
import { transferDeliveryPrerequisites } from "./delivery-prerequisites.js";
import type { DeliveryQuarantineReviewInput } from "../../domain/delivery-quarantine-review.js";
import type { SemanticDeliveryReservationInput } from "../../domain/ports/outbox.js";
import { parseTurnCardProjectionKey } from "../../domain/turn-card-projection-key.js";
import { settleConversationPageDelivery } from "./conversation-segment-store.js";
import { confirmDeliveryRecoveries } from "./delivery-recovery-evidence.js";
import { SqliteProjectionGapStore } from "./projection-gap-store.js";
import type { DeliveryLatencyTrace } from "../../domain/delivery-trace.js";

type HeadCandidateRow = {
  id: string;
  scope_key: string;
  delivery_order: number;
  state: string;
  claim_attempt_id: string | null;
  next_attempt_at: string;
  quarantined: number;
  unmet_prerequisites: number;
};
type SemanticDeliveryRow = OutboundReplyRow & {
  delivery_input_kind: string | null;
  subject_kind: string | null;
  subject_json: string | null;
  subject_revision: number | null;
  presentation_snapshot_json: string | null;
  presentation_snapshot_hash: string | null;
  planner_policy_version: number | null;
  renderer_policy_version: number | null;
  gateway_profile_version: number | null;
  preparation_state: string | null;
};
type ScopePageRow = {
  page_scope_key: string;
  page_rank: number;
  prior_committed_order: number | null;
  checkpoint_scope_kind: string | null;
  checkpoint_workspace_id: string | null;
  checkpoint_pane_id: string | null;
  reply_scope_kind: string | null;
  reply_workspace_id: string | null;
  reply_pane_id: string | null;
  reply_identity_conflict: number | null;
  blocker_reply_id: string | null;
  blocker_delivery_order: number | null;
  maximum_delivery_order: number | null;
  cooldown_until: string | null;
  head_id: string | null;
  head_scope_key: string | null;
  head_delivery_order: number | null;
  head_state: string | null;
  head_claim_attempt_id: string | null;
  head_next_attempt_at: string | null;
  quarantined: number | null;
  unmet_prerequisites: number | null;
};
type ScopeIdentityRow = Pick<ScopePageRow,
  "page_scope_key" | "checkpoint_scope_kind" | "checkpoint_workspace_id" | "checkpoint_pane_id"
  | "reply_scope_kind" | "reply_workspace_id" | "reply_pane_id" | "reply_identity_conflict">;
type CheckpointFactRow = ScopeIdentityRow & Pick<ScopePageRow,
  "prior_committed_order"
  | "blocker_reply_id" | "blocker_delivery_order" | "maximum_delivery_order">;
type DeliveryCheckpointRow = {
  scope_key: string;
  scope_kind: string;
  scope_workspace_id: string | null;
  scope_pane_id: string | null;
  committed_delivery_order: number;
  updated_at: string;
};
type ReconstructibleInvalidOwnerRow = {
  id: string;
  snapshot_revision: number;
  scope_key: string;
  scope_workspace_id: string;
  scope_pane_id: string;
  lane_key: string;
  current_owner_id: string;
  current_owner_generation: number;
};
type OrphanedPrimaryMainPendingRow = {
  id: string;
  snapshot_revision: number;
  scope_key: string;
  scope_workspace_id: string;
  scope_pane_id: string;
  lane_key: string;
};
type OrphanedPrimaryMainPendingCandidate = {
  id: string;
  scope_key: string;
  delivery_order: number;
};
type OrphanedPrimaryMainPendingCursor = {
  scopeKey: string;
  deliveryOrder: number;
  id: string;
};
const rejectedQuarantineReviewBatchLimit = 512;
const terminalReplacementSql = (row: string) => `EXISTS (
  SELECT 1 FROM delivery_recoveries recovery
  JOIN outbound_replies replacement ON replacement.id=recovery.replacement_reply_id
  WHERE recovery.failed_reply_id=${row}.id AND recovery.state IN ('replacement_pending','recovered')
    AND recovery.replacement_reply_id IS NOT NULL
    AND (recovery.resolved_by_reply_id IS NULL OR recovery.resolved_by_reply_id=recovery.replacement_reply_id)
    AND replacement.state='delivered'
)`;
const exactPendingPrimaryMainRecoverySuccessorSql = (row: string) => `EXISTS (
  SELECT 1 FROM delivery_recoveries recovery
  JOIN outbound_replies replacement ON replacement.id=recovery.replacement_reply_id
  WHERE recovery.failed_reply_id=${row}.id AND recovery.state='replacement_pending'
    AND recovery.action='rebuild_main'
    AND recovery.replacement_reply_id IS NOT NULL AND recovery.resolved_by_reply_id IS NULL
    AND ${row}.delivery_owner_kind='primary' AND ${row}.binding_id IS NOT NULL
    AND replacement.state='pending' AND replacement.kind='card_reply'
    AND replacement.projection_key=${row}.projection_key
    AND replacement.binding_id=${row}.binding_id
    AND replacement.delivery_owner_kind='primary'
    AND replacement.delivery_owner_id=${row}.delivery_owner_id
    AND replacement.delivery_owner_generation=${row}.delivery_owner_generation
    AND replacement.delivery_owner_session_generation=${row}.delivery_owner_session_generation
    AND replacement.scope_key=${row}.scope_key
)`;
const exactPendingWorkerMainRecoverySuccessorSql = (row: string) => `EXISTS (
  SELECT 1 FROM delivery_recoveries recovery
  JOIN outbound_replies replacement ON replacement.id=recovery.replacement_reply_id
  WHERE recovery.failed_reply_id=${row}.id AND recovery.state='replacement_pending'
    AND recovery.replacement_reply_id IS NOT NULL AND recovery.resolved_by_reply_id IS NULL
    AND ${row}.worker_id IS NOT NULL AND ${row}.worker_session_generation IS NOT NULL
    AND replacement.state='pending'
    AND replacement.kind='group_card_create'
    AND replacement.projection_key='worker-main-recovery:' || ${row}.id
    AND replacement.worker_id=${row}.worker_id
    AND replacement.worker_session_generation=${row}.worker_session_generation
    AND replacement.binding_id IS ${row}.binding_id
    AND replacement.scope_key=${row}.scope_key
)`;
const exactPendingPrimaryAnswerRecoverySuccessorSql = (row: string) => `EXISTS (
  SELECT 1 FROM delivery_recoveries recovery
  JOIN outbound_replies replacement ON replacement.id=recovery.replacement_reply_id
  WHERE recovery.failed_reply_id=${row}.id AND recovery.state='replacement_pending'
    AND recovery.action IN ('rebuild_answer','expired_view_target')
    AND recovery.replacement_reply_id IS NOT NULL AND recovery.resolved_by_reply_id IS NULL
    AND ${row}.prompt_id IS NOT NULL AND ${row}.stream_page_index IS NOT NULL
    AND replacement.state='pending' AND replacement.kind='stream_card_create'
    AND replacement.prompt_id=${row}.prompt_id
    AND replacement.stream_page_index=${row}.stream_page_index+1
    AND replacement.delivery_owner_kind='primary'
    AND replacement.delivery_owner_id=${row}.delivery_owner_id
    AND replacement.delivery_owner_generation=${row}.delivery_owner_generation
    AND replacement.delivery_owner_session_generation=${row}.delivery_owner_session_generation
    AND replacement.scope_key=${row}.scope_key
)`;
const exactPendingPrimaryAnswerRecoveryConversationSql = (row: string) => `EXISTS (
  SELECT 1 FROM delivery_recoveries recovery
  JOIN outbound_replies replacement ON replacement.id=recovery.replacement_reply_id
  JOIN binding_thread_aliases alias ON alias.id=replacement.thread_alias_id
  WHERE recovery.failed_reply_id=${row}.id AND recovery.state='replacement_pending'
    AND recovery.action='create_recovery_conversation'
    AND recovery.replacement_reply_id IS NOT NULL AND recovery.resolved_by_reply_id IS NULL
    AND ${row}.prompt_id IS NOT NULL
    AND replacement.state='pending' AND replacement.kind='group_card_create'
    AND replacement.prompt_id=${row}.prompt_id
    AND replacement.stream_page_index IN (${row}.stream_page_index,${row}.stream_page_index+1)
    AND replacement.delivery_owner_kind='primary'
    AND replacement.delivery_owner_id=${row}.delivery_owner_id
    AND replacement.delivery_owner_generation=${row}.delivery_owner_generation
    AND replacement.delivery_owner_session_generation=${row}.delivery_owner_session_generation
    AND replacement.scope_key=${row}.scope_key
    AND alias.id=replacement.thread_alias_id AND alias.binding_id=${row}.binding_id
    AND alias.binding_generation=${row}.delivery_owner_generation
    AND alias.pane_id=${row}.scope_pane_id AND alias.state='reserving'
)`;
const exactPendingWorkerTaskRecoverySuccessorSql = (row: string) => `EXISTS (
  SELECT 1 FROM delivery_recoveries recovery
  JOIN outbound_replies replacement ON replacement.id=recovery.replacement_reply_id
  WHERE recovery.failed_reply_id=${row}.id AND recovery.state='replacement_pending'
    AND recovery.action='rebuild_worker_task'
    AND recovery.replacement_reply_id IS NOT NULL AND recovery.resolved_by_reply_id IS NULL
    AND ${row}.worker_turn_id IS NOT NULL AND ${row}.stream_page_index IS NOT NULL
    AND replacement.state='pending'
    AND replacement.kind='stream_card_create'
    AND replacement.worker_turn_id=${row}.worker_turn_id
    AND replacement.stream_page_index=${row}.stream_page_index+1
    AND replacement.delivery_owner_kind='worker'
    AND replacement.delivery_owner_id=${row}.delivery_owner_id
    AND replacement.delivery_owner_generation=${row}.delivery_owner_generation
    AND replacement.delivery_owner_session_generation=${row}.delivery_owner_session_generation
    AND replacement.delivery_parent_id=${row}.delivery_parent_id
    AND replacement.delivery_parent_generation=${row}.delivery_parent_generation
    AND replacement.delivery_parent_session_generation=${row}.delivery_parent_session_generation
    AND replacement.delivery_parent_pane_id=${row}.delivery_parent_pane_id
    AND replacement.scope_key=${row}.scope_key
)`;
const exactPendingExpiredWorkerTurnRecoverySuccessorSql = (row: string) => `EXISTS (
  SELECT 1 FROM delivery_recoveries recovery
  JOIN outbound_replies replacement ON replacement.id=recovery.replacement_reply_id
  WHERE recovery.failed_reply_id=${row}.id AND recovery.state='replacement_pending'
    AND recovery.action IN ('replace_expired_worker_target','startup_replace_expired_worker_target')
    AND recovery.replacement_reply_id IS NOT NULL AND recovery.resolved_by_reply_id IS NULL
    AND ${row}.worker_turn_id IS NOT NULL AND replacement.state='pending'
    AND replacement.kind='group_card_create'
    AND replacement.projection_key='worker-turn-recovery:' || ${row}.id
    AND replacement.worker_turn_id=${row}.worker_turn_id
    AND replacement.delivery_owner_kind='worker'
    AND replacement.delivery_owner_id=${row}.delivery_owner_id
    AND replacement.delivery_owner_generation=${row}.delivery_owner_generation
    AND replacement.delivery_owner_session_generation=${row}.delivery_owner_session_generation
    AND replacement.delivery_parent_id=${row}.delivery_parent_id
    AND replacement.delivery_parent_generation=${row}.delivery_parent_generation
    AND replacement.delivery_parent_session_generation=${row}.delivery_parent_session_generation
    AND replacement.delivery_parent_pane_id=${row}.delivery_parent_pane_id
    AND replacement.scope_key=${row}.scope_key
)`;
const exactPendingWorkerTaskRecoveryConversationSuccessorSql = (row: string) => `EXISTS (
  SELECT 1 FROM delivery_recoveries recovery
  JOIN outbound_replies replacement ON replacement.id=recovery.replacement_reply_id
  JOIN binding_thread_aliases alias ON alias.id=replacement.thread_alias_id
  WHERE recovery.failed_reply_id=${row}.id AND recovery.state='replacement_pending'
    AND recovery.action='create_recovery_conversation'
    AND recovery.replacement_reply_id IS NOT NULL AND recovery.resolved_by_reply_id IS NULL
    AND ${row}.worker_turn_id IS NOT NULL AND replacement.state='pending'
    AND replacement.kind='group_card_create' AND replacement.worker_turn_id=${row}.worker_turn_id
    AND replacement.projection_key='worker-task-recovery-thread:' || ${row}.worker_turn_id || ':' || replacement.stream_page_index || ':' || alias.action_message_id
    AND replacement.delivery_owner_kind='worker'
    AND replacement.delivery_owner_id=${row}.delivery_owner_id
    AND replacement.delivery_owner_generation=${row}.delivery_owner_generation
    AND replacement.delivery_owner_session_generation=${row}.delivery_owner_session_generation
    AND replacement.delivery_parent_id=${row}.delivery_parent_id
    AND replacement.delivery_parent_generation=${row}.delivery_parent_generation
    AND replacement.delivery_parent_session_generation=${row}.delivery_parent_session_generation
    AND replacement.delivery_parent_pane_id=${row}.delivery_parent_pane_id
    AND replacement.scope_key=${row}.scope_key
)`;
const exactPendingWorkerTaskRecoveryCreateAliasSuccessorSql = (row: string) => `EXISTS (
  SELECT 1 FROM binding_thread_aliases alias
  JOIN outbound_replies replacement ON replacement.thread_alias_id=alias.id
  JOIN delivery_recoveries recovery ON recovery.replacement_reply_id=replacement.id
  WHERE alias.action_message_id=${row}.id AND recovery.state='replacement_pending'
    AND recovery.action='create_recovery_conversation' AND recovery.resolved_by_reply_id IS NULL
    AND ${row}.worker_turn_id IS NOT NULL AND replacement.state='pending'
    AND replacement.kind='group_card_create' AND replacement.worker_turn_id=${row}.worker_turn_id
    AND replacement.projection_key='worker-task-recovery-thread:' || ${row}.worker_turn_id || ':' || replacement.stream_page_index || ':' || ${row}.id
    AND replacement.delivery_owner_kind='worker'
    AND replacement.delivery_owner_id=${row}.delivery_owner_id
    AND replacement.delivery_owner_generation=${row}.delivery_owner_generation
    AND replacement.delivery_owner_session_generation=${row}.delivery_owner_session_generation
    AND replacement.delivery_parent_id=${row}.delivery_parent_id
    AND replacement.delivery_parent_generation=${row}.delivery_parent_generation
    AND replacement.delivery_parent_session_generation=${row}.delivery_parent_session_generation
    AND replacement.delivery_parent_pane_id=${row}.delivery_parent_pane_id
    AND replacement.scope_key=${row}.scope_key
)`;
const exactPendingWorkerHumanReviewRecoverySuccessorSql = (row: string) => `EXISTS (
  SELECT 1 FROM delivery_recoveries recovery
  JOIN outbound_replies replacement ON replacement.id=recovery.replacement_reply_id
  JOIN worker_human_review_episodes episode
    ON replacement.projection_key='human-review:worker:' || episode.id || ':surface:' || episode.surface_generation
  WHERE recovery.failed_reply_id=${row}.id AND recovery.state='replacement_pending'
    AND recovery.action='replace_human_review_target'
    AND recovery.replacement_reply_id IS NOT NULL AND recovery.resolved_by_reply_id IS NULL
    AND replacement.state='pending'
    AND replacement.kind='card_reply' AND replacement.id=episode.create_reply_id
    AND replacement.worker_id=${row}.delivery_owner_id
    AND replacement.worker_session_generation=${row}.delivery_owner_session_generation
    AND replacement.delivery_owner_kind='worker'
    AND replacement.delivery_owner_id=${row}.delivery_owner_id
    AND replacement.delivery_owner_generation=${row}.delivery_owner_generation
    AND replacement.delivery_owner_session_generation=${row}.delivery_owner_session_generation
    AND replacement.delivery_parent_id=${row}.delivery_parent_id
    AND replacement.delivery_parent_generation=${row}.delivery_parent_generation
    AND replacement.delivery_parent_session_generation=${row}.delivery_parent_session_generation
    AND replacement.delivery_parent_pane_id=${row}.delivery_parent_pane_id
    AND replacement.scope_key=${row}.scope_key
)`;
const exactPendingRecoverySuccessorSql = (row: string) => `(
  ${exactPendingPrimaryMainRecoverySuccessorSql(row)}
  OR ${exactPendingWorkerMainRecoverySuccessorSql(row)}
  OR ${exactPendingPrimaryAnswerRecoverySuccessorSql(row)}
  OR ${exactPendingPrimaryAnswerRecoveryConversationSql(row)}
  OR ${exactPendingWorkerTaskRecoverySuccessorSql(row)}
  OR ${exactPendingExpiredWorkerTurnRecoverySuccessorSql(row)}
  OR ${exactPendingWorkerTaskRecoveryConversationSuccessorSql(row)}
  OR ${exactPendingWorkerTaskRecoveryCreateAliasSuccessorSql(row)}
  OR ${exactPendingWorkerHumanReviewRecoverySuccessorSql(row)}
)`;
export const nonterminalReplySql = (row: string) => `(${row}.state='pending' OR (${row}.state='dead_letter'
  AND NOT (${terminalReplacementSql(row)})
  AND NOT (${exactPendingRecoverySuccessorSql(row)})))`;
const semanticSettlementGapSql = (row: string) => `EXISTS (
  SELECT 1 FROM projection_gaps settlement_gap
  JOIN outbound_replies settled_effect ON settled_effect.id=settlement_gap.source_item_id
  WHERE settlement_gap.state='open' AND settlement_gap.failure_code='semantic_subject_settlement_mismatch'
    AND settled_effect.delivery_input_kind='semantic-snapshot' AND ${row}.delivery_input_kind='semantic-snapshot'
    AND json_extract(settled_effect.subject_json,'$.kind')='conversation-page'
    AND json_extract(${row}.subject_json,'$.kind')='conversation-page'
    AND json_extract(settled_effect.subject_json,'$.segmentId')=json_extract(${row}.subject_json,'$.segmentId')
    AND json_extract(settled_effect.subject_json,'$.pageIndex')=json_extract(${row}.subject_json,'$.pageIndex')
)`;
const authoritativeRingBlockerSql = (row: string) => `((${row}.state IN ('pending','dead_letter') AND ${nonterminalReplySql(row)})
  OR (${row}.state='delivered' AND ${semanticSettlementGapSql(row)}))`;
const bypassesPendingRecoverySuccessorSql = (row: string) => `EXISTS (
  SELECT 1 FROM outbound_replies blocked
  WHERE blocked.scope_key=${row}.scope_key AND blocked.state='dead_letter'
    AND blocked.delivery_order<${row}.delivery_order
    AND ${exactPendingRecoverySuccessorSql("blocked")}
    AND NOT EXISTS (
      SELECT 1 FROM delivery_recoveries linked
      WHERE linked.failed_reply_id=blocked.id AND linked.state='replacement_pending'
        AND linked.replacement_reply_id=${row}.id
    )
)`;
const hasActiveConflictIsolationSql = (row: string) => `EXISTS (
  SELECT 1 FROM outbox_lane_quarantines isolated
  JOIN outbound_replies isolated_failed ON isolated_failed.id=isolated.failed_reply_id
  WHERE isolated.state='active' AND isolated.phase='conflict_isolated'
    AND isolated_failed.scope_key=${row}.scope_key AND isolated.conflict_key=${row}.conflict_key
)`;
const eligibleConflictBypassSql = (row: string) => `(
  ${row}.state='pending' AND ${row}.claim_attempt_id IS NULL
  AND ${row}.next_attempt_at<=(SELECT at FROM query_clock)
  AND EXISTS (
    SELECT 1 FROM outbox_lane_quarantines isolated_gap
    JOIN outbound_replies isolated_failed ON isolated_failed.id=isolated_gap.failed_reply_id
    WHERE isolated_gap.state='active' AND isolated_gap.phase='conflict_isolated'
      AND isolated_failed.scope_key=${row}.scope_key
      AND isolated_failed.delivery_order<${row}.delivery_order
      AND ${nonterminalReplySql("isolated_failed")}
  )
  AND NOT (${hasActiveConflictIsolationSql(row)})
  AND NOT EXISTS (
    SELECT 1 FROM outbound_replies same_conflict INDEXED BY outbound_replies_scope_conflict_order
    WHERE same_conflict.scope_key=${row}.scope_key
      AND same_conflict.delivery_order<${row}.delivery_order
      AND same_conflict.conflict_key=${row}.conflict_key
      AND same_conflict.state IN ('pending','dead_letter')
      AND ${nonterminalReplySql("same_conflict")}
  )
  AND NOT EXISTS (
    SELECT 1 FROM outbound_reply_prerequisites prerequisite
    LEFT JOIN outbound_replies required ON required.id=prerequisite.prerequisite_reply_id
    WHERE prerequisite.dependent_reply_id=${row}.id
      AND (required.id IS NULL OR required.state!=prerequisite.required_state)
  )
  AND NOT EXISTS (
    SELECT 1 FROM outbound_replies active_claim
    WHERE active_claim.scope_key=${row}.scope_key AND active_claim.state='pending'
      AND active_claim.claim_attempt_id IS NOT NULL
  )
)`;
const claimConflictEligibilitySql = (row: string) => `(
  NOT (${semanticSettlementGapSql(row)})
  AND
  NOT EXISTS (
    SELECT 1 FROM outbound_replies active_claim
    WHERE active_claim.scope_key=${row}.scope_key AND active_claim.state='pending'
      AND active_claim.claim_attempt_id IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM outbox_lane_quarantines grace
    JOIN outbound_replies grace_failed ON grace_failed.id=grace.failed_reply_id
    WHERE grace.state='active' AND grace.phase IS NOT 'conflict_isolated'
      AND grace_failed.scope_key=${row}.scope_key
  )
  AND NOT (${hasActiveConflictIsolationSql(row)})
  AND NOT EXISTS (
    SELECT 1 FROM outbound_replies same_conflict INDEXED BY outbound_replies_scope_conflict_order
    WHERE same_conflict.scope_key=${row}.scope_key
      AND same_conflict.delivery_order<${row}.delivery_order
      AND same_conflict.conflict_key=${row}.conflict_key
      AND same_conflict.state IN ('pending','dead_letter')
      AND ${nonterminalReplySql("same_conflict")}
  )
  AND (
    NOT EXISTS (
      SELECT 1 FROM outbound_replies older
      WHERE older.scope_key=${row}.scope_key AND older.delivery_order<${row}.delivery_order
        AND ${nonterminalReplySql("older")}
        AND NOT (${semanticSettlementGapSql("older")})
    )
    OR EXISTS (
      SELECT 1 FROM outbox_lane_quarantines isolated_gap
      JOIN outbound_replies isolated_failed ON isolated_failed.id=isolated_gap.failed_reply_id
      WHERE isolated_gap.state='active' AND isolated_gap.phase='conflict_isolated'
        AND isolated_failed.scope_key=${row}.scope_key
        AND isolated_failed.delivery_order<${row}.delivery_order
        AND ${nonterminalReplySql("isolated_failed")}
    )
  )
)`;

const scopePageCte = (exact: boolean) => exact ? `WITH scope_page(scope_key,page_rank) AS (
  SELECT ?,1 WHERE EXISTS(SELECT 1 FROM delivery_ring_checkpoints WHERE scope_key=?)
    OR EXISTS(SELECT 1 FROM outbound_replies WHERE scope_key=? LIMIT 1)
)` : `WITH checkpoint_candidates AS (
  SELECT scope_key FROM delivery_ring_checkpoints
  WHERE (? IS NULL OR scope_key>?) ORDER BY scope_key LIMIT ?
), reply_candidates AS (
  SELECT scope_key FROM outbound_replies INDEXED BY outbound_replies_scope_nonterminal_order
  WHERE scope_key IS NOT NULL AND state IN ('pending','dead_letter')
    AND (? IS NULL OR scope_key>?)
  GROUP BY scope_key ORDER BY scope_key LIMIT ?
), combined_candidates AS (
  SELECT scope_key FROM checkpoint_candidates UNION SELECT scope_key FROM reply_candidates
), bounded_candidates AS (
  SELECT scope_key FROM combined_candidates ORDER BY scope_key LIMIT ?
), scope_page AS (
  SELECT scope_key,ROW_NUMBER() OVER (ORDER BY scope_key) AS page_rank FROM bounded_candidates
)`;

const scopePageQuery = (exact: boolean) => `${scopePageCte(exact)}, real_scopes AS (
  SELECT scope_key,page_rank FROM scope_page WHERE page_rank<=?
), query_clock(at) AS (
  SELECT ?
), scope_identity AS (
  SELECT page.scope_key,page.page_rank,
    checkpoint.committed_delivery_order AS prior_committed_order,
    checkpoint.scope_kind AS checkpoint_scope_kind,
    checkpoint.scope_workspace_id AS checkpoint_workspace_id,
    checkpoint.scope_pane_id AS checkpoint_pane_id,
    (SELECT identity.scope_kind FROM outbound_replies identity WHERE identity.scope_key=page.scope_key ORDER BY identity.delivery_order LIMIT 1) AS reply_scope_kind,
    (SELECT identity.scope_workspace_id FROM outbound_replies identity WHERE identity.scope_key=page.scope_key ORDER BY identity.delivery_order LIMIT 1) AS reply_workspace_id,
    (SELECT identity.scope_pane_id FROM outbound_replies identity WHERE identity.scope_key=page.scope_key ORDER BY identity.delivery_order LIMIT 1) AS reply_pane_id,
    EXISTS(SELECT 1 FROM outbound_replies identity WHERE identity.scope_key=page.scope_key AND (
      identity.scope_kind IS NOT COALESCE(checkpoint.scope_kind,(SELECT first_identity.scope_kind FROM outbound_replies first_identity WHERE first_identity.scope_key=page.scope_key ORDER BY first_identity.delivery_order LIMIT 1))
      OR identity.scope_workspace_id IS NOT COALESCE(checkpoint.scope_workspace_id,(SELECT first_identity.scope_workspace_id FROM outbound_replies first_identity WHERE first_identity.scope_key=page.scope_key ORDER BY first_identity.delivery_order LIMIT 1))
      OR identity.scope_pane_id IS NOT COALESCE(checkpoint.scope_pane_id,(SELECT first_identity.scope_pane_id FROM outbound_replies first_identity WHERE first_identity.scope_key=page.scope_key ORDER BY first_identity.delivery_order LIMIT 1))
    )) AS reply_identity_conflict
  FROM real_scopes page LEFT JOIN delivery_ring_checkpoints checkpoint ON checkpoint.scope_key=page.scope_key
), blocker_facts AS (
  SELECT identity.*,
    (SELECT blocker.id FROM outbound_replies blocker
      WHERE blocker.scope_key=identity.scope_key AND ${authoritativeRingBlockerSql("blocker")}
      ORDER BY blocker.delivery_order LIMIT 1) AS blocker_reply_id,
    (SELECT blocker.delivery_order FROM outbound_replies blocker
      WHERE blocker.scope_key=identity.scope_key AND ${authoritativeRingBlockerSql("blocker")}
      ORDER BY blocker.delivery_order LIMIT 1) AS blocker_delivery_order,
    (SELECT maximum.delivery_order FROM outbound_replies maximum INDEXED BY outbound_replies_scope_delivery_order
      WHERE maximum.scope_key=identity.scope_key ORDER BY maximum.delivery_order DESC LIMIT 1) AS maximum_delivery_order,
    COALESCE(
      (SELECT claimed_candidate.id FROM outbound_replies claimed_candidate INDEXED BY outbound_replies_scope_nonterminal_order
        WHERE claimed_candidate.scope_key=identity.scope_key
          AND claimed_candidate.state IN ('pending','dead_letter')
          AND NOT (${semanticSettlementGapSql("claimed_candidate")})
          AND claimed_candidate.claim_attempt_id IS NOT NULL
          AND ${nonterminalReplySql("claimed_candidate")}
          AND NOT (${bypassesPendingRecoverySuccessorSql("claimed_candidate")})
        ORDER BY claimed_candidate.delivery_order LIMIT 1),
      (SELECT bypass_candidate.id FROM outbound_replies bypass_candidate INDEXED BY outbound_replies_scope_nonterminal_order
        WHERE bypass_candidate.scope_key=identity.scope_key
          AND bypass_candidate.state IN ('pending','dead_letter')
          AND NOT (${semanticSettlementGapSql("bypass_candidate")})
          AND ${nonterminalReplySql("bypass_candidate")}
          AND NOT (${bypassesPendingRecoverySuccessorSql("bypass_candidate")})
          AND ${eligibleConflictBypassSql("bypass_candidate")}
        ORDER BY bypass_candidate.delivery_order LIMIT 1),
      (SELECT fallback_candidate.id FROM outbound_replies fallback_candidate INDEXED BY outbound_replies_scope_nonterminal_order
        WHERE fallback_candidate.scope_key=identity.scope_key
          AND fallback_candidate.state IN ('pending','dead_letter')
          AND NOT (${semanticSettlementGapSql("fallback_candidate")})
          AND ${nonterminalReplySql("fallback_candidate")}
          AND NOT (${bypassesPendingRecoverySuccessorSql("fallback_candidate")})
        ORDER BY fallback_candidate.delivery_order LIMIT 1)
    ) AS head_reply_id
  FROM scope_identity identity
), app_cooldown AS (
  SELECT blocked_until FROM lark_delivery_cooldowns
  WHERE scope='app' AND blocked_until>(SELECT at FROM query_clock) LIMIT 1
)
SELECT page.scope_key AS page_scope_key,page.page_rank,
  facts.prior_committed_order,facts.checkpoint_scope_kind,facts.checkpoint_workspace_id,facts.checkpoint_pane_id,
  facts.reply_scope_kind,facts.reply_workspace_id,facts.reply_pane_id,facts.reply_identity_conflict,
  facts.blocker_reply_id,facts.blocker_delivery_order,facts.maximum_delivery_order,
  CASE WHEN page.page_rank<=? THEN (SELECT blocked_until FROM app_cooldown) ELSE NULL END AS cooldown_until,
  head.id AS head_id,
  head.scope_key AS head_scope_key,
  head.delivery_order AS head_delivery_order,
  head.state AS head_state,
  head.claim_attempt_id AS head_claim_attempt_id,
  head.next_attempt_at AS head_next_attempt_at,
  CASE WHEN head.id IS NULL THEN NULL ELSE EXISTS(
    SELECT 1 FROM outbox_lane_quarantines q JOIN outbound_replies failed ON failed.id=q.failed_reply_id
    WHERE q.state='active' AND failed.scope_key=head.scope_key
      AND (q.phase IS NOT 'conflict_isolated' OR q.conflict_key=head.conflict_key)
  ) END AS quarantined,
  CASE WHEN head.id IS NULL THEN NULL ELSE EXISTS(
    SELECT 1 FROM outbound_reply_prerequisites prerequisite
    LEFT JOIN outbound_replies required ON required.id=prerequisite.prerequisite_reply_id
    WHERE prerequisite.dependent_reply_id=head.id AND (required.id IS NULL OR required.state!=prerequisite.required_state)
  ) END AS unmet_prerequisites
FROM scope_page page
LEFT JOIN blocker_facts facts ON facts.scope_key=page.scope_key AND page.page_rank<=?
LEFT JOIN outbound_replies head ON head.id=facts.head_reply_id
ORDER BY page.page_rank`;
const checkpointFactQuery = (scopeCount: number) => `WITH requested(scope_key) AS (
  VALUES ${Array.from({ length: scopeCount }, () => "(?)").join(",")}
), identity_facts AS (
  SELECT requested.scope_key,
    checkpoint.committed_delivery_order AS prior_committed_order,
    checkpoint.scope_kind AS checkpoint_scope_kind,
    checkpoint.scope_workspace_id AS checkpoint_workspace_id,
    checkpoint.scope_pane_id AS checkpoint_pane_id,
    (SELECT identity.scope_kind FROM outbound_replies identity
      WHERE identity.scope_key=requested.scope_key ORDER BY identity.delivery_order LIMIT 1) AS reply_scope_kind,
    (SELECT identity.scope_workspace_id FROM outbound_replies identity
      WHERE identity.scope_key=requested.scope_key ORDER BY identity.delivery_order LIMIT 1) AS reply_workspace_id,
    (SELECT identity.scope_pane_id FROM outbound_replies identity
      WHERE identity.scope_key=requested.scope_key ORDER BY identity.delivery_order LIMIT 1) AS reply_pane_id
  FROM requested LEFT JOIN delivery_ring_checkpoints checkpoint ON checkpoint.scope_key=requested.scope_key
)
SELECT identity.scope_key AS page_scope_key,
  identity.prior_committed_order,
  identity.checkpoint_scope_kind,identity.checkpoint_workspace_id,identity.checkpoint_pane_id,
  identity.reply_scope_kind,identity.reply_workspace_id,identity.reply_pane_id,
  EXISTS(SELECT 1 FROM outbound_replies conflicting_identity
    WHERE conflicting_identity.scope_key=identity.scope_key AND (
      conflicting_identity.scope_kind IS NOT COALESCE(identity.checkpoint_scope_kind,identity.reply_scope_kind)
      OR conflicting_identity.scope_workspace_id IS NOT COALESCE(identity.checkpoint_workspace_id,identity.reply_workspace_id)
      OR conflicting_identity.scope_pane_id IS NOT COALESCE(identity.checkpoint_pane_id,identity.reply_pane_id)
    )) AS reply_identity_conflict,
  (SELECT blocker.id FROM outbound_replies blocker
    WHERE blocker.scope_key=identity.scope_key AND ${authoritativeRingBlockerSql("blocker")}
    ORDER BY blocker.delivery_order LIMIT 1) AS blocker_reply_id,
  (SELECT blocker.delivery_order FROM outbound_replies blocker
    WHERE blocker.scope_key=identity.scope_key AND ${authoritativeRingBlockerSql("blocker")}
    ORDER BY blocker.delivery_order LIMIT 1) AS blocker_delivery_order,
  (SELECT maximum.delivery_order FROM outbound_replies maximum INDEXED BY outbound_replies_scope_delivery_order
    WHERE maximum.scope_key=identity.scope_key ORDER BY maximum.delivery_order DESC LIMIT 1) AS maximum_delivery_order
FROM identity_facts identity`;
const terminalOrphanProjectionSql = (row: string) => `(
  (${row}.target_role='session_status' AND EXISTS (
    SELECT 1 FROM topic_views terminal_topic
    WHERE terminal_topic.binding_id=${row}.binding_id
      AND json_extract(terminal_topic.state_json, '$.phase')='orphaned'
      AND CAST(json_extract(terminal_topic.state_json, '$.viewVersion') AS INTEGER)=${row}.view_version
  ))
  OR (${row}.card_role='answer' AND ${row}.prompt_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM run_cards terminal_run
    WHERE terminal_run.prompt_id=${row}.prompt_id AND terminal_run.binding_id=${row}.binding_id
      AND terminal_run.binding_generation=${row}.delivery_owner_generation
      AND terminal_run.phase='failed' AND terminal_run.view_version=${row}.view_version
  ))
)`;

const currentPrimaryOwnerSql = (row: string) => `EXISTS (
  SELECT 1 FROM bindings binding
  WHERE binding.id=${row}.delivery_owner_id AND binding.generation=${row}.delivery_owner_generation
    AND binding.session_epoch=${row}.delivery_owner_session_generation
    AND binding.workspace_id=${row}.scope_workspace_id AND binding.pane_id=${row}.scope_pane_id
    AND ((binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached')
      OR (binding.state='orphaned' AND binding.lifecycle='active' AND binding.attachment='orphaned'
        AND ${terminalOrphanProjectionSql(row)}))
)`;

const currentWorkerOwnerSql = (row: string) => `EXISTS (
  SELECT 1 FROM agent_instances worker
  JOIN bindings parent ON parent.id=${row}.delivery_parent_id
  WHERE worker.id=${row}.delivery_owner_id AND worker.role='worker'
    AND worker.desired_state='running'
    AND worker.generation=${row}.delivery_owner_generation
    AND worker.worker_session_generation=${row}.delivery_owner_session_generation
    AND worker.worker_session_lifecycle='active'
    AND worker.parent_binding_id=${row}.delivery_parent_id
    AND worker.parent_binding_generation=${row}.delivery_parent_generation
    AND worker.parent_pane_id=${row}.delivery_parent_pane_id
    AND parent.generation=${row}.delivery_parent_generation
    AND parent.session_epoch=${row}.delivery_parent_session_generation
    AND parent.workspace_id=${row}.scope_workspace_id AND parent.pane_id=${row}.delivery_parent_pane_id
    AND parent.state='active' AND parent.lifecycle='active' AND parent.attachment='attached'
    AND (${row}.scope_pane_id=${row}.delivery_parent_pane_id OR (
      worker.herdr_workspace_id=${row}.scope_workspace_id AND worker.pane_id=${row}.scope_pane_id
    ))
)`;

const conversationPageFinishKeySql = () => `('segment:' || page.segment_id || ':page:' || page.page_index || ':finish'
  || CASE WHEN page.sequence=2 THEN '' ELSE ':' || page.sequence END)`;

const currentConversationPageTargetSql = (row: string) => `EXISTS (
  SELECT 1 FROM conversation_segment_pages page
  JOIN conversation_segments segment ON segment.id=page.segment_id
  WHERE page.element_id=${row}.projection_key AND page.pending_reply_id=${row}.id
    AND page.sequence=${row}.snapshot_revision
    AND (segment.state!='closed' OR (
      segment.state='closed' AND page.state='finished' AND ${row}.kind='card_update'
      AND (${row}.idempotency_key=${conversationPageFinishKeySql()}
        OR substr(${row}.idempotency_key,1,length(${conversationPageFinishKeySql()})+7)=${conversationPageFinishKeySql()} || ':final:')
    ))
    AND segment.owner_kind=${row}.delivery_owner_kind
    AND segment.owner_id=${row}.delivery_owner_id
    AND segment.owner_generation=${row}.delivery_owner_generation
    AND page.state IN ('creating','active','frozen','finished')
    AND ((${row}.kind='card_reply' AND ${row}.root_message_id=CASE
          WHEN page.page_index=0 THEN segment.root_message_id
          ELSE (SELECT prior.message_id FROM conversation_segment_pages prior
            WHERE prior.segment_id=page.segment_id AND prior.page_index=page.page_index-1)
        END)
      OR (${row}.kind='card_update' AND page.message_id IS NOT NULL AND ${row}.root_message_id=page.message_id))
)`;

const conversationPageOwnerIdentitySql = (row: string, ownerKind: "primary" | "worker") => ownerKind === "primary"
  ? `${row}.delivery_owner_kind='primary' AND ${row}.delivery_owner_id=?
      AND ${row}.delivery_owner_generation=? AND ${row}.delivery_owner_session_generation=?
      AND ${row}.delivery_parent_id IS NULL AND ${row}.delivery_parent_generation IS NULL
      AND ${row}.delivery_parent_session_generation IS NULL AND ${row}.delivery_parent_pane_id IS NULL AND ${row}.binding_id=?`
  : `${row}.delivery_owner_kind='worker' AND ${row}.delivery_owner_id=?
      AND ${row}.delivery_owner_generation=? AND ${row}.delivery_owner_session_generation=?
      AND ${row}.delivery_parent_id=? AND ${row}.delivery_parent_generation=?
      AND ${row}.delivery_parent_session_generation=? AND ${row}.delivery_parent_pane_id=?`;

const currentPrimaryAnswerCreateRootSql = (row: string) => `(
  ${row}.root_message_id=(SELECT root_message_id FROM bindings WHERE id=${row}.binding_id)
  OR EXISTS (
    SELECT 1 FROM binding_thread_aliases answer_alias
    WHERE answer_alias.binding_id=${row}.binding_id
      AND answer_alias.binding_generation=${row}.delivery_owner_generation
      AND answer_alias.pane_id=${row}.scope_pane_id AND answer_alias.state='active'
      AND answer_alias.root_message_id=${row}.root_message_id
  )
)`;

const currentPrimaryTargetSql = (row: string) => `(
  (${row}.target_role='session_status' AND EXISTS (
    SELECT 1 FROM bindings target_binding
    JOIN topic_views topic ON topic.binding_id=target_binding.id
    WHERE target_binding.id=${row}.binding_id
      AND (( ${row}.kind='card_reply' AND ${row}.root_message_id=target_binding.root_message_id AND (
          target_binding.status_message_id IS NULL OR EXISTS (
            SELECT 1 FROM delivery_recoveries main_rebuild
            JOIN outbound_replies failed_main ON failed_main.id=main_rebuild.failed_reply_id
            WHERE main_rebuild.replacement_reply_id=${row}.id
              AND main_rebuild.state='replacement_pending' AND main_rebuild.action='rebuild_main'
              AND main_rebuild.resolved_by_reply_id IS NULL
              AND failed_main.binding_id=target_binding.id
              AND failed_main.target_role='session_status' AND failed_main.kind='card_update'
              AND failed_main.root_message_id=target_binding.status_message_id
              AND failed_main.effect_certainty='rejected'
          )
        ))
        OR (${row}.kind='card_update' AND target_binding.status_message_id=${row}.root_message_id))
      AND ${row}.view_version=CAST(json_extract(topic.state_json, '$.viewVersion') AS INTEGER)
  ))
  OR (${row}.kind='group_card_create' AND ${row}.thread_alias_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM binding_thread_aliases alias
    WHERE alias.id=${row}.thread_alias_id AND alias.binding_id=${row}.binding_id
      AND alias.binding_generation=${row}.delivery_owner_generation
      AND alias.chat_id=${row}.target_chat_id AND alias.pane_id=${row}.scope_pane_id
      AND alias.source_main_message_id=(SELECT status_message_id FROM bindings WHERE id=alias.binding_id)
      AND alias.state='reserving' AND ${row}.kind='group_card_create'
  ))
  OR (${row}.kind='card_update' AND ${row}.projection_key LIKE 'pane-entry:%'
    AND ${row}.thread_alias_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM binding_thread_aliases alias
      JOIN bindings alias_binding ON alias_binding.id=alias.binding_id
      JOIN topic_views topic ON topic.binding_id=alias.binding_id
      WHERE ${row}.projection_key='pane-entry:' || alias.id AND alias.id=${row}.thread_alias_id
        AND alias.binding_id=${row}.binding_id AND alias.binding_generation=${row}.delivery_owner_generation
        AND alias.pane_id=${row}.scope_pane_id AND alias.state='active'
        AND alias.root_message_id=${row}.root_message_id
        AND alias_binding.id=${row}.binding_id AND alias_binding.generation=${row}.delivery_owner_generation
        AND alias_binding.pane_id=${row}.scope_pane_id
        AND alias.source_main_message_id=alias_binding.status_message_id
        AND ${row}.view_version=CAST(json_extract(topic.state_json, '$.viewVersion') AS INTEGER)
        AND ${row}.snapshot_revision=CAST(json_extract(topic.state_json, '$.viewVersion') AS INTEGER)
    ))
  OR (${row}.projection_key LIKE 'human-review:primary:%' AND EXISTS (
    SELECT 1 FROM primary_human_review_episodes episode
    WHERE ${row}.projection_key='human-review:primary:' || episode.id || ':surface:' || episode.surface_generation
      AND episode.binding_id=${row}.binding_id AND episode.binding_generation=${row}.delivery_owner_generation
      AND episode.state='open' AND episode.view_version=${row}.snapshot_revision
      AND ((${row}.kind='card_reply' AND episode.message_id IS NULL AND episode.create_reply_id=${row}.id)
        OR (${row}.kind='card_update' AND episode.message_id=${row}.root_message_id))
  ))
  OR (${row}.card_role='answer' AND ${row}.prompt_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM run_cards run JOIN answer_pages page ON page.prompt_id=run.prompt_id
      AND page.page_index=COALESCE(${row}.stream_page_index, CAST(json_extract(${row}.payload, '$.pageIndex') AS INTEGER), CAST(json_extract(${row}.payload, '$.stream.pageIndex') AS INTEGER), 0)
    WHERE run.prompt_id=${row}.prompt_id AND run.binding_id=${row}.binding_id
      AND run.binding_generation=${row}.delivery_owner_generation
      AND (
        (${row}.kind IN ('card_reply','stream_card_create') AND page.state='creating'
          AND page.message_id IS NULL AND page.card_id IS NULL
          AND ${currentPrimaryAnswerCreateRootSql(row)}
          AND (${row}.stream_page_index IS NULL OR page.page_index=${row}.stream_page_index)
          AND (json_extract(${row}.payload, '$.stream.elementId') IS NULL OR page.element_id=json_extract(${row}.payload, '$.stream.elementId'))
          AND (json_extract(${row}.payload, '$.stream.pageStart') IS NULL OR page.source_start=json_extract(${row}.payload, '$.stream.pageStart')))
        OR (${row}.kind='stream_content' AND page.state='active' AND page.delivery_mode='streaming'
          AND page.card_id=${row}.root_message_id AND page.element_id=json_extract(${row}.payload, '$.elementId')
          AND ${row}.card_sequence=CAST(json_extract(${row}.payload, '$.sequence') AS INTEGER) AND ${row}.card_sequence<=page.sequence)
        OR (${row}.kind='stream_finish' AND page.state='active' AND page.delivery_mode='streaming'
          AND page.card_id=${row}.root_message_id
          AND ${row}.card_sequence=CAST(json_extract(${row}.payload, '$.sequence') AS INTEGER) AND ${row}.card_sequence<=page.sequence)
        OR (${row}.kind='card_update' AND page.state IN ('active','finished') AND page.message_id=${row}.root_message_id
          AND (${row}.card_sequence IS NULL OR ${row}.card_sequence<=page.sequence))
      )
  ))
  OR (${row}.kind='message_delete' AND (
    EXISTS (SELECT 1 FROM legacy_input_card_retirements retirement
      WHERE retirement.outbound_reply_id=${row}.id AND retirement.state='deleting' AND retirement.message_id=${row}.root_message_id)
    OR EXISTS (SELECT 1 FROM orchestrator_clear_answer_targets target
      WHERE target.outbound_reply_id=${row}.id AND target.outcome='pending' AND target.message_id=${row}.root_message_id)
  ))
  OR (${row}.projection_key LIKE 'command-status:%' AND EXISTS (
    SELECT 1 FROM command_status_views view
    WHERE ${row}.projection_key='command-status:' || view.intent_id AND view.revision=${row}.snapshot_revision
      AND ((${row}.kind='card_reply' AND view.message_id IS NULL) OR (${row}.kind='card_update' AND view.message_id=${row}.root_message_id))
  ))
  OR (${row}.projection_key LIKE 'input-card:%' AND EXISTS (
    SELECT 1 FROM input_card_views view
    JOIN submission_intents intent ON intent.submission_id=view.submission_id
    WHERE ${row}.projection_key='input-card:' || view.submission_id AND view.revision=${row}.snapshot_revision
      AND intent.owner_kind='primary' AND intent.owner_id=${row}.binding_id AND intent.owner_generation=${row}.delivery_owner_generation
      AND ((${row}.kind='card_reply' AND view.message_id IS NULL AND view.root_message_id=${row}.root_message_id)
        OR (${row}.kind='card_update' AND view.message_id=${row}.root_message_id))
  ))
  OR (${row}.projection_key LIKE 'conversation-turn:%:answer' AND EXISTS (
    SELECT 1 FROM conversation_turn_projections view
    WHERE ${row}.projection_key='conversation-turn:' || view.projection_id || ':answer'
      AND view.binding_id=${row}.binding_id AND view.binding_generation=${row}.delivery_owner_generation
      AND CAST(json_extract(view.state_json, '$.viewVersion') AS INTEGER)=${row}.snapshot_revision
      AND ((${row}.kind IN ('card_reply','stream_card_create') AND view.answer_message_id IS NULL)
        OR (${row}.kind='card_update' AND view.answer_message_id=${row}.root_message_id))
  ))
  OR (${row}.projection_key LIKE 'primary-redelivery:%' AND EXISTS (
    SELECT 1 FROM primary_card_redeliveries redelivery
    WHERE redelivery.binding_id=${row}.binding_id AND redelivery.binding_generation=${row}.delivery_owner_generation
      AND ((redelivery.main_reply_id=${row}.id AND redelivery.topic_view_version=${row}.view_version)
        OR (redelivery.answer_reply_id=${row}.id AND redelivery.prompt_id=${row}.prompt_id
          AND redelivery.run_view_version=${row}.view_version AND redelivery.answer_page_index=${row}.stream_page_index))
  ))
  OR (${row}.target_role IS NOT 'session_status' AND ${row}.thread_alias_id IS NULL
    AND (${row}.projection_key IS NULL OR (${row}.projection_key NOT LIKE 'human-review:primary:%'
      AND ${row}.projection_key NOT LIKE 'command-status:%' AND ${row}.projection_key NOT LIKE 'input-card:%'
      AND ${row}.projection_key NOT LIKE 'conversation-turn:%:answer' AND ${row}.projection_key NOT LIKE 'primary-redelivery:%'
      AND ${row}.projection_key NOT LIKE 'pane-entry:%'))
    AND ${row}.card_role IS NOT 'answer' AND ${row}.kind!='message_delete')
)`;

const currentGlobalTargetSql = (_row: string) => "1";

const currentWorkerTargetSql = (row: string) => `(
  (${row}.kind='group_card_create' AND ${row}.worker_thread_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM worker_session_threads thread
    JOIN worker_main_views main ON main.worker_id=thread.worker_id
      AND main.worker_session_generation=thread.worker_session_generation
    WHERE thread.id=${row}.worker_thread_id AND thread.state='reserving'
      AND thread.worker_id=${row}.delivery_owner_id
      AND thread.worker_session_generation=${row}.delivery_owner_session_generation
      AND thread.parent_binding_id=${row}.delivery_parent_id
      AND thread.parent_binding_generation=${row}.delivery_parent_generation
      AND thread.parent_pane_id=${row}.delivery_parent_pane_id
      AND thread.chat_id=${row}.target_chat_id
      AND ((thread.mode='canonical-main' AND thread.source_main_message_id IS NULL)
        OR (thread.mode='legacy-entry' AND thread.source_main_message_id IS NOT NULL
          AND thread.source_main_message_id=main.message_id))
  ))
  OR (${row}.kind='group_card_create' AND ${row}.worker_thread_id IS NOT NULL
    AND ${row}.projection_key LIKE 'worker-main-recovery:%' AND EXISTS (
      SELECT 1 FROM worker_session_threads thread
      JOIN delivery_recoveries recovery
        ON ${row}.projection_key='worker-main-recovery:' || recovery.failed_reply_id
      JOIN outbound_replies failed ON failed.id=recovery.failed_reply_id
      WHERE thread.id=${row}.worker_thread_id AND thread.state='active'
        AND thread.mode='canonical-main' AND thread.source_main_message_id IS NULL
        AND thread.worker_id=${row}.delivery_owner_id
        AND thread.worker_session_generation=${row}.delivery_owner_session_generation
        AND thread.parent_binding_id=${row}.delivery_parent_id
        AND thread.parent_binding_generation=${row}.delivery_parent_generation
        AND thread.parent_pane_id=${row}.delivery_parent_pane_id
        AND thread.chat_id=${row}.target_chat_id AND thread.root_message_id=failed.root_message_id
        AND failed.state='dead_letter' AND failed.kind='card_update'
        AND failed.worker_id=${row}.delivery_owner_id
        AND failed.worker_session_generation=${row}.delivery_owner_session_generation
        AND failed.worker_turn_id IS NULL AND failed.prompt_id IS NULL
        AND failed.binding_id=${row}.delivery_parent_id
        AND recovery.state IN ('unresolved','replacement_pending')
        AND (recovery.replacement_reply_id IS NULL OR recovery.replacement_reply_id=${row}.id)
        AND (failed.delivery_owner_kind IS NULL OR (
          failed.delivery_owner_kind='worker'
          AND failed.delivery_owner_generation=${row}.delivery_owner_generation
          AND failed.delivery_parent_id=${row}.delivery_parent_id
          AND failed.delivery_parent_generation=${row}.delivery_parent_generation
          AND failed.delivery_parent_session_generation=${row}.delivery_parent_session_generation
          AND failed.delivery_parent_pane_id=${row}.delivery_parent_pane_id
          AND failed.scope_kind='pane'
          AND failed.scope_workspace_id=${row}.scope_workspace_id
          AND failed.scope_pane_id=${row}.scope_pane_id))
    ))
  OR (${row}.kind='group_card_create' AND ${row}.worker_thread_id IS NOT NULL
    AND ${row}.worker_turn_id IS NOT NULL
    AND ${row}.projection_key LIKE 'worker-turn-recovery:%' AND EXISTS (
      SELECT 1 FROM delivery_recoveries recovery
      JOIN outbound_replies failed
        ON ${row}.projection_key='worker-turn-recovery:' || recovery.failed_reply_id
        AND failed.id=recovery.failed_reply_id
      JOIN worker_turn_cards card ON card.turn_id=${row}.worker_turn_id
      JOIN worker_session_threads thread ON thread.id=${row}.worker_thread_id
      WHERE recovery.state IN ('unresolved','replacement_pending')
        AND (recovery.replacement_reply_id IS NULL OR recovery.replacement_reply_id=${row}.id)
        AND failed.state='dead_letter' AND failed.kind='card_update'
        AND failed.worker_turn_id=${row}.worker_turn_id
        AND failed.stream_page_index=${row}.stream_page_index
        AND card.instance_id=${row}.delivery_owner_id
        AND card.instance_generation=${row}.delivery_owner_generation
        AND card.worker_session_generation=${row}.delivery_owner_session_generation
        AND thread.state='active' AND thread.worker_id=${row}.delivery_owner_id
        AND thread.worker_session_generation=${row}.delivery_owner_session_generation
        AND thread.parent_binding_id=${row}.delivery_parent_id
        AND thread.parent_binding_generation=${row}.delivery_parent_generation
        AND thread.parent_pane_id=${row}.delivery_parent_pane_id
        AND thread.chat_id=${row}.target_chat_id AND thread.root_message_id IS NOT NULL
    ))
  OR (${row}.kind='group_card_create' AND ${row}.thread_alias_id IS NOT NULL
    AND ${row}.worker_turn_id IS NOT NULL
    AND ${row}.projection_key LIKE 'worker-task-recovery-thread:%' AND EXISTS (
      SELECT 1 FROM binding_thread_aliases alias
      JOIN outbound_replies failed_create ON failed_create.id=alias.action_message_id
      JOIN delivery_recoveries recovery ON recovery.replacement_reply_id=failed_create.id
      JOIN worker_turn_cards card ON card.turn_id=${row}.worker_turn_id
      WHERE alias.id=${row}.thread_alias_id AND alias.state='reserving'
        AND alias.binding_id=${row}.delivery_parent_id
        AND alias.binding_generation=${row}.delivery_parent_generation
        AND alias.pane_id=${row}.delivery_parent_pane_id AND alias.chat_id=${row}.target_chat_id
        AND ${row}.projection_key='worker-task-recovery-thread:' || ${row}.worker_turn_id || ':' || ${row}.stream_page_index || ':' || failed_create.id
        AND recovery.state='replacement_pending' AND recovery.action='rebuild_worker_task'
        AND failed_create.state='dead_letter' AND failed_create.kind='stream_card_create'
        AND failed_create.worker_turn_id=${row}.worker_turn_id
        AND failed_create.stream_page_index=${row}.stream_page_index
        AND card.instance_id=${row}.delivery_owner_id
        AND card.instance_generation=${row}.delivery_owner_generation
        AND card.worker_session_generation=${row}.delivery_owner_session_generation
    ))
  OR (${row}.projection_key='worker-main:' || ${row}.delivery_owner_id || ':' || ${row}.delivery_owner_session_generation
    AND ${row}.worker_thread_id IS NULL AND EXISTS (
      SELECT 1 FROM worker_main_views main
      WHERE main.worker_id=${row}.delivery_owner_id
        AND main.worker_session_generation=${row}.delivery_owner_session_generation
        AND main.parent_binding_id=${row}.delivery_parent_id
        AND main.parent_binding_generation=${row}.delivery_parent_generation
        AND main.parent_pane_id=${row}.delivery_parent_pane_id
        AND main.view_version=${row}.snapshot_revision
        AND ((${row}.kind='card_reply' AND main.message_id IS NULL)
          OR (${row}.kind='card_update' AND main.message_id=${row}.root_message_id))
    ))
  OR (${row}.projection_key LIKE 'worker-thread-entry:%' AND EXISTS (
    SELECT 1 FROM worker_thread_entry_requests request
    JOIN worker_session_threads thread ON thread.worker_id=request.worker_id
      AND thread.worker_session_generation=request.worker_session_generation
    WHERE ${row}.projection_key='worker-thread-entry:' || request.command_intent_id
      AND request.state='reserved' AND request.worker_id=${row}.delivery_owner_id
      AND request.worker_session_generation=${row}.delivery_owner_session_generation
      AND request.binding_id=${row}.delivery_parent_id
      AND request.binding_generation=${row}.delivery_parent_generation
      AND request.root_message_id=${row}.root_message_id
      AND thread.state='active' AND thread.root_message_id IS NOT NULL
  ))
  OR (${row}.worker_turn_id IS NOT NULL
    AND ${row}.projection_key='worker-task:' || ${row}.worker_turn_id || ':page:' || ${row}.stream_page_index
    AND EXISTS (
      SELECT 1 FROM instance_turns turn
      JOIN worker_turn_cards card ON card.turn_id=turn.id
        AND card.instance_id=turn.instance_id AND card.instance_generation=turn.instance_generation
      JOIN worker_turn_card_pages page ON page.turn_id=card.turn_id
        AND page.page_index=${row}.stream_page_index
      WHERE turn.id=${row}.worker_turn_id
        AND turn.instance_id=${row}.delivery_owner_id
        AND turn.instance_generation=${row}.delivery_owner_generation
        AND card.instance_id=${row}.delivery_owner_id
        AND card.instance_generation=${row}.delivery_owner_generation
        AND card.worker_session_generation=${row}.delivery_owner_session_generation
        AND ((
          ${row}.kind='stream_card_create'
          AND card.root_message_id=${row}.root_message_id
          AND page.state='creating' AND page.message_id IS NULL AND page.card_id IS NULL
          AND page.element_id=${row}.stream_element_id
          AND card.page_index=CASE WHEN ${row}.stream_page_index=0 THEN 0 ELSE ${row}.stream_page_index-1 END
        ) OR (
          ${row}.kind='stream_content'
          AND page.state='active' AND page.card_id=${row}.root_message_id
          AND card.page_index=page.page_index AND card.sequence=${row}.card_sequence
          AND page.sequence=${row}.card_sequence
          AND ((${row}.selection_id='worker-progress' AND ${row}.stream_element_id IS NOT NULL)
            OR (${row}.selection_id IS NULL AND page.element_id=${row}.stream_element_id))
        ) OR (
          ${row}.kind='stream_finish'
          AND page.state='active' AND page.card_id=${row}.root_message_id
          AND card.page_index=page.page_index AND card.sequence=${row}.card_sequence
          AND page.sequence=${row}.card_sequence
        ) OR (
          ${row}.kind='card_update'
          AND (page.state IN ('active','finished') OR (
            page.state='frozen'
            AND ${row}.idempotency_key='worker-answer-segment:close:' || ${row}.worker_turn_id || ':' || page.page_index || ':' || page.message_id
          ))
          AND page.message_id=${row}.root_message_id
          AND card.page_index=page.page_index AND page.sequence=${row}.card_sequence
        ))
    ))
  OR (${row}.projection_key LIKE 'human-review:worker:%' AND EXISTS (
    SELECT 1 FROM worker_human_review_episodes episode
    WHERE ${row}.projection_key='human-review:worker:' || episode.id || ':surface:' || episode.surface_generation
      AND episode.instance_id=${row}.delivery_owner_id
      AND episode.worker_session_generation=${row}.delivery_owner_session_generation
      AND episode.instance_generation=${row}.delivery_owner_generation
      AND episode.binding_id=${row}.delivery_parent_id
      AND episode.binding_generation=${row}.delivery_parent_generation
      AND episode.state IN ('open','resolved') AND episode.view_version=${row}.snapshot_revision
      AND ((${row}.kind='card_reply' AND episode.message_id IS NULL AND episode.create_reply_id=${row}.id)
        OR (${row}.kind='card_update' AND episode.message_id=${row}.root_message_id))
  ))
  OR (${row}.kind='card_reply' AND ${row}.target_role='operation_result'
    AND ${row}.projection_key LIKE 'completion-review:%' AND EXISTS (
      SELECT 1 FROM completion_action_sets action
      JOIN instance_turns turn ON turn.id=action.owner_id
      JOIN worker_turn_cards card ON card.turn_id=turn.id
        AND card.instance_id=turn.instance_id AND card.instance_generation=turn.instance_generation
      JOIN worker_turn_card_pages page ON page.turn_id=turn.id AND page.page_index=action.page_index
      WHERE action.owner_kind='worker-turn' AND action.presentation_kind='fresh-card'
        AND action.state='presenting' AND action.presentation_reply_id=${row}.id
        AND ${row}.projection_key='completion-review:' || action.id || ':surface:' || action.presentation_generation
        AND action.owner_id=${row}.worker_turn_id
        AND action.owner_generation=${row}.delivery_owner_session_generation
        AND action.binding_id=${row}.delivery_parent_id
        AND action.binding_generation=${row}.delivery_parent_generation
        AND turn.instance_id=${row}.delivery_owner_id
        AND turn.instance_generation=${row}.delivery_owner_generation
        AND turn.state='completed' AND card.phase='completed'
        AND card.worker_session_generation=${row}.delivery_owner_session_generation
        AND card.root_message_id=${row}.root_message_id
        AND page.state='finished' AND ${row}.snapshot_revision=action.presentation_generation
    ))
  OR (${row}.kind='card_reply' AND ${row}.target_role='operation_result'
    AND ${row}.projection_key LIKE 'completion-review:%' AND ${row}.worker_turn_id IS NULL AND EXISTS (
      SELECT 1 FROM completion_action_sets action
      JOIN conversation_segments segment ON segment.id=action.owner_id AND segment.owner_kind='worker'
      JOIN conversation_segment_pages page ON page.segment_id=segment.id AND page.page_index=action.page_index
      WHERE action.owner_kind='primary-segment' AND action.presentation_kind='fresh-card'
        AND action.state='presenting' AND action.presentation_reply_id=${row}.id
        AND ${row}.projection_key='completion-review:' || action.id || ':surface:' || action.presentation_generation
        AND action.owner_generation=segment.owner_generation
        AND action.binding_id=${row}.delivery_parent_id
        AND action.binding_generation=${row}.delivery_parent_generation
        AND segment.owner_id=${row}.delivery_owner_id
        AND segment.owner_generation=${row}.delivery_owner_generation
        AND segment.state='completed' AND page.state IN ('active','finished')
        AND segment.root_message_id=${row}.root_message_id
        AND ${row}.snapshot_revision=action.presentation_generation
    ))
  OR (${row}.kind='text' AND ${row}.target_role='operation_result'
    AND ${row}.projection_key='worker-completion-notification:' || ${row}.worker_turn_id
    AND EXISTS (
      SELECT 1 FROM completion_action_sets action
      JOIN completion_notification_obligations obligation
        ON obligation.owner_kind=action.owner_kind AND obligation.owner_id=action.owner_id
          AND obligation.owner_generation=action.owner_generation
      JOIN instance_turns turn ON turn.id=action.owner_id
      JOIN worker_turn_card_pages page ON page.turn_id=turn.id
        AND page.page_index=(SELECT MAX(latest.page_index) FROM worker_turn_card_pages latest WHERE latest.turn_id=turn.id)
      WHERE action.owner_kind='worker-turn' AND action.owner_id=${row}.worker_turn_id
        AND action.owner_generation=${row}.delivery_owner_session_generation
        AND action.binding_id=${row}.delivery_parent_id
        AND action.binding_generation=${row}.delivery_parent_generation
        AND action.card_message_id=${row}.root_message_id
        AND action.state='available' AND action.mention_open_id IS NOT NULL
        AND obligation.state IN ('waiting_for_answer','released')
        AND (obligation.notification_reply_id IS NULL OR obligation.notification_reply_id=${row}.id)
        AND turn.instance_id=${row}.delivery_owner_id
        AND turn.instance_generation=${row}.delivery_owner_generation
        AND turn.state='completed' AND page.state='finished'
        AND page.message_id=${row}.root_message_id AND page.card_id IS NOT NULL
    ))
)`;

const currentRecoveryReplacementSql = (row: string) => `NOT EXISTS (
  SELECT 1 FROM delivery_recoveries recovery WHERE recovery.replacement_reply_id=${row}.id
) OR EXISTS (
  SELECT 1 FROM delivery_recoveries recovery WHERE recovery.replacement_reply_id=${row}.id
    AND recovery.state='replacement_pending' AND recovery.resolved_by_reply_id IS NULL
)`;

const reconstructibleInvalidPrimaryMainScopePageSql = (afterScopeKey: boolean) => `SELECT DISTINCT candidate.scope_key
FROM outbound_replies candidate INDEXED BY outbound_replies_scope_nonterminal_order
WHERE candidate.scope_key IS NOT NULL AND candidate.state IN ('pending','dead_letter') AND candidate.state='pending'
  AND candidate.scope_kind='pane' AND candidate.scope_workspace_id IS NOT NULL AND candidate.scope_pane_id IS NOT NULL
  AND candidate.delivery_owner_kind='primary' AND candidate.delivery_owner_id IS NOT NULL
  AND candidate.kind='card_update' AND candidate.target_role='session_status'
  AND candidate.projection_key LIKE 'primary-main:%'
  ${afterScopeKey ? "AND candidate.scope_key>?" : ""}
ORDER BY candidate.scope_key LIMIT ?`;

const reconstructibleInvalidPrimaryMainHeadSql = (candidateScan = false) => `${candidateScan ? `WITH candidate_scopes(scope_key) AS MATERIALIZED (
  SELECT CAST(value AS TEXT) FROM json_each(?)
), authoritative_scope_heads AS MATERIALIZED (
  SELECT (
    SELECT blocker.rowid
    FROM outbound_replies blocker INDEXED BY outbound_replies_scope_delivery_order
    WHERE blocker.scope_key=candidate_scope.scope_key AND blocker.scope_key IS NOT NULL
      AND ${authoritativeRingBlockerSql("blocker")}
    ORDER BY blocker.delivery_order,blocker.id LIMIT 1
  ) AS reply_rowid
  FROM candidate_scopes candidate_scope
)
` : ""}SELECT
  head.id,head.snapshot_revision,head.scope_key,head.scope_workspace_id,head.scope_pane_id,head.lane_key,
  current.id AS current_owner_id,current.generation AS current_owner_generation
FROM ${candidateScan
    ? "authoritative_scope_heads candidate_head CROSS JOIN outbound_replies head NOT INDEXED"
    : "outbound_replies head"}
JOIN bindings current
  ON current.workspace_id=head.scope_workspace_id AND current.pane_id=head.scope_pane_id
  AND current.state='active' AND current.lifecycle='active' AND current.attachment='attached'
JOIN topic_views current_topic ON current_topic.binding_id=current.id
WHERE ${candidateScan ? "head.rowid=candidate_head.reply_rowid AND " : ""}head.scope_key IS NOT NULL AND head.scope_kind='pane'
  AND head.scope_workspace_id IS NOT NULL AND head.scope_pane_id IS NOT NULL
  AND head.delivery_owner_kind='primary' AND head.delivery_owner_id IS NOT NULL
  AND head.kind='card_update' AND head.target_role='session_status'
  AND head.projection_key LIKE 'primary-main:%'
  AND head.state IN ('pending','dead_letter') AND head.state='pending'
  AND head.attempt_count=0 AND head.first_claimed_at IS NULL
  AND head.claim_attempt_id IS NULL AND head.claimed_owner_id IS NULL AND head.claimed_fence IS NULL
  AND head.claimed_at IS NULL AND head.claim_expires_at IS NULL
  AND head.delivered_message_id IS NULL AND head.card_id_checkpoint IS NULL AND head.gateway_checkpoint_json IS NULL
  AND (head.effect_certainty IS NULL OR head.effect_certainty='not-started')
  AND NOT (${currentPrimaryOwnerSql("head")})
  AND (current.id<>head.delivery_owner_id OR current.generation<>head.delivery_owner_generation
    OR current.session_epoch<>head.delivery_owner_session_generation)
  AND current.root_message_id IS NOT NULL AND current.status_message_id IS NOT NULL
  AND json_type(current_topic.state_json,'$.sessionIdentity')='object'
  AND CAST(json_extract(current_topic.state_json,'$.sessionIdentity.bindingGeneration') AS INTEGER)=current.generation
  AND CAST(json_extract(current_topic.state_json,'$.sessionIdentity.sessionEpoch') AS INTEGER)=current.session_epoch
  AND json_extract(current_topic.state_json,'$.sessionIdentity.nativeSessionId') IS
    (CASE WHEN current.agent_session_kind='id' THEN current.agent_session_value ELSE NULL END)
  AND json_extract(current_topic.state_json,'$.sessionIdentity.paneId') IS current.pane_id
  AND json_extract(current_topic.state_json,'$.sessionIdentity.rootMessageId') IS current.root_message_id
  AND NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery
    WHERE recovery.failed_reply_id=head.id OR recovery.replacement_reply_id=head.id)
  AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines quarantine
    WHERE quarantine.failed_reply_id=head.id AND quarantine.state='active')
  AND NOT EXISTS (SELECT 1 FROM outbound_reply_prerequisites prerequisite
    WHERE prerequisite.dependent_reply_id=head.id OR prerequisite.prerequisite_reply_id=head.id)
  ${candidateScan ? "" : `AND head.id=(SELECT blocker.id FROM outbound_replies blocker
    WHERE blocker.scope_key=head.scope_key AND ${authoritativeRingBlockerSql("blocker")}
    ORDER BY blocker.delivery_order,blocker.id LIMIT 1)`}`;

const orphanedPrimaryMainPendingSql = (row: string) => `${row}.scope_key IS NOT NULL
  AND ${row}.scope_kind='pane' AND ${row}.scope_workspace_id IS NOT NULL AND ${row}.scope_pane_id IS NOT NULL
  AND ${row}.delivery_owner_kind='primary' AND ${row}.delivery_owner_id IS NOT NULL
  AND ${row}.delivery_owner_generation IS NOT NULL AND ${row}.delivery_owner_session_generation IS NOT NULL
  AND ${row}.delivery_parent_id IS NULL AND ${row}.delivery_parent_generation IS NULL
  AND ${row}.delivery_parent_session_generation IS NULL AND ${row}.delivery_parent_pane_id IS NULL
  AND ${row}.kind='card_update' AND ${row}.target_role='session_status'
  AND ${row}.projection_key LIKE 'primary-main:%'
  AND ${row}.state IN ('pending','dead_letter') AND ${row}.state='pending'
  AND ${row}.attempt_count=0 AND ${row}.first_claimed_at IS NULL
  AND ${row}.claim_attempt_id IS NULL AND ${row}.claimed_owner_id IS NULL AND ${row}.claimed_fence IS NULL
  AND ${row}.claimed_at IS NULL AND ${row}.claim_expires_at IS NULL
  AND ${row}.delivered_message_id IS NULL AND ${row}.card_id_checkpoint IS NULL AND ${row}.gateway_checkpoint_json IS NULL
  AND (${row}.effect_certainty IS NULL OR ${row}.effect_certainty='not-started')
  AND NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery
    WHERE recovery.failed_reply_id=${row}.id OR recovery.replacement_reply_id=${row}.id)
  AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines quarantine
    WHERE quarantine.failed_reply_id=${row}.id AND quarantine.state='active')
  AND NOT EXISTS (SELECT 1 FROM outbound_reply_prerequisites prerequisite
    WHERE prerequisite.dependent_reply_id=${row}.id OR prerequisite.prerequisite_reply_id=${row}.id)
  AND EXISTS (SELECT 1 FROM bindings owner
    WHERE owner.id=${row}.delivery_owner_id AND owner.generation=${row}.delivery_owner_generation
      AND owner.session_epoch=${row}.delivery_owner_session_generation
      AND (owner.attachment='orphaned' OR owner.lifecycle IN ('archived','closed') OR owner.state='archived'))
  AND NOT EXISTS (SELECT 1 FROM bindings replacement
    WHERE replacement.id<>${row}.delivery_owner_id
      AND replacement.workspace_id=${row}.scope_workspace_id AND replacement.pane_id=${row}.scope_pane_id
      AND replacement.state='active' AND replacement.lifecycle='active' AND replacement.attachment='attached')`;

export class SqlitePreparedDeliveryStore implements PreparedDeliveryStore, DeliveryEngineRefillPort {
  private deliveryTrace: DeliveryLatencyTrace | null = null;
  private quarantineReviewRenderer: ((input: DeliveryQuarantineReviewInput) => object) | null = null;
  private gatewayPlanPreparer: ((reply: OutboundReply) => PreparedDeliveryPlan) | null = null;
  private reconstructibleInvalidOwnerScopeCursor: string | null = null;
  private orphanedPrimaryMainPendingCursor: OrphanedPrimaryMainPendingCursor | null = null;

  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
    private readonly delivery: SqliteOutboxDeliveryStore,
    private readonly recovery: SqliteOutboxRecoveryStore,
    private readonly settleMessageDeletion?: (input: { outboundReplyId: string; outcome: "failed"; detail: string }) => unknown
  ) {}

  setDeliveryTrace(trace: DeliveryLatencyTrace): void { this.deliveryTrace = trace; }

  setGatewayPlanPreparer(preparer: (reply: OutboundReply) => PreparedDeliveryPlan): void { this.gatewayPlanPreparer = preparer; }

  setQuarantineReviewRenderer(renderer: (input: DeliveryQuarantineReviewInput) => object): void {
    this.quarantineReviewRenderer = renderer;
  }

  loadOrInitializeCheckpoint(input: { scope: DeliveryScope; at: string }): DeliveryRingCheckpoint {
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => this.loadOrInitializeCheckpointInTransaction(input));
  }

  private loadOrInitializeCheckpointInTransaction(input: { scope: DeliveryScope; at: string }): DeliveryRingCheckpoint {
    const scopeKey = deliveryScopeKey(input.scope);
    const existing = this.context.database.prepare(`SELECT scope_key,scope_kind,scope_workspace_id,scope_pane_id,
      committed_delivery_order,updated_at FROM delivery_ring_checkpoints WHERE scope_key=?`).get(scopeKey) as DeliveryCheckpointRow | undefined;
    if (existing) return hydrateDeliveryRingCheckpoint(existing, input.scope, scopeKey);

    const head = this.context.database.prepare(`SELECT MIN(delivery_order) AS delivery_order FROM outbound_replies
      WHERE scope_key=? AND ${authoritativeRingBlockerSql("outbound_replies")}`).get(scopeKey) as { delivery_order: number | null };
    const maximum = this.context.database.prepare("SELECT MAX(delivery_order) AS delivery_order FROM outbound_replies WHERE scope_key=?")
      .get(scopeKey) as { delivery_order: number | null };
    const initialOrder = head.delivery_order === null
      ? Math.max(0, Number(maximum.delivery_order ?? 0))
      : Math.max(0, Number(head.delivery_order) - 1);
    const fields = input.scope.kind === "pane"
      ? ["pane", input.scope.workspaceId, input.scope.paneId]
      : ["global", null, null];
    this.context.database.prepare(`INSERT INTO delivery_ring_checkpoints(
      scope_key,scope_kind,scope_workspace_id,scope_pane_id,committed_delivery_order,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_key) DO NOTHING`).run(scopeKey, ...fields, initialOrder, input.at, input.at);
    const persisted = this.context.database.prepare(`SELECT scope_key,scope_kind,scope_workspace_id,scope_pane_id,
      committed_delivery_order,updated_at FROM delivery_ring_checkpoints WHERE scope_key=?`).get(scopeKey) as DeliveryCheckpointRow | undefined;
    if (!persisted) throw new Error("delivery_checkpoint_initialization_missing");
    return hydrateDeliveryRingCheckpoint(persisted, input.scope, scopeKey);
  }

  private advanceCheckpointAfterTerminalTransition(scope: DeliveryScope, at: string): void {
    const checkpoint = this.loadOrInitializeCheckpointInTransaction({ scope, at });
    const scopeKey = deliveryScopeKey(scope);
    const head = this.context.database.prepare(`SELECT MIN(delivery_order) AS delivery_order FROM outbound_replies
      WHERE scope_key=? AND ${authoritativeRingBlockerSql("outbound_replies")}`).get(scopeKey) as { delivery_order: number | null };
    const maximum = this.context.database.prepare("SELECT MAX(delivery_order) AS delivery_order FROM outbound_replies WHERE scope_key=?")
      .get(scopeKey) as { delivery_order: number | null };
    const nextOrder = head.delivery_order === null
      ? Math.max(0, Number(maximum.delivery_order ?? 0))
      : Math.max(0, Number(head.delivery_order) - 1);
    if (nextOrder === checkpoint.position.value) return;
    const changed = this.context.database.prepare(`UPDATE delivery_ring_checkpoints SET committed_delivery_order=?,updated_at=?
      WHERE scope_key=? AND committed_delivery_order<>?`).run(nextOrder, at, scopeKey, nextOrder);
    if (changed.changes === 1 && nextOrder < checkpoint.position.value) this.incrementRolloutCounter("checkpoint_backward_rebase_count");
  }

  reserve(input: EnqueueOutboundReplyInput): PostCommitReceipt<OutboundReply, PreparedDelivery> {
    if (!this.gatewayPlanPreparer) throw new Error("Gateway plan preparer is not connected");
    const receipt = this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const reply = this.queue.enqueue(input);
      if (reply.gatewayPlanJson && reply.gatewayPlanHash) return this.context.receipt(reply, this.preparedEffect(reply));
      if (reply.state !== "pending") return this.context.receipt(reply, []);
      let plan: PreparedDeliveryPlan;
      let planJson: string;
      try { plan = this.gatewayPlanPreparer!(reply); }
      catch (error) { if (!(error instanceof PreparedDeliveryPoisonError)) throw error; return this.rejectPoison(reply); }
      try {
        const serialized = JSON.stringify(plan);
        if (typeof serialized !== "string") return this.rejectPoison(reply);
        planJson = serialized;
      } catch { return this.rejectPoison(reply); }
      const frozen = this.queue.prepareGatewayPlan(reply.id, { gatewayId: plan.gatewayId, gatewayProfileId: plan.profileId, gatewayPlanJson: planJson });
      if (!frozen || !frozen.gatewayPlanHash) throw new Error("Prepared delivery could not be frozen");
      return this.context.receipt(frozen, this.preparedEffect(frozen));
    });
    this.observeOutboxCommit(receipt, input.projectionKey ?? null);
    return receipt;
  }

  reserveSemantic(input: SemanticDeliveryReservationInput): PostCommitReceipt<OutboundReply, DeliveryRingWork> {
    const subjectJson = encodeDeliverySubject(input.subject);
    const snapshotJson = encodePresentationSnapshot(input.snapshot);
    const semanticInput = Object.freeze({
      kind: "semantic-snapshot" as const,
      subject: input.subject,
      snapshot: input.snapshot,
      snapshotHash: presentationSnapshotHash(snapshotJson),
      plannerPolicyVersion: input.plannerPolicyVersion,
      rendererPolicyVersion: input.rendererPolicyVersion,
      gatewayProfileVersion: input.gatewayProfileVersion
    });
    if (input.snapshotRevision !== input.subject.revision) throw new Error("semantic_subject_revision_mismatch");
    const receipt = this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const reply = this.queue.enqueue({ ...input, semanticInput } as unknown as EnqueueOutboundReplyInput);
      const hydrated = this.hydrateDeliveryWork(reply.id);
      if (hydrated.status !== "ready" || !("input" in hydrated.work)
        || hydrated.work.input.snapshotHash !== semanticInput.snapshotHash
        || encodeDeliverySubject(hydrated.work.input.subject) !== subjectJson) {
        throw new Error(hydrated.status === "invalid" ? hydrated.reason : "semantic_delivery_reservation_conflict");
      }
      return this.context.receipt(reply, reply.state === "pending" ? [hydrated.work] : []);
    });
    this.observeOutboxCommit(receipt, input.subject.segmentId, true);
    return receipt;
  }

  private observeOutboxCommit(receipt: PostCommitReceipt<OutboundReply, DeliveryRingWork>, projectionKeyOrSegmentId: string | null, isSegmentId = false): void {
    const parsed = projectionKeyOrSegmentId ? parseTurnCardProjectionKey(projectionKeyOrSegmentId) : null;
    const segmentId = parsed?.segmentId ?? (isSegmentId ? projectionKeyOrSegmentId : null);
    if (!segmentId || !this.deliveryTrace) return;
    receipt.afterCommit(() => {
      try {
        this.deliveryTrace?.mark({ stage: "outbox_committed", correlation: { segmentId, replyId: receipt.result.id } });
      } catch {}
    });
  }

  freezeSemanticDelivery(input: { work: SemanticDeliveryWork; preparedPlan: PreparedDeliveryPlan }): { outcome: "prepared"; delivery: PreparedDelivery } | { outcome: "stale" } {
    const { work, preparedPlan } = input;
    if (!validSemanticWork(work) || !validSemanticPreparedPlan(work, preparedPlan)) return { outcome: "stale" };
    let planJson: string;
    try {
      const serialized = JSON.stringify(preparedPlan);
      if (typeof serialized !== "string") return { outcome: "stale" };
      planJson = serialized;
    } catch {
      return { outcome: "stale" };
    }
    const planHash = createHash("sha256").update(planJson).digest("hex");
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const updated = this.context.database.prepare(`UPDATE outbound_replies SET
          gateway_plan_json=?,gateway_plan_hash=?,renderer_revision=?,preparation_state='prepared',updated_at=?
        WHERE id=? AND state='pending' AND claim_attempt_id IS NULL
          AND delivery_input_kind='semantic-snapshot' AND preparation_state IN ('reserved','preparing')
          AND gateway_plan_json IS NULL AND gateway_plan_hash IS NULL
          AND gateway_id=? AND gateway_profile_id=? AND root_message_id=? AND kind=?
          AND snapshot_revision=? AND presentation_snapshot_hash=?
          AND planner_policy_version=? AND renderer_policy_version=? AND gateway_profile_version=?
          AND subject_kind=? AND subject_json=? AND subject_revision=?
          AND scope_key=?`).run(
        planJson, planHash, preparedPlan.rendererRevision, new Date().toISOString(),
        work.replyId, work.gatewayId, work.gatewayProfileId, work.rootMessageId, work.deliveryKind,
        work.snapshotRevision, work.input.snapshotHash,
        work.input.plannerPolicyVersion, work.input.rendererPolicyVersion, work.input.gatewayProfileVersion,
        work.input.subject.kind, encodeDeliverySubject(work.input.subject), work.input.subject.revision,
        deliveryScopeKey(work.scope)
      );
      if (updated.changes !== 1) {
        this.incrementRolloutCounter("preparation_cas_failure_count");
        return { outcome: "stale" } as const;
      }
      const hydrated = this.hydratePreparedDelivery(work.replyId);
      if (hydrated.status !== "prepared" || hydrated.delivery.planHash !== planHash) {
        throw new Error("semantic_delivery_freeze_hydration_failed");
      }
      return { outcome: "prepared", delivery: hydrated.delivery } as const;
    });
  }

  failSemanticDeliveryPreparation(input: { work: SemanticDeliveryWork; error: string }): "failed" | "stale" {
    if (!validSemanticWork(input.work)) return "stale";
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const current = this.context.database.prepare(`SELECT 1 FROM outbound_replies
        WHERE id=? AND state='pending' AND claim_attempt_id IS NULL
          AND delivery_input_kind='semantic-snapshot' AND preparation_state IN ('reserved','preparing')
          AND gateway_plan_json IS NULL AND gateway_plan_hash IS NULL
          AND gateway_id=? AND gateway_profile_id=? AND root_message_id=? AND kind=?
          AND snapshot_revision=? AND presentation_snapshot_hash=?
          AND planner_policy_version=? AND renderer_policy_version=? AND gateway_profile_version=?
          AND subject_kind=? AND subject_json=? AND subject_revision=? AND scope_key=?`).get(
        input.work.replyId, input.work.gatewayId, input.work.gatewayProfileId, input.work.rootMessageId, input.work.deliveryKind,
        input.work.snapshotRevision, input.work.input.snapshotHash,
        input.work.input.plannerPolicyVersion, input.work.input.rendererPolicyVersion, input.work.input.gatewayProfileVersion,
        input.work.input.subject.kind, encodeDeliverySubject(input.work.input.subject), input.work.input.subject.revision,
        deliveryScopeKey(input.work.scope)
      );
      if (!current) return "stale";
      const failed = this.recovery.markOutboundReplyFailedWithQuarantine(input.work.replyId, input.error.slice(0, 500), {
        failureClass: "permanent", effectCertainty: "not-started", httpStatus: null, larkErrorCode: null
      });
      return failed ? "failed" : "stale";
    });
  }

  private preparedEffect(reply: OutboundReply): readonly PreparedDelivery[] {
    if (!reply.deliveryScope || !reply.gatewayPlanJson || !reply.gatewayPlanHash || reply.state !== "pending") return [];
    return [this.requireCanonicalReply(reply)];
  }

  private rejectPoison(reply: OutboundReply): PostCommitReceipt<OutboundReply, PreparedDelivery> {
    const rejected = this.recovery.markOutboundReplyFailedWithQuarantine(reply.id, "Gateway plan preparation failed", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: null, larkErrorCode: null });
    if (!rejected) throw new Error("Prepared delivery rejection could not be persisted");
    return this.context.receipt(rejected.reply, []);
  }

  private requireCanonicalReply(reply: OutboundReply): PreparedDelivery {
    const result = this.hydratePreparedDelivery(reply.id);
    if (result.status !== "prepared") throw new Error(`Prepared delivery is ${result.status}`);
    return result.delivery;
  }

  listScopeHeads(input: { afterScopeKey: string | null; limit: number; at: string }): PreparedDeliveryHeadPage {
    const page = this.loadScopePage({ scope: null, ...input });
    return { items: page.items.flatMap((item) => item.head ? [item.head] : []), nextCursor: page.nextCursor };
  }

  loadScopePage(input: { scope: DeliveryScope | null; afterScopeKey: string | null; limit: number; at: string }): PreparedDeliveryScopePage {
    return this.loadScopePageAttempt(input, 2);
  }

  private loadScopePageAttempt(input: { scope: DeliveryScope | null; afterScopeKey: string | null; limit: number; at: string }, staleRetries: number): PreparedDeliveryScopePage {
    const limit = boundedLimit(input.limit);
    if (limit === 0) return { items: [], nextCursor: null, nextRetryAt: null, recoveryBlocked: false };
    const exact = input.scope !== null;
    const scopeKey = input.scope ? deliveryScopeKey(input.scope) : null;
    const parameters = exact
      ? [scopeKey, scopeKey, scopeKey, limit, input.at, limit, limit]
      : [input.afterScopeKey, input.afterScopeKey, limit + 1, input.afterScopeKey, input.afterScopeKey, limit + 1, limit + 1, limit, input.at, limit, limit];
      const rows = this.context.database.prepare(scopePageQuery(exact)).all(...parameters) as ScopePageRow[];
      const sentinelExists = !exact && rows.some((row) => row.page_rank > limit);
      const realRows = rows.filter((row) => row.page_rank <= limit);
      const headCandidates = realRows.flatMap((row): HeadCandidateRow[] => row.head_id === null ? [] : [{
        id: row.head_id,
        scope_key: row.head_scope_key ?? "",
        delivery_order: Number(row.head_delivery_order),
        state: row.head_state ?? "",
        claim_attempt_id: row.head_claim_attempt_id,
        next_attempt_at: row.head_next_attempt_at ?? "",
        quarantined: Number(row.quarantined ?? 0),
        unmet_prerequisites: Number(row.unmet_prerequisites ?? 0)
      }]);
      const cooldownByHeadId = new Map(realRows.flatMap((row) => row.head_id === null ? [] : [[row.head_id, row.cooldown_until] as const]));
      const classifications = headCandidates.map((candidate) => this.classifyHeadCandidate(candidate, input.at,
        cooldownByHeadId.get(candidate.id) ?? null));
      const readyHydrations = this.hydrateDeliveryWorkBatch(classifications
        .filter((classification) => classification.head.status === "ready")
        .map((classification) => classification.candidate));
      const heads = new Map(classifications.map(({ candidate, head }) => {
        const hydrated = head.status === "ready" ? readyHydrations.get(candidate.id) : undefined;
        if (!hydrated) return [candidate.id, head] as const;
        if (hydrated.status === "ready") return [candidate.id, { ...head, delivery: hydrated.work }] as const;
        return [candidate.id, {
          ...head,
          status: hydrated.status === "missing" ? "invalid" : hydrated.status,
          delivery: null
        } satisfies PreparedDeliveryScopeHead] as const;
      }));
      const items = realRows.map((row): PreparedDeliveryScopePageItem => {
        const scope = this.requireScopePageIdentity(row, input.scope);
        const maximumDeliveryOrder = Math.max(0, Number(row.maximum_delivery_order ?? 0));
        const blockerDeliveryOrder = row.blocker_delivery_order === null ? null : Number(row.blocker_delivery_order);
        const safeCommittedOrder = blockerDeliveryOrder === null ? maximumDeliveryOrder : Math.max(0, blockerDeliveryOrder - 1);
        const priorCommittedOrder = row.prior_committed_order === null ? null : Number(row.prior_committed_order);
        const head = row.head_id === null ? null : heads.get(row.head_id) ?? {
          replyId: row.head_id,
          scopeKey: row.page_scope_key,
          deliveryOrder: Number(row.head_delivery_order),
          status: "invalid",
          nextAttemptAt: row.head_next_attempt_at ?? "",
          delivery: null
        };
        return {
          scope,
          scopeKey: row.page_scope_key,
          priorCommittedOrder,
          safeCommittedOrder,
          maximumDeliveryOrder,
          authoritativeBlocker: row.blocker_reply_id === null || blockerDeliveryOrder === null
            ? null
            : { replyId: row.blocker_reply_id, deliveryOrder: blockerDeliveryOrder },
          head,
          checkpointChanged: priorCommittedOrder !== safeCommittedOrder
        };
      });
      const changed = items.filter((item) => item.checkpointChanged);
      if (changed.length > 0) {
        const checkpointOutcome = this.commitDiscoveredCheckpoints(changed, input.at);
        if (checkpointOutcome === "stale") {
          if (staleRetries > 0) return this.loadScopePageAttempt(input, staleRetries - 1);
          return { items: [], nextCursor: null, nextRetryAt: null, recoveryBlocked: true };
        }
      }
      const nextRetryAt = items.flatMap((item) => item.head && (item.head.status === "future_due" || item.head.status === "cooldown_blocked")
        ? [item.head.status === "cooldown_blocked" ? (realRows.find((row) => row.page_scope_key === item.scopeKey)?.cooldown_until ?? item.head.nextAttemptAt) : item.head.nextAttemptAt]
        : []).sort()[0] ?? null;
      return {
        items,
        nextCursor: sentinelExists ? items.at(-1)?.scopeKey ?? null : null,
        nextRetryAt,
        recoveryBlocked: items.some((item) => item.head?.status === "invalid" || item.head?.status === "unprepared")
      };
  }

  private commitDiscoveredCheckpoints(
    items: readonly PreparedDeliveryScopePageItem[],
    at: string
  ): "committed" | "stale" {
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const currentRows = this.context.database.prepare(checkpointFactQuery(items.length))
        .all(...items.map((item) => item.scopeKey)) as CheckpointFactRow[];
      const currentByScope = new Map(currentRows.map((row) => [row.page_scope_key, row]));
      for (const item of items) {
        const current = currentByScope.get(item.scopeKey);
        if (!current) return "stale";
        this.requireScopePageIdentity(current, item.scope);
        const blockerOrder = current.blocker_delivery_order === null ? null : Number(current.blocker_delivery_order);
        const maximumOrder = Math.max(0, Number(current.maximum_delivery_order ?? 0));
        const safeOrder = blockerOrder === null ? maximumOrder : Math.max(0, blockerOrder - 1);
        const priorOrder = current.prior_committed_order === null ? null : Number(current.prior_committed_order);
        if (priorOrder !== item.priorCommittedOrder
          || maximumOrder !== item.maximumDeliveryOrder
          || safeOrder !== item.safeCommittedOrder
          || current.blocker_reply_id !== (item.authoritativeBlocker?.replyId ?? null)
          || blockerOrder !== (item.authoritativeBlocker?.deliveryOrder ?? null)) return "stale";
      }
      const values = items.map(() => "(?,?,?,?,?,?,?)").join(",");
      const bindings = items.flatMap((item) => item.scope.kind === "pane"
        ? [item.scopeKey, "pane", item.scope.workspaceId, item.scope.paneId, item.safeCommittedOrder, at, at]
        : [item.scopeKey, "global", null, null, item.safeCommittedOrder, at, at]);
      this.context.database.prepare(`INSERT INTO delivery_ring_checkpoints(
        scope_key,scope_kind,scope_workspace_id,scope_pane_id,committed_delivery_order,created_at,updated_at
      ) VALUES ${values}
      ON CONFLICT(scope_key) DO UPDATE SET
        committed_delivery_order=excluded.committed_delivery_order,updated_at=excluded.updated_at
      WHERE delivery_ring_checkpoints.committed_delivery_order<>excluded.committed_delivery_order`).run(...bindings);
      const backwardRebases = items.filter((item) => item.priorCommittedOrder !== null && item.safeCommittedOrder < item.priorCommittedOrder).length;
      if (backwardRebases > 0) this.incrementRolloutCounter("checkpoint_backward_rebase_count", backwardRebases);
      return "committed";
    });
  }

  private incrementRolloutCounter(column: "preparation_cas_failure_count" | "checkpoint_backward_rebase_count", amount = 1): void {
    this.context.database.prepare(`UPDATE semantic_delivery_rollout SET ${column}=${column}+? WHERE singleton_id=1`).run(amount);
  }

  async load(input: { scope: DeliveryScope | null; limit: number; now: string; pageToken?: string | null }): Promise<DeliveryEngineRefillResult> {
    const page = this.loadScopePage({ scope: input.scope, afterScopeKey: input.pageToken ?? null, limit: input.limit, at: input.now });
    return {
      deliveries: page.items.flatMap((item) => item.head?.status === "ready" && item.head.delivery ? [item.head.delivery as PreparedDelivery] : []),
      nextRetryAt: page.nextRetryAt, nextPageToken: page.nextCursor,
      recoveryBlocked: page.recoveryBlocked
    };
  }

  async isDurablyEmpty(scope: DeliveryScope, _now: string): Promise<boolean> {
    const scopeKey = deliveryScopeKey(scope);
    return this.context.database.prepare(`SELECT 1 FROM outbound_replies
      WHERE scope_key=? AND ${nonterminalReplySql("outbound_replies")} LIMIT 1`).get(scopeKey) === undefined;
  }

  private requireScopePageIdentity(row: ScopeIdentityRow, expected: DeliveryScope | null): DeliveryScope {
    if (Number(row.reply_identity_conflict ?? 0) !== 0) throw new Error(`Conflicting Delivery Scope rows for ${row.page_scope_key}`);
    const checkpointIdentity = row.checkpoint_scope_kind === null ? null : {
      kind: row.checkpoint_scope_kind,
      workspaceId: row.checkpoint_workspace_id,
      paneId: row.checkpoint_pane_id
    };
    const replyIdentity = row.reply_scope_kind === null ? null : {
      kind: row.reply_scope_kind,
      workspaceId: row.reply_workspace_id,
      paneId: row.reply_pane_id
    };
    if (checkpointIdentity && replyIdentity && (checkpointIdentity.kind !== replyIdentity.kind
      || checkpointIdentity.workspaceId !== replyIdentity.workspaceId || checkpointIdentity.paneId !== replyIdentity.paneId)) {
      throw new Error(`Conflicting Delivery Scope evidence for ${row.page_scope_key}`);
    }
    const identity = checkpointIdentity ?? replyIdentity;
    const scope: DeliveryScope = identity?.kind === "global" && identity.workspaceId === null && identity.paneId === null
      ? { kind: "global" }
      : identity?.kind === "pane" && identity.workspaceId !== null && identity.paneId !== null
        ? { kind: "pane", workspaceId: identity.workspaceId, paneId: identity.paneId }
        : (() => { throw new Error(`Invalid Delivery Scope for ${row.page_scope_key}`); })();
    if (deliveryScopeKey(scope) !== row.page_scope_key || expected && deliveryScopeKey(expected) !== row.page_scope_key) {
      throw new Error(`Delivery Scope key conflict for ${row.page_scope_key}`);
    }
    return scope;
  }

  hydratePreparedDelivery(replyId: string): PreparedDeliveryHydration {
    const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE id=?").get(replyId) as OutboundReplyRow | undefined;
    if (!row) return { status: "missing" };
    if (row.state === "dismissed") {
      const hiddenAttemptBudgetDismissal = this.context.database.prepare(`SELECT 1 FROM delivery_recoveries
        WHERE failed_reply_id=? AND state='dismissed' AND action='dismiss_attempt_budget'`).get(replyId);
      if (hiddenAttemptBudgetDismissal) return { status: "missing" };
    }
    return hydrate(row);
  }

  hydrateDeliveryInput(replyId: string): DeliveryInputHydration {
    const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE id=?").get(replyId) as SemanticDeliveryRow | undefined;
    if (!row) return { status: "missing" };
    return hydrateDeliveryInput(row);
  }

  hydrateDeliveryWork(replyId: string): DeliveryWorkHydration {
    const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE id=?").get(replyId) as SemanticDeliveryRow | undefined;
    if (!row) return { status: "missing" };
    return hydrateDeliveryWork(row);
  }

  backfillLegacyConflictKeys(limit: number): { processedCount: number; hasMore: boolean } {
    const bounded = boundedLimit(limit);
    if (bounded === 0) return { processedCount: 0, hasMore: false };
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const rows = this.context.database.prepare(`SELECT * FROM outbound_replies INDEXED BY outbound_replies_conflict_backfill
        WHERE conflict_key IS NULL AND state IN ('pending','dead_letter')
        ORDER BY delivery_order,id LIMIT ?`).all(bounded + 1) as OutboundReplyRow[];
      for (const row of rows.slice(0, bounded)) {
        let conflictKey: string;
        try {
          conflictKey = deliveryConflictKey({
            gatewayId: row.gateway_id, laneKey: row.lane_key, projectionKey: row.projection_key,
            bindingId: row.binding_id,
            bindingGeneration: row.delivery_owner_kind === "primary" ? row.delivery_owner_generation : row.delivery_parent_generation,
            promptId: row.prompt_id, workerTurnId: row.worker_turn_id, workerId: row.worker_id,
            workerSessionGeneration: row.worker_session_generation, streamPageIndex: row.stream_page_index,
            targetRole: row.target_role as OutboundReply["targetRole"], kind: row.kind as OutboundReply["kind"],
            rootMessageId: row.root_message_id
          });
        } catch {
          if (!row.lane_key?.trim()) throw new Error("delivery_conflict_identity_required");
          conflictKey = row.lane_key;
        }
        const changed = this.context.database.prepare(`UPDATE outbound_replies SET conflict_key=?
          WHERE id=? AND conflict_key IS NULL AND state IN ('pending','dead_letter')`).run(conflictKey, row.id);
        if (changed.changes !== 1) throw new Error("legacy_delivery_conflict_changed_during_backfill");
        const quarantine = this.context.database.prepare(`SELECT failure_class,created_at FROM outbox_lane_quarantines
          WHERE failed_reply_id=? AND state='active'`).get(row.id) as { failure_class: OutboundReply["failureClass"]; created_at: string } | undefined;
        if (quarantine) {
          const failureClass = quarantine.failure_class ?? row.failure_class as OutboundReply["failureClass"] ?? "unknown";
          const effectCertainty = row.effect_certainty as OutboundReply["effectCertainty"] ?? "uncertain";
          const budget = deliveryDegradationBudget({
            failureClass,
            effectCertainty,
            firstFailedAt: quarantine.created_at
          });
          this.context.database.prepare(`UPDATE outbox_lane_quarantines SET conflict_key=?,phase='grace_blocking',
            first_failed_at=COALESCE(first_failed_at,created_at),grace_deadline_at=COALESCE(grace_deadline_at,?),
            budget_attempt_limit=COALESCE(budget_attempt_limit,?),budget_duration_ms=COALESCE(budget_duration_ms,?)
            WHERE failed_reply_id=? AND state='active'`).run(conflictKey, budget.deadlineAt, budget.attemptLimit, budget.durationMs, row.id);
        }
      }
      return { processedCount: Math.min(rows.length, bounded), hasMore: rows.length > bounded };
    });
  }

  getNextScopeHeadEligibility(at: string): string | null {
    let cursor: string | null = null;
    let earliest: string | null = null;
    do {
      const page = this.loadScopePage({ scope: null, afterScopeKey: cursor, limit: 256, at });
      if (page.nextRetryAt && (!earliest || page.nextRetryAt < earliest)) earliest = page.nextRetryAt;
      cursor = page.nextCursor;
    } while (cursor !== null);
    return earliest;
  }

  addPrerequisite(input: { dependentReplyId: string; prerequisiteReplyId: string; requiredState: "delivered" | "dismissed" }): void {
    this.context.database.prepare(`INSERT INTO outbound_reply_prerequisites(dependent_reply_id,prerequisite_reply_id,required_state,created_at)
      VALUES(?,?,?,?) ON CONFLICT(dependent_reply_id,prerequisite_reply_id) DO UPDATE SET required_state=excluded.required_state`).run(input.dependentReplyId, input.prerequisiteReplyId, input.requiredState, now());
  }

  listDependentScopeKeys(prerequisiteReplyId: string, limit: number): string[] {
    const bounded = boundedLimit(limit);
    if (bounded === 0) return [];
    return (this.context.database.prepare(`SELECT DISTINCT dependent.scope_key
      FROM outbound_reply_prerequisites p INDEXED BY outbound_reply_prerequisites_reverse
      JOIN outbound_replies dependent ON dependent.id=p.dependent_reply_id
      WHERE p.prerequisite_reply_id=? AND dependent.scope_key IS NOT NULL
        AND dependent.state IN ('pending','dead_letter')
      ORDER BY dependent.scope_key LIMIT ?`).all(prerequisiteReplyId, bounded) as Array<{ scope_key: string }>).map(({ scope_key }) => scope_key);
  }

  runGlobalRingMaintenance(input: { at: string; limit: number }): GlobalRingMaintenance {
    const bounded = boundedLimit(input.limit);
    if (bounded === 0) return { affectedScopeKeys: [] };
    const affectedScopeKeys = new Set<string>();
    for (const replyId of this.recoverExpiredRingClaims(input.at, bounded)) {
      const row = this.context.database.prepare("SELECT scope_key FROM outbound_replies WHERE id=?").get(replyId) as { scope_key: string | null } | undefined;
      if (row?.scope_key) affectedScopeKeys.add(row.scope_key);
    }
    for (const scopeKey of this.dismissRejectedQuarantineReviewBatch({ at: input.at, limit: bounded })) affectedScopeKeys.add(scopeKey);
    for (const scopeKey of this.dismissNestedPendingQuarantineReviewBatch({ at: input.at, limit: bounded })) affectedScopeKeys.add(scopeKey);
    for (const scopeKey of this.coalesceHistoricalPrimaryMainSnapshots({ at: input.at, limit: bounded })) affectedScopeKeys.add(scopeKey);
    for (const scopeKey of this.retireOrphanedPrimaryMainPendingDeliveries({ at: input.at, limit: bounded }).transitionedScopeKeys) affectedScopeKeys.add(scopeKey);
    return { affectedScopeKeys: [...affectedScopeKeys] };
  }

  recoverExpiredRingClaims(at: string, limit: number): string[] {
    const bounded = boundedLimit(limit);
    if (bounded === 0) return [];
    return this.context.transaction("sqlite.prepared-delivery-store.ring-maintenance.expired-claims", () => this.recoverExpiredRingClaimsInTransaction(at, bounded));
  }

  private recoverExpiredRingClaimsInTransaction(at: string, bounded: number): string[] {
    const rows = this.context.database.prepare(`SELECT id,lane_key,conflict_key FROM outbound_replies INDEXED BY outbound_replies_expired_ring_claims
      WHERE state='pending' AND claim_attempt_id IS NOT NULL
        AND claim_expires_at IS NOT NULL AND claim_expires_at <= ? ORDER BY claim_expires_at,id LIMIT ?`).all(at, bounded) as Array<{ id: string; lane_key: string; conflict_key: string }>;
    const recovered: string[] = [];
    for (const row of rows) {
      const changed = this.context.database.prepare(`UPDATE outbound_replies SET state='dead_letter', claim_attempt_id=NULL,
        claimed_fence=NULL, claimed_owner_id=NULL, claimed_at=NULL, claim_expires_at=NULL,
        failure_class='unknown', effect_certainty='uncertain', error='Delivery outcome uncertain after Ring claim expiry',
        dead_lettered_at=?, updated_at=? WHERE id=? AND state='pending'
        AND claim_attempt_id IS NOT NULL AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`).run(at, at, row.id, at);
      if (changed.changes !== 1) continue;
      const budget = deliveryDegradationBudget({ failureClass: "unknown", effectCertainty: "uncertain", firstFailedAt: at });
      this.context.database.prepare(`INSERT INTO outbox_lane_quarantines(
        lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at,
        conflict_key,phase,first_failed_at,grace_deadline_at,budget_attempt_limit,budget_duration_ms
      ) VALUES(?,?,'immutable','unknown','active','blocked','Delivery outcome uncertain after Ring claim expiry',?,?,?,'grace_blocking',?,?,?,?)
      ON CONFLICT(lane_key) DO UPDATE SET failed_reply_id=excluded.failed_reply_id,lane_class='immutable',failure_class='unknown',
        state='active',action='blocked',reason=excluded.reason,updated_at=excluded.updated_at,released_at=NULL,
        conflict_key=excluded.conflict_key,phase='grace_blocking',first_failed_at=excluded.first_failed_at,
        grace_deadline_at=excluded.grace_deadline_at,degraded_at=NULL,budget_attempt_limit=excluded.budget_attempt_limit,
        budget_duration_ms=excluded.budget_duration_ms`).run(
        row.lane_key, row.id, at, at, row.conflict_key, at, budget.deadlineAt, budget.attemptLimit, budget.durationMs
      );
      recovered.push(row.id);
    }
    return recovered;
  }

  coalesceHistoricalPrimaryMainSnapshots(input: { at: string; limit: number }): string[] {
    const bounded = boundedLimit(input.limit);
    if (bounded === 0) return [];
    const candidates = this.findHistoricalPrimaryMainSnapshotCandidates({ limit: bounded });
    return this.context.transaction("sqlite.prepared-delivery-store.ring-maintenance.historical-primary-main", () =>
      this.coalesceHistoricalPrimaryMainSnapshotsInTransaction(input.at, candidates)
    );
  }

  retireReconstructibleInvalidOwnerHeads(input: { at: string; limit: number }): ReconstructibleInvalidOwnerMaintenance {
    const bounded = boundedLimit(input.limit);
    if (bounded === 0) return { transitionedScopeKeys: [], projectionRecoveryHints: [] };
    const scopeKeys = this.listReconstructibleInvalidOwnerScopePage(bounded);
    if (scopeKeys.length === 0) return { transitionedScopeKeys: [], projectionRecoveryHints: [] };
    const candidates = this.context.database.prepare(`${reconstructibleInvalidPrimaryMainHeadSql(true)}
      ORDER BY head.delivery_order,head.id LIMIT ?`).all(JSON.stringify(scopeKeys), bounded) as ReconstructibleInvalidOwnerRow[];
    const transitionedScopeKeys: string[] = [];
    const projectionRecoveryHints: PreparedDeliveryProjectionRecoveryHint[] = [];
    for (const candidate of candidates) {
      const committed = this.context.transaction("sqlite.prepared-delivery-store.ring-maintenance.invalid-owner", () => {
        const row = this.context.database.prepare(`${reconstructibleInvalidPrimaryMainHeadSql()} AND head.id=?`)
          .get(candidate.id) as ReconstructibleInvalidOwnerRow | undefined;
        if (!row) return null;
        const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET
            state='dismissed',effect_certainty='not-started',
            error='Retired reconstructible delivery after durable owner invalidation',updated_at=?
          WHERE id=? AND state='pending' AND attempt_count=0 AND first_claimed_at IS NULL
            AND claim_attempt_id IS NULL AND claimed_owner_id IS NULL AND claimed_fence IS NULL
            AND claimed_at IS NULL AND claim_expires_at IS NULL
            AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL
            AND (effect_certainty IS NULL OR effect_certainty='not-started')`).run(input.at, row.id);
        if (dismissed.changes !== 1) return null;
        const recovery = this.context.database.prepare(`INSERT INTO delivery_recoveries(
            failed_reply_id,snapshot_revision,state,failure_class,http_status,lark_error_code,reason,action,
            semantic_recovery_proof,replacement_reply_id,resolved_by_reply_id,resolved_message_id,created_at,updated_at,resolved_at
          ) VALUES(?,?,'dismissed','unknown',NULL,NULL,?,'retired_invalid_owner_reconstructible',NULL,NULL,NULL,NULL,?,?,?)`)
          .run(row.id, row.snapshot_revision, "Durably invalid owner; authoritative current projection remains reconstructible", input.at, input.at, input.at);
        if (recovery.changes !== 1) throw new Error(`Failed to audit reconstructible invalid-owner retirement ${row.id}`);
        this.advanceCheckpointAfterTerminalTransition({ kind: "pane", workspaceId: row.scope_workspace_id, paneId: row.scope_pane_id }, input.at);
        this.queue.notifyScopeMutation(row.lane_key);
        return {
          scopeKey: row.scope_key,
          hint: { kind: "card-context", targetKind: "primary-session", targetId: row.current_owner_id, targetGeneration: row.current_owner_generation } as const
        };
      });
      if (!committed) continue;
      if (!transitionedScopeKeys.includes(committed.scopeKey)) transitionedScopeKeys.push(committed.scopeKey);
      if (!projectionRecoveryHints.some((hint) => hint.kind === "card-context"
        && hint.targetKind === committed.hint.targetKind && hint.targetId === committed.hint.targetId
        && hint.targetGeneration === committed.hint.targetGeneration)) projectionRecoveryHints.push(committed.hint);
    }
    return { transitionedScopeKeys, projectionRecoveryHints };
  }

  retireOrphanedPrimaryMainPendingDeliveries(input: { at: string; limit: number }): OrphanedPrimaryMainPendingMaintenance {
    const bounded = boundedLimit(input.limit);
    if (bounded === 0) return { transitionedScopeKeys: [] };
    const selectPage = (cursor: OrphanedPrimaryMainPendingCursor | null): OrphanedPrimaryMainPendingCandidate[] => {
      const rows = cursor === null
        ? this.context.database.prepare(`SELECT candidate.id,candidate.scope_key,candidate.delivery_order
            FROM outbound_replies candidate INDEXED BY outbound_replies_scope_nonterminal_order
            WHERE candidate.scope_key IS NOT NULL AND candidate.state IN ('pending','dead_letter') AND candidate.state='pending'
            ORDER BY candidate.scope_key,candidate.delivery_order,candidate.id LIMIT ?`).all(bounded)
        : this.context.database.prepare(`SELECT candidate.id,candidate.scope_key,candidate.delivery_order
            FROM outbound_replies candidate INDEXED BY outbound_replies_scope_nonterminal_order
            WHERE candidate.scope_key IS NOT NULL AND candidate.state IN ('pending','dead_letter') AND candidate.state='pending'
              AND (candidate.scope_key>? OR (candidate.scope_key=? AND candidate.delivery_order>?)
                OR (candidate.scope_key=? AND candidate.delivery_order=? AND candidate.id>?))
            ORDER BY candidate.scope_key,candidate.delivery_order,candidate.id LIMIT ?`).all(
            cursor.scopeKey, cursor.scopeKey, cursor.deliveryOrder,
            cursor.scopeKey, cursor.deliveryOrder, cursor.id, bounded
          );
      return rows as OrphanedPrimaryMainPendingCandidate[];
    };
    let page = selectPage(this.orphanedPrimaryMainPendingCursor);
    if (page.length === 0 && this.orphanedPrimaryMainPendingCursor !== null) {
      this.orphanedPrimaryMainPendingCursor = null;
      page = selectPage(null);
    }
    if (page.length === 0) return { transitionedScopeKeys: [] };
    this.orphanedPrimaryMainPendingCursor = page.length < bounded
      ? null
      : {
          scopeKey: page[page.length - 1]!.scope_key,
          deliveryOrder: Number(page[page.length - 1]!.delivery_order),
          id: page[page.length - 1]!.id
        };
    const candidateIds = page.map((candidate) => candidate.id);
    const candidates = this.context.database.prepare(`SELECT head.id
      FROM outbound_replies head
      WHERE head.id IN (${candidateIds.map(() => "?").join(",")})
        AND ${orphanedPrimaryMainPendingSql("head")}`).all(...candidateIds) as Array<{ id: string }>;
    const transitionedScopeKeys = new Set<string>();
    for (const candidate of candidates) {
      const transitionedScopeKey = this.context.transaction("sqlite.prepared-delivery-store.ring-maintenance.orphaned-primary-main-pending", () => {
        const row = this.context.database.prepare(`SELECT head.id,head.snapshot_revision,head.scope_key,
            head.scope_workspace_id,head.scope_pane_id,head.lane_key
          FROM outbound_replies head WHERE head.id=? AND ${orphanedPrimaryMainPendingSql("head")}`)
          .get(candidate.id) as OrphanedPrimaryMainPendingRow | undefined;
        if (!row) return null;
        const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET
            state='dismissed',effect_certainty='not-started',
            error='Retired no-effect Primary Main delivery after owner invalidation',updated_at=?
          WHERE id=? AND ${orphanedPrimaryMainPendingSql("outbound_replies")}`).run(input.at, row.id);
        if (dismissed.changes !== 1) return null;
        const recovery = this.context.database.prepare(`INSERT INTO delivery_recoveries(
            failed_reply_id,snapshot_revision,state,failure_class,http_status,lark_error_code,reason,action,
            semantic_recovery_proof,replacement_reply_id,resolved_by_reply_id,resolved_message_id,created_at,updated_at,resolved_at
          ) VALUES(?,?,'dismissed','unknown',NULL,NULL,?,'retired_orphaned_pending',NULL,NULL,NULL,NULL,?,?,?)`)
          .run(row.id, row.snapshot_revision, "Durably invalid owner; no external effect was attempted", input.at, input.at, input.at);
        if (recovery.changes !== 1) throw new Error(`Failed to audit orphaned pending retirement ${row.id}`);
        this.advanceCheckpointAfterTerminalTransition({ kind: "pane", workspaceId: row.scope_workspace_id, paneId: row.scope_pane_id }, input.at);
        this.queue.notifyScopeMutation(row.lane_key);
        return row.scope_key;
      });
      if (transitionedScopeKey) transitionedScopeKeys.add(transitionedScopeKey);
    }
    return { transitionedScopeKeys: [...transitionedScopeKeys] };
  }

  private listReconstructibleInvalidOwnerScopePage(limit: number): string[] {
    const select = (afterScopeKey: string | null): string[] => {
      const rows = this.context.database.prepare(reconstructibleInvalidPrimaryMainScopePageSql(afterScopeKey !== null))
        .all(...(afterScopeKey === null ? [limit] : [afterScopeKey, limit])) as Array<{ scope_key: string }>;
      return rows.map(({ scope_key }) => scope_key);
    };
    let scopeKeys = select(this.reconstructibleInvalidOwnerScopeCursor);
    if (scopeKeys.length === 0 && this.reconstructibleInvalidOwnerScopeCursor !== null) {
      this.reconstructibleInvalidOwnerScopeCursor = null;
      scopeKeys = select(null);
    }
    if (scopeKeys.length > 0) this.reconstructibleInvalidOwnerScopeCursor = scopeKeys.at(-1) ?? null;
    return scopeKeys;
  }

  private findHistoricalPrimaryMainSnapshotCandidates(input: { limit: number; replyId?: string }): Array<{ id: string; scope_key: string; lane_key: string }> {
    const replyFilter = input.replyId ? "AND historical.id=?" : "";
    const parameters = input.replyId ? [input.replyId, input.limit] : [input.limit];
    return this.context.database.prepare(`SELECT DISTINCT historical.id,historical.scope_key,historical.lane_key
      FROM outbound_replies historical
      JOIN outbound_replies newer ON newer.scope_key=historical.scope_key
        AND newer.conflict_key=historical.conflict_key
        AND newer.projection_key IS historical.projection_key
        AND newer.root_message_id IS historical.root_message_id
        AND newer.delivery_order>historical.delivery_order
        AND newer.snapshot_revision>historical.snapshot_revision
      WHERE historical.kind='card_update' AND historical.target_role='session_status'
        AND historical.state='pending' AND historical.attempt_count=0
        AND historical.claim_attempt_id IS NULL AND historical.claimed_owner_id IS NULL AND historical.claimed_fence IS NULL
        AND historical.claimed_at IS NULL AND historical.claim_expires_at IS NULL
        AND historical.card_id_checkpoint IS NULL AND historical.gateway_checkpoint_json IS NULL AND historical.delivered_message_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery
          WHERE recovery.failed_reply_id=historical.id OR recovery.replacement_reply_id=historical.id)
        AND NOT EXISTS (SELECT 1 FROM outbound_reply_prerequisites prerequisite
          WHERE prerequisite.dependent_reply_id=historical.id OR prerequisite.prerequisite_reply_id=historical.id)
        AND newer.kind='card_update' AND newer.target_role='session_status'
        AND newer.state='pending' AND newer.attempt_count=0
        AND newer.claim_attempt_id IS NULL AND newer.claimed_owner_id IS NULL AND newer.claimed_fence IS NULL
        AND newer.claimed_at IS NULL AND newer.claim_expires_at IS NULL
        AND newer.card_id_checkpoint IS NULL AND newer.gateway_checkpoint_json IS NULL AND newer.delivered_message_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery
          WHERE recovery.failed_reply_id=newer.id OR recovery.replacement_reply_id=newer.id)
        AND NOT EXISTS (SELECT 1 FROM outbound_reply_prerequisites prerequisite
          WHERE prerequisite.dependent_reply_id=newer.id OR prerequisite.prerequisite_reply_id=newer.id)
        ${replyFilter}
        AND historical.delivery_owner_kind='primary' AND ${currentPrimaryOwnerSql("historical")}
        AND newer.delivery_owner_kind='primary' AND ${currentPrimaryOwnerSql("newer")}
        AND ${currentPrimaryTargetSql("newer")}
      ORDER BY historical.delivery_order,historical.id,newer.snapshot_revision DESC,newer.delivery_order DESC LIMIT ?`).all(...parameters) as Array<{ id: string; scope_key: string; lane_key: string }>;
  }

  private coalesceHistoricalPrimaryMainSnapshotsInTransaction(
    at: string,
    candidates: readonly { id: string; scope_key: string; lane_key: string }[]
  ): string[] {
    const affectedScopeKeys = new Set<string>();
    for (const candidate of candidates) {
      const row = this.findHistoricalPrimaryMainSnapshotCandidates({ limit: 1, replyId: candidate.id })[0];
      if (!row) continue;
      const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET
          state='dismissed',error='Coalesced unclaimed stale Primary Main snapshot during global Ring maintenance',updated_at=?
        WHERE id=? AND state='pending' AND attempt_count=0
          AND claim_attempt_id IS NULL AND claimed_owner_id IS NULL AND claimed_fence IS NULL
          AND claimed_at IS NULL AND claim_expires_at IS NULL
          AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL AND delivered_message_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM delivery_recoveries recovery
            WHERE recovery.failed_reply_id=outbound_replies.id OR recovery.replacement_reply_id=outbound_replies.id)
          AND NOT EXISTS (SELECT 1 FROM outbound_reply_prerequisites prerequisite
            WHERE prerequisite.dependent_reply_id=outbound_replies.id OR prerequisite.prerequisite_reply_id=outbound_replies.id)`).run(at, row.id);
      if (dismissed.changes !== 1) continue;
      this.queue.notifyScopeMutation(row.lane_key);
      affectedScopeKeys.add(row.scope_key);
    }
    return [...affectedScopeKeys];
  }

  recoverQuarantinedRingHeads(input: { afterScopeKey: string | null; limit: number; at: string; skipGlobalMaintenance?: boolean }): QuarantinedRingHeadMaintenance {
    if (!input.skipGlobalMaintenance) {
      this.dismissRejectedQuarantineReviewBatch({ at: input.at, limit: rejectedQuarantineReviewBatchLimit });
      this.dismissNestedPendingQuarantineReviewBatch({ at: input.at, limit: rejectedQuarantineReviewBatchLimit });
    }
    const degradedScopeKeys = this.degradeExpiredQuarantines(input);
    this.reserveMissingQuarantineReviews(input);
    const page = this.listScopeHeads(input);
    const transitionedScopeKeys = [...degradedScopeKeys];
    const recoverableHeads = page.items.filter((head) => head.status === "dead_letter" || head.status === "quarantined");
    const hydratedHeads = this.hydratePreparedDeliveryBatch(recoverableHeads);
    for (const head of recoverableHeads) {
      const hydrated = hydratedHeads.get(head.replyId) ?? { status: "missing" as const };
      if (hydrated.status === "prepared") {
        const advanced = this.advanceSupersededHead({ delivery: hydrated.delivery, at: input.at });
        if (advanced.outcome === "advanced") {
          if (!transitionedScopeKeys.includes(advanced.scopeKey)) transitionedScopeKeys.push(advanced.scopeKey);
          continue;
        }
      }
      const dismissedScopeKey = this.dismissRejectedAfterAttemptBudget(head.replyId, input.at);
      const retiredScopeKey = dismissedScopeKey ?? this.retireObsoleteQuarantinedRingHead(head.replyId, input.at);
      const orphanedScopeKey = retiredScopeKey ?? this.retireOrphanedRejectedRingHead(head.replyId, input.at);
      if (orphanedScopeKey && !transitionedScopeKeys.includes(orphanedScopeKey)) transitionedScopeKeys.push(orphanedScopeKey);
    }
    return { transitionedScopeKeys, nextCursor: page.nextCursor };
  }

  private reserveMissingQuarantineReviews(input: { afterScopeKey: string | null; limit: number; at: string }): void {
    if (!this.quarantineReviewRenderer) return;
    const rows = this.context.database.prepare(`SELECT quarantine.failed_reply_id
      FROM outbox_lane_quarantines quarantine INDEXED BY outbox_lane_quarantines_phase_deadline
      JOIN outbound_replies failed ON failed.id=quarantine.failed_reply_id
      WHERE quarantine.state='active' AND quarantine.phase='conflict_isolated'
        AND quarantine.review_reply_id IS NULL AND failed.scope_key IS NOT NULL
        AND (failed.projection_key IS NULL OR failed.projection_key NOT LIKE 'delivery-quarantine-review:%')
        AND (? IS NULL OR failed.scope_key>?)
      ORDER BY failed.scope_key,quarantine.degraded_at,quarantine.failed_reply_id LIMIT ?`).all(
      input.afterScopeKey, input.afterScopeKey, boundedLimit(input.limit)
    ) as Array<{ failed_reply_id:string }>;
    for (const row of rows) this.reserveQuarantineReview(row.failed_reply_id, input.at);
  }

  dismissRejectedQuarantineReviewBatch(input: { at: string; limit: number }): string[] {
    const bounded = boundedLimit(input.limit);
    if (bounded === 0) return [];
    const rows = this.context.database.prepare(`SELECT review.id,review.lane_key,review.scope_key
      FROM outbound_replies review
      JOIN outbox_lane_quarantines quarantine ON quarantine.failed_reply_id=review.id
      WHERE review.projection_key LIKE 'delivery-quarantine-review:%'
        AND review.state='dead_letter' AND review.effect_certainty='rejected'
        AND review.claim_attempt_id IS NULL AND review.claimed_owner_id IS NULL AND review.claimed_fence IS NULL
        AND review.claimed_at IS NULL AND review.claim_expires_at IS NULL
        AND review.card_id_checkpoint IS NULL AND review.gateway_checkpoint_json IS NULL
        AND review.delivered_message_id IS NULL AND quarantine.state='active'
      ORDER BY review.dead_lettered_at,review.id LIMIT ?`).all(bounded) as Array<{ id: string; lane_key: string; scope_key: string | null }>;
    return this.context.transaction("sqlite.prepared-delivery-store.ring-maintenance.rejected-quarantine-review", () => {
      const affectedScopeKeys = new Set<string>();
      for (const row of rows) {
        const dismissed = this.context.database.prepare(`UPDATE outbound_replies AS review SET
            state='dismissed',error='Dismissed rejected Human Review escalation without recursive escalation',updated_at=?
          WHERE review.id=? AND review.projection_key LIKE 'delivery-quarantine-review:%'
            AND review.state='dead_letter' AND review.effect_certainty='rejected'
            AND review.claim_attempt_id IS NULL AND review.claimed_owner_id IS NULL AND review.claimed_fence IS NULL
            AND review.claimed_at IS NULL AND review.claim_expires_at IS NULL
            AND review.card_id_checkpoint IS NULL AND review.gateway_checkpoint_json IS NULL
            AND review.delivered_message_id IS NULL
            AND EXISTS (SELECT 1 FROM outbox_lane_quarantines quarantine
              WHERE quarantine.failed_reply_id=review.id AND quarantine.state='active')`).run(input.at, row.id);
        if (dismissed.changes !== 1) continue;
        this.context.database.prepare(`UPDATE delivery_recoveries SET state='dismissed',action='dismiss_rejected_review',
            resolved_at=?,updated_at=? WHERE failed_reply_id=? AND state IN ('unresolved','replacement_pending')`).run(input.at, input.at, row.id);
        const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines SET
            state='released',action='dismiss_rejected_review',released_at=?,updated_at=?
          WHERE failed_reply_id=? AND state='active'`).run(input.at, input.at, row.id);
        if (released.changes !== 1) throw new Error(`Failed to release rejected quarantine review ${row.id}`);
        this.queue.notifyScopeMutation(row.lane_key);
        if (row.scope_key) affectedScopeKeys.add(row.scope_key);
      }
      return [...affectedScopeKeys];
    });
  }

  dismissNestedPendingQuarantineReviewBatch(input: { at: string; limit: number }): string[] {
    const bounded = boundedLimit(input.limit);
    if (bounded === 0) return [];
    const rows = this.context.database.prepare(`SELECT candidate.id,candidate.lane_key,
        parent.id AS parent_reply_id,parent.scope_key AS parent_scope_key,
        parent_quarantine.lane_key AS parent_lane_key
      FROM outbound_replies candidate
      JOIN outbound_replies parent ON parent.id=substr(candidate.projection_key,length('delivery-quarantine-review:')+1)
      JOIN outbox_lane_quarantines parent_quarantine
        ON parent_quarantine.failed_reply_id=parent.id AND parent_quarantine.review_reply_id=candidate.id
      WHERE candidate.projection_key LIKE 'delivery-quarantine-review:%'
        AND parent.projection_key LIKE 'delivery-quarantine-review:%'
        AND candidate.state='pending' AND candidate.attempt_count=0 AND candidate.first_claimed_at IS NULL
        AND candidate.claim_attempt_id IS NULL AND candidate.claimed_owner_id IS NULL AND candidate.claimed_fence IS NULL
        AND candidate.claimed_at IS NULL AND candidate.claim_expires_at IS NULL
        AND candidate.card_id_checkpoint IS NULL AND candidate.gateway_checkpoint_json IS NULL
        AND candidate.delivered_message_id IS NULL
        AND parent_quarantine.state IN ('active','released')
      ORDER BY candidate.created_at,candidate.id LIMIT ?`).all(bounded) as Array<{
        id: string; lane_key: string; parent_reply_id: string; parent_scope_key: string | null; parent_lane_key: string;
      }>;
    return this.context.transaction("sqlite.prepared-delivery-store.ring-maintenance.nested-quarantine-review", () => {
      const affectedScopeKeys = new Set<string>();
      for (const row of rows) {
        const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET
            state='dismissed',error='Dismissed nested pending Human Review escalation without recursive escalation',updated_at=?
          WHERE id=? AND state='pending' AND attempt_count=0 AND first_claimed_at IS NULL
            AND claim_attempt_id IS NULL AND claimed_owner_id IS NULL AND claimed_fence IS NULL
            AND claimed_at IS NULL AND claim_expires_at IS NULL
            AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL
            AND delivered_message_id IS NULL`).run(input.at, row.id);
        if (dismissed.changes !== 1) continue;
        this.context.database.prepare(`UPDATE delivery_recoveries SET state='dismissed',action='dismiss_nested_review',
            resolved_at=?,updated_at=? WHERE failed_reply_id=? AND state IN ('unresolved','replacement_pending')`).run(input.at, input.at, row.parent_reply_id);
        const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines SET
            state='released',action='dismiss_nested_review',released_at=?,updated_at=?
          WHERE failed_reply_id=? AND review_reply_id=? AND state='active'`).run(input.at, input.at, row.parent_reply_id, row.id);
        if (released.changes > 1) throw new Error(`Multiple nested quarantine reviews found for ${row.id}`);
        this.queue.notifyScopeMutation(row.lane_key);
        this.queue.notifyScopeMutation(row.parent_lane_key);
        if (row.parent_scope_key) affectedScopeKeys.add(row.parent_scope_key);
      }
      return [...affectedScopeKeys];
    });
  }

  private degradeExpiredQuarantines(input: { afterScopeKey: string | null; limit: number; at: string }): string[] {
    const bounded = boundedLimit(input.limit);
    if (bounded === 0) return [];
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const rows = this.context.database.prepare(`SELECT quarantine.failed_reply_id,failed.scope_key
        FROM outbox_lane_quarantines quarantine INDEXED BY outbox_lane_quarantines_phase_deadline
        JOIN outbound_replies failed ON failed.id=quarantine.failed_reply_id
        WHERE quarantine.state='active' AND quarantine.phase='grace_blocking'
          AND failed.scope_key IS NOT NULL AND (? IS NULL OR failed.scope_key>?)
          AND ((quarantine.grace_deadline_at IS NOT NULL AND quarantine.grace_deadline_at<=?)
            OR (quarantine.budget_attempt_limit IS NOT NULL AND quarantine.budget_attempt_limit>0
              AND failed.attempt_count>=quarantine.budget_attempt_limit))
        ORDER BY failed.scope_key,quarantine.grace_deadline_at,quarantine.failed_reply_id LIMIT ?`).all(
        input.afterScopeKey, input.afterScopeKey, input.at, bounded
      ) as Array<{ failed_reply_id: string; scope_key: string }>;
      const transitioned = new Set<string>();
      for (const row of rows) {
        const changed = this.context.database.prepare(`UPDATE outbox_lane_quarantines AS quarantine SET
            phase='conflict_isolated',degraded_at=COALESCE(degraded_at,?),updated_at=?
          WHERE failed_reply_id=? AND state='active' AND phase='grace_blocking'
            AND ((grace_deadline_at IS NOT NULL AND grace_deadline_at<=?)
              OR (budget_attempt_limit IS NOT NULL AND budget_attempt_limit>0
                AND (SELECT attempt_count FROM outbound_replies WHERE id=quarantine.failed_reply_id)>=budget_attempt_limit))`).run(
          input.at, input.at, row.failed_reply_id, input.at
        );
        if (changed.changes === 1) transitioned.add(row.scope_key);
        if (changed.changes === 1) this.reserveQuarantineReview(row.failed_reply_id, input.at);
      }
      return [...transitioned];
    });
  }

  private reserveQuarantineReview(failedReplyId: string, at: string): void {
    const renderer = this.quarantineReviewRenderer;
    if (!renderer) return;
    const row = this.context.database.prepare(`SELECT failed.id,failed.gateway_id,failed.gateway_profile_id,failed.binding_id,
      failed.worker_id,failed.worker_session_generation,failed.kind,failed.failure_class,failed.effect_certainty,
      failed.auto_recovery_count,failed.delivered_message_id,failed.card_id_checkpoint,failed.gateway_checkpoint_json,
      failed.scope_kind,failed.scope_workspace_id,failed.scope_pane_id,failed.error,quarantine.reason,
      binding.generation AS binding_generation,failed.root_message_id AS failed_root_message_id,binding.root_message_id AS binding_root_message_id,
      binding.creator_open_id,binding.title
      FROM outbound_replies failed
      JOIN outbox_lane_quarantines quarantine ON quarantine.failed_reply_id=failed.id
      LEFT JOIN bindings binding ON binding.id=failed.binding_id
      WHERE failed.id=? AND failed.state='dead_letter' AND quarantine.state='active'
        AND quarantine.phase='conflict_isolated' AND quarantine.review_reply_id IS NULL
        AND (failed.projection_key IS NULL OR failed.projection_key NOT LIKE 'delivery-quarantine-review:%')`).get(failedReplyId) as {
          id:string; gateway_id:string; gateway_profile_id:string; binding_id:string|null; worker_id:string|null;
          worker_session_generation:number|null; kind:OutboundReply["kind"]; failure_class:OutboundReply["failureClass"];
          effect_certainty:OutboundReply["effectCertainty"]; auto_recovery_count:number; delivered_message_id:string|null;
          card_id_checkpoint:string|null; gateway_checkpoint_json:string|null; scope_kind:"pane"|"global";
          scope_workspace_id:string|null; scope_pane_id:string|null; error:string|null; reason:string;
          binding_generation:number|null; failed_root_message_id:string|null; binding_root_message_id:string|null; creator_open_id:string|null; title:string|null;
        } | undefined;
    if (!row || !row.failure_class || !row.effect_certainty) return;
    const rootMessageId = row.binding_root_message_id ?? row.failed_root_message_id;
    if (!rootMessageId) return;
    const retryAllowed = isDirectDeliveryRetryAllowed({
      effectCertainty: row.effect_certainty,
      autoRecoveryCount: row.auto_recovery_count,
      kind: row.kind,
      deliveredMessageId: row.delivered_message_id,
      cardIdCheckpoint: row.card_id_checkpoint,
      gatewayCheckpointJson: row.gateway_checkpoint_json,
    });
    const scopeLabel = row.scope_kind === "pane"
      ? `${row.title ?? "Primary pane"} · ${row.scope_pane_id ?? "unknown pane"}`
      : "Global Ring";
    const projectionKey = `delivery-quarantine-review:${row.id}`;
    const card = renderer({
      failedReplyId: row.id, replyKind: row.kind, failureClass: row.failure_class,
      effectCertainty: row.effect_certainty, reason: row.reason || row.error || "Delivery requires review",
      scopeLabel, creatorOpenId: row.creator_open_id, retryAllowed
    });
    const receipt = this.reserve({
      id: randomUUID(), idempotencyKey: projectionKey,
      gatewayId: row.gateway_id, gatewayProfileId: row.gateway_profile_id,
      bindingId: row.binding_id, bindingGeneration: row.binding_generation,
      ...(row.worker_id && row.worker_session_generation !== null ? { workerId: row.worker_id, workerSessionGeneration: row.worker_session_generation } : {}),
      targetRole: "operation_result", rootMessageId, kind: "card_reply", payload: JSON.stringify(card),
      projectionKey, snapshotRevision: 1, viewVersion: 1, laneKeyOverride: projectionKey,
      ...(row.scope_kind === "global" ? { globalDelivery: true as const } : {})
    });
    const linked = this.context.database.prepare(`UPDATE outbox_lane_quarantines SET review_reply_id=?,review_requested_at=?,updated_at=?
      WHERE failed_reply_id=? AND state='active' AND phase='conflict_isolated' AND review_reply_id IS NULL`).run(
      receipt.result.id, at, at, row.id
    );
    if (linked.changes !== 1) throw new Error(`Delivery quarantine review changed for ${row.id}`);
  }

  private retireObsoleteQuarantinedRingHead(replyId: string, at: string): string | null {
    const approvedExpiredPrimaryTarget = `(
      head.scope_kind='pane' AND head.delivery_owner_kind='primary'
      AND head.state='dead_letter' AND head.failure_class='permanent' AND head.effect_certainty='rejected'
      AND head.lark_error_code IN ('200750','230031')
      AND head.claim_attempt_id IS NULL AND head.claimed_owner_id IS NULL AND head.claimed_fence IS NULL
      AND head.claimed_at IS NULL AND head.claim_expires_at IS NULL
      AND head.card_id_checkpoint IS NULL AND head.gateway_checkpoint_json IS NULL AND head.delivered_message_id IS NULL
      AND EXISTS (
        SELECT 1 FROM outbox_lane_quarantines active_quarantine
        WHERE active_quarantine.failed_reply_id=head.id AND active_quarantine.state='active'
          AND active_quarantine.failure_class='permanent'
      )
      AND EXISTS (
        SELECT 1 FROM bindings expired_owner
        WHERE expired_owner.id=head.delivery_owner_id
          AND expired_owner.generation=head.delivery_owner_generation
          AND expired_owner.session_epoch=head.delivery_owner_session_generation
          AND expired_owner.workspace_id=head.scope_workspace_id AND expired_owner.pane_id=head.scope_pane_id
          AND ((expired_owner.state='archived' AND expired_owner.lifecycle IN ('archived','closed'))
            OR (expired_owner.state='orphaned' AND expired_owner.lifecycle='active' AND expired_owner.attachment='orphaned'))
      )
    )`;
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const row = this.context.database.prepare(`SELECT head.id,head.scope_key,head.lane_key,head.snapshot_revision,
          head.failure_class,head.http_status,head.lark_error_code,head.error
        FROM outbound_replies head
        WHERE head.id=? AND head.scope_key IS NOT NULL
          AND ${approvedExpiredPrimaryTarget}
          AND NOT EXISTS (
            SELECT 1 FROM outbound_replies older
            WHERE older.scope_key=head.scope_key AND older.delivery_order<head.delivery_order
              AND ${nonterminalReplySql("older")}
          )
          AND NOT EXISTS (
            SELECT 1 FROM delivery_recoveries settled
            WHERE settled.failed_reply_id=head.id AND settled.state IN ('recovered','dismissed')
          )`).get(replyId) as {
        id: string; scope_key: string; lane_key: string; snapshot_revision: number;
        failure_class: string | null; http_status: number | null; lark_error_code: string | null; error: string | null;
      } | undefined;
      if (!row) return null;

      const dismissed = this.context.database.prepare(`UPDATE outbound_replies AS head SET
          state='dismissed',error='Retired stale quarantined Ring head after durable owner/target invalidation',updated_at=?
        WHERE head.id=? AND head.scope_key IS NOT NULL
          AND ${approvedExpiredPrimaryTarget}`).run(at, row.id);
      if (dismissed.changes !== 1) return null;

      this.context.database.prepare(`UPDATE delivery_recoveries SET state='unresolved',replacement_reply_id=NULL,
        resolved_by_reply_id=NULL,resolved_message_id=NULL,resolved_at=NULL,updated_at=?
        WHERE replacement_reply_id=? AND state='replacement_pending'`).run(at, row.id);
      const recovery = this.context.database.prepare(`INSERT INTO delivery_recoveries(
          failed_reply_id,snapshot_revision,state,failure_class,http_status,lark_error_code,reason,action,
          semantic_recovery_proof,replacement_reply_id,resolved_by_reply_id,resolved_message_id,created_at,updated_at,resolved_at)
        VALUES(?,?,'dismissed',?,?,?,?, 'ring_stale_target_retired',NULL,NULL,NULL,NULL,?,?,?)
        ON CONFLICT(failed_reply_id) DO UPDATE SET state='dismissed',action='ring_stale_target_retired',
          replacement_reply_id=NULL,resolved_by_reply_id=NULL,resolved_message_id=NULL,resolved_at=excluded.resolved_at,
          updated_at=excluded.updated_at
        WHERE delivery_recoveries.state IN ('unresolved','replacement_pending')`).run(
        row.id, Number(row.snapshot_revision), row.failure_class ?? "permanent", row.http_status, row.lark_error_code,
        (row.error ?? "Stale quarantined Ring target").slice(0, 500), at, at, at
      );
      if (recovery.changes !== 1) throw new Error(`Failed to settle stale quarantined Ring head ${row.id}`);
      const released = this.context.database.prepare(`UPDATE outbox_lane_quarantines SET
        state='released',action='ring_stale_target_retired',released_at=?,updated_at=?
        WHERE failed_reply_id=? AND state='active'`).run(at, at, row.id);
      if (released.changes !== 1) throw new Error(`Failed to release stale quarantined Ring head ${row.id}`);
      this.queue.notifyScopeMutation(row.lane_key);
      return row.scope_key;
    });
  }

  private retireOrphanedRejectedRingHead(replyId: string, at: string): string | null {
    return this.context.transaction("sqlite.prepared-delivery-store.ring-maintenance.orphaned-rejected-head", () => {
      const row = this.context.database.prepare(`SELECT head.id,head.scope_key,head.scope_workspace_id,head.scope_pane_id,head.lane_key
        FROM outbound_replies head
        JOIN delivery_recoveries recovery ON recovery.failed_reply_id=head.id AND recovery.state='unresolved'
        JOIN bindings owner ON owner.id=head.delivery_owner_id AND owner.generation=head.delivery_owner_generation
          AND owner.session_epoch=head.delivery_owner_session_generation
        WHERE head.id=? AND head.scope_kind='pane' AND head.state='dead_letter'
          AND head.failure_class='permanent' AND head.effect_certainty='rejected'
          AND head.claim_attempt_id IS NULL AND head.claimed_owner_id IS NULL AND head.claimed_fence IS NULL
          AND head.claimed_at IS NULL AND head.claim_expires_at IS NULL
          AND head.delivered_message_id IS NULL AND head.card_id_checkpoint IS NULL AND head.gateway_checkpoint_json IS NULL
          AND (owner.attachment='orphaned' OR owner.lifecycle IN ('archived','closed') OR owner.state='archived')
          AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines active WHERE active.failed_reply_id=head.id AND active.state='active')
          AND NOT EXISTS (SELECT 1 FROM outbound_reply_prerequisites prerequisite
            WHERE prerequisite.dependent_reply_id=head.id OR prerequisite.prerequisite_reply_id=head.id)`).get(replyId) as {
              id:string; scope_key:string; scope_workspace_id:string; scope_pane_id:string; lane_key:string;
            } | undefined;
      if (!row) return null;
      const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET
          state='dismissed',error='Retired stale rejected delivery after owner invalidation',updated_at=?
        WHERE id=? AND state='dead_letter' AND effect_certainty='rejected'
          AND claim_attempt_id IS NULL AND claimed_owner_id IS NULL AND claimed_fence IS NULL
          AND claimed_at IS NULL AND claim_expires_at IS NULL
          AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL`).run(at, row.id);
      if (dismissed.changes !== 1) return null;
      const recovery = this.context.database.prepare(`UPDATE delivery_recoveries SET
          state='dismissed',action='stale_orphan_retired',resolved_at=?,updated_at=?
        WHERE failed_reply_id=? AND state='unresolved'`).run(at, at, row.id);
      if (recovery.changes !== 1) throw new Error(`Failed to retire orphaned rejected delivery ${row.id}`);
      this.advanceCheckpointAfterTerminalTransition({ kind: "pane", workspaceId: row.scope_workspace_id, paneId: row.scope_pane_id }, at);
      this.queue.notifyScopeMutation(row.lane_key);
      return row.scope_key;
    });
  }

  private dismissRejectedAfterAttemptBudget(replyId: string, at: string): string | null {
    return this.context.transaction("sqlite.prepared-delivery-store.ring-maintenance.rejected-attempt-budget", () => {
      const row = this.context.database.prepare(`SELECT head.id,head.scope_key,head.scope_workspace_id,head.scope_pane_id,head.lane_key,
          quarantine.review_reply_id
        FROM outbound_replies head
        LEFT JOIN outbox_lane_quarantines quarantine ON quarantine.failed_reply_id=head.id AND quarantine.state='active'
        WHERE head.id=? AND head.state='dead_letter' AND head.failure_class IN ('permanent','transient')
          AND head.effect_certainty IN ('rejected','not-started') AND head.attempt_count>=3
          AND head.claim_attempt_id IS NULL AND head.claimed_owner_id IS NULL AND head.claimed_fence IS NULL
          AND head.claimed_at IS NULL AND head.claim_expires_at IS NULL
          AND head.delivered_message_id IS NULL AND head.card_id_checkpoint IS NULL AND head.gateway_checkpoint_json IS NULL
          AND (head.projection_key IS NULL OR head.projection_key NOT LIKE 'delivery-quarantine-review:%')
          AND NOT EXISTS (SELECT 1 FROM outbound_reply_prerequisites prerequisite
            WHERE prerequisite.dependent_reply_id=head.id OR prerequisite.prerequisite_reply_id=head.id)`).get(replyId) as {
              id:string; scope_key:string; scope_workspace_id:string; scope_pane_id:string; lane_key:string; review_reply_id:string|null;
            } | undefined;
      if (!row) return null;
      const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET
          state='dismissed',error='Dismissed rejected delivery after bounded attempt budget',updated_at=?
        WHERE id=? AND state='dead_letter' AND effect_certainty IN ('rejected','not-started') AND attempt_count>=3
          AND claim_attempt_id IS NULL AND claimed_owner_id IS NULL AND claimed_fence IS NULL
          AND claimed_at IS NULL AND claim_expires_at IS NULL
          AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL`).run(at, row.id);
      if (dismissed.changes !== 1) return null;
      this.context.database.prepare(`UPDATE delivery_recoveries SET state='dismissed',action='dismiss_rejected_attempt_budget',resolved_at=?,updated_at=?
        WHERE failed_reply_id=? AND state IN ('unresolved','replacement_pending')`).run(at, at, row.id);
      if (row.review_reply_id) {
        const review = this.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',error='Dismissed review for bounded rejected delivery',updated_at=?
          WHERE id=? AND state='pending' AND claim_attempt_id IS NULL AND delivered_message_id IS NULL
            AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL`).run(at, row.review_reply_id);
        if (review.changes === 1) {
          this.context.database.prepare(`UPDATE delivery_recoveries SET state='dismissed',action='dismiss_rejected_attempt_budget',resolved_at=?,updated_at=?
            WHERE failed_reply_id=? AND state IN ('unresolved','replacement_pending')`).run(at, at, row.review_reply_id);
        }
      }
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state='released',action='dismiss_rejected_attempt_budget',released_at=?,updated_at=?
        WHERE failed_reply_id=? AND state='active'`).run(at, at, row.id);
      this.advanceCheckpointAfterTerminalTransition({ kind: "pane", workspaceId: row.scope_workspace_id, paneId: row.scope_pane_id }, at);
      this.queue.notifyScopeMutation(row.lane_key);
      return row.scope_key;
    });
  }

  advanceSupersededHead(input: { delivery: PreparedDelivery; at: string }): PreparedDeliveryHeadAdvance {
    const scopeKey = deliveryScopeKey(input.delivery.scope);
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const row = this.context.database.prepare(`SELECT
          head.id AS head_id,head.lane_key,head.failure_class,head.http_status,head.lark_error_code,head.error,
          head.snapshot_revision AS head_revision,head.effect_certainty,head.auto_recovery_count,head.kind,
          head.idempotency_key,head.projection_key,replacement.id AS replacement_id
        FROM outbound_replies head
        JOIN outbound_replies replacement ON replacement.scope_key=head.scope_key
          AND replacement.state='pending'
          AND replacement.claim_attempt_id IS NULL
          AND replacement.gateway_plan_json IS NOT NULL AND replacement.gateway_plan_hash IS NOT NULL
          AND replacement.delivery_order>head.delivery_order
          AND replacement.snapshot_revision>head.snapshot_revision
          AND ${exactReplaceableCardTargetSql("head", "replacement")}
          AND replacement.projection_key IS head.projection_key
        WHERE head.id=? AND head.scope_key=? AND head.delivery_order=?
          AND head.gateway_plan_hash=? AND head.snapshot_revision=?
          AND head.kind='card_update'
          AND head.state IN ('pending','dead_letter') AND head.claim_attempt_id IS NULL
          AND head.claimed_owner_id IS NULL AND head.claimed_fence IS NULL AND head.claimed_at IS NULL
          AND head.card_id_checkpoint IS NULL AND head.gateway_checkpoint_json IS NULL AND head.delivered_message_id IS NULL
          AND head.effect_certainty IN ('not-started','rejected')
          AND head.auto_recovery_count=0
          AND (head.scope_kind='global'
            OR (head.delivery_owner_kind='primary' AND ${currentPrimaryOwnerSql("head")})
            OR (head.delivery_owner_kind='worker' AND ${currentWorkerOwnerSql("head")}))
          AND (head.state!='dead_letter' OR EXISTS (
            SELECT 1 FROM delivery_recoveries recovery WHERE recovery.failed_reply_id=head.id
              AND recovery.state IN ('unresolved','replacement_pending')
          ))
          AND NOT EXISTS (
            SELECT 1 FROM outbound_replies older
            WHERE older.scope_key=head.scope_key AND older.delivery_order<head.delivery_order
              AND ${nonterminalReplySql("older")}
          )
          AND NOT EXISTS (
            SELECT 1 FROM outbox_lane_quarantines quarantine
            WHERE quarantine.lane_key=head.lane_key AND quarantine.state='active'
              AND (quarantine.failed_reply_id!=head.id OR head.projection_key LIKE 'human-review:%')
          )
          AND NOT EXISTS (
            SELECT 1 FROM answer_pages page
            WHERE head.card_role='answer' AND page.prompt_id=head.prompt_id
              AND page.page_index=head.stream_page_index AND page.message_id=head.root_message_id AND page.state='frozen'
          )
        ORDER BY replacement.snapshot_revision DESC,replacement.delivery_order DESC LIMIT 1`).get(
        input.delivery.replyId, scopeKey, input.delivery.deliveryOrder, input.delivery.planHash, input.delivery.snapshotRevision
      ) as { head_id: string; lane_key: string; failure_class: string | null; http_status: number | null; lark_error_code: string | null; error: string | null; head_revision: number; effect_certainty: "not-started" | "rejected"; auto_recovery_count: number; kind: "card_update"; idempotency_key: string; projection_key: string | null; replacement_id: string } | undefined;
      if (!row) return { outcome: "blocked" };
      if (!isReplaySafeSupersession({
        effectCertainty: row.effect_certainty,
        autoRecoveryCount: row.auto_recovery_count,
        kind: row.kind,
        idempotencyKey: row.idempotency_key,
        projectionKey: row.projection_key,
        reconstructible: true,
        targetFrozen: false,
        providerOperationSafe: true,
        ownerCurrent: true,
        hasExternalEffectEvidence: false,
      })) return { outcome: "blocked" };

      transferDeliveryPrerequisites(this.context, row.head_id, row.replacement_id);

      const dismissed = this.context.database.prepare(`UPDATE outbound_replies AS head SET
          state='dismissed',error='Superseded by a newer prepared Card snapshot after confirmed non-application',
          auto_recovery_count=1,
          claim_attempt_id=NULL,claimed_owner_id=NULL,claimed_fence=NULL,claimed_at=NULL,claim_expires_at=NULL,updated_at=?
        WHERE id=? AND scope_key=? AND delivery_order=? AND gateway_plan_hash=? AND snapshot_revision=?
          AND kind='card_update' AND state IN ('pending','dead_letter')
          AND claim_attempt_id IS NULL AND claimed_owner_id IS NULL AND claimed_fence IS NULL AND claimed_at IS NULL
          AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL AND delivered_message_id IS NULL
          AND effect_certainty IN ('not-started','rejected')
          AND auto_recovery_count=0
          AND (head.scope_kind='global'
            OR (head.delivery_owner_kind='primary' AND ${currentPrimaryOwnerSql("head")})
            OR (head.delivery_owner_kind='worker' AND ${currentWorkerOwnerSql("head")}))
          AND NOT EXISTS (
            SELECT 1 FROM outbound_replies older
            WHERE older.scope_key=head.scope_key AND older.delivery_order<head.delivery_order
              AND ${nonterminalReplySql("older")}
          )`).run(input.at, row.head_id, scopeKey, input.delivery.deliveryOrder, input.delivery.planHash, input.delivery.snapshotRevision);
      if (dismissed.changes !== 1) throw new Error(`Safe supersession target changed for ${row.head_id}`);

      const recovery = this.context.database.prepare(`INSERT INTO delivery_recoveries(
          failed_reply_id,snapshot_revision,state,failure_class,http_status,lark_error_code,reason,action,
          semantic_recovery_proof,replacement_reply_id,created_at,updated_at)
        VALUES(?,?,'replacement_pending',?,?,?,?, 'released_newer_snapshot',NULL,?,?,?)
        ON CONFLICT(failed_reply_id) DO UPDATE SET state='replacement_pending',action='released_newer_snapshot',
          replacement_reply_id=excluded.replacement_reply_id,resolved_by_reply_id=NULL,resolved_message_id=NULL,
          resolved_at=NULL,updated_at=excluded.updated_at
        WHERE delivery_recoveries.state IN ('unresolved','replacement_pending')`).run(
        row.head_id, Number(row.head_revision), row.failure_class ?? "transient", row.http_status, row.lark_error_code,
        (row.error ?? "Confirmed non-application").slice(0, 500), row.replacement_id, input.at, input.at
      );
      if (recovery.changes !== 1) throw new Error(`Failed to persist safe supersession for ${row.head_id}`);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state='released',action='released_newer_snapshot',
        released_at=?,updated_at=? WHERE lane_key=? AND failed_reply_id=? AND state='active'`).run(input.at, input.at, row.lane_key, row.head_id);
      this.advanceCheckpointAfterTerminalTransition(input.delivery.scope, input.at);
      this.queue.notifyScopeMutation(row.lane_key);
      return { outcome: "advanced", scopeKey, replacementReplyId: row.replacement_id };
    });
  }

  claimPreparedDelivery(input: { delivery: PreparedDelivery; at: string; expiresAt: string }): PreparedDeliveryClaim | null {
    if (input.delivery.projectionKey?.startsWith("turn-card:")) return this.claimConversationPageDelivery(input);
    if (input.delivery.scope.kind === "global") return this.context.transaction("sqlite.prepared-delivery-store.write", () => this.claimGlobalDelivery(input));
    if (input.delivery.ownerFence?.kind === "worker") return this.context.transaction("sqlite.prepared-delivery-store.write", () => this.claimWorkerDelivery(input));
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => this.claimGenericPrimaryDelivery(input));
  }

  private claimGlobalDelivery(input: { delivery: PreparedDelivery; at: string; expiresAt: string }): PreparedDeliveryClaim | null {
    const { delivery } = input;
    if (delivery.scope.kind !== "global" || delivery.ownerFence !== null || delivery.parentPaneId !== null) return null;
    const attemptId = randomUUID();
    const row = this.context.database.prepare(`UPDATE outbound_replies AS claimed SET
        claim_attempt_id=?,claimed_owner_id=(SELECT owner_id FROM temp.bridge_write_fence LIMIT 1),
        claimed_fence=(SELECT fencing_token FROM temp.bridge_write_fence LIMIT 1),claimed_at=?,claim_expires_at=?,
        first_claimed_at=COALESCE(first_claimed_at,?),payload_hash=gateway_plan_hash
      WHERE id=? AND state='pending' AND next_attempt_at<=? AND claim_attempt_id IS NULL
        AND scope_kind='global' AND scope_key=? AND scope_workspace_id IS NULL AND scope_pane_id IS NULL
        AND delivery_owner_kind IS NULL AND delivery_owner_id IS NULL AND delivery_owner_generation IS NULL
        AND delivery_owner_session_generation IS NULL AND delivery_parent_id IS NULL
        AND delivery_parent_generation IS NULL AND delivery_parent_session_generation IS NULL AND delivery_parent_pane_id IS NULL
        AND gateway_id=? AND gateway_profile_id=? AND gateway_plan_hash=? AND snapshot_revision=? AND renderer_revision=?
        AND ${currentGlobalTargetSql("claimed")}
        AND ${claimConflictEligibilitySql("claimed")}
        AND NOT EXISTS (SELECT 1 FROM outbound_reply_prerequisites prerequisite
          LEFT JOIN outbound_replies required ON required.id=prerequisite.prerequisite_reply_id
          WHERE prerequisite.dependent_reply_id=claimed.id AND (required.id IS NULL OR required.state!=prerequisite.required_state))
        AND NOT EXISTS (SELECT 1 FROM lark_delivery_cooldowns cooldown WHERE cooldown.scope='app' AND cooldown.blocked_until>?)
        AND EXISTS (SELECT 1 FROM instance_lease lease JOIN temp.bridge_write_fence fence
          WHERE lease.singleton_id=1 AND lease.owner_id=fence.owner_id AND lease.fencing_token=fence.fencing_token AND lease.expires_at_ms>?)
      RETURNING id AS reply_id,claim_attempt_id,claimed_owner_id,claimed_fence,gateway_plan_hash,snapshot_revision`).get(
      attemptId, input.at, input.expiresAt, input.at,
      delivery.replyId, input.at, deliveryScopeKey(delivery.scope),
      delivery.gatewayId, delivery.gatewayProfileId, delivery.planHash, delivery.snapshotRevision, delivery.rendererRevision,
      input.at, parseLeaseTimestampMs(input.at, "delivery claim time")
    ) as { reply_id: string; claim_attempt_id: string; claimed_owner_id: string; claimed_fence: number; gateway_plan_hash: string; snapshot_revision: number } | undefined;
    if (!row) {
      this.dismissStaleGlobalDelivery(input);
      return null;
    }
    return Object.freeze({ replyId: row.reply_id, attemptId: row.claim_attempt_id, ownerId: row.claimed_owner_id, fencingToken: Number(row.claimed_fence), planHash: row.gateway_plan_hash, snapshotRevision: Number(row.snapshot_revision) });
  }

  private dismissStaleGlobalDelivery(input: { delivery: PreparedDelivery; at: string }): void {
    const { delivery } = input;
    if (delivery.scope.kind !== "global" || delivery.ownerFence !== null || delivery.parentPaneId !== null) return;
    const dismissed = this.context.database.prepare(`UPDATE outbound_replies AS stale SET
        state='dismissed',error='Dismissed stale Global Ring delivery before Gateway execution',updated_at=?
      WHERE id=? AND state='pending' AND claim_attempt_id IS NULL
        AND scope_kind='global' AND scope_key=? AND gateway_plan_hash=? AND snapshot_revision=? AND renderer_revision=?
        AND effect_certainty IS NOT 'uncertain' AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL
        AND NOT (${currentGlobalTargetSql("stale")})`).run(
      input.at, delivery.replyId, deliveryScopeKey(delivery.scope), delivery.planHash, delivery.snapshotRevision, delivery.rendererRevision
    );
    if (dismissed.changes !== 1) return;
    this.advanceCheckpointAfterTerminalTransition(delivery.scope, input.at);
    const lane = this.context.database.prepare("SELECT lane_key FROM outbound_replies WHERE id=?").get(delivery.replyId) as { lane_key: string } | undefined;
    if (lane) this.queue.notifyScopeMutation(lane.lane_key);
  }

  private claimWorkerDelivery(input: { delivery: PreparedDelivery; at: string; expiresAt: string }): PreparedDeliveryClaim | null {
    const { delivery } = input;
    if (delivery.scope.kind !== "pane" || delivery.ownerFence?.kind !== "worker" || !delivery.ownerFence.parent || !delivery.parentPaneId) return null;
    const owner = delivery.ownerFence;
    const parent = owner.parent!;
    const attemptId = randomUUID();
    const row = this.context.database.prepare(`UPDATE outbound_replies AS claimed SET
        claim_attempt_id=?,claimed_owner_id=(SELECT owner_id FROM temp.bridge_write_fence LIMIT 1),
        claimed_fence=(SELECT fencing_token FROM temp.bridge_write_fence LIMIT 1),claimed_at=?,claim_expires_at=?,
        first_claimed_at=COALESCE(first_claimed_at,?),payload_hash=gateway_plan_hash
      WHERE id=? AND state='pending' AND next_attempt_at<=? AND claim_attempt_id IS NULL
        AND scope_kind='pane' AND scope_key=? AND scope_workspace_id=? AND scope_pane_id=?
        AND delivery_owner_kind='worker' AND delivery_owner_id=? AND delivery_owner_generation=? AND delivery_owner_session_generation=?
        AND delivery_parent_id=? AND delivery_parent_generation=? AND delivery_parent_session_generation=? AND delivery_parent_pane_id=?
        AND gateway_id=? AND gateway_profile_id=? AND gateway_plan_hash=? AND snapshot_revision=? AND renderer_revision=?
        AND ${currentWorkerTargetSql("claimed")}
        AND (${currentRecoveryReplacementSql("claimed")})
        AND ${currentWorkerOwnerSql("claimed")}
        AND ${claimConflictEligibilitySql("claimed")}
        AND NOT EXISTS (SELECT 1 FROM outbound_reply_prerequisites prerequisite
          LEFT JOIN outbound_replies required ON required.id=prerequisite.prerequisite_reply_id
          WHERE prerequisite.dependent_reply_id=claimed.id AND (required.id IS NULL OR required.state!=prerequisite.required_state))
        AND NOT EXISTS (SELECT 1 FROM lark_delivery_cooldowns cooldown WHERE cooldown.scope='app' AND cooldown.blocked_until>?)
        AND EXISTS (SELECT 1 FROM instance_lease lease JOIN temp.bridge_write_fence fence
          WHERE lease.singleton_id=1 AND lease.owner_id=fence.owner_id AND lease.fencing_token=fence.fencing_token AND lease.expires_at_ms>?)
      RETURNING id AS reply_id,claim_attempt_id,claimed_owner_id,claimed_fence,gateway_plan_hash,snapshot_revision`).get(
      attemptId, input.at, input.expiresAt, input.at,
      delivery.replyId, input.at, deliveryScopeKey(delivery.scope), delivery.scope.workspaceId, delivery.scope.paneId,
      owner.id, owner.generation, owner.sessionGeneration,
      parent.id, parent.generation, parent.sessionGeneration, delivery.parentPaneId,
      delivery.gatewayId, delivery.gatewayProfileId, delivery.planHash, delivery.snapshotRevision, delivery.rendererRevision,
      input.at, parseLeaseTimestampMs(input.at, "delivery claim time")
    ) as { reply_id: string; claim_attempt_id: string; claimed_owner_id: string; claimed_fence: number; gateway_plan_hash: string; snapshot_revision: number } | undefined;
    if (!row) {
      this.dismissStaleWorkerDelivery(input);
      return null;
    }
    return Object.freeze({ replyId: row.reply_id, attemptId: row.claim_attempt_id, ownerId: row.claimed_owner_id, fencingToken: Number(row.claimed_fence), planHash: row.gateway_plan_hash, snapshotRevision: Number(row.snapshot_revision) });
  }

  private dismissStaleWorkerDelivery(input: { delivery: PreparedDelivery; at: string }): void {
    const { delivery } = input;
    if (delivery.scope.kind !== "pane" || delivery.ownerFence?.kind !== "worker" || !delivery.ownerFence.parent || !delivery.parentPaneId) return;
    const owner = delivery.ownerFence;
    const parent = owner.parent!;
    const staleTarget = `(NOT (${currentWorkerOwnerSql("stale")}) OR NOT (${currentWorkerTargetSql("stale")}) OR NOT (${currentRecoveryReplacementSql("stale")}))`;
    const dismissed = this.context.database.prepare(`UPDATE outbound_replies AS stale SET
        state='dismissed',error='Dismissed stale Worker Ring delivery before Gateway execution',updated_at=?
      WHERE id=? AND state='pending' AND claim_attempt_id IS NULL
        AND scope_kind='pane' AND scope_key=? AND scope_workspace_id=? AND scope_pane_id=?
        AND delivery_owner_kind='worker' AND delivery_owner_id=? AND delivery_owner_generation=? AND delivery_owner_session_generation=?
        AND delivery_parent_id=? AND delivery_parent_generation=? AND delivery_parent_session_generation=? AND delivery_parent_pane_id=?
        AND gateway_id=? AND gateway_profile_id=? AND gateway_plan_hash=? AND snapshot_revision=? AND renderer_revision=?
        AND effect_certainty IS NOT 'uncertain' AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL
        AND ${staleTarget}`).run(
      input.at, delivery.replyId, deliveryScopeKey(delivery.scope), delivery.scope.workspaceId, delivery.scope.paneId,
      owner.id, owner.generation, owner.sessionGeneration,
      parent.id, parent.generation, parent.sessionGeneration, delivery.parentPaneId,
      delivery.gatewayId, delivery.gatewayProfileId, delivery.planHash, delivery.snapshotRevision, delivery.rendererRevision
    );
    if (dismissed.changes !== 1) return;
    this.context.database.prepare(`UPDATE delivery_recoveries SET state='unresolved',replacement_reply_id=NULL,
      resolved_by_reply_id=NULL,resolved_message_id=NULL,resolved_at=NULL,updated_at=?
      WHERE replacement_reply_id=? AND state='replacement_pending'`).run(input.at, delivery.replyId);
    this.advanceCheckpointAfterTerminalTransition(delivery.scope, input.at);
    const lane = this.context.database.prepare("SELECT lane_key FROM outbound_replies WHERE id=?").get(delivery.replyId) as { lane_key: string } | undefined;
    if (lane) this.queue.notifyScopeMutation(lane.lane_key);
  }

  private claimGenericPrimaryDelivery(input: { delivery: PreparedDelivery; at: string; expiresAt: string }): PreparedDeliveryClaim | null {
    const { delivery } = input;
    if (delivery.scope.kind !== "pane" || delivery.ownerFence?.kind !== "primary" || delivery.ownerFence.parent || delivery.parentPaneId !== null) return null;
    const attemptId = randomUUID();
    const row = this.context.database.prepare(`UPDATE outbound_replies AS claimed SET
        claim_attempt_id=?,claimed_owner_id=(SELECT owner_id FROM temp.bridge_write_fence LIMIT 1),
        claimed_fence=(SELECT fencing_token FROM temp.bridge_write_fence LIMIT 1),claimed_at=?,claim_expires_at=?,
        first_claimed_at=COALESCE(first_claimed_at,?),payload_hash=gateway_plan_hash
      WHERE id=? AND state='pending' AND next_attempt_at<=? AND claim_attempt_id IS NULL
        AND scope_kind='pane' AND scope_key=? AND scope_workspace_id=? AND scope_pane_id=?
        AND delivery_owner_kind='primary' AND delivery_owner_id=? AND delivery_owner_generation=? AND delivery_owner_session_generation=?
        AND delivery_parent_id IS NULL AND delivery_parent_generation IS NULL AND delivery_parent_session_generation IS NULL AND delivery_parent_pane_id IS NULL
        AND gateway_id=? AND gateway_profile_id=? AND gateway_plan_hash=? AND snapshot_revision=? AND renderer_revision=?
        AND binding_id=?
        AND ${currentPrimaryTargetSql("claimed")}
        AND (${currentRecoveryReplacementSql("claimed")})
        AND ${currentPrimaryOwnerSql("claimed")}
        AND ${claimConflictEligibilitySql("claimed")}
        AND NOT EXISTS (
          SELECT 1 FROM outbound_reply_prerequisites prerequisite
          LEFT JOIN outbound_replies required ON required.id=prerequisite.prerequisite_reply_id
          WHERE prerequisite.dependent_reply_id=claimed.id AND (required.id IS NULL OR required.state!=prerequisite.required_state)
        )
        AND NOT EXISTS (SELECT 1 FROM lark_delivery_cooldowns cooldown WHERE cooldown.scope='app' AND cooldown.blocked_until>?)
        AND EXISTS (
          SELECT 1 FROM instance_lease lease JOIN temp.bridge_write_fence fence
          WHERE lease.singleton_id=1 AND lease.owner_id=fence.owner_id AND lease.fencing_token=fence.fencing_token AND lease.expires_at_ms>?
        )
      RETURNING id AS reply_id,claim_attempt_id,claimed_owner_id,claimed_fence,gateway_plan_hash,snapshot_revision`).get(
      attemptId, input.at, input.expiresAt, input.at,
      delivery.replyId, input.at, deliveryScopeKey(delivery.scope), delivery.scope.workspaceId, delivery.scope.paneId,
      delivery.ownerFence.id, delivery.ownerFence.generation, delivery.ownerFence.sessionGeneration,
      delivery.gatewayId, delivery.gatewayProfileId, delivery.planHash, delivery.snapshotRevision, delivery.rendererRevision,
      delivery.ownerFence.id, input.at, parseLeaseTimestampMs(input.at, "delivery claim time")
    ) as { reply_id: string; claim_attempt_id: string; claimed_owner_id: string; claimed_fence: number; gateway_plan_hash: string; snapshot_revision: number } | undefined;
    if (!row) {
      this.dismissStaleGenericPrimaryDelivery(input);
      return null;
    }
    return Object.freeze({
      replyId: row.reply_id, attemptId: row.claim_attempt_id, ownerId: row.claimed_owner_id,
      fencingToken: Number(row.claimed_fence), planHash: row.gateway_plan_hash, snapshotRevision: Number(row.snapshot_revision)
    });
  }

  private dismissStaleGenericPrimaryDelivery(input: { delivery: PreparedDelivery; at: string }): void {
    const { delivery } = input;
    if (delivery.scope.kind !== "pane" || delivery.ownerFence?.kind !== "primary" || delivery.ownerFence.parent || delivery.parentPaneId !== null) return;
    const staleTarget = `(
      NOT (${currentPrimaryOwnerSql("stale")}) OR NOT (${currentPrimaryTargetSql("stale")}) OR NOT (${currentRecoveryReplacementSql("stale")})
    )`;
    const dismissed = this.context.database.prepare(`UPDATE outbound_replies AS stale SET
        state='dismissed',error='Dismissed stale Ring delivery before Gateway execution',updated_at=?
      WHERE id=? AND state='pending' AND claim_attempt_id IS NULL
        AND scope_kind='pane' AND scope_key=? AND scope_workspace_id=? AND scope_pane_id=?
        AND delivery_owner_kind='primary' AND delivery_owner_id=? AND delivery_owner_generation=? AND delivery_owner_session_generation=?
        AND delivery_parent_id IS NULL AND delivery_parent_generation IS NULL AND delivery_parent_session_generation IS NULL AND delivery_parent_pane_id IS NULL
        AND gateway_id=? AND gateway_profile_id=? AND gateway_plan_hash=? AND snapshot_revision=? AND renderer_revision=?
        AND effect_certainty IS NOT 'uncertain' AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL
        AND ${staleTarget}`).run(
      input.at, delivery.replyId, deliveryScopeKey(delivery.scope), delivery.scope.workspaceId, delivery.scope.paneId,
      delivery.ownerFence.id, delivery.ownerFence.generation, delivery.ownerFence.sessionGeneration,
      delivery.gatewayId, delivery.gatewayProfileId, delivery.planHash, delivery.snapshotRevision, delivery.rendererRevision
    );
    if (dismissed.changes !== 1) return;
    this.context.database.prepare(`UPDATE delivery_recoveries SET state='unresolved',replacement_reply_id=NULL,
      resolved_by_reply_id=NULL,resolved_message_id=NULL,resolved_at=NULL,updated_at=?
      WHERE replacement_reply_id=? AND state='replacement_pending'`).run(input.at, delivery.replyId);
    this.advanceCheckpointAfterTerminalTransition(delivery.scope, input.at);
    const lane = this.context.database.prepare("SELECT lane_key FROM outbound_replies WHERE id=?").get(delivery.replyId) as { lane_key: string } | undefined;
    if (lane) this.queue.notifyScopeMutation(lane.lane_key);
  }

  renewPreparedDeliveryClaim(input: { claim: PreparedDeliveryClaim; at: string; expiresAt: string }): boolean {
    const { claim } = input;
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => this.context.database.prepare(`UPDATE outbound_replies SET claim_expires_at=?
      WHERE id=? AND state='pending' AND claim_attempt_id=? AND claimed_owner_id=? AND claimed_fence=?
        AND payload_hash=? AND gateway_plan_hash=? AND snapshot_revision=?
        AND EXISTS (SELECT 1 FROM instance_lease lease
          WHERE lease.singleton_id=1 AND lease.owner_id=? AND lease.fencing_token=? AND lease.expires_at_ms>?)`).run(
      input.expiresAt, claim.replyId, claim.attemptId, claim.ownerId, claim.fencingToken,
      claim.planHash, claim.planHash, claim.snapshotRevision,
      claim.ownerId, claim.fencingToken, parseLeaseTimestampMs(input.at, "delivery claim renewal time")
    ).changes === 1);
  }

  checkpointPreparedDelivery(claim: PreparedDeliveryClaim, checkpoint: PreparedDeliveryCheckpoint): boolean {
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const row = this.claimedReply(claim);
      if (!row) return false;
      if (row.projectionKey?.startsWith("turn-card:")) return this.checkpointConversationPageDeliveryMutation(claim, checkpoint);
      return this.delivery.checkpointCard(claim.replyId, checkpoint.ref.opaqueId, this.outboundClaim(row, claim)) !== null;
    });
  }

  acknowledgePreparedDelivery(claim: PreparedDeliveryClaim, ack: PreparedDeliveryAck): boolean {
    const delivered = this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const row = this.claimedReply(claim);
      if (!row) return false;
      if (row.projectionKey?.startsWith("turn-card:")) return this.acknowledgeConversationPageDeliverySettlement(claim, ack, row.deliveryScope);
      const delivered = this.delivery.markDelivered(
        claim.replyId,
        ack.messageId,
        ack.surfaceId ?? undefined,
        this.outboundClaim(row, claim),
        ack.threadId ?? undefined,
        ack.messageDeleteOutcome
      );
      if (delivered && row.deliveryScope) this.advanceCheckpointAfterTerminalTransition(row.deliveryScope, now());
      return delivered;
    });
    if (delivered) this.observeSettlement(claim, ack, "succeeded");
    return delivered;
  }

  failPreparedDelivery(claim: PreparedDeliveryClaim, failure: PreparedDeliveryFailure): "retry" | "dead_letter" | "stale" {
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const row = this.claimedReply(claim);
      if (!row) return "stale";
      if (row.projectionKey?.startsWith("turn-card:")) return this.failConversationPageDeliveryMutation(claim, failure);
      const retryDelayMs = Math.max(0, Date.parse(failure.retryAt) - Date.now());
      const transition = this.recovery.markOutboundReplyFailedWithQuarantine(
        claim.replyId,
        failure.error,
        failure.metadata,
        retryDelayMs,
        this.outboundClaim(row, claim)
      );
      if (!transition) return "stale";
      if (transition.reply.state === "dead_letter" && transition.reply.kind === "message_delete") {
        this.settleMessageDeletion?.({ outboundReplyId: transition.reply.id, outcome: "failed", detail: failure.error });
      }
      return transition.reply.state === "pending" ? "retry" : "dead_letter";
    });
  }

  private claimedReply(claim: PreparedDeliveryClaim): OutboundReply | null {
    const row = this.context.database.prepare(`SELECT * FROM outbound_replies
      WHERE id=? AND state='pending' AND claim_attempt_id=?
        AND claimed_owner_id=? AND claimed_fence=? AND payload_hash=? AND gateway_plan_hash=? AND snapshot_revision=?
        AND EXISTS (SELECT 1 FROM instance_lease lease WHERE lease.singleton_id=1 AND lease.owner_id=? AND lease.fencing_token=? AND lease.expires_at_ms>?)`).get(
      claim.replyId, claim.attemptId, claim.ownerId, claim.fencingToken, claim.planHash, claim.planHash, claim.snapshotRevision,
      claim.ownerId, claim.fencingToken, parseLeaseTimestampMs(now(), "delivery claim validation time")
    ) as OutboundReplyRow | undefined;
    return row ? mapOutboundReply(row) : null;
  }

  private outboundClaim(reply: OutboundReply, claim: PreparedDeliveryClaim) {
    return Object.freeze({ reply: Object.freeze(reply), attemptId: claim.attemptId, fencingToken: claim.fencingToken, payloadHash: claim.planHash, snapshotRevision: claim.snapshotRevision });
  }

  claimConversationPageDelivery(input: {
    delivery: PreparedDelivery; at: string; expiresAt: string; unclaimedCreateNotBefore?: string;
  }): PreparedDeliveryClaim | null {
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => this.claimConversationPageDeliveryMutation(input));
  }

  private claimConversationPageDeliveryMutation(input: {
    delivery: PreparedDelivery; at: string; expiresAt: string; unclaimedCreateNotBefore?: string;
  }): PreparedDeliveryClaim | null {
    const { delivery } = input;
    if (delivery.scope.kind !== "pane" || !delivery.projectionKey?.startsWith("turn-card:") || !delivery.ownerFence) return null;
    const owner = delivery.ownerFence;
    if (owner.kind === "primary" && owner.parent || owner.kind === "worker" && !owner.parent) return null;
    if (owner.kind === "primary" && delivery.parentPaneId !== null || owner.kind === "worker" && !delivery.parentPaneId) return null;
    const ownerIdentitySql = conversationPageOwnerIdentitySql("claimed", owner.kind);
    const currentOwnerSql = owner.kind === "primary" ? currentPrimaryOwnerSql("claimed") : currentWorkerOwnerSql("claimed");
    const ownerIdentityValues = owner.kind === "primary"
      ? [owner.id, owner.generation, owner.sessionGeneration, owner.id]
      : [owner.id, owner.generation, owner.sessionGeneration, owner.parent!.id, owner.parent!.generation, owner.parent!.sessionGeneration, delivery.parentPaneId!];
    const attemptId = randomUUID();
    const row = this.context.database.prepare(`UPDATE outbound_replies AS claimed SET
        claim_attempt_id=?,claimed_owner_id=(SELECT owner_id FROM temp.bridge_write_fence LIMIT 1),
        claimed_fence=(SELECT fencing_token FROM temp.bridge_write_fence LIMIT 1),claimed_at=?,claim_expires_at=?,
        first_claimed_at=COALESCE(first_claimed_at,?),payload_hash=gateway_plan_hash
      WHERE id=? AND state='pending' AND next_attempt_at<=? AND claim_attempt_id IS NULL
        AND scope_kind='pane' AND scope_key=? AND scope_workspace_id=? AND scope_pane_id=?
        AND ${ownerIdentitySql} AND ${currentOwnerSql}
        AND gateway_id=? AND gateway_profile_id=? AND gateway_plan_hash=? AND snapshot_revision=? AND renderer_revision=?
        AND projection_key=? AND (${currentConversationPageTargetSql("claimed")} OR (
          claimed.kind='card_reply' AND claimed.first_claimed_at IS NULL AND claimed.created_at>=?
          AND claimed.delivered_message_id IS NULL AND claimed.card_id_checkpoint IS NULL AND claimed.gateway_checkpoint_json IS NULL
          AND EXISTS (
            SELECT 1 FROM conversation_segment_pages initial_page
            JOIN conversation_segments initial_segment ON initial_segment.id=initial_page.segment_id
            WHERE initial_page.pending_reply_id=claimed.id AND initial_page.element_id=claimed.projection_key
              AND initial_page.page_index=0 AND initial_page.message_id IS NULL AND initial_page.state IN ('frozen','finished')
              AND initial_page.sequence=claimed.snapshot_revision AND initial_segment.state='closed'
              AND initial_segment.root_message_id=claimed.root_message_id
              AND initial_segment.owner_kind=claimed.delivery_owner_kind
              AND initial_segment.owner_id=claimed.delivery_owner_id
              AND initial_segment.owner_generation=claimed.delivery_owner_generation
          )
        ))
        AND NOT (
          claimed.kind='card_reply' AND claimed.first_claimed_at IS NULL AND claimed.created_at<?
          AND claimed.delivered_message_id IS NULL AND claimed.effect_certainty IS NOT 'uncertain'
          AND claimed.card_id_checkpoint IS NULL AND claimed.gateway_checkpoint_json IS NULL
          AND EXISTS (
            SELECT 1 FROM conversation_segment_pages initial_page
            WHERE initial_page.pending_reply_id=claimed.id AND initial_page.element_id=claimed.projection_key
              AND initial_page.page_index=0 AND initial_page.message_id IS NULL
          )
        )
        AND ${claimConflictEligibilitySql("claimed")}
        AND NOT EXISTS (
          SELECT 1 FROM outbound_reply_prerequisites prerequisite
          LEFT JOIN outbound_replies required ON required.id=prerequisite.prerequisite_reply_id
          WHERE prerequisite.dependent_reply_id=claimed.id AND (required.id IS NULL OR required.state!=prerequisite.required_state)
        )
        AND NOT EXISTS (SELECT 1 FROM lark_delivery_cooldowns cooldown WHERE cooldown.scope='app' AND cooldown.blocked_until>?)
        AND EXISTS (
          SELECT 1 FROM instance_lease lease JOIN temp.bridge_write_fence fence
          WHERE lease.singleton_id=1 AND lease.owner_id=fence.owner_id
            AND lease.fencing_token=fence.fencing_token AND lease.expires_at_ms>?
        )
      RETURNING id AS reply_id,claim_attempt_id,claimed_owner_id,claimed_fence,gateway_plan_hash,snapshot_revision`).get(
      attemptId, input.at, input.expiresAt, input.at,
      delivery.replyId, input.at, deliveryScopeKey(delivery.scope), delivery.scope.workspaceId, delivery.scope.paneId,
      ...ownerIdentityValues,
      delivery.gatewayId, delivery.gatewayProfileId, delivery.planHash, delivery.snapshotRevision, delivery.rendererRevision,
      delivery.projectionKey, input.unclaimedCreateNotBefore ?? "9999-12-31T23:59:59.999Z",
      input.unclaimedCreateNotBefore ?? "0001-01-01T00:00:00.000Z",
      input.at, parseLeaseTimestampMs(input.at, "delivery claim time")
    ) as { reply_id: string; claim_attempt_id: string; claimed_owner_id: string; claimed_fence: number; gateway_plan_hash: string; snapshot_revision: number } | undefined;
    if (!row) {
      this.retireStaleConversationPageDelivery(input, conversationPageOwnerIdentitySql("stale", owner.kind), ownerIdentityValues);
      return null;
    }
    return Object.freeze({
      replyId: row.reply_id, attemptId: row.claim_attempt_id, ownerId: row.claimed_owner_id,
      fencingToken: Number(row.claimed_fence), planHash: row.gateway_plan_hash, snapshotRevision: Number(row.snapshot_revision)
    });
  }

  private retireStaleConversationPageDelivery(
    input: { delivery: PreparedDelivery; at: string; unclaimedCreateNotBefore?: string },
    ownerIdentitySql: string,
    ownerIdentityValues: readonly (string | number)[]
  ): void {
    const { delivery } = input;
    if (delivery.scope.kind !== "pane" || !delivery.projectionKey) return;
    const historicalInitialCreate = this.context.database.prepare(`SELECT EXISTS (
        SELECT 1 FROM outbound_replies historical
        JOIN conversation_segment_pages initial_page ON initial_page.pending_reply_id=historical.id
        WHERE historical.id=? AND historical.kind='card_reply' AND historical.first_claimed_at IS NULL
          AND historical.created_at<? AND historical.delivered_message_id IS NULL
          AND historical.effect_certainty IS NOT 'uncertain'
          AND historical.card_id_checkpoint IS NULL AND historical.gateway_checkpoint_json IS NULL
          AND initial_page.element_id=historical.projection_key
          AND initial_page.page_index=0 AND initial_page.message_id IS NULL
      ) AS matched`).get(
      delivery.replyId, input.unclaimedCreateNotBefore ?? "0001-01-01T00:00:00.000Z"
    ) as { matched: number };
    const currentOwnerSql = delivery.ownerFence?.kind === "primary" ? currentPrimaryOwnerSql("stale") : currentWorkerOwnerSql("stale");
    const dismissed = this.context.database.prepare(`UPDATE outbound_replies AS stale SET
        state='dismissed',error='Dismissed stale Conversation Page delivery before Gateway execution',updated_at=?
      WHERE id=? AND state='pending' AND claim_attempt_id IS NULL
        AND claimed_owner_id IS NULL AND claimed_fence IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL
        AND scope_kind='pane' AND scope_key=? AND scope_workspace_id=? AND scope_pane_id=?
        AND ${ownerIdentitySql}
        AND gateway_id=? AND gateway_profile_id=? AND gateway_plan_hash=? AND snapshot_revision=? AND renderer_revision=?
        AND projection_key=? AND delivered_message_id IS NULL
        AND effect_certainty IS NOT 'uncertain' AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL
        AND ${claimConflictEligibilitySql("stale")}
        AND NOT EXISTS (
          SELECT 1 FROM outbound_reply_prerequisites prerequisite
          LEFT JOIN outbound_replies required ON required.id=prerequisite.prerequisite_reply_id
          WHERE prerequisite.dependent_reply_id=stale.id
            AND (required.id IS NULL OR required.state!=prerequisite.required_state)
        )
        AND NOT EXISTS (
          SELECT 1 FROM lark_delivery_cooldowns cooldown
          WHERE cooldown.scope='app' AND cooldown.blocked_until>?
        )
        AND EXISTS (
          SELECT 1 FROM instance_lease lease JOIN temp.bridge_write_fence fence
          WHERE lease.singleton_id=1 AND lease.owner_id=fence.owner_id
            AND lease.fencing_token=fence.fencing_token AND lease.expires_at_ms>?
        )
        AND (NOT (${currentOwnerSql}) OR NOT (${currentConversationPageTargetSql("stale")}) OR ?=1)
      RETURNING lane_key`).get(
      input.at, delivery.replyId, deliveryScopeKey(delivery.scope), delivery.scope.workspaceId, delivery.scope.paneId,
      ...ownerIdentityValues,
      delivery.gatewayId, delivery.gatewayProfileId, delivery.planHash, delivery.snapshotRevision, delivery.rendererRevision,
      delivery.projectionKey, input.at, parseLeaseTimestampMs(input.at, "stale Conversation Page retirement time"),
      historicalInitialCreate.matched
    ) as { lane_key: string } | undefined;
    if (!dismissed) return;
    this.context.database.prepare(`UPDATE conversation_segment_pages AS page SET
        pending_reply_id=NULL,pending_cursor_json=NULL,
        state=CASE
          WHEN (SELECT segment.state FROM conversation_segments segment WHERE segment.id=page.segment_id)='closed' OR ?=1 THEN 'finished'
          WHEN page.state='frozen' THEN 'frozen'
          WHEN page.message_id IS NULL THEN 'creating'
          ELSE 'active'
        END,
        updated_at=?
      WHERE page.pending_reply_id=? AND page.element_id=?
        AND EXISTS (
          SELECT 1 FROM conversation_segments segment
          WHERE segment.id=page.segment_id
            AND segment.owner_kind=? AND segment.owner_id=? AND segment.owner_generation=?
        )`).run(
      historicalInitialCreate.matched, input.at, delivery.replyId, delivery.projectionKey,
      delivery.ownerFence!.kind, delivery.ownerFence!.id, delivery.ownerFence!.generation
    );
    this.advanceCheckpointAfterTerminalTransition(delivery.scope, input.at);
    this.queue.notifyScopeMutation(dismissed.lane_key);
  }

  checkpointConversationPageDelivery(claim: PreparedDeliveryClaim, checkpoint: PreparedDeliveryCheckpoint): boolean {
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => this.checkpointConversationPageDeliveryMutation(claim, checkpoint));
  }

  private checkpointConversationPageDeliveryMutation(claim: PreparedDeliveryClaim, checkpoint: PreparedDeliveryCheckpoint): boolean {
    const encoded = JSON.stringify({ kind: "surface", gatewayId: checkpoint.ref.gatewayId, opaqueId: checkpoint.ref.opaqueId });
    return this.context.database.prepare(`UPDATE outbound_replies SET
        card_id_checkpoint=COALESCE(card_id_checkpoint,?),gateway_checkpoint_json=COALESCE(gateway_checkpoint_json,?),updated_at=?
      WHERE id=? AND state='pending' AND claim_attempt_id=?
        AND claimed_owner_id=? AND claimed_fence=? AND gateway_plan_hash=? AND snapshot_revision=?
        AND (card_id_checkpoint IS NULL OR card_id_checkpoint=?)
        AND (gateway_checkpoint_json IS NULL OR gateway_checkpoint_json=?)
        AND EXISTS (SELECT 1 FROM instance_lease lease WHERE lease.singleton_id=1 AND lease.owner_id=? AND lease.fencing_token=? AND lease.expires_at_ms>?)`).run(
      checkpoint.ref.opaqueId, encoded, now(), claim.replyId, claim.attemptId, claim.ownerId, claim.fencingToken,
      claim.planHash, claim.snapshotRevision, checkpoint.ref.opaqueId, encoded, claim.ownerId, claim.fencingToken,
      parseLeaseTimestampMs(now(), "delivery checkpoint time")
    ).changes === 1;
  }

  acknowledgeConversationPageDelivery(claim: PreparedDeliveryClaim, ack: PreparedDeliveryAck): boolean {
    const delivered = this.context.transaction("sqlite.prepared-delivery-store.write", () => {
      const row = this.claimedReply(claim);
      if (!row) return false;
      return this.acknowledgeConversationPageDeliverySettlement(claim, ack, row.deliveryScope);
    });
    if (delivered) this.observeSettlement(claim, ack, "succeeded");
    return delivered;
  }

  private observeSettlement(claim: PreparedDeliveryClaim, ack: PreparedDeliveryAck, outcome: "succeeded" | "failed"): void {
    this.deliveryTrace?.mark({
      stage: "settled",
      outcome,
      correlation: { replyId: claim.replyId, attemptId: claim.attemptId, receiptId: ack.surfaceId ?? ack.messageId }
    });
  }

  private acknowledgeConversationPageDeliverySettlement(claim: PreparedDeliveryClaim, ack: PreparedDeliveryAck, scope: DeliveryScope | null): boolean {
    const settledAt = now();
    const semantic = this.context.database.prepare(`SELECT delivery_input_kind,subject_kind,subject_json,subject_revision
      FROM outbound_replies WHERE id=?`).get(claim.replyId) as {
        delivery_input_kind: string | null; subject_kind: string | null; subject_json: string | null; subject_revision: number | null;
      } | undefined;
    const subject = semantic?.delivery_input_kind === "semantic-snapshot"
      && semantic.subject_kind && semantic.subject_json && semantic.subject_revision !== null
      ? decodeDeliverySubject(semantic.subject_kind, semantic.subject_json)
      : null;
    const delivered = this.context.database.prepare(`UPDATE outbound_replies SET state='delivered',delivered_message_id=?,
        card_id_checkpoint=COALESCE(?,card_id_checkpoint),
        gateway_checkpoint_json=CASE WHEN ? IS NULL THEN gateway_checkpoint_json ELSE COALESCE(gateway_checkpoint_json,json_object('kind','surface','gatewayId',gateway_id,'opaqueId',?)) END,
        error=NULL,failure_class=NULL,effect_certainty=NULL,http_status=NULL,lark_error_code=NULL,dead_lettered_at=NULL,
        attempt_count=attempt_count+1,claim_attempt_id=NULL,claimed_owner_id=NULL,claimed_fence=NULL,claimed_at=NULL,claim_expires_at=NULL,updated_at=?
      WHERE id=? AND state='pending' AND claim_attempt_id=? AND claimed_owner_id=? AND claimed_fence=?
        AND gateway_plan_hash=? AND snapshot_revision=?
        AND EXISTS (SELECT 1 FROM instance_lease lease WHERE lease.singleton_id=1 AND lease.owner_id=? AND lease.fencing_token=? AND lease.expires_at_ms>?)`).run(
      ack.messageId, ack.surfaceId, ack.surfaceId, ack.surfaceId, settledAt, claim.replyId, claim.attemptId, claim.ownerId,
      claim.fencingToken, claim.planHash, claim.snapshotRevision, claim.ownerId, claim.fencingToken,
      parseLeaseTimestampMs(settledAt, "delivery acknowledgement time")
    ).changes === 1;
    if (!delivered) return false;

    const target = semantic?.delivery_input_kind === "semantic-snapshot" ? subject : (() => {
      const projectionKey = this.context.database.prepare("SELECT projection_key FROM outbound_replies WHERE id=?").get(claim.replyId) as { projection_key: string | null } | undefined;
      const parsed = projectionKey?.projection_key ? parseTurnCardProjectionKey(projectionKey.projection_key) : null;
      return parsed ? { kind: "conversation-page" as const, ...parsed, revision: claim.snapshotRevision } : null;
    })();
    const settlement = target && settleConversationPageDelivery(this.context, {
      segmentId: target.segmentId, pageIndex: target.pageIndex, replyId: claim.replyId,
      messageId: ack.messageId, cardId: ack.surfaceId
    }, subject ?? undefined);
    if (settlement === "checkpointed") {
      if (ack.messageId) this.context.database.prepare("INSERT OR IGNORE INTO bridge_messages(message_id,created_at) VALUES(?,?)").run(ack.messageId, settledAt);
      confirmDeliveryRecoveries(this.context, claim.replyId);
      new SqliteProjectionGapStore(this.context).compensateDeliveryForReply(claim.replyId, claim.snapshotRevision, settledAt);
    } else if (semantic?.delivery_input_kind === "semantic-snapshot") {
      const ownerId = subject ? `${subject.segmentId}:page:${subject.pageIndex}` : `reply:${claim.replyId}`;
      new SqliteProjectionGapStore(this.context).open({
        stage: "turn_recovery", ownerKind: "turn_card", ownerId, sourceItemId: claim.replyId,
        failureClass: "permanent", failureCode: "semantic_subject_settlement_mismatch",
        requiredVersion: subject?.revision ?? claim.snapshotRevision, occurredAt: settledAt
      });
      this.context.database.prepare(`UPDATE projection_gaps SET details_json=json_object(
        'kind','semantic-subject-settlement','replyId',?,'subjectKind',?,'subjectJson',?,'ackMessageId',?,'ackSurfaceId',?)
        WHERE stage='turn_recovery' AND owner_kind='turn_card' AND owner_id=? AND source_item_id=? AND state='open'`)
        .run(claim.replyId, semantic.subject_kind, semantic.subject_json, ack.messageId, ack.surfaceId, ownerId, claim.replyId);
    }
    if (scope) this.advanceCheckpointAfterTerminalTransition(scope, settledAt);
    return delivered;
  }

  failConversationPageDelivery(claim: PreparedDeliveryClaim, failure: PreparedDeliveryFailure): "retry" | "dead_letter" | "stale" {
    return this.context.transaction("sqlite.prepared-delivery-store.write", () => this.failConversationPageDeliveryMutation(claim, failure));
  }

  private failConversationPageDeliveryMutation(claim: PreparedDeliveryClaim, failure: PreparedDeliveryFailure): "retry" | "dead_letter" | "stale" {
    const timestamp = now();
    const previous = this.context.database.prepare(`SELECT attempt_count,scope_kind,scope_workspace_id,scope_pane_id FROM outbound_replies
      WHERE id=? AND state='pending' AND claim_attempt_id=? AND claimed_owner_id=? AND claimed_fence=?
        AND gateway_plan_hash=? AND snapshot_revision=?
        AND EXISTS (SELECT 1 FROM instance_lease lease WHERE lease.singleton_id=1 AND lease.owner_id=? AND lease.fencing_token=? AND lease.expires_at_ms>?)`).get(
      claim.replyId, claim.attemptId, claim.ownerId, claim.fencingToken, claim.planHash, claim.snapshotRevision,
      claim.ownerId, claim.fencingToken, parseLeaseTimestampMs(timestamp, "delivery failure time")
    ) as {
      attempt_count: number; scope_kind: string; scope_workspace_id: string; scope_pane_id: string;
    } | undefined;
    if (!previous) return "stale";
    const retryTimestampMs = Date.parse(timestamp);
    const retryDecision = planDeliveryRetry({
      previousAttemptCount: Number(previous.attempt_count),
      explicitDelayMs: Math.max(0, Date.parse(failure.retryAt) - retryTimestampMs),
      nowMs: retryTimestampMs
    });
    const certainty = failure.metadata.effectCertainty ?? (failure.metadata.effectCertainty !== "uncertain" ? "not-started" : "uncertain");
    const retry = !retryDecision.exhausted;
    const state = retry ? "pending" : "dismissed";
    const row = this.context.database.prepare(`UPDATE outbound_replies SET state=?,error=?,failure_class=?,effect_certainty=?,http_status=?,lark_error_code=?,
        attempt_count=?,next_attempt_at=?,dead_lettered_at=CASE WHEN ?='dismissed' THEN ? ELSE NULL END,
        claim_attempt_id=NULL,claimed_owner_id=NULL,claimed_fence=NULL,claimed_at=NULL,claim_expires_at=NULL,updated_at=?
      WHERE id=? AND state='pending' AND claim_attempt_id=? AND claimed_owner_id=? AND claimed_fence=?
        AND gateway_plan_hash=? AND snapshot_revision=?
        AND EXISTS (SELECT 1 FROM instance_lease lease WHERE lease.singleton_id=1 AND lease.owner_id=? AND lease.fencing_token=? AND lease.expires_at_ms>?)
      RETURNING lane_key`).get(
      state, failure.error.slice(0, 500), failure.metadata.failureClass, certainty,
      failure.metadata.httpStatus, failure.metadata.larkErrorCode, retryDecision.attemptCount, retryDecision.nextAttemptAt, state, timestamp, timestamp,
      claim.replyId, claim.attemptId, claim.ownerId, claim.fencingToken, claim.planHash, claim.snapshotRevision,
      claim.ownerId, claim.fencingToken, parseLeaseTimestampMs(timestamp, "delivery failure time")
    ) as { lane_key: string } | undefined;
    if (!row) return "stale";
    if (!retry) {
      this.context.database.prepare(`INSERT INTO delivery_recoveries(
          failed_reply_id,snapshot_revision,state,failure_class,http_status,lark_error_code,reason,action,
          semantic_recovery_proof,replacement_reply_id,resolved_by_reply_id,resolved_message_id,created_at,updated_at,resolved_at
        ) VALUES(?,?,'dismissed',?,?,?,?, 'dismiss_attempt_budget',NULL,NULL,NULL,NULL,?,?,?)
        ON CONFLICT(failed_reply_id) DO UPDATE SET
          state='dismissed',failure_class=excluded.failure_class,http_status=excluded.http_status,lark_error_code=excluded.lark_error_code,
          reason=excluded.reason,action='dismiss_attempt_budget',semantic_recovery_proof=NULL,replacement_reply_id=NULL,
          resolved_by_reply_id=NULL,resolved_message_id=NULL,updated_at=excluded.updated_at,resolved_at=excluded.resolved_at
        WHERE delivery_recoveries.state IN ('unresolved','replacement_pending','dismissed')`).run(
        claim.replyId, claim.snapshotRevision, failure.metadata.failureClass, failure.metadata.httpStatus,
        failure.metadata.larkErrorCode, failure.error.slice(0, 500), timestamp, timestamp, timestamp
      );
      this.context.database.prepare(`UPDATE conversation_segment_pages AS page SET
          pending_reply_id=NULL,pending_cursor_json=NULL,
          state=CASE
            WHEN (SELECT segment.state FROM conversation_segments segment WHERE segment.id=page.segment_id)='closed' THEN 'finished'
            WHEN page.state='frozen' THEN 'frozen'
            WHEN page.state='finished' THEN 'finished'
            WHEN page.message_id IS NULL THEN 'finished'
            ELSE 'active'
          END,
          updated_at=?
        WHERE page.pending_reply_id=?`).run(timestamp, claim.replyId);
      this.advanceCheckpointAfterTerminalTransition({ kind: "pane", workspaceId: previous.scope_workspace_id, paneId: previous.scope_pane_id }, timestamp);
      this.queue.notifyScopeMutation(row.lane_key);
      return "dead_letter";
    }
    return retry ? "retry" : "dead_letter";
  }

  explainScopeHeadQuery(): string[] {
    return (this.context.database.prepare(`EXPLAIN QUERY PLAN ${scopePageQuery(false)}`).all(
      null, null, 11, null, null, 11, 11, 10, "2099-01-01T00:00:00.000Z", 10, 10
    ) as Array<{ detail: string }>).map(({ detail }) => detail);
  }

  explainCheckpointBootstrapQuery(scope: DeliveryScope): string[] {
    return (this.context.database.prepare(`EXPLAIN QUERY PLAN SELECT MIN(delivery_order) AS delivery_order FROM outbound_replies INDEXED BY outbound_replies_scope_nonterminal_order
      WHERE scope_key=? AND state IN ('pending','dead_letter') AND ${nonterminalReplySql("outbound_replies")}`).all(deliveryScopeKey(scope)) as Array<{ detail: string }>).map(({ detail }) => detail);
  }

  explainReconstructibleInvalidOwnerQuery(): string[] {
    return (this.context.database.prepare(`EXPLAIN QUERY PLAN ${reconstructibleInvalidPrimaryMainHeadSql(true)}
      ORDER BY head.delivery_order,head.id LIMIT ?`).all(JSON.stringify(['["pane","workspace","pane-a"]']), 64) as Array<{ detail: string }>).map(({ detail }) => detail);
  }

  explainReconstructibleInvalidOwnerScopePageQuery(): string[] {
    return (this.context.database.prepare(`EXPLAIN QUERY PLAN ${reconstructibleInvalidPrimaryMainScopePageSql(true)}`)
      .all('["pane","workspace","pane-a"]', 64) as Array<{ detail: string }>).map(({ detail }) => detail);
  }

  private classifyHeadCandidate(row: HeadCandidateRow, at: string, cooldown: string | null): {
    candidate: HeadCandidateRow;
    head: PreparedDeliveryScopeHead;
  } {
    const base = { replyId: row.id, scopeKey: String(row.scope_key), deliveryOrder: Number(row.delivery_order), nextAttemptAt: row.next_attempt_at };
    const classified = (status: PreparedDeliveryScopeHead["status"]): { candidate: HeadCandidateRow; head: PreparedDeliveryScopeHead } => ({
      candidate: row,
      head: { ...base, status, delivery: null }
    });
    if (row.state === "dead_letter") return classified("dead_letter");
    if (row.claim_attempt_id !== null) return classified("claimed");
    if (Number(row.quarantined)) return classified("quarantined");
    if (Number(row.unmet_prerequisites)) return classified("prerequisite_blocked");
    if (cooldown !== null) return classified("cooldown_blocked");
    if (row.next_attempt_at > at) return classified("future_due");
    return classified("ready");
  }

  private hydrateDeliveryWorkBatch(candidates: readonly HeadCandidateRow[]): Map<string, DeliveryWorkHydration> {
    return this.hydrateCandidateBatch(candidates, hydrateDeliveryWork);
  }

  private hydratePreparedDeliveryBatch(heads: readonly PreparedDeliveryScopeHead[]): Map<string, PreparedDeliveryHydration> {
    const candidates = heads.map((head): HeadCandidateRow => ({
      id: head.replyId,
      scope_key: head.scopeKey,
      delivery_order: head.deliveryOrder,
      state: head.status === "dead_letter" ? "dead_letter" : "pending",
      claim_attempt_id: null,
      next_attempt_at: head.nextAttemptAt,
      quarantined: head.status === "quarantined" ? 1 : 0,
      unmet_prerequisites: 0
    }));
    return this.hydrateCandidateBatch(candidates, hydrate);
  }

  private hydrateCandidateBatch<T extends DeliveryWorkHydration | PreparedDeliveryHydration>(
    candidates: readonly HeadCandidateRow[],
    hydrateRow: (row: SemanticDeliveryRow) => T
  ): Map<string, T> {
    if (candidates.length === 0) return new Map();
    const placeholders = candidates.map(() => "?").join(",");
    const rows = this.context.database.prepare(`SELECT * FROM outbound_replies WHERE id IN (${placeholders})`)
      .all(...candidates.map((candidate) => candidate.id)) as SemanticDeliveryRow[];
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    return new Map(candidates.map((candidate) => {
      const row = rowsById.get(candidate.id);
      if (!row) return [candidate.id, { status: "missing" } as T];
      if (row.scope_key !== candidate.scope_key || Number(row.delivery_order) !== candidate.delivery_order
        || row.state !== candidate.state || row.claim_attempt_id !== candidate.claim_attempt_id
        || row.next_attempt_at !== candidate.next_attempt_at) {
        return [candidate.id, { status: "invalid", reason: "delivery_candidate_changed" } as T];
      }
      return [candidate.id, hydrateRow(row)];
    }));
  }

}

function hydrate(row: OutboundReplyRow): PreparedDeliveryHydration {
  const input = hydrateDeliveryInput(row as SemanticDeliveryRow);
  if (input.status === "invalid" || input.status === "missing") return input;
  if (input.status === "legacy-unprepared") return { status: "unprepared" };
  if (input.status === "prepared-effect") return { status: "prepared", delivery: input.delivery };
  return input.preparedDelivery === null
    ? { status: "unprepared" }
    : { status: "prepared", delivery: input.preparedDelivery };
}

function hydrateDeliveryWork(row: SemanticDeliveryRow): DeliveryWorkHydration {
  const input = hydrateDeliveryInput(row);
  if (input.status === "invalid" || input.status === "missing") return input;
  if (input.status === "legacy-unprepared") return { status: "unprepared" };
  if (input.status === "prepared-effect") return { status: "ready", work: input.delivery };
  if (input.preparedDelivery) return { status: "ready", work: input.preparedDelivery };
  const work = hydrateSemanticDeliveryWork(row, input.input, input.preparationState);
  return work ? { status: "ready", work } : { status: "invalid", reason: "semantic_delivery_metadata_invalid" };
}

function hydrateDeliveryInput(row: SemanticDeliveryRow): DeliveryInputHydration {
  const semanticColumns = [
    row.subject_kind, row.subject_json, row.subject_revision,
    row.presentation_snapshot_json, row.presentation_snapshot_hash,
    row.planner_policy_version, row.renderer_policy_version, row.gateway_profile_version,
    row.preparation_state
  ];
  if (row.delivery_input_kind === null) {
    if (semanticColumns.some((value) => value !== null)) return { status: "invalid", reason: "mixed_delivery_input" };
    const prepared = hydratePreparedEffect(row);
    if (prepared.status === "unprepared") return { status: "legacy-unprepared" };
    if (prepared.status !== "prepared") return prepared;
    return {
      status: "prepared-effect",
      input: Object.freeze({ kind: "prepared-effect", effect: prepared.delivery.preparedPlan }),
      delivery: prepared.delivery
    };
  }
  if (row.delivery_input_kind === "prepared-effect") {
    if (semanticColumns.some((value) => value !== null)) return { status: "invalid", reason: "mixed_delivery_input" };
    const prepared = hydratePreparedEffect(row);
    if (prepared.status !== "prepared") return { status: "invalid", reason: prepared.status === "invalid" ? prepared.reason : "prepared_effect_missing_plan" };
    return {
      status: "prepared-effect",
      input: Object.freeze({ kind: "prepared-effect", effect: prepared.delivery.preparedPlan }),
      delivery: prepared.delivery
    };
  }
  if (row.delivery_input_kind !== "semantic-snapshot") return { status: "invalid", reason: "delivery_input_kind_invalid" };
  if (typeof row.subject_kind !== "string" || typeof row.subject_json !== "string" || !Number.isSafeInteger(row.subject_revision)
    || typeof row.presentation_snapshot_json !== "string" || typeof row.presentation_snapshot_hash !== "string"
    || !Number.isSafeInteger(row.planner_policy_version) || !Number.isSafeInteger(row.renderer_policy_version)
    || !Number.isSafeInteger(row.gateway_profile_version) || !isDeliveryPreparationState(row.preparation_state)) {
    return { status: "invalid", reason: "semantic_delivery_fields_invalid" };
  }
  const input = decodeSemanticSnapshotDeliveryInput({
    subjectKind: row.subject_kind,
    subjectJson: row.subject_json,
    subjectRevision: Number(row.subject_revision),
    presentationSnapshotJson: row.presentation_snapshot_json,
    presentationSnapshotHash: row.presentation_snapshot_hash,
    plannerPolicyVersion: Number(row.planner_policy_version),
    rendererPolicyVersion: Number(row.renderer_policy_version),
    gatewayProfileVersion: Number(row.gateway_profile_version)
  });
  if (!input) return { status: "invalid", reason: "semantic_delivery_codec_invalid" };
  const hasPlanJson = row.gateway_plan_json !== null;
  const hasPlanHash = row.gateway_plan_hash !== null;
  if (row.preparation_state === "prepared") {
    const prepared = hydratePreparedEffect(row);
    if (prepared.status !== "prepared") return { status: "invalid", reason: prepared.status === "invalid" ? prepared.reason : "prepared_semantic_plan_missing" };
    return { status: "semantic-snapshot", input, preparationState: row.preparation_state, preparedDelivery: prepared.delivery };
  }
  if (hasPlanJson || hasPlanHash) return { status: "invalid", reason: "unprepared_semantic_has_plan" };
  const metadata = validateDeliveryMetadata(row);
  if (metadata) return metadata;
  return { status: "semantic-snapshot", input, preparationState: row.preparation_state, preparedDelivery: null };
}

function hydrateSemanticDeliveryWork(
  row: SemanticDeliveryRow,
  input: import("../../domain/delivery.js").SemanticSnapshotDeliveryInput,
  preparationState: DeliveryPreparationState
): SemanticDeliveryWork | null {
  if (preparationState === "prepared") return null;
  const reply = mapOutboundReply(row);
  if (validateDeliveryMetadata(row, reply)) return null;
  if ((reply.kind !== "card_reply" && reply.kind !== "card_update") || reply.rootMessageId === null) return null;
  const checkpoint = decodeCheckpoint(row);
  if (checkpoint.status === "invalid") return null;
  const snapshotJson = row.presentation_snapshot_json!;
  return deepFreeze({
    replyId: reply.id,
    scope: structuredClone(reply.deliveryScope!),
    ownerFence: structuredClone(reply.deliveryOwnerFence),
    parentPaneId: reply.deliveryParentPaneId,
    deliveryOrder: Number(row.delivery_order),
    workClass: reply.workClass,
    idempotencyKey: reply.idempotencyKey,
    gatewayId: reply.gatewayId,
    gatewayProfileId: reply.gatewayProfileId,
    deliveryKind: reply.kind === "card_update" ? "card_update" : "card_reply",
    rootMessageId: reply.rootMessageId!,
    cardSequence: reply.cardSequence,
    conflictKey: reply.conflictKey,
    projectionKey: reply.projectionKey ?? null,
    snapshotRevision: Number(row.snapshot_revision),
    priorCheckpoints: checkpoint.checkpoints,
    nextAttemptAt: reply.nextAttemptAt,
    estimatedBytes: Buffer.byteLength(snapshotJson) + Buffer.byteLength(reply.idempotencyKey) + Buffer.byteLength(input.snapshotHash),
    input,
    preparationState
  });
}

function validSemanticPreparedPlan(work: SemanticDeliveryWork, plan: PreparedDeliveryPlan): boolean {
  if (plan.protocolVersion !== 1 || plan.gatewayId !== work.gatewayId || plan.profileId !== work.gatewayProfileId
    || plan.rendererRevision !== work.input.rendererPolicyVersion || plan.operation !== plan.intent.kind) return false;
  const intent = plan.intent as Record<string, unknown>;
  if (work.deliveryKind === "card_reply") {
    return intent.kind === "message.reply.view" && intent.rootMessageId === work.rootMessageId
      && intent.idempotencyKey === work.idempotencyKey;
  }
  return intent.kind === "surface.replace" && intent.messageId === work.rootMessageId
    && (work.cardSequence === null || intent.sequence === work.cardSequence);
}

function validSemanticWork(work: SemanticDeliveryWork): boolean {
  if (work.input.subject.revision !== work.snapshotRevision) return false;
  try {
    const snapshotJson = encodePresentationSnapshot(work.input.snapshot);
    return presentationSnapshotHash(snapshotJson) === work.input.snapshotHash;
  } catch {
    return false;
  }
}

function hydratePreparedEffect(row: OutboundReplyRow): PreparedDeliveryHydration {
  const reply = mapOutboundReply(row);
  const metadata = validateDeliveryMetadata(row, reply);
  if (metadata) return metadata;
  const scope = reply.deliveryScope!;
  if (!reply.gatewayPlanJson && !reply.gatewayPlanHash) return { status: "unprepared" };
  if (!reply.gatewayPlanJson || !reply.gatewayPlanHash) return { status: "invalid", reason: "partial_plan" };
  if (createHash("sha256").update(reply.gatewayPlanJson).digest("hex") !== reply.gatewayPlanHash) return { status: "invalid", reason: "plan_hash_mismatch" };
  let plan: PreparedDeliveryPlan;
  try { plan = JSON.parse(reply.gatewayPlanJson) as PreparedDeliveryPlan; } catch { return { status: "invalid", reason: "plan_json_invalid" }; }
  if (plan.protocolVersion !== 1 || typeof plan.intent !== "object" || plan.intent === null || typeof plan.intent.kind !== "string" || plan.operation !== plan.intent.kind) return { status: "invalid", reason: "plan_shape_invalid" };
  if (plan.gatewayId !== reply.gatewayId || plan.profileId !== reply.gatewayProfileId || !Number.isInteger(plan.rendererRevision) || plan.rendererRevision < 1) return { status: "invalid", reason: "plan_identity_mismatch" };
  if (!matchesFrozenTarget(plan.intent as Record<string, unknown>, reply)) return { status: "invalid", reason: "plan_target_mismatch" };
  if (!Number.isInteger(row.delivery_order) || row.delivery_order < 1 || !Number.isInteger(row.snapshot_revision) || row.snapshot_revision < 1 || !validTimestamp(reply.nextAttemptAt)) return { status: "invalid", reason: "delivery_metadata_invalid" };
  const checkpoint = decodeCheckpoint(row);
  if (checkpoint.status === "invalid") return checkpoint;
  const preparedPlan = deepFreeze(structuredClone(plan));
  const delivery: PreparedDelivery = deepFreeze({
    replyId: reply.id, scope: structuredClone(scope), ownerFence: structuredClone(reply.deliveryOwnerFence), parentPaneId: reply.deliveryParentPaneId, deliveryOrder: Number(row.delivery_order), workClass: reply.workClass,
    idempotencyKey: reply.idempotencyKey, gatewayId: reply.gatewayId, gatewayProfileId: reply.gatewayProfileId,
    preparedPlan, planHash: reply.gatewayPlanHash, conflictKey: reply.conflictKey, projectionKey: reply.projectionKey ?? null,
    snapshotRevision: Number(row.snapshot_revision), rendererRevision: preparedPlan.rendererRevision, cardSequence: reply.cardSequence,
    priorCheckpoints: checkpoint.checkpoints, nextAttemptAt: reply.nextAttemptAt,
    estimatedBytes: Buffer.byteLength(reply.gatewayPlanJson) + Buffer.byteLength(reply.idempotencyKey) + Buffer.byteLength(reply.gatewayPlanHash)
  });
  return { status: "prepared", delivery };
}

function validateDeliveryMetadata(row: OutboundReplyRow, mapped = mapOutboundReply(row)): { status: "invalid"; reason: string } | null {
  if (!mapped.deliveryScope || !row.scope_key || deliveryScopeKey(mapped.deliveryScope) !== row.scope_key) return { status: "invalid", reason: "invalid_scope" };
  if (mapped.deliveryScope.kind === "pane" && !mapped.deliveryOwnerFence) return { status: "invalid", reason: "invalid_owner_fence" };
  if (mapped.deliveryOwnerFence?.kind === "worker" ? !mapped.deliveryParentPaneId : mapped.deliveryParentPaneId !== null) return { status: "invalid", reason: "invalid_parent_pane_fence" };
  if (!Number.isInteger(row.delivery_order) || row.delivery_order < 1 || !Number.isInteger(row.snapshot_revision) || row.snapshot_revision < 1 || !validTimestamp(mapped.nextAttemptAt)) return { status: "invalid", reason: "delivery_metadata_invalid" };
  return null;
}

function isDeliveryPreparationState(value: unknown): value is DeliveryPreparationState {
  return value === "reserved" || value === "preparing" || value === "prepared";
}

function decodeCheckpoint(row: OutboundReplyRow): { status: "valid"; checkpoints: readonly PreparedDeliveryCheckpoint[] } | { status: "invalid"; reason: string } {
  if (row.gateway_checkpoint_json === null && row.card_id_checkpoint === null) return { status: "valid", checkpoints: [] };
  if (row.gateway_checkpoint_json === null || row.card_id_checkpoint === null) return { status: "invalid", reason: "checkpoint_mismatch" };
  try {
    const value = JSON.parse(row.gateway_checkpoint_json) as { kind?: unknown; gatewayId?: unknown; opaqueId?: unknown };
    if (value.kind !== "surface" || value.gatewayId !== row.gateway_id || value.opaqueId !== row.card_id_checkpoint) return { status: "invalid", reason: "checkpoint_mismatch" };
    return { status: "valid", checkpoints: [{ kind: "surface", ref: { gatewayId: row.gateway_id, kind: "surface", opaqueId: row.card_id_checkpoint } }] };
  } catch { return { status: "invalid", reason: "checkpoint_json_invalid" }; }
}

function boundedLimit(value: number): number { return Number.isInteger(value) && value > 0 ? Math.min(value, 1_000) : 0; }
function hydrateDeliveryRingCheckpoint(row: DeliveryCheckpointRow, requestedScope: DeliveryScope, requestedScopeKey: string): DeliveryRingCheckpoint {
  const updatedAtMs = Date.parse(row.updated_at);
  if (!Number.isSafeInteger(row.committed_delivery_order) || row.committed_delivery_order < 0 || !Number.isFinite(updatedAtMs)) {
    throw new Error("invalid_delivery_checkpoint_row");
  }
  const scope: DeliveryScope = row.scope_kind === "global" && row.scope_workspace_id === null && row.scope_pane_id === null
    ? { kind: "global" }
    : row.scope_kind === "pane" && typeof row.scope_workspace_id === "string" && row.scope_workspace_id.length > 0
      && typeof row.scope_pane_id === "string" && row.scope_pane_id.length > 0
      ? { kind: "pane", workspaceId: row.scope_workspace_id, paneId: row.scope_pane_id }
      : (() => { throw new Error("invalid_delivery_checkpoint_scope"); })();
  if (row.scope_key !== requestedScopeKey || deliveryScopeKey(scope) !== row.scope_key
    || deliveryScopeKey(requestedScope) !== row.scope_key) throw new Error("delivery_checkpoint_scope_conflict");
  return deliveryRingCheckpoint(scope, row.committed_delivery_order, updatedAtMs);
}
function validTimestamp(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function now(): string { return new Date().toISOString(); }
function matchesFrozenTarget(intent: Record<string, unknown>, reply: ReturnType<typeof mapOutboundReply>): boolean {
  if (intent.kind === "conversation.create") return intent.conversationId === reply.targetChatId && intent.idempotencyKey === reply.idempotencyKey;
  if (intent.kind === "message.reply.text" || intent.kind === "message.reply.view" || intent.kind === "stream.create") {
    return intent.rootMessageId === reply.rootMessageId && intent.idempotencyKey === reply.idempotencyKey;
  }
  if (intent.kind === "surface.replace") return intent.messageId === reply.rootMessageId && (reply.cardSequence === null ? intent.sequence === undefined : intent.sequence === reply.cardSequence);
  if (intent.kind === "message.delete") return intent.messageId === reply.rootMessageId && intent.idempotencyKey === reply.idempotencyKey;
  if (intent.kind === "stream.append" || intent.kind === "stream.finish") return intent.surfaceId === reply.rootMessageId;
  if (intent.kind === "conversation.share") return intent.idempotencyKey === undefined;
  return false;
}
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}
