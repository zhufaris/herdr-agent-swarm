import type { AgentInstance } from "../../domain/agent-instance.js";
import type { Binding } from "../../domain/binding.js";
import type { ControlActor } from "../../domain/commands.js";
import type {
  InstanceEvent,
  InstanceEventKind,
  InstanceTurn,
  InstanceTurnState,
  InstanceTurnSummary,
} from "../../domain/instance-turn.js";
import type {
  AcceptInstanceTurnWithCardInput,
  TransitionInstanceTurnWithProjectionInput,
  TransitionInstanceTurnWithProjectionResult,
  WorkerCompletionActionAcceptanceInput,
  WorkerCompletionActionAcceptanceResult,
} from "../../domain/ports.js";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { AnswerTimelineItem } from "../../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../../domain/delivery.js";
import type {
  AnswerPageDeliveryFacts,
  AnswerPageReservationOutcome,
  AnswerTimelinePageCheckpoint,
} from "../../domain/types.js";
import type { AnswerSegment } from "../../domain/answer-segment.js";
import type {
  WorkerTurnCardChange,
  WorkerTurnCardPage,
  WorkerTurnCardView,
} from "../../domain/worker-turn-card-view.js";
import { matchesExpectedWorkerRuntimeTurn } from "../../domain/worker-turn-policies.js";
import type { SqliteContext } from "./context.js";
import { WorkerTurnAcceptance } from "./worker-turn/acceptance.js";
import { WorkerHumanReview } from "./worker-turn/human-review.js";
import { WorkerCompletionActionEligibility } from "./worker-turn/completion-action-eligibility.js";
import { loadCompletionChoice } from "./completion-choice-store.js";
import { WorkerTurnProjection } from "./worker-turn/projection.js";
import { WorkerTurnQueue } from "./worker-turn/queue.js";
import { WorkerTurnRecovery } from "./worker-turn/recovery.js";
import { mapInstanceTurn, mapWorkerTurnCard } from "./worker-turn/records.js";
import { WorkerTurnTransition } from "./worker-turn/transition.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import { SqliteProjectionGapStore } from "./projection-gap-store.js";
import { randomUUID } from "node:crypto";
import { COMPLETION_ACTION_SELECTIONS, completionReviewActionSetIdentity, type CompletionActionSelection, type CompletionActionSetRenderState } from "../../domain/completion-action-set.js";
import { canMentionFeishuOpenId } from "../../domain/worker-human-review.js";
import { recoverCompletionNotification } from "./completion-notification-store.js";
import type { ConversationSegmentStore } from "../../domain/ports/conversation-segment.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import { withWorkerTaskProjectionIdentity } from "./worker-task-projection-identity.js";
import type { ReserveValidatedCardDismissalInput } from "../../domain/ports/card-dismissal.js";
import { SqliteCompletionReviewStore } from "./completion-review-store.js";

export interface WorkerTurnStoreDependencies {
  conversationSegments?: ConversationSegmentStore;
  getAgentInstance(id: string): AgentInstance | null;
  getBinding(id: string): Binding | null;
  enqueueOutboundReply(input: EnqueueOutboundReplyInput): unknown;
  invalidateWorkerCardContexts(view: WorkerTurnCardView, reason: string): void;
  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean;
  reserveCardDismissal(input: ReserveValidatedCardDismissalInput): unknown;
}

export class SqliteWorkerTurnStore {
  private readonly projection: WorkerTurnProjection;
  private readonly queue: WorkerTurnQueue;
  private readonly acceptance: WorkerTurnAcceptance;
  private readonly transition: WorkerTurnTransition;
  private readonly recovery: WorkerTurnRecovery;
  private readonly humanReview: WorkerHumanReview;
  private readonly completionReviews: SqliteCompletionReviewStore;
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: WorkerTurnStoreDependencies,
  ) {
    this.projection = new WorkerTurnProjection(context, {
      enqueueOutboundReply: (input) => this.enqueueOutboundReply(input),
    });
    const event = this.insertInstanceEvent.bind(this);
    this.queue = new WorkerTurnQueue(context, {
      getAgentInstance: dependencies.getAgentInstance,
      saveWorkerTurnCard: (view) => this.projection.save(view),
      invalidateWorkerCardContexts: dependencies.invalidateWorkerCardContexts,
      insertInstanceEvent: event,
    });
    this.acceptance = new WorkerTurnAcceptance(context, {
      ...dependencies,
      enqueueOutboundReply: (input) => this.enqueueOutboundReply(input),
      queue: this.queue,
      projection: this.projection,
      insertInstanceEvent: event,
    });
    this.humanReview = new WorkerHumanReview(context, dependencies);
    this.completionReviews = new SqliteCompletionReviewStore(context);
    const completionActionEligibility = new WorkerCompletionActionEligibility(context, {
      getAgentInstance: dependencies.getAgentInstance,
      getBinding: dependencies.getBinding
    });
    this.transition = new WorkerTurnTransition(context, {
      projection: this.projection,
      queue: this.queue,
      humanReview: this.humanReview,
      completionActionEligibility,
      invalidateWorkerCardContexts: dependencies.invalidateWorkerCardContexts,
      insertInstanceEvent: event,
    });
    this.recovery = new WorkerTurnRecovery(context, {
      projection: this.projection,
      insertInstanceEvent: event,
    });
  }
  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
    this.projection.setPreparedDeliveryReservation(reservation, consumer);
    this.humanReview.setPreparedDeliveryReservation(reservation, consumer);
  }
  private enqueueOutboundReply(input: EnqueueOutboundReplyInput): unknown {
    const routed = withWorkerTaskProjectionIdentity(this.context, input);
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Worker Turn prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(routed);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }
  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }
  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean {
    return this.dependencies.hasPendingOutboundReplyForWorkerTurn(turnId);
  }
  acceptInstanceTurn(input: {
    id: string;
    idempotencyKey: string;
    actor: ControlActor;
    projectId: string;
    instanceId: string;
    instanceGeneration: number;
    kind: InstanceTurn["kind"];
    priority?: InstanceTurn["priority"];
    text: string;
    maxQueueDepth?: number;
  }): { turn: InstanceTurn; inserted: boolean; completionActionOwnerTurnIds?: string[] } {
    return this.context.transaction("sqlite.worker-turn-store.write", () => this.acceptance.accept(input));
  }
  acceptInstanceTurnWithCard(
    input: AcceptInstanceTurnWithCardInput & { maxQueueDepth?: number },
  ): { turn: InstanceTurn; view: WorkerTurnCardView; inserted: boolean; completionActionOwnerTurnIds?: string[] } {
    return this.context.transaction("sqlite.worker-turn-store.write", () => {
      const result = this.acceptance.acceptWithCard(input);
      return result;
    });
  }
  acceptWorkerCompletionAction(input: WorkerCompletionActionAcceptanceInput): WorkerCompletionActionAcceptanceResult {
    return this.context.transaction("sqlite.worker-turn-store.write", () => this.acceptance.acceptCompletionAction(input));
  }
  ignoreWorkerCompletionAction(input: { actionSetId: string; ownerTurnId: string; ownerGeneration: number; cardMessageId: string; chatId: string; actorOpenId: string }): import("../../domain/completion-action-set.js").CompletionActionIgnoreResult {
    return this.context.transaction("sqlite.worker-turn-store.write", () => this.acceptance.ignoreCompletionAction(input));
  }
  resolveWorkerCompletionChoice(input: { actionSetId: string; optionId: string; ownerTurnId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string }): { label: string; message: string } {
    const row = this.context.database.prepare(`SELECT option.label, option.message
      FROM completion_action_sets action
      JOIN completion_choice_options option ON option.specification_id = action.choice_specification_id
      WHERE action.id = ? AND action.owner_kind = 'worker-turn' AND action.owner_id = ? AND action.owner_generation = ?
        AND (CASE WHEN action.presentation_kind='fresh-card' THEN action.presentation_message_id ELSE action.card_message_id END) = ?
        AND action.mention_open_id = ?
        AND ((action.presentation_kind='fresh-card' AND action.state='active')
          OR (action.presentation_kind='legacy-inline' AND action.state='available')
          OR (action.state = 'consumed' AND action.selected_choice_option_id = option.option_id))
        AND option.option_id = ?`).get(input.actionSetId, input.ownerTurnId, input.ownerGeneration, input.cardMessageId, input.actorOpenId, input.optionId) as { label: string; message: string } | undefined;
    if (!row) throw new Error("Worker completion choice is no longer available");
    return row;
  }
  resolveFreshWorkerCompletionReview(input: { actionSetId: string; optionId: string; messageId: string; actorOpenId: string; chatId: string }): { ownerTurnId: string; ownerGeneration: number; cardMessageId: string } | null {
    const row = this.context.database.prepare(`SELECT action.owner_id,action.owner_generation,action.presentation_message_id
      FROM completion_action_sets action
      JOIN bindings binding ON binding.id=action.binding_id AND binding.generation=action.binding_generation
      LEFT JOIN completion_choice_options option ON option.specification_id=action.choice_specification_id AND option.option_id=?
      WHERE action.id=? AND action.owner_kind='worker-turn' AND action.presentation_kind='fresh-card'
        AND action.presentation_message_id=? AND action.mention_open_id=? AND binding.chat_id=?
        AND (
          (action.state='active' AND (?='ignore' OR option.option_id IS NOT NULL))
          OR (action.state='consumed' AND ((?='ignore' AND action.reason='ignored') OR action.selected_choice_option_id=?))
        )`).get(
      input.optionId, input.actionSetId, input.messageId, input.actorOpenId, input.chatId,
      input.optionId, input.optionId, input.optionId
    ) as { owner_id: string; owner_generation: number; presentation_message_id: string } | undefined;
    return row ? { ownerTurnId: row.owner_id, ownerGeneration: row.owner_generation, cardMessageId: row.presentation_message_id } : null;
  }
  getInstanceTurn(id: string): InstanceTurn | null {
    return mapInstanceTurn(
      this.context.database
        .prepare("SELECT * FROM instance_turns WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined,
    );
  }
  claimInstanceTurnTranscript(input: {
    turnId: string;
    expectedGeneration: number;
    runtimeTurnId: string;
    startedAt: string;
  }): InstanceTurn | null {
    if (!input.runtimeTurnId || !Number.isFinite(Date.parse(input.startedAt)))
      return null;
    return this.context.transaction("sqlite.worker-turn-store.write", () => {
      const current = this.getInstanceTurn(input.turnId);
      if (
        !current ||
        current.instanceGeneration !== input.expectedGeneration ||
        !["dispatching", "running", "blocked", "dispatch-uncertain"].includes(
          current.state,
        )
      )
        return null;
      if (
        current.runtimeTurnId !== null ||
        current.runtimeTurnStartedAt !== null
      )
        return current.runtimeTurnId === input.runtimeTurnId &&
          current.runtimeTurnStartedAt === input.startedAt
          ? current
          : null;
      const changed = this.context.database
        .prepare(
          `UPDATE instance_turns SET runtime_turn_id = ?, runtime_turn_started_at = ?, updated_at = ? WHERE id = ? AND instance_generation = ? AND runtime_turn_id IS NULL AND runtime_turn_started_at IS NULL AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.id = instance_turns.instance_id AND i.generation = ? AND i.pane_id IS NOT NULL)`,
        )
        .run(
          input.runtimeTurnId,
          input.startedAt,
          now(),
          input.turnId,
          input.expectedGeneration,
          input.expectedGeneration,
        );
      if (changed.changes === 1)
        this.insertInstanceEvent(
          current.projectId,
          current.instanceId,
          current.id,
          "turn.transcript-owned",
          { runtimeTurnId: input.runtimeTurnId, startedAt: input.startedAt },
        );
      return changed.changes === 1 ? this.getInstanceTurn(input.turnId) : null;
    });
  }
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null {
    return this.projection.load(turnId);
  }
  findWorkerTurnByCardMessage(
    messageId: string,
  ): { turn: InstanceTurn; view: WorkerTurnCardView } | null {
    const id = this.projection.findTurnIdByMessage(messageId);
    if (!id) return null;
    const turn = this.getInstanceTurn(id);
    const view = this.projection.load(id);
    return turn && view ? { turn, view } : null;
  }
  listWorkerTurnCardPages(turnId: string): WorkerTurnCardPage[] {
    return this.projection.listPages(turnId);
  }
  prepareWorkerCompletionActionSet(input: { turnId: string; pageIndex: number; cardId: string; messageId: string; card?: object | ((review: { actionSetId: string; mentionOpenId: string; choicePrompt: import("../../domain/completion-choice.js").ChoicePrompt; choiceSpecification: import("../../domain/completion-choice.js").ChoicePrompt }) => object) }): CompletionActionSetRenderState | null {
    return this.context.transaction("sqlite.worker-turn-store.write", () => {
      let existing = this.context.database.prepare(`SELECT id, owner_kind, owner_id, owner_generation, card_message_id, mention_open_id, presentation_kind, state, selected_action, selected_choice_option_id, reason
        FROM completion_action_sets WHERE owner_kind = 'worker-turn' AND owner_id = ?`).get(input.turnId) as {
          id: string; owner_kind: "worker-turn"; owner_id: string; owner_generation: number; card_message_id: string;
          mention_open_id: string | null; presentation_kind: string; state: "available" | "provisional" | "presenting" | "active" | "consumed" | "superseded" | "unavailable"; selected_action: string | null; selected_choice_option_id: string | null; reason: string | null;
        } | undefined;
      if (existing && (!input.card || existing.presentation_kind !== "fresh-card")) {
        if (existing.card_message_id !== input.messageId) return null;
        recoverCompletionNotification(
          this.context,
          "worker-turn",
          input.turnId,
          this.preparedDeliveryReservation && this.preparedDeliveryConsumer
            ? { reservation: this.preparedDeliveryReservation, consumer: this.preparedDeliveryConsumer }
            : undefined,
        );
        existing = this.context.database.prepare(`SELECT id, owner_kind, owner_id, owner_generation, card_message_id, mention_open_id, presentation_kind, state, selected_action, selected_choice_option_id, reason
          FROM completion_action_sets WHERE owner_kind = 'worker-turn' AND owner_id = ?`).get(input.turnId) as typeof existing;
        if (!existing) return null;
        const current = existing;
        const choice = loadCompletionChoice(this.context, current.owner_kind, current.owner_id, current.owner_generation)?.prompt;
        if (current.state === "available" && current.mention_open_id) return { id: current.id, state: "available", mentionOpenId: current.mention_open_id, ownerKind: current.owner_kind, ownerId: current.owner_id, ownerGeneration: current.owner_generation, cardMessageId: current.card_message_id, ...(choice ? { choicePrompt: choice, choiceSpecification: choice } : {}) };
        if (current.state === "consumed" && current.reason === "ignored") return { id: current.id, state: "consumed", ignored: true, ownerKind: current.owner_kind, ownerId: current.owner_id, ownerGeneration: current.owner_generation, cardMessageId: current.card_message_id };
        if (current.state === "consumed" && choice && current.selected_choice_option_id) {
          const selected = [choice.defaultOption, ...choice.alternatives].find(({ id }) => id === current.selected_choice_option_id);
          if (selected) return { id: current.id, state: "consumed", selectedChoice: { id: selected.id, label: selected.label }, ownerKind: current.owner_kind, ownerId: current.owner_id, ownerGeneration: current.owner_generation, cardMessageId: current.card_message_id };
        }
        if (current.state === "consumed" && COMPLETION_ACTION_SELECTIONS.includes(current.selected_action as CompletionActionSelection)) return { id: current.id, state: "consumed", selectedAction: current.selected_action as CompletionActionSelection, ownerKind: current.owner_kind, ownerId: current.owner_id, ownerGeneration: current.owner_generation, cardMessageId: current.card_message_id };
        return null;
      }
      const obligation = this.context.database.prepare(`SELECT owner_generation, binding_id, binding_generation, state, notification_reply_id
        FROM completion_notification_obligations WHERE owner_kind = 'worker-turn' AND owner_id = ?`).get(input.turnId) as {
          owner_generation: number; binding_id: string; binding_generation: number; state: string; notification_reply_id: string | null;
        } | undefined;
      const turn = this.context.database.prepare("SELECT rowid, instance_id, instance_generation, actor_json, actor_kind, state, created_at FROM instance_turns WHERE id = ?").get(input.turnId) as {
        rowid: number; instance_id: string; instance_generation: number; actor_json: string; actor_kind: string | null; state: string; created_at: string;
      } | undefined;
      const page = this.context.database.prepare("SELECT page_index, card_id, message_id, state FROM worker_turn_card_pages WHERE turn_id = ? AND page_index = ?").get(input.turnId, input.pageIndex) as { page_index: number; card_id: string | null; message_id: string | null; state: string } | undefined;
      const latest = this.context.database.prepare("SELECT MAX(page_index) AS page_index FROM worker_turn_card_pages WHERE turn_id = ?").get(input.turnId) as { page_index: number | null };
      const view = this.projection.load(input.turnId);
      const instance = turn ? this.dependencies.getAgentInstance(turn.instance_id) : null;
      const parent = instance?.parent;
      const binding = parent ? this.dependencies.getBinding(parent.bindingId) : null;
      const legacyPending = obligation?.state === "released" && obligation.notification_reply_id
        ? this.context.database.prepare(`SELECT 1 FROM outbound_replies WHERE id = ? AND state = 'pending'
            AND kind = 'text' AND target_role='operation_result' AND payload LIKE '%需要你的选择%'
            AND claim_attempt_id IS NULL AND claimed_owner_id IS NULL AND claimed_fence IS NULL
            AND claimed_at IS NULL AND first_claimed_at IS NULL AND attempt_count = 0
            AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL
            AND COALESCE(effect_certainty,'not-started') IN ('not-started','rejected')`).get(obligation.notification_reply_id) !== undefined
        : false;
      if (!obligation || !turn || !page || !view || !instance || !parent || !binding
        || obligation.state === "suppressed" && existing?.presentation_kind !== "fresh-card"
        || obligation.state === "released" && !legacyPending
        || turn.state !== "completed" || view.phase !== "completed" || page.page_index !== latest.page_index || !["active", "finished"].includes(page.state)
        || page.card_id !== input.cardId || page.message_id !== input.messageId || view.instanceId !== instance.id
        || instance.generation !== turn.instance_generation || view.instanceGeneration !== turn.instance_generation
        || instance.role !== "worker" || instance.desiredState !== "running"
        || instance.workerSessionLifecycle !== "active" || !instance.runtimeRef
        || instance.workerSessionGeneration !== obligation.owner_generation || view.workerSessionGeneration !== obligation.owner_generation
        || parent.bindingId !== obligation.binding_id || parent.bindingGeneration !== obligation.binding_generation
        || parent.paneId !== binding.paneId || binding.traexSessionId !== null && parent.nativeSessionId !== binding.traexSessionId
        || binding.generation !== obligation.binding_generation || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return null;
      const successor = this.context.database.prepare(`SELECT 1 FROM instance_turns later
        WHERE later.instance_id = ? AND later.instance_generation = ? AND later.actor_kind = 'human' AND later.id != ?
          AND (later.created_at > ? OR (later.created_at = ? AND later.rowid > ?)) LIMIT 1`).get(
          turn.instance_id, turn.instance_generation, input.turnId, turn.created_at, turn.created_at, turn.rowid
        );
      let actor: InstanceTurn["actor"] | null = null;
      try { actor = JSON.parse(turn.actor_json) as InstanceTurn["actor"]; } catch { actor = null; }
      const mentionOpenId = actor?.kind === "human" && actor.channel === "feishu" && canMentionFeishuOpenId(actor.userId)
        ? actor.userId
        : canMentionFeishuOpenId(binding.creatorOpenId) ? binding.creatorOpenId : null;
      const state = successor ? "superseded" : mentionOpenId ? "available" : "unavailable";
      const timestamp = now();
      const choice = loadCompletionChoice(this.context, "worker-turn", input.turnId, obligation.owner_generation);
      if (input.card && mentionOpenId && choice && (!successor || existing?.presentation_kind === "fresh-card")) {
        if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Completion Review prepared delivery is not connected");
        const actionSetId = completionReviewActionSetIdentity("worker-turn", input.turnId, obligation.owner_generation);
        const card = typeof input.card === "function"
          ? input.card({ actionSetId, mentionOpenId, choicePrompt: choice.prompt, choiceSpecification: choice.prompt })
          : input.card;
        const reserved = this.completionReviews.reserveWorker({
          turnId: input.turnId, workerId: instance.id, workerGeneration: instance.generation, ownerGeneration: obligation.owner_generation,
          bindingId: binding.id, bindingGeneration: binding.generation,
          pageIndex: input.pageIndex, mentionOpenId, choiceSpecificationId: choice.id,
          rootMessageId: view.rootMessageId, card,
          reserveDelivery: this.preparedDeliveryReservation
        });
        if (reserved.receipt) this.handoffAfterCommit(reserved.receipt);
        return { id: reserved.actionSetId, state: "available", presentationKind: "fresh-card", mentionOpenId,
          ownerKind: "worker-turn", ownerId: input.turnId, ownerGeneration: obligation.owner_generation,
          cardMessageId: input.messageId, choicePrompt: choice.prompt, choiceSpecification: choice.prompt };
      }
      const id = randomUUID();
      this.context.database.prepare(`INSERT INTO completion_action_sets(
        id, owner_kind, owner_id, owner_generation, binding_id, binding_generation, page_index, card_id, card_message_id,
        mention_open_id, state, selected_action, result_source_key, reason, created_at, updated_at, decided_at, choice_specification_id, selected_choice_option_id
      ) VALUES (?, 'worker-turn', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)`).run(
        id, input.turnId, obligation.owner_generation, binding.id, binding.generation, input.pageIndex, input.cardId, input.messageId,
        mentionOpenId, state, successor ? "successor-present" : mentionOpenId ? null : "missing-mention-target", timestamp, timestamp,
        state === "available" ? null : timestamp, choice?.id ?? null
      );
      this.context.database.prepare(`UPDATE completion_notification_obligations SET state = ?, released_at = ?, updated_at = ?
        WHERE owner_kind = 'worker-turn' AND owner_id = ? AND owner_generation = ? AND state IN ('waiting_for_answer','missing_mention_target')`).run(
          state === "available" ? "waiting_for_answer" : successor ? "suppressed" : "missing_mention_target", null,
          timestamp, input.turnId, obligation.owner_generation
        );
      if (state === "available") {
        this.context.database.prepare("UPDATE worker_turn_cards SET view_version = view_version + 1, updated_at = ? WHERE turn_id = ?").run(timestamp, input.turnId);
      }
      return state === "available" && mentionOpenId
        ? { id, state: "available", mentionOpenId, ownerKind: "worker-turn", ownerId: input.turnId, ownerGeneration: obligation.owner_generation, cardMessageId: input.messageId, ...(choice ? { choicePrompt: choice.prompt, choiceSpecification: choice.prompt } : {}) }
        : null;
    });
  }
  listAnswerSegments(
    aggregateKind: "primary-run" | "worker-turn",
    aggregateId: string,
  ): AnswerSegment[] {
    return this.projection.listAnswerSegments(aggregateKind, aggregateId);
  }
  listActionableWorkerTurnCardIds(): string[] {
    return this.projection.listActionableIds();
  }
  listRecoverableWorkerTurnIds(limit: number): string[] {
    return this.projection.listRecoverableIds(limit);
  }
  listRecoverableWorkerTurnIdsForBinding(bindingId: string, limit: number): string[] {
    return this.projection.listRecoverableIdsForBinding(bindingId, limit);
  }
  getWorkerTurnCardDeliveryFacts(
    turnId: string,
    pageIndex: number,
  ): AnswerPageDeliveryFacts {
    return this.projection.getDeliveryFacts(turnId, pageIndex);
  }
  getWorkerAnswerTimelinePage(
    turnId: string,
    pageIndex: number,
  ): AnswerTimelinePageCheckpoint {
    return this.projection.getTimelinePage(turnId, pageIndex);
  }
  listFrozenWorkerAnswerTimelineItems(turnId: string, beforePageIndex: number) {
    return this.projection.listFrozenTimelineItems(turnId, beforePageIndex);
  }
  getWorkerProjectionGapSummary(turnId: string) {
    return new SqliteProjectionGapStore(this.context).summarize({ workerTurnId: turnId });
  }
  reserveHumanMessageAnswerSegments(input: {
    aggregateKind: "primary-run" | "worker-turn";
    aggregateId: string;
    expectedGeneration: number;
    boundaries: readonly import("../../domain/answer-segment.js").AnswerSegmentBoundary[];
    previousFinalizedCard: object;
    nextCards: readonly object[];
    rootMessageId: string;
    workClass?: import("../../domain/types.js").OutboundWorkClass;
  }) {
    return this.context.transaction("sqlite.worker-turn-store.write", () =>
      this.projection.reserveHumanMessageAnswerSegments(input),
    );
  }
  reserveWorkerAnswerTimelineCard(input: {
    turnId: string;
    pageIndex: number;
    messageId: string;
    card: object;
    cursor: AnswerTimelineCursor | null;
    items: readonly AnswerTimelineItem[];
  }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.worker-turn-store.write", () =>
      this.projection.reserveTimelineCard(input),
    );
  }
  reserveWorkerTurnContent(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    elementId: string;
    content: string;
    sourceEnd: number;
  }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.worker-turn-store.write", () =>
      this.projection.reserveContent(input),
    );
  }
  reserveWorkerTurnProgress(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    elementId: string;
    content: string;
  }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.worker-turn-store.write", () =>
      this.projection.reserveProgress(input),
    );
  }
  reserveWorkerTurnFinish(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    summary: string;
  }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.worker-turn-store.write", () => this.projection.reserveFinish(input));
  }
  reserveWorkerTurnCardHydration(input: {
    turnId: string;
    pageIndex: number;
    cardId: string | null;
    messageId: string;
    card: object;
  }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.worker-turn-store.write", () =>
      this.projection.reserveHydration(input),
    );
  }
  reserveWorkerTurnContinuation(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    summary: string;
    nextPageIndex: number;
    nextPageStart: number;
    nextElementId: string;
    rootMessageId: string;
    viewVersion: number;
    card: object;
    timelineStartCursor?: AnswerTimelineCursor;
    timelineEndCursor?: AnswerTimelineCursor | null;
    timelineItems?: readonly AnswerTimelineItem[];
  }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.worker-turn-store.write", () =>
      this.projection.reserveContinuation(input),
    );
  }
  reserveWorkerTurnRecovery(input: {
    turnId: string;
    previousPageIndex: number;
    nextPageIndex: number;
    pageStart: number;
    nextElementId: string;
    rootMessageId: string;
    viewVersion: number;
    card: object;
  }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.worker-turn-store.write", () => this.projection.reserveRecovery(input));
  }
  applyInstanceTurnProjection(input: {
    turnId: string;
    expectedGeneration: number;
    expectedRuntimeTurnId?: string;
    expectedRuntimeTurnStartedAt?: string;
    change: WorkerTurnCardChange;
    render(view: WorkerTurnCardView): object;
  }): WorkerTurnCardView | null {
    return this.context.transaction("sqlite.worker-turn-store.write", () =>
      this.transition.applyProjection(input),
    );
  }
  transitionInstanceTurnWithProjection(
    input: TransitionInstanceTurnWithProjectionInput,
  ): TransitionInstanceTurnWithProjectionResult | null {
    return this.context.transaction("sqlite.worker-turn-store.write", () => this.transition.transition(input));
  }
  saveWorkerTurnCard(view: WorkerTurnCardView): void {
    this.context.transaction("sqlite.worker-turn-store.write", () => this.projection.save(view));
  }
  listInstanceTurns(
    instanceId: string,
    options: { limit?: number; after?: { createdAt: string; id: string } } = {},
  ): {
    items: InstanceTurn[];
    nextCursor: { createdAt: string; id: string } | null;
  } {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const rows = (
      options.after
        ? this.context.database
            .prepare(
              "SELECT * FROM instance_turns WHERE instance_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?",
            )
            .all(
              instanceId,
              options.after.createdAt,
              options.after.createdAt,
              options.after.id,
              limit + 1,
            )
        : this.context.database
            .prepare(
              "SELECT * FROM instance_turns WHERE instance_id = ? ORDER BY created_at, id LIMIT ?",
            )
            .all(instanceId, limit + 1)
    ) as Array<Record<string, unknown>>;
    const items = rows.slice(0, limit).map((row) => mapInstanceTurn(row)!);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }
  listRecentInstanceTurnSummaries(
    instanceId: string,
    requestedLimit = 5,
  ): InstanceTurnSummary[] {
    const limit = Math.max(1, Math.min(requestedLimit, 5));
    return (
      this.context.database
        .prepare(
          `SELECT t.*, COALESCE(c.result_capture, CASE WHEN t.result IS NOT NULL THEN 'captured' ELSE 'pending' END) AS result_capture FROM instance_turns t LEFT JOIN worker_turn_cards c ON c.turn_id = t.id WHERE t.instance_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
        )
        .all(instanceId, limit) as Array<Record<string, unknown>>
    ).map((row) => ({
      ...mapInstanceTurn(row)!,
      resultCapture: String(
        row.result_capture,
      ) as InstanceTurnSummary["resultCapture"],
    }));
  }
  getActiveInstanceTurn(
    instanceId: string,
    expectedGeneration: number,
  ): InstanceTurn | null {
    return this.queue.getActive(instanceId, expectedGeneration);
  }
  claimNextInstanceTurn(
    instanceId: string,
    expectedGeneration: number,
  ): InstanceTurn | null {
    return this.context.transaction("sqlite.worker-turn-store.write", () =>
      this.queue.claimNext(instanceId, expectedGeneration),
    );
  }
  recoverInterruptedInstanceTurns(): {
    requeuedTurnIds: string[];
    cancelledLegacyTurnIds: string[];
    observableTurns: InstanceTurn[];
  } {
    return this.context.transaction("sqlite.worker-turn-store.write", () => this.recovery.recover());
  }
  listObservableInstanceTurns(): InstanceTurn[] {
    return this.recovery.listObservable();
  }
  listObservableInstanceTurnsByPaneIds(
    paneIds: readonly string[],
  ): InstanceTurn[] {
    return this.recovery.listObservableByPaneIds(paneIds);
  }
  getInstanceTurnDiagnostics(): {
    queuedTurns: number;
    activeTurns: number;
    uncertainTurns: number;
  } {
    return this.recovery.diagnostics();
  }
  updateInstanceTurn(input: {
    turnId: string;
    expectedGeneration: number;
    expectedRuntimeTurnId?: string;
    expectedRuntimeTurnStartedAt?: string;
    state: InstanceTurnState;
    result?: string | null;
    error?: string | null;
    eventKind: InstanceEventKind;
  }): InstanceTurn | null {
    return this.context.transaction("sqlite.worker-turn-store.write", () => this.transition.update(input));
  }
  completeInstanceTurn(input: {
    turnId: string;
    expectedGeneration: number;
    result: string;
  }): InstanceTurn | null {
    return this.updateInstanceTurn({
      ...input,
      state: "completed",
      eventKind: "turn.completed",
    });
  }
  listInstanceEvents(instanceId: string, afterId = 0): InstanceEvent[] {
    return (
      this.context.database
        .prepare(
          "SELECT * FROM instance_events WHERE instance_id = ? AND id > ? ORDER BY id LIMIT 100",
        )
        .all(instanceId, afterId) as Array<Record<string, unknown>>
    ).map((row) => ({
      id: Number(row.id),
      projectId: String(row.project_id),
      instanceId: String(row.instance_id),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      kind: String(row.kind) as InstanceEventKind,
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      createdAt: String(row.created_at),
    }));
  }
  countPendingInstanceTurns(
    instanceId: string,
    expectedGeneration?: number,
  ): number {
    return this.queue.countPending(instanceId, expectedGeneration);
  }
  private insertInstanceEvent(
    projectId: string,
    instanceId: string,
    turnId: string | null,
    kind: InstanceEventKind,
    payload: Record<string, unknown>,
  ): number {
    const result = this.context.database
      .prepare(
        "INSERT INTO instance_events(project_id, instance_id, turn_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(projectId, instanceId, turnId, kind, JSON.stringify(payload), now());
    return Number(result.lastInsertRowid);
  }
}

export { mapWorkerTurnCard };
function now(): string {
  return new Date().toISOString();
}
