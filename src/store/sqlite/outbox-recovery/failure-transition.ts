import { randomUUID } from "node:crypto";
import type { OutboundDeliveryClaim } from "../../../domain/delivery.js";
import type { DeliveryFailureMetadata, OutboundFailureTransition as OutboundFailureTransitionResult, OutboxLaneClass } from "../../../domain/types.js";
import type { SqliteContext } from "../context.js";
import type { SqliteOutboxQueueStore } from "../outbox-queue-store.js";
import { boundedOutboxError, type SqliteOutboxDeliveryStore } from "../outbox-delivery-store.js";
import type { OutboxRecoveryDependencies } from "./dependencies.js";
import { normalizedEffectCertainty, outboundLaneClass, streamContentPageIndex } from "./policies.js";

export class OutboundFailureTransitionProtocol {
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
    private readonly delivery: SqliteOutboxDeliveryStore,
    private readonly dependencies: Pick<OutboxRecoveryDependencies, "getBinding">,
  ) {}

  apply(
    id: string,
    error: string,
    metadata: DeliveryFailureMetadata,
    retryDelayMs?: number,
    claim?: OutboundDeliveryClaim,
  ): OutboundFailureTransitionResult | null {
    if (!this.queue.matchesClaim(id, claim)) return null;
    const before = this.queue.get(id);
    if (!before) return null;
    if (claim && before.state !== "pending") {
      this.queue.releaseClaim(id);
      return null;
    }
    if (before.state === "dead_letter") {
      const existing = this.context.database
        .prepare("SELECT lane_class, action FROM outbox_lane_quarantines WHERE lane_key = ? AND failed_reply_id = ?")
        .get(before.laneKey, id) as { lane_class: OutboxLaneClass; action: OutboundFailureTransitionResult["action"] } | undefined;
      if (existing) {
        return { state: before.state, action: existing.action, laneClass: existing.lane_class, promptId: before.promptId, reply: before };
      }
    }
    if (before.state !== "pending") return null;

    const staleMainCard = before.kind === "card_update" && before.targetRole === "session_status" && metadata.recoveryKind === "stale_main_card";
    const closedAnswerStream = before.cardRole === "answer" && before.kind === "stream_content" && metadata.recoveryKind === "closed_answer_stream";
    const projection = this.context.database
      .prepare("SELECT projection_key FROM outbound_replies WHERE id = ?")
      .get(id) as { projection_key: string | null } | undefined;
    const expiredViewTarget = before.cardRole === "answer" && before.kind === "card_update"
      && projection?.projection_key !== null && projection?.projection_key !== undefined
      && metadata.recoveryKind === "expired_view_target";
    const effectCertainty = normalizedEffectCertainty(metadata);
    const uncertainEffect = effectCertainty === "uncertain";
    const settledMetadata = { ...metadata, effectCertainty, ...(uncertainEffect ? { failureClass: "unknown" as const } : {}) };
    const settledError = uncertainEffect
      ? `Delivery outcome uncertain; the external effect may have completed. Inspect before manual retry: ${error}`
      : error;
    const failed = uncertainEffect || metadata.failureClass === "permanent" || staleMainCard || closedAnswerStream
      ? this.delivery.markDeadLetter(id, settledError, settledMetadata, claim)
      : this.delivery.markFailed(id, error, retryDelayMs, metadata, claim);
    if (!failed) return null;
    const laneClass = outboundLaneClass(failed);
    if (failed.state !== "dead_letter" || (settledMetadata.failureClass === "transient" && failed.autoRecoveryCount === 0)) {
      return { state: failed.state, action: "retry", laneClass, promptId: failed.promptId, reply: failed };
    }

    const timestamp = now();
    let action: OutboundFailureTransitionResult["action"] = "blocked";
    let quarantineState: "active" | "released" = "active";
    let replacementReplyId: string | null = null;
    if (!uncertainEffect && expiredViewTarget && projection?.projection_key) {
      this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed', error = 'Dismissed after Gateway rejected the expired view target', updated_at = ? WHERE projection_key = ? AND state = 'pending' AND first_claimed_at IS NULL AND claim_attempt_id IS NULL`).run(timestamp, projection.projection_key);
      action = "expired_view_target";
      quarantineState = "released";
    } else if (!uncertainEffect && closedAnswerStream && failed.promptId) {
      const pageIndex = streamContentPageIndex(failed.payload);
      if (pageIndex === null) throw new Error(`Closed Answer stream ${failed.id} has invalid page metadata`);
      this.context.database.prepare(`UPDATE answer_pages SET state = 'frozen', delivery_mode = 'static', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND card_id = ?`).run(timestamp, failed.promptId, pageIndex, failed.rootMessageId);
      this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed', error = 'Dismissed after Lark closed the Answer stream', updated_at = ? WHERE lane_key = ? AND state = 'pending' AND delivery_order > ? AND kind IN ('stream_content','stream_finish')`).run(timestamp, failed.laneKey, this.outboundDeliveryOrder(id));
      action = "rebuild_answer";
      quarantineState = "released";
    } else if (!uncertainEffect && laneClass === "answer_stream" && failed.promptId) {
      this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed', error = 'Isolated after an earlier Answer stream failure', updated_at = ? WHERE lane_key = ? AND state = 'pending' AND delivery_order > ? AND kind IN ('stream_content','stream_finish')`).run(timestamp, failed.laneKey, this.outboundDeliveryOrder(id));
    } else if (!uncertainEffect && laneClass === "main_card" && staleMainCard && failed.bindingId) {
      const replacement = this.context.database.prepare(`SELECT payload, COALESCE(view_version, 0) AS view_version FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND (id = ? OR state = 'pending') ORDER BY COALESCE(view_version, 0) DESC, delivery_order DESC LIMIT 1`).get(failed.bindingId, id) as { payload: string; view_version: number } | undefined;
      const binding = this.dependencies.getBinding(failed.bindingId);
      if (!binding) throw new Error(`Binding not found: ${failed.bindingId}`);
      if (replacement && binding.rootMessageId) {
        this.context.database.prepare(`DELETE FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND kind = 'card_update' AND state = 'pending' AND first_claimed_at IS NULL`).run(failed.bindingId);
        replacementReplyId = this.queue.enqueue({
          id: randomUUID(), idempotencyKey: `main-card:rebuild:${failed.bindingId}:${replacement.view_version}`, workClass: "history",
          bindingId: failed.bindingId, viewVersion: replacement.view_version, targetRole: "session_status", rootMessageId: binding.rootMessageId,
          kind: "card_reply", payload: replacement.payload,
        }).id;
        action = "rebuild_main";
        quarantineState = "released";
      }
    } else if (!uncertainEffect && (laneClass === "main_card" || laneClass === "replaceable_card")) {
      action = "released_newer_snapshot";
      quarantineState = "released";
    }

    this.context.database.prepare("UPDATE delivery_recoveries SET action = ?, replacement_reply_id = ?, state = ?, updated_at = ? WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')").run(action, replacementReplyId, replacementReplyId ? "replacement_pending" : "unresolved", timestamp, id);
    if (action === "expired_view_target") {
      this.context.database.prepare("UPDATE delivery_recoveries SET state = 'dismissed', resolved_at = ?, updated_at = ? WHERE failed_reply_id = ?").run(timestamp, timestamp, id);
    }
    const laneKey = failed.laneKey;
    this.context.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key, failed_reply_id, lane_class, failure_class, state, action, reason, created_at, updated_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(lane_key) DO UPDATE SET failed_reply_id = excluded.failed_reply_id, lane_class = excluded.lane_class, failure_class = excluded.failure_class, state = excluded.state, action = excluded.action, reason = excluded.reason, updated_at = excluded.updated_at, released_at = excluded.released_at`).run(laneKey, id, laneClass, metadata.failureClass, quarantineState, action, boundedOutboxError(error), timestamp, timestamp, quarantineState === "released" ? timestamp : null);
    if (quarantineState === "released") this.queue.refreshLaneHead(laneKey);
    else this.context.database.prepare("DELETE FROM outbox_lane_heads WHERE lane_key = ?").run(laneKey);
    return { state: failed.state, action, laneClass, promptId: failed.promptId, reply: failed };
  }

  private outboundDeliveryOrder(id: string): number {
    const row = this.context.database.prepare("SELECT delivery_order FROM outbound_replies WHERE id = ?").get(id) as { delivery_order: number } | undefined;
    if (!row) throw new Error(`Outbound reply not found: ${id}`);
    return Number(row.delivery_order);
  }
}

function now(): string {
  return new Date().toISOString();
}
