import { randomUUID } from "node:crypto";
import { ANSWER_RECOVERY_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage } from "../../../runtime/answer-stream.js";
import type { SqliteContext } from "../context.js";
import type { SqliteOutboxQueueStore } from "../outbox-queue-store.js";
import type { OutboxRecoveryDependencies } from "./dependencies.js";
import { lightweightAnswerCardPayload } from "./policies.js";
import { linkExpiredAnswerRecoverySnapshot } from "../delivery-recovery-evidence.js";
import { PRIMARY_ANSWER_EXPIRED_TARGET_PLAN_PROOF } from "./semantic-recovery-proof.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../../domain/ports/outbox.js";
import type { EnqueueOutboundReplyInput } from "../outbox-queue-store.js";
import { isReplaySafeSupersession } from "../../../domain/delivery-replay-safety.js";

export interface AnswerStreamRecoveryResult {
  retriedAnswerPromptIds: string[];
  rolledBackAnswerPromptIds: string[];
}

export class AnswerStreamRecovery {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
    private readonly dependencies: Pick<OutboxRecoveryDependencies, "getActiveAnswerPage" | "loadRunCard">,
  ) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  recover(timestamp: string): AnswerStreamRecoveryResult {
    const retriedAnswerPromptIds: string[] = [];
    const retriedAnswerPromptIdSet = new Set<string>();
    const preflightRows = this.context.database.prepare(`
      SELECT DISTINCT failed.id, failed.prompt_id, failed.binding_id, failed.lane_key,
        failed.stream_page_index, page.source_start, card.binding_generation
      FROM outbox_lane_quarantines quarantine
      JOIN outbound_replies failed ON failed.id = quarantine.failed_reply_id
      JOIN run_cards card ON card.prompt_id = failed.prompt_id AND card.binding_id = failed.binding_id
      JOIN bindings binding ON binding.id = failed.binding_id AND binding.generation = card.binding_generation
      JOIN answer_pages page ON page.prompt_id = failed.prompt_id
        AND page.page_index = failed.stream_page_index
        AND page.state = 'creating' AND page.delivery_mode = 'static'
        AND page.message_id IS NULL AND page.card_id IS NULL
        AND page.source_start = json_extract(failed.payload, '$.stream.pageStart')
        AND page.element_id = json_extract(failed.payload, '$.stream.elementId')
      JOIN answer_pages previous ON previous.prompt_id = page.prompt_id
        AND previous.page_index = page.page_index - 1
        AND previous.state = 'frozen' AND previous.delivery_mode = 'static'
        AND previous.source_start = page.source_start
      WHERE quarantine.state = 'active' AND quarantine.lane_class = 'immutable'
        AND quarantine.failure_class = 'permanent'
        AND failed.state = 'dead_letter' AND failed.kind = 'stream_card_create'
        AND failed.gateway_id = 'feishu:primary' AND failed.gateway_profile_id = 'feishu-cardkit-v1'
        AND failed.card_role = 'answer' AND failed.target_role IS NULL
        AND failed.prompt_id IS NOT NULL AND failed.binding_id IS NOT NULL
        AND failed.worker_id IS NULL AND failed.worker_turn_id IS NULL
        AND failed.stream_page_index > 0
        AND failed.idempotency_key = 'answer-static-rebuild:' || failed.prompt_id || ':' || failed.stream_page_index
        AND failed.root_message_id = binding.root_message_id
        AND json_extract(failed.payload, '$.stream.pageIndex') = failed.stream_page_index
        AND json_extract(failed.payload, '$.stream.deliveryMode') = 'static'
        AND failed.failure_class = 'permanent' AND failed.effect_certainty = 'rejected'
        AND failed.http_status IS NULL AND failed.lark_error_code IS NULL
        AND failed.gateway_plan_json IS NULL AND failed.gateway_checkpoint_json IS NULL
        AND failed.delivered_message_id IS NULL AND failed.card_id_checkpoint IS NULL
        AND failed.auto_recovery_count = 0
        AND failed.error = 'Answer continuation target mismatch for prompt ' || failed.prompt_id
        AND card.answer_page_index = previous.page_index
        AND card.answer_page_start = previous.source_start
        AND EXISTS (
          SELECT 1 FROM delivery_recoveries recovery
          JOIN outbound_replies source ON source.id = recovery.failed_reply_id
          WHERE recovery.action = 'expired_view_target'
            AND recovery.state IN ('unresolved','replacement_pending')
            AND recovery.semantic_recovery_proof = ?
            AND source.prompt_id = failed.prompt_id AND source.binding_id = failed.binding_id
            AND source.stream_page_index = previous.page_index
        )
      ORDER BY failed.delivery_order
    `).all(PRIMARY_ANSWER_EXPIRED_TARGET_PLAN_PROOF) as Array<{
      id: string; prompt_id: string; binding_id: string; lane_key: string;
      stream_page_index: number; source_start: number; binding_generation: number;
    }>;
    for (const row of preflightRows) {
      const view = this.dependencies.loadRunCard(row.prompt_id);
      if (!view || view.bindingId !== row.binding_id || view.bindingGeneration !== Number(row.binding_generation)) continue;
      const source = answerStreamContent(view);
      const rendered = renderAnswerStreamPage(source, Number(row.source_start));
      const coveredSource = source.slice(Number(row.source_start), rendered.nextPageStart ?? source.length);
      if (linkExpiredAnswerRecoverySnapshot(this.context, {
        promptId: row.prompt_id,
        generation: Number(row.binding_generation),
        previousPage: Number(row.stream_page_index) - 1,
        nextPage: Number(row.stream_page_index),
        replacementId: row.id,
        sourceStart: Number(row.source_start),
        source: coveredSource
      }) === 0) continue;
      const retried = this.context.database.prepare(`UPDATE outbound_replies
        SET state = 'pending', next_attempt_at = ?, auto_recovery_count = 1,
          claim_attempt_id = NULL, claimed_fence = NULL, claimed_owner_id = NULL, claimed_at = NULL,
          updated_at = ?
        WHERE id = ? AND state = 'dead_letter' AND auto_recovery_count = 0
          AND gateway_plan_json IS NULL AND gateway_checkpoint_json IS NULL`).run(timestamp, timestamp, row.id);
      if (retried.changes !== 1) continue;
      this.context.database.prepare(`UPDATE outbox_lane_quarantines
        SET state = 'released', action = 'startup_retry_preflight_validation', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.id);
      this.queue.notifyScopeMutation(row.lane_key);
      if (!retriedAnswerPromptIdSet.has(row.prompt_id)) { retriedAnswerPromptIdSet.add(row.prompt_id); retriedAnswerPromptIds.push(row.prompt_id); }
    }
    const answerRows = this.context.database.prepare(`
      SELECT o.id, o.prompt_id, o.lane_key
      FROM outbox_lane_quarantines q
      JOIN outbound_replies o ON o.id = q.failed_reply_id
      JOIN answer_pages p ON p.prompt_id = o.prompt_id
        AND p.page_index = json_extract(o.payload, '$.stream.pageIndex')
        AND p.state = 'creating' AND p.message_id IS NULL AND p.card_id IS NULL
      WHERE q.state = 'active' AND q.lane_class = 'immutable' AND q.failure_class = 'transient'
        AND o.state = 'dead_letter' AND o.kind = 'stream_card_create' AND o.auto_recovery_count = 1
        AND o.idempotency_key NOT LIKE 'startup-lite:%'
        AND NOT EXISTS (SELECT 1 FROM outbound_replies replacement WHERE replacement.idempotency_key = 'startup-lite:' || o.id)
      ORDER BY q.created_at, o.delivery_order
    `).all() as Array<{ id: string; prompt_id: string; lane_key: string }>;
    for (const row of answerRows) {
      const failed = this.queue.get(row.id);
      if (!failed) continue;
      const view = this.dependencies.loadRunCard(row.prompt_id);
      if (!failed.bindingId || !view || view.bindingId !== failed.bindingId
        || (this.preparedDeliveryReservation && !this.hasExactActiveBinding(view.bindingId, view.bindingGeneration))) continue;
      if (!isReplaySafeSupersession({
        effectCertainty: failed.effectCertainty,
        autoRecoveryCount: answerReplacementGeneration(failed.autoRecoveryCount),
        kind: failed.kind,
        idempotencyKey: failed.idempotencyKey,
        projectionKey: failed.projectionKey ?? null,
        reconstructible: true,
        targetFrozen: false,
        providerOperationSafe: failed.kind === "stream_card_create",
        ownerCurrent: true,
        hasExternalEffectEvidence: failed.deliveredMessageId !== null || failed.cardIdCheckpoint !== null
          || failed.gatewayCheckpointJson !== null,
      })) continue;
      const replacement = this.reservePrimary({
        id: randomUUID(), idempotencyKey: `startup-lite:${row.id}`, workClass: "history", bindingId: failed.bindingId, promptId: failed.promptId,
        bindingGeneration: view.bindingGeneration, viewVersion: failed.viewVersion, cardRole: failed.cardRole, rootMessageId: failed.rootMessageId, kind: "stream_card_create",
        payload: lightweightAnswerCardPayload(failed.payload), streamPageIndex: failed.streamPageIndex
      });
      this.context.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 2, updated_at = ? WHERE id = ? AND state = 'pending'").run(timestamp, replacement.id);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_rebuild', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.id);
      this.queue.notifyScopeMutation(row.lane_key);
      if (!retriedAnswerPromptIdSet.has(row.prompt_id)) { retriedAnswerPromptIdSet.add(row.prompt_id); retriedAnswerPromptIds.push(row.prompt_id); }
    }
    const invalidRebuildRows = this.context.database.prepare(`
      SELECT rebuild.id, rebuild.prompt_id, rebuild.lane_key, current.page_index AS current_page_index, next.page_index AS next_page_index
      FROM outbox_lane_quarantines q
      JOIN outbound_replies rebuild ON rebuild.id = q.failed_reply_id
      JOIN answer_pages next ON next.prompt_id = rebuild.prompt_id
        AND next.page_index = json_extract(rebuild.payload, '$.stream.pageIndex')
        AND next.state = 'creating' AND next.message_id IS NULL AND next.card_id IS NULL
      JOIN answer_pages current ON current.prompt_id = next.prompt_id
        AND current.page_index = next.page_index - 1
        AND current.state = 'frozen' AND current.message_id IS NOT NULL AND current.card_id IS NOT NULL
        AND current.source_start = next.source_start
      JOIN run_cards card ON card.prompt_id = current.prompt_id AND card.answer_page_index = current.page_index
      WHERE q.state = 'active' AND q.lane_class = 'immutable'
        AND q.failure_class = 'permanent'
        AND rebuild.state = 'dead_letter' AND rebuild.kind = 'stream_card_create'
        AND rebuild.idempotency_key = 'stream-rebuild:' || rebuild.prompt_id || ':' || next.page_index
        AND json_extract(rebuild.payload, '$.stream.pageStart') = next.source_start
        AND json_extract(rebuild.payload, '$.stream.elementId') = next.element_id
        AND EXISTS (
          SELECT 1 FROM outbound_replies content
          WHERE content.prompt_id = current.prompt_id AND content.card_role = 'answer'
            AND content.kind = 'stream_content' AND content.state = 'dead_letter'
            AND json_extract(content.payload, '$.pageIndex') = current.page_index
            AND json_extract(content.payload, '$.elementId') = current.element_id
        )
      ORDER BY q.created_at, rebuild.delivery_order
    `).all() as Array<{ id: string; prompt_id: string; lane_key: string; current_page_index: number; next_page_index: number }>;
    const rolledBackAnswerPromptIds: string[] = [];
    const rolledBackAnswerPromptIdSet = new Set<string>();
    for (const row of invalidRebuildRows) {
      const removed = this.context.database.prepare(`DELETE FROM answer_pages
        WHERE prompt_id = ? AND page_index = ? AND state = 'creating' AND message_id IS NULL AND card_id IS NULL`).run(row.prompt_id, row.next_page_index);
      if (removed.changes !== 1) continue;
      const restored = this.context.database.prepare(`UPDATE answer_pages SET state = 'active', updated_at = ?
        WHERE prompt_id = ? AND page_index = ? AND state = 'frozen'`).run(timestamp, row.prompt_id, row.current_page_index);
      if (restored.changes !== 1) throw new Error(`Failed to restore Answer page ${row.prompt_id}:${row.current_page_index}`);
      this.context.database.prepare("UPDATE outbound_replies SET state = 'dismissed', updated_at = ? WHERE id = ? AND state = 'dead_letter'").run(timestamp, row.id);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_rollback', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, row.lane_key, row.id);
      this.queue.notifyScopeMutation(row.lane_key);
      if (!rolledBackAnswerPromptIdSet.has(row.prompt_id)) { rolledBackAnswerPromptIdSet.add(row.prompt_id); rolledBackAnswerPromptIds.push(row.prompt_id); }
    }
    const failedContentRows = this.context.database.prepare(`
      SELECT content.id, content.prompt_id, content.lane_key
      FROM outbound_replies content
      JOIN answer_pages page ON page.prompt_id = content.prompt_id
        AND page.page_index = json_extract(content.payload, '$.pageIndex')
        AND page.element_id = json_extract(content.payload, '$.elementId')
        AND page.state = 'active' AND page.card_id = content.root_message_id
      WHERE content.card_role = 'answer' AND content.kind = 'stream_content' AND content.state = 'dead_letter'
        AND content.failure_class = 'transient' AND content.auto_recovery_count = 1
        AND NOT EXISTS (SELECT 1 FROM outbound_replies replacement WHERE replacement.idempotency_key = 'startup-lite-content:' || content.id)
        AND (
          EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.failed_reply_id = content.id AND q.state = 'active' AND q.lane_class = 'answer_stream')
          OR EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.state = 'released' AND q.action = 'startup_rollback'
            AND q.failed_reply_id IN (SELECT rebuild.id FROM outbound_replies rebuild WHERE rebuild.prompt_id = content.prompt_id))
        )
      ORDER BY content.delivery_order
    `).all() as Array<{ id: string; prompt_id: string; lane_key: string }>;
    for (const failedContent of failedContentRows) {
      const promptId = failedContent.prompt_id;
      const page = this.dependencies.getActiveAnswerPage(promptId);
      const view = this.dependencies.loadRunCard(promptId);
      const failed = this.queue.get(failedContent.id);
      if (!page?.cardId || !view
        || !failed
        || (this.preparedDeliveryReservation && !this.hasExactActiveBinding(view.bindingId, view.bindingGeneration))
        || (view.phase !== "completed" && view.phase !== "failed")) continue;
      if (!isReplaySafeSupersession({
        effectCertainty: failed.effectCertainty,
        autoRecoveryCount: answerReplacementGeneration(failed.autoRecoveryCount),
        kind: failed.kind,
        idempotencyKey: failed.idempotencyKey,
        projectionKey: failed.projectionKey ?? null,
        reconstructible: true,
        targetFrozen: false,
        providerOperationSafe: failed.kind === "stream_content",
        ownerCurrent: true,
        hasExternalEffectEvidence: failed.deliveredMessageId !== null || failed.cardIdCheckpoint !== null
          || failed.gatewayCheckpointJson !== null,
      })) continue;
      const rendered = renderAnswerStreamPage(answerStreamContent(view), page.sourceStart, ANSWER_RECOVERY_PAGE_LIMIT);
      if (!rendered.page) continue;
      const sequence = page.sequence + 1;
      const sourceEnd = rendered.nextPageStart ?? answerStreamContent(view).length;
      this.context.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active'")
        .run(sequence, timestamp, promptId, page.pageIndex);
      this.context.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?")
        .run(sequence, timestamp, promptId, page.pageIndex);
      const replacement = this.reservePrimary({
        id: randomUUID(), idempotencyKey: `startup-lite-content:${failedContent.id}`, workClass: "history", bindingId: view.bindingId, bindingGeneration: view.bindingGeneration,
        promptId, viewVersion: sequence, cardSequence: sequence, cardRole: "answer", rootMessageId: page.cardId, kind: "stream_content",
        payload: JSON.stringify({ pageIndex: page.pageIndex, elementId: page.elementId, content: rendered.page, sequence, sourceEnd }), streamPageIndex: page.pageIndex
      });
      this.context.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 2, updated_at = ? WHERE id = ? AND state = 'pending'").run(timestamp, replacement.id);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state = 'released', action = 'startup_rebuild', released_at = ?, updated_at = ?
        WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, failedContent.lane_key, failedContent.id);
      this.queue.notifyScopeMutation(failedContent.lane_key);
      if (!retriedAnswerPromptIdSet.has(promptId)) { retriedAnswerPromptIdSet.add(promptId); retriedAnswerPromptIds.push(promptId); }
    }
    return { retriedAnswerPromptIds, rolledBackAnswerPromptIds };
  }

  private reservePrimary(input: EnqueueOutboundReplyInput & { bindingGeneration: number }) {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Answer Stream Recovery prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

  private hasExactActiveBinding(bindingId: string, bindingGeneration: number): boolean {
    return this.context.database.prepare(`SELECT 1 FROM bindings
      WHERE id=? AND generation=? AND state='active' AND lifecycle='active' AND attachment='attached'`
    ).get(bindingId, bindingGeneration) !== undefined;
  }
}

// Answer recovery count 1 is the cooled same-Delivery retry; count 2 records
// that the one automatic replacement generation has already been consumed.
function answerReplacementGeneration(autoRecoveryCount: number): number {
  return Math.max(0, autoRecoveryCount - 1);
}
