import { randomUUID } from "node:crypto";
import { estimateQueueWait } from "../../domain/queue-wait-estimate.js";
import type { AcceptPromptInput, DetachedPromptSkipResult } from "../../domain/ports/prompt.js";
import type { AdoptExternalTurnInput } from "../../domain/ports/workflow.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { Binding, DurablePromptWorkScan, ExternalTurnAdoption, OutboundReply, PromptJob, PromptObservationState, PromptState, PromptWorkHint, StalePromptClaim, TranscriptTurnClaimOutcome } from "../../domain/types.js";
import type { ModelPreference } from "../../domain/model-selection.js";
import { acceptModelSelection } from "../../domain/model-selection.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { freezeRunCardWorkerContext, reduceRunCard, updateRunCardWorkerContext, type RunCardChange } from "../../domain/run-card-view.js";
import { mirrorRunCardToTopic } from "../../domain/topic-view.js";
import { selectPrimaryWorkerActivity, type PrimaryWorkerActivitySummary } from "../../domain/card-context-summary.js";
import type { CardContextInvalidation, CardContextTarget } from "../../domain/card-context-invalidation.js";
import type { SessionTransition } from "../../domain/pane-thread-lifecycle.js";
import { mapBinding, mapModelPreference, mapPrompt, type BindingRow, type ModelPreferenceRow, type PromptRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteProjectionStore } from "./projection-store.js";

export interface PromptStoreDependencies {
  getBinding(id: string): Binding | null;
  persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  loadCardContextInvalidation(target: CardContextTarget): CardContextInvalidation | null;
  loadPrimaryWorkerActivity(promptId: string, bindingGeneration: number): PrimaryWorkerActivitySummary[];
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): OutboundReply;
}

export class SqlitePromptStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: PromptStoreDependencies
  ) {}

  getActiveOrdinaryPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    const rows = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id JOIN run_cards r ON r.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state = 'running'
        AND b.generation = ? AND r.binding_generation = b.generation AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 2`).all(bindingId, expectedGeneration) as PromptRow[];
    return rows.length === 1 ? mapPrompt(rows[0]!) : null;
  }

  getActiveExternalPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    const rows = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id JOIN run_cards r ON r.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state = 'running' AND p.execution_origin = 'herdr'
        AND p.transcript_turn_id IS NOT NULL AND p.transcript_turn_started_at IS NOT NULL
        AND b.generation = ? AND r.binding_generation = b.generation AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 2`).all(bindingId, expectedGeneration) as PromptRow[];
    return rows.length === 1 ? mapPrompt(rows[0]!) : null;
  }

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

  ensureAnswerCard(promptId: string, rootMessageId: string, card: object): void {
    const view = this.projections.loadRunCard(promptId);
    if (!view || view.answerMessageId) return;
    const existing = this.context.database.prepare("SELECT view_version FROM outbound_replies WHERE idempotency_key = ?").get(`run-card:create:${promptId}:answer`) as { view_version: number | null } | undefined;
    if (existing && (existing.view_version ?? 0) >= view.viewVersion) return;
    const prompt = this.requirePrompt(promptId);
    this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:create:${promptId}:answer`, bindingId: prompt.bindingId, promptId, viewVersion: view.viewVersion, cardRole: "answer", rootMessageId, kind: "card_reply", payload: JSON.stringify(card) });
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

  enqueuePrompt(input: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "priority" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin"> & Partial<Pick<PromptJob, "priority" | "wasDetached" | "executionOrigin">>): { prompt: PromptJob; inserted: boolean } {
    const timestamp = now();
    const statement = this.context.database.prepare(`
      INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, priority, was_detached, state, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?) ON CONFLICT(lark_message_id) DO NOTHING
    `);
    const inserted = statement.run(input.id, input.bindingId, input.larkMessageId, input.actorOpenId, input.body, input.priority ?? "normal", input.wasDetached ? 1 : 0, timestamp, timestamp).changes === 1;
    const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE lark_message_id = ?").get(input.larkMessageId) as PromptRow | undefined;
    if (!row) throw new Error(`Prompt not found: ${input.larkMessageId}`);
    return { prompt: mapPrompt(row), inserted };
  }

  acceptPrompt(input: AcceptPromptInput): { prompt: PromptJob; view: RunCardView; inserted: boolean } {
    return this.context.transaction(() => {
      const existing = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE lark_message_id = ?").get(input.prompt.larkMessageId) as PromptRow | undefined;
      if (existing) {
        const view = this.projections.loadRunCard(existing.id);
        if (!view) throw new Error(`Run card missing for prompt: ${existing.id}`);
        return { prompt: mapPrompt(existing), view, inserted: false };
      }
      if (input.expectedBindingGeneration !== undefined) {
        const binding = this.dependencies.getBinding(input.prompt.bindingId);
        if (!binding || binding.generation !== input.expectedBindingGeneration || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") throw new Error("Binding generation changed before prompt acceptance");
      }
      if (input.maxQueueDepth !== undefined && this.countPendingPrompts(input.prompt.bindingId) >= input.maxQueueDepth) throw new Error("This topic's prompt queue is full");
      if (input.prompt.priority === "priority") {
        if (this.context.database.prepare("SELECT 1 FROM prompt_jobs WHERE binding_id = ? AND priority = 'priority' AND state IN ('queued','running') LIMIT 1").get(input.prompt.bindingId)) throw new Error("Primary binding already has a live priority turn");
        if (this.context.database.prepare("SELECT 1 FROM prompt_jobs WHERE binding_id = ? AND state = 'running' LIMIT 1").get(input.prompt.bindingId)) throw new Error("Primary binding already has an active runtime turn");
      }
      const timestamp = now();
      this.context.database.prepare(`INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, priority, was_detached, state, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`)
        .run(input.prompt.id, input.prompt.bindingId, input.prompt.larkMessageId, input.prompt.actorOpenId, input.prompt.body, input.prompt.priority ?? "normal", input.prompt.wasDetached ? 1 : 0, timestamp, timestamp);
      const view = input.view;
      this.projections.insertRunCard(view);
      this.context.database.prepare(`INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, card_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
        .run(randomUUID(), `run-card:create:${input.prompt.id}:answer`, input.prompt.bindingId, input.prompt.id, view.viewVersion, "answer", input.rootMessageId, "stream_card_create", JSON.stringify(input.answerCard), `answer:${input.prompt.id}`, timestamp, timestamp, timestamp);
      return { prompt: this.requirePrompt(input.prompt.id), view: this.projections.loadRunCard(input.prompt.id)!, inserted: true };
    });
  }

  claimNextDispatchablePrompt(bindingId: string): { binding: Binding; prompt: PromptJob; model: { name: string; revision: number } | null } | null {
    return this.context.transaction(() => {
      const bindingRow = this.context.database.prepare(`
        SELECT * FROM bindings WHERE id = ? AND state = 'active' AND lifecycle = 'active'
          AND attachment = 'attached' AND pane_id IS NOT NULL AND last_agent_state IN ('idle','done')
      `).get(bindingId) as BindingRow | undefined;
      if (!bindingRow) return null;
      const row = this.context.database.prepare(`
        SELECT p.* FROM prompt_jobs p
        WHERE p.binding_id = ? AND p.state = 'queued'
          AND NOT EXISTS (SELECT 1 FROM prompt_jobs active WHERE active.binding_id = p.binding_id AND active.state = 'running')
        ORDER BY CASE p.priority WHEN 'priority' THEN 0 ELSE 1 END, p.created_at, p.rowid LIMIT 1
      `).get(bindingId) as PromptRow | undefined;
      if (!row) return null;
      const claimed = this.context.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'not_started', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'queued'").run(now(), row.id);
      if (Number(claimed.changes) !== 1) throw new Error(`Prompt ${row.id} was not atomically claimed`);
      const preference = this.context.database.prepare("SELECT * FROM binding_model_preferences WHERE binding_id = ? AND binding_generation = ? AND state = 'pending'").get(bindingId, Number(bindingRow.generation)) as ModelPreferenceRow | undefined;
      if (preference) {
        const pinned = this.context.database.prepare("UPDATE prompt_jobs SET model_name = ?, model_revision = ? WHERE id = ? AND model_revision IS NULL").run(preference.desired_model, preference.desired_revision, row.id);
        const applying = this.context.database.prepare("UPDATE binding_model_preferences SET state = 'applying', dispatch_prompt_id = ?, prepared_operation_id = NULL, updated_at = ? WHERE binding_id = ? AND binding_generation = ? AND desired_revision = ? AND state = 'pending'").run(row.id, now(), bindingId, Number(bindingRow.generation), preference.desired_revision);
        if (Number(pinned.changes) !== 1 || Number(applying.changes) !== 1) throw new Error(`Model revision ${preference.desired_revision} was not atomically pinned`);
      }
      const promptRow = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(row.id) as PromptRow;
      return { binding: mapBinding(bindingRow), prompt: mapPrompt(promptRow), model: preference ? { name: mapModelPreference(preference).desiredModel, revision: Number(preference.desired_revision) } : null };
    });
  }

  updatePrompt(id: string, state: PromptState, error: string | null = null): void {
    const observationState: PromptObservationState = state === "queued" ? "not_started" : state === "running" ? "attached" : "completed";
    this.context.database.prepare("UPDATE prompt_jobs SET state = ?, observation_state = ?, error = ?, updated_at = ? WHERE id = ?").run(state, observationState, error, now(), id);
  }

  completeTurn(input: { promptId: string; bindingId: string; answer: string; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): Binding {
    return this.context.transaction(() => {
      this.context.database.prepare("UPDATE prompt_jobs SET state = 'delivered', observation_state = 'completed', error = NULL, updated_at = ? WHERE id = ? AND binding_id = ?")
        .run(input.occurredAt, input.promptId, input.bindingId);
      this.dependencies.persistBindingPatch(input.bindingId, { lastOutputFingerprint: input.outputFingerprint });
      const binding = this.dependencies.transitionBinding(input.bindingId, { type: "turn_completed" });
      this.persistTerminalRunCard(input.promptId, { type: "completed", occurredAt: input.occurredAt, answer: input.answer, ...(input.replaceAnswer === undefined ? {} : { replaceAnswer: input.replaceAnswer }) });
      return binding;
    });
  }

  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void {
    this.context.transaction(() => {
      this.context.database.prepare(`
        UPDATE binding_model_preferences
        SET state = CASE WHEN prepared_operation_id IS NULL THEN 'pending' ELSE 'uncertain' END,
          dispatch_prompt_id = CASE WHEN prepared_operation_id IS NULL THEN NULL ELSE dispatch_prompt_id END,
          updated_at = ?
        WHERE state = 'applying' AND dispatch_prompt_id = ?
          AND EXISTS (
            SELECT 1 FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
            WHERE p.id = ? AND p.binding_id = binding_model_preferences.binding_id
              AND b.generation = binding_model_preferences.binding_generation
              AND p.model_name = binding_model_preferences.desired_model
              AND p.model_revision = binding_model_preferences.desired_revision
          )
      `).run(input.occurredAt, input.promptId, input.promptId);
      this.context.database.prepare("UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ?, updated_at = ? WHERE id = ?")
        .run(input.error, input.occurredAt, input.promptId);
      this.persistTerminalRunCard(input.promptId, { type: "failed", occurredAt: input.occurredAt, notice: input.error });
    });
  }

  settleDetachedPrompt(input: { promptId: string; bindingId: string; runtime: Binding["lastAgentState"]; occurredAt: string; terminal: { kind: "completed"; answer: string; outputFingerprint: string } | { kind: "failed"; error: string } }): boolean {
    return this.context.transaction(() => {
      const nextState = input.terminal.kind === "completed" ? "delivered" : "failed";
      const error = input.terminal.kind === "failed" ? input.terminal.error : null;
      const changed = this.context.database.prepare(`
        UPDATE prompt_jobs SET state = ?, observation_state = 'completed', error = ?, updated_at = ?
        WHERE id = ? AND binding_id = ? AND state = 'running' AND observation_state = 'detached'
      `).run(nextState, error, input.occurredAt, input.promptId, input.bindingId);
      if (Number(changed.changes) !== 1) return false;
      this.dependencies.transitionBinding(input.bindingId, { type: "pane_observed", runtime: input.runtime });
      if (input.terminal.kind === "completed") {
        this.dependencies.persistBindingPatch(input.bindingId, { lastOutputFingerprint: input.terminal.outputFingerprint });
        this.dependencies.transitionBinding(input.bindingId, { type: "turn_completed" });
        this.persistTerminalRunCard(input.promptId, { type: "completed", occurredAt: input.occurredAt, answer: input.terminal.answer, replaceAnswer: true });
      } else {
        this.persistTerminalRunCard(input.promptId, { type: "failed", occurredAt: input.occurredAt, notice: input.terminal.error });
      }
      return true;
    });
  }

  private persistTerminalRunCard(promptId: string, change: RunCardChange): void {
    const current = this.projections.loadRunCard(promptId);
    if (!current) throw new Error(`Run card missing for prompt: ${promptId}`);
    let next = reduceRunCard(current, change);
    if (next.phase === "completed" || next.phase === "failed") {
      const invalidation = this.dependencies.loadCardContextInvalidation({ targetKind: "primary-turn", targetId: next.promptId, targetGeneration: next.bindingGeneration });
      const revision = Math.max(next.workerDependencyRevision, invalidation?.requestedDependencyRevision ?? 0);
      next = freezeRunCardWorkerContext(updateRunCardWorkerContext(next, selectPrimaryWorkerActivity(this.dependencies.loadPrimaryWorkerActivity(next.promptId, next.bindingGeneration)), revision, change.occurredAt), change.occurredAt);
    }
    if (next !== current) this.projections.saveRunCard(next);
    const topic = this.projections.loadTopicView(current.bindingId);
    if (topic) this.projections.saveTopicView(mirrorRunCardToTopic(topic, next));
  }

  markPromptObservationDetached(id: string, notice: string): void {
    const timestamp = now();
    this.context.transaction(() => {
      const result = this.context.database.prepare("UPDATE prompt_jobs SET observation_state = 'detached', was_detached = 1, error = ?, updated_at = ? WHERE id = ? AND state = 'running' AND observation_state = 'attached'").run(notice, timestamp, id);
      if (result.changes > 0) this.context.database.prepare(`
        UPDATE binding_model_preferences SET state = 'uncertain', updated_at = ?
        WHERE state = 'applying' AND dispatch_prompt_id = ?
          AND EXISTS (SELECT 1 FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE p.id = ? AND p.binding_id = binding_model_preferences.binding_id AND b.generation = binding_model_preferences.binding_generation AND p.model_name = binding_model_preferences.desired_model AND p.model_revision = binding_model_preferences.desired_revision)
      `).run(timestamp, id, id);
      if (result.changes > 0) this.context.database.prepare("UPDATE run_cards SET notice = ?, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ? AND phase IN ('running','blocked')").run(notice, timestamp, id);
    });
  }

  markPromptDispatched(id: string, dispatchedAt = now()): void {
    const dispatchedAtMs = Date.parse(dispatchedAt);
    if (!Number.isFinite(dispatchedAtMs) || new Date(dispatchedAtMs).toISOString() !== dispatchedAt) throw new Error("Invalid prompt dispatch timestamp");
    this.context.database.prepare("UPDATE prompt_jobs SET observation_state = 'attached', dispatched_at = ?, error = NULL, updated_at = ? WHERE id = ? AND state = 'running'").run(dispatchedAt, now(), id);
  }

  markModelPromptPrepared(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string }): boolean {
    const changed = this.context.database.prepare(`UPDATE binding_model_preferences SET prepared_operation_id = ?, updated_at = ? WHERE binding_id = ? AND binding_generation = ? AND desired_revision = ? AND dispatch_prompt_id = ? AND state = 'applying' AND (prepared_operation_id IS NULL OR prepared_operation_id = ?)`).run(input.operationId, now(), input.bindingId, input.bindingGeneration, input.revision, input.promptId, input.operationId);
    return Number(changed.changes) === 1;
  }

  markModelPromptAccepted(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string; turnId: string }): boolean {
    return this.context.transaction(() => {
      const timestamp = now();
      const preference = this.context.database.prepare(`UPDATE binding_model_preferences SET effective_model = desired_model, effective_revision = desired_revision, state = 'effective', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = ? WHERE binding_id = ? AND binding_generation = ? AND desired_revision = ? AND dispatch_prompt_id = ? AND prepared_operation_id = ? AND state = 'applying'`).run(timestamp, input.bindingId, input.bindingGeneration, input.revision, input.promptId, input.operationId);
      if (Number(preference.changes) !== 1) return false;
      const prompt = this.context.database.prepare("UPDATE prompt_jobs SET transcript_turn_id = ?, updated_at = ? WHERE id = ? AND binding_id = ? AND model_revision = ? AND state = 'running' AND (transcript_turn_id IS NULL OR transcript_turn_id = ?)").run(input.turnId, timestamp, input.promptId, input.bindingId, input.revision, input.turnId);
      if (Number(prompt.changes) !== 1) throw new Error(`Model prompt ${input.promptId} acceptance was not atomically fenced`);
      return true;
    });
  }

  rollbackPreparedModelPrompt(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string }): boolean {
    return this.context.transaction(() => {
      const timestamp = now();
      const prompt = this.context.database.prepare(`UPDATE prompt_jobs SET dispatched_at = NULL, updated_at = ? WHERE id = ? AND binding_id = ? AND model_revision = ? AND state = 'running' AND observation_state = 'attached' AND transcript_turn_id IS NULL`).run(timestamp, input.promptId, input.bindingId, input.revision);
      if (Number(prompt.changes) !== 1) return false;
      const preference = this.context.database.prepare(`UPDATE binding_model_preferences SET state = 'pending', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = ? WHERE binding_id = ? AND binding_generation = ? AND desired_revision = ? AND dispatch_prompt_id = ? AND prepared_operation_id = ? AND state = 'applying'`).run(timestamp, input.bindingId, input.bindingGeneration, input.revision, input.promptId, input.operationId);
      if (Number(preference.changes) !== 1) throw new Error(`Model prompt ${input.promptId} abort was not atomically fenced`);
      return true;
    });
  }

  claimPromptTranscriptTurn(input: { promptId: string; bindingId: string; turnId: string; startedAt: string }): TranscriptTurnClaimOutcome {
    return this.context.transaction(() => {
      const before = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ? AND binding_id = ?").get(input.promptId, input.bindingId) as PromptRow | undefined;
      if (!before) return { state: "ineligible", prompt: null };
      if (before.transcript_turn_id !== null && (before.transcript_turn_id !== input.turnId || before.transcript_turn_started_at !== null)) return { state: before.transcript_turn_id === input.turnId ? "matched" : "conflict", prompt: mapPrompt(before) };
      const startedAtMs = Date.parse(input.startedAt);
      const dispatchedAtMs = before.dispatched_at === null ? Number.NaN : Date.parse(before.dispatched_at);
      if (!Number.isFinite(startedAtMs) || !Number.isFinite(dispatchedAtMs) || startedAtMs < dispatchedAtMs - 1_000) return { state: "ineligible", prompt: mapPrompt(before) };
      const result = this.context.database.prepare(`UPDATE prompt_jobs SET transcript_turn_id = ?, transcript_turn_started_at = ?, updated_at = ? WHERE id = ? AND binding_id = ? AND state = 'running' AND (observation_state = 'attached' OR (observation_state = 'detached' AND transcript_turn_id = ? AND transcript_turn_started_at IS NULL)) AND dispatched_at IS NOT NULL AND (transcript_turn_id IS NULL OR (transcript_turn_id = ? AND transcript_turn_started_at IS NULL))`).run(input.turnId, input.startedAt, now(), input.promptId, input.bindingId, input.turnId, input.turnId);
      const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ? AND binding_id = ?").get(input.promptId, input.bindingId) as PromptRow | undefined;
      if (!row) throw new Error(`Prompt disappeared while claiming transcript turn: ${input.promptId}`);
      return { state: result.changes > 0 ? "claimed" : row.transcript_turn_id === input.turnId ? "matched" : row.transcript_turn_id === null ? "ineligible" : "conflict", prompt: mapPrompt(row) };
    });
  }

  adoptExternalTurn(input: AdoptExternalTurnInput): ExternalTurnAdoption {
    return this.context.transaction(() => {
      const binding = this.context.database.prepare("SELECT * FROM bindings WHERE id = ?").get(input.bindingId) as BindingRow | undefined;
      if (!binding || !binding.root_message_id || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached" || Number(binding.generation) !== input.expectedGeneration || binding.pane_id !== input.expectedPaneId
        || binding.agent_session_source !== input.expectedSession.source || binding.agent_session_agent !== input.expectedSession.agent || binding.agent_session_kind !== input.expectedSession.kind || binding.agent_session_value !== input.expectedSession.value) {
        return { outcome: "stale_binding", prompt: null, supersededPromptIds: [], outboxReserved: false };
      }
      const owners = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE transcript_turn_id = ? ORDER BY id LIMIT 2").all(input.turnId) as PromptRow[];
      const owned = owners[0];
      if (owned) return { outcome: owners.length === 1 && owned.binding_id === input.bindingId ? "already_owned" : "conflict", prompt: mapPrompt(owned), supersededPromptIds: [], outboxReserved: false };
      const active = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE binding_id = ? AND state = 'running' ORDER BY created_at, id").all(input.bindingId) as PromptRow[];
      const superseded = input.supersede;
      const supersessionIsFenced = superseded !== undefined
        && active.length === 1
        && active[0]!.id === superseded.promptId
        && active[0]!.observation_state === "detached"
        && active[0]!.transcript_turn_id === superseded.turnId
        && active[0]!.transcript_turn_started_at === superseded.startedAt
        && Date.parse(input.startedAt) > Date.parse(superseded.startedAt);
      const identitylessDetached = active.every((row) => row.observation_state === "detached" && row.transcript_turn_id === null);
      if (!identitylessDetached && !supersessionIsFenced) return { outcome: "conflict", prompt: null, supersededPromptIds: [], outboxReserved: false };
      const timestamp = now();
      const supersededPromptIds = active.map((row) => row.id);
      for (const row of active) {
        this.context.database.prepare("UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ?, updated_at = ? WHERE id = ?").run("Superseded by a newer external Herdr turn; prior outcome is uncertain", timestamp, row.id);
        this.context.database.prepare("UPDATE run_cards SET phase = 'failed', finished_at = ?, notice = ?, queue_position = 0, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ? AND phase IN ('running','blocked')").run(input.startedAt, "A newer Herdr turn started while this detached turn had an uncertain outcome.", timestamp, row.id);
      }
      const normalizedRequest = normalizeExternalRequest(input.requestText);
      const candidates = input.supersede ? [] : (this.context.database.prepare(`
        SELECT p.* FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
        WHERE p.binding_id = ? AND p.state = 'queued' AND p.observation_state = 'not_started'
          AND c.binding_generation = ? AND c.pane_id = ? AND p.created_at <= ?
        ORDER BY p.created_at, p.id
      `).all(input.bindingId, input.expectedGeneration, input.expectedPaneId, input.startedAt) as PromptRow[])
        .filter((row) => normalizeExternalRequest(row.body) === normalizedRequest);
      let promptId: string;
      let outcome: ExternalTurnAdoption["outcome"];
      let outboxReserved = false;
      if (candidates.length === 1) {
        promptId = candidates[0]!.id;
        outcome = "adopted_queued";
        this.context.database.prepare(`UPDATE prompt_jobs SET execution_origin = 'herdr', state = 'running', observation_state = 'attached', dispatched_at = ?, transcript_turn_id = ?, transcript_turn_started_at = ?, error = NULL, updated_at = ? WHERE id = ?`).run(input.startedAt, input.turnId, input.startedAt, timestamp, promptId);
        const queuedView = this.projections.loadRunCard(promptId)!;
        const runningView = reduceRunCard(queuedView, { type: "started", occurredAt: input.startedAt });
        outboxReserved = Number(this.context.database.prepare("UPDATE outbound_replies SET payload = ?, view_version = ?, updated_at = ? WHERE prompt_id = ? AND kind = 'stream_card_create' AND card_role = 'answer' AND state = 'pending'").run(JSON.stringify(input.answerCardFor(runningView)), runningView.viewVersion, timestamp, promptId).changes) > 0;
      } else {
        promptId = input.externalPromptId;
        outcome = "created_external";
        this.context.database.prepare(`INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, execution_origin, state, observation_state, dispatched_at, transcript_turn_id, transcript_turn_started_at, attempt_count, created_at, updated_at) VALUES (?, ?, ?, 'herdr', ?, 'herdr', 'running', 'attached', ?, ?, ?, 1, ?, ?)`).run(promptId, input.bindingId, input.externalMessageId, input.requestText, input.startedAt, input.turnId, input.startedAt, input.startedAt, timestamp);
        const view = { ...input.externalView, promptId, bindingId: input.bindingId, bindingGeneration: input.expectedGeneration, paneId: input.expectedPaneId, requestText: input.requestText, queuePosition: 0 };
        const runningView = reduceRunCard(view, { type: "started", occurredAt: input.startedAt });
        this.projections.insertRunCard(view);
        this.context.database.prepare(`INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, card_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'answer', ?, 'stream_card_create', ?, ?, 'pending', 0, ?, ?, ?)`).run(randomUUID(), `run-card:create:${promptId}:answer`, input.bindingId, promptId, runningView.viewVersion, binding.root_message_id, JSON.stringify(input.answerCardFor(runningView)), `answer:${promptId}`, timestamp, timestamp, timestamp);
        outboxReserved = true;
      }
      return { outcome, prompt: this.requirePrompt(promptId), supersededPromptIds, outboxReserved };
    });
  }

  listStaleUndispatchedPromptClaims(updatedBefore: string, limit: number): StalePromptClaim[] {
    if (!Number.isFinite(Date.parse(updatedBefore))) throw new Error("Invalid stale prompt cutoff");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Invalid stale prompt claim limit");
    const rows = this.context.database.prepare(`
      SELECT p.id, p.binding_id, p.updated_at
      FROM prompt_jobs p
      LEFT JOIN binding_model_preferences preference ON preference.dispatch_prompt_id = p.id
      WHERE p.state = 'running' AND p.observation_state = 'not_started'
        AND p.dispatched_at IS NULL AND p.transcript_turn_id IS NULL
        AND preference.prepared_operation_id IS NULL AND p.updated_at < ?
      ORDER BY p.updated_at, p.rowid LIMIT ?
    `).all(updatedBefore, limit) as Array<{ id: string; binding_id: string; updated_at: string }>;
    return rows.map((row) => ({ promptId: row.id, bindingId: row.binding_id, updatedAt: row.updated_at }));
  }

  recoverRunningPrompts(): number {
    const timestamp = now();
    return this.context.transaction(() => {
      const safeModelClaims = this.context.database.prepare(`SELECT p.id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id JOIN binding_model_preferences preference ON preference.binding_id = p.binding_id AND preference.binding_generation = b.generation AND preference.desired_revision = p.model_revision AND preference.desired_model = p.model_name AND preference.dispatch_prompt_id = p.id WHERE p.state = 'running' AND p.observation_state = 'not_started' AND p.model_name IS NOT NULL AND p.model_revision IS NOT NULL AND preference.state = 'applying' AND preference.prepared_operation_id IS NULL`).all() as Array<{ id: string }>;
      this.context.database.prepare(`UPDATE binding_model_preferences SET state = 'pending', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = ? WHERE state = 'applying' AND prepared_operation_id IS NULL AND dispatch_prompt_id IN (${safeModelClaims.length > 0 ? safeModelClaims.map(() => "?").join(", " ) : "NULL"})`).run(timestamp, ...safeModelClaims.map((prompt) => prompt.id));
      if (safeModelClaims.length > 0) {
        const placeholders = safeModelClaims.map(() => "?").join(", " );
        this.context.database.prepare(`UPDATE prompt_jobs SET state = 'queued', observation_state = 'not_started', model_name = NULL, model_revision = NULL, error = NULL, updated_at = ? WHERE id IN (${placeholders}) AND state = 'running' AND observation_state = 'not_started'`).run(timestamp, ...safeModelClaims.map((prompt) => prompt.id));
      }
      this.context.database.prepare(`UPDATE binding_model_preferences SET state = 'uncertain', updated_at = ? WHERE state = 'applying' AND prepared_operation_id IS NOT NULL AND EXISTS (SELECT 1 FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE p.id = binding_model_preferences.dispatch_prompt_id AND p.binding_id = binding_model_preferences.binding_id AND b.generation = binding_model_preferences.binding_generation AND p.model_name = binding_model_preferences.desired_model AND p.model_revision = binding_model_preferences.desired_revision AND p.state = 'running' AND p.observation_state = 'not_started')`).run(timestamp);
      const undispatched = this.context.database.prepare("SELECT id FROM prompt_jobs WHERE state = 'running' AND observation_state = 'not_started' AND model_name IS NULL AND model_revision IS NULL").all() as Array<{ id: string }>;
      this.context.database.prepare("UPDATE prompt_jobs SET state = 'queued', observation_state = 'not_started', error = NULL, updated_at = ? WHERE state = 'running' AND observation_state = 'not_started' AND model_name IS NULL AND model_revision IS NULL").run(timestamp);
      for (const prompt of undispatched) this.context.database.prepare("UPDATE run_cards SET phase = 'queued', started_at = NULL, notice = NULL, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?").run(timestamp, prompt.id);
      const running = this.context.database.prepare("SELECT id FROM prompt_jobs WHERE state = 'running'").all() as Array<{ id: string }>;
      const result = this.context.database.prepare("UPDATE prompt_jobs SET observation_state = 'detached', was_detached = 1, error = 'Bridge restarted after dispatch; observing the existing TraeX turn without replay', updated_at = ? WHERE state = 'running'").run(timestamp);
      for (const prompt of running) {
        this.context.database.prepare("UPDATE run_cards SET phase = 'running', finished_at = NULL, queue_position = 0, notice = ?, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?").run("Bridge 已重连，正在观察原 TraeX 任务；不会重复发送请求", timestamp, prompt.id);
      }
      return safeModelClaims.length + undispatched.length + Number(result.changes);
    });
  }

  scanDurablePromptWork(): DurablePromptWorkScan {
    const timestamp = now();
    const reason = "Session can no longer dispatch queued work";
    const detachedReason = "Session ended while a dispatched turn was detached; the prompt was not replayed";
    return this.context.transaction(() => {
      const terminalBindings = `SELECT id FROM bindings WHERE state IN ('archived', 'orphaned', 'failed') OR lifecycle IN ('archived', 'closed', 'failed') OR attachment = 'orphaned'`;
      const result = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'cancelled', observation_state = 'completed', error = ?, updated_at = ? WHERE state = 'queued' AND binding_id IN (${terminalBindings})`).run(reason, timestamp);
      this.context.database.prepare(`UPDATE run_cards SET phase = 'failed', notice = ?, finished_at = ?, queue_position = 0, activity_at = ?, view_version = view_version + 1, updated_at = ? WHERE phase = 'queued' AND binding_id IN (${terminalBindings})`).run(reason, timestamp, timestamp, timestamp);
      const terminalDetachedPrompts = `SELECT p.id FROM prompt_jobs p WHERE p.state = 'running' AND p.observation_state = 'detached' AND p.binding_id IN (${terminalBindings})`;
      this.context.database.prepare(`UPDATE run_cards SET phase = 'failed', notice = ?, finished_at = ?, queue_position = 0, activity_at = ?, view_version = view_version + 1, updated_at = ? WHERE prompt_id IN (${terminalDetachedPrompts})`).run(detachedReason, timestamp, timestamp, timestamp);
      const detachedResult = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', was_detached = 1, error = ?, updated_at = ? WHERE state = 'running' AND observation_state = 'detached' AND binding_id IN (${terminalBindings})`).run(detachedReason, timestamp);
      const hints: PromptWorkHint[] = [];
      const detached = this.context.database.prepare(`SELECT p.id, p.binding_id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE p.state = 'running' AND p.observation_state = 'detached' AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL ORDER BY p.created_at, p.id`).all() as Array<{ id: string; binding_id: string }>;
      for (const row of detached) hints.push({ kind: "detached-observer-ready", bindingId: row.binding_id, promptId: row.id });
      const turns = this.context.database.prepare(`SELECT DISTINCT p.binding_id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE p.state = 'queued' AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM prompt_jobs active WHERE active.binding_id = p.binding_id AND active.state = 'running') ORDER BY p.binding_id`).all() as Array<{ binding_id: string }>;
      for (const row of turns) hints.push({ kind: "prompt-ready", bindingId: row.binding_id });
      return { cancelled: Number(result.changes), failedDetached: Number(detachedResult.changes), hints };
    });
  }

  requeueStaleUndispatchedPromptClaim(candidate: StalePromptClaim): boolean {
    return this.context.transaction(() => {
      const row = this.context.database.prepare(`
        SELECT p.model_name, p.model_revision, preference.state AS preference_state, preference.prepared_operation_id
        FROM prompt_jobs p
        LEFT JOIN bindings b ON b.id = p.binding_id
        LEFT JOIN binding_model_preferences preference ON preference.dispatch_prompt_id = p.id AND preference.binding_id = p.binding_id AND preference.binding_generation = b.generation AND preference.desired_model = p.model_name AND preference.desired_revision = p.model_revision
        WHERE p.id = ? AND p.binding_id = ? AND p.updated_at = ?
          AND p.state = 'running' AND p.observation_state = 'not_started'
          AND p.dispatched_at IS NULL AND p.transcript_turn_id IS NULL AND preference.prepared_operation_id IS NULL
      `).get(candidate.promptId, candidate.bindingId, candidate.updatedAt) as { model_name: string | null; model_revision: number | null; preference_state: string | null; prepared_operation_id: string | null } | undefined;
      if (!row) return false;
      const hasModel = row.model_name !== null || row.model_revision !== null;
      if (hasModel && row.preference_state !== "applying") return false;
      const timestamp = now();
      if (hasModel) this.context.database.prepare(`UPDATE binding_model_preferences SET state = 'pending', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = ? WHERE dispatch_prompt_id = ? AND state = 'applying' AND prepared_operation_id IS NULL`).run(timestamp, candidate.promptId);
      const result = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'queued', observation_state = 'not_started', model_name = NULL, model_revision = NULL, error = NULL, updated_at = ? WHERE id = ? AND binding_id = ? AND updated_at = ? AND state = 'running' AND observation_state = 'not_started' AND dispatched_at IS NULL AND transcript_turn_id IS NULL`).run(timestamp, candidate.promptId, candidate.bindingId, candidate.updatedAt);
      if (Number(result.changes) !== 1) throw new Error("Stale prompt claim changed during recovery");
      this.context.database.prepare(`UPDATE run_cards SET phase = 'queued', started_at = NULL, finished_at = NULL, notice = NULL, queue_position = 1, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?`).run(timestamp, candidate.promptId);
      return true;
    });
  }

  listDetachedPrompts(): PromptJob[] {
    return (this.context.database.prepare("SELECT * FROM prompt_jobs WHERE state = 'running' AND observation_state = 'detached' ORDER BY created_at, id").all() as PromptRow[]).map(mapPrompt);
  }

  skipOldestDetachedPrompt(input: { bindingId: string; expectedBindingGeneration: number; actorOpenId: string; sourceMessageId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): DetachedPromptSkipResult {
    return this.context.transaction(() => {
      const binding = this.context.database.prepare("SELECT generation, lifecycle, state FROM bindings WHERE id = ?").get(input.bindingId) as { generation: number; lifecycle: string; state: string } | undefined;
      if (!binding || Number(binding.generation) !== input.expectedBindingGeneration || binding.lifecycle !== "active" || binding.state !== "active") return { outcome: "stale" };
      const candidate = this.context.database.prepare(`SELECT p.id FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id WHERE p.binding_id = ? AND c.binding_generation = ? AND p.state = 'running' AND p.observation_state = 'detached' ORDER BY p.created_at, p.rowid LIMIT 1`).get(input.bindingId, input.expectedBindingGeneration) as { id: string } | undefined;
      if (!candidate) return { outcome: "none" };
      const changed = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ?, updated_at = ? WHERE id = ? AND binding_id = ? AND state = 'running' AND observation_state = 'detached' AND EXISTS (SELECT 1 FROM run_cards c WHERE c.prompt_id = prompt_jobs.id AND c.binding_generation = ?)`).run(input.reason, input.occurredAt, candidate.id, input.bindingId, input.expectedBindingGeneration);
      if (Number(changed.changes) !== 1) return { outcome: "stale" };
      const current = this.projections.loadRunCard(candidate.id);
      if (!current) throw new Error(`Run card missing for prompt: ${candidate.id}`);
      const next = reduceRunCard(current, { type: "failed", occurredAt: input.occurredAt, notice: input.reason });
      this.projections.saveRunCard(next);
      const topic = this.projections.loadTopicView(input.bindingId);
      if (topic) this.projections.saveTopicView(mirrorRunCardToTopic(topic, next));
      let outboxReserved = false;
      if (next.answerMessageId) {
        this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:update:${next.promptId}:answer:${next.viewVersion}`, bindingId: next.bindingId, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: next.answerMessageId, kind: "card_update", payload: JSON.stringify(input.renderRunCard(next)) });
        outboxReserved = true;
      } else if (input.rootMessageId) {
        const pendingCreate = this.context.database.prepare("SELECT idempotency_key FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' ORDER BY delivery_order LIMIT 1").get(next.promptId) as { idempotency_key: string } | undefined;
        if (pendingCreate) {
          this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: pendingCreate.idempotency_key, bindingId: next.bindingId, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify(input.renderRunCard(next)) });
          outboxReserved = true;
        }
      }
      this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, 'swarm.skip', ?, 'skipped', ?)").run(input.actorOpenId, `binding:${input.bindingId}:prompt:${candidate.id}:message:${input.sourceMessageId}`, input.occurredAt);
      return { outcome: "skipped", promptId: candidate.id, outboxReserved };
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

  getPrompt(id: string): PromptJob | null {
    const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(id) as PromptRow | undefined;
    return row ? mapPrompt(row) : null;
  }

  private requirePrompt(id: string): PromptJob {
    const prompt = this.getPrompt(id);
    if (!prompt) throw new Error(`Prompt not found: ${id}`);
    return prompt;
  }
}

function now(): string { return new Date().toISOString(); }
function normalizeExternalRequest(value: string): string { return value.replace(/\r\n?/g, "\n"); }
