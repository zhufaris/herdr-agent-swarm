import { randomUUID } from "node:crypto";
import { createBridgeEvent } from "../../domain/create-bridge-event.js";
import { primaryAnswerCreateIdempotencyKey } from "../../domain/delivery-intent.js";
import { formatNativeInputBatch, formatNativeInputReplyContext, type AcceptCollectingNativeInputInput, type AcceptImmediateNativeInputBatchInput, type FormDueNativeInputBatchInput, type NativeInputBacklog, type NativeInputBatch, type NativeInputBatchAcceptanceResult, type NativeInputBatchFormationResult, type NativeInputBatchMember, type NativeInputCollectionResult, type PromptInput } from "../../domain/native-input-batch.js";
import type { AcceptPromptInput, InterruptedContinuationAcceptanceInput, PrimaryCompletionActionAcceptanceInput, PromptAcceptanceEffect, PromptAcceptanceReceipt } from "../../domain/ports/prompt-acceptance.js";
import { COMPLETION_ACTION_MESSAGES } from "../../domain/completion-action-set.js";
import { PromptCapacityExceeded } from "../../domain/prompt-capacity-error.js";
import type { Binding, PromptJob } from "../../domain/types.js";
import type { OutboxStore, PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation, PreparedDeliveryReservationInput } from "../../domain/ports/outbox.js";
import { mapPrompt, type PromptRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import { dismissPendingCompletionNotification } from "./completion-notification-store.js";
import type { ReserveValidatedCardDismissalInput } from "../../domain/ports/card-dismissal.js";

export interface PromptAcceptanceStoreDependencies {
  getBinding(id: string): Binding | null;
  countPendingPrompts(bindingId: string): number;
  enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): unknown;
  reserveCardDismissal(input: ReserveValidatedCardDismissalInput): unknown;
}

export class SqlitePromptAcceptanceStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly projections: SqliteProjectionStore,
    private readonly dependencies: PromptAcceptanceStoreDependencies
  ) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  getCurrentGoal(bindingId: string) { return this.projections.loadTopicView(bindingId)?.currentGoal ?? null; }

  resolvePrimaryCompletionChoice(input: { actionSetId: string; optionId: string; ownerPromptId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string }): { label: string; message: string } {
    const row = this.context.database.prepare(`SELECT option.label, option.message
      FROM completion_action_sets action
      JOIN completion_choice_options option ON option.specification_id = action.choice_specification_id
      WHERE action.id = ? AND action.owner_kind = 'primary-prompt' AND action.owner_id = ? AND action.owner_generation = ?
        AND action.card_message_id = ? AND action.mention_open_id = ?
        AND (action.state = 'available' OR (action.state = 'consumed' AND action.selected_choice_option_id = option.option_id))
        AND option.option_id = ?`).get(
      input.actionSetId, input.ownerPromptId, input.ownerGeneration, input.cardMessageId, input.actorOpenId, input.optionId
    ) as { label: string; message: string } | undefined;
    if (!row) throw new Error("Completion choice is no longer available");
    return row;
  }

  getNativeInputBacklog(bindingId: string, bindingGeneration: number): NativeInputBacklog {
    const inputs = this.context.database.prepare(`
      SELECT COUNT(*) AS count FROM prompt_inputs
      WHERE binding_id = ? AND binding_generation = ? AND state = 'queued' AND batch_id IS NULL
    `).get(bindingId, bindingGeneration) as { count: number };
    const batches = this.context.database.prepare(`
      SELECT COUNT(*) AS count FROM native_input_batches batch
      JOIN prompt_jobs prompt ON prompt.id = batch.execution_prompt_id
      WHERE batch.binding_id = ? AND batch.binding_generation = ? AND batch.state = 'formed'
        AND prompt.state IN ('queued','submitted','recovering','uncertain')
    `).get(bindingId, bindingGeneration) as { count: number };
    return { unbatchedInputCount: Number(inputs.count), pendingBatchCount: Number(batches.count) };
  }

  enqueuePrompt(input: Omit<PromptJob, "sessionEpoch" | "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "priority" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin" | "ingressSource" | "sourceMessageKey"> & Partial<Pick<PromptJob, "priority" | "wasDetached" | "executionOrigin" | "ingressSource" | "sourceMessageKey">>): { prompt: PromptJob; inserted: boolean } {
    return this.context.transaction("sqlite.prompt-acceptance-store.write", () => {
      const timestamp = now();
      const ingressSource = input.ingressSource ?? (input.executionOrigin === "herdr" ? "herdr" : "internal");
      const sourceMessageKey = input.sourceMessageKey ?? input.larkMessageId ?? `legacy:new:v1:${input.id}`;
      const binding = this.dependencies.getBinding(input.bindingId);
      if (!binding) throw new Error(`Binding not found: ${input.bindingId}`);
      this.assertNoSessionRotation(input.bindingId);
      const statement = this.context.database.prepare(`
        INSERT INTO prompt_jobs(id, binding_id, session_epoch, lark_message_id, ingress_source, source_message_key, actor_open_id, body, parent_prompt_id, priority, was_detached, state, attempt_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?) ON CONFLICT(ingress_source, source_message_key) DO NOTHING
      `);
      const inserted = statement.run(input.id, input.bindingId, binding.sessionEpoch, input.larkMessageId, ingressSource, sourceMessageKey, input.actorOpenId, input.body, input.parentPromptId ?? null, input.priority ?? "normal", input.wasDetached ? 1 : 0, timestamp, timestamp).changes === 1;
      const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE ingress_source = ? AND source_message_key = ?").get(ingressSource, sourceMessageKey) as PromptRow | undefined;
      if (!row) throw new Error(`Prompt not found: ${ingressSource}:${sourceMessageKey}`);
      return { prompt: mapPrompt(row), inserted };
    });
  }

  acceptPrompt(input: AcceptPromptInput): { prompt: PromptJob; view: import("../../domain/run-card-view.js").RunCardView; inserted: boolean } {
    return this.context.transaction("sqlite.prompt-acceptance-store.write", () => {
      const ingressSource = input.prompt.ingressSource ?? "feishu";
      const sourceMessageKey = input.prompt.sourceMessageKey ?? input.prompt.larkMessageId;
      if (!sourceMessageKey) throw new Error("Managed Prompt source message key is required");
      const existing = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE ingress_source = ? AND source_message_key = ?").get(ingressSource, sourceMessageKey) as PromptRow | undefined;
      if (existing) {
        const view = this.projections.loadRunCard(existing.id);
        if (!view) throw new Error(`Run card missing for prompt: ${existing.id}`);
        return { prompt: mapPrompt(existing), view, inserted: false };
      }
      const binding = this.dependencies.getBinding(input.prompt.bindingId);
      if (!binding) throw new Error(`Binding not found: ${input.prompt.bindingId}`);
      this.assertNoSessionRotation(input.prompt.bindingId);
      if (input.expectedBindingGeneration !== undefined) {
        if (!binding || binding.generation !== input.expectedBindingGeneration || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") throw new Error("Binding generation changed before prompt acceptance");
      }
      if (input.maxQueueDepth !== undefined && this.dependencies.countPendingPrompts(input.prompt.bindingId) >= input.maxQueueDepth) throw new PromptCapacityExceeded();
      if (input.prompt.priority === "priority") {
        if (this.context.database.prepare("SELECT 1 FROM prompt_jobs WHERE binding_id = ? AND priority = 'priority' AND state IN ('queued','submitted','running') LIMIT 1").get(input.prompt.bindingId)) throw new Error("Primary binding already has a live priority turn");
        if (this.context.database.prepare("SELECT 1 FROM prompt_jobs WHERE binding_id = ? AND state IN ('submitted','running') LIMIT 1").get(input.prompt.bindingId)) throw new Error("Primary binding already has an active runtime turn");
      }
      const timestamp = now();
      this.context.database.prepare(`INSERT INTO prompt_jobs(id, binding_id, session_epoch, lark_message_id, ingress_source, source_message_key, actor_open_id, body, parent_prompt_id, priority, was_detached, state, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`)
        .run(input.prompt.id, input.prompt.bindingId, binding.sessionEpoch, input.prompt.larkMessageId, ingressSource, sourceMessageKey, input.prompt.actorOpenId, input.prompt.body, input.prompt.parentPromptId ?? null, input.prompt.priority ?? "normal", input.prompt.wasDetached ? 1 : 0, timestamp, timestamp);
      const view = input.view;
      this.projections.insertRunCard(view);
      this.reservePrimaryAnswer({
        id: randomUUID(), idempotencyKey: primaryAnswerCreateIdempotencyKey(input.prompt.id), bindingId: input.prompt.bindingId,
        promptId: input.prompt.id, viewVersion: view.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId,
        kind: "stream_card_create", payload: JSON.stringify(input.answerCard), bindingGeneration: view.bindingGeneration
      });
      const prompt = this.getPrompt(input.prompt.id);
      if (!prompt) throw new Error(`Prompt not found: ${input.prompt.id}`);
      return { prompt, view: this.projections.loadRunCard(input.prompt.id)!, inserted: true };
    });
  }

  acceptPromptWithEffects(input: AcceptPromptInput): PromptAcceptanceReceipt {
    return this.context.transaction("sqlite.prompt-acceptance-store.write", () => {
      let result = this.acceptPrompt(input);
      if (result.inserted && result.prompt.executionOrigin === "bridge") {
        const updated = this.context.database.prepare("UPDATE prompt_jobs SET native_submission_id = id WHERE id = ? AND native_submission_id IS NULL").run(result.prompt.id);
        if (Number(updated.changes) !== 1) throw new Error(`Managed Prompt identity was not established: ${result.prompt.id}`);
        const prompt = this.getPrompt(result.prompt.id);
        if (!prompt) throw new Error(`Prompt not found: ${result.prompt.id}`);
        result = { ...result, prompt };
      }
      const effects: PromptAcceptanceEffect[] = result.inserted ? [
        { kind: "outbound-wake" },
        { kind: "prompt-wake", bindingId: input.prompt.bindingId },
        { kind: "lifecycle-event", event: createBridgeEvent(input.prompt.bindingId, "PromptQueued", "lark", {
          promptId: result.prompt.id, queueDepth: this.dependencies.countPendingPrompts(input.prompt.bindingId), actorOpenId: input.prompt.actorOpenId
        }) },
        ...this.supersedeEarlierPrimaryCompletionActions(result.prompt)
      ] : [];
      return this.context.receipt(result, effects);
    });
  }

  acceptImmediateNativeInputBatch(input: AcceptImmediateNativeInputBatchInput): NativeInputBatchAcceptanceResult {
    return this.context.transaction("sqlite.prompt-acceptance-store.write", () => {
      const existingInput = this.getPromptInputBySource(input.input.ingressSource, input.input.sourceMessageKey);
      if (existingInput) return this.requireAcceptedNativeInputBatch(existingInput, false, []);

      const expectedBody = formatNativeInputBatch([input.input.body]);
      if (input.combinedBody !== expectedBody) throw new Error("Immediate Native Input Batch body does not match its source input");
      if (input.view.replyContext != null && input.view.replyContext !== formatNativeInputReplyContext([input.input.body])) {
        throw new Error("Immediate Native Input Batch reply context does not match its source input");
      }
      if (input.batchId !== input.view.promptId || input.input.bindingId !== input.view.bindingId
        || input.input.bindingGeneration !== input.view.bindingGeneration || input.view.requestText !== input.combinedBody) {
        throw new Error("Immediate Native Input Batch identity mismatch");
      }
      const binding = this.dependencies.getBinding(input.input.bindingId);
      if (!binding || binding.generation !== input.input.bindingGeneration || binding.state !== "active"
        || binding.lifecycle !== "active" || binding.attachment !== "attached") {
        throw new Error("Binding generation changed before Native Input Batch acceptance");
      }
      const pendingSourceWork = this.countPendingSourceWork(input.input.bindingId);
      if (pendingSourceWork >= input.maxQueueDepth) throw new PromptCapacityExceeded();
      if ((binding.lastAgentState !== "idle" && binding.lastAgentState !== "done") || pendingSourceWork !== 0) {
        throw new Error("Immediate Native Input Batch requires a settled Primary with no earlier work");
      }

      this.context.database.prepare(`
        INSERT INTO native_input_batches(
          id, binding_id, binding_generation, state, window_opened_at, drain_due_at,
          combined_body, execution_prompt_id, formed_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'collecting', ?, ?, NULL, NULL, NULL, ?, ?)
      `).run(input.batchId, input.input.bindingId, input.input.bindingGeneration, input.occurredAt, input.occurredAt, input.occurredAt, input.occurredAt);
      this.context.database.prepare(`
        INSERT INTO prompt_inputs(
          id, binding_id, binding_generation, ingress_source, source_message_key, lark_message_id,
          actor_open_id, body, root_message_id, parent_prompt_id, state, batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)
      `).run(
        input.input.id, input.input.bindingId, input.input.bindingGeneration, input.input.ingressSource,
        input.input.sourceMessageKey, input.input.larkMessageId, input.input.actorOpenId, input.input.body,
        input.input.rootMessageId, input.input.parentPromptId, input.occurredAt, input.occurredAt
      );
      this.context.database.prepare(`
        INSERT INTO prompt_jobs(
          id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body,
          parent_prompt_id, execution_origin, priority, was_detached, state, observation_state,
          attempt_count, native_submission_id, created_at, updated_at
        ) VALUES (?, ?, NULL, 'feishu', ?, ?, ?, ?, 'bridge', 'normal', 0, 'queued', 'not_started', 0, ?, ?, ?)
      `).run(
        input.batchId, input.input.bindingId, `feishu-batch:v1:${input.batchId}`, input.input.actorOpenId,
        input.combinedBody, input.input.parentPromptId, input.batchId, input.occurredAt, input.occurredAt
      );
      this.context.database.prepare(`
        INSERT INTO native_input_batch_members(batch_id, prompt_input_id, ordinal, created_at)
        VALUES (?, ?, 0, ?)
      `).run(input.batchId, input.input.id, input.occurredAt);
      this.context.database.prepare("UPDATE prompt_inputs SET state = 'batched', batch_id = ?, updated_at = ? WHERE id = ?")
        .run(input.batchId, input.occurredAt, input.input.id);
      this.context.database.prepare(`
        UPDATE native_input_batches
        SET state = 'formed', combined_body = ?, execution_prompt_id = id, formed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'collecting'
      `).run(input.combinedBody, input.occurredAt, input.occurredAt, input.batchId);

      this.projections.insertRunCard(input.view);
      this.reservePrimaryAnswer({
        id: randomUUID(), idempotencyKey: primaryAnswerCreateIdempotencyKey(input.batchId),
        bindingId: input.input.bindingId, promptId: input.batchId, viewVersion: input.view.viewVersion,
        cardRole: "answer", rootMessageId: input.input.rootMessageId, kind: "stream_card_create",
        payload: JSON.stringify(input.answerCard), bindingGeneration: input.view.bindingGeneration
      });
      const supersededPromptIds = this.supersedePrimaryCompletionActionsForAcceptedInput(input.input.bindingId, input.input.bindingGeneration);
      return this.requireAcceptedNativeInputBatch(this.getPromptInputBySource(input.input.ingressSource, input.input.sourceMessageKey)!, true, supersededPromptIds);
    });
  }

  acceptCollectingNativeInput(input: AcceptCollectingNativeInputInput): NativeInputCollectionResult {
    return this.context.transaction("sqlite.prompt-acceptance-store.write", () => {
      const existingInput = this.getPromptInputBySource(input.input.ingressSource, input.input.sourceMessageKey);
      if (existingInput) return { inserted: false, input: existingInput, batch: this.requireBatchForPromptInput(existingInput), supersededPromptIds: [] };

      const binding = this.dependencies.getBinding(input.input.bindingId);
      if (!binding || binding.generation !== input.input.bindingGeneration || binding.state !== "active"
        || binding.lifecycle !== "active" || binding.attachment !== "attached") {
        throw new Error("Binding generation changed before Native Input Batch acceptance");
      }
      const collecting = this.findCollectingNativeInputBatch(input.input.bindingId, input.input.bindingGeneration);
      const pendingSourceWork = this.countPendingSourceWork(input.input.bindingId);
      if (!collecting && binding.lastAgentState !== "working" && binding.lastAgentState !== "blocked" && pendingSourceWork === 0) {
        throw new Error("Collecting Native Input Batch requires active or earlier Primary work");
      }
      if (pendingSourceWork >= input.maxQueueDepth) throw new PromptCapacityExceeded();
      const drainDueAt = deadlineAfter(input.occurredAt, input.windowMs);
      if (!collecting) {
        this.context.database.prepare(`
          INSERT INTO native_input_batches(
            id, binding_id, binding_generation, state, window_opened_at, drain_due_at,
            combined_body, execution_prompt_id, formed_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'collecting', ?, ?, NULL, NULL, NULL, ?, ?)
        `).run(input.batchId, input.input.bindingId, input.input.bindingGeneration, input.occurredAt, drainDueAt, input.occurredAt, input.occurredAt);
      }
      this.context.database.prepare(`
        INSERT INTO prompt_inputs(
          id, binding_id, binding_generation, ingress_source, source_message_key, lark_message_id,
          actor_open_id, body, root_message_id, parent_prompt_id, state, batch_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)
      `).run(
        input.input.id, input.input.bindingId, input.input.bindingGeneration, input.input.ingressSource,
        input.input.sourceMessageKey, input.input.larkMessageId, input.input.actorOpenId, input.input.body,
        input.input.rootMessageId, input.input.parentPromptId, input.occurredAt, input.occurredAt
      );
      const supersededPromptIds = this.supersedePrimaryCompletionActionsForAcceptedInput(input.input.bindingId, input.input.bindingGeneration);
      const acceptedInput = this.getPromptInputBySource(input.input.ingressSource, input.input.sourceMessageKey)!;
      return { inserted: true, input: acceptedInput, batch: collecting ?? this.getNativeInputBatch(input.batchId)!, supersededPromptIds };
    });
  }

  formDueNativeInputBatch(input: FormDueNativeInputBatchInput): NativeInputBatchFormationResult {
    return this.context.transaction("sqlite.prompt-acceptance-store.write", () => {
      const binding = this.dependencies.getBinding(input.bindingId);
      if (!binding) return { outcome: "none" };
      this.context.database.prepare(`
        UPDATE prompt_inputs SET state = 'cancelled', updated_at = ?
        WHERE binding_id = ? AND binding_generation != ? AND state = 'queued' AND batch_id IS NULL
      `).run(input.occurredAt, input.bindingId, binding.generation);
      this.context.database.prepare(`
        UPDATE native_input_batches SET state = 'cancelled', updated_at = ?
        WHERE binding_id = ? AND binding_generation != ? AND state = 'collecting'
      `).run(input.occurredAt, input.bindingId, binding.generation);
      const row = this.context.database.prepare(`
        SELECT * FROM native_input_batches
        WHERE binding_id = ? AND binding_generation = ? AND state = 'collecting'
        ORDER BY created_at, rowid LIMIT 1
      `).get(input.bindingId, binding.generation) as NativeInputBatchRow | undefined;
      if (!row) return { outcome: "none" };
      const currentBatch = mapNativeInputBatch(row);
      if (currentBatch.drainDueAt > input.occurredAt) return { outcome: "not_due", batch: currentBatch };
      if (binding.state !== "active"
        || binding.lifecycle !== "active" || binding.attachment !== "attached") return { outcome: "none" };
      const members = this.context.database.prepare(`
        SELECT * FROM prompt_inputs
        WHERE binding_id = ? AND binding_generation = ? AND state = 'queued' AND batch_id IS NULL
        ORDER BY created_at, rowid LIMIT 3
      `).all(input.bindingId, currentBatch.bindingGeneration) as PromptInputRow[];
      if (members.length === 0) return { outcome: "none" };
      const first = members[0]!;
      const memberBodies = members.map((member) => member.body);
      const combinedBody = formatNativeInputBatch(memberBodies);
      const replyContext = formatNativeInputReplyContext(memberBodies);
      const projection = input.createProjection({
        batchId: currentBatch.id, binding, combinedBody, replyContext, titleSource: first.body, rootMessageId: first.root_message_id, memberCount: members.length,
        queuePosition: this.dependencies.countPendingPrompts(input.bindingId) + 1
      });
      if (projection.view.promptId !== currentBatch.id || projection.view.bindingId !== binding.id
        || projection.view.bindingGeneration !== binding.generation || projection.view.requestText !== combinedBody) {
        throw new Error("Formed Native Input Batch projection identity mismatch");
      }
      this.context.database.prepare(`
        INSERT INTO prompt_jobs(
          id, binding_id, lark_message_id, ingress_source, source_message_key, actor_open_id, body,
          parent_prompt_id, execution_origin, priority, was_detached, state, observation_state,
          attempt_count, native_submission_id, created_at, updated_at
        ) VALUES (?, ?, NULL, 'feishu', ?, ?, ?, ?, 'bridge', 'normal', 0, 'queued', 'not_started', 0, ?, ?, ?)
      `).run(
        currentBatch.id, binding.id, `feishu-batch:v1:${currentBatch.id}`, first.actor_open_id,
        combinedBody, first.parent_prompt_id, currentBatch.id, input.occurredAt, input.occurredAt
      );
      const insertMember = this.context.database.prepare(`
        INSERT INTO native_input_batch_members(batch_id, prompt_input_id, ordinal, created_at) VALUES (?, ?, ?, ?)
      `);
      const assignInput = this.context.database.prepare("UPDATE prompt_inputs SET state = 'batched', batch_id = ?, updated_at = ? WHERE id = ? AND state = 'queued' AND batch_id IS NULL");
      for (const [ordinal, member] of members.entries()) {
        insertMember.run(currentBatch.id, member.id, ordinal, input.occurredAt);
        if (Number(assignInput.run(currentBatch.id, input.occurredAt, member.id).changes) !== 1) throw new Error(`Prompt Input assignment lost ownership: ${member.id}`);
      }
      const formed = this.context.database.prepare(`
        UPDATE native_input_batches
        SET state = 'formed', combined_body = ?, execution_prompt_id = id, formed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'collecting'
      `).run(combinedBody, input.occurredAt, input.occurredAt, currentBatch.id);
      if (Number(formed.changes) !== 1) throw new Error(`Native Input Batch formation lost ownership: ${currentBatch.id}`);
      this.projections.insertRunCard(projection.view);
      this.reservePrimaryAnswer({
        id: randomUUID(), idempotencyKey: primaryAnswerCreateIdempotencyKey(currentBatch.id), bindingId: binding.id,
        promptId: currentBatch.id, viewVersion: projection.view.viewVersion, cardRole: "answer",
        rootMessageId: projection.rootMessageId, kind: "stream_card_create", payload: JSON.stringify(projection.answerCard), bindingGeneration: projection.view.bindingGeneration
      });

      const overflow = this.context.database.prepare(`
        SELECT 1 FROM prompt_inputs
        WHERE binding_id = ? AND binding_generation = ? AND state = 'queued' AND batch_id IS NULL LIMIT 1
      `).get(binding.id, binding.generation);
      let nextBatch: NativeInputBatch | null = null;
      if (overflow) {
        const nextDueAt = deadlineAfter(input.occurredAt, input.windowMs);
        this.context.database.prepare(`
          INSERT INTO native_input_batches(
            id, binding_id, binding_generation, state, window_opened_at, drain_due_at,
            combined_body, execution_prompt_id, formed_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'collecting', ?, ?, NULL, NULL, NULL, ?, ?)
        `).run(input.nextBatchId, binding.id, binding.generation, input.occurredAt, nextDueAt, input.occurredAt, input.occurredAt);
        nextBatch = this.getNativeInputBatch(input.nextBatchId);
      }
      const supersededPromptIds = this.supersedePrimaryCompletionActionsForAcceptedInput(binding.id, binding.generation);
      const batch = this.getNativeInputBatch(currentBatch.id)!;
      const prompt = this.getPrompt(currentBatch.id)!;
      return { outcome: "formed", batch, prompt, view: this.projections.loadRunCard(currentBatch.id)!, nextBatch, supersededPromptIds };
    });
  }

  private reservePrimaryAnswer(input: PreparedDeliveryReservationInput): unknown {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Prompt Acceptance prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

  getPromptInputBySource(ingressSource: "feishu", sourceMessageKey: string): PromptInput | null {
    const row = this.context.database.prepare("SELECT * FROM prompt_inputs WHERE ingress_source = ? AND source_message_key = ?")
      .get(ingressSource, sourceMessageKey) as PromptInputRow | undefined;
    return row ? mapPromptInput(row) : null;
  }

  getNativeInputBatch(batchId: string): NativeInputBatch | null {
    const row = this.context.database.prepare("SELECT * FROM native_input_batches WHERE id = ?").get(batchId) as NativeInputBatchRow | undefined;
    return row ? mapNativeInputBatch(row) : null;
  }

  listNativeInputBatchMembers(batchId: string): NativeInputBatchMember[] {
    return (this.context.database.prepare("SELECT batch_id, prompt_input_id, ordinal FROM native_input_batch_members WHERE batch_id = ? ORDER BY ordinal")
      .all(batchId) as NativeInputBatchMemberRow[]).map(mapNativeInputBatchMember);
  }

  acceptInterruptedContinuation(input: InterruptedContinuationAcceptanceInput): PromptAcceptanceReceipt {
    return this.context.transaction("sqlite.prompt-acceptance-store.write", () => {
      const interaction = this.context.database.prepare("SELECT * FROM card_interactions WHERE id = ?").get(input.interactionId) as { binding_id: string; binding_generation: number; actor_open_id: string; action_kind: string; parent_prompt_id: string | null; state: string; expires_at: string } | undefined;
      const acceptedIngressSource = input.accepted.prompt.ingressSource ?? "feishu";
      const acceptedSourceMessageKey = input.accepted.prompt.sourceMessageKey ?? input.accepted.prompt.larkMessageId;
      const existing = acceptedSourceMessageKey === null ? undefined : this.context.database.prepare("SELECT * FROM prompt_jobs WHERE ingress_source = ? AND source_message_key = ?").get(acceptedIngressSource, acceptedSourceMessageKey) as PromptRow | undefined;
      if (interaction?.state === "consumed" && existing) {
        const view = this.projections.loadRunCard(existing.id);
        if (!view) throw new Error(`Run card missing for prompt: ${existing.id}`);
        return this.context.receipt({ prompt: mapPrompt(existing), view, inserted: false }, []);
      }
      if (!interaction || interaction.state !== "active" || interaction.action_kind !== "continuation" || interaction.actor_open_id !== input.actorOpenId
        || interaction.binding_generation !== input.expectedBindingGeneration || interaction.parent_prompt_id !== input.parentPromptId || interaction.expires_at <= now()) {
        throw new Error("Interrupted-task continuation interaction is no longer active");
      }
      const parent = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(input.parentPromptId) as PromptRow | undefined;
      const parentView = this.projections.loadRunCard(input.parentPromptId);
      const binding = parent ? this.dependencies.getBinding(parent.binding_id) : null;
      if (!parent || !parentView || !binding || interaction.binding_id !== binding.id || binding.id !== input.accepted.prompt.bindingId || binding.creatorOpenId !== input.actorOpenId
        || binding.generation !== input.expectedBindingGeneration || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached"
        || parent.state !== "failed" || parent.error !== "TraeX turn was interrupted by a human operator" || parentView.answerMessageId !== input.sourceAnswerMessageId) {
        throw new Error("Interrupted-task continuation is no longer eligible");
      }
      if (input.accepted.prompt.parentPromptId !== input.parentPromptId || input.accepted.expectedBindingGeneration !== input.expectedBindingGeneration) throw new Error("Interrupted-task continuation identity mismatch");
      const receipt = this.acceptPromptWithEffects(input.accepted);
      const consumed = this.context.database.prepare("UPDATE card_interactions SET state = 'consumed', result_code = 'continuation', consumed_at = ? WHERE id = ? AND state = 'active'").run(now(), input.interactionId);
      if (Number(consumed.changes) !== 1) throw new Error(`Continuation interaction acceptance lost ownership: ${input.interactionId}`);
      return receipt;
    });
  }

  acceptPrimaryCompletionAction(input: PrimaryCompletionActionAcceptanceInput): PromptAcceptanceReceipt {
    return this.context.transaction("sqlite.prompt-acceptance-store.write", () => {
      if ((input.selection === undefined) === (input.optionId === undefined)) throw new Error("Exactly one completion action identity is required");
      const sourceMessageKey = input.optionId
        ? `completion-choice:v1:${input.actionSetId}:${input.optionId}`
        : `completion-action:v1:${input.actionSetId}:${input.selection}`;
      const action = this.context.database.prepare(`SELECT id, owner_id, owner_generation, binding_id, binding_generation, card_message_id,
          mention_open_id, state, selected_action, selected_choice_option_id, choice_specification_id, result_source_key
        FROM completion_action_sets WHERE id = ? AND owner_kind = 'primary-prompt'`).get(input.actionSetId) as {
          id: string; owner_id: string; owner_generation: number; binding_id: string; binding_generation: number; card_message_id: string;
          mention_open_id: string | null; state: string; selected_action: string | null; selected_choice_option_id: string | null; choice_specification_id: string | null; result_source_key: string | null;
        } | undefined;
      const choice = action && input.optionId ? this.context.database.prepare(`SELECT label, message FROM completion_choice_options
        WHERE specification_id = ? AND option_id = ?`).get(action.choice_specification_id, input.optionId) as { label: string; message: string } | undefined : undefined;
      const existing = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE ingress_source = 'internal' AND source_message_key = ?").get(sourceMessageKey) as PromptRow | undefined;
      if (action?.state === "consumed" && (input.optionId ? action.selected_choice_option_id === input.optionId : action.selected_action === input.selection) && action.result_source_key === sourceMessageKey
        && action.mention_open_id === input.actorOpenId && existing) {
        const view = this.projections.loadRunCard(existing.id);
        if (!view) throw new Error(`Run card missing for prompt: ${existing.id}`);
        return this.context.receipt({ prompt: mapPrompt(existing), view, inserted: false }, []);
      }
      const binding = action ? this.dependencies.getBinding(action.binding_id) : null;
      const owner = action ? this.context.database.prepare("SELECT state FROM prompt_jobs WHERE id = ? AND binding_id = ?").get(action.owner_id, action.binding_id) as { state: string } | undefined : undefined;
      const ownerView = action ? this.projections.loadRunCard(action.owner_id) : null;
      const finalPage = action ? this.context.database.prepare("SELECT page_index, card_id, message_id, state FROM answer_pages WHERE prompt_id = ? ORDER BY page_index DESC LIMIT 1").get(action.owner_id) as { page_index: number; card_id: string | null; message_id: string | null; state: string } | undefined : undefined;
      if (!action || action.state !== "available" || action.owner_id !== input.ownerPromptId || action.owner_generation !== input.ownerGeneration
        || action.card_message_id !== input.cardMessageId || action.mention_open_id !== input.actorOpenId || !binding || !owner || !ownerView || !finalPage
        || binding.generation !== action.binding_generation || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached"
        || owner.state !== "delivered" || ownerView.phase !== "completed" || ownerView.bindingGeneration !== action.binding_generation
        || finalPage.message_id !== action.card_message_id || finalPage.state === "frozen") throw new Error("Completion action is no longer available");
      if (input.selection !== undefined && action.choice_specification_id !== null) throw new Error("Completion action is no longer available");
      if (input.accepted.prompt.bindingId !== binding.id || input.accepted.prompt.parentPromptId !== action.owner_id
        || input.accepted.prompt.actorOpenId !== input.actorOpenId || input.accepted.prompt.body !== (input.optionId ? choice?.message : COMPLETION_ACTION_MESSAGES[input.selection!])
        || input.accepted.prompt.ingressSource !== "internal" || input.accepted.prompt.sourceMessageKey !== sourceMessageKey
        || input.accepted.expectedBindingGeneration !== action.binding_generation) throw new Error("Completion action admission identity mismatch");
      const consumedAt = now();
      if (input.optionId && !choice) throw new Error("Completion choice is no longer available");
      const consumed = this.context.database.prepare(`UPDATE completion_action_sets SET state = 'consumed', selected_action = ?, selected_choice_option_id = ?, result_source_key = ?, decided_at = ?, updated_at = ?
        WHERE id = ? AND state = 'available'`).run(input.selection ?? null, input.optionId ?? null, sourceMessageKey, consumedAt, consumedAt, input.actionSetId);
      if (Number(consumed.changes) !== 1) throw new Error("Completion action lost ownership");
      dismissPendingCompletionNotification(this.context, "primary-prompt", action.owner_id);
      return this.acceptPromptWithEffects(input.accepted);
    });
  }

  ignorePrimaryCompletionAction(input: { actionSetId: string; ownerPromptId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string }): import("../../domain/completion-action-set.js").CompletionActionIgnoreResult {
    return this.context.transaction("sqlite.prompt-acceptance-store.write", () => {
      const action = this.context.database.prepare(`SELECT id, owner_id, owner_generation, binding_id, binding_generation, card_message_id,
          mention_open_id, state, reason, choice_specification_id
        FROM completion_action_sets WHERE id = ? AND owner_kind = 'primary-prompt'`).get(input.actionSetId) as {
          id: string; owner_id: string; owner_generation: number; binding_id: string; binding_generation: number;
          card_message_id: string; mention_open_id: string | null; state: string; reason: string | null; choice_specification_id: string | null;
        } | undefined;
      const exactIdentity = action && action.owner_id === input.ownerPromptId && action.owner_generation === input.ownerGeneration
        && action.card_message_id === input.cardMessageId && action.mention_open_id === input.actorOpenId;
      if (exactIdentity && action.state === "consumed" && action.reason === "ignored") {
        return { ownerId: action.owner_id, changed: false };
      }
      const binding = action ? this.dependencies.getBinding(action.binding_id) : null;
      const owner = action ? this.context.database.prepare("SELECT state FROM prompt_jobs WHERE id = ? AND binding_id = ?").get(action.owner_id, action.binding_id) as { state: string } | undefined : undefined;
      const ownerView = action ? this.projections.loadRunCard(action.owner_id) : null;
      const finalPage = action ? this.context.database.prepare("SELECT card_id, message_id, state FROM answer_pages WHERE prompt_id = ? ORDER BY page_index DESC LIMIT 1").get(action.owner_id) as { card_id: string | null; message_id: string | null; state: string } | undefined : undefined;
      if (!exactIdentity || action.state !== "available" || !action.choice_specification_id || !binding || !owner || !ownerView || !finalPage
        || binding.generation !== action.binding_generation || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached"
        || owner.state !== "delivered" || ownerView.phase !== "completed" || ownerView.bindingGeneration !== action.binding_generation
        || finalPage.message_id !== action.card_message_id || finalPage.state === "frozen") throw new Error("Completion action is no longer available");
      const timestamp = now();
      const changed = this.context.database.prepare(`UPDATE completion_action_sets SET state = 'consumed', selected_action = NULL,
        selected_choice_option_id = NULL, result_source_key = NULL, reason = 'ignored', decided_at = ?, updated_at = ?
        WHERE id = ? AND state = 'available'`).run(timestamp, timestamp, input.actionSetId);
      if (Number(changed.changes) !== 1) throw new Error("Completion action lost ownership");
      dismissPendingCompletionNotification(this.context, "primary-prompt", action.owner_id);
      this.dependencies.reserveCardDismissal({
        actionKind: "primary_completion_ignore", semanticKey: `completion-action:${action.id}`,
        actorOpenId: input.actorOpenId, chatId: binding.chatId, gatewayId: binding.gatewayId,
        messageId: action.card_message_id
      });
      this.context.database.prepare(`UPDATE run_cards SET view_version = view_version + 1, updated_at = ?
        WHERE prompt_id = ? AND binding_id = ? AND binding_generation = ?`).run(timestamp, action.owner_id, action.binding_id, action.binding_generation);
      return { ownerId: action.owner_id, changed: true };
    });
  }

  private getPrompt(id: string): PromptJob | null {
    const row = this.context.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(id) as PromptRow | undefined;
    return row ? mapPrompt(row) : null;
  }

  private assertNoSessionRotation(bindingId: string): void {
    if (this.context.database.prepare(`SELECT 1 FROM orchestrator_clear_operations WHERE binding_id = ?
      AND state IN ('accepted','rotating','rotation-uncertain') LIMIT 1`).get(bindingId)) {
      throw new Error("Orchestrator context rotation is in progress");
    }
  }

  private supersedeEarlierPrimaryCompletionActions(successor: PromptJob): PromptAcceptanceEffect[] {
    if (successor.ingressSource === "herdr") return [];
    const candidates = this.context.database.prepare(`SELECT action.id, action.owner_id
      FROM completion_action_sets action
      JOIN prompt_jobs owner ON owner.id = action.owner_id
      JOIN prompt_jobs later ON later.id = ?
      WHERE action.owner_kind = 'primary-prompt' AND action.state IN ('available','provisional','presenting','active')
        AND action.binding_id = later.binding_id AND action.binding_generation = ?
        AND (owner.created_at < later.created_at OR (owner.created_at = later.created_at AND owner.rowid < later.rowid))
      ORDER BY owner.created_at, owner.rowid`).all(successor.id, this.projections.loadRunCard(successor.id)?.bindingGeneration ?? -1) as Array<{ id: string; owner_id: string }>;
    const timestamp = now();
    const effects: PromptAcceptanceEffect[] = [];
    for (const candidate of candidates) {
      this.dismissUnattemptedPrimaryCompletionReview(candidate.id, timestamp);
      const updated = this.context.database.prepare(`UPDATE completion_action_sets
        SET state = 'superseded', reason = 'successor-accepted', decided_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('available','provisional','presenting','active')`).run(timestamp, timestamp, candidate.id);
      if (Number(updated.changes) === 1) {
        dismissPendingCompletionNotification(this.context, "primary-prompt", candidate.owner_id);
        effects.push({ kind: "answer-converge", promptId: candidate.owner_id });
      }
    }
    return effects;
  }

  private supersedePrimaryCompletionActionsForAcceptedInput(bindingId: string, bindingGeneration: number): string[] {
    const candidates = this.context.database.prepare(`SELECT id, owner_id FROM completion_action_sets
      WHERE owner_kind = 'primary-prompt' AND state IN ('available','provisional','presenting','active')
        AND binding_id = ? AND binding_generation = ?
      ORDER BY created_at, rowid`).all(bindingId, bindingGeneration) as Array<{ id: string; owner_id: string }>;
    const timestamp = now();
    const supersededPromptIds: string[] = [];
    for (const candidate of candidates) {
      this.dismissUnattemptedPrimaryCompletionReview(candidate.id, timestamp);
      const updated = this.context.database.prepare(`UPDATE completion_action_sets
        SET state = 'superseded', reason = 'successor-accepted', decided_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('available','provisional','presenting','active')`).run(timestamp, timestamp, candidate.id);
      if (Number(updated.changes) !== 1) continue;
      dismissPendingCompletionNotification(this.context, "primary-prompt", candidate.owner_id);
      this.context.database.prepare(`UPDATE run_cards
        SET view_version = view_version + 1, updated_at = ?
        WHERE prompt_id = ? AND binding_id = ? AND binding_generation = ?`)
        .run(timestamp, candidate.owner_id, bindingId, bindingGeneration);
      supersededPromptIds.push(candidate.owner_id);
    }
    return supersededPromptIds;
  }

  private dismissUnattemptedPrimaryCompletionReview(actionSetId: string, occurredAt: string): void {
    this.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',
      error='Completion Review became obsolete before first delivery attempt',updated_at=?
      WHERE id=(SELECT presentation_reply_id FROM completion_action_sets
          WHERE id=? AND owner_kind='primary-prompt' AND presentation_kind='fresh-card')
        AND state='pending' AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
        AND attempt_count=0 AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL`).run(occurredAt, actionSetId);
  }

  private requireAcceptedNativeInputBatch(promptInput: PromptInput, inserted: boolean, supersededPromptIds: readonly string[]): NativeInputBatchAcceptanceResult {
    if (!promptInput.batchId) throw new Error(`Prompt Input is not assigned to a batch: ${promptInput.id}`);
    const batch = this.getNativeInputBatch(promptInput.batchId);
    if (!batch?.executionPromptId) throw new Error(`Native Input Batch is not formed: ${promptInput.batchId}`);
    const prompt = this.getPrompt(batch.executionPromptId);
    const view = this.projections.loadRunCard(batch.executionPromptId);
    if (!prompt || !view) throw new Error(`Native Input Batch execution is incomplete: ${promptInput.batchId}`);
    return { inserted, prompt, view, supersededPromptIds };
  }

  private requireBatchForPromptInput(promptInput: PromptInput): NativeInputBatch {
    const batch = promptInput.batchId
      ? this.getNativeInputBatch(promptInput.batchId)
      : this.findCollectingNativeInputBatch(promptInput.bindingId, promptInput.bindingGeneration);
    if (!batch) throw new Error(`Prompt Input has no Native Input Batch: ${promptInput.id}`);
    return batch;
  }

  private findCollectingNativeInputBatch(bindingId: string, bindingGeneration: number): NativeInputBatch | null {
    const row = this.context.database.prepare(`
      SELECT * FROM native_input_batches
      WHERE binding_id = ? AND binding_generation = ? AND state = 'collecting'
      ORDER BY created_at, rowid LIMIT 1
    `).get(bindingId, bindingGeneration) as NativeInputBatchRow | undefined;
    return row ? mapNativeInputBatch(row) : null;
  }

  private countPendingSourceWork(bindingId: string): number {
    const source = this.context.database.prepare(`
      SELECT COUNT(*) AS count FROM prompt_inputs AS input
      LEFT JOIN native_input_batches AS batch ON batch.id = input.batch_id
      LEFT JOIN prompt_jobs AS prompt ON prompt.id = batch.execution_prompt_id
      WHERE input.binding_id = ? AND (
        input.state = 'queued' OR (input.state = 'batched' AND prompt.state IN ('queued','submitted','running','recovering','uncertain'))
      )
    `).get(bindingId) as { count: number };
    const legacy = this.context.database.prepare(`
      SELECT COUNT(*) AS count FROM prompt_jobs AS prompt
      WHERE prompt.binding_id = ? AND prompt.state IN ('queued','submitted','running')
        AND NOT EXISTS (SELECT 1 FROM native_input_batches AS batch WHERE batch.execution_prompt_id = prompt.id)
    `).get(bindingId) as { count: number };
    return Number(source.count) + Number(legacy.count);
  }
}

type PromptInputRow = {
  id: string; binding_id: string; binding_generation: number; ingress_source: "feishu"; source_message_key: string;
  lark_message_id: string; actor_open_id: string; body: string; root_message_id: string; parent_prompt_id: string | null;
  state: PromptInput["state"]; batch_id: string | null; created_at: string; updated_at: string;
};
type NativeInputBatchRow = {
  id: string; binding_id: string; binding_generation: number; state: NativeInputBatch["state"];
  window_opened_at: string; drain_due_at: string; combined_body: string | null; execution_prompt_id: string | null;
  formed_at: string | null; created_at: string; updated_at: string;
};
type NativeInputBatchMemberRow = { batch_id: string; prompt_input_id: string; ordinal: number };

function mapPromptInput(row: PromptInputRow): PromptInput {
  return {
    id: row.id, bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation), ingressSource: row.ingress_source,
    sourceMessageKey: row.source_message_key, larkMessageId: row.lark_message_id, actorOpenId: row.actor_open_id,
    body: row.body, rootMessageId: row.root_message_id, parentPromptId: row.parent_prompt_id, state: row.state,
    batchId: row.batch_id, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapNativeInputBatch(row: NativeInputBatchRow): NativeInputBatch {
  return {
    id: row.id, bindingId: row.binding_id, bindingGeneration: Number(row.binding_generation), state: row.state,
    windowOpenedAt: row.window_opened_at, drainDueAt: row.drain_due_at, combinedBody: row.combined_body,
    executionPromptId: row.execution_prompt_id, formedAt: row.formed_at, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapNativeInputBatchMember(row: NativeInputBatchMemberRow): NativeInputBatchMember {
  return { batchId: row.batch_id, promptInputId: row.prompt_input_id, ordinal: Number(row.ordinal) };
}

function deadlineAfter(occurredAt: string, windowMs: number): string {
  const start = Date.parse(occurredAt);
  if (!Number.isFinite(start) || !Number.isInteger(windowMs) || windowMs <= 0) throw new Error("Native Input Batch window is invalid");
  return new Date(start + windowMs).toISOString();
}

function now(): string { return new Date().toISOString(); }
