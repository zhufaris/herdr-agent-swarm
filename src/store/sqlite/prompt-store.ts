import { randomUUID } from "node:crypto";
import { primaryAnswerCreateIdempotencyKey } from "../../domain/delivery-intent.js";
import type { OutboxStore, PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation, PreparedDeliveryReservationInput } from "../../domain/ports/outbox.js";
import type { Binding, OutboundReply, OutboundWorkClass } from "../../domain/types.js";
import { RuntimeModelPreference, type ModelPreference } from "../../domain/model-selection.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { reduceRunCard } from "../../domain/run-card-view.js";
import { mapModelPreference, type ModelPreferenceRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import { incrementPrimaryAnswerPageSequence } from "./answer-page-sequence.js";
import type { SqliteProjectionStore } from "./projection-store.js";

export const queuedRunCardSelectionSql = `
  SELECT card.prompt_id, card.binding_id, card.binding_generation, card.conversion_parent_prompt_id,
    card.lark_message_id, card.answer_message_id, card.answer_card_id, card.answer_element_id,
    card.answer_sequence, card.answer_page_index, card.answer_page_start, card.phase, card.title,
    card.session_title, card.agent_kind, card.request_text, card.reply_context, card.workspace_id,
    card.space_name, card.pane_id, card.pane_token, card.task_list_json, card.task_list_title,
    card.current_goal_json, card.worker_activity_json, card.worker_dependency_revision,
    card.queue_position, card.queue_feedback_json,
    card.activity_at, card.view_version, card.delivered_version, card.answer_delivered_version,
    card.created_at, card.updated_at
  FROM prompt_jobs AS prompt INDEXED BY prompt_jobs_priority_queue
  JOIN run_cards AS card ON card.prompt_id = prompt.id
  WHERE prompt.binding_id = ? AND prompt.state = 'queued'
  ORDER BY prompt.created_at, prompt.rowid
`;

export interface PromptStoreDependencies {
  listBindings(): Binding[];
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): OutboundReply;
}

export class SqlitePromptStore {
  private readonly modelPreferences = new RuntimeModelPreference();
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;

  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: PromptStoreDependencies
  ) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  listBindings(): Binding[] { return this.dependencies.listBindings(); }

  countPendingPrompts(bindingId: string): number {
    const row = this.context.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE binding_id = ? AND state IN ('queued','submitted','running')").get(bindingId) as { count: number };
    return Number(row.count);
  }

  listQueuedTurnPromptIds(bindingId: string): string[] {
    return (this.context.database.prepare("SELECT id FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' ORDER BY created_at, rowid").all(bindingId) as Array<{ id: string }>).map((row) => row.id);
  }

  listQueuedTurnRunCards(bindingId: string): RunCardView[] {
    const rows = this.context.database.prepare(queuedRunCardSelectionSql).all(bindingId) as Array<Record<string, unknown>>;
    return rows.map(mapQueuedRunCard);
  }

  listCompletedOrdinaryTurnDurations(bindingId: string, limit: number): number[] {
    const boundedLimit = Math.max(0, Math.min(10, Math.floor(limit)));
    if (boundedLimit === 0) return [];
    const rows = this.context.database.prepare(`
      SELECT c.started_at, c.finished_at FROM prompt_jobs AS p
      JOIN run_cards AS c ON c.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state = 'delivered'
        AND p.observation_state = 'completed' AND p.was_detached = 0 AND c.phase = 'completed'
        AND c.started_at IS NOT NULL AND c.finished_at IS NOT NULL
        AND julianday(c.finished_at) > julianday(c.started_at)
      ORDER BY c.finished_at DESC LIMIT ?
    `).all(bindingId, boundedLimit) as Array<{ started_at: string; finished_at: string }>;
    return rows.map((row) => Date.parse(row.finished_at) - Date.parse(row.started_at)).filter((duration) => Number.isFinite(duration) && duration > 0);
  }

  loadQueueFeedbackInputs(bindingId: string): { activeStartedAt: string | null; queued: RunCardView[]; durationsMs: number[] } {
    const active = this.context.database.prepare(`
      SELECT c.started_at FROM prompt_jobs AS p
      JOIN run_cards AS c ON c.prompt_id = p.id
      JOIN bindings AS b ON b.id = p.binding_id
      WHERE p.binding_id = ? AND p.state IN ('submitted','running')
        AND p.observation_state = 'attached' AND p.was_detached = 0
        AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 1
    `).get(bindingId) as { started_at: string | null } | undefined;
    return { activeStartedAt: active?.started_at ?? null, queued: this.listQueuedTurnRunCards(bindingId), durationsMs: this.listCompletedOrdinaryTurnDurations(bindingId, 10) };
  }

  projectQueuedRunCards(input: { bindingId: string; projections: Array<{ expectedViewVersion: number; view: RunCardView; card: object | null }> }): { projected: RunCardView[]; stalePromptIds: string[]; outboxReserved: boolean } {
    if (input.projections.length === 0) return { projected: [], stalePromptIds: [], outboxReserved: false };
    return this.context.transaction("sqlite.prompt-store.write", () => {
      const projected: RunCardView[] = [];
      const stalePromptIds: string[] = [];
      let outboxReserved = false;
      const updateQueueProjection = this.context.database.prepare(`
        UPDATE run_cards SET queue_position = ?, queue_feedback_json = ?, view_version = ?, updated_at = ?
        WHERE prompt_id = ? AND binding_id = ? AND phase = 'queued' AND view_version = ?
          AND (queue_position IS NOT ? OR queue_feedback_json IS NOT ?)
      `);
      const loadQueueProjection = this.context.database.prepare("SELECT binding_id, phase, view_version, queue_position, queue_feedback_json FROM run_cards WHERE prompt_id = ?");
      const loadAnswerPage = this.context.database.prepare("SELECT page_index FROM answer_pages WHERE prompt_id = ? AND page_index = ?");
      for (const projection of input.projections) {
        const queueFeedbackJson = projection.view.queueFeedback === null ? null : JSON.stringify(projection.view.queueFeedback);
        const nextViewVersion = projection.expectedViewVersion + 1;
        const result = updateQueueProjection.run(
          projection.view.queuePosition, queueFeedbackJson, nextViewVersion, projection.view.updatedAt,
          projection.view.promptId, input.bindingId, projection.expectedViewVersion,
          projection.view.queuePosition, queueFeedbackJson
        );
        if (result.changes === 0) {
          const current = loadQueueProjection.get(projection.view.promptId) as { binding_id: string; phase: string; view_version: number; queue_position: number; queue_feedback_json: string | null } | undefined;
          const unchanged = current?.binding_id === input.bindingId && current.phase === "queued"
            && Number(current.view_version) === projection.expectedViewVersion
            && Number(current.queue_position) === projection.view.queuePosition
            && current.queue_feedback_json === queueFeedbackJson;
          if (!unchanged) stalePromptIds.push(projection.view.promptId);
          continue;
        }
        const view = { ...projection.view, viewVersion: nextViewVersion };
        projected.push(view);
        const answerPage = loadAnswerPage.get(view.promptId, view.answerPageIndex) as { page_index: number } | undefined;
        if (view.answerMessageId && projection.card) {
          const cardSequence = view.answerCardId && answerPage
            ? incrementPrimaryAnswerPageSequence(this.context, view.promptId, Number(answerPage.page_index))
            : null;
          const reply = this.reservePrimaryAnswer({ id: randomUUID(), idempotencyKey: `run-card:update:${view.promptId}:answer:${view.viewVersion}`, bindingId: view.bindingId, bindingGeneration: view.bindingGeneration, promptId: view.promptId, viewVersion: view.viewVersion, cardSequence, streamPageIndex: answerPage ? Number(answerPage.page_index) : null, cardRole: "answer", rootMessageId: view.answerMessageId, kind: "card_update", payload: JSON.stringify(projection.card) });
          outboxReserved ||= reply.state === "pending";
        }
      }
      return { projected, stalePromptIds, outboxReserved };
    });
  }

  ensureAnswerCard(promptId: string, rootMessageId: string, card: object, workClass?: OutboundWorkClass): void {
    const view = this.projections.loadRunCard(promptId);
    if (!view || view.answerMessageId) return;
    const idempotencyKey = primaryAnswerCreateIdempotencyKey(promptId);
    const existing = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key IN (?, ?) LIMIT 1").get(`answer-post:${promptId}:0`, idempotencyKey);
    if (existing) return;
    const prompt = this.context.database.prepare("SELECT binding_id FROM prompt_jobs WHERE id = ?").get(promptId) as { binding_id: string } | undefined;
    if (!prompt) throw new Error(`Prompt not found: ${promptId}`);
    this.reservePrimaryAnswer({ id: randomUUID(), idempotencyKey, bindingId: prompt.binding_id, bindingGeneration: view.bindingGeneration, promptId, viewVersion: view.viewVersion, cardRole: "answer", ...(workClass ? { workClass } : {}), rootMessageId, kind: "stream_card_create", payload: JSON.stringify(card) });
  }

  getModelPreference(bindingId: string): ModelPreference | null {
    const row = this.context.database.prepare("SELECT * FROM binding_model_preferences WHERE binding_id = ?").get(bindingId) as ModelPreferenceRow | undefined;
    return row ? mapModelPreference(row) : null;
  }

  acceptModelPreference(input: { bindingId: string; bindingGeneration: number; model: string }): { outcome: "accepted" | "busy" | "stale"; preference: ModelPreference | null } {
    return this.context.transaction("sqlite.prompt-store.write", () => {
      const binding = this.context.database.prepare("SELECT generation FROM bindings WHERE id = ?").get(input.bindingId) as { generation: number } | undefined;
      const decision = this.modelPreferences.request(this.getModelPreference(input.bindingId), { ...input, currentBindingGeneration: Number(binding?.generation ?? -1), updatedAt: now() });
      if (decision.outcome !== "accepted") return decision;
      const next = decision.preference;
      this.context.database.prepare(`INSERT INTO binding_model_preferences(binding_id, binding_generation, desired_model, desired_revision, effective_model, effective_revision, state, dispatch_prompt_id, prepared_operation_id, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 'pending', NULL, NULL, ?) ON CONFLICT(binding_id) DO UPDATE SET binding_generation = excluded.binding_generation, desired_model = excluded.desired_model, desired_revision = excluded.desired_revision, effective_model = CASE WHEN binding_model_preferences.binding_generation = excluded.binding_generation THEN binding_model_preferences.effective_model ELSE NULL END, effective_revision = CASE WHEN binding_model_preferences.binding_generation = excluded.binding_generation THEN binding_model_preferences.effective_revision ELSE NULL END, state = 'pending', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = excluded.updated_at`).run(next.bindingId, next.bindingGeneration, next.desiredModel, next.desiredRevision, next.updatedAt);
      return { outcome: "accepted", preference: this.getModelPreference(input.bindingId) };
    });
  }

  cancelQueuedPromptsWithProjection(input: { bindingId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): { cancelledPromptIds: string[]; outboxReserved: boolean } {
    return this.context.transaction("sqlite.prompt-store.write", () => {
      const rows = this.context.database.prepare(`SELECT p.id FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id WHERE p.binding_id = ? AND p.state = 'queued' ORDER BY p.created_at, p.rowid`).all(input.bindingId) as Array<{ id: string }>;
      if (rows.length === 0) return { cancelledPromptIds: [], outboxReserved: false };
      let outboxReserved = false;
      for (const row of rows) {
        const updated = this.context.database.prepare("UPDATE prompt_jobs SET state = 'cancelled', observation_state = 'completed', error = ?, updated_at = ? WHERE id = ? AND binding_id = ? AND state = 'queued'").run(input.reason, input.occurredAt, row.id, input.bindingId);
        if (Number(updated.changes) !== 1) throw new Error(`Queued prompt changed during cancellation: ${row.id}`);
        const current = this.projections.loadRunCard(row.id);
        if (!current) throw new Error(`Run card missing for prompt: ${row.id}`);
        const next = reduceRunCard(current, { type: "failed", occurredAt: input.occurredAt, notice: input.reason });
        this.projections.saveRunCard(next);
        const card = input.renderRunCard(next);
        const answerPage = this.projections.listAnswerPages(next.promptId).find(({ pageIndex }) => pageIndex === next.answerPageIndex);
        if (!next.answerCardId && next.answerMessageId) {
          this.reservePrimaryAnswer({ id: randomUUID(), idempotencyKey: `run-card:update:${next.promptId}:answer:${next.viewVersion}`, bindingId: next.bindingId, bindingGeneration: next.bindingGeneration, promptId: next.promptId, viewVersion: next.viewVersion, streamPageIndex: answerPage?.pageIndex ?? null, cardRole: "answer", rootMessageId: next.answerMessageId, kind: "card_update", payload: JSON.stringify(card) });
          outboxReserved = true;
        } else if (!next.answerCardId && !next.answerMessageId && input.rootMessageId) {
          const create = this.context.database.prepare("SELECT first_claimed_at FROM outbound_replies WHERE prompt_id = ? AND card_role = 'answer' AND kind = 'stream_card_create' AND state = 'pending' ORDER BY delivery_order LIMIT 1").get(next.promptId) as { first_claimed_at: string | null } | undefined;
          if (create) outboxReserved = true;
        }
      }
      return { cancelledPromptIds: rows.map((row) => row.id), outboxReserved };
    });
  }

  private reservePrimaryAnswer(input: PreparedDeliveryReservationInput): OutboundReply {
    if (!input.bindingId || input.bindingGeneration === null || input.bindingGeneration === undefined) {
      throw new Error("Primary Answer reservation requires an exact binding generation");
    }
    const current = this.context.database.prepare(`SELECT 1 FROM bindings
      WHERE id=? AND generation=? AND state='active' AND lifecycle='active' AND attachment='attached' AND pane_id IS NOT NULL`).get(
      input.bindingId, input.bindingGeneration
    );
    if (!current) throw new Error("Primary Answer binding generation changed before reservation");
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Prompt prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

}

function mapQueuedRunCard(row: Record<string, unknown>): RunCardView {
  return {
    promptId: String(row.prompt_id), bindingId: String(row.binding_id), bindingGeneration: Number(row.binding_generation),
    conversionParentPromptId: row.conversion_parent_prompt_id === null ? null : String(row.conversion_parent_prompt_id),
    larkMessageId: row.lark_message_id === null ? null : String(row.lark_message_id), answerMessageId: row.answer_message_id === null ? null : String(row.answer_message_id),
    answerCardId: row.answer_card_id === null ? null : String(row.answer_card_id), answerElementId: String(row.answer_element_id), answerSequence: Number(row.answer_sequence),
    answerPageIndex: Number(row.answer_page_index), answerPageStart: Number(row.answer_page_start), phase: "queued", title: String(row.title),
    ...(row.session_title === null ? {} : { sessionTitle: String(row.session_title) }), agentKind: String(row.agent_kind) as RunCardView["agentKind"], requestText: String(row.request_text),
    replyContext: row.reply_context === null ? null : String(row.reply_context), workspaceId: String(row.workspace_id), spaceName: String(row.space_name),
    paneId: row.pane_id === null ? null : String(row.pane_id), paneToken: row.pane_token === null ? null : String(row.pane_token),
    answer: "", answerSegments: [], answerDraft: "", answerDraftTransient: false, timelineItems: [], progressEvents: [],
    taskList: JSON.parse(String(row.task_list_json)) as RunCardView["taskList"], taskListTitle: row.task_list_title === null ? null : String(row.task_list_title),
    currentGoal: row.current_goal_json === null ? null : JSON.parse(String(row.current_goal_json)) as RunCardView["currentGoal"],
    progressSummary: { total: 0, stepTotal: 0, stepDone: 0 }, queuePosition: Number(row.queue_position),
    queueFeedback: row.queue_feedback_json === null ? null : JSON.parse(String(row.queue_feedback_json)) as RunCardView["queueFeedback"],
    startedAt: null, finishedAt: null, notice: null, workerActivity: JSON.parse(String(row.worker_activity_json)) as RunCardView["workerActivity"],
    workerDependencyRevision: Number(row.worker_dependency_revision), workerContextFrozenAt: null,
    activityAt: String(row.activity_at), viewVersion: Number(row.view_version), deliveredVersion: Number(row.delivered_version), answerDeliveredVersion: Number(row.answer_delivered_version),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}

function now(): string { return new Date().toISOString(); }
