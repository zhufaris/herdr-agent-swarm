import { createHash, randomUUID } from "node:crypto";
import type { OutboundDeliveryClaim } from "../../domain/delivery.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { Binding, OutboundReply, OutboundWorkClass } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import { encodeDeliveryIntent } from "../../domain/delivery-intent.js";
import { gatewayScopedOutboundLaneKey, outboundLaneKey } from "../outbox-lanes.js";
import { mapOutboundReply, type OutboundReplyRow, type SqlValue } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteLarkDeliveryCooldownStore } from "./lark-delivery-cooldown-store.js";

type SnapshotIdentity =
  | { projectionKey: string; snapshotRevision: number }
  | { projectionKey?: never; snapshotRevision?: never };

export type EnqueueOutboundReplyInput = Parameters<OutboxStore["enqueueOutboundReply"]>[0] &
  { laneKeyOverride?: string } & SnapshotIdentity;

export class SqliteOutboxQueueStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getBinding(id: string): Binding | null;
      loadRunCard(promptId: string): RunCardView | null;
      loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
    },
    private readonly cooldown: SqliteLarkDeliveryCooldownStore
  ) {}

  enqueue(input: EnqueueOutboundReplyInput): OutboundReply {
    const timestamp = now();
    const bindingGeneration = input.promptId ? this.dependencies.loadRunCard(input.promptId)?.bindingGeneration ?? null : input.bindingId ? this.dependencies.getBinding(input.bindingId)?.generation ?? null : null;
    const logicalLaneKey = input.laneKeyOverride ?? outboundLaneKey({ ...input, bindingGeneration });
    const streamMetadata = outboundStreamMetadata(input.kind, input.payload);
    const encoded = encodeDeliveryIntent(input.kind, input.payload);
    const intentKind = input.intentKind ?? encoded.intentKind;
    const intentJson = input.intentJson ?? encoded.intentJson;
    const rendererRevision = input.rendererRevision ?? encoded.rendererRevision;
    const workClass = input.workClass ?? "live";
    let cardSequence = input.cardSequence ?? null;
    const gatewayId = input.gatewayId ?? "feishu:primary";
    const laneKey = gatewayScopedOutboundLaneKey(gatewayId, logicalLaneKey);
    const gatewayProfileId = input.gatewayProfileId ?? "feishu-cardkit-v1";
    const gatewayPlanJson = input.gatewayPlanJson ?? null;
    const gatewayPlanHash = input.gatewayPlanHash ?? null;
    const gatewayCheckpointJson = input.gatewayCheckpointJson ?? null;
    const rootMessageId = input.rootMessageId ?? null;
    const targetChatId = input.targetChatId ?? null;
    const threadAliasId = input.threadAliasId ?? null;
    const workerThreadId = input.workerThreadId ?? null;
    return this.context.transaction(() => {
      const existing = this.getByKey(input.idempotencyKey);
      if (existing) {
        const same = existing.gatewayId === gatewayId && existing.gatewayProfileId === gatewayProfileId && existing.gatewayPlanJson === gatewayPlanJson && existing.gatewayPlanHash === gatewayPlanHash && existing.gatewayCheckpointJson === gatewayCheckpointJson && existing.payload === input.payload && existing.intentJson === intentJson && existing.rendererRevision === rendererRevision && existing.rootMessageId === rootMessageId && existing.targetChatId === targetChatId && existing.threadAliasId === threadAliasId && existing.workerThreadId === workerThreadId && existing.kind === input.kind && existing.viewVersion === (input.viewVersion ?? null) && existing.cardSequence === (input.cardSequence ?? null);
        if (same) return existing;
        if (existing.workClass !== workClass) throw new Error("outbound_idempotency_conflict");
        if (existing.state !== "pending") return existing;
        if (this.wasClaimed(existing.id)) throw new Error("outbound_idempotency_conflict");
      }
      if (input.kind === "card_update" && input.bindingId && !input.promptId && rootMessageId && input.targetRole === "session_status") {
        const replaceable = this.context.database.prepare(`
          SELECT MIN(card_sequence) AS reusable_sequence
          FROM outbound_replies
          WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
            AND lane_key = ? AND kind = 'card_update' AND target_role = 'session_status' AND state = 'pending'
            AND claim_attempt_id IS NULL AND first_claimed_at IS NULL AND attempt_count = 0
            AND card_id_checkpoint IS NULL AND projection_key IS NULL
        `).get(input.bindingId, rootMessageId, laneKey) as { reusable_sequence: number | null };
        if (replaceable.reusable_sequence !== null && cardSequence !== null) cardSequence = Math.min(cardSequence, Number(replaceable.reusable_sequence));
        this.context.database.prepare(`
          DELETE FROM outbound_replies
          WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
            AND lane_key = ? AND kind = 'card_update' AND target_role = 'session_status' AND state = 'pending'
            AND claim_attempt_id IS NULL AND first_claimed_at IS NULL AND attempt_count = 0
            AND card_id_checkpoint IS NULL AND projection_key IS NULL
        `).run(input.bindingId, rootMessageId, laneKey);
      } else if (input.kind === "card_update" && input.bindingId && !input.promptId && rootMessageId && logicalLaneKey.startsWith("pane-entry:")) {
        this.context.database.prepare(`
          DELETE FROM outbound_replies
          WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
            AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            AND claim_attempt_id IS NULL AND first_claimed_at IS NULL AND attempt_count = 0
            AND card_id_checkpoint IS NULL AND projection_key IS NULL
        `).run(input.bindingId, rootMessageId, laneKey);
      } else if (input.kind === "card_update" && input.bindingId && !input.promptId && rootMessageId) {
        this.context.database.prepare(`
          DELETE FROM outbound_replies
          WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
            AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            AND first_claimed_at IS NULL AND attempt_count = 0 AND card_id_checkpoint IS NULL AND projection_key IS NULL
            AND delivery_order > (
              SELECT MIN(delivery_order) FROM outbound_replies
              WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
                AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            )
        `).run(input.bindingId, rootMessageId, laneKey, input.bindingId, rootMessageId, laneKey);
      }
      if (input.kind === "card_update" && input.workerId && input.workerSessionGeneration !== undefined && input.workerSessionGeneration !== null && input.viewVersion !== undefined && input.viewVersion !== null) {
        this.context.database.prepare("DELETE FROM outbound_replies WHERE worker_id = ? AND worker_session_generation = ? AND kind = 'card_update' AND state = 'pending' AND first_claimed_at IS NULL AND attempt_count = 0 AND card_id_checkpoint IS NULL AND projection_key IS NULL AND COALESCE(view_version, 0) < ?").run(input.workerId, input.workerSessionGeneration, input.viewVersion);
      }
      if (input.kind === "card_update" && input.promptId && rootMessageId && input.viewVersion !== undefined && input.viewVersion !== null) {
        this.context.database.prepare("DELETE FROM outbound_replies WHERE prompt_id = ? AND root_message_id = ? AND kind = ? AND state = 'pending' AND first_claimed_at IS NULL AND attempt_count = 0 AND card_id_checkpoint IS NULL AND projection_key IS NULL AND card_role IS ? AND COALESCE(view_version, 0) < ?").run(input.promptId, rootMessageId, input.kind, input.cardRole ?? null, input.viewVersion);
      }
      this.context.database.prepare(`
        INSERT INTO outbound_replies(id, gateway_id, gateway_profile_id, gateway_plan_json, gateway_plan_hash, gateway_checkpoint_json, idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, stream_page_index, stream_element_id, card_role, target_role, thread_alias_id, worker_thread_id, target_chat_id, work_class, root_message_id, kind, payload, intent_kind, intent_json, renderer_revision, lane_key, projection_key, snapshot_revision, state, attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          payload = CASE WHEN outbound_replies.state = 'pending' THEN excluded.payload ELSE outbound_replies.payload END,
          view_version = CASE WHEN outbound_replies.state = 'pending' THEN excluded.view_version ELSE outbound_replies.view_version END,
          card_sequence = CASE WHEN outbound_replies.state = 'pending' THEN excluded.card_sequence ELSE outbound_replies.card_sequence END,
          stream_page_index = CASE WHEN outbound_replies.state = 'pending' THEN excluded.stream_page_index ELSE outbound_replies.stream_page_index END,
          stream_element_id = CASE WHEN outbound_replies.state = 'pending' THEN excluded.stream_element_id ELSE outbound_replies.stream_element_id END,
          intent_kind = CASE WHEN outbound_replies.state = 'pending' THEN excluded.intent_kind ELSE outbound_replies.intent_kind END,
          intent_json = CASE WHEN outbound_replies.state = 'pending' THEN excluded.intent_json ELSE outbound_replies.intent_json END,
          renderer_revision = CASE WHEN outbound_replies.state = 'pending' THEN excluded.renderer_revision ELSE outbound_replies.renderer_revision END,
          updated_at = CASE WHEN outbound_replies.state = 'pending' THEN excluded.updated_at ELSE outbound_replies.updated_at END
      `).run(input.id, gatewayId, gatewayProfileId, gatewayPlanJson, gatewayPlanHash, gatewayCheckpointJson, input.idempotencyKey, input.bindingId ?? null, input.promptId ?? null, input.workerTurnId ?? null, input.workerId ?? null, input.workerSessionGeneration ?? null, input.viewVersion ?? null, cardSequence, input.selectionId ?? null, streamMetadata.pageIndex, streamMetadata.elementId, input.cardRole ?? null, input.targetRole ?? null, threadAliasId, workerThreadId, targetChatId, workClass, rootMessageId, input.kind, input.payload, intentKind, intentJson, rendererRevision, laneKey, input.projectionKey ?? null, input.snapshotRevision ?? 1, timestamp, timestamp, timestamp);
      const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key = ?").get(input.idempotencyKey) as OutboundReplyRow | undefined;
      if (!row) throw new Error(`Outbound reply not found: ${input.idempotencyKey}`);
      if (input.kind === "stream_card_create" && input.promptId) {
        const stream = streamCardState(input.payload);
        const pageIndex = stream?.pageIndex ?? 0;
        const view = this.dependencies.loadRunCard(input.promptId);
        const elementId = stream?.elementId ?? view?.answerElementId;
        if (!view || !elementId) throw new Error(`Answer page metadata missing for prompt: ${input.promptId}`);
        this.context.database.prepare(`INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, 0, 'creating', 'streaming', ?, ?) ON CONFLICT(prompt_id, page_index) DO NOTHING`).run(input.promptId, pageIndex, elementId, stream?.pageStart ?? 0, timestamp, timestamp);
      }
      if (input.kind === "stream_card_create" && input.workerTurnId) {
        const stream = streamCardState(input.payload);
        const view = this.dependencies.loadWorkerTurnCard(input.workerTurnId);
        const pageIndex = stream?.pageIndex ?? 0;
        const elementId = stream?.elementId ?? view?.elementId;
        if (!view || !elementId) throw new Error(`Worker card page metadata missing for turn: ${input.workerTurnId}`);
        this.context.database.prepare(`INSERT INTO worker_turn_card_pages(id, turn_id, page_index, page_start, element_id, message_id, card_id, state, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'creating', 0, ?, ?) ON CONFLICT(turn_id, page_index) DO NOTHING`).run(`${input.workerTurnId}:${pageIndex}`, input.workerTurnId, pageIndex, stream?.pageStart ?? 0, elementId, timestamp, timestamp);
      }
      return mapOutboundReply(row);
    });
  }

  getByKey(key: string): OutboundReply | null {
    const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key = ?").get(key) as OutboundReplyRow | undefined;
    return row ? mapOutboundReply(row) : null;
  }

  wasClaimed(id: string): boolean {
    return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE id = ? AND (first_claimed_at IS NOT NULL OR attempt_count > 0 OR card_id_checkpoint IS NOT NULL)").get(id) !== undefined;
  }

  prepareGatewayPlan(id: string, input: { gatewayId: string; gatewayProfileId: string; gatewayPlanJson: string }): OutboundReply | null {
    return this.context.transaction(() => {
      const current = this.get(id);
      if (!current || current.state !== "pending") return null;
      const gatewayPlanHash = createHash("sha256").update(input.gatewayPlanJson).digest("hex");
      if (current.gatewayPlanJson !== null || current.gatewayPlanHash !== null) {
        if (current.gatewayId !== input.gatewayId || current.gatewayProfileId !== input.gatewayProfileId || current.gatewayPlanJson !== input.gatewayPlanJson || current.gatewayPlanHash !== gatewayPlanHash) throw new Error("outbound_gateway_plan_conflict");
        return current;
      }
      const claim = this.context.database.prepare("SELECT claim_attempt_id, first_claimed_at FROM outbound_replies WHERE id = ?").get(id) as { claim_attempt_id: string | null; first_claimed_at: string | null } | undefined;
      if (!claim || claim.claim_attempt_id !== null) return null;
      if (claim.first_claimed_at !== null && (current.gatewayId !== input.gatewayId || current.gatewayProfileId !== input.gatewayProfileId)) throw new Error("outbound_gateway_identity_conflict");
      const updated = this.context.database.prepare("UPDATE outbound_replies SET gateway_id = ?, gateway_profile_id = ?, gateway_plan_json = ?, gateway_plan_hash = ?, updated_at = ? WHERE id = ? AND state = 'pending' AND claim_attempt_id IS NULL AND gateway_plan_json IS NULL AND gateway_plan_hash IS NULL").run(input.gatewayId, input.gatewayProfileId, input.gatewayPlanJson, gatewayPlanHash, now(), id);
      return updated.changes === 1 ? this.get(id) : null;
    });
  }

  claim(id: string, dueAt: string | null): OutboundDeliveryClaim | null {
    return this.context.transaction(() => {
      if (this.cooldown.activeUntil()) return null;
      const row = this.context.database.prepare(`SELECT o.* FROM outbound_replies o JOIN outbox_lane_heads h ON h.reply_id = o.id WHERE o.id = ? AND o.state = 'pending' AND o.claim_attempt_id IS NULL AND (? IS NULL OR o.next_attempt_at <= ?) AND NOT EXISTS (SELECT 1 FROM outbound_replies active WHERE active.lane_key = o.lane_key AND active.claim_attempt_id IS NOT NULL)`).get(id, dueAt, dueAt) as OutboundReplyRow | undefined;
      if (!row) return null;
      const hasFence = this.context.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name = 'bridge_write_fence'").get();
      const fence = hasFence ? this.context.database.prepare("SELECT owner_id, fencing_token FROM temp.bridge_write_fence").get() as { owner_id: string; fencing_token: number } : null;
      const reply = mapOutboundReply(row);
      const attemptId = randomUUID();
      const payloadHash = createHash("sha256").update(JSON.stringify([reply.gatewayId, reply.gatewayProfileId, reply.gatewayPlanJson, reply.gatewayPlanHash, reply.idempotencyKey, reply.rootMessageId, reply.targetChatId, reply.threadAliasId, reply.workerThreadId, reply.kind, reply.payload, reply.intentKind, reply.intentJson, reply.rendererRevision, reply.viewVersion, reply.cardSequence, reply.workClass])).digest("hex");
      this.context.database.prepare("UPDATE outbound_replies SET claim_attempt_id = ?, claimed_fence = ?, claimed_owner_id = ?, claimed_at = ?, first_claimed_at = COALESCE(first_claimed_at, ?), payload_hash = ? WHERE id = ?").run(attemptId, fence?.fencing_token ?? null, fence?.owner_id ?? null, now(), now(), payloadHash, id);
      return Object.freeze({ reply: Object.freeze(reply), attemptId, fencingToken: fence?.fencing_token ?? null, payloadHash, snapshotRevision: Number(row.snapshot_revision) });
    });
  }

  matchesClaim(id: string, claim?: OutboundDeliveryClaim): boolean {
    if (!claim) return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE id = ? AND claim_attempt_id IS NULL").get(id) !== undefined;
    if (claim.reply.id !== id) return false;
    return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE id = ? AND claim_attempt_id = ? AND claimed_fence IS ? AND payload_hash = ? AND snapshot_revision = ?").get(id, claim.attemptId, claim.fencingToken, claim.payloadHash, claim.snapshotRevision) !== undefined;
  }

  releaseClaim(id: string): void {
    this.context.database.prepare("UPDATE outbound_replies SET claim_attempt_id = NULL, claimed_fence = NULL, claimed_at = NULL WHERE id = ?").run(id);
  }

  listPending(): OutboundReply[] {
    return (this.context.database.prepare("SELECT * FROM outbound_replies WHERE state = 'pending' ORDER BY delivery_order").all() as OutboundReplyRow[]).map(mapOutboundReply);
  }

  hasPendingForWorkerTurn(turnId: string): boolean {
    return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND state = 'pending' LIMIT 1").get(turnId) !== undefined;
  }

  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean {
    return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' AND stream_page_index = ? LIMIT 1").get(promptId, pageIndex) !== undefined;
  }

  dismissSupersededAnswerStream(replyId: string): boolean {
    const updated = this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed', error = 'Answer stream superseded by a continuation page', updated_at = ? WHERE id = ? AND state = 'pending' AND claim_attempt_id IS NULL AND kind IN ('stream_content', 'stream_finish') AND prompt_id IS NOT NULL AND EXISTS (SELECT 1 FROM run_cards WHERE run_cards.prompt_id = outbound_replies.prompt_id AND run_cards.answer_page_index > 0 AND run_cards.answer_card_id IS NOT NULL AND run_cards.answer_card_id != outbound_replies.root_message_id)`).run(now(), replyId);
    return Number(updated.changes) === 1;
  }

  listLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys: readonly string[] = [], workClass?: OutboundWorkClass): OutboundReply[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    if (this.cooldown.activeUntil()) return [];
    const parameters: SqlValue[] = [...excludedLaneKeys];
    if (dueAt !== null) parameters.push(dueAt);
    if (workClass) parameters.push(workClass);
    parameters.push(limit);
    const sql = outboundLaneHeadSelectionSql({ excludedLaneCount: excludedLaneKeys.length, dueAt: dueAt !== null, workClass: Boolean(workClass) });
    return (this.context.database.prepare(sql).all(...parameters) as OutboundReplyRow[]).map(mapOutboundReply);
  }

  getNextLaneHeadAttemptAt(): string | null {
    const row = this.context.database.prepare("SELECT MIN(h.next_attempt_at) AS next_attempt_at FROM outbox_lane_heads h WHERE NOT EXISTS (SELECT 1 FROM outbound_replies active WHERE active.lane_key = h.lane_key AND active.claim_attempt_id IS NOT NULL)").get() as { next_attempt_at: string | null };
    if (!row.next_attempt_at) return null;
    const cooldown = this.cooldown.activeUntil();
    return cooldown && cooldown > row.next_attempt_at ? cooldown : row.next_attempt_at;
  }

  refreshLaneHead(laneKey: string): void {
    this.context.database.prepare("DELETE FROM outbox_lane_heads WHERE lane_key = ?").run(laneKey);
    this.context.database.prepare(`INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at) SELECT lane_key, id, delivery_order, next_attempt_at, created_at FROM outbound_replies WHERE lane_key = ? AND state = 'pending' AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = ? AND q.state = 'active') ORDER BY delivery_order LIMIT 1`).run(laneKey, laneKey);
  }

  get(id: string): OutboundReply | null {
    const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE id = ?").get(id) as OutboundReplyRow | undefined;
    return row ? mapOutboundReply(row) : null;
  }
}

export function outboundLaneHeadSelectionSql(input: { excludedLaneCount: number; dueAt: boolean; workClass: boolean }): string {
  const exclusions = input.excludedLaneCount > 0 ? `AND h.lane_key NOT IN (${Array.from({ length: input.excludedLaneCount }, () => "?").join(", " )})` : "";
  const due = input.dueAt ? "AND h.next_attempt_at <= ?" : "";
  const classFilter = input.workClass ? "AND o.work_class = ?" : "";
  return `SELECT o.* FROM outbox_lane_heads h INDEXED BY outbox_lane_heads_delivery_order JOIN outbound_replies o ON o.id = h.reply_id WHERE o.claim_attempt_id IS NULL AND NOT EXISTS (SELECT 1 FROM outbound_replies active WHERE active.lane_key = o.lane_key AND active.claim_attempt_id IS NOT NULL) ${exclusions} ${due} ${classFilter} ORDER BY h.delivery_order LIMIT ?`;
}

function now(): string { return new Date().toISOString(); }
function streamCardState(payload: string): { pageIndex: number; pageStart: number; elementId: string } | null {
  try {
    const decoded = JSON.parse(payload) as { stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown } };
    const stream = decoded.stream;
    return stream && Number.isInteger(stream.pageIndex) && Number.isInteger(stream.pageStart) && typeof stream.elementId === "string"
      ? { pageIndex: Number(stream.pageIndex), pageStart: Number(stream.pageStart), elementId: stream.elementId } : null;
  } catch { return null; }
}
function outboundStreamMetadata(kind: OutboundReply["kind"], payload: string): { pageIndex: number | null; elementId: string | null } {
  if (kind !== "stream_card_create" && kind !== "stream_content" && kind !== "stream_finish") return { pageIndex: null, elementId: null };
  const decoded = parseJsonRecord(payload);
  const stream = kind === "stream_card_create" && typeof decoded.stream === "object" && decoded.stream !== null && !Array.isArray(decoded.stream)
    ? decoded.stream as Record<string, unknown> : decoded;
  return { pageIndex: Number.isInteger(stream.pageIndex) ? Number(stream.pageIndex) : null, elementId: typeof stream.elementId === "string" ? stream.elementId : null };
}
function parseJsonRecord(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value) as unknown; return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
