import { randomUUID } from "node:crypto";
import type { DetachedPromptSkipResult } from "../../domain/ports/prompt.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { Binding, DurablePromptWorkScan, OutboundReply, PromptJob, PromptWorkHint, StalePromptClaim, UndispatchedPromptClaimFence } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { freezeRunCardWorkerContext, reduceRunCard, updateRunCardWorkerContext, type RunCardChange } from "../../domain/run-card-view.js";
import { mirrorRunCardToTopic } from "../../domain/topic-view.js";
import { selectPrimaryWorkerActivity, type PrimaryWorkerActivitySummary } from "../../domain/card-context-summary.js";
import type { CardContextInvalidation, CardContextTarget } from "../../domain/card-context-invalidation.js";
import type { SessionTransition } from "../../domain/pane-thread-lifecycle.js";
import { mapPrompt, type PromptRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteProjectionStore } from "./projection-store.js";

export interface PromptRecoveryStoreDependencies {
  persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  loadCardContextInvalidation(target: CardContextTarget): CardContextInvalidation | null;
  loadPrimaryWorkerActivity(promptId: string, bindingGeneration: number): PrimaryWorkerActivitySummary[];
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): OutboundReply;
}

export class SqlitePromptRecoveryStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: PromptRecoveryStoreDependencies
  ) {}

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
      } else this.persistTerminalRunCard(input.promptId, { type: "failed", occurredAt: input.occurredAt, notice: input.terminal.error });
      return true;
    });
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
      for (const prompt of running) this.context.database.prepare("UPDATE run_cards SET phase = 'running', finished_at = NULL, queue_position = 0, notice = ?, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?").run("Bridge 已重连，正在观察原 TraeX 任务；不会重复发送请求", timestamp, prompt.id);
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
      const detached = this.context.database.prepare(`SELECT p.id, p.binding_id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE p.state = 'running' AND p.observation_state = 'detached' AND p.transcript_turn_id IS NOT NULL AND p.transcript_turn_started_at IS NOT NULL AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL ORDER BY p.created_at, p.id`).all() as Array<{ id: string; binding_id: string }>;
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

  releaseUndispatchedPromptClaim(candidate: UndispatchedPromptClaimFence): boolean {
    return this.context.transaction(() => {
      const binding = this.context.database.prepare("SELECT 1 FROM bindings WHERE id = ? AND generation = ? AND pane_id = ? AND state = 'active' AND lifecycle = 'active' AND attachment = 'attached'").get(candidate.bindingId, candidate.bindingGeneration, candidate.paneId);
      return Boolean(binding) && this.requeueStaleUndispatchedPromptClaim(candidate);
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
