import { randomUUID } from "node:crypto";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { Binding, OutboundReply, OutboundWorkClass } from "../../domain/types.js";
import type { ModelPreference } from "../../domain/model-selection.js";
import { acceptModelSelection } from "../../domain/model-selection.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { reduceRunCard } from "../../domain/run-card-view.js";
import { mapModelPreference, type ModelPreferenceRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteProjectionStore } from "./projection-store.js";

export interface PromptStoreDependencies {
  listBindings(): Binding[];
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): OutboundReply;
}

export class SqlitePromptStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: PromptStoreDependencies
  ) {}

  listBindings(): Binding[] { return this.dependencies.listBindings(); }

  countPendingPrompts(bindingId: string): number {
    const row = this.context.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE binding_id = ? AND state IN ('queued','running')").get(bindingId) as { count: number };
    return Number(row.count);
  }

  listQueuedTurnPromptIds(bindingId: string): string[] {
    return (this.context.database.prepare("SELECT id FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' ORDER BY created_at, rowid").all(bindingId) as Array<{ id: string }>).map((row) => row.id);
  }

  listQueuedTurnRunCards(bindingId: string): RunCardView[] {
    const rows = this.context.database.prepare(`
      SELECT view.state_json FROM prompt_jobs AS prompt
      JOIN run_cards_view AS view ON view.prompt_id = prompt.id
      WHERE prompt.binding_id = ? AND prompt.state = 'queued'
      ORDER BY prompt.created_at, prompt.rowid
    `).all(bindingId) as Array<{ state_json: string }>;
    return rows.map((row) => JSON.parse(row.state_json) as RunCardView);
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
      WHERE p.binding_id = ? AND p.state = 'running'
        AND p.observation_state = 'attached' AND p.was_detached = 0
        AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 1
    `).get(bindingId) as { started_at: string | null } | undefined;
    return { activeStartedAt: active?.started_at ?? null, queued: this.listQueuedTurnRunCards(bindingId), durationsMs: this.listCompletedOrdinaryTurnDurations(bindingId, 10) };
  }

  projectQueuedRunCards(input: { bindingId: string; projections: Array<{ expectedViewVersion: number; view: RunCardView; card: object | null }> }): { projected: RunCardView[]; stalePromptIds: string[]; outboxReserved: boolean } {
    if (input.projections.length === 0) return { projected: [], stalePromptIds: [], outboxReserved: false };
    return this.context.transaction(() => {
      const projected: RunCardView[] = [];
      const stalePromptIds: string[] = [];
      let outboxReserved = false;
      for (const projection of input.projections) {
        const current = this.projections.loadRunCard(projection.view.promptId);
        if (!current || current.bindingId !== input.bindingId || current.phase !== "queued" || current.viewVersion !== projection.expectedViewVersion) { stalePromptIds.push(projection.view.promptId); continue; }
        const view = this.projections.saveRunCard(projection.view);
        projected.push(view);
        if (view.answerMessageId && projection.card) {
          const reply = this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:update:${view.promptId}:answer:${view.viewVersion}`, bindingId: view.bindingId, promptId: view.promptId, viewVersion: view.viewVersion, cardRole: "answer", rootMessageId: view.answerMessageId, kind: "card_update", payload: JSON.stringify(projection.card) });
          outboxReserved ||= reply.state === "pending";
        }
      }
      return { projected, stalePromptIds, outboxReserved };
    });
  }

  ensureAnswerCard(promptId: string, rootMessageId: string, card: object, workClass?: OutboundWorkClass): void {
    const view = this.projections.loadRunCard(promptId);
    if (!view || view.answerMessageId) return;
    const existing = this.context.database.prepare("SELECT view_version, work_class FROM outbound_replies WHERE idempotency_key = ?").get(`run-card:create:${promptId}:answer`) as { view_version: number | null; work_class: OutboundWorkClass } | undefined;
    if (existing && (existing.view_version ?? 0) >= view.viewVersion) return;
    const prompt = this.context.database.prepare("SELECT binding_id FROM prompt_jobs WHERE id = ?").get(promptId) as { binding_id: string } | undefined;
    if (!prompt) throw new Error(`Prompt not found: ${promptId}`);
    this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:create:${promptId}:answer`, bindingId: prompt.binding_id, promptId, viewVersion: view.viewVersion, cardRole: "answer", ...(existing ? { workClass: existing.work_class } : workClass ? { workClass } : {}), rootMessageId, kind: "card_reply", payload: JSON.stringify(card) });
  }

  getModelPreference(bindingId: string): ModelPreference | null {
    const row = this.context.database.prepare("SELECT * FROM binding_model_preferences WHERE binding_id = ?").get(bindingId) as ModelPreferenceRow | undefined;
    return row ? mapModelPreference(row) : null;
  }

  acceptModelPreference(input: { bindingId: string; bindingGeneration: number; model: string }): { outcome: "accepted" | "busy" | "stale"; preference: ModelPreference | null } {
    return this.context.transaction(() => {
      const binding = this.context.database.prepare("SELECT generation FROM bindings WHERE id = ?").get(input.bindingId) as { generation: number } | undefined;
      const decision = acceptModelSelection(this.getModelPreference(input.bindingId), { ...input, currentBindingGeneration: Number(binding?.generation ?? -1), updatedAt: now() });
      if (decision.outcome !== "accepted") return decision;
      const next = decision.preference;
      this.context.database.prepare(`INSERT INTO binding_model_preferences(binding_id, binding_generation, desired_model, desired_revision, effective_model, effective_revision, state, dispatch_prompt_id, prepared_operation_id, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 'pending', NULL, NULL, ?) ON CONFLICT(binding_id) DO UPDATE SET binding_generation = excluded.binding_generation, desired_model = excluded.desired_model, desired_revision = excluded.desired_revision, effective_model = CASE WHEN binding_model_preferences.binding_generation = excluded.binding_generation THEN binding_model_preferences.effective_model ELSE NULL END, effective_revision = CASE WHEN binding_model_preferences.binding_generation = excluded.binding_generation THEN binding_model_preferences.effective_revision ELSE NULL END, state = 'pending', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = excluded.updated_at`).run(next.bindingId, next.bindingGeneration, next.desiredModel, next.desiredRevision, next.updatedAt);
      return { outcome: "accepted", preference: this.getModelPreference(input.bindingId) };
    });
  }

  cancelQueuedPromptsWithProjection(input: { bindingId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): { cancelledPromptIds: string[]; outboxReserved: boolean } {
    return this.context.transaction(() => {
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
        if (!next.answerCardId && next.answerMessageId) {
          this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:update:${next.promptId}:answer:${next.viewVersion}`, bindingId: next.bindingId, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: next.answerMessageId, kind: "card_update", payload: JSON.stringify(card) });
          outboxReserved = true;
        } else if (!next.answerCardId && !next.answerMessageId && input.rootMessageId) {
          const create = this.context.database.prepare("SELECT card_id_checkpoint FROM outbound_replies WHERE idempotency_key = ? AND state = 'pending'").get(`run-card:create:${next.promptId}:answer`) as { card_id_checkpoint: string | null } | undefined;
          if (create && !create.card_id_checkpoint) {
            this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:create:${next.promptId}:answer`, bindingId: next.bindingId, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify(card) });
            outboxReserved = true;
          }
        }
      }
      return { cancelledPromptIds: rows.map((row) => row.id), outboxReserved };
    });
  }

}

function now(): string { return new Date().toISOString(); }
