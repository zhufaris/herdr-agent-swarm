import type { DeadLetterActionOutcome, OutboundReply } from "../../../domain/types.js";
import type { SqliteContext } from "../context.js";
import type { SqliteOutboxQueueStore } from "../outbox-queue-store.js";

export class DeadLetterAction {
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
  ) {}

  apply(id: string, chatId: string, actorOpenId: string, action: "retry" | "dismiss"): DeadLetterActionOutcome {
    const row = this.context.database.prepare(`SELECT o.state, COALESCE(b.chat_id, s.chat_id) AS chat_id FROM outbound_replies o LEFT JOIN bindings b ON b.id = o.binding_id LEFT JOIN project_selections s ON s.id = o.selection_id WHERE o.id = ?`).get(id) as { state: OutboundReply["state"]; chat_id: string | null } | undefined;
    let outcome: DeadLetterActionOutcome;
    if (!row) outcome = "missing";
    else if (row.chat_id !== chatId) outcome = "unauthorized";
    else if (row.state !== "dead_letter") outcome = "stale";
    else {
      const lane = this.context.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(id) as { lane_key: string } | undefined;
      const nextState = action === "retry" ? "pending" : "dismissed";
      this.context.database.prepare("UPDATE outbound_replies SET state = ?, error = NULL, failure_class = NULL, effect_certainty = CASE WHEN ? = 'pending' THEN effect_certainty ELSE NULL END, http_status = NULL, lark_error_code = NULL, attempt_count = CASE WHEN ? = 'pending' THEN 0 ELSE attempt_count END, next_attempt_at = ?, updated_at = ? WHERE id = ? AND state = 'dead_letter'").run(nextState, nextState, nextState, now(), now(), id);
      if (lane) {
        this.context.database.prepare("UPDATE outbox_lane_quarantines SET state = 'released', action = ?, released_at = ?, updated_at = ? WHERE lane_key = ? AND failed_reply_id = ? AND state = 'active'").run(action === "retry" ? "manual_retry" : "manual_dismiss", now(), now(), lane.lane_key, id);
        this.queue.refreshLaneHead(lane.lane_key);
      }
      this.context.database.prepare("UPDATE delivery_recoveries SET state = ?, action = ?, replacement_reply_id = NULL, resolved_by_reply_id = NULL, resolved_message_id = NULL, resolved_at = ?, updated_at = ? WHERE failed_reply_id = ?").run(action === "retry" ? "unresolved" : "dismissed", action === "retry" ? "manual_retry" : "manual_dismiss", action === "retry" ? null : now(), now(), id);
      outcome = action === "retry" ? "retried" : "dismissed";
    }
    this.context.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, ?, ?, ?, ?)").run(actorOpenId, `outbound.${action}`, id, outcome, now());
    return outcome;
  }
}

function now(): string {
  return new Date().toISOString();
}
