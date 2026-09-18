import type { Binding, HerdrAgentSession, PromptJob, PromptObservationState, PromptState, TranscriptTurnClaimOutcome } from "../../domain/types.js";
import { freezeRunCardWorkerContext, reduceRunCard, updateRunCardWorkerContext, type RunCardChange } from "../../domain/run-card-view.js";
import { mirrorRunCardToTopic } from "../../domain/topic-view.js";
import { selectPrimaryWorkerActivity, type PrimaryWorkerActivitySummary } from "../../domain/card-context-summary.js";
import type { CardContextInvalidation, CardContextTarget } from "../../domain/card-context-invalidation.js";
import type { SessionTransition } from "../../domain/pane-thread-lifecycle.js";
import { mapBinding, mapModelPreference, mapPrompt, type BindingRow, type ModelPreferenceRow, type PromptRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteProjectionStore } from "./projection-store.js";

export interface PromptDispatchStoreDependencies {
  persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  loadCardContextInvalidation(target: CardContextTarget): CardContextInvalidation | null;
  loadPrimaryWorkerActivity(promptId: string, bindingGeneration: number): PrimaryWorkerActivitySummary[];
}

export class SqlitePromptDispatchStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: PromptDispatchStoreDependencies
  ) {}

  getActiveOrdinaryPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    const rows = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id JOIN run_cards r ON r.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state = 'running'
        AND b.generation = ? AND r.binding_generation = b.generation AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 2`).all(bindingId, expectedGeneration) as PromptRow[];
    return rows.length === 1 ? mapPrompt(rows[0]!) : null;
  }

  getPrompt(id: string): PromptJob | null {
    const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(id) as PromptRow | undefined;
    return row ? mapPrompt(row) : null;
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

  failExternalTurnWithoutTerminalEvent(input: { promptId: string; bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: HerdrAgentSession; expectedObservedAt: string; turnId: string; startedAt: string; error: string; occurredAt: string }): boolean {
    return this.context.transaction(() => {
      const changed = this.context.database.prepare(`
        UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ?, updated_at = ?
        WHERE id = ? AND binding_id = ? AND execution_origin = 'herdr'
          AND state = 'running' AND observation_state = 'attached'
          AND transcript_turn_id = ? AND transcript_turn_started_at = ?
          AND EXISTS (
            SELECT 1 FROM bindings b JOIN run_cards r ON r.prompt_id = prompt_jobs.id
            WHERE b.id = prompt_jobs.binding_id AND b.generation = ? AND r.binding_generation = b.generation
              AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
              AND b.pane_id = ? AND b.agent_session_source = ? AND b.agent_session_agent = ?
              AND b.agent_session_kind = ? AND b.agent_session_value = ?
              AND b.last_agent_state IN ('idle', 'done') AND b.last_observed_at = ?
          )
      `).run(input.error, input.occurredAt, input.promptId, input.bindingId, input.turnId, input.startedAt, input.expectedGeneration, input.expectedPaneId, input.expectedSession.source, input.expectedSession.agent, input.expectedSession.kind, input.expectedSession.value, input.expectedObservedAt);
      if (Number(changed.changes) !== 1) return false;
      this.persistTerminalRunCard(input.promptId, { type: "failed", occurredAt: input.occurredAt, notice: input.error });
      return true;
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
}

function now(): string { return new Date().toISOString(); }
