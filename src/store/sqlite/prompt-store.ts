import type { Binding, PromptJob, PromptObservationState, PromptState } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { mapBinding, mapModelPreference, mapPrompt, type BindingRow, type ModelPreferenceRow, type PromptRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

export class SqlitePromptStore {
  constructor(private readonly context: SqliteContext) {}

  getActiveOrdinaryPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    const rows = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id JOIN run_cards r ON r.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state = 'running' AND p.dispatch_kind = 'turn'
        AND b.generation = ? AND r.binding_generation = b.generation AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 2`).all(bindingId, expectedGeneration) as PromptRow[];
    return rows.length === 1 ? mapPrompt(rows[0]!) : null;
  }

  getActiveExternalPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    const rows = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id JOIN run_cards r ON r.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state = 'running' AND p.dispatch_kind = 'turn' AND p.execution_origin = 'herdr'
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
    return (this.context.database.prepare("SELECT id FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' AND dispatch_kind = 'turn' ORDER BY created_at, rowid").all(bindingId) as Array<{ id: string }>).map((row) => row.id);
  }

  listQueuedTurnRunCards(bindingId: string): RunCardView[] {
    const rows = this.context.database.prepare(`
      SELECT view.state_json FROM prompt_jobs AS prompt
      JOIN run_cards_view AS view ON view.prompt_id = prompt.id
      WHERE prompt.binding_id = ? AND prompt.state = 'queued' AND prompt.dispatch_kind = 'turn'
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
      WHERE p.binding_id = ? AND p.dispatch_kind = 'turn' AND p.state = 'delivered'
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
      WHERE p.binding_id = ? AND p.dispatch_kind = 'turn' AND p.state = 'running'
        AND p.observation_state = 'attached' AND p.was_detached = 0
        AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 1
    `).get(bindingId) as { started_at: string | null } | undefined;
    return { activeStartedAt: active?.started_at ?? null, queued: this.listQueuedTurnRunCards(bindingId), durationsMs: this.listCompletedOrdinaryTurnDurations(bindingId, 10) };
  }

  enqueuePrompt(input: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "priority" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin"> & Partial<Pick<PromptJob, "dispatchKind" | "priority" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached" | "executionOrigin">>): { prompt: PromptJob; inserted: boolean } {
    const timestamp = now();
    const statement = this.context.database.prepare(`
      INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, priority, parent_prompt_id, steering_origin, source_prompt_id, was_detached, state, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?) ON CONFLICT(lark_message_id) DO NOTHING
    `);
    const dispatchKind = input.dispatchKind ?? "turn";
    const steeringOrigin = input.steeringOrigin ?? (dispatchKind === "steering" ? "explicit" : null);
    const inserted = statement.run(input.id, input.bindingId, input.larkMessageId, input.actorOpenId, input.body, dispatchKind, input.priority ?? "normal", input.parentPromptId ?? null, steeringOrigin, input.sourcePromptId ?? null, input.wasDetached ? 1 : 0, timestamp, timestamp).changes === 1;
    const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE lark_message_id = ?").get(input.larkMessageId) as PromptRow | undefined;
    if (!row) throw new Error(`Prompt not found: ${input.larkMessageId}`);
    return { prompt: mapPrompt(row), inserted };
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
        WHERE p.binding_id = ? AND p.state = 'queued' AND p.dispatch_kind = 'turn'
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

  claimNextReadySteering(bindingId: string, parentPromptId: string): PromptJob | null {
    return this.context.transaction(() => {
      const row = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p WHERE p.binding_id = ? AND p.parent_prompt_id = ? AND p.dispatch_kind = 'steering' AND p.state = 'queued' ORDER BY p.created_at, p.rowid LIMIT 1`).get(bindingId, parentPromptId) as PromptRow | undefined;
      if (!row) return null;
      this.context.database.prepare("UPDATE prompt_jobs SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(now(), row.id);
      return this.requirePrompt(row.id);
    });
  }

  updatePrompt(id: string, state: PromptState, error: string | null = null): void {
    const observationState: PromptObservationState = state === "queued" ? "not_started" : state === "running" ? "attached" : "completed";
    this.context.database.prepare("UPDATE prompt_jobs SET state = ?, observation_state = ?, error = ?, updated_at = ? WHERE id = ?").run(state, observationState, error, now(), id);
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
