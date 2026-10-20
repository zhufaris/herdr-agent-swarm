import type { DeadLetterActionOutcome, OutboundReply } from "../../../domain/types.js";
import type { SqliteContext } from "../context.js";
import type { SqliteOutboxQueueStore } from "../outbox-queue-store.js";
import type { ReserveValidatedCardDismissalInput } from "../../../domain/ports/card-dismissal.js";
import { isDirectDeliveryRetryAllowed } from "../../../domain/delivery-replay-safety.js";

export class DeadLetterAction {
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
    private readonly reserveCardDismissal: (input: ReserveValidatedCardDismissalInput) => unknown,
  ) {}

  apply(id: string, chatId: string, actorOpenId: string, action: "retry" | "dismiss", sourceMessageId?: string): DeadLetterActionOutcome {
    const row = this.context.database.prepare(`SELECT o.state,o.gateway_id,o.kind,o.effect_certainty,o.auto_recovery_count,
      o.delivered_message_id,o.card_id_checkpoint,o.gateway_checkpoint_json,COALESCE(b.chat_id,s.chat_id) AS chat_id
      FROM outbound_replies o LEFT JOIN bindings b ON b.id=o.binding_id LEFT JOIN project_selections s ON s.id=o.selection_id WHERE o.id=?`).get(id) as {
        state:OutboundReply["state"]; gateway_id:string; kind:OutboundReply["kind"]; effect_certainty:OutboundReply["effectCertainty"];
        auto_recovery_count:number; delivered_message_id:string|null; card_id_checkpoint:string|null; gateway_checkpoint_json:string|null; chat_id:string|null;
      } | undefined;
    let outcome: DeadLetterActionOutcome;
    if (!row) outcome = "missing";
    else if (row.chat_id !== chatId) outcome = "unauthorized";
    else if (row.state !== "dead_letter") outcome = "stale";
    else if (action === "retry" && !isDirectDeliveryRetryAllowed({
      effectCertainty: row.effect_certainty,
      autoRecoveryCount: row.auto_recovery_count,
      kind: row.kind,
      deliveredMessageId: row.delivered_message_id,
      cardIdCheckpoint: row.card_id_checkpoint,
      gatewayCheckpointJson: row.gateway_checkpoint_json,
    })) outcome = "unsafe";
    else {
      const lane = this.context.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(id) as { lane_key: string } | undefined;
      const nextState = action === "retry" ? "pending" : "dismissed";
      this.context.database.prepare(`UPDATE outbound_replies SET state = ?,
        error = CASE WHEN ? = 'pending' THEN NULL ELSE error END,
        failure_class = CASE WHEN ? = 'pending' THEN NULL ELSE failure_class END,
        http_status = CASE WHEN ? = 'pending' THEN NULL ELSE http_status END,
        lark_error_code = CASE WHEN ? = 'pending' THEN NULL ELSE lark_error_code END,
        attempt_count = CASE WHEN ? = 'pending' THEN 0 ELSE attempt_count END,
        next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND state = 'dead_letter'`).run(
        nextState, nextState, nextState, nextState, nextState, nextState, now(), now(), id
      );
      if (lane) {
        this.context.database.prepare("UPDATE outbox_lane_quarantines SET state = 'released', action = ?, released_at = ?, updated_at = ? WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'").run(action === "retry" ? "manual_retry" : "manual_dismiss", now(), now(), lane.lane_key, id);
        this.queue.notifyScopeMutation(lane.lane_key);
      }
      this.context.database.prepare("UPDATE delivery_recoveries SET state = ?, action = ?, replacement_reply_id = NULL, resolved_by_reply_id = NULL, resolved_message_id = NULL, resolved_at = ?, updated_at = ? WHERE failed_reply_id = ?").run(action === "retry" ? "unresolved" : "dismissed", action === "retry" ? "manual_retry" : "manual_dismiss", action === "retry" ? null : now(), now(), id);
      outcome = action === "retry" ? "retried" : "dismissed";
      if (outcome === "dismissed" && sourceMessageId) {
        this.reserveCardDismissal({
          actionKind: "dead_letter_dismiss", semanticKey: `dead-letter:${id}`,
          actorOpenId, chatId, gatewayId: row.gateway_id, messageId: sourceMessageId
        });
      }
    }
    this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, ?, ?, ?, ?)").run(actorOpenId, `outbound.${action}`, id, outcome, now());
    return outcome;
  }
}

function now(): string {
  return new Date().toISOString();
}
