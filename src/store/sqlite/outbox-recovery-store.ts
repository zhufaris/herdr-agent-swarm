import type { OutboundDeliveryClaim } from "../../domain/delivery.js";
import type { DeadLetterActionOutcome, DeliveryFailureMetadata, OutboundFailureTransition, OutboundReply, StaleOutboxQuarantineRecovery } from "../../domain/types.js";
import type { SqliteContext } from "./context.js";
import type { SqliteOutboxDeliveryStore } from "./outbox-delivery-store.js";
import type { SqliteOutboxQueueStore } from "./outbox-queue-store.js";
import { AnswerStreamRecovery } from "./outbox-recovery/answer-stream.js";
import { DeadLetterAction } from "./outbox-recovery/dead-letter-action.js";
import type { OutboxRecoveryDependencies } from "./outbox-recovery/dependencies.js";
import { OutboundFailureTransitionProtocol } from "./outbox-recovery/failure-transition.js";
import { ImmutableEffectRecovery } from "./outbox-recovery/immutable-effect.js";
import { ReplaceableCardRecovery } from "./outbox-recovery/replaceable-card.js";

export class SqliteOutboxRecoveryStore {
  private readonly answerStream: AnswerStreamRecovery;
  private readonly deadLetterAction: DeadLetterAction;
  private readonly failureTransition: OutboundFailureTransitionProtocol;
  private readonly immutableEffect: ImmutableEffectRecovery;
  private readonly replaceableCard: ReplaceableCardRecovery;

  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
    delivery: SqliteOutboxDeliveryStore,
    dependencies: OutboxRecoveryDependencies,
  ) {
    this.answerStream = new AnswerStreamRecovery(context, queue, dependencies);
    this.deadLetterAction = new DeadLetterAction(context, queue);
    this.failureTransition = new OutboundFailureTransitionProtocol(context, queue, delivery, dependencies);
    this.immutableEffect = new ImmutableEffectRecovery(context, queue);
    this.replaceableCard = new ReplaceableCardRecovery(context, queue);
  }

  markOutboundReplyFailedWithQuarantine(
    id: string,
    error: string,
    metadata: DeliveryFailureMetadata,
    retryDelayMs?: number,
    claim?: OutboundDeliveryClaim,
  ): OutboundFailureTransition | null {
    return this.context.transaction(() => this.failureTransition.apply(id, error, metadata, retryDelayMs, claim));
  }

  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    return this.context.transaction(() => {
      const rows = this.context.database.prepare(`SELECT o.id FROM outbound_replies o WHERE o.state = 'dead_letter' AND o.failure_class = 'transient' AND COALESCE(o.effect_certainty, 'uncertain') != 'uncertain' AND o.auto_recovery_count = 0 AND o.dead_lettered_at IS NOT NULL AND o.dead_lettered_at <= ? AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines q WHERE q.lane_key = o.lane_key AND q.state = 'active') ORDER BY o.dead_lettered_at, o.delivery_order LIMIT ?`).all(cutoff, limit) as Array<{ id: string }>;
      const recovered: OutboundReply[] = [];
      for (const row of rows) {
        const timestamp = now();
        const updated = this.context.database.prepare(`UPDATE outbound_replies SET state = 'pending', attempt_count = 0, error = NULL, next_attempt_at = ?, auto_recovery_count = 1, updated_at = ? WHERE id = ? AND state = 'dead_letter' AND failure_class = 'transient' AND auto_recovery_count = 0 AND dead_lettered_at <= ?`).run(timestamp, timestamp, row.id, cutoff);
        if (updated.changes === 1) {
          const reply = this.queue.get(row.id);
          if (reply) recovered.push(reply);
        }
      }
      return recovered;
    });
  }

  retireUndeliveredWorkerTaskCardIntents(): number {
    return this.context.transaction(() => {
      const timestamp = now();
      const rows = this.context.database.prepare(`
        SELECT id, worker_turn_id, lane_key
        FROM outbound_replies
        WHERE worker_turn_id IS NOT NULL
          AND kind = 'stream_card_create'
          AND idempotency_key = 'worker-turn:create:' || worker_turn_id || ':0'
          AND state = 'pending'
          AND attempt_count = 0 AND first_claimed_at IS NULL
          AND delivered_message_id IS NULL
          AND card_id_checkpoint IS NULL
          AND EXISTS (
            SELECT 1 FROM instance_turns turn
            JOIN agent_instances worker ON worker.id = turn.instance_id
            WHERE turn.id = outbound_replies.worker_turn_id
              AND COALESCE(worker.worker_session_lifecycle, 'legacy') != 'active'
          )
      `).all() as Array<{ id: string; worker_turn_id: string; lane_key: string }>;
      let retired = 0;
      for (const row of rows) {
        const updated = this.context.database.prepare(`
          UPDATE outbound_replies
          SET state = 'dismissed', error = 'Retired by Worker Session single-card migration', updated_at = ?
          WHERE id = ? AND kind = 'stream_card_create'
            AND idempotency_key = 'worker-turn:create:' || worker_turn_id || ':0'
            AND state = 'pending' AND attempt_count = 0
            AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL
        `).run(timestamp, row.id);
        retired += Number(updated.changes);
        this.queue.refreshLaneHead(row.lane_key);
      }
      return retired;
    });
  }

  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery {
    return this.context.transaction(() => {
      const timestamp = now();
      const answer = this.answerStream.recover(timestamp);
      const immutable = this.immutableEffect.dismissRecoverableEffects(timestamp);
      const replaceable = this.replaceableCard.recover(timestamp);
      const terminalizedQuarantines = this.immutableEffect.terminalizeQuarantines(timestamp);
      return { ...answer, ...immutable, ...replaceable, terminalizedQuarantines };
    });
  }

  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.context.transaction(() => this.deadLetterAction.apply(id, chatId, actorOpenId, "retry"));
  }

  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.context.transaction(() => this.deadLetterAction.apply(id, chatId, actorOpenId, "dismiss"));
  }
}

function now(): string {
  return new Date().toISOString();
}
