import { createHash, randomUUID } from "node:crypto";
import type { OutboundDeliveryClaim } from "../../domain/delivery.js";
import { deliveryScopeKey, routeDelivery, type DeliveryRoute, type DeliveryScope } from "../../domain/delivery-scope.js";
import type { DeliveryReservationIdentity, OutboxStore } from "../../domain/ports/outbox.js";
import type { Binding, OutboundReply, OutboundWorkClass } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import { encodeDeliveryIntent } from "../../domain/delivery-intent.js";
import type { SemanticSnapshotDeliveryInput } from "../../domain/delivery.js";
import { deliveryConflictKey } from "../../domain/delivery-conflict.js";
import { gatewayScopedOutboundLaneKey, outboundLaneKey } from "../outbox-lanes.js";
import { mapOutboundReply, type OutboundReplyRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

type SnapshotIdentity =
  | { projectionKey: string; snapshotRevision: number }
  | { projectionKey?: never; snapshotRevision?: never };

const OUTBOUND_EFFECT_IDENTITY_KEYS = [
  "gatewayId", "gatewayProfileId", "bindingId", "promptId", "workerTurnId", "workerId", "workerSessionGeneration",
  "viewVersion", "cardSequence", "selectionId", "streamPageIndex", "streamElementId", "cardRole", "targetRole",
  "threadAliasId", "workerThreadId", "shortcutPanelId", "targetChatId", "laneKey", "conflictKey", "projectionKey", "rootMessageId",
  "kind", "payload", "intentKind", "intentJson", "rendererRevision"
] as const satisfies ReadonlyArray<keyof OutboundReply>;
const DEFAULT_PENDING_LIST_LIMIT = 256;
type OutboundEffectIdentity = Pick<OutboundReply, typeof OUTBOUND_EFFECT_IDENTITY_KEYS[number]> & { snapshotRevision: number; scopeKey: string | null; ownerFenceJson: string | null; parentPaneId: string | null };

export type EnqueueOutboundReplyInput = Parameters<OutboxStore["enqueueOutboundReply"]>[0] &
  { laneKeyOverride?: string; bindingGeneration?: number | null; streamPageIndex?: number | null; semanticInput?: SemanticSnapshotDeliveryInput } & SnapshotIdentity;

export class SqliteOutboxQueueStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      getBinding(id: string): Binding | null;
      getAgentInstance(id: string): import("../../domain/agent-instance.js").AgentInstance | null;
      loadRunCard(promptId: string): RunCardView | null;
      loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
    }
  ) {}

  preview(input: EnqueueOutboundReplyInput): DeliveryReservationIdentity {
    const bindingGeneration = this.resolveBindingGeneration(input);
    const streamMetadata = this.resolveStreamMetadata(input);
    const gatewayId = input.gatewayId ?? "feishu:primary";
    const logicalLaneKey = input.laneKeyOverride ?? outboundLaneKey({ ...input, bindingGeneration, streamPageIndex: streamMetadata.pageIndex });
    const laneKey = gatewayScopedOutboundLaneKey(gatewayId, logicalLaneKey);
    const conflictKey = deliveryConflictKey({
      gatewayId, laneKey, projectionKey: input.projectionKey ?? null,
      bindingId: input.bindingId ?? null, bindingGeneration,
      promptId: input.promptId ?? null, workerTurnId: input.workerTurnId ?? null,
      workerId: input.workerId ?? null, workerSessionGeneration: input.workerSessionGeneration ?? null,
      streamPageIndex: streamMetadata.pageIndex, targetRole: input.targetRole ?? null,
      kind: input.kind, rootMessageId: input.rootMessageId ?? null
    });
    const route = this.resolveDeliveryRoute(input, bindingGeneration);
    return Object.freeze({
      deliveryTarget: Object.freeze({ gatewayId, kind: input.kind, rootMessageId: input.rootMessageId ?? null, targetChatId: input.targetChatId ?? null }),
      scope: route.scope ? Object.freeze({ ...route.scope }) : null,
      ownerFence: route.ownerFence ? freezeOwnerFence(route.ownerFence) : null,
      parentPaneId: route.parentPaneId,
      laneKey,
      conflictKey,
      orderingIdentity: reservationOrderingIdentity(route, laneKey, conflictKey, input.projectionKey ?? null),
      idempotencyKey: input.idempotencyKey
    });
  }

  getReservationIdentity(replyId: string): DeliveryReservationIdentity | null {
    const reply = this.get(replyId);
    if (!reply) return null;
    return Object.freeze({
      deliveryTarget: Object.freeze({ gatewayId: reply.gatewayId, kind: reply.kind, rootMessageId: reply.rootMessageId, targetChatId: reply.targetChatId }),
      scope: reply.deliveryScope ? Object.freeze({ ...reply.deliveryScope }) : null,
      ownerFence: reply.deliveryOwnerFence ? freezeOwnerFence(reply.deliveryOwnerFence) : null,
      parentPaneId: reply.deliveryParentPaneId,
      laneKey: reply.laneKey,
      conflictKey: reply.conflictKey,
      orderingIdentity: reservationOrderingIdentity({ scope: reply.deliveryScope, ownerFence: reply.deliveryOwnerFence, parentPaneId: reply.deliveryParentPaneId }, reply.laneKey, reply.conflictKey, reply.projectionKey ?? null),
      idempotencyKey: reply.idempotencyKey
    });
  }

  enqueue(input: EnqueueOutboundReplyInput): OutboundReply {
    const timestamp = now();
    const bindingGeneration = this.resolveBindingGeneration(input);
    const streamMetadata = this.resolveStreamMetadata(input);
    const reservationIdentity = this.preview(input);
    const encoded = encodeDeliveryIntent(input.kind, input.payload, input.intentKind ?? undefined);
    const intentKind = input.intentKind ?? encoded.intentKind;
    const intentJson = input.intentJson ?? encoded.intentJson;
    const rendererRevision = input.rendererRevision ?? encoded.rendererRevision;
    const workClass = input.workClass ?? "live";
    let cardSequence = input.cardSequence ?? null;
    const { laneKey, conflictKey } = reservationIdentity;
    const gatewayId = reservationIdentity.deliveryTarget.gatewayId;
    const logicalLaneKey = laneKey.slice(`gateway:${gatewayId}:`.length);
    const gatewayProfileId = input.gatewayProfileId ?? "feishu-cardkit-v1";
    const gatewayPlanJson = input.gatewayPlanJson ?? null;
    const gatewayPlanHash = input.gatewayPlanHash ?? null;
    const gatewayCheckpointJson = input.gatewayCheckpointJson ?? null;
    const rootMessageId = reservationIdentity.deliveryTarget.rootMessageId;
    const targetChatId = reservationIdentity.deliveryTarget.targetChatId;
    const threadAliasId = input.threadAliasId ?? null;
    const workerThreadId = input.workerThreadId ?? null;
    const shortcutPanelId = input.shortcutPanelId ?? null;
    const replaceableSessionStatus = input.kind === "card_update" && input.bindingId && !input.promptId && rootMessageId && input.targetRole === "session_status";
    return this.context.transaction("sqlite.outbox-queue-store.write", () => {
      const deliveryRoute: DeliveryRoute = { scope: reservationIdentity.scope, ownerFence: reservationIdentity.ownerFence, parentPaneId: reservationIdentity.parentPaneId };
      const scope = deliveryScopeColumns(deliveryRoute);
      const existing = this.getByKey(input.idempotencyKey);
      if (replaceableSessionStatus && cardSequence !== null) {
        const replaceable = existing?.cardSequence !== null && existing?.cardSequence !== undefined
          ? { reusable_sequence: existing.cardSequence }
          : this.context.database.prepare(`
            SELECT MIN(card_sequence) AS reusable_sequence
            FROM outbound_replies
            WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
              AND lane_key = ? AND kind = 'card_update' AND target_role = 'session_status' AND state = 'pending'
              AND claim_attempt_id IS NULL AND first_claimed_at IS NULL AND attempt_count = 0
              AND card_id_checkpoint IS NULL AND projection_key IS NULL
          `).get(input.bindingId, rootMessageId, laneKey) as { reusable_sequence: number | null };
        if (replaceable.reusable_sequence !== null) cardSequence = Math.min(cardSequence, Number(replaceable.reusable_sequence));
      }
      const requestedEffect: OutboundEffectIdentity = {
        gatewayId, gatewayProfileId, bindingId: input.bindingId ?? null, promptId: input.promptId ?? null,
        workerTurnId: input.workerTurnId ?? null, workerId: input.workerId ?? null, workerSessionGeneration: input.workerSessionGeneration ?? null,
        viewVersion: input.viewVersion ?? null, cardSequence, selectionId: input.selectionId ?? null,
        streamPageIndex: streamMetadata.pageIndex, streamElementId: streamMetadata.elementId, cardRole: input.cardRole ?? null,
        targetRole: input.targetRole ?? null, threadAliasId, workerThreadId, shortcutPanelId, targetChatId, laneKey, conflictKey,
        projectionKey: input.projectionKey ?? null, rootMessageId, kind: input.kind, payload: input.payload, intentKind, intentJson,
        rendererRevision, snapshotRevision: input.snapshotRevision ?? 1, scopeKey: scope.key,
        ownerFenceJson: deliveryRoute.ownerFence ? JSON.stringify(deliveryRoute.ownerFence) : null,
        parentPaneId: deliveryRoute.parentPaneId
      };
      if (existing) {
        const sameEffect = this.sameEffect(existing, requestedEffect);
        const compatibleGatewayState = (gatewayPlanJson === null || existing.gatewayPlanJson === gatewayPlanJson) && (gatewayPlanHash === null || existing.gatewayPlanHash === gatewayPlanHash) && (gatewayCheckpointJson === null || existing.gatewayCheckpointJson === gatewayCheckpointJson);
        if (sameEffect && compatibleGatewayState) return existing;
        if (existing.workClass !== workClass) throw new Error("outbound_idempotency_conflict");
        if (this.effectIsFrozen(existing.id)) throw new Error("outbound_idempotency_conflict");
        if (existing.state !== "pending") return existing;
      }
      const supersededConfirmedRetries = input.kind === "card_update"
        ? this.dismissConfirmedNotAppliedSnapshots({
          laneKey,
          projectionKey: input.projectionKey ?? null,
          snapshotRevision: input.snapshotRevision ?? 1,
          viewVersion: input.viewVersion ?? null,
          timestamp,
        })
        : [];
      if (input.kind === "card_update" && input.projectionKey?.startsWith("conversation-turn:")) {
        this.context.database.prepare(`
          UPDATE outbound_replies
          SET state = 'dismissed',
            error = 'Coalesced unclaimed legacy conversation-turn snapshot before first attempt',
            updated_at = ?
          WHERE projection_key = ? AND kind = 'card_update' AND state = 'pending'
            AND snapshot_revision < ?
            AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
            AND attempt_count = 0 AND card_id_checkpoint IS NULL
        `).run(timestamp, input.projectionKey, input.snapshotRevision ?? 1);
      }
      if (replaceableSessionStatus) {
        this.context.database.prepare(`
          UPDATE outbound_replies
          SET state = 'dismissed',
            error = 'Coalesced unclaimed status-card snapshot before first attempt',
            updated_at = ?
          WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
            AND lane_key = ? AND kind = 'card_update' AND target_role = 'session_status' AND state = 'pending'
            AND claim_attempt_id IS NULL AND first_claimed_at IS NULL AND attempt_count = 0
            AND card_id_checkpoint IS NULL AND projection_key IS NULL
        `).run(timestamp, input.bindingId, rootMessageId, laneKey);
      } else if (input.kind === "card_update" && input.bindingId && !input.promptId && rootMessageId && logicalLaneKey.startsWith("pane-entry:")) {
        this.context.database.prepare(`
          UPDATE outbound_replies
          SET state = 'dismissed',
            error = 'Coalesced unclaimed pane-entry snapshot before first attempt',
            updated_at = ?
          WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
            AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            AND claim_attempt_id IS NULL AND first_claimed_at IS NULL AND attempt_count = 0
            AND card_id_checkpoint IS NULL AND projection_key IS NULL
        `).run(timestamp, input.bindingId, rootMessageId, laneKey);
      } else if (input.kind === "card_update" && input.bindingId && !input.promptId && rootMessageId) {
        this.context.database.prepare(`
          UPDATE outbound_replies
          SET state = 'dismissed',
            error = 'Coalesced unclaimed replaceable-card snapshot before first attempt',
            updated_at = ?
          WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
            AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
            AND attempt_count = 0 AND card_id_checkpoint IS NULL AND projection_key IS NULL
            AND delivery_order > (
              SELECT MIN(delivery_order) FROM outbound_replies
              WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
                AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            )
        `).run(timestamp, input.bindingId, rootMessageId, laneKey, input.bindingId, rootMessageId, laneKey);
      }
      if (input.kind === "card_update" && input.workerId && input.workerSessionGeneration !== undefined && input.workerSessionGeneration !== null && input.viewVersion !== undefined && input.viewVersion !== null) {
        this.context.database.prepare(`UPDATE outbound_replies
          SET state = 'dismissed',
            error = 'Coalesced unclaimed Worker Main snapshot before first attempt',
            updated_at = ?
          WHERE worker_id = ? AND worker_session_generation = ? AND kind = 'card_update'
            AND state = 'pending' AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
            AND attempt_count = 0 AND card_id_checkpoint IS NULL AND projection_key IS NULL
            AND COALESCE(view_version, 0) < ?`).run(timestamp, input.workerId, input.workerSessionGeneration, input.viewVersion);
      }
      if (input.kind === "card_update" && input.promptId && rootMessageId && input.viewVersion !== undefined && input.viewVersion !== null) {
        this.context.database.prepare(`UPDATE outbound_replies
          SET state = 'dismissed',
            error = 'Coalesced unclaimed prompt snapshot before first attempt',
            updated_at = ?
          WHERE prompt_id = ? AND root_message_id = ? AND kind = ?
            AND state = 'pending' AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
            AND attempt_count = 0 AND card_id_checkpoint IS NULL AND projection_key IS NULL
            AND card_role IS ? AND COALESCE(view_version, 0) < ?`).run(timestamp, input.promptId, rootMessageId, input.kind, input.cardRole ?? null, input.viewVersion);
      }
      this.context.database.prepare(`
        INSERT INTO outbound_replies(id, gateway_id, gateway_profile_id, gateway_plan_json, gateway_plan_hash, gateway_checkpoint_json, idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, stream_page_index, stream_element_id, card_role, target_role, thread_alias_id, worker_thread_id, shortcut_panel_id, target_chat_id, work_class,
          scope_kind, scope_key, scope_workspace_id, scope_pane_id, delivery_owner_kind, delivery_owner_id, delivery_owner_generation, delivery_owner_session_generation, delivery_parent_id, delivery_parent_generation, delivery_parent_session_generation, delivery_parent_pane_id,
          root_message_id, kind, payload, intent_kind, intent_json, renderer_revision, lane_key, conflict_key, projection_key, snapshot_revision,
          delivery_input_kind,subject_kind,subject_json,subject_revision,presentation_snapshot_json,presentation_snapshot_hash,
          planner_policy_version,renderer_policy_version,gateway_profile_version,preparation_state,
          state, attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'pending', 0, ?, ?, ?
        )
        ON CONFLICT(idempotency_key) DO UPDATE SET
          payload = CASE WHEN outbound_replies.state = 'pending' THEN excluded.payload ELSE outbound_replies.payload END,
          view_version = CASE WHEN outbound_replies.state = 'pending' THEN excluded.view_version ELSE outbound_replies.view_version END,
          card_sequence = CASE WHEN outbound_replies.state = 'pending' THEN excluded.card_sequence ELSE outbound_replies.card_sequence END,
          stream_page_index = CASE WHEN outbound_replies.state = 'pending' THEN excluded.stream_page_index ELSE outbound_replies.stream_page_index END,
          stream_element_id = CASE WHEN outbound_replies.state = 'pending' THEN excluded.stream_element_id ELSE outbound_replies.stream_element_id END,
          intent_kind = CASE WHEN outbound_replies.state = 'pending' THEN excluded.intent_kind ELSE outbound_replies.intent_kind END,
          intent_json = CASE WHEN outbound_replies.state = 'pending' THEN excluded.intent_json ELSE outbound_replies.intent_json END,
          renderer_revision = CASE WHEN outbound_replies.state = 'pending' THEN excluded.renderer_revision ELSE outbound_replies.renderer_revision END,
          snapshot_revision = CASE WHEN outbound_replies.state = 'pending' THEN MAX(outbound_replies.snapshot_revision, excluded.snapshot_revision) ELSE outbound_replies.snapshot_revision END,
          updated_at = CASE WHEN outbound_replies.state = 'pending' THEN excluded.updated_at ELSE outbound_replies.updated_at END
      `).run(input.id, gatewayId, gatewayProfileId, gatewayPlanJson, gatewayPlanHash, gatewayCheckpointJson, input.idempotencyKey, input.bindingId ?? null, input.promptId ?? null, input.workerTurnId ?? null, input.workerId ?? null, input.workerSessionGeneration ?? null, input.viewVersion ?? null, cardSequence, input.selectionId ?? null, streamMetadata.pageIndex, streamMetadata.elementId, input.cardRole ?? null, input.targetRole ?? null, threadAliasId, workerThreadId, shortcutPanelId, targetChatId, workClass,
        scope.kind, scope.key, scope.workspaceId, scope.paneId, scope.ownerKind, scope.ownerId, scope.ownerGeneration, scope.ownerSessionGeneration, scope.parentId, scope.parentGeneration, scope.parentSessionGeneration, scope.parentPaneId,
        rootMessageId, input.kind, input.payload, intentKind, intentJson, rendererRevision, laneKey, conflictKey, input.projectionKey ?? null, input.snapshotRevision ?? 1,
        input.semanticInput?.kind ?? null, input.semanticInput?.subject.kind ?? null,
        input.semanticInput ? JSON.stringify(input.semanticInput.subject) : null,
        input.semanticInput?.subject.revision ?? null,
        input.semanticInput ? JSON.stringify(input.semanticInput.snapshot) : null,
        input.semanticInput?.snapshotHash ?? null,
        input.semanticInput?.plannerPolicyVersion ?? null,
        input.semanticInput?.rendererPolicyVersion ?? null,
        input.semanticInput?.gatewayProfileVersion ?? null,
        input.semanticInput ? "reserved" : null,
        timestamp, timestamp, timestamp);
      const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key = ?").get(input.idempotencyKey) as OutboundReplyRow | undefined;
      if (!row) throw new Error(`Outbound reply not found: ${input.idempotencyKey}`);
      for (const failedReplyId of supersededConfirmedRetries) {
        this.context.database.prepare(`UPDATE delivery_recoveries
          SET state = 'replacement_pending', action = 'released_newer_snapshot', replacement_reply_id = ?, updated_at = ?
          WHERE failed_reply_id = ? AND state IN ('unresolved','replacement_pending')`).run(row.id, timestamp, failedReplyId);
        this.context.database.prepare(`UPDATE outbox_lane_quarantines
          SET state = 'released', action = 'released_newer_snapshot', released_at = ?, updated_at = ?
          WHERE failed_reply_id = ? AND state = 'active'`).run(timestamp, timestamp, failedReplyId);
      }
      if (input.kind === "stream_card_create" && input.promptId) {
        const stream = streamCardState(input.payload);
        const pageIndex = stream?.pageIndex ?? 0;
        const view = this.dependencies.loadRunCard(input.promptId);
        const elementId = stream?.elementId ?? view?.answerElementId;
        if (!view || !elementId) throw new Error(`Answer page metadata missing for prompt: ${input.promptId}`);
        this.context.database.prepare(`INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, 0, 'creating', ?, ?, ?) ON CONFLICT(prompt_id, page_index) DO NOTHING`).run(input.promptId, pageIndex, elementId, stream?.pageStart ?? 0, stream?.deliveryMode ?? "streaming", timestamp, timestamp);
      }
      if (input.kind === "stream_card_create" && input.workerTurnId) {
        const stream = streamCardState(input.payload);
        const view = this.dependencies.loadWorkerTurnCard(input.workerTurnId);
        const pageIndex = stream?.pageIndex ?? 0;
        const elementId = stream?.elementId ?? view?.elementId;
        if (!view || !elementId) throw new Error(`Worker card page metadata missing for turn: ${input.workerTurnId}`);
        this.context.database.prepare(`INSERT INTO worker_turn_card_pages(id, turn_id, page_index, page_start, element_id, message_id, card_id, state, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'creating', 0, ?, ?) ON CONFLICT(turn_id, page_index) DO NOTHING`).run(`${input.workerTurnId}:${pageIndex}`, input.workerTurnId, pageIndex, stream?.pageStart ?? 0, elementId, timestamp, timestamp);
      }
      return mapOutboundReply(row);
    });
  }

  private resolveBindingGeneration(input: EnqueueOutboundReplyInput): number | null {
    return input.bindingGeneration ?? (input.promptId
      ? (this.context.database.prepare("SELECT binding_generation FROM run_cards WHERE prompt_id = ?").get(input.promptId) as { binding_generation: number } | undefined)?.binding_generation ?? null
      : input.bindingId ? this.dependencies.getBinding(input.bindingId)?.generation ?? null : null);
  }

  private resolveStreamMetadata(input: EnqueueOutboundReplyInput) {
    const parsed = outboundStreamMetadata(input.kind, input.payload);
    return { ...parsed, pageIndex: input.streamPageIndex ?? parsed.pageIndex ?? (input.cardRole === "answer" && input.promptId && input.kind === "stream_card_create" ? 0 : null) };
  }

  private resolveDeliveryRoute(input: EnqueueOutboundReplyInput, bindingGeneration: number | null): DeliveryRoute {
    if (input.globalDelivery === true) return routeDelivery({ kind: "unowned" });
    const workerView = input.workerTurnId ? this.dependencies.loadWorkerTurnCard(input.workerTurnId) : null;
    const workerId = input.workerId ?? workerView?.instanceId ?? null;
    if (workerId) {
      const worker = this.dependencies.getAgentInstance(workerId);
      const runtime = worker?.runtimeRef ?? null;
      const expectedWorkerSessionGeneration = input.workerSessionGeneration ?? workerView?.workerSessionGeneration ?? null;
      const parent = worker?.parent ?? null;
      const parentBinding = parent ? this.dependencies.getBinding(parent.bindingId) : null;
      const exactWorker = worker?.role === "worker"
        && runtime !== null
        && worker.workerSessionLifecycle === "active"
        && worker.desiredState === "running"
        && worker.workerSessionGeneration === expectedWorkerSessionGeneration
        && (workerView === null || workerView.instanceGeneration === worker.generation)
        && parent !== null
        && parent.bindingGeneration === parentBinding?.generation
        && parent.paneId === parentBinding?.paneId
        && parentBinding?.state === "active"
        && parentBinding.lifecycle === "active"
        && parentBinding.attachment === "attached"
        && (input.bindingId === undefined || input.bindingId === null || input.bindingId === parent.bindingId);
      if (!exactWorker) return { scope: null, ownerFence: null, parentPaneId: null };
      return routeDelivery({
        kind: "worker",
        workspaceId: exactWorker ? runtime!.herdrWorkspaceId : null,
        paneId: exactWorker ? runtime!.paneId : null,
        parentPaneId: exactWorker ? parent.paneId : null,
        workerId,
        workerSessionGeneration: exactWorker ? worker.workerSessionGeneration : null,
        runtimeGeneration: exactWorker ? worker.generation : null,
        parentBindingId: exactWorker ? parent.bindingId : null,
        parentBindingGeneration: exactWorker ? parent.bindingGeneration ?? null : null,
        parentSessionEpoch: exactWorker ? parentBinding.sessionEpoch : null
      });
    }
    if (input.bindingId) {
      const binding = this.dependencies.getBinding(input.bindingId);
      const exactBinding = binding !== null && binding.generation === bindingGeneration;
      if (!exactBinding || !binding.paneId) return { scope: null, ownerFence: null, parentPaneId: null };
      return routeDelivery({
        kind: "primary",
        workspaceId: exactBinding ? binding.workspaceId : null,
        paneId: exactBinding ? binding.paneId : null,
        bindingId: input.bindingId,
        bindingGeneration: exactBinding ? binding.generation : null,
        sessionEpoch: exactBinding ? binding.sessionEpoch : null
      });
    }
    return routeDelivery({ kind: "unowned" });
  }

  private dismissConfirmedNotAppliedSnapshots(input: {
    laneKey: string;
    projectionKey: string | null;
    snapshotRevision: number;
    viewVersion: number | null;
    timestamp: string;
  }): string[] {
    if (input.projectionKey === null && input.viewVersion === null) return [];
    const newerPredicate = input.projectionKey === null
      ? "projection_key IS NULL AND COALESCE(view_version, 0) < ?"
      : "projection_key = ? AND snapshot_revision < ?";
    const newerParameters = input.projectionKey === null
      ? [input.viewVersion]
      : [input.projectionKey, input.snapshotRevision];
    const rows = this.context.database.prepare(`SELECT id FROM outbound_replies
      WHERE lane_key = ? AND kind = 'card_update' AND state = 'pending'
        AND claim_attempt_id IS NULL AND attempt_count > 0 AND card_id_checkpoint IS NULL
        AND effect_certainty IN ('rejected','not-started') AND ${newerPredicate}
      ORDER BY delivery_order`).all(input.laneKey, ...newerParameters) as Array<{ id: string }>;
    if (rows.length === 0) return [];
    const ids = rows.map(({ id }) => id);
    const placeholders = ids.map(() => "?").join(", ");
    this.context.database.prepare(`UPDATE outbound_replies
      SET state = 'dismissed', error = 'Superseded by a newer authoritative snapshot after confirmed non-application',
        claim_attempt_id = NULL, claimed_fence = NULL, claimed_owner_id = NULL, claimed_at = NULL, updated_at = ?
      WHERE id IN (${placeholders})`).run(input.timestamp, ...ids);
    return ids;
  }

  getByKey(key: string): OutboundReply | null {
    const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key = ?").get(key) as OutboundReplyRow | undefined;
    return row ? mapOutboundReply(row) : null;
  }

  effectIsFrozen(id: string): boolean {
    return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE id = ? AND (first_claimed_at IS NOT NULL OR attempt_count > 0 OR card_id_checkpoint IS NOT NULL OR gateway_plan_json IS NOT NULL OR gateway_plan_hash IS NOT NULL)").get(id) !== undefined;
  }

  private sameEffect(existing: OutboundReply, requested: OutboundEffectIdentity): boolean {
    const snapshot = this.context.database.prepare("SELECT snapshot_revision FROM outbound_replies WHERE id = ?").get(existing.id) as { snapshot_revision: number } | undefined;
    return snapshot !== undefined && Number(snapshot.snapshot_revision) === requested.snapshotRevision
      && (existing.deliveryScope ? deliveryScopeKey(existing.deliveryScope) : null) === requested.scopeKey
      && (existing.deliveryOwnerFence ? JSON.stringify(existing.deliveryOwnerFence) : null) === requested.ownerFenceJson
      && existing.deliveryParentPaneId === requested.parentPaneId
      && OUTBOUND_EFFECT_IDENTITY_KEYS.every((key) => (existing[key] ?? null) === (requested[key] ?? null));
  }

  prepareGatewayPlan(id: string, input: { gatewayId: string; gatewayProfileId: string; gatewayPlanJson: string }): OutboundReply | null {
    return this.context.transaction("sqlite.outbox-queue-store.write", () => {
      const current = this.get(id);
      if (!current || current.state !== "pending") return null;
      const gatewayPlanHash = createHash("sha256").update(input.gatewayPlanJson).digest("hex");
      if (current.gatewayPlanJson !== null || current.gatewayPlanHash !== null) {
        if (current.gatewayId !== input.gatewayId || current.gatewayProfileId !== input.gatewayProfileId || current.gatewayPlanJson !== input.gatewayPlanJson || current.gatewayPlanHash !== gatewayPlanHash) throw new Error("outbound_gateway_plan_conflict");
        return current;
      }
      const claim = this.context.database.prepare("SELECT claim_attempt_id, first_claimed_at FROM outbound_replies WHERE id = ?").get(id) as { claim_attempt_id: string | null; first_claimed_at: string | null } | undefined;
      if (!claim || claim.claim_attempt_id !== null) return null;
      if (claim.first_claimed_at !== null && (current.gatewayId !== input.gatewayId || current.gatewayProfileId !== input.gatewayProfileId)) throw new Error("outbound_gateway_identity_conflict");
      const updated = this.context.database.prepare("UPDATE outbound_replies SET gateway_id = ?, gateway_profile_id = ?, gateway_plan_json = ?, gateway_plan_hash = ?, updated_at = ? WHERE id = ? AND state = 'pending' AND claim_attempt_id IS NULL AND gateway_plan_json IS NULL AND gateway_plan_hash IS NULL").run(input.gatewayId, input.gatewayProfileId, input.gatewayPlanJson, gatewayPlanHash, now(), id);
      return updated.changes === 1 ? this.get(id) : null;
    });
  }

  /** Test/admin compatibility seam; production delivery claims through PreparedDeliveryStore. */
  claim(id: string, dueAt: string | null): OutboundDeliveryClaim | null {
    return this.context.transaction("sqlite.outbox-queue-store.write", () => {
      if (this.cooldownActive()) return null;
      const row = this.context.database.prepare(`SELECT candidate.* FROM outbound_replies candidate
        WHERE candidate.id=? AND candidate.state='pending' AND candidate.scope_key IS NOT NULL
          AND candidate.claim_attempt_id IS NULL AND (? IS NULL OR candidate.next_attempt_at<=?)
          AND NOT EXISTS (SELECT 1 FROM outbound_replies older WHERE older.scope_key=candidate.scope_key
            AND older.delivery_order<candidate.delivery_order AND older.state IN ('pending','dead_letter'))
          AND NOT EXISTS (SELECT 1 FROM outbox_lane_quarantines quarantine
            JOIN outbound_replies failed ON failed.id=quarantine.failed_reply_id
            WHERE quarantine.state='active' AND failed.scope_key=candidate.scope_key)`).get(id, dueAt, dueAt) as OutboundReplyRow | undefined;
      if (!row) return null;
      const hasFence = this.context.database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name='bridge_write_fence'").get();
      const fence = hasFence ? this.context.database.prepare("SELECT owner_id,fencing_token FROM temp.bridge_write_fence").get() as { owner_id: string; fencing_token: number } : null;
      const reply = mapOutboundReply(row);
      const attemptId = randomUUID();
      const payloadHash = createHash("sha256").update(JSON.stringify([reply.gatewayId, reply.gatewayProfileId, reply.gatewayPlanJson, reply.gatewayPlanHash, reply.idempotencyKey, reply.rootMessageId, reply.targetChatId, reply.threadAliasId, reply.workerThreadId, reply.shortcutPanelId, reply.kind, reply.payload, reply.intentKind, reply.intentJson, reply.rendererRevision, reply.viewVersion, reply.cardSequence, reply.workClass])).digest("hex");
      this.context.database.prepare("UPDATE outbound_replies SET claim_attempt_id=?,claimed_fence=?,claimed_owner_id=?,claimed_at=?,first_claimed_at=COALESCE(first_claimed_at,?),payload_hash=? WHERE id=?").run(attemptId, fence?.fencing_token ?? null, fence?.owner_id ?? null, now(), now(), payloadHash, id);
      return Object.freeze({ reply: Object.freeze(reply), attemptId, fencingToken: fence?.fencing_token ?? null, payloadHash, snapshotRevision: Number(row.snapshot_revision) });
    });
  }

  matchesClaim(id: string, claim?: OutboundDeliveryClaim): boolean {
    if (!claim) return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE id = ? AND claim_attempt_id IS NULL").get(id) !== undefined;
    if (claim.reply.id !== id) return false;
    return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE id = ? AND claim_attempt_id = ? AND claimed_fence IS ? AND payload_hash = ? AND snapshot_revision = ?").get(id, claim.attemptId, claim.fencingToken, claim.payloadHash, claim.snapshotRevision) !== undefined;
  }

  releaseClaim(id: string): void {
    this.context.database.prepare("UPDATE outbound_replies SET claim_attempt_id = NULL, claimed_fence = NULL, claimed_owner_id = NULL, claimed_at = NULL, claim_expires_at = NULL WHERE id = ?").run(id);
  }

  listPending(limit = DEFAULT_PENDING_LIST_LIMIT): OutboundReply[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Invalid pending outbound list limit");
    return (this.context.database.prepare("SELECT * FROM outbound_replies WHERE state = 'pending' ORDER BY delivery_order LIMIT ?").all(limit) as OutboundReplyRow[]).map(mapOutboundReply);
  }

  hasPendingForWorkerTurn(turnId: string): boolean {
    return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND state = 'pending' LIMIT 1").get(turnId) !== undefined;
  }

  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean {
    return this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' AND stream_page_index = ? LIMIT 1").get(promptId, pageIndex) !== undefined;
  }

  dismissSupersededAnswerStream(replyId: string): boolean {
    const updated = this.context.database.prepare(`UPDATE outbound_replies SET state = 'dismissed', error = 'Answer stream superseded by a continuation page', updated_at = ? WHERE id = ? AND state = 'pending' AND claim_attempt_id IS NULL AND kind IN ('stream_content', 'stream_finish') AND prompt_id IS NOT NULL AND EXISTS (SELECT 1 FROM run_cards WHERE run_cards.prompt_id = outbound_replies.prompt_id AND run_cards.answer_page_index > 0 AND run_cards.answer_card_id IS NOT NULL AND run_cards.answer_card_id != outbound_replies.root_message_id)`).run(now(), replyId);
    return Number(updated.changes) === 1;
  }

  notifyScopeMutation(_scopeHint: string): void {}

  get(id: string): OutboundReply | null {
    const row = this.context.database.prepare("SELECT * FROM outbound_replies WHERE id = ?").get(id) as OutboundReplyRow | undefined;
    return row ? mapOutboundReply(row) : null;
  }

  private cooldownActive(): boolean {
    const row = this.context.database.prepare("SELECT blocked_until FROM lark_delivery_cooldowns WHERE scope='app' AND blocked_until>?").get(now()) as { blocked_until: string } | undefined;
    return row !== undefined;
  }
}

function now(): string { return new Date().toISOString(); }
function freezeOwnerFence(owner: NonNullable<DeliveryRoute["ownerFence"]>): NonNullable<DeliveryRoute["ownerFence"]> {
  return Object.freeze({ ...owner, ...(owner.parent ? { parent: Object.freeze({ ...owner.parent }) } : {}) });
}
function reservationOrderingIdentity(route: DeliveryRoute, laneKey: string, conflictKey: string, projectionKey: string | null): string {
  return JSON.stringify([route.scope ? deliveryScopeKey(route.scope) : null, route.ownerFence, route.parentPaneId, laneKey, conflictKey, projectionKey]);
}
function deliveryScopeColumns(route: DeliveryRoute): {
  kind: DeliveryScope["kind"] | null;
  key: string | null;
  ownerKind: "primary" | "worker" | null;
  workspaceId: string | null;
  paneId: string | null;
  ownerId: string | null;
  ownerGeneration: number | null;
  ownerSessionGeneration: number | null;
  parentId: string | null;
  parentGeneration: number | null;
  parentSessionGeneration: number | null;
  parentPaneId: string | null;
} {
  const { scope, ownerFence } = route;
  if (!scope) return { kind: null, key: null, ownerKind: null, workspaceId: null, paneId: null, ownerId: null, ownerGeneration: null, ownerSessionGeneration: null, parentId: null, parentGeneration: null, parentSessionGeneration: null, parentPaneId: null };
  if (scope.kind === "global" || !ownerFence) return { kind: "global", key: deliveryScopeKey({ kind: "global" }), ownerKind: null, workspaceId: null, paneId: null, ownerId: null, ownerGeneration: null, ownerSessionGeneration: null, parentId: null, parentGeneration: null, parentSessionGeneration: null, parentPaneId: null };
  return {
    kind: "pane", key: deliveryScopeKey(scope), ownerKind: ownerFence.kind, workspaceId: scope.workspaceId, paneId: scope.paneId,
    ownerId: ownerFence.id, ownerGeneration: ownerFence.generation, ownerSessionGeneration: ownerFence.sessionGeneration,
    parentId: ownerFence.parent?.id ?? null, parentGeneration: ownerFence.parent?.generation ?? null,
    parentSessionGeneration: ownerFence.parent?.sessionGeneration ?? null,
    parentPaneId: route.parentPaneId
  };
}
function streamCardState(payload: string): { pageIndex: number; pageStart: number; elementId: string; deliveryMode: "streaming" | "static" } | null {
  try {
    const decoded = JSON.parse(payload) as { stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown; deliveryMode?: unknown } };
    const stream = decoded.stream;
    return stream && Number.isInteger(stream.pageIndex) && Number.isInteger(stream.pageStart) && typeof stream.elementId === "string"
      ? { pageIndex: Number(stream.pageIndex), pageStart: Number(stream.pageStart), elementId: stream.elementId, deliveryMode: stream.deliveryMode === "static" ? "static" : "streaming" } : null;
  } catch { return null; }
}
function outboundStreamMetadata(kind: OutboundReply["kind"], payload: string): { pageIndex: number | null; elementId: string | null } {
  if (kind !== "stream_card_create" && kind !== "stream_content" && kind !== "stream_finish") return { pageIndex: null, elementId: null };
  const decoded = parseJsonRecord(payload);
  const stream = kind === "stream_card_create" && typeof decoded.stream === "object" && decoded.stream !== null && !Array.isArray(decoded.stream)
    ? decoded.stream as Record<string, unknown> : decoded;
  return { pageIndex: Number.isInteger(stream.pageIndex) ? Number(stream.pageIndex) : null, elementId: typeof stream.elementId === "string" ? stream.elementId : null };
}
function parseJsonRecord(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value) as unknown; return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
