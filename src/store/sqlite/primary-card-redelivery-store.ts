import { randomUUID } from "node:crypto";
import type { AnswerPage, Binding, OutboundReply } from "../../domain/types.js";
import type { PrimaryCardRedeliveryReservation, PrimaryCardRedeliverySnapshot, PrimaryCardRedeliverySnapshotResult, PrimaryCardRedeliveryStore } from "../../domain/ports/primary-card-redelivery.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { TopicViewState } from "../../domain/topic-view.js";
import { updateTopicView } from "../../domain/topic-view.js";
import type { NativeInputBacklog } from "../../domain/native-input-batch.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import type { SqliteContext } from "./context.js";
import { incrementPrimaryAnswerPageSequence } from "./answer-page-sequence.js";
import { COMPLETION_ACTION_SELECTIONS, type CompletionActionSelection, type CompletionActionSetRenderState } from "../../domain/completion-action-set.js";
import { loadCompletionChoice } from "./completion-choice-store.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";

type StoredOperation = {
  outcome: "main_and_answer" | "main_only";
};

export class SqlitePrimaryCardRedeliveryStore implements PrimaryCardRedeliveryStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;

  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getBinding(id: string): Binding | null;
      loadTopicView(bindingId: string): TopicViewState | null;
      loadRunCard(promptId: string): RunCardView | null;
      getNativeInputBacklog(bindingId: string, bindingGeneration: number): NativeInputBacklog;
      enqueueOutboundReply(input: EnqueueOutboundReplyInput): OutboundReply;
    }
  ) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  loadSnapshot(input: { bindingId: string; expectedBindingGeneration: number }): PrimaryCardRedeliverySnapshotResult {
    const binding = this.dependencies.getBinding(input.bindingId);
    if (!isCurrentBinding(binding, input.expectedBindingGeneration)) return { outcome: "unavailable", reason: "stale_binding" };
    if (!binding.statusMessageId && !binding.rootMessageId) return { outcome: "unavailable", reason: "missing_main_target" };
    const storedTopic = this.dependencies.loadTopicView(input.bindingId);
    if (!storedTopic || storedTopic.bindingGeneration !== input.expectedBindingGeneration) return { outcome: "unavailable", reason: "stale_projection" };
    const topic = updateTopicView(storedTopic, {
      nativeInputBacklog: this.dependencies.getNativeInputBacklog(input.bindingId, input.expectedBindingGeneration)
    });

    const activePromptIds = this.context.database.prepare(`SELECT p.id FROM prompt_jobs p
      JOIN run_cards r ON r.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state IN ('submitted','running')
        AND NOT (p.state = 'submitted' AND p.observation_state = 'detached')
        AND r.binding_generation = ?
      ORDER BY p.created_at, p.rowid LIMIT 2`).all(input.bindingId, input.expectedBindingGeneration) as Array<{ id: string }>;
    if (activePromptIds.length > 1) return { outcome: "unavailable", reason: "ambiguous_active_prompt" };

    const selected = activePromptIds.length === 1
      ? this.loadLatestEligiblePage(activePromptIds[0]!.id)
      : this.loadLatestHistoricalPage(input.bindingId, input.expectedBindingGeneration);
    if (!selected) return { outcome: "available", topic, answer: null };
    const run = this.dependencies.loadRunCard(selected.promptId);
    if (!run || run.bindingId !== input.bindingId || run.bindingGeneration !== input.expectedBindingGeneration) {
      return { outcome: "unavailable", reason: "stale_projection" };
    }
    return { outcome: "available", topic, answer: {
      run, page: selected, nextPageStart: this.loadNextPageStart(selected.promptId, selected.pageIndex),
      completionActions: this.loadCompletionActions(selected)
    } };
  }

  reserve(input: { commandIntentId: string; snapshot: PrimaryCardRedeliverySnapshot; mainCard: object; answerCard: object | null }): PrimaryCardRedeliveryReservation {
    return this.context.transaction("sqlite.primary-card-redelivery-store.write", () => {
      const existing = this.context.database.prepare("SELECT outcome FROM primary_card_redeliveries WHERE command_intent_id = ?")
        .get(input.commandIntentId) as StoredOperation | undefined;
      if (existing) return storedResult("duplicate", existing);

      const current = this.loadSnapshot({ bindingId: input.snapshot.topic.bindingId, expectedBindingGeneration: input.snapshot.topic.bindingGeneration });
      if (current.outcome !== "available") return { outcome: "unavailable", reason: current.reason };
      if (!sameSnapshot(current, input.snapshot)) return { outcome: "stale", reason: "projection_changed" };
      if ((current.answer === null) !== (input.answerCard === null)) return { outcome: "stale", reason: "answer_render_mismatch" };

      const binding = this.dependencies.getBinding(current.topic.bindingId)!;
      const mainProjectionKey = `primary-redelivery:main:${binding.id}:${binding.generation}`;
      const mainRevision = this.nextSnapshotRevision(mainProjectionKey);
      const mainReply = this.reserveDelivery({
        id: randomUUID(),
        idempotencyKey: binding.statusMessageId ? `${mainProjectionKey}:revision:${mainRevision}` : `status-card:${binding.id}`,
        bindingId: binding.id,
        bindingGeneration: binding.generation,
        viewVersion: current.topic.viewVersion,
        cardSequence: binding.statusMessageId ? this.nextMainCardSequence(binding) : null,
        targetRole: "session_status",
        workClass: "live",
        rootMessageId: binding.statusMessageId ?? binding.rootMessageId,
        kind: binding.statusMessageId ? "card_update" : "card_reply",
        payload: JSON.stringify(input.mainCard),
        projectionKey: mainProjectionKey,
        snapshotRevision: mainRevision
      });

      let answerReply: OutboundReply | null = null;
      if (current.answer && input.answerCard) {
        const { run, page } = current.answer;
        const answerProjectionKey = `primary-redelivery:answer:${run.promptId}:${page.pageIndex}`;
        const answerRevision = this.nextSnapshotRevision(answerProjectionKey);
        const cardSequence = incrementPrimaryAnswerPageSequence(this.context, run.promptId, page.pageIndex);
        if (cardSequence === null) throw new Error("Primary Answer page disappeared during redelivery reservation");
        answerReply = this.reserveDelivery({
          id: randomUUID(),
          idempotencyKey: `${answerProjectionKey}:revision:${answerRevision}`,
          bindingId: binding.id,
          bindingGeneration: binding.generation,
          promptId: run.promptId,
          viewVersion: run.viewVersion,
          cardSequence,
          cardRole: "answer",
          workClass: "live",
          rootMessageId: page.messageId,
          kind: "card_update",
          payload: JSON.stringify(input.answerCard),
          projectionKey: answerProjectionKey,
          snapshotRevision: answerRevision,
          streamPageIndex: page.pageIndex,
          laneKeyOverride: `answer:${run.promptId}:${page.pageIndex}`
        });
      }

      const outcome = answerReply ? "main_and_answer" : "main_only";
      const timestamp = now();
      this.context.database.prepare(`INSERT INTO primary_card_redeliveries(
        command_intent_id, binding_id, binding_generation, topic_view_version,
        prompt_id, run_view_version, answer_page_index, main_reply_id, answer_reply_id,
        outcome, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.commandIntentId, binding.id, binding.generation, current.topic.viewVersion,
          current.answer?.run.promptId ?? null, current.answer?.run.viewVersion ?? null,
          current.answer?.page.pageIndex ?? null, mainReply.id, answerReply?.id ?? null,
          outcome, timestamp, timestamp);
      return storedResult("scheduled", { outcome });
    });
  }

  private loadLatestEligiblePage(promptId: string): AnswerPage | null {
    const row = this.context.database.prepare(`SELECT prompt_id, page_index, message_id, card_id, element_id,
      source_start, sequence, state, delivery_mode, created_at, updated_at
      FROM answer_pages WHERE prompt_id = ? AND state IN ('active','finished') AND message_id IS NOT NULL
      ORDER BY page_index DESC LIMIT 1`).get(promptId) as AnswerPageRow | undefined;
    return row ? mapPage(row) : null;
  }

  private reserveDelivery(input: EnqueueOutboundReplyInput & { bindingGeneration: number }): OutboundReply {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Primary Card Redelivery prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

  private loadLatestHistoricalPage(bindingId: string, bindingGeneration: number): AnswerPage | null {
    const row = this.context.database.prepare(`SELECT page.prompt_id, page.page_index, page.message_id, page.card_id,
      page.element_id, page.source_start, page.sequence, page.state, page.delivery_mode, page.created_at, page.updated_at
      FROM run_cards run JOIN prompt_jobs prompt ON prompt.id = run.prompt_id
      JOIN answer_pages page ON page.prompt_id = run.prompt_id
      WHERE run.binding_id = ? AND run.binding_generation = ?
        AND page.state IN ('active','finished') AND page.message_id IS NOT NULL
      ORDER BY prompt.created_at DESC, prompt.rowid DESC, page.page_index DESC LIMIT 1`)
      .get(bindingId, bindingGeneration) as AnswerPageRow | undefined;
    return row ? mapPage(row) : null;
  }

  private loadNextPageStart(promptId: string, pageIndex: number): number | null {
    const row = this.context.database.prepare(`SELECT source_start FROM answer_pages
      WHERE prompt_id = ? AND page_index > ? ORDER BY page_index LIMIT 1`).get(promptId, pageIndex) as { source_start: number } | undefined;
    return row ? Number(row.source_start) : null;
  }

  private loadCompletionActions(page: AnswerPage): CompletionActionSetRenderState | null {
    const action = this.context.database.prepare(`SELECT id, owner_kind, owner_id, owner_generation, card_message_id,
      mention_open_id, state, selected_action, selected_choice_option_id, reason
      FROM completion_action_sets
      WHERE owner_kind = 'primary-prompt' AND owner_id = ? AND page_index = ?
        AND card_message_id = ? AND state IN ('available','consumed')`).get(page.promptId, page.pageIndex, page.messageId) as {
          id: string; owner_kind: "primary-prompt"; owner_id: string; owner_generation: number; card_message_id: string;
          mention_open_id: string | null; state: "available" | "consumed"; selected_action: string | null; selected_choice_option_id: string | null; reason: string | null;
        } | undefined;
    if (!action) return null;
    const identity = { id: action.id, ownerKind: action.owner_kind, ownerId: action.owner_id, ownerGeneration: Number(action.owner_generation), cardMessageId: action.card_message_id };
    const choice = loadCompletionChoice(this.context, action.owner_kind, action.owner_id, Number(action.owner_generation))?.specification;
    if (action.state === "available" && action.mention_open_id) return { ...identity, state: "available", mentionOpenId: action.mention_open_id, ...(choice ? { choiceSpecification: choice } : {}) };
    if (action.state === "consumed" && action.reason === "ignored") return { ...identity, state: "consumed", ignored: true };
    if (action.state === "consumed" && choice && action.selected_choice_option_id) {
      const selected = choice.options.find(({ id }) => id === action.selected_choice_option_id);
      if (selected) return { ...identity, state: "consumed", selectedChoice: { id: selected.id, label: selected.label } };
    }
    if (action.state === "consumed" && COMPLETION_ACTION_SELECTIONS.includes(action.selected_action as CompletionActionSelection)) {
      return { ...identity, state: "consumed", selectedAction: action.selected_action as CompletionActionSelection };
    }
    return null;
  }

  private nextSnapshotRevision(projectionKey: string): number {
    const row = this.context.database.prepare("SELECT MAX(snapshot_revision) AS revision FROM outbound_replies WHERE projection_key = ?")
      .get(projectionKey) as { revision: number | null };
    return Number(row.revision ?? 0) + 1;
  }

  private nextMainCardSequence(binding: Binding): number {
    const row = this.context.database.prepare(`SELECT MAX(COALESCE(card_sequence, 0)) AS sequence
      FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status'
        AND root_message_id = ? AND kind = 'card_update' AND state = 'pending'`)
      .get(binding.id, binding.statusMessageId) as { sequence: number | null };
    return Math.max(binding.statusCardSequence, Number(row.sequence ?? 0)) + 1;
  }
}

type AnswerPageRow = {
  prompt_id: string; page_index: number; message_id: string; card_id: string | null; element_id: string;
  source_start: number; sequence: number; state: AnswerPage["state"]; delivery_mode: AnswerPage["deliveryMode"];
  created_at: string; updated_at: string;
};

function mapPage(row: AnswerPageRow): AnswerPage {
  return {
    promptId: row.prompt_id, pageIndex: Number(row.page_index), messageId: row.message_id,
    cardId: row.card_id, elementId: row.element_id, sourceStart: Number(row.source_start),
    sequence: Number(row.sequence), state: row.state, deliveryMode: row.delivery_mode,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function isCurrentBinding(binding: Binding | null, expectedGeneration: number): binding is Binding {
  return binding !== null && binding.generation === expectedGeneration && binding.state === "active"
    && binding.lifecycle === "active" && binding.attachment === "attached";
}

function sameSnapshot(current: PrimaryCardRedeliverySnapshot, expected: PrimaryCardRedeliverySnapshot): boolean {
  if (current.topic.bindingId !== expected.topic.bindingId
    || current.topic.bindingGeneration !== expected.topic.bindingGeneration
    || current.topic.viewVersion !== expected.topic.viewVersion) return false;
  if (!current.answer || !expected.answer) return current.answer === expected.answer;
  return current.answer.run.promptId === expected.answer.run.promptId
    && current.answer.run.viewVersion === expected.answer.run.viewVersion
    && current.answer.page.pageIndex === expected.answer.page.pageIndex
    && current.answer.page.messageId === expected.answer.page.messageId
    && current.answer.page.cardId === expected.answer.page.cardId
    && current.answer.page.elementId === expected.answer.page.elementId
    && current.answer.page.sequence === expected.answer.page.sequence
    && current.answer.page.state === expected.answer.page.state
    && current.answer.nextPageStart === expected.answer.nextPageStart
    && JSON.stringify(current.answer.completionActions) === JSON.stringify(expected.answer.completionActions);
}

function storedResult(outcome: "scheduled" | "duplicate", stored: StoredOperation): PrimaryCardRedeliveryReservation {
  return { outcome, mainScheduled: true, answerScheduled: stored.outcome === "main_and_answer" };
}

function now(): string { return new Date().toISOString(); }
