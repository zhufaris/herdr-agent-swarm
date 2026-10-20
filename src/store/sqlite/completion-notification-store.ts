import type { SqliteContext } from "./context.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import { parseTurnCardProjectionKey } from "../../domain/turn-card-projection-key.js";
import { coreEventDiscriminatorSql } from "./core-event-discriminators.js";
import type { SegmentCompletionNotificationRecoveryResult } from "../../domain/ports/conversation-segment.js";
import { removeDependentDeliveryPrerequisites } from "./delivery-prerequisites.js";

type CompletionOwnerKind = "primary-prompt" | "worker-turn" | "primary-segment";

interface DeliveredComponentReply {
  id?: string;
  idempotencyKey?: string;
  kind: string;
  payload: string;
  promptId: string | null;
  workerTurnId: string | null;
  rootMessageId: string | null;
  projectionKey?: string | null;
}

interface CompletionNotificationRow {
  id: string;
  owner_kind: CompletionOwnerKind;
  owner_id: string;
  owner_generation: number;
  binding_id: string;
  binding_generation: number;
  card_message_id: string;
  mention_open_id: string;
  action_state: string;
  obligation_state: string;
  notification_reply_id: string | null;
  has_human_review: number;
}

export interface CompletionNotificationPreparedDelivery {
  reservation: PreparedDeliveryReservation;
  consumer: PreparedDeliveryConsumer;
}

export function releaseCompletionNotificationForDeliveredReply(
  context: SqliteContext,
  reply: DeliveredComponentReply,
  preparedDelivery?: CompletionNotificationPreparedDelivery
): boolean {
  if (reply.kind !== "card_update" || !reply.rootMessageId) return false;
  const owner = reply.promptId
    ? { kind: "primary-prompt" as const, id: reply.promptId }
    : reply.workerTurnId ? { kind: "worker-turn" as const, id: reply.workerTurnId } : null;
  if (!owner) {
    const target = reply.projectionKey ? parseTurnCardProjectionKey(reply.projectionKey) : null;
    return Boolean(reply.id && target
      && releaseSegment(context, target.segmentId, target.pageIndex, reply.id, preparedDelivery).outcome === "released");
  }
  return release(context, owner.kind, owner.id, reply, preparedDelivery);
}

export function recoverPrimarySegmentCompletionNotification(
  context: SqliteContext,
  segmentId: string,
  preparedDelivery?: CompletionNotificationPreparedDelivery
): SegmentCompletionNotificationRecoveryResult {
  const obligation = context.database.prepare(`SELECT obligation.state,obligation.notification_reply_id,
      obligation.presentation_reply_id,reply.id AS reply_id,reply.state AS reply_state,reply.projection_key
    FROM completion_notification_obligations obligation
    LEFT JOIN outbound_reply_prerequisites prerequisite
      ON prerequisite.dependent_reply_id=obligation.notification_reply_id AND prerequisite.required_state='delivered'
    LEFT JOIN outbound_replies reply ON reply.id=COALESCE(prerequisite.prerequisite_reply_id,obligation.presentation_reply_id)
    WHERE obligation.owner_kind='primary-segment' AND obligation.owner_id=?
      AND obligation.notice_kind='completion'`).get(segmentId) as {
        state: string; notification_reply_id: string | null; presentation_reply_id: string | null; reply_id: string | null;
        reply_state: string | null; projection_key: string | null;
      } | undefined;
  if (!obligation) return { outcome: "not_ready", reason: "missing_obligation" };
  if (obligation.state === "released" && obligation.notification_reply_id) return { outcome: "already_converged", notificationReplyId: obligation.notification_reply_id };
  if (obligation.state !== "waiting_for_answer") return { outcome: "not_ready", reason: "obligation_not_waiting" };
  if (!obligation.reply_id) return { outcome: "not_ready", reason: "missing_presentation_reply" };
  if (obligation.reply_state !== "delivered") return { outcome: "not_ready", reason: "presentation_not_delivered" };
  const target = obligation.projection_key ? parseTurnCardProjectionKey(obligation.projection_key) : null;
  if (!target || target.segmentId !== segmentId) return { outcome: "not_ready", reason: "invalid_presentation_identity" };
  return releaseSegment(context, segmentId, target.pageIndex, obligation.reply_id, preparedDelivery);
}

export function recoverCompletionNotification(
  context: SqliteContext,
  ownerKind: CompletionOwnerKind,
  ownerId: string,
  preparedDelivery?: CompletionNotificationPreparedDelivery
): boolean {
  const action = loadNotification(context, ownerKind, ownerId);
  if (!action || action.notification_reply_id && action.has_human_review !== 1) return false;
  const delivered = context.database.prepare(`SELECT kind, payload, prompt_id, worker_turn_id, root_message_id
    FROM outbound_replies
    WHERE state = 'delivered' AND kind = 'card_update' AND root_message_id = ?
      AND ((? = 'primary-prompt' AND prompt_id = ?) OR (? = 'worker-turn' AND worker_turn_id = ?))
    ORDER BY delivery_order DESC`).all(
      action.card_message_id, ownerKind, ownerId, ownerKind, ownerId
    ) as Array<{ kind: string; payload: string; prompt_id: string | null; worker_turn_id: string | null; root_message_id: string | null }>;
  for (const row of delivered) {
    const reply = { kind: row.kind, payload: row.payload, promptId: row.prompt_id, workerTurnId: row.worker_turn_id, rootMessageId: row.root_message_id };
    if (payloadContainsActionSet(reply.payload, action.id)) return release(context, ownerKind, ownerId, reply, preparedDelivery);
  }
  return false;
}

export function dismissPendingCompletionNotification(
  context: SqliteContext,
  ownerKind: CompletionOwnerKind,
  ownerId: string
): boolean {
  return context.transaction("sqlite.completion-notification-store.write", () => {
    const obligation = loadObligation(context, ownerKind, ownerId);
    return obligation ? suppressObligation(context, ownerKind, ownerId, obligation) : false;
  });
}

/**
 * A fresh Completion Review replaces only a notification that has no possible
 * external effect.  The caller is already inside the Action Set reservation
 * transaction, so this shares its atomic boundary with the new presentation.
 */
export function suppressCompletionNotificationForFreshReview(
  context: SqliteContext,
  ownerKind: CompletionOwnerKind,
  ownerId: string
): void {
  const obligation = loadObligation(context, ownerKind, ownerId);
  if (!obligation) return;
  if (obligation.state === "suppressed" && obligation.notification_reply_id === null) return;
  if (!suppressObligation(context, ownerKind, ownerId, obligation)) {
    throw new Error("Completion Review cannot replace a notification with possible external effect");
  }
}

export function suppressPrimarySegmentInlineCompletionNotification(
  context: SqliteContext,
  input: { segmentId: string; presentationReplyId: string; rootMessageId: string },
): boolean {
  return context.transaction("sqlite.completion-notification-store.write", () => {
    const action = context.database.prepare(`SELECT action.id,action.owner_generation,action.card_message_id,
        obligation.notification_reply_id,obligation.state
      FROM completion_action_sets action
      JOIN completion_choice_specifications choice
        ON choice.id=action.choice_specification_id AND choice.owner_kind=action.owner_kind
          AND choice.owner_id=action.owner_id AND choice.owner_generation=action.owner_generation
      JOIN completion_notification_obligations obligation
        ON obligation.owner_kind=action.owner_kind AND obligation.owner_id=action.owner_id
          AND obligation.owner_generation=action.owner_generation
      WHERE action.owner_kind='primary-segment' AND action.owner_id=?
        AND action.state='available' AND action.card_message_id=?`).get(
          input.segmentId, input.rootMessageId
        ) as { id: string; owner_generation: number; card_message_id: string; notification_reply_id: string | null; state: string } | undefined;
    if (!action) return false;
    const presentation = context.database.prepare(`SELECT kind,root_message_id,payload
      FROM outbound_replies WHERE id=?`).get(input.presentationReplyId) as {
        kind: string; root_message_id: string | null; payload: string;
      } | undefined;
    if (!presentation || presentation.kind !== "card_update" || presentation.root_message_id !== action.card_message_id
      || !payloadContainsActionSet(presentation.payload, action.id)) return false;
    return suppressObligation(context, "primary-segment", input.segmentId, {
      owner_generation: action.owner_generation,
      notification_reply_id: action.notification_reply_id,
      state: action.state
    });
  });
}

function release(
  context: SqliteContext,
  ownerKind: CompletionOwnerKind,
  ownerId: string,
  reply: DeliveredComponentReply,
  preparedDelivery?: CompletionNotificationPreparedDelivery
): boolean {
  const action = loadNotification(context, ownerKind, ownerId);
  if (!action || action.action_state !== "available"
    || !["waiting_for_answer", "released"].includes(action.obligation_state)
    || action.card_message_id !== reply.rootMessageId
    || !payloadContainsActionSet(reply.payload, action.id)) return false;
  if (!currentOwnerIdentity(context, action)) {
    const timestamp = now();
    context.database.prepare(`UPDATE completion_action_sets SET state = 'superseded', reason = 'stale-owner', decided_at = COALESCE(decided_at, ?), updated_at = ?
      WHERE id = ? AND state = 'available'`).run(timestamp, timestamp, action.id);
    context.database.prepare(`UPDATE completion_notification_obligations SET state = 'suppressed', released_at = NULL, updated_at = ?
      WHERE owner_kind = ? AND owner_id = ? AND owner_generation = ? AND notification_reply_id IS NULL`).run(
        timestamp, action.owner_kind, action.owner_id, action.owner_generation
      );
    return false;
  }
  if (action.has_human_review === 1) {
    return suppressObligation(context, ownerKind, ownerId, {
      owner_generation: action.owner_generation,
      notification_reply_id: action.notification_reply_id,
      state: action.obligation_state
    });
  }
  if (action.notification_reply_id) return false;
  const key = action.owner_kind === "primary-prompt"
    ? `primary-next-input:${action.binding_id}:${action.binding_generation}:${action.owner_id}`
    : `worker-next-input:${workerId(context, action.owner_id)!}:${action.owner_generation}:${action.owner_id}`;
  const ownerWorkerId = action.owner_kind === "worker-turn" ? workerId(context, action.owner_id) : null;
  if (action.owner_kind === "worker-turn" && !ownerWorkerId) return false;
  const outbound: EnqueueOutboundReplyInput = {
    id: key,
    idempotencyKey: key,
    bindingId: action.binding_id,
    bindingGeneration: action.binding_generation,
    ...(ownerWorkerId ? {
      workerTurnId: action.owner_id,
      workerId: ownerWorkerId,
      workerSessionGeneration: action.owner_generation,
      projectionKey: `worker-completion-notification:${action.owner_id}`,
      snapshotRevision: action.owner_generation,
    } : {}),
    targetRole: "operation_result",
    rootMessageId: action.card_message_id,
    kind: "text",
    payload: `<at user_id="${action.mention_open_id}">用户</at> 需要你的选择，请查看上方 Answer 卡。`
  };
  if (!preparedDelivery) throw new Error("Completion Notification prepared delivery is not connected");
  handoffAfterCommit(preparedDelivery.reservation.reservePreparedOutboundReply(outbound), preparedDelivery.consumer);
  const timestamp = now();
  return context.database.prepare(`UPDATE completion_notification_obligations SET state = 'released', notification_reply_id = ?, released_at = ?, updated_at = ?
    WHERE owner_kind = ? AND owner_id = ? AND owner_generation = ? AND notification_reply_id IS NULL
      AND state IN ('waiting_for_answer','released')`).run(
        key, timestamp, timestamp, action.owner_kind, action.owner_id, action.owner_generation
      ).changes === 1;
}

function releaseSegment(
  context: SqliteContext,
  segmentId: string,
  pageIndex: number,
  replyId: string,
  preparedDelivery?: CompletionNotificationPreparedDelivery
): SegmentCompletionNotificationRecoveryResult {
  const reply = context.database.prepare(`SELECT id,idempotency_key,kind,payload,root_message_id,state,projection_key
    FROM outbound_replies WHERE id=?`).get(replyId) as {
      id: string; idempotency_key: string; kind: string; payload: string; root_message_id: string | null;
      state: string; projection_key: string | null;
    } | undefined;
  if (!reply || reply.state !== "delivered") return { outcome: "not_ready", reason: "presentation_not_delivered" };
  const target = reply.projection_key ? parseTurnCardProjectionKey(reply.projection_key) : null;
  if (reply.kind !== "card_update" || !reply.root_message_id || !target
    || target.segmentId !== segmentId || target.pageIndex !== pageIndex) {
    return { outcome: "not_ready", reason: "invalid_presentation_identity" };
  }
  const finalEventId = completionFinalEventId(reply.idempotency_key);
  if (!finalEventId) return { outcome: "not_ready", reason: "final_event_mismatch" };
  const eventType = coreEventDiscriminatorSql(context.database, "final_inbox", "event_type");
  const channel = coreEventDiscriminatorSql(context.database, "final_inbox", "channel");
  const notice = context.database.prepare(`SELECT obligation.owner_generation,obligation.binding_id,
      obligation.binding_generation,obligation.required_view_version,obligation.mention_open_id,
      obligation.state,obligation.notification_reply_id,obligation.presentation_reply_id,
      segment.state AS segment_state,page.state AS page_state,page.message_id,
      EXISTS(SELECT 1 FROM core_event_lane_items final_lane
        JOIN core_event_inbox final_inbox ON final_inbox.event_id=final_lane.event_id
        JOIN core_event_inbox human_inbox ON human_inbox.event_id=segment.human_event_id
        WHERE final_inbox.event_id=? AND final_lane.lane_id=substr(segment.producer_key,6)
          AND final_inbox.turn_id=human_inbox.turn_id AND ${eventType}='message' AND ${channel}='final'
      ) AS final_event_matches
    FROM completion_notification_obligations obligation
    JOIN conversation_segments segment ON segment.id=obligation.owner_id
      AND segment.owner_generation=obligation.owner_generation
    JOIN conversation_segment_pages page ON page.segment_id=segment.id AND page.page_index=?
    WHERE obligation.owner_kind='primary-segment' AND obligation.owner_id=?
      AND obligation.notice_kind='completion'`).get(finalEventId, pageIndex, segmentId) as {
        owner_generation: number; binding_id: string; binding_generation: number; required_view_version: number;
        mention_open_id: string | null; state: string; notification_reply_id: string | null;
        presentation_reply_id: string | null; segment_state: string; page_state: string;
        message_id: string | null;
        final_event_matches: number;
      } | undefined;
  if (!notice) return { outcome: "not_ready", reason: "missing_obligation" };
  if (notice.state === "released" && notice.notification_reply_id) {
    return { outcome: "already_converged", notificationReplyId: notice.notification_reply_id };
  }
  if (notice.state !== "waiting_for_answer") return { outcome: "not_ready", reason: "obligation_not_waiting" };
  if (!notice.mention_open_id) return { outcome: "not_ready", reason: "missing_mention_target" };
  const exactPrerequisite = notice.notification_reply_id && context.database.prepare(`SELECT 1
    FROM outbound_reply_prerequisites
    WHERE dependent_reply_id=? AND prerequisite_reply_id=? AND required_state='delivered'`).get(
      notice.notification_reply_id, reply.id
    );
  if (!exactPrerequisite && notice.presentation_reply_id !== reply.id) return { outcome: "not_ready", reason: "invalid_presentation_identity" };
  if (notice.final_event_matches !== 1) return { outcome: "not_ready", reason: "final_event_mismatch" };
  if (notice.segment_state !== "completed") return { outcome: "not_ready", reason: "segment_not_completed" };
  if (notice.page_state !== "finished") return { outcome: "not_ready", reason: "page_not_finished" };
  if (notice.message_id !== reply.root_message_id) return { outcome: "not_ready", reason: "message_mismatch" };
  if (!payloadContainsMention(reply.payload, notice.mention_open_id)) {
    return { outcome: "not_ready", reason: "mention_payload_mismatch" };
  }
  const binding = context.database.prepare(`SELECT generation,state,lifecycle,attachment
    FROM bindings WHERE id=?`).get(notice.binding_id) as {
      generation: number; state: string; lifecycle: string; attachment: string;
    } | undefined;
  if (!binding || binding.generation !== notice.binding_generation || binding.state !== "active"
    || binding.lifecycle !== "active" || binding.attachment !== "attached") {
    return { outcome: "not_ready", reason: "stale_binding" };
  }
  if (suppressObligation(context, "primary-segment", segmentId, {
    owner_generation: notice.owner_generation,
    notification_reply_id: notice.notification_reply_id,
    state: notice.state
  })) {
    return { outcome: "not_ready", reason: "obligation_not_waiting" };
  }
  const key = `primary-segment-completion:${notice.binding_id}:${notice.binding_generation}:${segmentId}:${finalEventId}`;
  if (!notice.notification_reply_id) return { outcome: "not_ready", reason: "missing_presentation_reply" };
  const timestamp = now();
  const changed = context.database.prepare(`UPDATE completion_notification_obligations
    SET state='released',notification_reply_id=?,released_at=?,updated_at=?
    WHERE owner_kind='primary-segment' AND owner_id=? AND owner_generation=?
      AND state='waiting_for_answer' AND notification_reply_id=?
      AND (presentation_reply_id=? OR EXISTS(
        SELECT 1 FROM outbound_reply_prerequisites prerequisite
        WHERE prerequisite.dependent_reply_id=completion_notification_obligations.notification_reply_id
          AND prerequisite.prerequisite_reply_id=? AND prerequisite.required_state='delivered'
      ))`).run(
        notice.notification_reply_id, timestamp, timestamp, segmentId, notice.owner_generation,
        notice.notification_reply_id, reply.id, reply.id
      ).changes;
  if (changed === 1) return { outcome: "released", notificationReplyId: key };
  const current = context.database.prepare(`SELECT notification_reply_id FROM completion_notification_obligations
    WHERE owner_kind='primary-segment' AND owner_id=? AND owner_generation=?`).get(
      segmentId, notice.owner_generation
    ) as { notification_reply_id: string | null } | undefined;
  return current?.notification_reply_id
    ? { outcome: "already_converged", notificationReplyId: current.notification_reply_id }
    : { outcome: "not_ready", reason: "obligation_not_waiting" };
}

function completionFinalEventId(idempotencyKey: string | undefined): string | null {
  if (!idempotencyKey) return null;
  const marker = ":final:";
  const index = idempotencyKey.lastIndexOf(marker);
  if (index < 0 || index + marker.length === idempotencyKey.length) return null;
  const encoded = idempotencyKey.slice(index + marker.length);
  try {
    const eventId = decodeURIComponent(encoded);
    return eventId && encodeURIComponent(eventId) === encoded ? eventId : null;
  } catch {
    return null;
  }
}

function payloadContainsMention(payload: string, mentionOpenId: string): boolean {
  try { return JSON.stringify(JSON.parse(payload)).includes(`<at id=${mentionOpenId}></at>`); } catch { return false; }
}

function handoffAfterCommit(receipt: PreparedDeliveryReceipt, consumer: PreparedDeliveryConsumer): void {
  queueMicrotask(() => { for (const delivery of receipt.consumeEffects()) consumer.enqueuePreparedDelivery(delivery); });
}

function loadNotification(context: SqliteContext, ownerKind: CompletionOwnerKind, ownerId: string): CompletionNotificationRow | null {
  return context.database.prepare(`SELECT action.id, action.owner_kind, action.owner_id, action.owner_generation,
      action.binding_id, action.binding_generation, action.card_message_id, action.mention_open_id,
      action.state AS action_state, obligation.state AS obligation_state, obligation.notification_reply_id,
      EXISTS(SELECT 1 FROM completion_choice_specifications choice
        WHERE choice.id=action.choice_specification_id AND choice.owner_kind=action.owner_kind
          AND choice.owner_id=action.owner_id AND choice.owner_generation=action.owner_generation) AS has_human_review
    FROM completion_action_sets action
    JOIN completion_notification_obligations obligation
      ON obligation.owner_kind = action.owner_kind AND obligation.owner_id = action.owner_id
        AND obligation.owner_generation = action.owner_generation
    WHERE action.owner_kind = ? AND action.owner_id = ? AND action.mention_open_id IS NOT NULL`).get(
      ownerKind, ownerId
    ) as CompletionNotificationRow | undefined ?? null;
}

interface CompletionObligationReference {
  owner_generation: number;
  notification_reply_id: string | null;
  state: string;
}

function loadObligation(
  context: SqliteContext,
  ownerKind: CompletionOwnerKind,
  ownerId: string,
): CompletionObligationReference | null {
  return context.database.prepare(`SELECT owner_generation,notification_reply_id,state
    FROM completion_notification_obligations WHERE owner_kind=? AND owner_id=?`).get(
      ownerKind, ownerId
    ) as CompletionObligationReference | undefined ?? null;
}

function suppressObligation(
  context: SqliteContext,
  ownerKind: CompletionOwnerKind,
  ownerId: string,
  obligation: CompletionObligationReference,
): boolean {
  if (obligation.state === "suppressed") return false;
  const timestamp = now();
  const replyId = obligation.notification_reply_id;
  if (replyId) {
    const dismissed = context.database.prepare(`UPDATE outbound_replies
      SET state='dismissed',error='Human Review mention became obsolete before first delivery attempt',updated_at=?
      WHERE id=? AND state='pending' AND kind='text' AND target_role='operation_result'
        AND (payload LIKE '%需要你的选择%' OR payload LIKE '%你的请求已完成，请查看上方 Turn Card。%')
        AND claim_attempt_id IS NULL AND claimed_owner_id IS NULL AND claimed_fence IS NULL
        AND claimed_at IS NULL AND first_claimed_at IS NULL AND attempt_count=0
        AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL
        AND COALESCE(effect_certainty,'not-started') IN ('not-started','rejected')`).run(timestamp, replyId);
    if (dismissed.changes !== 1) return false;
    removeDependentDeliveryPrerequisites(context, replyId);
  }
  return context.database.prepare(`UPDATE completion_notification_obligations
    SET state='suppressed',notification_reply_id=NULL,released_at=NULL,updated_at=?
    WHERE owner_kind=? AND owner_id=? AND owner_generation=?
      AND state IN ('waiting_for_answer','missing_mention_target','released')
      AND ${replyId ? "notification_reply_id=?" : "notification_reply_id IS NULL"}`).run(
        timestamp, ownerKind, ownerId, obligation.owner_generation, ...(replyId ? [replyId] : [])
      ).changes === 1;
}

function currentOwnerIdentity(context: SqliteContext, action: CompletionNotificationRow): boolean {
  const binding = context.database.prepare(`SELECT generation, state, lifecycle, attachment FROM bindings WHERE id = ?`).get(action.binding_id) as {
    generation: number; state: string; lifecycle: string; attachment: string;
  } | undefined;
  if (!binding || binding.generation !== action.binding_generation || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return false;
  if (action.owner_kind === "primary-prompt") {
    const prompt = context.database.prepare(`SELECT p.state, r.binding_generation, r.phase, page.page_index, page.message_id, page.card_id
      FROM prompt_jobs p JOIN run_cards r ON r.prompt_id = p.id
      JOIN answer_pages page ON page.prompt_id = p.id AND page.page_index = (SELECT MAX(page_index) FROM answer_pages WHERE prompt_id = p.id)
      WHERE p.id = ? AND p.binding_id = ?`).get(action.owner_id, action.binding_id) as {
        state: string; binding_generation: number; phase: string; page_index: number; message_id: string | null; card_id: string | null;
      } | undefined;
    return Boolean(prompt && prompt.state === "delivered" && prompt.phase === "completed"
      && prompt.binding_generation === action.binding_generation && prompt.page_index >= 0
      && prompt.message_id === action.card_message_id && prompt.card_id);
  }
  const worker = context.database.prepare(`SELECT turn.state, turn.instance_id, turn.instance_generation,
      instance.generation, instance.worker_session_generation, instance.parent_binding_id, instance.parent_binding_generation,
      page.page_index, page.message_id, page.card_id
    FROM instance_turns turn JOIN agent_instances instance ON instance.id = turn.instance_id
    JOIN worker_turn_card_pages page ON page.turn_id = turn.id AND page.page_index = (SELECT MAX(page_index) FROM worker_turn_card_pages WHERE turn_id = turn.id)
    WHERE turn.id = ?`).get(action.owner_id) as {
      state: string; instance_id: string; instance_generation: number; generation: number; worker_session_generation: number;
      parent_binding_id: string | null; parent_binding_generation: number | null; page_index: number; message_id: string | null; card_id: string | null;
    } | undefined;
  return Boolean(worker && worker.state === "completed" && worker.instance_generation === worker.generation
    && worker.worker_session_generation === action.owner_generation && worker.parent_binding_id === action.binding_id
    && worker.parent_binding_generation === action.binding_generation && worker.page_index >= 0
    && worker.message_id === action.card_message_id && worker.card_id);
}

function workerId(context: SqliteContext, turnId: string): string | null {
  return (context.database.prepare("SELECT instance_id FROM instance_turns WHERE id = ?").get(turnId) as { instance_id: string } | undefined)?.instance_id ?? null;
}

function payloadContainsActionSet(payload: string, actionSetId: string): boolean {
  try {
    return containsActionSet(JSON.parse(payload) as unknown, actionSetId);
  } catch {
    return false;
  }
}

function containsActionSet(value: unknown, actionSetId: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsActionSet(item, actionSetId));
  const record = value as Record<string, unknown>;
  return record.actionSetId === actionSetId || Object.values(record).some((item) => containsActionSet(item, actionSetId));
}

function now(): string { return new Date().toISOString(); }
