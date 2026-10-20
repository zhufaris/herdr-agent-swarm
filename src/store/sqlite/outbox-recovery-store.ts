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
import { parseTurnCardProjectionKey } from "../../domain/turn-card-projection-key.js";
import { SqliteProjectionGapStore } from "./projection-gap-store.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import type { SqliteBindingThreadAliasStore } from "./binding-thread-alias-store.js";

const ORPHAN_RECOVERY_BATCH_LIMIT = 128;

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
    private readonly dependencies: OutboxRecoveryDependencies,
    threadAliases: SqliteBindingThreadAliasStore,
  ) {
    this.answerStream = new AnswerStreamRecovery(context, queue, dependencies);
    this.deadLetterAction = new DeadLetterAction(context, queue, dependencies.reserveCardDismissal);
    this.failureTransition = new OutboundFailureTransitionProtocol(context, queue, delivery, dependencies, threadAliases);
    this.immutableEffect = new ImmutableEffectRecovery(context, queue);
    this.replaceableCard = new ReplaceableCardRecovery(context, queue);
  }

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.answerStream.setPreparedDeliveryReservation(reservation, consumer);
    this.failureTransition.setPreparedDeliveryReservation(reservation, consumer);
    this.immutableEffect.setPreparedDeliveryReservation(reservation, consumer);
  }

  markOutboundReplyFailedWithQuarantine(
    id: string,
    error: string,
    metadata: DeliveryFailureMetadata,
    retryDelayMs?: number,
    claim?: OutboundDeliveryClaim,
  ): OutboundFailureTransition | null {
    return this.context.transaction("sqlite.outbox-recovery-store.failure-transition", () => this.failureTransition.apply(id, error, metadata, retryDelayMs, claim));
  }

  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    return this.context.transaction("sqlite.outbox-recovery-store.recover-eligible-dead-letters", () => {
      const recovered: OutboundReply[] = [];
      const rows = this.context.database.prepare(`SELECT o.id,
        CASE WHEN segment.id IS NULL THEN 0 ELSE 1 END AS turn_card
        FROM outbound_replies o
        LEFT JOIN conversation_segments segment ON o.projection_key = 'turn-card:' || segment.id || ':page:0'
        LEFT JOIN outbox_lane_quarantines q ON q.lane_key=o.lane_key AND q.state='active'
        WHERE o.state='dead_letter' AND o.dead_lettered_at IS NOT NULL AND o.dead_lettered_at <= ?
          AND o.auto_recovery_count < 1
          AND ((segment.id IS NOT NULL AND q.lane_key IS NOT NULL AND o.effect_certainty IN ('rejected','not-started') AND o.attempt_count < 5
            AND EXISTS(SELECT 1 FROM delivery_recoveries recovery WHERE recovery.failed_reply_id=o.id AND recovery.state='unresolved'))
            OR (segment.id IS NULL AND (o.projection_key IS NULL OR o.projection_key NOT LIKE 'turn-card:%') AND o.failure_class='transient' AND COALESCE(o.effect_certainty,'uncertain') != 'uncertain' AND q.lane_key IS NULL))
        ORDER BY o.dead_lettered_at, o.delivery_order, o.id LIMIT ?`).all(cutoff, limit) as Array<{ id:string; turn_card:number }>;
      for (const row of rows) {
        if (row.turn_card === 1) {
          const turn = this.recoverTurnCardDeadLetters(new Date().toISOString(), cutoff, 1, row.id);
          if (turn.length > 0) recovered.push(turn[0]!);
          continue;
        }
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
    return this.context.transaction("sqlite.outbox-recovery-store.retire-undelivered-worker-task-cards", () => {
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
        this.queue.notifyScopeMutation(row.lane_key);
      }
      return retired;
    });
  }

  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery {
    return this.context.transaction("sqlite.outbox-recovery-store.recover-stale-quarantines", () => {
      this.dismissOrphanedUncertainTurnCards(new Date().toISOString());
      const timestamp = now();
      const answer = this.answerStream.recover(timestamp);
      const immutable = this.immutableEffect.dismissRecoverableEffects(timestamp);
      const replaceable = this.replaceableCard.recover(timestamp);
      const terminalizedQuarantines = this.immutableEffect.terminalizeQuarantines(timestamp);
      this.recoverTurnCardDeadLetters(timestamp);
      return { ...answer, ...immutable, ...replaceable, terminalizedQuarantines };
    });
  }

  /** Dismiss only uncertain Turn Card updates whose durable Segment target is gone. */
  private dismissOrphanedUncertainTurnCards(timestamp: string): number {
    const rows = this.context.database.prepare(`SELECT o.id,o.lane_key,o.snapshot_revision,o.failure_class,o.http_status,o.lark_error_code,o.error,
          o.scope_kind,o.scope_workspace_id,o.scope_pane_id,segment.id AS segment_id
      FROM outbound_replies o
      LEFT JOIN conversation_segments segment ON o.projection_key = 'turn-card:' || segment.id || ':page:0'
      WHERE o.state='dead_letter' AND o.kind='card_update' AND o.projection_key LIKE 'turn-card:%'
        AND o.effect_certainty='uncertain' AND o.attempt_count < 3
        AND o.delivered_message_id IS NULL AND o.card_id_checkpoint IS NULL AND o.gateway_checkpoint_json IS NULL
        AND o.dead_lettered_at IS NOT NULL AND segment.id IS NULL
      ORDER BY o.dead_lettered_at,o.delivery_order,o.id LIMIT ?`).all(ORPHAN_RECOVERY_BATCH_LIMIT) as Array<{
          id: string; lane_key: string; snapshot_revision: number; failure_class: string | null;
          http_status: number | null; lark_error_code: string | null; error: string | null;
          scope_kind: string | null; scope_workspace_id: string | null; scope_pane_id: string | null; segment_id: string | null;
        }>;
    let retried = 0;
    for (const row of rows) {
      const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',
          error='Automatically dismissed orphaned uncertain CardKit update',updated_at=?
        WHERE id=? AND state='dead_letter' AND effect_certainty='uncertain' AND attempt_count < 3
          AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL`).run(timestamp, row.id);
      if (dismissed.changes !== 1) continue;
      this.context.database.prepare(`UPDATE delivery_recoveries SET state='dismissed',action='dismiss_orphaned_uncertain',resolved_at=?,updated_at=?
        WHERE failed_reply_id=? AND state IN ('unresolved','replacement_pending')`).run(timestamp, timestamp, row.id);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state='released',action='dismiss_orphaned_uncertain',released_at=?,updated_at=?
        WHERE failed_reply_id=? AND state='active'`).run(timestamp, timestamp, row.id);
      if (row.scope_kind === "pane" && row.scope_workspace_id && row.scope_pane_id) {
        this.advanceOrphanedPaneCheckpoint(row.scope_workspace_id, row.scope_pane_id, timestamp);
      }
      this.queue.notifyScopeMutation(row.lane_key);
      retried += 1;
    }
    return retried;
  }

  private advanceOrphanedPaneCheckpoint(workspaceId: string, paneId: string, timestamp: string): void {
    const scopeKey = JSON.stringify(["pane", workspaceId, paneId]);
    const head = this.context.database.prepare(`SELECT MIN(delivery_order) AS delivery_order
      FROM outbound_replies WHERE scope_key=? AND state IN ('pending','dead_letter')`).get(scopeKey) as { delivery_order: number | null };
    const maximum = this.context.database.prepare("SELECT MAX(delivery_order) AS delivery_order FROM outbound_replies WHERE scope_key=?").get(scopeKey) as { delivery_order: number | null };
    const nextOrder = head.delivery_order === null ? Number(maximum.delivery_order ?? 0) : Math.max(0, Number(head.delivery_order) - 1);
    this.context.database.prepare(`INSERT INTO delivery_ring_checkpoints(
        scope_key,scope_kind,scope_workspace_id,scope_pane_id,committed_delivery_order,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET committed_delivery_order=excluded.committed_delivery_order,updated_at=excluded.updated_at`).run(
      scopeKey, "pane", workspaceId, paneId, nextOrder, timestamp, timestamp
    );
  }

  private recoverTurnCardDeadLetters(timestamp: string, cutoff?: string, limit = Number.MAX_SAFE_INTEGER, replyId?: string): OutboundReply[] {
    const rows = this.context.database.prepare(`SELECT o.id,o.projection_key,o.snapshot_revision,o.lane_key,o.auto_recovery_count,o.attempt_count
      FROM outbound_replies o JOIN conversation_segments segment ON o.projection_key = 'turn-card:' || segment.id || ':page:0'
      JOIN outbox_lane_quarantines quarantine ON quarantine.lane_key=o.lane_key AND quarantine.failed_reply_id=o.id
        AND quarantine.lane_class='immutable' AND quarantine.state='active'
      JOIN delivery_recoveries recovery ON recovery.failed_reply_id=o.id AND recovery.state='unresolved'
      WHERE o.state='dead_letter'
        AND o.dead_lettered_at IS NOT NULL AND o.dead_lettered_at <= COALESCE(?, o.dead_lettered_at)
        AND o.effect_certainty IN ('rejected','not-started') AND o.auto_recovery_count < 1 AND o.attempt_count < 5
        AND (? IS NULL OR o.id = ?) ORDER BY o.dead_lettered_at,o.delivery_order LIMIT ?`).all(cutoff ?? null, replyId ?? null, replyId ?? null, Math.max(0, limit)) as Array<{ id:string; projection_key:string; snapshot_revision:number; lane_key:string; auto_recovery_count:number; attempt_count:number }>;
    const recovered: OutboundReply[] = [];
    for (const row of rows) {
      const target = parseTurnCardProjectionKey(row.projection_key);
      if (!target) continue;
      const replacement = this.dependencies.rebuildRejectedTurnCardRoot(row.id, timestamp);
      if (replacement) {
        new SqliteProjectionGapStore(this.context).open({ stage: "turn_recovery", ownerKind: "turn_card", ownerId: target.segmentId, sourceItemId: row.projection_key, failureClass: "permanent", failureCode: "turn_card_dead_letter", requiredVersion: row.snapshot_revision, occurredAt: timestamp });
        this.queue.notifyScopeMutation(row.lane_key);
        const reply = this.queue.get(replacement.replacementReplyId);
        if (reply) recovered.push(reply);
      }
    }
    return recovered;
  }

  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.context.transaction("sqlite.outbox-recovery-store.retry-dead-letter", () => this.deadLetterAction.apply(id, chatId, actorOpenId, "retry"));
  }

  dismissDeadLetter(id: string, chatId: string, actorOpenId: string, sourceMessageId?: string): DeadLetterActionOutcome {
    return this.context.transaction("sqlite.outbox-recovery-store.dismiss-dead-letter", () => this.deadLetterAction.apply(id, chatId, actorOpenId, "dismiss", sourceMessageId));
  }
}

function now(): string {
  return new Date().toISOString();
}
