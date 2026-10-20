import type { SqliteContext } from "./context.js";
import type { HistoricalDeliveryDebtMaintenance } from "../../domain/ports/retention.js";
import { confirmAnswerRecoveries, confirmDeliveryRecoveries } from "./delivery-recovery-evidence.js";
import { resolvedPromptReferenceSql } from "./prompt-identity-corrections.js";

export const outboundRetentionCandidateSelectionSql = `
  SELECT id FROM outbound_replies
  WHERE state IN ('delivered', 'dismissed')
    AND claim_attempt_id IS NULL
    AND (
      projection_key IS NULL
      OR snapshot_revision < (
        SELECT MAX(newer.snapshot_revision)
        FROM outbound_replies newer
        WHERE newer.projection_key = outbound_replies.projection_key
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM delivery_recoveries recovery
      WHERE recovery.failed_reply_id = outbound_replies.id
        AND recovery.state IN ('unresolved','replacement_pending')
    )
    AND NOT EXISTS (
      SELECT 1 FROM delivery_recoveries recovery
      WHERE recovery.replacement_reply_id = outbound_replies.id
        AND recovery.state IN ('unresolved','replacement_pending')
    )
    AND NOT EXISTS (
      SELECT 1 FROM conversation_segment_page_recoveries recovery
      WHERE recovery.reply_id = outbound_replies.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM conversation_segment_page_recovery_parts recovery
      WHERE recovery.reply_id = outbound_replies.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM conversation_segment_late_recoveries recovery
      WHERE recovery.reply_id = outbound_replies.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM projection_gaps gap INDEXED BY projection_gaps_open_source_item
      WHERE gap.state='open' AND gap.source_item_id=outbound_replies.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM completion_action_sets action
      WHERE action.presentation_reply_id=outbound_replies.id
        AND action.presentation_kind='fresh-card' AND action.state IN ('presenting','active')
    )
    AND id NOT IN (SELECT prerequisite_reply_id FROM outbound_reply_prerequisites)
    AND updated_at < ?
  ORDER BY updated_at, delivery_order
  LIMIT ?
`;

const failedReplyResolvedPromptSql = resolvedPromptReferenceSql("failed.prompt_id", { bindingIdColumn: "failed.binding_id" });
const projectionGapResolvedPromptSql = resolvedPromptReferenceSql(`CASE
  WHEN gap.owner_kind = 'prompt' THEN gap.owner_id
  WHEN gap.owner_kind = 'answer_page' THEN substr(gap.owner_id,1,instr(gap.owner_id || ':',':')-1)
END`);
const retiredConversationTurnProjectionSql = `prompt.id IS NULL
  AND failed.kind = 'card_update' AND failed.card_role = 'answer'
  AND (
    (failed.prompt_id LIKE 'conversation-turn:v1:%'
      AND failed.projection_key = 'conversation-turn:' || failed.prompt_id || ':answer')
    OR (failed.prompt_id IS NULL
      AND failed.projection_key LIKE 'conversation-turn:conversation-turn:v1:%:answer')
  )
  AND quarantine.failed_reply_id IS NOT NULL`;
const deliveryRecoverySourceUpdatedAtSql = `CASE WHEN ${retiredConversationTurnProjectionSql}
  THEN MAX(recovery.updated_at, quarantine.updated_at, COALESCE((
    SELECT MAX(lane_reply.updated_at)
    FROM outbound_replies lane_reply INDEXED BY outbound_replies_lane_order
    WHERE lane_reply.state IN ('pending','delivered','dead_letter','dismissed')
      AND lane_reply.lane_key = failed.lane_key
  ), recovery.updated_at))
  ELSE MAX(recovery.updated_at, COALESCE(quarantine.updated_at, recovery.updated_at)) END`;

export class SqliteOutboxRetentionStore {
  constructor(private readonly context: SqliteContext) {}

  pruneDelivered(cutoff: string, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    return this.context.transaction("sqlite.outbox-retention-store.write", () => {
      return Number(this.context.database.prepare(`DELETE FROM outbound_replies WHERE id IN (${outboundRetentionCandidateSelectionSql})`).run(cutoff, limit).changes);
    });
  }

  compactDeliveryIntents(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    return Number(this.context.database.prepare(`
      UPDATE outbound_replies
      SET intent_json = json_object('schemaVersion', 2, 'kind', intent_kind)
      WHERE id IN (
        SELECT id FROM outbound_replies
        WHERE claim_attempt_id IS NULL AND (first_claimed_at IS NULL OR state IN ('delivered','dismissed')) AND renderer_revision = 1
          AND json_valid(intent_json)
          AND json_extract(intent_json, '$.schemaVersion') = 1
          AND json_extract(intent_json, '$.kind') = intent_kind
          AND json_extract(intent_json, '$.materializedPayload') = payload
        ORDER BY delivery_order LIMIT ?
      )
    `).run(limit).changes);
  }

  classifyHistoricalDeliveryDebt(cutoff: string, limit: number): HistoricalDeliveryDebtMaintenance {
    const empty = { settledProjectionGaps: 0, releasedQuarantines: 0, classifiedDeliveryRecoveries: 0, classifiedProjectionGaps: 0 };
    if (!Number.isInteger(limit) || limit <= 0) return empty;
    return this.context.transaction("sqlite.outbox-retention-store.write", () => {
      const classifiedAt = new Date().toISOString();
      const candidates = this.context.database.prepare(`
        SELECT debt_kind, debt_id, source_updated_at, reason FROM (
          SELECT 'delivery_recovery' AS debt_kind, recovery.failed_reply_id AS debt_id,
            ${deliveryRecoverySourceUpdatedAtSql} AS source_updated_at,
            CASE WHEN ${retiredConversationTurnProjectionSql} THEN 'retired_conversation_turn_projection'
              WHEN prompt.state IN ('delivered','failed','cancelled') OR turn.state IN ('completed','failed','cancelled')
              THEN 'owner_terminal_without_resolution_proof' ELSE 'retention_window_elapsed_without_resolution_proof' END AS reason
          FROM delivery_recoveries recovery
          JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
          LEFT JOIN outbox_lane_quarantines quarantine
            ON quarantine.failed_reply_id = recovery.failed_reply_id AND quarantine.state = 'active'
          LEFT JOIN prompt_jobs prompt ON prompt.id = ${failedReplyResolvedPromptSql}
          LEFT JOIN instance_turns turn ON turn.id = failed.worker_turn_id
          LEFT JOIN delivery_debt_classifications classified
            ON classified.debt_kind = 'delivery_recovery' AND classified.debt_id = recovery.failed_reply_id
              AND classified.source_updated_at >= recovery.updated_at
              AND classified.source_updated_at >= COALESCE(quarantine.updated_at, recovery.updated_at)
              AND (COALESCE((${retiredConversationTurnProjectionSql}), 0) = 0 OR NOT EXISTS (
                SELECT 1 FROM outbound_replies newer_lane_reply INDEXED BY outbound_replies_lane_order
                WHERE newer_lane_reply.state IN ('pending','delivered','dead_letter','dismissed')
                  AND newer_lane_reply.lane_key = failed.lane_key
                  AND newer_lane_reply.updated_at > classified.source_updated_at
              ))
          WHERE (recovery.state IN ('unresolved','replacement_pending') OR quarantine.failed_reply_id IS NOT NULL)
            AND (prompt.state IN ('delivered','failed','cancelled') OR turn.state IN ('completed','failed','cancelled')
              OR ${retiredConversationTurnProjectionSql}
              OR (recovery.created_at < ? AND COALESCE(quarantine.created_at, recovery.created_at) < ?))
            AND classified.debt_id IS NULL
          UNION ALL
          SELECT 'projection_gap', CAST(gap.id AS TEXT), gap.last_failed_at,
            CASE WHEN prompt.state IN ('delivered','failed','cancelled') OR turn.state IN ('completed','failed','cancelled')
                OR binding.lifecycle IN ('archived','closed','failed')
              THEN 'owner_terminal_without_resolution_proof' ELSE 'retention_window_elapsed_without_resolution_proof' END
          FROM projection_gaps gap
          LEFT JOIN prompt_jobs prompt ON prompt.id = ${projectionGapResolvedPromptSql}
          LEFT JOIN instance_turns turn ON gap.owner_kind = 'worker_turn'
            AND turn.id = substr(gap.owner_id,1,instr(gap.owner_id || ':',':')-1)
          LEFT JOIN bindings binding ON gap.owner_kind = 'binding' AND binding.id = gap.owner_id
          LEFT JOIN delivery_recoveries source_recovery ON source_recovery.failed_reply_id = gap.source_item_id
          LEFT JOIN delivery_debt_classifications classified
            ON classified.debt_kind = 'projection_gap' AND classified.debt_id = CAST(gap.id AS TEXT)
              AND classified.source_updated_at >= gap.last_failed_at
          WHERE gap.state = 'open' AND (prompt.state IN ('delivered','failed','cancelled') OR turn.state IN ('completed','failed','cancelled')
              OR binding.lifecycle IN ('archived','closed','failed') OR COALESCE(source_recovery.created_at,gap.first_failed_at) < ?)
            AND classified.debt_id IS NULL
        ) ORDER BY source_updated_at, debt_kind, debt_id LIMIT ?
      `).all(cutoff, cutoff, cutoff, limit) as Array<{ debt_kind: "delivery_recovery" | "projection_gap"; debt_id: string; source_updated_at: string; reason: string }>;
      let classifiedDeliveryRecoveries = 0;
      let classifiedProjectionGaps = 0;
      let settledProjectionGaps = 0;
      let releasedQuarantines = 0;
      for (const row of candidates) {
        if (row.debt_kind === "delivery_recovery") {
          const recovery = this.context.database.prepare("SELECT replacement_reply_id FROM delivery_recoveries WHERE failed_reply_id = ?").get(row.debt_id) as { replacement_reply_id: string | null } | undefined;
          if (recovery?.replacement_reply_id) {
            confirmDeliveryRecoveries(this.context, recovery.replacement_reply_id);
            confirmAnswerRecoveries(this.context, recovery.replacement_reply_id);
          }
          const resolved = this.context.database.prepare("SELECT state FROM delivery_recoveries WHERE failed_reply_id = ?").get(row.debt_id) as { state: string } | undefined;
          if (resolved?.state === "recovered" || resolved?.state === "dismissed") {
            const quarantine = this.context.database.prepare(`UPDATE outbox_lane_quarantines
              SET state='released',action='maintenance_confirmed_recovery',released_at=?,updated_at=?
              WHERE failed_reply_id=? AND state='active'`).run(classifiedAt, classifiedAt, row.debt_id);
            releasedQuarantines += Number(quarantine.changes);
            if (quarantine.changes > 0) this.context.database.prepare("UPDATE outbound_replies SET next_attempt_at=next_attempt_at WHERE id=?").run(row.debt_id);
            settledProjectionGaps += this.settleProjectionGapsForRecovery(row.debt_id, classifiedAt);
            continue;
          }
        } else if (this.settleProjectionGap(row.debt_id, classifiedAt)) {
          settledProjectionGaps += 1;
          continue;
        }
        const stillUnresolved = row.debt_kind === "delivery_recovery"
          ? this.context.database.prepare("SELECT 1 FROM delivery_recoveries WHERE failed_reply_id=? AND state IN ('unresolved','replacement_pending')").get(row.debt_id)
          : this.context.database.prepare("SELECT 1 FROM projection_gaps WHERE id=? AND state='open'").get(row.debt_id);
        if (!stillUnresolved) continue;
        this.context.database.prepare(`INSERT INTO delivery_debt_classifications(
          debt_kind,debt_id,scope,reason,source_updated_at,classified_at
        ) VALUES (?,?,'historical',?,?,?)
        ON CONFLICT(debt_kind,debt_id) DO UPDATE SET scope='historical',reason=excluded.reason,
          source_updated_at=excluded.source_updated_at,classified_at=excluded.classified_at`).run(
          row.debt_kind, row.debt_id, row.reason, row.source_updated_at, classifiedAt
        );
        if (row.debt_kind === "delivery_recovery") classifiedDeliveryRecoveries += 1;
        else classifiedProjectionGaps += 1;
      }
      return { settledProjectionGaps, releasedQuarantines, classifiedDeliveryRecoveries, classifiedProjectionGaps };
    });
  }

  private settleProjectionGapsForRecovery(failedReplyId: string, occurredAt: string): number {
    const rows = this.context.database.prepare("SELECT id FROM projection_gaps WHERE state='open' AND source_item_id=?").all(failedReplyId) as Array<{ id: number }>;
    let settled = 0;
    for (const row of rows) if (this.settleProjectionGap(String(row.id), occurredAt)) settled += 1;
    return settled;
  }

  private settleProjectionGap(gapId: string, occurredAt: string): boolean {
    const recovery = this.context.database.prepare(`SELECT recovery.state, delivered.view_version
      FROM projection_gaps gap JOIN delivery_recoveries recovery ON recovery.failed_reply_id = gap.source_item_id
      LEFT JOIN outbound_replies delivered ON delivered.id = recovery.resolved_by_reply_id AND delivered.state='delivered'
      WHERE gap.id=? AND gap.state='open' AND recovery.state IN ('recovered','dismissed')`).get(gapId) as { state: "recovered" | "dismissed"; view_version: number | null } | undefined;
    if (!recovery) return false;
    if (recovery.state === "dismissed") {
      return this.context.database.prepare("UPDATE projection_gaps SET state='dismissed',compensated_at=? WHERE id=? AND state='open'").run(occurredAt, gapId).changes === 1;
    }
    if (recovery.view_version === null) return false;
    return this.context.database.prepare(`UPDATE projection_gaps SET state='compensated',compensated_by_version=?,compensated_at=?
      WHERE id=? AND state='open' AND COALESCE(required_version,0) <= ?`).run(recovery.view_version, occurredAt, gapId, recovery.view_version).changes === 1;
  }
}
