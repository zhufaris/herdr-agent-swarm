import type { LegacyInputCardRetirement, LegacyInputCardRetirementState, LegacyInputCardRetirementStore } from "../../domain/ports/legacy-input-card-retirement.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import type { SqliteContext } from "./context.js";
import { coreEventDiscriminatorSql } from "./core-event-discriminators.js";

interface LegacyInputCardRetirementRow {
  submission_id: string;
  gateway_id: string;
  message_id: string;
  outbound_reply_id: string;
  state: LegacyInputCardRetirementState;
  outcome: "deleted" | "already_absent" | "failed" | null;
  detail: string | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

interface RetirementCandidate {
  submission_id: string;
  gateway_id: string;
  message_id: string;
  owner_kind: "primary" | "worker";
  owner_id: string;
  owner_generation: number;
}

export class SqliteLegacyInputCardRetirementStore implements LegacyInputCardRetirementStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(private readonly context: SqliteContext, private readonly dependencies: {
    enqueueOutboundReply(input: EnqueueOutboundReplyInput): unknown;
  }) {}
  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void { this.preparedDeliveryReservation = reservation; this.preparedDeliveryConsumer = consumer; }

  scan(limit = 100): number {
    const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
    const submissionId = coreEventDiscriminatorSql(this.context.database, "human", "submission_id");
    return this.context.transaction("sqlite.legacy-input-card-retirement-store.write", () => {
      const candidates = this.context.database.prepare(`
        SELECT intent.submission_id,
          json_extract(intent.actor_json, '$.gatewayId') AS gateway_id,
          card.message_id, intent.owner_kind, intent.owner_id, intent.owner_generation
        FROM submission_intents intent
        JOIN input_card_views card ON card.submission_id = intent.submission_id
        JOIN canonical_human_message_submissions canonical ON canonical.submission_id = intent.submission_id
        JOIN core_event_inbox human ON human.event_id = canonical.event_id
        JOIN conversation_segments segment ON segment.submission_id = intent.submission_id
          AND segment.human_event_id = canonical.event_id
        LEFT JOIN legacy_input_card_retirements retirement ON retirement.submission_id = intent.submission_id
        WHERE retirement.submission_id IS NULL
          AND intent.state = 'terminal'
          AND segment.state IN ('completed','failed','cancelled','closed')
          AND segment.owner_kind = intent.owner_kind
          AND segment.owner_id = intent.owner_id
          AND segment.owner_generation = intent.owner_generation
          AND segment.agent_kind = intent.expected_agent_kind
          AND segment.session_id = canonical.session_id
          AND card.message_id IS NOT NULL AND length(card.message_id) > 0
          AND card.delivered_revision > 0
          AND json_type(intent.actor_json, '$.gatewayId') = 'text'
          AND length(json_extract(intent.actor_json, '$.gatewayId')) > 0
          AND json_type(intent.actor_json, '$.chatId') = 'text'
          AND length(json_extract(intent.actor_json, '$.chatId')) > 0
          AND json_type(intent.actor_json, '$.rootMessageId') = 'text'
          AND card.root_message_id = json_extract(intent.actor_json, '$.rootMessageId')
          AND canonical.agent_kind = intent.expected_agent_kind
          AND canonical.session_id = json_extract(intent.receipt_json, '$.sessionId')
          AND human.agent_kind = canonical.agent_kind
          AND human.session_id = canonical.session_id
          AND human.turn_id = json_extract(intent.receipt_json, '$.turnId')
          AND ${submissionId} = intent.submission_id
          AND NOT EXISTS (
            SELECT 1 FROM input_card_views conflict
            WHERE conflict.message_id = card.message_id AND conflict.submission_id <> card.submission_id
          )
        ORDER BY intent.updated_at, intent.submission_id
        LIMIT ?
      `).all(bounded) as unknown as RetirementCandidate[];
      let reserved = 0;
      for (const candidate of candidates) {
        const timestamp = now();
        const outboundReplyId = `legacy-input-card-delete:${candidate.submission_id}`;
        const primaryBinding = candidate.owner_kind === "primary" && this.context.database.prepare("SELECT 1 FROM bindings WHERE id=? AND generation=? AND state='active' AND lifecycle='active' AND attachment='attached'").get(candidate.owner_id, candidate.owner_generation) !== undefined;
        if (candidate.owner_kind === "primary" && !primaryBinding) continue;
        const worker = candidate.owner_kind === "worker"
          ? this.context.database.prepare("SELECT worker_session_generation FROM agent_instances WHERE id=? AND generation=? AND role='worker' AND worker_session_lifecycle='active'").get(candidate.owner_id, candidate.owner_generation) as { worker_session_generation: number } | undefined
          : undefined;
        if (candidate.owner_kind === "worker" && !worker) continue;
        const outbound: EnqueueOutboundReplyInput = {
          id: outboundReplyId,
          idempotencyKey: outboundReplyId,
          gatewayId: candidate.gateway_id,
          bindingId: primaryBinding ? candidate.owner_id : null,
          bindingGeneration: primaryBinding ? candidate.owner_generation : null,
          ...(worker ? { workerId: candidate.owner_id, workerSessionGeneration: worker.worker_session_generation } : {}),
          rootMessageId: candidate.message_id,
          kind: "message_delete",
          payload: "",
          workClass: "history",
          laneKeyOverride: `input-card:${candidate.submission_id}`
        };
        if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Legacy Input Card Retirement prepared delivery is not connected");
        this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply(outbound));
        this.context.database.prepare(`INSERT INTO legacy_input_card_retirements(
          submission_id,gateway_id,message_id,outbound_reply_id,state,outcome,detail,created_at,updated_at,retired_at
        ) VALUES (?, ?, ?, ?, 'deleting', NULL, NULL, ?, ?, NULL)`).run(
          candidate.submission_id, candidate.gateway_id, candidate.message_id, outboundReplyId, timestamp, timestamp
        );
        reserved += 1;
      }
      return reserved;
    });
  }

  get(submissionId: string): LegacyInputCardRetirement | null {
    const row = this.context.database.prepare("SELECT * FROM legacy_input_card_retirements WHERE submission_id = ?")
      .get(submissionId) as LegacyInputCardRetirementRow | undefined;
    return row ? mapRetirement(row) : null;
  }

  settle(input: { outboundReplyId: string; outcome: "deleted" | "already_absent" | "failed"; detail?: string | null }): LegacyInputCardRetirement | null {
    return this.context.transaction("sqlite.legacy-input-card-retirement-store.write", () => {
      const current = this.context.database.prepare("SELECT * FROM legacy_input_card_retirements WHERE outbound_reply_id = ?")
        .get(input.outboundReplyId) as LegacyInputCardRetirementRow | undefined;
      if (!current) return null;
      if (current.state !== "deleting") return mapRetirement(current);
      const timestamp = now();
      const terminalState = input.outcome === "failed" ? "failed" : "retired";
      this.context.database.prepare(`UPDATE legacy_input_card_retirements
        SET state = ?, outcome = ?, detail = ?, retired_at = ?, updated_at = ?
        WHERE outbound_reply_id = ? AND state = 'deleting'`).run(
          terminalState,
          input.outcome,
          input.detail?.slice(0, 500) ?? null,
          terminalState === "retired" ? timestamp : null,
          timestamp,
          input.outboundReplyId
        );
      return this.get(current.submission_id);
    });
  }

  reconcileExpiredMessageDelete(outboundReplyId: string): boolean {
    return this.context.transaction("sqlite.legacy-input-card-retirement-store.write", () => {
      const timestamp = now();
      const updated = this.context.database.prepare(`UPDATE legacy_input_card_retirements AS retirement
        SET state = 'retired', outcome = 'already_absent', detail = NULL, retired_at = ?, updated_at = ?
        WHERE retirement.outbound_reply_id = ? AND retirement.state = 'failed' AND retirement.outcome = 'failed'
          AND EXISTS (
            SELECT 1 FROM outbound_replies failed
            WHERE failed.id = retirement.outbound_reply_id
              AND failed.gateway_id = retirement.gateway_id
              AND failed.root_message_id = retirement.message_id
              AND failed.gateway_profile_id = 'feishu-cardkit-v1'
              AND failed.state = 'dead_letter' AND failed.kind = 'message_delete'
              AND failed.failure_class = 'permanent' AND failed.effect_certainty = 'rejected'
              AND failed.lark_error_code = '230009'
          )`).run(timestamp, timestamp, outboundReplyId);
      return updated.changes === 1;
    });
  }
  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void { queueMicrotask(() => { for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery); }); }
}

function mapRetirement(row: LegacyInputCardRetirementRow): LegacyInputCardRetirement {
  return {
    submissionId: row.submission_id,
    gatewayId: row.gateway_id,
    messageId: row.message_id,
    outboundReplyId: row.outbound_reply_id,
    state: row.state,
    outcome: row.outcome,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at
  };
}

function now(): string { return new Date().toISOString(); }
