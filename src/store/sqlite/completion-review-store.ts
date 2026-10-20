import { completionReviewActionSetIdentity } from "../../domain/completion-action-set.js";
import { completionChoiceSubmissionIdentity } from "../../domain/completion-choice.js";
import { canonicalHumanInputJson, humanInputMessage } from "../../domain/inbound.js";
import type { PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import type { SubmissionIntentActor } from "../../domain/submission-intent.js";
import type { PrimarySegmentCompletionReviewDecision } from "../../domain/ports/conversation-segment.js";
import type { PrimaryCompletionReviewDecision } from "../../domain/ports/workflow.js";
import type { SqliteContext } from "./context.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import { SqliteProjectionGapStore } from "./projection-gap-store.js";
import { suppressCompletionNotificationForFreshReview } from "./completion-notification-store.js";

export type CompletionReviewActivationOutcome =
  | { outcome: "activated" }
  | { outcome: "already_active" }
  | { outcome: "already_terminal" };

export interface CompletionReviewStartupRecovery {
  activated: number;
  alreadyActive: number;
  alreadyTerminal: number;
  invalid: number;
}

export type PrimaryPromptCompletionReviewDecision =
  | { kind: "ignored"; promptId: string; changed: boolean }
  | { kind: "submission"; promptId: string; submissionId: string; inserted: boolean };

export class SqliteCompletionReviewStore {
  constructor(private readonly context: SqliteContext) {}

  getOwnerKind(actionSetId: string): "primary-segment" | "primary-prompt" | "worker-turn" | null {
    const row = this.context.database.prepare(`SELECT owner_kind FROM completion_action_sets
      WHERE id=? AND presentation_kind='fresh-card'`).get(actionSetId) as { owner_kind: string } | undefined;
    return row?.owner_kind === "primary-segment" || row?.owner_kind === "primary-prompt" || row?.owner_kind === "worker-turn" ? row.owner_kind : null;
  }

  decidePrimary(input: {
    actionSetId: string;
    optionId: string;
    messageId: string;
    actorOpenId: string;
    chatId: string;
    occurredAt: string;
  }): PrimaryCompletionReviewDecision {
    const ownerKind = this.getOwnerKind(input.actionSetId);
    if (ownerKind === "primary-segment") return { ownerKind, ...this.decidePrimarySegment(input) };
    if (ownerKind === "primary-prompt") return { ownerKind, ...this.decidePrimaryPrompt(input) };
    throw new Error("Completion choice is no longer available");
  }

  recoverDeliveredPresentations(): CompletionReviewStartupRecovery {
    return this.context.transaction("sqlite.completion-review-store.write", () => {
      const result: CompletionReviewStartupRecovery = { activated: 0, alreadyActive: 0, alreadyTerminal: 0, invalid: 0 };
      const receipts = this.context.database.prepare(`SELECT action.presentation_reply_id AS reply_id,
          reply.delivered_message_id,reply.card_id_checkpoint
        FROM completion_action_sets action
        JOIN outbound_replies reply ON reply.id=action.presentation_reply_id
        WHERE action.presentation_kind='fresh-card' AND action.state='presenting'
          AND reply.state='delivered'
        ORDER BY action.updated_at,action.id`).all() as Array<{
          reply_id: string; delivered_message_id: string | null; card_id_checkpoint: string | null;
        }>;
      const gaps = new SqliteProjectionGapStore(this.context);
      for (const receipt of receipts) {
        try {
          if (!receipt.delivered_message_id) throw new Error("Completion Review delivered evidence is incomplete");
          const outcome = this.activatePresentation({
            replyId: receipt.reply_id,
            messageId: receipt.delivered_message_id,
            cardId: receipt.card_id_checkpoint,
            occurredAt: new Date().toISOString()
          });
          if (outcome.outcome === "activated") result.activated += 1;
          else if (outcome.outcome === "already_active") result.alreadyActive += 1;
          else result.alreadyTerminal += 1;
        } catch {
          result.invalid += 1;
          gaps.openDeliveryForReply(receipt.reply_id, "permanent", "completion_review_startup_receipt_conflict", new Date().toISOString());
        }
      }
      return result;
    });
  }

  reservePrimarySegment(input: {
    segmentId: string;
    ownerGeneration: number;
    bindingId: string;
    bindingGeneration: number;
    pageIndex: number;
    mentionOpenId: string;
    choiceSpecificationId: string;
    rootMessageId: string;
    worker?: { id: string; generation: number; sessionGeneration: number };
    card: object;
    reserveDelivery: PreparedDeliveryReservation;
  }): { actionSetId: string; receipt: PreparedDeliveryReceipt | null } {
    return this.context.transaction("sqlite.completion-review-store.write", () => {
      const actionSetId = completionReviewActionSetIdentity("primary-segment", input.segmentId, input.ownerGeneration);
      const frozenPayload = JSON.stringify(input.card);
      const existing = this.context.database.prepare(`SELECT action.id,action.owner_generation,action.binding_id,
          action.binding_generation,action.page_index,action.mention_open_id,action.presentation_kind,
          action.presentation_generation,action.presentation_reply_id,action.choice_specification_id,
          reply.idempotency_key,reply.binding_id AS reply_binding_id,reply.worker_id,reply.worker_session_generation,
          reply.delivery_owner_kind,reply.delivery_owner_generation,reply.delivery_parent_id,reply.delivery_parent_generation,
          reply.root_message_id,reply.kind,
          reply.payload,reply.projection_key,reply.state AS reply_state,reply.delivered_message_id,reply.card_id_checkpoint
        FROM completion_action_sets action
        LEFT JOIN outbound_replies reply ON reply.id=action.presentation_reply_id
        WHERE action.owner_kind='primary-segment' AND action.owner_id=?
        ORDER BY action.owner_generation DESC LIMIT 1`).get(input.segmentId) as ExistingReviewRow | undefined;
      if (existing) {
        const projectionKey = `completion-review:${actionSetId}:surface:1`;
        const exact = existing.id === actionSetId
          && existing.owner_generation === input.ownerGeneration
          && existing.binding_id === input.bindingId
          && existing.binding_generation === input.bindingGeneration
          && existing.page_index === input.pageIndex
          && existing.mention_open_id === input.mentionOpenId
          && existing.choice_specification_id === input.choiceSpecificationId
          && existing.presentation_kind === "fresh-card"
          && existing.presentation_generation === 1
          && existing.presentation_reply_id !== null
          && existing.idempotency_key === projectionKey
          && existing.projection_key === projectionKey
          && existing.reply_binding_id === input.bindingId
          && (input.worker
            ? existing.worker_id === input.worker.id
              && existing.worker_session_generation === input.worker.sessionGeneration
              && existing.delivery_owner_kind === "worker"
              && existing.delivery_owner_generation === input.worker.generation
              && existing.delivery_parent_id === input.bindingId
              && existing.delivery_parent_generation === input.bindingGeneration
            : existing.worker_id === null && existing.worker_session_generation === null
              && existing.delivery_owner_kind === "primary")
          && existing.root_message_id === input.rootMessageId
          && existing.kind === "card_reply"
          && existing.payload === frozenPayload;
        if (!exact) throw new Error("Completion Review immutable replay conflict");
        if (existing.reply_state === "delivered") {
          if (!existing.delivered_message_id) throw new Error("Completion Review delivered evidence is incomplete");
          this.activatePresentation({
            replyId: existing.presentation_reply_id!,
            messageId: existing.delivered_message_id,
            cardId: existing.card_id_checkpoint,
            occurredAt: new Date().toISOString()
          });
        }
        return { actionSetId, receipt: null };
      }
      suppressCompletionNotificationForFreshReview(this.context, "primary-segment", input.segmentId);
      const timestamp = new Date().toISOString();
      this.context.database.prepare(`INSERT INTO completion_action_sets(
        id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,card_id,card_message_id,
        mention_open_id,presentation_kind,presentation_generation,presentation_reply_id,presentation_message_id,presentation_card_id,
        state,selected_action,result_source_key,reason,created_at,updated_at,decided_at,
        choice_specification_id,selected_choice_option_id
      ) VALUES(?,'primary-segment',?,?,?,?,?,NULL,NULL,?,'fresh-card',1,NULL,NULL,NULL,
        'provisional',NULL,NULL,NULL,?,?,NULL,?,NULL)`).run(
        actionSetId, input.segmentId, input.ownerGeneration, input.bindingId, input.bindingGeneration,
        input.pageIndex, input.mentionOpenId, timestamp, timestamp, input.choiceSpecificationId
      );
      const projectionKey = `completion-review:${actionSetId}:surface:1`;
      const delivery: EnqueueOutboundReplyInput = {
        id: projectionKey, idempotencyKey: projectionKey,
        bindingId: input.bindingId, bindingGeneration: input.bindingGeneration,
        ...(input.worker ? { workerId: input.worker.id, workerSessionGeneration: input.worker.sessionGeneration } : {}),
        targetRole: "operation_result", rootMessageId: input.rootMessageId,
        kind: "card_reply", payload: frozenPayload,
        projectionKey, snapshotRevision: 1, viewVersion: 1,
        laneKeyOverride: projectionKey
      };
      const receipt = input.reserveDelivery.reservePreparedOutboundReply(delivery);
      const linked = this.context.database.prepare(`UPDATE completion_action_sets
        SET state='presenting',presentation_reply_id=?,updated_at=?
        WHERE id=? AND state='provisional' AND presentation_reply_id IS NULL`).run(
        receipt.result.id, timestamp, actionSetId
      );
      if (linked.changes !== 1) throw new Error("Completion Review presentation link was not reserved");
      this.context.database.prepare(`UPDATE completion_notification_obligations
        SET presentation_reply_id=?,updated_at=?
        WHERE owner_kind='primary-segment' AND owner_id=? AND owner_generation=?
          AND notice_kind='completion' AND state='suppressed' AND notification_reply_id IS NULL`).run(
        receipt.result.id, timestamp, input.segmentId, input.ownerGeneration
      );
      return { actionSetId, receipt };
    });
  }

  reservePrimaryPrompt(input: {
    promptId: string;
    ownerGeneration: number;
    bindingId: string;
    bindingGeneration: number;
    pageIndex: number;
    mentionOpenId: string;
    choiceSpecificationId: string;
    rootMessageId: string;
    card: object;
    reserveDelivery: PreparedDeliveryReservation;
  }): { actionSetId: string; receipt: PreparedDeliveryReceipt | null } {
    return this.context.transaction("sqlite.completion-review-store.write", () => {
      const actionSetId = completionReviewActionSetIdentity("primary-prompt", input.promptId, input.ownerGeneration);
      const frozenPayload = JSON.stringify(input.card);
      const existing = this.context.database.prepare(`SELECT action.id,action.owner_generation,action.binding_id,
          action.binding_generation,action.page_index,action.mention_open_id,action.presentation_kind,
          action.presentation_generation,action.presentation_reply_id,action.choice_specification_id,
          reply.idempotency_key,reply.binding_id AS reply_binding_id,reply.root_message_id,reply.kind,
          reply.payload,reply.projection_key,reply.state AS reply_state,reply.delivered_message_id,reply.card_id_checkpoint
        FROM completion_action_sets action
        LEFT JOIN outbound_replies reply ON reply.id=action.presentation_reply_id
        WHERE action.owner_kind='primary-prompt' AND action.owner_id=?
        ORDER BY action.owner_generation DESC LIMIT 1`).get(input.promptId) as ExistingReviewRow | undefined;
      if (existing) {
        const projectionKey = `completion-review:${actionSetId}:surface:1`;
        const exact = existing.id === actionSetId
          && existing.owner_generation === input.ownerGeneration
          && existing.binding_id === input.bindingId
          && existing.binding_generation === input.bindingGeneration
          && existing.page_index === input.pageIndex
          && existing.mention_open_id === input.mentionOpenId
          && existing.choice_specification_id === input.choiceSpecificationId
          && existing.presentation_kind === "fresh-card"
          && existing.presentation_generation === 1
          && existing.presentation_reply_id !== null
          && existing.idempotency_key === projectionKey
          && existing.projection_key === projectionKey
          && existing.reply_binding_id === input.bindingId
          && existing.root_message_id === input.rootMessageId
          && existing.kind === "card_reply"
          && existing.payload === frozenPayload;
        if (!exact) throw new Error("Completion Review immutable replay conflict");
        if (existing.reply_state === "delivered") {
          if (!existing.delivered_message_id) throw new Error("Completion Review delivered evidence is incomplete");
          this.activatePresentation({
            replyId: existing.presentation_reply_id!,
            messageId: existing.delivered_message_id,
            cardId: existing.card_id_checkpoint,
            occurredAt: new Date().toISOString()
          });
        }
        return { actionSetId, receipt: null };
      }
      suppressCompletionNotificationForFreshReview(this.context, "primary-prompt", input.promptId);
      const timestamp = new Date().toISOString();
      this.context.database.prepare(`INSERT INTO completion_action_sets(
        id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,card_id,card_message_id,
        mention_open_id,presentation_kind,presentation_generation,presentation_reply_id,presentation_message_id,presentation_card_id,
        state,selected_action,result_source_key,reason,created_at,updated_at,decided_at,
        choice_specification_id,selected_choice_option_id
      ) VALUES(?,'primary-prompt',?,?,?,?,?,NULL,NULL,?,'fresh-card',1,NULL,NULL,NULL,
        'provisional',NULL,NULL,NULL,?,?,NULL,?,NULL)`).run(
        actionSetId, input.promptId, input.ownerGeneration, input.bindingId, input.bindingGeneration,
        input.pageIndex, input.mentionOpenId, timestamp, timestamp, input.choiceSpecificationId
      );
      const projectionKey = `completion-review:${actionSetId}:surface:1`;
      const delivery: EnqueueOutboundReplyInput = {
        id: projectionKey, idempotencyKey: projectionKey,
        bindingId: input.bindingId, bindingGeneration: input.bindingGeneration,
        targetRole: "operation_result", rootMessageId: input.rootMessageId,
        kind: "card_reply", payload: frozenPayload,
        projectionKey, snapshotRevision: 1, viewVersion: 1,
        laneKeyOverride: projectionKey
      };
      const receipt = input.reserveDelivery.reservePreparedOutboundReply(delivery);
      const linked = this.context.database.prepare(`UPDATE completion_action_sets
        SET state='presenting',presentation_reply_id=?,updated_at=?
        WHERE id=? AND state='provisional' AND presentation_reply_id IS NULL`).run(
        receipt.result.id, timestamp, actionSetId
      );
      if (linked.changes !== 1) throw new Error("Completion Review presentation link was not reserved");
      this.context.database.prepare(`UPDATE completion_notification_obligations
        SET presentation_reply_id=?,updated_at=?
        WHERE owner_kind='primary-prompt' AND owner_id=? AND owner_generation=?
          AND notice_kind='completion' AND state='suppressed' AND notification_reply_id IS NULL`).run(
        receipt.result.id, timestamp, input.promptId, input.ownerGeneration
      );
      return { actionSetId, receipt };
    });
  }

  reserveWorker(input: {
    turnId: string;
    workerId: string;
    workerGeneration: number;
    ownerGeneration: number;
    bindingId: string;
    bindingGeneration: number;
    pageIndex: number;
    mentionOpenId: string;
    choiceSpecificationId: string;
    rootMessageId: string;
    card: object;
    reserveDelivery: PreparedDeliveryReservation;
  }): { actionSetId: string; receipt: PreparedDeliveryReceipt | null } {
    return this.context.transaction("sqlite.completion-review-store.write", () => {
      const actionSetId = completionReviewActionSetIdentity("worker-turn", input.turnId, input.ownerGeneration);
      const frozenPayload = JSON.stringify(input.card);
      const existing = this.context.database.prepare(`SELECT action.id,action.owner_generation,action.binding_id,
          action.binding_generation,action.page_index,action.mention_open_id,action.presentation_kind,
          action.presentation_generation,action.presentation_reply_id,action.choice_specification_id,
          reply.idempotency_key,reply.binding_id AS reply_binding_id,reply.worker_turn_id,reply.worker_id,reply.worker_session_generation,
          reply.delivery_owner_kind,reply.delivery_owner_generation,reply.delivery_parent_id,reply.delivery_parent_generation,
          reply.root_message_id,reply.kind,
          reply.payload,reply.projection_key,reply.state AS reply_state,reply.delivered_message_id,reply.card_id_checkpoint
        FROM completion_action_sets action
        LEFT JOIN outbound_replies reply ON reply.id=action.presentation_reply_id
        WHERE action.owner_kind='worker-turn' AND action.owner_id=?
        ORDER BY action.owner_generation DESC LIMIT 1`).get(input.turnId) as ExistingReviewRow | undefined;
      if (existing) {
        const projectionKey = `completion-review:${actionSetId}:surface:1`;
        const exact = existing.id === actionSetId
          && existing.owner_generation === input.ownerGeneration
          && existing.binding_id === input.bindingId
          && existing.binding_generation === input.bindingGeneration
          && existing.page_index === input.pageIndex
          && existing.mention_open_id === input.mentionOpenId
          && existing.choice_specification_id === input.choiceSpecificationId
          && existing.presentation_kind === "fresh-card"
          && existing.presentation_generation === 1
          && existing.presentation_reply_id !== null
          && existing.idempotency_key === projectionKey
          && existing.projection_key === projectionKey
          && existing.reply_binding_id === input.bindingId
          && existing.worker_turn_id === input.turnId
          && existing.worker_id === input.workerId
          && existing.worker_session_generation === input.ownerGeneration
          && existing.delivery_owner_kind === "worker"
          && existing.delivery_owner_generation === input.workerGeneration
          && existing.delivery_parent_id === input.bindingId
          && existing.delivery_parent_generation === input.bindingGeneration
          && existing.root_message_id === input.rootMessageId
          && existing.kind === "card_reply"
          && existing.payload === frozenPayload;
        if (!exact) throw new Error("Completion Review immutable replay conflict");
        if (existing.reply_state === "delivered") {
          if (!existing.delivered_message_id) throw new Error("Completion Review delivered evidence is incomplete");
          this.activatePresentation({ replyId: existing.presentation_reply_id!, messageId: existing.delivered_message_id,
            cardId: existing.card_id_checkpoint, occurredAt: new Date().toISOString() });
        }
        return { actionSetId, receipt: null };
      }
      suppressCompletionNotificationForFreshReview(this.context, "worker-turn", input.turnId);
      const timestamp = new Date().toISOString();
      this.context.database.prepare(`INSERT INTO completion_action_sets(
        id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,card_id,card_message_id,
        mention_open_id,presentation_kind,presentation_generation,presentation_reply_id,presentation_message_id,presentation_card_id,
        state,selected_action,result_source_key,reason,created_at,updated_at,decided_at,
        choice_specification_id,selected_choice_option_id
      ) VALUES(?,'worker-turn',?,?,?,?,?,NULL,NULL,?,'fresh-card',1,NULL,NULL,NULL,
        'provisional',NULL,NULL,NULL,?,?,NULL,?,NULL)`).run(
        actionSetId, input.turnId, input.ownerGeneration, input.bindingId, input.bindingGeneration,
        input.pageIndex, input.mentionOpenId, timestamp, timestamp, input.choiceSpecificationId
      );
      const projectionKey = `completion-review:${actionSetId}:surface:1`;
      const delivery: EnqueueOutboundReplyInput = {
        id: projectionKey, idempotencyKey: projectionKey,
        bindingId: input.bindingId, bindingGeneration: input.bindingGeneration,
        workerTurnId: input.turnId, workerId: input.workerId, workerSessionGeneration: input.ownerGeneration,
        targetRole: "operation_result", rootMessageId: input.rootMessageId,
        kind: "card_reply", payload: frozenPayload,
        projectionKey, snapshotRevision: 1, viewVersion: 1,
        laneKeyOverride: projectionKey
      };
      const receipt = input.reserveDelivery.reservePreparedOutboundReply(delivery);
      const linked = this.context.database.prepare(`UPDATE completion_action_sets
        SET state='presenting',presentation_reply_id=?,updated_at=?
        WHERE id=? AND state='provisional' AND presentation_reply_id IS NULL`).run(
        receipt.result.id, timestamp, actionSetId
      );
      if (linked.changes !== 1) throw new Error("Completion Review presentation link was not reserved");
      this.context.database.prepare(`UPDATE completion_notification_obligations
        SET presentation_reply_id=?,updated_at=?
        WHERE owner_kind='worker-turn' AND owner_id=? AND owner_generation=?
          AND notice_kind='completion' AND state='suppressed' AND notification_reply_id IS NULL`).run(
        receipt.result.id, timestamp, input.turnId, input.ownerGeneration
      );
      return { actionSetId, receipt };
    });
  }

  activatePresentation(input: { replyId: string; messageId: string; cardId: string | null; occurredAt: string }): CompletionReviewActivationOutcome {
    const row = this.context.database.prepare(`SELECT action.state,action.presentation_message_id,action.presentation_card_id,
        reply.state AS reply_state,reply.delivered_message_id,reply.card_id_checkpoint,
        EXISTS(
          SELECT 1 FROM conversation_segments segment
          JOIN bindings binding ON binding.id=segment.owner_id AND binding.generation=segment.owner_generation
          WHERE segment.id=action.owner_id AND action.owner_kind='primary-segment'
            AND segment.owner_kind='primary' AND segment.owner_id=action.binding_id
            AND segment.owner_generation=action.owner_generation
            AND action.binding_generation=segment.owner_generation
            AND segment.state='completed'
            AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
            AND binding.agent_kind=segment.agent_kind AND binding.agent_session_value=segment.session_id
        ) OR EXISTS(
          SELECT 1 FROM conversation_segments segment
          JOIN agent_instances worker ON worker.id=segment.owner_id AND worker.generation=segment.owner_generation
          JOIN worker_session_threads thread ON thread.worker_id=worker.id
            AND thread.worker_session_generation=worker.worker_session_generation AND thread.state='active'
          JOIN bindings binding ON binding.id=worker.parent_binding_id AND binding.generation=worker.parent_binding_generation
          JOIN conversation_segment_pages page ON page.segment_id=segment.id AND page.page_index=action.page_index
          WHERE segment.id=action.owner_id AND action.owner_kind='primary-segment'
            AND segment.owner_kind='worker' AND action.owner_generation=segment.owner_generation
            AND action.binding_id=worker.parent_binding_id AND action.binding_generation=worker.parent_binding_generation
            AND segment.state='completed' AND page.state IN ('active','finished')
            AND worker.role='worker' AND worker.desired_state='running' AND worker.worker_session_lifecycle='active'
            AND worker.agent_kind=segment.agent_kind AND worker.native_session_id=segment.session_id
            AND worker.parent_pane_id=binding.pane_id AND worker.parent_native_session_id=binding.agent_session_value
            AND thread.parent_binding_id=worker.parent_binding_id AND thread.parent_binding_generation=worker.parent_binding_generation
            AND thread.parent_pane_id=worker.parent_pane_id AND thread.root_message_id=segment.root_message_id
            AND reply.worker_id=worker.id AND reply.worker_session_generation=worker.worker_session_generation
            AND reply.delivery_owner_kind='worker' AND reply.delivery_owner_generation=worker.generation
            AND reply.delivery_parent_id=worker.parent_binding_id AND reply.delivery_parent_generation=worker.parent_binding_generation
            AND reply.delivery_parent_session_generation=binding.session_epoch
            AND reply.root_message_id=thread.root_message_id
            AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
        ) OR EXISTS(
          SELECT 1 FROM prompt_jobs prompt
          JOIN run_cards card ON card.prompt_id=prompt.id
          JOIN answer_pages page ON page.prompt_id=prompt.id AND page.page_index=action.page_index
          JOIN bindings binding ON binding.id=prompt.binding_id AND binding.generation=action.binding_generation
          WHERE action.owner_kind='primary-prompt' AND prompt.id=action.owner_id
            AND prompt.binding_id=action.binding_id AND prompt.state='delivered'
            AND card.binding_generation=action.binding_generation AND card.phase='completed'
            AND page.state IN ('active','finished')
            AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
            AND prompt.session_epoch=binding.session_epoch
            AND card.pane_id=binding.pane_id AND card.agent_kind=binding.agent_kind
        ) OR EXISTS(
          SELECT 1 FROM instance_turns turn
          JOIN worker_turn_cards card ON card.turn_id=turn.id
          JOIN worker_turn_card_pages page ON page.turn_id=turn.id AND page.page_index=action.page_index
          JOIN agent_instances worker ON worker.id=turn.instance_id AND worker.generation=turn.instance_generation
          JOIN bindings binding ON binding.id=action.binding_id AND binding.generation=action.binding_generation
          WHERE action.owner_kind='worker-turn' AND turn.id=action.owner_id
            AND turn.state='completed' AND card.phase='completed' AND card.instance_generation=turn.instance_generation
            AND card.worker_session_generation=action.owner_generation
            AND page.state='finished'
            AND worker.role='worker' AND worker.desired_state='running' AND worker.worker_session_lifecycle='active'
            AND worker.worker_session_generation=action.owner_generation
            AND worker.parent_binding_id=action.binding_id AND worker.parent_binding_generation=action.binding_generation
            AND worker.parent_pane_id=binding.pane_id
            AND (binding.traex_session_id IS NULL OR worker.parent_native_session_id=binding.traex_session_id)
            AND reply.worker_turn_id=turn.id AND reply.worker_id=worker.id
            AND reply.worker_session_generation=worker.worker_session_generation
            AND reply.delivery_owner_kind='worker' AND reply.delivery_owner_generation=worker.generation
            AND reply.delivery_parent_id=worker.parent_binding_id
            AND reply.delivery_parent_generation=worker.parent_binding_generation
            AND reply.delivery_parent_session_generation=binding.session_epoch
            AND reply.root_message_id=card.root_message_id
            AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
        ) AS owner_current
      FROM completion_action_sets action
      JOIN outbound_replies reply ON reply.id=action.presentation_reply_id
      WHERE action.presentation_kind='fresh-card' AND action.presentation_reply_id=?`).get(input.replyId) as ActivationRow | undefined;
    if (!row || row.reply_state !== "delivered" || row.delivered_message_id !== input.messageId
      || row.card_id_checkpoint !== input.cardId) throw new Error("Completion Review ACK identity conflict");
    if (row.presentation_message_id !== null || row.presentation_card_id !== null) {
      if (row.presentation_message_id !== input.messageId || row.presentation_card_id !== input.cardId) {
        throw new Error("Completion Review ACK identity conflict");
      }
      return row.state === "active" ? { outcome: "already_active" } : { outcome: "already_terminal" };
    }
    if (row.state === "superseded" || row.state === "unavailable") {
      const bound = this.context.database.prepare(`UPDATE completion_action_sets
        SET presentation_message_id=?,presentation_card_id=?,updated_at=?
        WHERE presentation_reply_id=? AND state=? AND presentation_message_id IS NULL AND presentation_card_id IS NULL`).run(
        input.messageId, input.cardId, input.occurredAt, input.replyId, row.state
      );
      if (bound.changes !== 1) throw new Error("Completion Review ACK identity conflict");
      return { outcome: "already_terminal" };
    }
    if (row.state !== "presenting" || row.owner_current !== 1) throw new Error("Completion Review ACK identity conflict");
    const activated = this.context.database.prepare(`UPDATE completion_action_sets
      SET state='active',presentation_message_id=?,presentation_card_id=?,updated_at=?
      WHERE presentation_reply_id=? AND presentation_kind='fresh-card' AND state='presenting'
        AND presentation_message_id IS NULL AND presentation_card_id IS NULL`).run(
      input.messageId, input.cardId, input.occurredAt, input.replyId
    );
    if (activated.changes !== 1) throw new Error("Completion Review ACK identity conflict");
    return { outcome: "activated" };
  }

  decidePrimarySegment(input: {
    actionSetId: string;
    optionId: string;
    messageId: string;
    actorOpenId: string;
    chatId: string;
    occurredAt: string;
  }): PrimarySegmentCompletionReviewDecision {
    return this.context.transaction("sqlite.completion-review-store.write", () => {
      const duplicate = this.loadConsumedDecision(input);
      if (duplicate) {
        const actor = parseActor(duplicate.actor_json);
        this.assertActor(actor, duplicate, input);
        if (input.optionId === "ignore" && duplicate.reason === "ignored") {
          return { kind: "ignored", segmentId: duplicate.owner_id, changed: false };
        }
        const submissionId = completionChoiceSubmissionIdentity(input.actionSetId, input.optionId);
        if (duplicate.selected_choice_option_id === input.optionId && duplicate.result_source_key === submissionId
          && duplicate.result_submission_id === submissionId) {
          return { kind: "submission", segmentId: duplicate.owner_id, submissionId, inserted: false };
        }
        throw new Error("Completion choice is no longer available");
      }
      const row = this.loadActiveDecision(input);
      if (!row) throw new Error("Completion choice is no longer available");
      const actor = parseActor(row.actor_json);
      this.assertActor(actor, row, input);
      if (input.optionId === "ignore") {
        const changed = this.context.database.prepare(`UPDATE completion_action_sets
          SET state='consumed',reason='ignored',decided_at=?,updated_at=?
          WHERE id=? AND presentation_kind='fresh-card' AND state='active' AND presentation_message_id=?`).run(
          input.occurredAt, input.occurredAt, input.actionSetId, input.messageId
        );
        if (changed.changes !== 1) throw new Error("Completion choice is no longer available");
        this.markSegmentChanged(row.owner_id, input.occurredAt);
        return { kind: "ignored", segmentId: row.owner_id, changed: true };
      }
      if (!row.option_message) throw new Error("Completion choice is no longer available");
      if (!row.pane_id || !row.terminal_id || !row.agent_kind || !row.agent_session_value) {
        throw new Error("Completion choice is no longer available");
      }
      const submissionId = completionChoiceSubmissionIdentity(input.actionSetId, input.optionId);
      const consumed = this.context.database.prepare(`UPDATE completion_action_sets
        SET state='consumed',selected_choice_option_id=?,result_source_key=?,decided_at=?,updated_at=?
        WHERE id=? AND presentation_kind='fresh-card' AND state='active' AND presentation_message_id=?`).run(
        input.optionId, submissionId, input.occurredAt, input.occurredAt, input.actionSetId, input.messageId
      );
      if (consumed.changes !== 1) throw new Error("Completion choice is no longer available");
      this.context.database.prepare(`INSERT INTO submission_intents(
        submission_id,ingress_source,source_message_key,actor_json,input_json,text,owner_kind,owner_id,owner_generation,
        pane_id,terminal_id,expected_agent_kind,expected_session_id,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'recorded',?,?)`).run(
        submissionId, actor.gatewayId, submissionId, JSON.stringify(actor), canonicalHumanInputJson(humanInputMessage(row.option_message, {
          actionSetId: input.actionSetId, optionId: input.optionId, sourceMessageId: input.messageId
        })), row.option_message,
        row.segment_owner_kind, row.submission_owner_id, row.submission_owner_generation,
        row.pane_id, row.terminal_id, row.agent_kind,
        row.agent_session_value, input.occurredAt, input.occurredAt
      );
      this.markSegmentChanged(row.owner_id, input.occurredAt);
      return { kind: "submission", segmentId: row.owner_id, submissionId, inserted: true };
    });
  }

  decidePrimaryPrompt(input: {
    actionSetId: string;
    optionId: string;
    messageId: string;
    actorOpenId: string;
    chatId: string;
    occurredAt: string;
  }): PrimaryPromptCompletionReviewDecision {
    return this.context.transaction("sqlite.completion-review-store.write", () => {
      const duplicate = this.loadConsumedPrimaryPromptDecision(input);
      if (duplicate) {
        this.assertPrimaryPromptActor(duplicate, input);
        if (input.optionId === "ignore" && duplicate.reason === "ignored") {
          return { kind: "ignored", promptId: duplicate.owner_id, changed: false };
        }
        const submissionId = completionChoiceSubmissionIdentity(input.actionSetId, input.optionId);
        if (duplicate.selected_choice_option_id === input.optionId && duplicate.result_source_key === submissionId
          && duplicate.result_submission_id === submissionId) {
          return { kind: "submission", promptId: duplicate.owner_id, submissionId, inserted: false };
        }
        throw new Error("Completion choice is no longer available");
      }
      const row = this.loadActivePrimaryPromptDecision(input);
      if (!row) throw new Error("Completion choice is no longer available");
      this.assertPrimaryPromptActor(row, input);
      if (input.optionId === "ignore") {
        const changed = this.context.database.prepare(`UPDATE completion_action_sets
          SET state='consumed',reason='ignored',decided_at=?,updated_at=?
          WHERE id=? AND presentation_kind='fresh-card' AND state='active' AND presentation_message_id=?`).run(
          input.occurredAt, input.occurredAt, input.actionSetId, input.messageId
        );
        if (changed.changes !== 1) throw new Error("Completion choice is no longer available");
        this.context.database.prepare("UPDATE run_cards SET view_version=view_version+1,updated_at=? WHERE prompt_id=?").run(input.occurredAt, row.owner_id);
        return { kind: "ignored", promptId: row.owner_id, changed: true };
      }
      if (!row.option_message || !row.pane_id || !row.terminal_id || !row.agent_kind || !row.agent_session_value) {
        throw new Error("Completion choice is no longer available");
      }
      const submissionId = completionChoiceSubmissionIdentity(input.actionSetId, input.optionId);
      const consumed = this.context.database.prepare(`UPDATE completion_action_sets
        SET state='consumed',selected_choice_option_id=?,result_source_key=?,decided_at=?,updated_at=?
        WHERE id=? AND presentation_kind='fresh-card' AND state='active' AND presentation_message_id=?`).run(
        input.optionId, submissionId, input.occurredAt, input.occurredAt, input.actionSetId, input.messageId
      );
      if (consumed.changes !== 1) throw new Error("Completion choice is no longer available");
      const actor: SubmissionIntentActor = {
        kind: "human", id: input.actorOpenId, chatId: input.chatId,
        topicId: row.binding_topic_id, rootMessageId: row.binding_root_message_id,
        gatewayId: row.binding_gateway_id ?? "feishu:primary"
      };
      this.context.database.prepare(`INSERT INTO submission_intents(
        submission_id,ingress_source,source_message_key,actor_json,input_json,text,owner_kind,owner_id,owner_generation,
        pane_id,terminal_id,expected_agent_kind,expected_session_id,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'primary',?,?,?,?,?,?,'recorded',?,?)`).run(
        submissionId, actor.gatewayId, submissionId, JSON.stringify(actor), canonicalHumanInputJson(humanInputMessage(row.option_message, {
          actionSetId: input.actionSetId, optionId: input.optionId, sourceMessageId: input.messageId
        })), row.option_message,
        row.binding_id, row.binding_generation, row.pane_id, row.terminal_id, row.agent_kind,
        row.agent_session_value, input.occurredAt, input.occurredAt
      );
      this.context.database.prepare("UPDATE run_cards SET view_version=view_version+1,updated_at=? WHERE prompt_id=?").run(input.occurredAt, row.owner_id);
      return { kind: "submission", promptId: row.owner_id, submissionId, inserted: true };
    });
  }

  private loadConsumedDecision(input: { actionSetId: string; messageId: string }): ConsumedDecisionRow | null {
    return this.context.database.prepare(`SELECT action.owner_id,action.reason,action.selected_choice_option_id,
        action.result_source_key,intent.ingress_source,intent.actor_json,result.submission_id AS result_submission_id
      FROM completion_action_sets action
      JOIN conversation_segments segment ON segment.id=action.owner_id
      JOIN submission_intents intent ON intent.submission_id=segment.submission_id
      LEFT JOIN submission_intents result ON result.submission_id=action.result_source_key
        AND result.source_message_key=action.result_source_key
      WHERE action.id=? AND action.owner_kind='primary-segment' AND action.presentation_kind='fresh-card'
        AND action.presentation_message_id=? AND action.state='consumed'`).get(
      input.actionSetId, input.messageId
    ) as ConsumedDecisionRow | undefined ?? null;
  }

  private loadActiveDecision(input: { actionSetId: string; optionId: string; messageId: string }): DecisionRow | null {
    return this.context.database.prepare(`SELECT action.owner_id,action.state,action.reason,action.selected_choice_option_id,
        action.result_source_key,action.binding_id,action.binding_generation,option.message AS option_message,
        segment.owner_kind AS segment_owner_kind,
        CASE WHEN segment.owner_kind='worker' THEN worker.id ELSE action.binding_id END AS submission_owner_id,
        CASE WHEN segment.owner_kind='worker' THEN worker.generation ELSE action.binding_generation END AS submission_owner_generation,
        binding.chat_id AS binding_chat_id,
        CASE WHEN segment.owner_kind='worker' THEN worker.pane_id ELSE binding.pane_id END AS pane_id,
        CASE WHEN segment.owner_kind='worker' THEN worker.native_session_id ELSE binding.traex_session_id END AS terminal_id,
        segment.agent_kind,segment.session_id AS agent_session_value,intent.ingress_source,intent.actor_json
      FROM completion_action_sets action
      JOIN conversation_segments segment ON segment.id=action.owner_id AND segment.state='completed'
      JOIN bindings binding ON binding.id=action.binding_id AND binding.generation=action.binding_generation
        AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
      LEFT JOIN agent_instances worker ON segment.owner_kind='worker' AND worker.id=segment.owner_id
      LEFT JOIN worker_session_threads thread ON thread.worker_id=worker.id
        AND thread.worker_session_generation=worker.worker_session_generation AND thread.state='active'
      JOIN submission_intents intent ON intent.submission_id=segment.submission_id
      LEFT JOIN completion_choice_options option ON option.specification_id=action.choice_specification_id
        AND option.option_id=?
      WHERE action.id=? AND action.owner_kind='primary-segment' AND action.presentation_kind='fresh-card'
        AND action.presentation_message_id=? AND action.state='active'
        AND ((segment.owner_kind='primary' AND segment.owner_id=action.binding_id
          AND segment.owner_generation=action.owner_generation
          AND binding.agent_kind=segment.agent_kind AND binding.agent_session_value=segment.session_id)
          OR (segment.owner_kind='worker' AND action.owner_generation=segment.owner_generation
            AND worker.generation=segment.owner_generation AND worker.role='worker'
            AND worker.desired_state='running' AND worker.worker_session_lifecycle='active'
            AND worker.agent_kind=segment.agent_kind AND worker.native_session_id=segment.session_id
            AND worker.parent_binding_id=action.binding_id AND worker.parent_binding_generation=action.binding_generation
            AND worker.parent_pane_id=binding.pane_id AND worker.parent_native_session_id=binding.agent_session_value
            AND thread.parent_binding_id=worker.parent_binding_id AND thread.parent_binding_generation=worker.parent_binding_generation
            AND thread.parent_pane_id=worker.parent_pane_id AND thread.root_message_id=segment.root_message_id))`).get(
      input.optionId, input.actionSetId, input.messageId
    ) as DecisionRow | undefined ?? null;
  }

  private loadConsumedPrimaryPromptDecision(input: { actionSetId: string; messageId: string }): PrimaryPromptConsumedDecisionRow | null {
    return this.context.database.prepare(`SELECT action.owner_id,action.reason,action.selected_choice_option_id,
        action.result_source_key,result.submission_id AS result_submission_id,action.mention_open_id,
        binding.chat_id AS binding_chat_id
      FROM completion_action_sets action
      JOIN prompt_jobs prompt ON prompt.id=action.owner_id AND prompt.binding_id=action.binding_id
      JOIN bindings binding ON binding.id=action.binding_id AND binding.generation=action.binding_generation
      LEFT JOIN submission_intents result ON result.submission_id=action.result_source_key
        AND result.source_message_key=action.result_source_key
      WHERE action.id=? AND action.owner_kind='primary-prompt' AND action.presentation_kind='fresh-card'
        AND action.presentation_message_id=? AND action.state='consumed'`).get(
      input.actionSetId, input.messageId
    ) as PrimaryPromptConsumedDecisionRow | undefined ?? null;
  }

  private loadActivePrimaryPromptDecision(input: { actionSetId: string; optionId: string; messageId: string }): PrimaryPromptDecisionRow | null {
    return this.context.database.prepare(`SELECT action.owner_id,action.binding_id,action.binding_generation,
        action.mention_open_id,option.message AS option_message,binding.chat_id AS binding_chat_id,
        binding.gateway_id AS binding_gateway_id,binding.topic_id AS binding_topic_id,
        binding.root_message_id AS binding_root_message_id,
        binding.pane_id,binding.traex_session_id AS terminal_id,binding.agent_kind,binding.agent_session_value
      FROM completion_action_sets action
      JOIN prompt_jobs prompt ON prompt.id=action.owner_id AND prompt.binding_id=action.binding_id
        AND prompt.state='delivered'
      JOIN run_cards card ON card.prompt_id=prompt.id AND card.binding_generation=action.binding_generation
        AND card.phase='completed'
      JOIN answer_pages page ON page.prompt_id=prompt.id AND page.page_index=action.page_index
        AND page.state IN ('active','finished')
      JOIN bindings binding ON binding.id=action.binding_id AND binding.generation=action.binding_generation
        AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
        AND prompt.session_epoch=binding.session_epoch
        AND card.pane_id=binding.pane_id AND card.agent_kind=binding.agent_kind
      LEFT JOIN completion_choice_options option ON option.specification_id=action.choice_specification_id
        AND option.option_id=?
      WHERE action.id=? AND action.owner_kind='primary-prompt' AND action.presentation_kind='fresh-card'
        AND action.presentation_message_id=? AND action.state='active'`).get(
      input.optionId, input.actionSetId, input.messageId
    ) as PrimaryPromptDecisionRow | undefined ?? null;
  }

  private assertActor(actor: SubmissionIntentActor, row: { ingress_source: string; actor_json: string; binding_chat_id?: string }, input: { actorOpenId: string; chatId: string }): void {
    if (actor.kind !== "human" || actor.id !== input.actorOpenId || actor.chatId !== input.chatId
      || actor.gatewayId !== row.ingress_source || !actor.gatewayId.startsWith("feishu:")
      || row.binding_chat_id !== undefined && row.binding_chat_id !== input.chatId) {
      throw new Error("Completion choice is no longer available");
    }
  }

  private assertPrimaryPromptActor(row: { mention_open_id: string | null; binding_chat_id: string }, input: { actorOpenId: string; chatId: string }): void {
    if (!row.mention_open_id || row.mention_open_id !== input.actorOpenId || row.binding_chat_id !== input.chatId) {
      throw new Error("Completion choice is no longer available");
    }
  }

  private markSegmentChanged(segmentId: string, occurredAt: string): void {
    this.context.database.prepare("UPDATE conversation_segments SET view_version=view_version+1,updated_at=? WHERE id=?").run(occurredAt, segmentId);
  }
}

interface DecisionRow {
  owner_id: string;
  state: string;
  reason: string | null;
  selected_choice_option_id: string | null;
  result_source_key: string | null;
  binding_id: string;
  binding_generation: number;
  segment_owner_kind: "primary" | "worker";
  submission_owner_id: string;
  submission_owner_generation: number;
  option_message: string | null;
  binding_chat_id: string;
  pane_id: string | null;
  terminal_id: string | null;
  agent_kind: "traex" | "pi" | null;
  agent_session_value: string | null;
  ingress_source: string;
  actor_json: string;
}

interface ConsumedDecisionRow {
  owner_id: string;
  reason: string | null;
  selected_choice_option_id: string | null;
  result_source_key: string | null;
  result_submission_id: string | null;
  ingress_source: string;
  actor_json: string;
}

interface PrimaryPromptDecisionRow {
  owner_id: string;
  binding_id: string;
  binding_generation: number;
  mention_open_id: string | null;
  option_message: string | null;
  binding_chat_id: string;
  binding_gateway_id: string | null;
  binding_topic_id: string | null;
  binding_root_message_id: string | null;
  pane_id: string | null;
  terminal_id: string | null;
  agent_kind: "traex" | "pi" | null;
  agent_session_value: string | null;
}

interface PrimaryPromptConsumedDecisionRow {
  owner_id: string;
  reason: string | null;
  selected_choice_option_id: string | null;
  result_source_key: string | null;
  result_submission_id: string | null;
  mention_open_id: string | null;
  binding_chat_id: string;
}

interface ExistingReviewRow {
  id: string;
  owner_generation: number;
  binding_id: string;
  binding_generation: number;
  page_index: number;
  mention_open_id: string | null;
  presentation_kind: string;
  presentation_generation: number;
  presentation_reply_id: string | null;
  choice_specification_id: string | null;
  idempotency_key: string | null;
  reply_binding_id: string | null;
  worker_turn_id: string | null;
  worker_id: string | null;
  worker_session_generation: number | null;
  delivery_owner_kind: string | null;
  delivery_owner_generation: number | null;
  delivery_parent_id: string | null;
  delivery_parent_generation: number | null;
  root_message_id: string | null;
  kind: string | null;
  payload: string | null;
  projection_key: string | null;
  reply_state: string | null;
  delivered_message_id: string | null;
  card_id_checkpoint: string | null;
}

interface ActivationRow {
  state: string;
  presentation_message_id: string | null;
  presentation_card_id: string | null;
  reply_state: string;
  delivered_message_id: string | null;
  card_id_checkpoint: string | null;
  owner_current: number;
}

function parseActor(value: string): SubmissionIntentActor {
  try {
    const actor = JSON.parse(value) as SubmissionIntentActor;
    if (!actor || typeof actor !== "object") throw new Error("invalid actor");
    return actor;
  } catch {
    throw new Error("Completion choice is no longer available");
  }
}
