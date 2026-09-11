import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { Binding, OutboundReply } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import { encodeDeliveryIntent } from "../../domain/delivery-intent.js";
import { outboundLaneKey } from "../outbox-lanes.js";
import { mapOutboundReply, type OutboundReplyRow, type SqlValue } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

export type EnqueueOutboundReplyInput = Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string };

export class SqliteOutboxQueueStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getBinding(id: string): Binding | null;
      loadRunCard(promptId: string): RunCardView | null;
      loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
    }
  ) {}

  enqueue(input: EnqueueOutboundReplyInput): OutboundReply {
    const timestamp = now();
    const bindingGeneration = input.promptId ? this.dependencies.loadRunCard(input.promptId)?.bindingGeneration ?? null : input.bindingId ? this.dependencies.getBinding(input.bindingId)?.generation ?? null : null;
    const laneKey = input.laneKeyOverride ?? outboundLaneKey({ ...input, bindingGeneration });
    const streamMetadata = outboundStreamMetadata(input.kind, input.payload);
    const encoded = encodeDeliveryIntent(input.kind, input.payload);
    const intentKind = input.intentKind ?? encoded.intentKind;
    const intentJson = input.intentJson ?? encoded.intentJson;
    const rendererRevision = input.rendererRevision ?? encoded.rendererRevision;
    return this.context.transaction(() => {
      if (input.kind === "card_update" && input.bindingId && !input.promptId) {
        this.context.database.prepare(`
          DELETE FROM outbound_replies
          WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
            AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            AND delivery_order > (
              SELECT MIN(delivery_order) FROM outbound_replies
              WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
                AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            )
        `).run(input.bindingId, input.rootMessageId, laneKey, input.bindingId, input.rootMessageId, laneKey);
      }
      if (input.kind === "card_update" && input.workerId && input.workerSessionGeneration !== undefined && input.workerSessionGeneration !== null && input.viewVersion !== undefined && input.viewVersion !== null) {
        this.context.database.prepare("DELETE FROM outbound_replies WHERE worker_id = ? AND worker_session_generation = ? AND kind = 'card_update' AND state = 'pending' AND COALESCE(view_version, 0) < ?").run(input.workerId, input.workerSessionGeneration, input.viewVersion);
      }
      if (input.kind === "card_update" && input.promptId && input.viewVersion !== undefined && input.viewVersion !== null) {
        this.context.database.prepare("DELETE FROM outbound_replies WHERE prompt_id = ? AND root_message_id = ? AND kind = ? AND state = 'pending' AND card_role IS ? AND COALESCE(view_version, 0) < ?").run(input.promptId, input.rootMessageId, input.kind, input.cardRole ?? null, input.viewVersion);
      }
      this.context.database.prepare(`
        INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, stream_page_index, stream_element_id, card_role, target_role, root_message_id, kind, payload, intent_kind, intent_json, renderer_revision, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
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
      `).run(input.id, input.idempotencyKey, input.bindingId ?? null, input.promptId ?? null, input.workerTurnId ?? null, input.workerId ?? null, input.workerSessionGeneration ?? null, input.viewVersion ?? null, input.cardSequence ?? null, input.selectionId ?? null, streamMetadata.pageIndex, streamMetadata.elementId, input.cardRole ?? null, input.targetRole ?? null, input.rootMessageId, input.kind, input.payload, intentKind, intentJson, rendererRevision, laneKey, timestamp, timestamp, timestamp);
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

  listPending(): OutboundReply[] {
    return (this.context.database.prepare("SELECT * FROM outbound_replies WHERE state = 'pending' ORDER BY delivery_order").all() as OutboundReplyRow[]).map(mapOutboundReply);
  }

  hasPendingForWorkerTurn(turnId: string): boolean {
    return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND state = 'pending' LIMIT 1").get(turnId) !== undefined;
  }

  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean {
    return this.context.database.prepare(`SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' AND json_extract(payload, '$.stream.pageIndex') = ? LIMIT 1`).get(promptId, pageIndex) !== undefined;
  }

  dismissSupersededAnswerStream(replyId: string): boolean {
    const updated = this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed', error = 'Answer stream superseded by a continuation page', updated_at = ? WHERE id = ? AND state = 'pending' AND kind IN ('stream_content', 'stream_finish') AND prompt_id IS NOT NULL AND EXISTS (SELECT 1 FROM run_cards WHERE run_cards.prompt_id = outbound_replies.prompt_id AND run_cards.answer_page_index > 0 AND run_cards.answer_card_id IS NOT NULL AND run_cards.answer_card_id != outbound_replies.root_message_id)`).run(now(), replyId);
    return Number(updated.changes) === 1;
  }

  listLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys: readonly string[] = [], laneClass?: "interactive"): OutboundReply[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const exclusions = excludedLaneKeys.length > 0 ? `AND h.lane_key NOT IN (${excludedLaneKeys.map(() => "?").join(", " )})` : "";
    const due = dueAt === null ? "" : "AND h.next_attempt_at <= ?";
    const laneFilter = laneClass === "interactive" ? "AND (h.lane_key GLOB 'answer:*' OR h.lane_key GLOB 'primary-answer:*' OR h.lane_key GLOB 'reply:*')" : "";
    const parameters: SqlValue[] = [...excludedLaneKeys];
    if (dueAt !== null) parameters.push(dueAt);
    parameters.push(limit);
    return (this.context.database.prepare(`SELECT o.* FROM outbox_lane_heads h JOIN outbound_replies o ON o.id = h.reply_id WHERE 1 = 1 ${exclusions} ${due} ${laneFilter} ORDER BY h.delivery_order LIMIT ?`).all(...parameters) as OutboundReplyRow[]).map(mapOutboundReply);
  }

  getNextLaneHeadAttemptAt(): string | null {
    const row = this.context.database.prepare("SELECT MIN(next_attempt_at) AS next_attempt_at FROM outbox_lane_heads").get() as { next_attempt_at: string | null };
    return row.next_attempt_at;
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
