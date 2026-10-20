import { randomUUID } from "node:crypto";
import type { AdvanceDetachedPromptRecoveryInput, DetachedPromptNeedsHumanInput, DetachedPromptNeedsHumanResult, DetachedPromptRecoveryResult, DetachedPromptSkipResult, ProjectedBridgeTurnRecoveryInput, ProjectedBridgeTurnRecoveryResult } from "../../domain/ports/prompt.js";
import type { OutboxStore, PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation, PreparedDeliveryReservationInput } from "../../domain/ports/outbox.js";
import type { Binding, DurablePromptWorkScan, OutboundReply, PromptJob, PromptWorkHint, StalePromptClaim, UndispatchedPromptClaimFence } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import { answerElementId, freezeRunCardWorkerContext, reduceRunCard, updateRunCardWorkerContext, type RunCardChange } from "../../domain/run-card-view.js";
import { mirrorRunCardToTopic } from "../../domain/topic-view.js";
import { selectPrimaryWorkerActivity, type PrimaryWorkerActivitySummary } from "../../domain/card-context-summary.js";
import type { CardContextInvalidation, CardContextTarget } from "../../domain/card-context-invalidation.js";
import type { SessionTransition } from "../../domain/pane-thread-lifecycle.js";
import { mapPrompt, type PromptRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import { normalizeAndPersistCompletionChoice } from "./completion-choice-store.js";
import { choicePromptFromLegacyCompletionChoice, continueChoicePrompt, isFinalMessageCompletionChoice, selectCompletionChoiceTerminalAnswer, selectCompletionChoiceTerminalInput } from "../../domain/completion-choice.js";
import { incrementPrimaryAnswerPageSequence } from "./answer-page-sequence.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import { listNewestExactRunningPromptOwners, supersededDetachedPromptNotice, terminalizeOlderDetachedPromptOwners } from "./prompt-running-integrity.js";
import { outputFingerprint } from "../../domain/output-fingerprint.js";
import type { CompletionActionEligibilityReservation } from "../../domain/completion-action-eligibility.js";
import { PrimaryCompletionActionEligibility } from "./primary-completion-action-eligibility.js";
import { coreEventDiscriminatorSql } from "./core-event-discriminators.js";
import { foldFinalTraceChoiceEvidence } from "../../domain/final-trace-envelope.js";

const PROMPT_RECOVERY_BATCH_LIMIT = 128;

export interface PromptRecoveryStoreDependencies {
  persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  loadCardContextInvalidation(target: CardContextTarget): CardContextInvalidation | null;
  loadPrimaryWorkerActivity(promptId: string, bindingGeneration: number): PrimaryWorkerActivitySummary[];
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): OutboundReply;
  getBinding(id: string): Binding | null;
}

export class SqlitePromptRecoveryStore {
  private readonly completionActionEligibility: PrimaryCompletionActionEligibility;
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: PromptRecoveryStoreDependencies
  ) {
    this.completionActionEligibility = new PrimaryCompletionActionEligibility(context, {
      getBinding: dependencies.getBinding,
      loadRunCard: (promptId) => projections.loadRunCard(promptId)
    });
  }

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  settleDetachedPrompt(input: { promptId: string; bindingId: string; runtime: Binding["lastAgentState"]; occurredAt: string; terminal: { kind: "completed"; answer: string; completionChoice?: import("../../domain/completion-choice.js").ChoicePrompt; outputFingerprint: string } | { kind: "failed"; error: string } }): { settled: boolean; completionActionEligibility: CompletionActionEligibilityReservation } {
    return this.context.transaction("sqlite.prompt-recovery-store.write", () => {
      const nextState = input.terminal.kind === "completed" ? "delivered" : "failed";
      const error = input.terminal.kind === "failed" ? input.terminal.error : null;
      const changed = this.context.database.prepare(`
        UPDATE prompt_jobs SET state = ?, observation_state = 'completed', error = ?, updated_at = ?
        WHERE id = ? AND binding_id = ? AND state = 'running' AND observation_state = 'detached'
      `).run(nextState, error, input.occurredAt, input.promptId, input.bindingId);
      if (Number(changed.changes) !== 1) return { settled: false, completionActionEligibility: { outcome: "skipped", reason: "not-completion" } };
      this.context.database.prepare("DELETE FROM detached_prompt_recovery_attempts WHERE prompt_id = ?").run(input.promptId);
      this.dependencies.transitionBinding(input.bindingId, { type: "pane_observed", runtime: input.runtime });
      let completionActionEligibility: CompletionActionEligibilityReservation = { outcome: "skipped", reason: "not-completion" };
      if (input.terminal.kind === "completed") {
        this.dependencies.persistBindingPatch(input.bindingId, { lastOutputFingerprint: input.terminal.outputFingerprint });
        this.dependencies.transitionBinding(input.bindingId, { type: "turn_completed" });
        this.persistTerminalRunCard(input.promptId, { type: "completed", occurredAt: input.occurredAt, answer: input.terminal.answer, ...(input.terminal.completionChoice ? { completionChoice: input.terminal.completionChoice } : {}), replaceAnswer: true });
        completionActionEligibility = this.completionActionEligibility.defer({ bindingId: input.bindingId, promptId: input.promptId, occurredAt: input.occurredAt });
      } else this.persistTerminalRunCard(input.promptId, { type: "failed", occurredAt: input.occurredAt, notice: input.terminal.error });
      return { settled: true, completionActionEligibility };
    });
  }

  markPromptObservationDetached(id: string, notice: string): void {
    const timestamp = now();
    this.context.transaction("sqlite.prompt-recovery-store.write", () => {
      const result = this.context.database.prepare("UPDATE prompt_jobs SET state = CASE WHEN state = 'submitted' THEN 'recovering' ELSE state END, observation_state = 'detached', was_detached = 1, error = ?, updated_at = ? WHERE id = ? AND ((state = 'submitted' AND observation_state IN ('attached','detached')) OR (state = 'running' AND observation_state = 'attached') OR (state = 'recovering' AND observation_state = 'detached'))").run(notice, timestamp, id);
      if (result.changes > 0) this.context.database.prepare(`
        UPDATE binding_model_preferences SET state = 'uncertain', updated_at = ?
        WHERE state = 'applying' AND dispatch_prompt_id = ?
          AND EXISTS (SELECT 1 FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE p.id = ? AND p.binding_id = binding_model_preferences.binding_id AND b.generation = binding_model_preferences.binding_generation AND p.model_name = binding_model_preferences.desired_model AND p.model_revision = binding_model_preferences.desired_revision)
      `).run(timestamp, id, id);
      if (result.changes > 0) this.persistRunCardChange(id, { type: "recovering", occurredAt: timestamp, notice });
    });
  }

  listStaleUndispatchedPromptClaims(updatedBefore: string, limit: number): StalePromptClaim[] {
    if (!Number.isFinite(Date.parse(updatedBefore))) throw new Error("Invalid stale prompt cutoff");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Invalid stale prompt claim limit");
    const rows = this.context.database.prepare(`
      SELECT p.id, p.binding_id, p.updated_at
      FROM prompt_jobs p
      LEFT JOIN binding_model_preferences preference ON preference.dispatch_prompt_id = p.id
      WHERE p.state = 'submitted' AND p.observation_state = 'not_started'
        AND p.dispatched_at IS NULL AND p.transcript_turn_id IS NULL
        AND preference.prepared_operation_id IS NULL AND p.updated_at < ?
      ORDER BY p.updated_at, p.rowid LIMIT ?
    `).all(updatedBefore, limit) as Array<{ id: string; binding_id: string; updated_at: string }>;
    return rows.map((row) => ({ promptId: row.id, bindingId: row.binding_id, updatedAt: row.updated_at }));
  }

  recoverRunningPrompts(): number {
    const timestamp = now();
    return this.context.transaction("sqlite.prompt-recovery-store.write", () => {
      const requeued = this.requeueNeverStartedClaims(timestamp);
      const superseded = this.terminalizeSupersededExactPromptOwners(timestamp);
      const detached = this.detachPossiblyDispatchedPrompts(timestamp);
      return requeued + detached + superseded;
    });
  }

  private terminalizeSupersededExactPromptOwners(timestamp: string): number {
    let terminalized = 0;
    for (const successor of listNewestExactRunningPromptOwners(this.context)) {
      terminalized += terminalizeOlderDetachedPromptOwners(this.context, successor, timestamp, (promptId) => {
        this.persistRunCardChange(promptId, { type: "uncertain", occurredAt: successor.startedAt, notice: supersededDetachedPromptNotice });
      }).length;
    }
    return terminalized;
  }

  private requeueNeverStartedClaims(timestamp: string): number {
    const safeModelClaims = this.context.database.prepare(`
      SELECT p.id FROM prompt_jobs p
      JOIN bindings b ON b.id = p.binding_id
      JOIN binding_model_preferences preference ON preference.binding_id = p.binding_id
        AND preference.binding_generation = b.generation
        AND preference.desired_revision = p.model_revision
        AND preference.desired_model = p.model_name
        AND preference.dispatch_prompt_id = p.id
      WHERE p.state = 'submitted' AND p.observation_state IN ('not_started', 'detached')
        AND p.dispatched_at IS NULL AND (p.native_submission_id IS NULL OR p.native_submission_id = p.id)
        AND p.transcript_turn_id IS NULL AND p.transcript_turn_started_at IS NULL
        AND p.model_name IS NOT NULL AND p.model_revision IS NOT NULL
        AND preference.state = 'applying' AND preference.prepared_operation_id IS NULL
    `).all() as Array<{ id: string }>;
    this.context.database.prepare(`UPDATE binding_model_preferences SET state = 'pending', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = ? WHERE state = 'applying' AND prepared_operation_id IS NULL AND dispatch_prompt_id IN (${placeholders(safeModelClaims)})`).run(timestamp, ...promptIds(safeModelClaims));
    if (safeModelClaims.length > 0) {
      this.context.database.prepare(`UPDATE prompt_jobs SET state = 'queued', observation_state = 'not_started', model_name = NULL, model_revision = NULL, error = NULL, updated_at = ? WHERE id IN (${placeholders(safeModelClaims)}) AND state = 'submitted' AND observation_state IN ('not_started', 'detached') AND dispatched_at IS NULL AND (native_submission_id IS NULL OR native_submission_id = id) AND transcript_turn_id IS NULL AND transcript_turn_started_at IS NULL`).run(timestamp, ...promptIds(safeModelClaims));
    }
    this.context.database.prepare(`UPDATE binding_model_preferences SET state = 'uncertain', updated_at = ? WHERE state = 'applying' AND prepared_operation_id IS NOT NULL AND EXISTS (SELECT 1 FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE p.id = binding_model_preferences.dispatch_prompt_id AND p.binding_id = binding_model_preferences.binding_id AND b.generation = binding_model_preferences.binding_generation AND p.model_name = binding_model_preferences.desired_model AND p.model_revision = binding_model_preferences.desired_revision AND p.state IN ('submitted','running','recovering') AND p.observation_state IN ('not_started', 'attached', 'detached'))`).run(timestamp);
    const safePlainClaims = this.context.database.prepare(`
      SELECT p.id FROM prompt_jobs p
      WHERE p.state = 'submitted' AND p.observation_state IN ('not_started', 'detached')
        AND p.dispatched_at IS NULL AND (p.native_submission_id IS NULL OR p.native_submission_id = p.id)
        AND p.transcript_turn_id IS NULL AND p.transcript_turn_started_at IS NULL
        AND p.model_name IS NULL AND p.model_revision IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM binding_model_preferences preference
          WHERE preference.dispatch_prompt_id = p.id AND preference.prepared_operation_id IS NOT NULL
        )
    `).all() as Array<{ id: string }>;
    this.context.database.prepare(`
      UPDATE prompt_jobs SET state = 'queued', observation_state = 'not_started', error = NULL, updated_at = ?
      WHERE id IN (${placeholders(safePlainClaims)})
        AND state = 'submitted' AND observation_state IN ('not_started', 'detached')
        AND dispatched_at IS NULL AND (native_submission_id IS NULL OR native_submission_id = id)
        AND transcript_turn_id IS NULL AND transcript_turn_started_at IS NULL
    `).run(timestamp, ...promptIds(safePlainClaims));
    for (const prompt of safePlainClaims) this.context.database.prepare("UPDATE run_cards SET phase = 'queued', started_at = NULL, notice = NULL, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?").run(timestamp, prompt.id);
    return safeModelClaims.length + safePlainClaims.length;
  }

  private detachPossiblyDispatchedPrompts(timestamp: string): number {
    let detached = 0;
    let afterRowid = 0;
    while (true) {
      const running = this.context.database.prepare(`SELECT rowid,id FROM prompt_jobs
        WHERE state IN ('submitted','running','recovering') AND rowid > ?
        ORDER BY rowid LIMIT ?`).all(afterRowid, PROMPT_RECOVERY_BATCH_LIMIT) as Array<{ rowid: number; id: string }>;
      if (running.length === 0) break;
      const result = this.context.database.prepare(`UPDATE prompt_jobs SET
          state = CASE WHEN state = 'submitted' THEN 'recovering' ELSE state END,
          observation_state = 'detached', was_detached = 1,
          error = 'Bridge restarted after dispatch; observing the existing TraeX turn without replay', updated_at = ?
        WHERE id IN (${placeholders(running)}) AND state IN ('submitted','running','recovering')`).run(
        timestamp, ...promptIds(running)
      );
      for (const prompt of running) this.persistRunCardChange(prompt.id, { type: "recovering", occurredAt: timestamp, notice: "Bridge 已重连，正在观察原 TraeX 任务；不会重复发送请求" }, true, false);
      detached += Number(result.changes);
      afterRowid = running.at(-1)!.rowid;
      if (running.length < PROMPT_RECOVERY_BATCH_LIMIT) break;
    }
    return detached;
  }

  scanDurablePromptWork(): DurablePromptWorkScan {
    const timestamp = now();
    const humanEventType = coreEventDiscriminatorSql(this.context.database, "human", "event_type");
    const humanSubmissionId = coreEventDiscriminatorSql(this.context.database, "human", "submission_id");
    const startedEventType = coreEventDiscriminatorSql(this.context.database, "started", "event_type");
    const terminalEventType = coreEventDiscriminatorSql(this.context.database, "terminal", "event_type");
    const reason = "Session can no longer dispatch queued work";
    const detachedReason = "Session ended while a dispatched turn was detached; the prompt was not replayed";
    return this.context.transaction("sqlite.prompt-recovery-store.write", () => {
      const terminalBindings = `SELECT id FROM bindings WHERE state IN ('archived', 'orphaned', 'failed') OR lifecycle IN ('archived', 'closed', 'failed') OR attachment = 'orphaned'`;
      const result = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'cancelled', observation_state = 'completed', error = ?, updated_at = ? WHERE state = 'queued' AND binding_id IN (${terminalBindings})`).run(reason, timestamp);
      this.context.database.prepare(`UPDATE run_cards SET phase = 'failed', notice = ?, finished_at = ?, queue_position = 0, activity_at = ?, view_version = view_version + 1, updated_at = ? WHERE phase = 'queued' AND binding_id IN (${terminalBindings})`).run(reason, timestamp, timestamp, timestamp);
      const terminalDetachedPrompts = `SELECT p.id FROM prompt_jobs p WHERE p.state = 'running' AND p.observation_state = 'detached' AND p.binding_id IN (${terminalBindings})`;
      this.context.database.prepare(`UPDATE run_cards SET phase = 'failed', notice = ?, finished_at = ?, queue_position = 0, activity_at = ?, view_version = view_version + 1, updated_at = ? WHERE prompt_id IN (${terminalDetachedPrompts})`).run(detachedReason, timestamp, timestamp, timestamp);
      const detachedResult = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', was_detached = 1, error = ?, updated_at = ? WHERE state = 'running' AND observation_state = 'detached' AND binding_id IN (${terminalBindings})`).run(detachedReason, timestamp);
      const hints: PromptWorkHint[] = [];
      const detached = this.context.database.prepare(`
        SELECT p.id, p.binding_id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
        WHERE p.execution_origin = 'bridge'
          AND (
            ((p.state = 'running' OR p.state = 'recovering') AND p.observation_state = 'detached')
            OR (p.state IN ('uncertain','cancelled') AND p.observation_state = 'completed' AND EXISTS (
              SELECT 1 FROM core_event_inbox human
              WHERE human.agent_kind = b.agent_session_agent AND human.session_id = b.agent_session_value
                AND human.turn_id IS NOT NULL
                AND ${humanEventType} = 'human_message'
                AND ${humanSubmissionId} = p.id
                AND EXISTS (SELECT 1 FROM core_event_lane_items lane WHERE lane.event_id = human.event_id AND lane.state IN ('projected','ignored'))
                AND EXISTS (SELECT 1 FROM core_event_inbox started
                  WHERE started.source_id = human.source_id AND started.agent_kind = human.agent_kind
                    AND started.session_id = human.session_id AND started.turn_id = human.turn_id
                    AND ${startedEventType} = 'turn_started'
                    AND EXISTS (SELECT 1 FROM core_event_lane_items lane WHERE lane.event_id = started.event_id AND lane.state IN ('projected','ignored')))
                AND EXISTS (SELECT 1 FROM core_event_inbox terminal
                  WHERE terminal.source_id = human.source_id AND terminal.agent_kind = human.agent_kind
                    AND terminal.session_id = human.session_id AND terminal.turn_id = human.turn_id
                    AND ${terminalEventType} IN ('turn_completed','turn_aborted')
                    AND EXISTS (SELECT 1 FROM core_event_lane_items lane WHERE lane.event_id = terminal.event_id AND lane.state IN ('projected','ignored')))
            ))
          )
          AND ((p.state = 'running' AND p.transcript_turn_id IS NOT NULL AND p.transcript_turn_started_at IS NOT NULL)
            OR (p.state IN ('recovering','uncertain','cancelled') AND p.transcript_turn_id IS NULL AND p.transcript_turn_started_at IS NULL))
          AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL
        ORDER BY p.created_at, p.id
      `).all() as Array<{ id: string; binding_id: string }>;
      for (const row of detached) hints.push({ kind: "detached-observer-ready", bindingId: row.binding_id, promptId: row.id });
      const turns = this.context.database.prepare(`
        SELECT binding_id FROM (
          SELECT p.binding_id AS binding_id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
          WHERE p.state = 'queued' AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL
          UNION
          SELECT batch.binding_id AS binding_id FROM native_input_batches batch JOIN bindings b ON b.id = batch.binding_id
          WHERE batch.state = 'collecting' AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL
        ) ORDER BY binding_id
      `).all() as Array<{ binding_id: string }>;
      for (const row of turns) hints.push({ kind: "prompt-ready", bindingId: row.binding_id });
      return { cancelled: Number(result.changes), failedDetached: Number(detachedResult.changes), hints };
    });
  }

  requeueStaleUndispatchedPromptClaim(candidate: StalePromptClaim): boolean {
    return this.context.transaction("sqlite.prompt-recovery-store.write", () => {
      const row = this.context.database.prepare(`
        SELECT p.model_name, p.model_revision, preference.state AS preference_state, preference.prepared_operation_id
        FROM prompt_jobs p
        LEFT JOIN bindings b ON b.id = p.binding_id
        LEFT JOIN binding_model_preferences preference ON preference.dispatch_prompt_id = p.id AND preference.binding_id = p.binding_id AND preference.binding_generation = b.generation AND preference.desired_model = p.model_name AND preference.desired_revision = p.model_revision
        WHERE p.id = ? AND p.binding_id = ? AND p.updated_at = ?
          AND p.state = 'submitted' AND p.observation_state = 'not_started'
          AND p.dispatched_at IS NULL AND p.transcript_turn_id IS NULL AND preference.prepared_operation_id IS NULL
      `).get(candidate.promptId, candidate.bindingId, candidate.updatedAt) as { model_name: string | null; model_revision: number | null; preference_state: string | null; prepared_operation_id: string | null } | undefined;
      if (!row) return false;
      const hasModel = row.model_name !== null || row.model_revision !== null;
      if (hasModel && row.preference_state !== "applying") return false;
      const timestamp = now();
      if (hasModel) this.context.database.prepare(`UPDATE binding_model_preferences SET state = 'pending', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = ? WHERE dispatch_prompt_id = ? AND state = 'applying' AND prepared_operation_id IS NULL`).run(timestamp, candidate.promptId);
      const result = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'queued', observation_state = 'not_started', model_name = NULL, model_revision = NULL, error = NULL, updated_at = ? WHERE id = ? AND binding_id = ? AND updated_at = ? AND state = 'submitted' AND observation_state = 'not_started' AND dispatched_at IS NULL AND transcript_turn_id IS NULL`).run(timestamp, candidate.promptId, candidate.bindingId, candidate.updatedAt);
      if (Number(result.changes) !== 1) throw new Error("Stale prompt claim changed during recovery");
      this.context.database.prepare(`UPDATE run_cards SET phase = 'queued', started_at = NULL, finished_at = NULL, notice = NULL, queue_position = 1, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?`).run(timestamp, candidate.promptId);
      return true;
    });
  }

  releaseUndispatchedPromptClaim(candidate: UndispatchedPromptClaimFence): boolean {
    return this.context.transaction("sqlite.prompt-recovery-store.write", () => {
      const binding = this.context.database.prepare("SELECT 1 FROM bindings WHERE id = ? AND generation = ? AND pane_id = ? AND state = 'active' AND lifecycle = 'active' AND attachment = 'attached'").get(candidate.bindingId, candidate.bindingGeneration, candidate.paneId);
      return Boolean(binding) && this.requeueStaleUndispatchedPromptClaim(candidate);
    });
  }

  listDetachedPrompts(): PromptJob[] {
    return (this.context.database.prepare("SELECT * FROM prompt_jobs WHERE state IN ('running','recovering') AND observation_state = 'detached' ORDER BY created_at, id").all() as PromptRow[]).map(mapPrompt);
  }

  skipOldestDetachedPrompt(input: { bindingId: string; expectedBindingGeneration: number; actorOpenId: string; sourceMessageId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): DetachedPromptSkipResult {
    return this.context.transaction("sqlite.prompt-recovery-store.write", () => {
      const binding = this.context.database.prepare("SELECT generation, lifecycle, state FROM bindings WHERE id = ?").get(input.bindingId) as { generation: number; lifecycle: string; state: string } | undefined;
      if (!binding || Number(binding.generation) !== input.expectedBindingGeneration || binding.lifecycle !== "active" || binding.state !== "active") return { outcome: "stale" };
      const candidate = this.context.database.prepare(`SELECT p.id FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id WHERE p.binding_id = ? AND c.binding_generation = ? AND ((p.state = 'recovering' AND p.observation_state = 'detached') OR (p.state = 'uncertain' AND p.observation_state = 'completed')) ORDER BY p.created_at, p.rowid LIMIT 1`).get(input.bindingId, input.expectedBindingGeneration) as { id: string } | undefined;
      if (!candidate) return { outcome: "none" };
      return this.terminalizeDetachedPrompt({
        ...input, promptId: candidate.id,
        auditActor: input.actorOpenId, auditAction: "swarm.skip",
        auditTarget: `binding:${input.bindingId}:prompt:${candidate.id}:message:${input.sourceMessageId}`
      });
    });
  }

  advanceDetachedPromptRecovery(input: AdvanceDetachedPromptRecoveryInput): DetachedPromptRecoveryResult {
    const occurredAtMs = Date.parse(input.occurredAt);
    const expiredBeforeMs = Date.parse(input.expiredBefore);
    if (!Number.isFinite(occurredAtMs) || !Number.isFinite(expiredBeforeMs)) throw new Error("Invalid detached Prompt recovery timestamp");
    return this.context.transaction("sqlite.prompt-recovery-store.write", () => {
      const candidate = this.context.database.prepare(`SELECT p.id, b.root_message_id, COALESCE(p.dispatched_at, p.created_at) AS recovery_started_at
        FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id JOIN bindings b ON b.id = p.binding_id
        WHERE p.id = ? AND p.binding_id = ? AND c.binding_generation = ?
          AND p.state = 'recovering' AND p.observation_state = 'detached' AND p.parent_prompt_id IS NULL
          AND p.transcript_turn_id IS NULL AND p.transcript_turn_started_at IS NULL
          AND b.generation = ? AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
          AND b.pane_id = ? AND b.agent_session_value = ? AND b.last_agent_state IN ('idle','done')
          AND NOT EXISTS (SELECT 1 FROM prompt_jobs earlier WHERE earlier.binding_id = p.binding_id AND earlier.state = 'recovering' AND (earlier.created_at < p.created_at OR (earlier.created_at = p.created_at AND earlier.rowid < p.rowid)))`)
        .get(input.promptId, input.bindingId, input.expectedBindingGeneration, input.expectedBindingGeneration, input.expectedPaneId, input.expectedNativeSessionId) as { id: string; root_message_id: string | null; recovery_started_at: string } | undefined;
      if (!candidate) {
        this.context.database.prepare("DELETE FROM detached_prompt_recovery_attempts WHERE prompt_id = ?").run(input.promptId);
        return { outcome: "stale" };
      }
      const prior = this.context.database.prepare(`SELECT binding_generation, pane_id, session_value, attempt_count, first_attempt_at, next_attempt_at
        FROM detached_prompt_recovery_attempts WHERE prompt_id = ?`).get(candidate.id) as {
          binding_generation: number; pane_id: string; session_value: string; attempt_count: number; first_attempt_at: string; next_attempt_at: string;
        } | undefined;
      const sameFence = prior && Number(prior.binding_generation) === input.expectedBindingGeneration
        && prior.pane_id === input.expectedPaneId && prior.session_value === input.expectedNativeSessionId;
      if (prior && !sameFence) this.context.database.prepare("DELETE FROM detached_prompt_recovery_attempts WHERE prompt_id = ?").run(candidate.id);
      const current = sameFence ? prior : undefined;
      const expired = Date.parse(candidate.recovery_started_at) <= expiredBeforeMs;
      if (current && !expired && current.next_attempt_at > input.occurredAt) {
        return { outcome: "deferred", attemptCount: Number(current.attempt_count), nextAttemptAt: current.next_attempt_at };
      }
      const attemptCount = Number(current?.attempt_count ?? 0) + 1;
      if (!expired && attemptCount < DETACHED_RECOVERY_ATTEMPT_LIMIT) {
        const nextAttemptAt = recoveryAttemptDueAt(occurredAtMs, attemptCount);
        this.context.database.prepare(`INSERT INTO detached_prompt_recovery_attempts(
          prompt_id,binding_id,binding_generation,pane_id,session_value,attempt_count,first_attempt_at,last_attempt_at,next_attempt_at
        ) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(prompt_id) DO UPDATE SET
          binding_id=excluded.binding_id,binding_generation=excluded.binding_generation,pane_id=excluded.pane_id,session_value=excluded.session_value,
          attempt_count=excluded.attempt_count,last_attempt_at=excluded.last_attempt_at,next_attempt_at=excluded.next_attempt_at`)
          .run(candidate.id, input.bindingId, input.expectedBindingGeneration, input.expectedPaneId, input.expectedNativeSessionId, attemptCount, current?.first_attempt_at ?? input.occurredAt, input.occurredAt, nextAttemptAt);
        return { outcome: "observed", attemptCount, nextAttemptAt };
      }
      const result = this.terminalizeDetachedPrompt({
        ...input, promptId: candidate.id, rootMessageId: candidate.root_message_id,
        auditActor: "system:auto-skip", auditAction: "swarm.auto_skip",
        auditTarget: `binding:${input.bindingId}:prompt:${candidate.id}`
      });
      return result.outcome === "skipped" ? { ...result, attemptCount } : result;
    });
  }

  recoverProjectedBridgeTurn(input: ProjectedBridgeTurnRecoveryInput): ProjectedBridgeTurnRecoveryResult {
    const eventType = coreEventDiscriminatorSql(this.context.database, "i", "event_type");
    const submissionId = coreEventDiscriminatorSql(this.context.database, "i", "submission_id");
    const channel = coreEventDiscriminatorSql(this.context.database, "i", "channel");
    return this.context.transaction("sqlite.prompt-recovery-store.write", () => {
      const candidate = this.context.database.prepare(`SELECT p.id, p.state, p.observation_state, b.agent_session_agent, b.root_message_id
        FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id JOIN bindings b ON b.id = p.binding_id
        WHERE p.id = ? AND p.binding_id = ? AND p.execution_origin = 'bridge'
          AND ((p.state = 'recovering' AND p.observation_state = 'detached') OR (p.state IN ('uncertain','cancelled') AND p.observation_state = 'completed'))
          AND p.parent_prompt_id IS NULL
          AND p.native_submission_id = p.id AND p.transcript_turn_id IS NULL AND p.transcript_turn_started_at IS NULL
          AND c.binding_generation = ? AND b.generation = c.binding_generation
          AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
          AND b.pane_id = ? AND b.agent_session_kind = 'id' AND b.agent_session_value = ?
          AND b.agent_session_agent IN ('traex','pi')`).get(
            input.promptId, input.bindingId, input.expectedBindingGeneration,
            input.expectedPaneId, input.expectedNativeSessionId
          ) as { id: string; state: "recovering" | "uncertain" | "cancelled"; observation_state: "detached" | "completed"; agent_session_agent: "traex" | "pi"; root_message_id: string | null } | undefined;
      if (!candidate) return { outcome: "stale" };
      const lateRepair = candidate.state !== "recovering";

      const humanMatches = this.context.database.prepare(`SELECT i.source_id, i.turn_id, l.lane_id, l.sequence AS lane_sequence
        FROM core_event_inbox i JOIN core_event_lane_items l ON l.event_id = i.event_id AND l.state IN ('projected','ignored')
        WHERE i.agent_kind = ? AND i.session_id = ? AND i.turn_id IS NOT NULL
          AND i.payload_compacted_at IS NULL
          AND ${eventType} = 'human_message'
          AND ${submissionId} = ?
        ORDER BY l.lane_id, l.sequence LIMIT 2`).all(
          candidate.agent_session_agent, input.expectedNativeSessionId, input.promptId
        ) as Array<{ source_id: string; turn_id: string; lane_id: string; lane_sequence: number }>;
      if (humanMatches.length === 0) return { outcome: "not_found" };
      if (humanMatches.length !== 1) return this.markDetachedPromptRecoveryNeedsHumanInTransaction({
        ...input,
        reason: "Core event ordering cannot uniquely identify the managed turn; the prompt will not be replayed."
      }, "turn.recovery.ambiguous");
      const human = humanMatches[0]!;

      const starts = this.context.database.prepare(`SELECT i.occurred_at, l.sequence AS lane_sequence
        FROM core_event_lane_items l JOIN core_event_inbox i ON i.event_id = l.event_id
        WHERE l.lane_id = ? AND l.state IN ('projected','ignored')
          AND i.source_id = ? AND i.agent_kind = ? AND i.session_id = ? AND i.turn_id = ?
          AND i.payload_compacted_at IS NULL
          AND ${eventType} = 'turn_started'
        ORDER BY l.sequence LIMIT 2`).all(
          human.lane_id, human.source_id, candidate.agent_session_agent, input.expectedNativeSessionId, human.turn_id
        ) as Array<{ occurred_at: string; lane_sequence: number }>;
      const terminals = this.context.database.prepare(`SELECT i.occurred_at, l.sequence AS lane_sequence,
          ${eventType} AS event_type,
          json_extract(i.event_json, '$.payload.reason') AS reason
        FROM core_event_lane_items l JOIN core_event_inbox i ON i.event_id = l.event_id
        WHERE l.lane_id = ? AND l.state IN ('projected','ignored')
          AND i.source_id = ? AND i.agent_kind = ? AND i.session_id = ? AND i.turn_id = ?
          AND i.payload_compacted_at IS NULL
          AND ${eventType} IN ('turn_completed','turn_aborted')
        ORDER BY l.sequence LIMIT 2`).all(
          human.lane_id, human.source_id, candidate.agent_session_agent, input.expectedNativeSessionId, human.turn_id
        ) as Array<{ occurred_at: string; lane_sequence: number; event_type: "turn_completed" | "turn_aborted"; reason: string | null }>;
      if (starts.length === 0 || terminals.length === 0) return { outcome: "not_found" };
      if (starts.length !== 1 || terminals.length !== 1) return this.markDetachedPromptRecoveryNeedsHumanInTransaction({
        ...input,
        reason: "Core event ordering cannot uniquely identify the managed turn; the prompt will not be replayed."
      }, "turn.recovery.ambiguous");
      const startedAt = normalizeCoreTurnStartedAt(starts[0]!.occurred_at);
      const conflictingOwner = this.context.database.prepare(`SELECT prompt_id FROM prompt_transcript_turns
        WHERE pane_id = ? AND native_session_id = ? AND turn_id = ? AND started_at = ? AND prompt_id != ?
        UNION ALL
        SELECT p.id AS prompt_id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
        WHERE b.pane_id = ? AND b.agent_session_value = ?
          AND p.transcript_turn_id = ? AND p.transcript_turn_started_at = ? AND p.id != ?
        LIMIT 1`).get(
          input.expectedPaneId, input.expectedNativeSessionId, human.turn_id, startedAt, input.promptId,
          input.expectedPaneId, input.expectedNativeSessionId, human.turn_id, startedAt, input.promptId
        );
      if (conflictingOwner) return { outcome: "turn_owned_by_other_prompt" };

      const terminal = terminals[0]!;
      if (terminal.event_type === "turn_completed") {
        const finalMessage = this.context.database.prepare(`SELECT json_extract(i.event_json, '$.payload.text') AS text,
            json_extract(i.event_json, '$.payload.completion_choice') AS completion_choice,
            json_type(i.event_json, '$.payload.completion_choice') AS completion_choice_type
          FROM core_event_lane_items l JOIN core_event_inbox i ON i.event_id = l.event_id
          WHERE l.lane_id = ? AND l.state IN ('projected','ignored')
            AND l.sequence < ?
            AND i.source_id = ? AND i.agent_kind = ? AND i.session_id = ? AND i.turn_id = ?
            AND i.payload_compacted_at IS NULL
            AND ${eventType} = 'message'
            AND ${channel} = 'final'
            AND json_type(i.event_json, '$.payload.text') = 'text'
          ORDER BY l.sequence DESC LIMIT 1`).get(
            human.lane_id, terminal.lane_sequence, human.source_id, candidate.agent_session_agent, input.expectedNativeSessionId, human.turn_id
          ) as { text: string; completion_choice: unknown; completion_choice_type: string | null } | undefined;
        if (!finalMessage) return { outcome: "not_found" };
        const accumulatedAnswer = this.projections.loadRunCard(input.promptId)?.answer ?? "";
        const terminalInput = selectCompletionChoiceTerminalInput(finalMessage.text, accumulatedAnswer);
        const answer = selectCompletionChoiceTerminalAnswer(finalMessage.text, accumulatedAnswer);
        const completionChoice = finalMessage.completion_choice_type === "object"
          ? parsePersistedCompletionChoice(finalMessage.completion_choice)
          : finalMessage.completion_choice_type === null
            ? this.loadFoldedCompletionChoice(human.lane_id, human.source_id, candidate.agent_session_agent, input.expectedNativeSessionId, human.turn_id, terminal.lane_sequence)
            : undefined;
        const changed = this.context.database.prepare(`UPDATE prompt_jobs
          SET state = 'delivered', observation_state = 'completed', transcript_turn_id = ?, transcript_turn_started_at = ?, error = NULL, updated_at = ?
          WHERE id = ? AND binding_id = ? AND execution_origin = 'bridge'
            AND ((state = 'recovering' AND observation_state = 'detached') OR (state IN ('uncertain','cancelled') AND observation_state = 'completed')) AND native_submission_id = id
            AND transcript_turn_id IS NULL AND transcript_turn_started_at IS NULL`).run(
              human.turn_id, startedAt, input.occurredAt, input.promptId, input.bindingId
            );
        if (Number(changed.changes) !== 1) return { outcome: "stale" };
        this.insertRecoveredPromptTurn(input, human.turn_id, startedAt);
        if (!lateRepair) {
          this.dependencies.persistBindingPatch(input.bindingId, { lastOutputFingerprint: outputFingerprint(answer) });
          this.dependencies.transitionBinding(input.bindingId, { type: "turn_completed" });
        }
        this.persistTerminalRunCard(input.promptId, { type: "completed", occurredAt: input.occurredAt, answer: terminalInput, ...(completionChoice ? { completionChoice } : {}), replaceAnswer: true }, !lateRepair);
        const completionActionEligibility = lateRepair
          ? { outcome: "skipped" as const, reason: "historical-recovery" as const }
          : this.completionActionEligibility.defer({ bindingId: input.bindingId, promptId: input.promptId, occurredAt: input.occurredAt });
        const outboxReserved = lateRepair ? this.reserveLateRecoveryContinuation(input, candidate.root_message_id, human.turn_id, "completed") : false;
        this.finishProjectedBridgeRecovery(input, human.turn_id, "completed");
        return lateRepair
          ? { outcome: "recovered", terminalState: "completed", answer, turnId: human.turn_id, recoveryMode: "late", outboxReserved, completionActionEligibility }
          : { outcome: "recovered", terminalState: "completed", answer, turnId: human.turn_id, completionActionEligibility };
      }

      const error = terminal.reason ? `TraeX turn was aborted: ${terminal.reason}` : "TraeX turn was aborted";
      const changed = this.context.database.prepare(`UPDATE prompt_jobs
        SET state = 'failed', observation_state = 'completed', transcript_turn_id = ?, transcript_turn_started_at = ?, error = ?, updated_at = ?
        WHERE id = ? AND binding_id = ? AND execution_origin = 'bridge'
          AND ((state = 'recovering' AND observation_state = 'detached') OR (state IN ('uncertain','cancelled') AND observation_state = 'completed')) AND native_submission_id = id
          AND transcript_turn_id IS NULL AND transcript_turn_started_at IS NULL`).run(
            human.turn_id, startedAt, error, input.occurredAt, input.promptId, input.bindingId
          );
      if (Number(changed.changes) !== 1) return { outcome: "stale" };
      this.insertRecoveredPromptTurn(input, human.turn_id, startedAt);
      this.persistTerminalRunCard(input.promptId, { type: "failed", occurredAt: input.occurredAt, notice: error }, !lateRepair);
      const outboxReserved = lateRepair ? this.reserveLateRecoveryContinuation(input, candidate.root_message_id, human.turn_id, "aborted") : false;
      this.finishProjectedBridgeRecovery(input, human.turn_id, "aborted");
      return lateRepair
        ? { outcome: "recovered", terminalState: "aborted", error, turnId: human.turn_id, recoveryMode: "late", outboxReserved }
        : { outcome: "recovered", terminalState: "aborted", error, turnId: human.turn_id };
    });
  }

  private loadFoldedCompletionChoice(laneId: string, sourceId: string, agentKind: "traex" | "pi", sessionId: string, turnId: string, terminalSequence: number): import("../../domain/completion-choice.js").ChoicePrompt | undefined {
    const eventType = coreEventDiscriminatorSql(this.context.database, "i", "event_type");
    const channel = coreEventDiscriminatorSql(this.context.database, "i", "channel");
    const evidence = this.context.database.prepare(`SELECT l.sequence AS lane_sequence,
        json_extract(i.event_json, '$.payload.text') AS text,
        json_extract(i.event_json, '$.payload.truncated') AS truncated
      FROM core_event_lane_items l JOIN core_event_inbox i ON i.event_id = l.event_id
      WHERE l.lane_id = ? AND l.state IN ('projected','ignored') AND l.sequence < ?
        AND i.source_id = ? AND i.agent_kind = ? AND i.session_id = ? AND i.turn_id = ?
        AND i.payload_compacted_at IS NULL
        AND ${eventType} = 'message' AND ${channel} IN ('commentary','final')
        AND json_type(i.event_json, '$.payload.text') = 'text'
      ORDER BY l.sequence`).all(laneId, terminalSequence, sourceId, agentKind, sessionId, turnId) as Array<{
        lane_sequence: number; text: string; truncated: number;
      }>;
    const folded = foldFinalTraceChoiceEvidence(evidence.map((item) => ({
      order: item.lane_sequence, text: item.text, truncated: item.truncated === 1
    })));
    return folded.decision === "selected" ? folded.choice : folded.decision === "explicit-none" ? continueChoicePrompt() : undefined;
  }

  markDetachedPromptRecoveryNeedsHuman(input: DetachedPromptNeedsHumanInput): DetachedPromptNeedsHumanResult {
    return this.context.transaction("sqlite.prompt-recovery-store.write", () => this.markDetachedPromptRecoveryNeedsHumanInTransaction(input, "turn.recovery.cursor_gap"));
  }

  private markDetachedPromptRecoveryNeedsHumanInTransaction(
    input: Omit<DetachedPromptNeedsHumanInput, "renderRunCard"> & { renderRunCard?: DetachedPromptNeedsHumanInput["renderRunCard"] },
    auditAction: "turn.recovery.ambiguous" | "turn.recovery.cursor_gap"
  ): DetachedPromptNeedsHumanResult {
    const candidate = this.context.database.prepare(`SELECT b.root_message_id
      FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id JOIN bindings b ON b.id = p.binding_id
      WHERE p.id = ? AND p.binding_id = ? AND p.execution_origin = 'bridge'
        AND p.state IN ('running','recovering') AND p.observation_state = 'detached'
        AND p.native_submission_id = p.id AND p.parent_prompt_id IS NULL
        AND c.binding_generation = ? AND b.generation = c.binding_generation
        AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
        AND b.pane_id = ? AND b.agent_session_kind = 'id' AND b.agent_session_value = ?`)
      .get(input.promptId, input.bindingId, input.expectedBindingGeneration, input.expectedPaneId, input.expectedNativeSessionId) as { root_message_id: string | null } | undefined;
    if (!candidate) return { outcome: "stale" };
    const changed = this.context.database.prepare(`UPDATE prompt_jobs
      SET state = 'uncertain', observation_state = 'completed', error = ?, updated_at = ?
      WHERE id = ? AND binding_id = ? AND state IN ('running','recovering') AND observation_state = 'detached'`)
      .run(input.reason, input.occurredAt, input.promptId, input.bindingId);
    if (Number(changed.changes) !== 1) return { outcome: "stale" };
    const current = this.projections.loadRunCard(input.promptId);
    if (!current) throw new Error(`Run card missing for prompt: ${input.promptId}`);
    const next = reduceRunCard(current, { type: "uncertain", occurredAt: input.occurredAt, notice: input.reason });
    this.projections.saveRunCard(next);
    this.context.database.prepare("UPDATE answer_pages SET state = 'frozen', updated_at = ? WHERE prompt_id = ? AND state = 'active'").run(input.occurredAt, input.promptId);
    const topic = this.projections.loadTopicView(input.bindingId);
    if (topic) this.projections.saveTopicView(mirrorRunCardToTopic(topic, next));
    let outboxReserved = false;
    if (next.answerMessageId && input.renderRunCard) {
      const cardSequence = next.answerCardId ? incrementPrimaryAnswerPageSequence(this.context, next.promptId, next.answerPageIndex) : null;
      this.reservePrimaryAnswer({
        id: randomUUID(), idempotencyKey: `run-card:update:${next.promptId}:answer:${next.viewVersion}`,
        bindingId: next.bindingId, bindingGeneration: next.bindingGeneration, promptId: next.promptId, viewVersion: next.viewVersion, cardSequence,
        streamPageIndex: next.answerPageIndex, cardRole: "answer", rootMessageId: next.answerMessageId,
        kind: "card_update", payload: JSON.stringify(input.renderRunCard(next))
      });
      outboxReserved = true;
    } else if (candidate.root_message_id && input.renderRunCard) {
      const pendingCreate = this.context.database.prepare("SELECT idempotency_key, gateway_plan_hash FROM outbound_replies WHERE prompt_id = ? AND card_role = 'answer' AND state = 'pending' AND kind = 'stream_card_create' ORDER BY delivery_order LIMIT 1").get(next.promptId) as { idempotency_key: string; gateway_plan_hash: string | null } | undefined;
      if (pendingCreate) {
        if (pendingCreate.gateway_plan_hash === null && !this.preparedDeliveryReservation) {
          this.reservePrimaryAnswer({
            id: randomUUID(), idempotencyKey: pendingCreate.idempotency_key, bindingId: next.bindingId, bindingGeneration: next.bindingGeneration,
            promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer",
            rootMessageId: candidate.root_message_id, kind: "stream_card_create",
            payload: JSON.stringify({ card: input.renderRunCard(next), stream: { pageIndex: 0, pageStart: 0, elementId: next.answerElementId } })
          });
        }
        outboxReserved = true;
      }
    }
    this.context.database.prepare("DELETE FROM detached_prompt_recovery_attempts WHERE prompt_id = ?").run(input.promptId);
    this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES ('system:turn-recovery', ?, ?, 'uncertain', ?)")
      .run(auditAction, `binding:${input.bindingId}:prompt:${input.promptId}`, input.occurredAt);
    return { outcome: "needs_human", outboxReserved };
  }

  private reserveLateRecoveryContinuation(input: ProjectedBridgeTurnRecoveryInput, rootMessageId: string | null, turnId: string, terminalState: "completed" | "aborted"): boolean {
    if (!input.renderRunCard || !rootMessageId) return false;
    const view = this.projections.loadRunCard(input.promptId);
    if (!view) throw new Error(`Run card missing for prompt: ${input.promptId}`);
    const page = this.context.database.prepare("SELECT COALESCE(MAX(page_index), -1) AS page_index FROM answer_pages WHERE prompt_id = ?").get(input.promptId) as { page_index: number };
    const nextPageIndex = Number(page.page_index) + 1;
    const nextElementId = answerElementId(input.promptId, nextPageIndex);
    const continuationView = {
      ...view, answerMessageId: null, answerCardId: null, answerElementId: nextElementId,
      answerSequence: 0, answerPageIndex: nextPageIndex, answerPageStart: 0,
      notice: terminalState === "completed"
        ? "已通过精确 turn identity 补回历史结果；原冻结页面未修改。"
        : `已通过精确 turn identity 补回历史结果；原冻结页面未修改。\n\n${view.notice ?? "TraeX turn was aborted"}`
    };
    const reply = this.reservePrimaryAnswer({
      id: randomUUID(), idempotencyKey: `prompt-recovery-continuation:${input.promptId}:${turnId}:${terminalState}`,
      bindingId: input.bindingId, bindingGeneration: view.bindingGeneration, promptId: input.promptId, viewVersion: view.viewVersion, cardRole: "answer", workClass: "history",
      rootMessageId, kind: "stream_card_create",
      payload: JSON.stringify({ card: input.renderRunCard(continuationView), stream: { pageIndex: nextPageIndex, pageStart: 0, elementId: nextElementId } })
    });
    return reply.state === "pending";
  }

  private insertRecoveredPromptTurn(input: ProjectedBridgeTurnRecoveryInput, turnId: string, startedAt: string): void {
    this.context.database.prepare(`INSERT INTO prompt_transcript_turns(
      prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at, chain_id, parent_turn_id, origin, ordinal, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prompt', 0, ?)`).run(
      input.promptId, input.bindingId, input.expectedBindingGeneration, input.expectedPaneId,
      input.expectedNativeSessionId, turnId, startedAt, turnId, input.occurredAt
    );
  }

  private finishProjectedBridgeRecovery(input: { promptId: string; bindingId: string; occurredAt: string }, turnId: string, terminalState: "completed" | "aborted"): void {
    this.context.database.prepare("DELETE FROM detached_prompt_recovery_attempts WHERE prompt_id = ?").run(input.promptId);
    this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES ('system:turn-recovery', 'turn.recovery.bridge_projected', ?, ?, ?)")
      .run(`binding:${input.bindingId}:prompt:${input.promptId}:turn:${turnId}`, terminalState, input.occurredAt);
  }

  private terminalizeDetachedPrompt(input: {
    promptId: string; bindingId: string; expectedBindingGeneration: number; reason: string; occurredAt: string;
    rootMessageId: string | null; renderRunCard(view: RunCardView): object;
    auditActor: string; auditAction: "swarm.skip" | "swarm.auto_skip"; auditTarget: string;
  }): { outcome: "skipped"; promptId: string; outboxReserved: boolean } | { outcome: "stale" } {
    const changed = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'cancelled', observation_state = 'completed', error = ?, updated_at = ? WHERE id = ? AND binding_id = ? AND ((state = 'recovering' AND observation_state = 'detached') OR (state = 'uncertain' AND observation_state = 'completed')) AND EXISTS (SELECT 1 FROM run_cards c WHERE c.prompt_id = prompt_jobs.id AND c.binding_generation = ?)`).run(input.reason, input.occurredAt, input.promptId, input.bindingId, input.expectedBindingGeneration);
    if (Number(changed.changes) !== 1) return { outcome: "stale" };
    const current = this.projections.loadRunCard(input.promptId);
    if (!current) throw new Error(`Run card missing for prompt: ${input.promptId}`);
    const next = reduceRunCard(current, { type: "uncertain", occurredAt: input.occurredAt, notice: input.reason });
    this.projections.saveRunCard(next);
    this.context.database.prepare("UPDATE answer_pages SET state = 'frozen', updated_at = ? WHERE prompt_id = ? AND state = 'active'").run(input.occurredAt, input.promptId);
    const topic = this.projections.loadTopicView(input.bindingId);
    if (topic) this.projections.saveTopicView(mirrorRunCardToTopic(topic, next));
    let outboxReserved = false;
    if (next.answerMessageId) {
      const cardSequence = next.answerCardId
        ? incrementPrimaryAnswerPageSequence(this.context, next.promptId, next.answerPageIndex)
        : null;
      this.reservePrimaryAnswer({ id: randomUUID(), idempotencyKey: `run-card:update:${next.promptId}:answer:${next.viewVersion}`, bindingId: next.bindingId, bindingGeneration: next.bindingGeneration, promptId: next.promptId, viewVersion: next.viewVersion, cardSequence, streamPageIndex: next.answerPageIndex, cardRole: "answer", rootMessageId: next.answerMessageId, kind: "card_update", payload: JSON.stringify(input.renderRunCard(next)) });
      outboxReserved = true;
    } else if (input.rootMessageId) {
      const pendingCreate = this.context.database.prepare("SELECT idempotency_key, gateway_plan_hash FROM outbound_replies WHERE prompt_id = ? AND card_role = 'answer' AND state = 'pending' AND kind = 'stream_card_create' ORDER BY delivery_order LIMIT 1").get(next.promptId) as { idempotency_key: string; gateway_plan_hash: string | null } | undefined;
      if (pendingCreate) {
        if (pendingCreate.gateway_plan_hash === null && !this.preparedDeliveryReservation) {
          this.reservePrimaryAnswer({ id: randomUUID(), idempotencyKey: pendingCreate.idempotency_key, bindingId: next.bindingId, bindingGeneration: next.bindingGeneration, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.renderRunCard(next), stream: { pageIndex: 0, pageStart: 0, elementId: next.answerElementId } }) });
        }
        outboxReserved = true;
      }
    }
    this.context.database.prepare("DELETE FROM detached_prompt_recovery_attempts WHERE prompt_id = ?").run(input.promptId);
    this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, ?, ?, 'uncertain', ?)").run(input.auditActor, input.auditAction, input.auditTarget, input.occurredAt);
    return { outcome: "skipped", promptId: input.promptId, outboxReserved };
  }

  private reservePrimaryAnswer(input: PreparedDeliveryReservationInput): OutboundReply {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Prompt Recovery prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

  private persistRunCardChange(promptId: string, change: RunCardChange, mirrorTopic = true, required = true): void {
    const current = this.projections.loadRunCard(promptId);
    if (!current) {
      if (required) throw new Error(`Run card missing for prompt: ${promptId}`);
      return;
    }
    let next = reduceRunCard(current, change);
    if (next.phase === "completed" || next.phase === "failed") {
      const invalidation = this.dependencies.loadCardContextInvalidation({ targetKind: "primary-turn", targetId: next.promptId, targetGeneration: next.bindingGeneration });
      const revision = Math.max(next.workerDependencyRevision, invalidation?.requestedDependencyRevision ?? 0);
      next = freezeRunCardWorkerContext(updateRunCardWorkerContext(next, selectPrimaryWorkerActivity(this.dependencies.loadPrimaryWorkerActivity(next.promptId, next.bindingGeneration)), revision, change.occurredAt), change.occurredAt);
    }
    if (next !== current) this.projections.saveRunCard(next);
    const topic = this.projections.loadTopicView(current.bindingId);
    if (mirrorTopic && topic) this.projections.saveTopicView(mirrorRunCardToTopic(topic, next));
  }

  private persistTerminalRunCard(promptId: string, change: RunCardChange & { completionChoice?: import("../../domain/completion-choice.js").ChoicePrompt }, mirrorTopic = true): void {
    if (change.type === "completed") {
      const current = this.projections.loadRunCard(promptId);
      if (current) {
        const normalized = normalizeAndPersistCompletionChoice({
          context: this.context,
          ownerKind: "primary-prompt",
          ownerId: promptId,
          ownerGeneration: current.bindingGeneration,
          answer: change.answer,
          ...(change.completionChoice ? { completionChoice: change.completionChoice } : {}),
          occurredAt: change.occurredAt
        });
        change = { ...change, answer: normalized.answer };
      }
    }
    this.persistRunCardChange(promptId, change, mirrorTopic);
  }
}

function now(): string { return new Date().toISOString(); }
const DETACHED_RECOVERY_ATTEMPT_LIMIT = 3;
function recoveryAttemptDueAt(occurredAtMs: number, attemptCount: number): string {
  const delayMs = Math.min(300_000, 30_000 * 2 ** Math.max(0, attemptCount - 1));
  return new Date(occurredAtMs + delayMs).toISOString();
}
function normalizeCoreTurnStartedAt(value: string): string {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(Math.floor(milliseconds / 1_000) * 1_000).toISOString() : value;
}
function parsePersistedCompletionChoice(value: unknown): import("../../domain/completion-choice.js").ChoicePrompt | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isFinalMessageCompletionChoice(parsed) ? choicePromptFromLegacyCompletionChoice(parsed) : undefined;
  } catch { return undefined; }
}
function promptIds(rows: Array<{ id: string }>): string[] { return rows.map(({ id }) => id); }
function placeholders(rows: Array<{ id: string }>): string { return rows.length > 0 ? rows.map(() => "?").join(", ") : "NULL"; }
