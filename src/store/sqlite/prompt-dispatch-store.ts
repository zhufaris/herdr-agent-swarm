import type { Binding, HerdrAgentSession, PromptJob, PromptObservationState, PromptState, PromptTranscriptTurn, TranscriptTurnAdoptionOutcome, TranscriptTurnClaimOutcome } from "../../domain/types.js";
import { freezeRunCardWorkerContext, reduceRunCard, updateRunCardWorkerContext, type RunCardChange } from "../../domain/run-card-view.js";
import { mirrorRunCardToTopic } from "../../domain/topic-view.js";
import { selectPrimaryWorkerActivity, type PrimaryWorkerActivitySummary } from "../../domain/card-context-summary.js";
import type { CardContextInvalidation, CardContextTarget } from "../../domain/card-context-invalidation.js";
import type { SessionTransition } from "../../domain/pane-thread-lifecycle.js";
import { mapBinding, mapModelPreference, mapPrompt, type BindingRow, type ModelPreferenceRow, type PromptRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import { normalizeAndPersistCompletionChoice } from "./completion-choice-store.js";
import { choicePromptFromLegacyCompletionChoice, continueChoicePrompt, isFinalMessageCompletionChoice, selectCompletionChoiceTerminalAnswer, selectCompletionChoiceTerminalInput } from "../../domain/completion-choice.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { ModelDispatchEvidenceCommand } from "../../domain/model-selection.js";
import { outputFingerprint } from "../../domain/output-fingerprint.js";
import { supersededDetachedPromptNotice, terminalizeOlderDetachedPromptOwners } from "./prompt-running-integrity.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { PrimaryCompletionResult } from "../../domain/ports/prompt-run.js";
import type { ClaimedPrompt } from "../../domain/ports/prompt-acceptance.js";
import { PrimaryCompletionActionEligibility } from "./primary-completion-action-eligibility.js";
import { coreEventDiscriminatorSql } from "./core-event-discriminators.js";
import { foldFinalTraceChoiceEvidence } from "../../domain/final-trace-envelope.js";

export interface PromptDispatchStoreDependencies {
  persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  loadCardContextInvalidation(target: CardContextTarget): CardContextInvalidation | null;
  loadPrimaryWorkerActivity(promptId: string, bindingGeneration: number): PrimaryWorkerActivitySummary[];
  getBinding(id: string): Binding | null;
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0]): unknown;
}

interface NativeInputExecutionMemberRow {
  ordinal: number;
  body: string;
  binding_id: string;
  binding_generation: number;
  state: string;
  batch_id: string | null;
}

export class SqlitePromptDispatchStore {
  private readonly completionActionEligibility: PrimaryCompletionActionEligibility;
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: PromptDispatchStoreDependencies
  ) {
    this.completionActionEligibility = new PrimaryCompletionActionEligibility(context, {
      getBinding: dependencies.getBinding,
      loadRunCard: (promptId) => projections.loadRunCard(promptId)
    });
  }

  getActiveOrdinaryPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    const rows = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id JOIN run_cards r ON r.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state IN ('submitted','running')
        AND NOT (p.state = 'submitted' AND p.observation_state = 'detached')
        AND b.generation = ? AND p.session_epoch = b.session_epoch AND r.binding_generation = b.generation AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 2`).all(bindingId, expectedGeneration) as PromptRow[];
    return rows.length === 1 ? mapPrompt(rows[0]!) : null;
  }

  getActiveBridgePrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    const rows = this.context.database.prepare(`SELECT p.* FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id JOIN run_cards r ON r.prompt_id = p.id
      WHERE p.binding_id = ? AND p.execution_origin = 'bridge'
        AND (
          (p.state = 'submitted' AND p.native_submission_id = p.id AND p.transcript_turn_id IS NULL)
          OR
          (p.state = 'running' AND p.observation_state = 'detached'
            AND p.transcript_turn_id IS NOT NULL AND p.transcript_turn_started_at IS NOT NULL)
        )
        AND NOT EXISTS (
          SELECT 1 FROM prompt_jobs exact_owner
          JOIN run_cards exact_card ON exact_card.prompt_id = exact_owner.id
          WHERE exact_owner.binding_id = p.binding_id AND exact_owner.id != p.id
            AND exact_owner.state = 'running'
            AND exact_owner.transcript_turn_id IS NOT NULL AND exact_owner.transcript_turn_started_at IS NOT NULL
            AND exact_card.binding_generation = r.binding_generation
        )
        AND b.generation = ? AND p.session_epoch = b.session_epoch AND r.binding_generation = b.generation AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
      ORDER BY p.created_at, p.rowid LIMIT 2`).all(bindingId, expectedGeneration) as PromptRow[];
    return rows.length === 1 ? mapPrompt(rows[0]!) : null;
  }

  getPrompt(id: string): PromptJob | null {
    const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(id) as PromptRow | undefined;
    return row ? mapPrompt(row) : null;
  }

  claimNextDispatchablePrompt(bindingId: string, options: { nativeInputBatchOnly?: boolean } = {}): ClaimedPrompt | null {
    return this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
      const bindingRow = this.context.database.prepare(`
        SELECT * FROM bindings WHERE id = ? AND state = 'active' AND lifecycle = 'active'
          AND attachment = 'attached' AND pane_id IS NOT NULL
          AND last_agent_state IN ('idle','done')
          AND NOT EXISTS (SELECT 1 FROM orchestrator_identity_migrations migration WHERE migration.binding_id = bindings.id AND migration.state IN ('accepted','applying','uncertain'))
      `).get(bindingId) as BindingRow | undefined;
      if (!bindingRow) return null;
      const row = this.context.database.prepare(`
        SELECT p.*, CASE WHEN batch.id IS NULL THEN 0 ELSE 1 END AS native_input_batch
        FROM prompt_jobs p
        LEFT JOIN native_input_batches batch
          ON batch.execution_prompt_id = p.id
          AND batch.binding_id = p.binding_id
          AND batch.binding_generation = ?
          AND batch.state = 'formed'
        WHERE p.binding_id = ? AND p.session_epoch = ? AND p.state = 'queued' AND p.observation_state = 'not_started'
          AND (? = 0 OR batch.id IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM prompt_jobs active
            WHERE active.binding_id = p.binding_id
              AND active.state IN ('submitted','running','recovering','uncertain')
          )
        ORDER BY CASE p.priority WHEN 'priority' THEN 0 ELSE 1 END, p.created_at, p.rowid LIMIT 1
      `).get(Number(bindingRow.generation), bindingId, Number(bindingRow.session_epoch), options.nativeInputBatchOnly ? 1 : 0) as (PromptRow & { native_input_batch: number }) | undefined;
      if (!row) return null;
      const executionBody = row.native_input_batch === 1
        ? this.loadNativeInputBatchExecutionBody(row.id, bindingId, Number(bindingRow.generation))
        : row.body;
      const claimed = this.context.database.prepare("UPDATE prompt_jobs SET state = 'submitted', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'queued' AND observation_state = 'not_started'").run(now(), row.id);
      if (Number(claimed.changes) !== 1) throw new Error(`Prompt ${row.id} was not atomically claimed`);
      this.persistRunCardChange(row.id, { type: "submitted", occurredAt: now() }, false);
      const preference = this.context.database.prepare("SELECT * FROM binding_model_preferences WHERE binding_id = ? AND binding_generation = ? AND state = 'pending'").get(bindingId, Number(bindingRow.generation)) as ModelPreferenceRow | undefined;
      if (preference) {
        const pinned = this.context.database.prepare("UPDATE prompt_jobs SET model_name = ?, model_revision = ? WHERE id = ? AND model_revision IS NULL").run(preference.desired_model, preference.desired_revision, row.id);
        const applying = this.context.database.prepare("UPDATE binding_model_preferences SET state = 'applying', dispatch_prompt_id = ?, prepared_operation_id = NULL, updated_at = ? WHERE binding_id = ? AND binding_generation = ? AND desired_revision = ? AND state = 'pending'").run(row.id, now(), bindingId, Number(bindingRow.generation), preference.desired_revision);
        if (Number(pinned.changes) !== 1 || Number(applying.changes) !== 1) throw new Error(`Model revision ${preference.desired_revision} was not atomically pinned`);
      }
      const promptRow = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(row.id) as PromptRow;
      return {
        binding: mapBinding(bindingRow), prompt: mapPrompt(promptRow), executionBody,
        model: preference ? { name: mapModelPreference(preference).desiredModel, revision: Number(preference.desired_revision) } : null,
        nativeInputBatch: row.native_input_batch === 1
      };
    });
  }

  private loadNativeInputBatchExecutionBody(promptId: string, bindingId: string, bindingGeneration: number): string {
    const members = this.context.database.prepare(`
      SELECT member.ordinal, input.body, input.binding_id, input.binding_generation, input.state, input.batch_id
      FROM native_input_batches batch
      JOIN native_input_batch_members member ON member.batch_id = batch.id
      JOIN prompt_inputs input ON input.id = member.prompt_input_id
      WHERE batch.execution_prompt_id = ? AND batch.binding_id = ? AND batch.binding_generation = ? AND batch.state = 'formed'
      ORDER BY member.ordinal
    `).all(promptId, bindingId, bindingGeneration) as unknown as NativeInputExecutionMemberRow[];
    const assigned = this.context.database.prepare(`
      SELECT COUNT(*) AS count
      FROM native_input_batches batch
      JOIN prompt_inputs input ON input.batch_id = batch.id
      WHERE batch.execution_prompt_id = ? AND batch.binding_id = ? AND batch.binding_generation = ? AND batch.state = 'formed'
    `).get(promptId, bindingId, bindingGeneration) as { count: number } | undefined;
    const valid = members.length >= 1 && members.length <= 3
      && Number(assigned?.count ?? 0) === members.length
      && members.every((member, ordinal) => member.ordinal === ordinal
        && member.binding_id === bindingId
        && Number(member.binding_generation) === bindingGeneration
        && member.state === "batched"
        && member.batch_id === promptId);
    if (!valid) throw new Error(`Native Input Batch ${promptId} has invalid durable members`);
    return members.map(({ body }) => body).join("\n\n");
  }

  updatePrompt(id: string, state: PromptState, error: string | null = null): void {
    const observationState: PromptObservationState = state === "queued" ? "not_started" : state === "submitted" || state === "running" ? "attached" : state === "recovering" ? "detached" : "completed";
    this.context.database.prepare("UPDATE prompt_jobs SET state = ?, observation_state = ?, error = ?, updated_at = ? WHERE id = ?").run(state, observationState, error, now(), id);
  }

  completeTurn(input: { promptId: string; bindingId: string; answer: string; completionChoice?: import("../../domain/completion-choice.js").ChoicePrompt; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): PrimaryCompletionResult {
    return this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
      const current = this.getPrompt(input.promptId);
      const bindingBefore = this.dependencies.getBinding(input.bindingId);
      if (!bindingBefore) throw new Error(`Binding not found: ${input.bindingId}`);
      const completed = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'delivered', observation_state = 'completed', error = NULL, updated_at = ?
        WHERE id = ? AND binding_id = ? AND session_epoch = ?`).run(input.occurredAt, input.promptId, input.bindingId, bindingBefore.sessionEpoch);
      if (Number(completed.changes) !== 1) return { binding: bindingBefore, completionActionEligibility: { outcome: "skipped", reason: "not-completion" } };
      this.dependencies.persistBindingPatch(input.bindingId, { lastOutputFingerprint: input.outputFingerprint });
      const binding = this.dependencies.transitionBinding(input.bindingId, { type: "turn_completed" });
      this.persistTerminalRunCard(input.promptId, { type: "completed", occurredAt: input.occurredAt, answer: input.answer, ...(input.completionChoice ? { completionChoice: input.completionChoice } : {}), ...(input.replaceAnswer === undefined ? {} : { replaceAnswer: input.replaceAnswer }) });
      const completionActionEligibility = !current || !["submitted", "running"].includes(current.state)
        ? { outcome: "skipped" as const, reason: "not-completion" as const }
        : this.completionActionEligibility.defer({ bindingId: input.bindingId, promptId: input.promptId, occurredAt: input.occurredAt });
      return { binding, completionActionEligibility };
    });
  }

  repairProjectedExternalTurn(input: { promptId: string; bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: HerdrAgentSession; turnId: string; startedAt: string; occurredAt: string }):
    | { outcome: "repaired"; terminalState: "completed"; answer: string; completionActionEligibility?: import("../../domain/completion-action-eligibility.js").CompletionActionEligibilityReservation }
    | { outcome: "repaired"; terminalState: "aborted"; error: string }
    | { outcome: "not_found" | "ambiguous" | "stale" } {
    const eventType = coreEventDiscriminatorSql(this.context.database, "i", "event_type");
    const channel = coreEventDiscriminatorSql(this.context.database, "i", "channel");
    return this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
      const prompt = this.context.database.prepare(`SELECT p.id, r.answer FROM prompt_jobs p
        JOIN bindings b ON b.id = p.binding_id JOIN run_cards r ON r.prompt_id = p.id
        WHERE p.id = ? AND p.binding_id = ? AND p.execution_origin = 'herdr'
          AND p.state = 'running' AND p.observation_state = 'detached'
          AND p.transcript_turn_id = ? AND p.transcript_turn_started_at = ?
          AND b.generation = ? AND r.binding_generation = b.generation
          AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
          AND b.pane_id = ? AND b.agent_session_source = ? AND b.agent_session_agent = ?
          AND b.agent_session_kind = ? AND b.agent_session_value = ?
      `).get(input.promptId, input.bindingId, input.turnId, input.startedAt, input.expectedGeneration,
        input.expectedPaneId, input.expectedSession.source, input.expectedSession.agent,
        input.expectedSession.kind, input.expectedSession.value) as { id: string; answer: string } | undefined;
      if (!prompt) return { outcome: "stale" };

      const evidence = this.context.database.prepare(`SELECT i.source_id, l.lane_id, l.sequence AS lane_sequence, i.occurred_at,
          ${eventType} AS event_type,
          ${channel} AS channel,
          json_extract(i.event_json, '$.payload.text') AS text,
          json_type(i.event_json, '$.payload.text') AS text_type,
          json_extract(i.event_json, '$.payload.truncated') AS truncated,
          json_extract(i.event_json, '$.payload.completion_choice') AS completion_choice,
          json_type(i.event_json, '$.payload.completion_choice') AS completion_choice_type,
          json_extract(i.event_json, '$.payload.reason') AS reason
        FROM core_event_inbox i JOIN core_event_lane_items l ON l.event_id = i.event_id AND l.state = 'projected'
        WHERE i.agent_kind = ? AND i.session_id = ? AND i.turn_id = ?
          AND i.payload_compacted_at IS NULL
        ORDER BY l.lane_id, l.sequence`).all(
          input.expectedSession.agent, input.expectedSession.value, input.turnId
        ) as Array<{
          source_id: string; lane_id: string; lane_sequence: number; occurred_at: string; event_type: string;
          channel: string | null; text: unknown; text_type: string | null; truncated: number | null;
          completion_choice: unknown; completion_choice_type: string | null; reason: string | null;
        }>;
      const terminals = evidence.filter((row) => row.event_type === "turn_completed" || row.event_type === "turn_aborted");
      if (terminals.length === 0) return { outcome: "not_found" };
      if (terminals.length !== 1) return { outcome: "ambiguous" };

      const terminal = terminals[0]!;
      const selectedEvidence = evidence.filter((row) => row.source_id === terminal.source_id && row.lane_id === terminal.lane_id && row.lane_sequence <= terminal.lane_sequence);
      const hasExactStart = selectedEvidence.some((row) => row.event_type === "turn_started" && sameInstant(row.occurred_at, input.startedAt));
      if (!hasExactStart) return { outcome: "not_found" };
      if (terminal.event_type === "turn_completed") {
        const finalMessage = selectedEvidence.filter((row) => row.lane_sequence < terminal.lane_sequence && row.event_type === "message" && row.channel === "final" && row.text_type === "text" && typeof row.text === "string").at(-1);
        const finalText = typeof finalMessage?.text === "string" ? finalMessage.text : undefined;
        const terminalInput = selectCompletionChoiceTerminalInput(finalText, prompt.answer);
        const answer = selectCompletionChoiceTerminalAnswer(finalText, prompt.answer);
        const completionChoice = finalMessage?.completion_choice_type === "object"
          ? parsePersistedCompletionChoice(finalMessage.completion_choice)
          : finalMessage?.completion_choice_type === null
            ? selectFoldedCompletionChoice(selectedEvidence)
            : undefined;
        const changed = this.context.database.prepare(`UPDATE prompt_jobs
          SET state = 'delivered', observation_state = 'completed', error = NULL, updated_at = ?
          WHERE id = ? AND binding_id = ? AND execution_origin = 'herdr'
            AND state = 'running' AND observation_state = 'detached'
            AND transcript_turn_id = ? AND transcript_turn_started_at = ?`).run(
              input.occurredAt, input.promptId, input.bindingId, input.turnId, input.startedAt
            );
        if (Number(changed.changes) !== 1) return { outcome: "stale" };
        this.dependencies.persistBindingPatch(input.bindingId, { lastOutputFingerprint: outputFingerprint(answer) });
        this.dependencies.transitionBinding(input.bindingId, { type: "turn_completed" });
        this.persistTerminalRunCard(input.promptId, { type: "completed", occurredAt: input.occurredAt, answer: terminalInput, ...(completionChoice ? { completionChoice } : {}), replaceAnswer: finalMessage !== undefined });
        const completionActionEligibility = this.completionActionEligibility.defer({ bindingId: input.bindingId, promptId: input.promptId, occurredAt: input.occurredAt });
        this.finishProjectedExternalRepair(input, "completed");
        return { outcome: "repaired", terminalState: "completed", answer, completionActionEligibility };
      }

      const error = terminal.reason ? `TraeX turn was aborted: ${terminal.reason}` : "TraeX turn was aborted";
      const changed = this.context.database.prepare(`UPDATE prompt_jobs
        SET state = 'failed', observation_state = 'completed', error = ?, updated_at = ?
        WHERE id = ? AND binding_id = ? AND execution_origin = 'herdr'
          AND state = 'running' AND observation_state = 'detached'
          AND transcript_turn_id = ? AND transcript_turn_started_at = ?`).run(
            error, input.occurredAt, input.promptId, input.bindingId, input.turnId, input.startedAt
          );
      if (Number(changed.changes) !== 1) return { outcome: "stale" };
      this.persistTerminalRunCard(input.promptId, { type: "failed", occurredAt: input.occurredAt, notice: error });
      this.finishProjectedExternalRepair(input, "aborted");
      return { outcome: "repaired", terminalState: "aborted", error };
    });
  }

  private finishProjectedExternalRepair(input: { promptId: string; bindingId: string; turnId: string; occurredAt: string }, terminalState: "completed" | "aborted"): void {
    this.context.database.prepare("DELETE FROM external_turn_recovery_attempts WHERE prompt_id = ?").run(input.promptId);
    this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES ('system:turn-recovery', 'turn.recovery.projected_owner', ?, ?, ?)")
      .run(`binding:${input.bindingId}:prompt:${input.promptId}:turn:${input.turnId}`, terminalState, input.occurredAt);
  }

  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void {
    this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
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
    return this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
      const changed = this.context.database.prepare(`
        UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ?, updated_at = ?
        WHERE id = ? AND binding_id = ? AND execution_origin = 'herdr'
          AND state = 'running' AND observation_state IN ('attached','detached')
          AND transcript_turn_id = ? AND transcript_turn_started_at = ?
          AND EXISTS (
            SELECT 1 FROM bindings b JOIN run_cards r ON r.prompt_id = prompt_jobs.id
            WHERE b.id = prompt_jobs.binding_id AND b.generation = ? AND r.binding_generation = b.generation
              AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'
              AND b.pane_id = ? AND b.agent_session_source = ? AND b.agent_session_agent = ?
              AND b.agent_session_kind = ? AND b.agent_session_value = ?
              AND b.last_agent_state IN ('idle', 'done') AND b.last_observed_at = ?
              AND b.last_observed_at > prompt_jobs.transcript_turn_started_at
          )
      `).run(input.error, input.occurredAt, input.promptId, input.bindingId, input.turnId, input.startedAt, input.expectedGeneration, input.expectedPaneId, input.expectedSession.source, input.expectedSession.agent, input.expectedSession.kind, input.expectedSession.value, input.expectedObservedAt);
      if (Number(changed.changes) !== 1) return false;
      this.persistTerminalRunCard(input.promptId, { type: "failed", occurredAt: input.occurredAt, notice: input.error });
      this.context.database.prepare("DELETE FROM external_turn_recovery_attempts WHERE prompt_id = ? AND binding_id = ? AND binding_generation = ? AND pane_id = ? AND session_value = ? AND turn_id = ? AND started_at = ?")
        .run(input.promptId, input.bindingId, input.expectedGeneration, input.expectedPaneId, input.expectedSession.value, input.turnId, input.startedAt);
      this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES ('system:turn-recovery', 'turn.recovery.terminalized', ?, 'uncertain', ?)")
        .run(`binding:${input.bindingId}:prompt:${input.promptId}:turn:${input.turnId}`, input.occurredAt);
      return true;
    });
  }

  markPromptDispatched(id: string, dispatchedAt = now()): void {
    const dispatchedAtMs = Date.parse(dispatchedAt);
    if (!Number.isFinite(dispatchedAtMs) || new Date(dispatchedAtMs).toISOString() !== dispatchedAt) throw new Error("Invalid prompt dispatch timestamp");
    this.context.database.prepare("UPDATE prompt_jobs SET observation_state = 'attached', dispatched_at = ?, error = NULL, updated_at = ? WHERE id = ? AND state IN ('submitted','running') AND observation_state IN ('not_started','attached')").run(dispatchedAt, now(), id);
  }

  fencePromptNativeSubmission(input: { promptId: string; bindingId: string; submissionId: string; dispatchedAt: string }): boolean {
    if (input.submissionId !== input.promptId) throw new Error("Native submission ID must match the prompt ID");
    validateDispatchTimestamp(input.dispatchedAt);
    const changed = this.context.database.prepare(`
      UPDATE prompt_jobs
      SET observation_state = 'detached', was_detached = 1, dispatched_at = ?, native_submission_id = ?,
        error = 'Native submission call started; awaiting an exact outcome', updated_at = ?
      WHERE id = ? AND binding_id = ? AND state = 'submitted' AND observation_state = 'not_started'
        AND dispatched_at IS NULL AND (native_submission_id IS NULL OR native_submission_id = ?)
        AND transcript_turn_id IS NULL AND transcript_turn_started_at IS NULL
    `).run(input.dispatchedAt, input.submissionId, now(), input.promptId, input.bindingId, input.submissionId);
    return Number(changed.changes) === 1;
  }

  markPromptNativeQueued(input: { promptId: string; bindingId: string; submissionId: string; dispatchedAt: string; uncertainReason?: string }): boolean {
    if (input.submissionId !== input.promptId) throw new Error("Native submission ID must match the prompt ID");
    const current = this.context.database.prepare("SELECT native_submission_id FROM prompt_jobs WHERE id = ? AND binding_id = ?").get(input.promptId, input.bindingId) as { native_submission_id: string | null } | undefined;
    if (current && current.native_submission_id !== null && current.native_submission_id !== input.submissionId) throw new Error("Persisted native submission ID does not match the prompt ID");
    validateDispatchTimestamp(input.dispatchedAt);
    const changed = this.context.database.prepare(`
      UPDATE prompt_jobs
      SET observation_state = 'detached', was_detached = 1, dispatched_at = ?, native_submission_id = ?, error = ?, updated_at = ?
      WHERE id = ? AND binding_id = ? AND state IN ('submitted','recovering')
        AND ((observation_state = 'not_started' AND dispatched_at IS NULL)
          OR (observation_state = 'detached' AND dispatched_at = ?))
        AND (native_submission_id IS NULL OR native_submission_id = ?)
        AND transcript_turn_id IS NULL AND transcript_turn_started_at IS NULL
    `).run(input.dispatchedAt, input.submissionId, input.uncertainReason ?? null, now(), input.promptId, input.bindingId, input.dispatchedAt, input.submissionId);
    return Number(changed.changes) === 1;
  }

  applyPromptNativeSubmissionReceipt(input: { promptId: string; bindingId: string; submissionId: string; dispatchedAt: string; state: "accepted" | "uncertain"; notice: string }): boolean {
    if (input.submissionId !== input.promptId) throw new Error("Native submission ID must match the prompt ID");
    validateDispatchTimestamp(input.dispatchedAt);
    return this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
      const changed = this.context.database.prepare(`UPDATE prompt_jobs
        SET state = 'recovering', observation_state = 'detached', was_detached = 1, error = ?, updated_at = ?
        WHERE id = ? AND binding_id = ? AND state IN ('submitted','recovering') AND observation_state = 'detached'
          AND dispatched_at = ? AND native_submission_id = ?
          AND transcript_turn_id IS NULL AND transcript_turn_started_at IS NULL`)
        .run(input.notice, now(), input.promptId, input.bindingId, input.dispatchedAt, input.submissionId);
      if (Number(changed.changes) !== 1) return false;
      if (input.state === "uncertain") this.context.database.prepare(`UPDATE binding_model_preferences SET state = 'uncertain', updated_at = ?
        WHERE state = 'applying' AND dispatch_prompt_id = ?
          AND EXISTS (SELECT 1 FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE p.id = ? AND p.binding_id = binding_model_preferences.binding_id AND b.generation = binding_model_preferences.binding_generation AND p.model_name = binding_model_preferences.desired_model AND p.model_revision = binding_model_preferences.desired_revision)`)
        .run(now(), input.promptId, input.promptId);
      this.persistRunCardChange(input.promptId, { type: "recovering", occurredAt: now(), notice: input.notice });
      return true;
    });
  }

  releaseRejectedNativeSubmission(input: { promptId: string; bindingId: string; submissionId: string; dispatchedAt: string }): boolean {
    if (input.submissionId !== input.promptId) throw new Error("Native submission ID must match the prompt ID");
    validateDispatchTimestamp(input.dispatchedAt);
    return this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
      const current = this.context.database.prepare(`SELECT p.model_name, p.model_revision, b.generation
        FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
        WHERE p.id = ? AND p.binding_id = ? AND p.state IN ('submitted','recovering') AND p.observation_state = 'detached'
          AND p.dispatched_at = ? AND p.native_submission_id = ?
          AND p.transcript_turn_id IS NULL AND p.transcript_turn_started_at IS NULL`)
        .get(input.promptId, input.bindingId, input.dispatchedAt, input.submissionId) as { model_name: string | null; model_revision: number | null; generation: number } | undefined;
      if (!current) return false;
      if (current.model_name !== null && current.model_revision !== null) {
        const preference = this.context.database.prepare(`UPDATE binding_model_preferences
          SET state = 'pending', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = ?
          WHERE binding_id = ? AND binding_generation = ? AND desired_model = ? AND desired_revision = ?
            AND dispatch_prompt_id = ? AND state IN ('applying','uncertain') AND prepared_operation_id IS NULL`)
          .run(now(), input.bindingId, current.generation, current.model_name, current.model_revision, input.promptId);
        if (Number(preference.changes) !== 1) return false;
      }
      const changed = this.context.database.prepare(`UPDATE prompt_jobs
        SET state = 'queued', observation_state = 'not_started', was_detached = 0, dispatched_at = NULL,
          model_name = NULL, model_revision = NULL, error = NULL, updated_at = ?
        WHERE id = ? AND binding_id = ? AND state IN ('submitted','recovering') AND observation_state = 'detached'
          AND dispatched_at = ? AND native_submission_id = ?
          AND transcript_turn_id IS NULL AND transcript_turn_started_at IS NULL`)
        .run(now(), input.promptId, input.bindingId, input.dispatchedAt, input.submissionId);
      if (Number(changed.changes) !== 1) throw new Error("Native submission rejection fence changed during release");
      this.context.database.prepare(`UPDATE run_cards
        SET phase = 'queued', started_at = NULL, notice = NULL, queue_position = 1,
          view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?`)
        .run(now(), input.promptId);
      return true;
    });
  }

  recordModelDispatchEvidence(input: ModelDispatchEvidenceCommand): boolean {
    if (input.kind === "prepared") return this.markModelPromptPrepared(input);
    if (input.kind === "prepare_aborted") return this.rollbackPreparedModelPrompt(input);
    return this.markModelPromptAccepted(input);
  }

  private markModelPromptPrepared(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string }): boolean {
    const changed = this.context.database.prepare(`UPDATE binding_model_preferences SET prepared_operation_id = ?, updated_at = ? WHERE binding_id = ? AND binding_generation = ? AND desired_revision = ? AND dispatch_prompt_id = ? AND state = 'applying' AND (prepared_operation_id IS NULL OR prepared_operation_id = ?)`).run(input.operationId, now(), input.bindingId, input.bindingGeneration, input.revision, input.promptId, input.operationId);
    return Number(changed.changes) === 1;
  }

  private markModelPromptAccepted(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string; turnId: string }): boolean {
    return this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
      const timestamp = now();
      const preference = this.context.database.prepare(`UPDATE binding_model_preferences SET effective_model = desired_model, effective_revision = desired_revision, state = 'effective', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = ? WHERE binding_id = ? AND binding_generation = ? AND desired_revision = ? AND dispatch_prompt_id = ? AND prepared_operation_id = ? AND state = 'applying'`).run(timestamp, input.bindingId, input.bindingGeneration, input.revision, input.promptId, input.operationId);
      if (Number(preference.changes) !== 1) return false;
      const prompt = this.context.database.prepare("UPDATE prompt_jobs SET transcript_turn_id = ?, updated_at = ? WHERE id = ? AND binding_id = ? AND model_revision = ? AND state = 'submitted' AND (transcript_turn_id IS NULL OR transcript_turn_id = ?)").run(input.turnId, timestamp, input.promptId, input.bindingId, input.revision, input.turnId);
      if (Number(prompt.changes) !== 1) throw new Error(`Model prompt ${input.promptId} acceptance was not atomically fenced`);
      return true;
    });
  }

  private rollbackPreparedModelPrompt(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string }): boolean {
    return this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
      const timestamp = now();
      const preference = this.context.database.prepare(`UPDATE binding_model_preferences SET state = 'pending', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = ? WHERE binding_id = ? AND binding_generation = ? AND desired_revision = ? AND dispatch_prompt_id = ? AND prepared_operation_id = ? AND state = 'applying'`).run(timestamp, input.bindingId, input.bindingGeneration, input.revision, input.promptId, input.operationId);
      if (Number(preference.changes) !== 1) return false;
      const prompt = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'queued', observation_state = 'not_started', dispatched_at = NULL, model_name = NULL, model_revision = NULL, updated_at = ? WHERE id = ? AND binding_id = ? AND model_revision = ? AND state = 'submitted' AND observation_state IN ('not_started','attached') AND transcript_turn_id IS NULL`).run(timestamp, input.promptId, input.bindingId, input.revision);
      if (Number(prompt.changes) !== 1) throw new Error(`Model prompt ${input.promptId} abort was not atomically fenced`);
      return true;
    });
  }

  claimPromptTranscriptTurn(input: { promptId: string; bindingId: string; turnId: string; startedAt: string }): TranscriptTurnClaimOutcome {
    return this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
      const before = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ? AND binding_id = ?").get(input.promptId, input.bindingId) as PromptRow | undefined;
      if (!before) return { state: "ineligible", prompt: null };
      if (before.transcript_turn_id !== null && (before.transcript_turn_id !== input.turnId || before.transcript_turn_started_at !== null)) return { state: before.transcript_turn_id === input.turnId ? "matched" : "conflict", prompt: mapPrompt(before) };
      const startedAtMs = Date.parse(input.startedAt);
      const dispatchedAtMs = before.dispatched_at === null ? Number.NaN : Date.parse(before.dispatched_at);
      if (!Number.isFinite(startedAtMs) || !Number.isFinite(dispatchedAtMs) || startedAtMs < dispatchedAtMs - 1_000) return { state: "ineligible", prompt: mapPrompt(before) };
      const result = this.context.database.prepare(`UPDATE prompt_jobs SET state = 'running', observation_state = 'attached', transcript_turn_id = ?, transcript_turn_started_at = ?, error = NULL, updated_at = ? WHERE id = ? AND binding_id = ? AND state IN ('submitted','recovering','running') AND dispatched_at IS NOT NULL AND (transcript_turn_id IS NULL OR (transcript_turn_id = ? AND transcript_turn_started_at IS NULL))`).run(input.turnId, input.startedAt, now(), input.promptId, input.bindingId, input.turnId);
      const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ? AND binding_id = ?").get(input.promptId, input.bindingId) as PromptRow | undefined;
      if (!row) throw new Error(`Prompt disappeared while claiming transcript turn: ${input.promptId}`);
      const state = result.changes > 0 ? "claimed" : row.transcript_turn_id === input.turnId ? "matched" : row.transcript_turn_id === null ? "ineligible" : "conflict";
      if ((state === "claimed" || state === "matched") && row.transcript_turn_started_at) {
        this.persistRunCardChange(input.promptId, { type: "started", occurredAt: row.transcript_turn_started_at }, false);
        const binding = this.context.database.prepare("SELECT generation, pane_id, agent_session_value FROM bindings WHERE id = ?").get(input.bindingId) as { generation: number; pane_id: string | null; agent_session_value: string | null } | undefined;
        if (!binding) throw new Error(`Binding disappeared while claiming transcript turn: ${input.bindingId}`);
        this.context.database.prepare(`INSERT OR IGNORE INTO prompt_transcript_turns(prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at, chain_id, parent_turn_id, origin, ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'prompt', 0, ?)` )
          .run(input.promptId, input.bindingId, binding.generation, binding.pane_id, binding.agent_session_value, input.turnId, row.transcript_turn_started_at, input.turnId, now());
        terminalizeOlderDetachedPromptOwners(this.context, {
          promptId: input.promptId,
          bindingId: input.bindingId,
          bindingGeneration: Number(binding.generation),
          turnId: input.turnId,
          startedAt: row.transcript_turn_started_at
        }, input.startedAt, (promptId) => {
          this.persistRunCardChange(promptId, { type: "uncertain", occurredAt: input.startedAt, notice: supersededDetachedPromptNotice });
        });
      }
      return { state, prompt: mapPrompt(row) };
    });
  }

  listPromptTranscriptTurns(promptId: string): PromptTranscriptTurn[] {
    return (this.context.database.prepare(`SELECT * FROM prompt_transcript_turns WHERE prompt_id = ? ORDER BY ordinal`).all(promptId) as PromptTranscriptTurnRow[]).map(mapTranscriptTurn);
  }

  adoptPromptTranscriptContinuation(input: { promptId: string; bindingId: string; bindingGeneration: number; turnId: string; startedAt: string; parentTurnId: string; chainId: string }): TranscriptTurnAdoptionOutcome {
    return this.context.transaction("sqlite.prompt-dispatch-store.write", () => {
      const binding = this.context.database.prepare(`
        SELECT generation, pane_id, agent_session_value
        FROM bindings
        WHERE id = ? AND generation = ?
      `).get(input.bindingId, input.bindingGeneration) as { generation: number; pane_id: string | null; agent_session_value: string | null } | undefined;
      const exactPaneId = binding?.pane_id ?? null;
      const exactSessionId = binding?.agent_session_value ?? null;
      const existing = this.context.database.prepare(`
        SELECT * FROM prompt_transcript_turns
        WHERE binding_id = ? AND binding_generation = ? AND pane_id IS NOT NULL AND native_session_id IS NOT NULL
          AND pane_id = ? AND native_session_id = ? AND turn_id = ? AND started_at = ?
      `).get(input.bindingId, input.bindingGeneration, exactPaneId, exactSessionId, input.turnId, input.startedAt) as PromptTranscriptTurnRow | undefined;
      if (existing) {
        const turn = mapTranscriptTurn(existing);
        return turn.promptId === input.promptId && turn.parentTurnId === input.parentTurnId && turn.chainId === input.chainId ? { state: "matched", turn } : { state: "conflict", turn: null };
      }
      const parent = this.context.database.prepare(`SELECT * FROM prompt_transcript_turns WHERE prompt_id = ? AND turn_id = ?`).get(input.promptId, input.parentTurnId) as PromptTranscriptTurnRow | undefined;
      const prompt = this.context.database.prepare(`SELECT p.*, b.generation AS binding_generation FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE p.id = ? AND p.binding_id = ?`).get(input.promptId, input.bindingId) as (PromptRow & { binding_generation: number }) | undefined;
      if (!parent || !prompt || prompt.state !== "running" || prompt.binding_generation !== input.bindingGeneration || parent.chain_id !== input.chainId) return { state: "ineligible", turn: null };
      const ordinal = Number(parent.ordinal) + 1;
      const existingOrdinal = this.context.database.prepare(`
        SELECT * FROM prompt_transcript_turns
        WHERE prompt_id = ? AND ordinal = ?
      `).get(input.promptId, ordinal) as PromptTranscriptTurnRow | undefined;
      if (existingOrdinal) {
        const turn = mapTranscriptTurn(existingOrdinal);
        const exactOwnershipMatches = turn.bindingId === input.bindingId
          && turn.bindingGeneration === input.bindingGeneration
          && turn.paneId === exactPaneId
          && turn.nativeSessionId === exactSessionId;
        const exactTurnMatches = turn.turnId === input.turnId
          && turn.startedAt === input.startedAt
          && turn.parentTurnId === input.parentTurnId
          && turn.chainId === input.chainId
          && turn.origin === "runtime_continuation";
        return exactOwnershipMatches && exactTurnMatches ? { state: "matched", turn } : { state: "conflict", turn: null };
      }
      this.context.database.prepare(`INSERT INTO prompt_transcript_turns(prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id, started_at, chain_id, parent_turn_id, origin, ordinal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'runtime_continuation', ?, ?)` )
        .run(input.promptId, input.bindingId, input.bindingGeneration, exactPaneId, exactSessionId, input.turnId, input.startedAt, input.chainId, input.parentTurnId, ordinal, now());
      const row = this.context.database.prepare(`
        SELECT * FROM prompt_transcript_turns
        WHERE prompt_id = ? AND turn_id = ?
      `).get(input.promptId, input.turnId) as PromptTranscriptTurnRow | undefined;
      if (!row) return { state: "ineligible", turn: null };
      return { state: "adopted", turn: mapTranscriptTurn(row) };
    });
  }

  private persistRunCardChange(promptId: string, change: RunCardChange, required = true): void {
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
    if (topic) this.projections.saveTopicView(mirrorRunCardToTopic(topic, next));
  }

  private persistTerminalRunCard(promptId: string, change: RunCardChange & { completionChoice?: import("../../domain/completion-choice.js").ChoicePrompt }): void {
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
    this.persistRunCardChange(promptId, change);
  }
}

type PromptTranscriptTurnRow = {
  prompt_id: string; binding_id: string; binding_generation: number; pane_id: string | null; native_session_id: string | null;
  turn_id: string; started_at: string; chain_id: string; parent_turn_id: string | null; origin: "prompt" | "runtime_continuation"; ordinal: number; created_at: string
};
function mapTranscriptTurn(row: PromptTranscriptTurnRow): PromptTranscriptTurn {
  return {
    promptId: row.prompt_id, bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation), paneId: row.pane_id, nativeSessionId: row.native_session_id,
    turnId: row.turn_id, startedAt: row.started_at, chainId: row.chain_id, parentTurnId: row.parent_turn_id, origin: row.origin, ordinal: Number(row.ordinal), createdAt: row.created_at
  };
}

function now(): string { return new Date().toISOString(); }
function validateDispatchTimestamp(value: string): void {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error("Invalid prompt dispatch timestamp");
}
function sameInstant(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}
function parsePersistedCompletionChoice(value: unknown): import("../../domain/completion-choice.js").ChoicePrompt | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isFinalMessageCompletionChoice(parsed) ? choicePromptFromLegacyCompletionChoice(parsed) : undefined;
  } catch { return undefined; }
}
function selectFoldedCompletionChoice(evidence: ReadonlyArray<{
  lane_sequence: number; event_type: string; channel: string | null; text: unknown; text_type: string | null; truncated: number | null;
}>): import("../../domain/completion-choice.js").ChoicePrompt | undefined {
  const folded = foldFinalTraceChoiceEvidence(evidence
    .filter((row) => row.event_type === "message" && (row.channel === "commentary" || row.channel === "final") && row.text_type === "text" && typeof row.text === "string")
    .map((row) => ({ order: row.lane_sequence, text: row.text as string, truncated: row.truncated === 1 })));
  return folded.decision === "selected" ? folded.choice : folded.decision === "explicit-none" ? continueChoicePrompt() : undefined;
}
