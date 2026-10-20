import type { OutboundDeliveryClaim } from "../../domain/delivery.js";
import type { Binding, DeliveryFailureMetadata, OutboundReply } from "../../domain/types.js";
import type { RunCardView } from "../../domain/run-card-view.js";
import type { WorkerTurnCardView } from "../../domain/worker-turn-card-view.js";
import type { WorkerMainView } from "../../domain/worker-main-view.js";
import type { CardContextTarget } from "../../domain/card-context-invalidation.js";
import { freezeRunCardWorkerContext } from "../../domain/run-card-view.js";
import type { SqliteContext } from "./context.js";
import type { SqliteOutboxQueueStore } from "./outbox-queue-store.js";
import { confirmAnswerRecoveries, confirmDeliveryRecoveries } from "./delivery-recovery-evidence.js";
import type { SqliteWorkerSessionThreadStore } from "./worker-session-thread-store.js";
import type { SqliteLarkDeliveryCooldownStore } from "./lark-delivery-cooldown-store.js";
import { settleAnswerTimelinePageCheckpoint } from "./answer-timeline-page-store.js";
import { SqliteProjectionGapStore } from "./projection-gap-store.js";
import { SqliteHumanReviewSurfaceStore } from "./human-review-surface-store.js";
import { deliveryDegradationBudget } from "../../domain/delivery-conflict.js";
import { releaseCompletionNotificationForDeliveredReply } from "./completion-notification-store.js";
import { parseTurnCardProjectionKey } from "../../domain/turn-card-projection-key.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import { SqliteCompletionReviewStore } from "./completion-review-store.js";
import { planDeliveryRetry } from "../../domain/delivery-retry-policy.js";

export class SqliteOutboxDeliveryStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly queue: SqliteOutboxQueueStore,
    private readonly dependencies: {
      getBinding(id: string): Binding | null;
      getAgentInstance(id: string): import("../../domain/agent-instance.js").AgentInstance | null;
      loadRunCard(promptId: string): RunCardView | null;
      loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null;
      loadWorkerMainView(workerId: string, workerSessionGeneration: number): WorkerMainView | null;
      saveRunCard(view: RunCardView): RunCardView;
      persistBindingPatch(id: string, patch: Partial<Binding>): Binding;
      invalidateCardContexts(targets: readonly (CardContextTarget & { reason: string })[]): unknown;
      settleMessageDeletion?(input: { outboundReplyId: string; outcome: "deleted" | "already_absent" | "failed"; detail?: string | null }): unknown;
    },
    private readonly workerThreads: SqliteWorkerSessionThreadStore,
    private readonly cooldown: SqliteLarkDeliveryCooldownStore
  ) {}
  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void { this.preparedDeliveryReservation = reservation; this.preparedDeliveryConsumer = consumer; }

  dismissEligibleLegacyCompletionNotifications(bindingIds?: readonly string[]): number {
    const parameters = bindingIds ?? [];
    if (bindingIds && bindingIds.length === 0) return 0;
    const filter = bindingIds ? ` AND legacy.binding_id IN (${bindingIds.map(() => "?").join(", ")})` : "";
    return this.context.transaction("sqlite.outbox-delivery-store.write", () => Number(this.context.database.prepare(`UPDATE outbound_replies AS legacy
      SET state = 'dismissed', error = 'Retired unclaimed standalone completion notification after inline-card convergence', updated_at = ?
      WHERE legacy.state = 'pending' AND legacy.kind = 'card_reply' AND legacy.target_role = 'operation_result'
        AND (legacy.idempotency_key LIKE 'primary-next-input:%' OR legacy.idempotency_key LIKE 'worker-next-input:%')
        AND legacy.claim_attempt_id IS NULL AND legacy.first_claimed_at IS NULL AND legacy.attempt_count = 0
        AND legacy.card_id_checkpoint IS NULL${filter}
        AND EXISTS (
          SELECT 1 FROM completion_notification_obligations obligation
          JOIN completion_action_sets action
            ON action.owner_kind = obligation.owner_kind AND action.owner_id = obligation.owner_id
              AND action.owner_generation = obligation.owner_generation
          WHERE obligation.notification_reply_id = legacy.id AND action.binding_id = legacy.binding_id
            AND action.presentation_kind='legacy-inline'
            AND EXISTS (
              SELECT 1 FROM outbound_replies inline
              WHERE inline.kind = 'card_update' AND inline.state IN ('pending','delivered')
                AND inline.root_message_id = action.card_message_id
                AND ((action.owner_kind = 'primary-prompt' AND inline.prompt_id = action.owner_id)
                  OR (action.owner_kind = 'worker-turn' AND inline.worker_turn_id = action.owner_id))
            )
        )`).run(now(), ...parameters).changes));
  }

  markDelivered(id: string, messageId: string, cardId?: string, claim?: OutboundDeliveryClaim, topicId?: string, messageDeleteOutcome?: "deleted" | "already_absent"): boolean {
    return this.context.transaction("sqlite.outbox-delivery-store.write", () => {
      if (!this.queue.matchesClaim(id, claim)) return false;
      const row = this.context.database.prepare("SELECT id, idempotency_key, binding_id, prompt_id, worker_turn_id, worker_id, worker_session_generation, view_version, card_sequence, selection_id, stream_page_index, card_role, target_role, thread_alias_id, worker_thread_id, shortcut_panel_id, kind, intent_kind, payload, root_message_id, projection_key, snapshot_revision, state, delivered_message_id, card_id_checkpoint, lane_key, conflict_key FROM outbound_replies WHERE id = ?").get(id) as { id: string; idempotency_key: string; binding_id: string | null; prompt_id: string | null; worker_turn_id: string | null; worker_id: string | null; worker_session_generation: number | null; view_version: number | null; card_sequence: number | null; selection_id: string | null; stream_page_index: number | null; card_role: string | null; target_role: string | null; thread_alias_id: string | null; worker_thread_id: string | null; shortcut_panel_id: string | null; kind: string; intent_kind: string | null; payload: string; root_message_id: string | null; projection_key: string | null; snapshot_revision: number; state: OutboundReply["state"]; delivered_message_id: string | null; card_id_checkpoint: string | null; lane_key: string; conflict_key: string } | undefined;
      if (!row || row.state !== "pending") {
        if (row?.state === "delivered" && row.projection_key?.startsWith("completion-review:") && row.kind === "card_reply") {
          new SqliteCompletionReviewStore(this.context).activatePresentation({
            replyId: row.id, messageId, cardId: cardId ?? null, occurredAt: now()
          });
        }
        if (claim) this.queue.releaseClaim(id);
        return false;
      }
      const completionReview = row.projection_key?.startsWith("completion-review:") && row.kind === "card_reply";
      if (completionReview && row.card_id_checkpoint !== null && row.card_id_checkpoint !== (cardId ?? null)) {
        throw new Error("Completion Review ACK identity conflict");
      }
      const delivered = this.context.database.prepare(`UPDATE outbound_replies SET state = 'delivered', delivered_message_id = ?,
        card_id_checkpoint = CASE WHEN ? THEN COALESCE(card_id_checkpoint, ?) ELSE card_id_checkpoint END,
        error = NULL, failure_class = NULL, effect_certainty = NULL, http_status = NULL, lark_error_code = NULL,
        dead_lettered_at = NULL, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'pending'`).run(
        messageId, completionReview ? 1 : 0, cardId ?? null, now(), id
      );
      if (delivered.changes !== 1) return false;
      this.queue.releaseClaim(id);
      const turnCardTarget = row.projection_key ? parseTurnCardProjectionKey(row.projection_key) : null;
      if (turnCardTarget) {
        const page = this.context.database.prepare("SELECT element_id FROM conversation_segment_pages WHERE segment_id = ? AND page_index = ?").get(turnCardTarget.segmentId, turnCardTarget.pageIndex) as { element_id: string } | undefined;
        if (!page || page.element_id !== row.projection_key) {
          new SqliteProjectionGapStore(this.context).open({ stage: "turn_recovery", ownerKind: "turn_card", ownerId: turnCardTarget.segmentId, sourceItemId: row.projection_key!, failureClass: "permanent", failureCode: "immutable_target_mismatch", requiredVersion: row.snapshot_revision, occurredAt: now() });
          const failedAt = now();
          const budget = deliveryDegradationBudget({ failureClass: "permanent", effectCertainty: "rejected", firstFailedAt: failedAt });
          this.context.database.prepare(`INSERT INTO outbox_lane_quarantines(
            lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at,
            conflict_key,phase,first_failed_at,grace_deadline_at,budget_attempt_limit,budget_duration_ms
          ) VALUES(?,?,'immutable','permanent','active','blocked',?,?,?,?,'grace_blocking',?,?,?,?)
          ON CONFLICT(lane_key) DO UPDATE SET failed_reply_id=excluded.failed_reply_id,state='active',action='blocked',
            reason=excluded.reason,updated_at=excluded.updated_at,released_at=NULL,conflict_key=excluded.conflict_key,
            phase='grace_blocking',first_failed_at=excluded.first_failed_at,grace_deadline_at=excluded.grace_deadline_at,
            degraded_at=NULL,budget_attempt_limit=excluded.budget_attempt_limit,budget_duration_ms=excluded.budget_duration_ms`).run(
            row.lane_key, id, "Turn Card immutable target mismatch", failedAt, failedAt, row.conflict_key,
            failedAt, budget.deadlineAt, budget.attemptLimit, budget.durationMs
          );
        }
      }
      if (row.kind === "message_delete") this.dependencies.settleMessageDeletion?.({ outboundReplyId: id, outcome: messageDeleteOutcome ?? "deleted" });
      if (row.kind === "group_card_create" && row.thread_alias_id) {
        if (!topicId) throw new Error("Group card delivery returned no thread identity");
        const activated = this.context.database.prepare(`UPDATE binding_thread_aliases AS alias SET topic_id = ?, root_message_id = ?, state = CASE WHEN EXISTS (SELECT 1 FROM bindings b WHERE b.id = alias.binding_id AND b.chat_id = alias.chat_id AND b.generation = alias.binding_generation AND b.pane_id = alias.pane_id AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached') THEN 'active' ELSE 'stale' END, updated_at = ? WHERE id = ? AND state = 'reserving'`).run(topicId, messageId, now(), row.thread_alias_id);
        if (activated.changes !== 1) throw new Error("Group card thread alias is stale");
        if (row.stream_page_index !== null) {
          const recovery = this.context.database.prepare("SELECT 1 FROM delivery_recoveries WHERE replacement_reply_id = ? AND action = 'create_recovery_conversation' AND state = 'replacement_pending' LIMIT 1").get(row.id);
          if (recovery && row.prompt_id) {
            const page = this.context.database.prepare("SELECT source_start, element_id FROM answer_pages WHERE prompt_id = ? AND page_index = ? AND state = 'creating'").get(row.prompt_id, row.stream_page_index) as { source_start: number; element_id: string } | undefined;
            if (page) {
              this.context.database.prepare("UPDATE answer_pages SET message_id = ?, card_id = NULL, state = 'active', delivery_mode = 'static', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'creating'").run(messageId, now(), row.prompt_id, row.stream_page_index);
              this.context.database.prepare("UPDATE run_cards SET answer_message_id = ?, answer_element_id = ?, answer_page_index = ?, answer_page_start = ?, answer_delivered_version = MAX(answer_delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(messageId, page.element_id, row.stream_page_index, Number(page.source_start), row.view_version ?? 0, now(), row.prompt_id);
            }
          }
          if (recovery && row.worker_turn_id) {
            const page = this.context.database.prepare("SELECT page_start, element_id FROM worker_turn_card_pages WHERE turn_id = ? AND page_index = ? AND state = 'creating'").get(row.worker_turn_id, row.stream_page_index) as { page_start: number; element_id: string } | undefined;
            if (page) {
              this.context.database.prepare("UPDATE worker_turn_card_pages SET message_id = ?, card_id = NULL, state = 'active', updated_at = ? WHERE turn_id = ? AND page_index = ? AND state = 'creating'").run(messageId, now(), row.worker_turn_id, row.stream_page_index);
              this.context.database.prepare("UPDATE worker_turn_cards SET message_id = ?, card_id = NULL, element_id = ?, page_index = ?, page_start = ?, delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE turn_id = ?").run(messageId, page.element_id, row.stream_page_index, Number(page.page_start), row.view_version ?? 0, now(), row.worker_turn_id);
            }
          }
        }
        this.context.database.prepare("INSERT OR IGNORE INTO bridge_messages(message_id, created_at) VALUES (?, ?)").run(messageId, now());
      }
      if (row.kind === "group_card_create" && row.worker_thread_id) {
        const thread = this.workerThreads.getDeliveryTarget(row.worker_thread_id);
        if (!thread || !row.worker_id || row.worker_session_generation === null) throw new Error("Worker group card delivery returned incomplete identity");
        if (thread.state === "reserving") {
          if (!topicId) throw new Error("Worker group card delivery returned no thread identity");
          const timestamp = now();
          const settlement = this.workerThreads.settlePublication({ threadId: row.worker_thread_id, workerId: row.worker_id, workerSessionGeneration: row.worker_session_generation, viewVersion: row.view_version, messageId, cardId: cardId ?? null, topicId, occurredAt: timestamp });
          if (settlement.invalidations.length > 0) this.dependencies.invalidateCardContexts(settlement.invalidations);
        } else if (thread.state === "active") {
          this.context.database.prepare("INSERT OR IGNORE INTO bridge_messages(message_id, created_at) VALUES (?, ?)").run(messageId, now());
        } else {
          throw new Error("Worker Session thread is stale");
        }
      }
      if (row.kind === "group_card_create" && row.shortcut_panel_id) {
        if (!topicId) throw new Error("Shortcut panel delivery returned no thread identity");
        const activated = this.context.database.prepare("UPDATE shortcut_panels SET topic_id = ?, root_message_id = ?, card_id = ?, state = 'active', activated_at = ?, updated_at = ? WHERE id = ? AND state = 'reserving'").run(topicId, messageId, cardId ?? null, now(), now(), row.shortcut_panel_id);
        if (activated.changes !== 1) throw new Error("Shortcut panel is stale");
        this.context.database.prepare("INSERT OR IGNORE INTO bridge_messages(message_id, created_at) VALUES (?, ?)").run(messageId, now());
      }
      if (row.prompt_id) {
        if (row.card_role === "answer") {
          if (row.kind === "card_reply" || row.kind === "stream_card_create") {
            const metadata = row.kind === "stream_card_create" ? streamCardState(row.payload) : null;
            const expectedPageIndex = metadata && metadata.pageIndex > 0 ? metadata.pageIndex - 1 : null;
            const pageIndex = metadata?.pageIndex ?? 0;
            const updated = this.context.database.prepare("UPDATE run_cards SET answer_message_id = ?, answer_card_id = COALESCE(?, answer_card_id), answer_element_id = COALESCE(?, answer_element_id), answer_sequence = CASE WHEN ? IS NULL THEN answer_sequence ELSE 0 END, answer_page_index = COALESCE(?, answer_page_index), answer_page_start = COALESCE(?, answer_page_start), lark_message_id = CASE WHEN ? IS NULL THEN COALESCE(lark_message_id, ?) ELSE lark_message_id END, answer_delivered_version = MAX(answer_delivered_version, ?), updated_at = ? WHERE prompt_id = ? AND (? IS NULL OR answer_page_index = ?)").run(messageId, cardId ?? null, metadata?.elementId ?? null, metadata ? 1 : null, metadata?.pageIndex ?? null, metadata?.pageStart ?? null, cardId ?? null, messageId, row.view_version ?? 0, now(), row.prompt_id, expectedPageIndex, expectedPageIndex);
            if (updated.changes > 0) {
              if (pageIndex > 0) this.context.database.prepare("UPDATE answer_pages SET state = 'frozen', updated_at = ? WHERE prompt_id = ? AND state = 'active' AND page_index < ?").run(now(), row.prompt_id, pageIndex);
              this.context.database.prepare("UPDATE answer_pages SET message_id = ?, card_id = COALESCE(?, card_id), sequence = CASE WHEN ? IS NULL THEN sequence ELSE 0 END, state = 'active', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'creating'").run(messageId, cardId ?? null, cardId ?? null, now(), row.prompt_id, pageIndex);
              const latest = this.dependencies.loadRunCard(row.prompt_id);
              if (latest) this.dependencies.invalidateCardContexts([
                ...(latest.viewVersion > latest.answerDeliveredVersion ? [{ targetKind: "primary-turn" as const, targetId: latest.promptId, targetGeneration: latest.bindingGeneration, reason: "answer-create.delivered" }] : []),
                { targetKind: "primary-session", targetId: latest.bindingId, targetGeneration: latest.bindingGeneration, reason: "answer-create.delivered" }
              ]);
            }
          } else {
            this.context.database.prepare("UPDATE run_cards SET answer_delivered_version = MAX(answer_delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(row.view_version ?? 0, now(), row.prompt_id);
            const payload = parseJsonRecord(row.payload);
            const pageIndex = Number.isInteger(payload.pageIndex) ? Number(payload.pageIndex) : null;
            if (row.kind === "stream_content") this.context.database.prepare("UPDATE answer_pages SET sequence = MAX(sequence, ?), updated_at = ? WHERE prompt_id = ? AND state = 'active' AND (? IS NULL OR page_index = ?)").run(row.view_version ?? 0, now(), row.prompt_id, pageIndex, pageIndex);
            if (row.kind === "stream_finish") {
              const pendingContinuation = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' LIMIT 1").get(row.prompt_id);
              const pendingFinalUpdate = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'card_update' AND state = 'pending' AND (idempotency_key = ? OR projection_key = ?) LIMIT 1").get(row.prompt_id, `answer-final-fold:${row.prompt_id}:${pageIndex}:${row.root_message_id}`, `answer-final-fold:${row.prompt_id}:${pageIndex}:${row.root_message_id}`);
              this.context.database.prepare("UPDATE answer_pages SET sequence = MAX(sequence, ?), state = CASE WHEN ? THEN state ELSE ? END, updated_at = ? WHERE prompt_id = ? AND state = 'active' AND (? IS NULL OR page_index = ?)").run(row.view_version ?? 0, pendingFinalUpdate ? 1 : 0, pendingContinuation ? "frozen" : "finished", now(), row.prompt_id, pageIndex, pageIndex);
              if (!pendingContinuation && !pendingFinalUpdate) this.freezeRunCard(row.prompt_id);
            }
            if (row.kind === "card_update" && row.idempotency_key.startsWith("answer-final-fold:")) {
              const pendingContinuation = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' LIMIT 1").get(row.prompt_id);
              this.context.database.prepare("UPDATE answer_pages SET state = ?, updated_at = ? WHERE prompt_id = ? AND message_id = ? AND state = 'active'").run(pendingContinuation ? "frozen" : "finished", now(), row.prompt_id, row.root_message_id);
              if (!pendingContinuation) this.freezeRunCard(row.prompt_id);
            }
          }
        } else if (row.kind === "card_reply" && row.card_role !== "task") this.context.database.prepare("UPDATE run_cards SET lark_message_id = ?, delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(messageId, row.view_version ?? 0, now(), row.prompt_id);
        else this.context.database.prepare("UPDATE run_cards SET delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(row.view_version ?? 0, now(), row.prompt_id);
      }
      if (row.worker_turn_id) {
        const stream = streamCardState(row.payload);
        const pageIndex = stream?.pageIndex ?? 0;
        if (row.kind === "stream_card_create") {
          const metadata = stream;
          const expectedPageIndex = pageIndex > 0 ? pageIndex - 1 : pageIndex;
          const updated = this.context.database.prepare("UPDATE worker_turn_cards SET message_id = ?, card_id = COALESCE(?, card_id), element_id = COALESCE(?, element_id), page_index = ?, page_start = COALESCE(?, page_start), sequence = CASE WHEN ? IS NULL THEN sequence ELSE 0 END, delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE turn_id = ? AND page_index = ?").run(messageId, cardId ?? null, metadata?.elementId ?? null, pageIndex, metadata?.pageStart ?? null, cardId ?? null, row.view_version ?? 0, now(), row.worker_turn_id, expectedPageIndex);
          if (updated.changes > 0) {
            if (pageIndex > 0) this.context.database.prepare("UPDATE worker_turn_card_pages SET state = 'frozen', updated_at = ? WHERE turn_id = ? AND state = 'active' AND page_index < ?").run(now(), row.worker_turn_id, pageIndex);
            this.context.database.prepare("UPDATE worker_turn_card_pages SET message_id = ?, card_id = COALESCE(?, card_id), state = 'active', sequence = CASE WHEN ? IS NULL THEN sequence ELSE 0 END, updated_at = ? WHERE turn_id = ? AND page_index = ? AND state = 'creating'").run(messageId, cardId ?? null, cardId ?? null, now(), row.worker_turn_id, pageIndex);
            const latest = this.dependencies.loadWorkerTurnCard(row.worker_turn_id);
            if (latest) {
              const main = this.dependencies.loadWorkerMainView(latest.instanceId, latest.workerSessionGeneration);
              this.dependencies.invalidateCardContexts([
                { targetKind: "worker-session", targetId: latest.instanceId, targetGeneration: latest.workerSessionGeneration, reason: "worker-turn-create.delivered" },
                ...(main ? [{ targetKind: "primary-session" as const, targetId: main.parentBindingId, targetGeneration: main.parentBindingGeneration, reason: "worker-turn-create.delivered" }] : []),
                ...(latest.primaryAnswer ? [{ targetKind: "primary-turn" as const, targetId: latest.primaryAnswer.aggregateId, targetGeneration: latest.primaryAnswer.generation, reason: "worker-turn-create.delivered" }] : [])
              ]);
            }
          }
        } else {
          this.context.database.prepare("UPDATE worker_turn_cards SET delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE turn_id = ?").run(row.view_version ?? 0, now(), row.worker_turn_id);
          if (row.kind === "stream_content") this.context.database.prepare("UPDATE worker_turn_card_pages SET sequence = MAX(sequence, ?), updated_at = ? WHERE turn_id = ? AND page_index = ?").run(row.view_version ?? 0, now(), row.worker_turn_id, pageIndex);
          if (row.kind === "stream_finish") {
            const pendingContinuation = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_card_create' AND state = 'pending' LIMIT 1").get(row.worker_turn_id);
            this.context.database.prepare("UPDATE worker_turn_card_pages SET sequence = MAX(sequence, ?), state = ?, updated_at = ? WHERE turn_id = ? AND page_index = ? AND state = 'active'").run(row.view_version ?? 0, pendingContinuation ? "frozen" : "finished", now(), row.worker_turn_id, pageIndex);
          }
        }
      }
      const workerId = row.worker_id;
      const workerSessionGeneration = row.worker_session_generation;
      const workerMainDeliveryKind = row.kind === "card_reply" || row.kind === "card_update";
      const workerMainProjection = workerId !== null && workerSessionGeneration !== null && row.worker_turn_id === null
        && workerMainDeliveryKind
        && (row.projection_key === `worker-main:${workerId}:${workerSessionGeneration}`
          || (row.projection_key === null
            && row.view_version !== null
            && row.prompt_id === null
            && row.card_role === null
            && row.target_role === null
            && row.selection_id === null
            && row.thread_alias_id === null
            && row.worker_thread_id === null));
      if (workerMainProjection) {
        const messageCheckpoint = row.kind === "card_reply" ? messageId : null;
        const cardCheckpoint = row.kind === "card_reply" ? cardId ?? null : null;
        this.context.database.prepare(`UPDATE worker_main_views SET delivered_version = MAX(delivered_version, ?), message_id = COALESCE(?, message_id), card_id = COALESCE(?, card_id), state_json = json_set(state_json, '$.deliveredVersion', MAX(COALESCE(json_extract(state_json, '$.deliveredVersion'), 0), ?), '$.messageId', COALESCE(?, json_extract(state_json, '$.messageId')), '$.cardId', COALESCE(?, json_extract(state_json, '$.cardId'))), updated_at = ? WHERE worker_id = ? AND worker_session_generation = ?`).run(row.view_version ?? 0, messageCheckpoint, cardCheckpoint, row.view_version ?? 0, messageCheckpoint, cardCheckpoint, now(), workerId, workerSessionGeneration);
        if (messageCheckpoint) {
          const main = this.dependencies.loadWorkerMainView(workerId, workerSessionGeneration);
          if (main) this.dependencies.invalidateCardContexts([
            { targetKind: "worker-session", targetId: main.workerId, targetGeneration: main.workerSessionGeneration, reason: "worker-main.delivered" },
            { targetKind: "primary-session", targetId: main.parentBindingId, targetGeneration: main.parentBindingGeneration, reason: "worker-main.delivered" }
          ]);
        }
      }
      if (row.prompt_id && row.card_role === "answer" && (row.kind === "card_reply" || row.kind === "stream_card_create")) {
        // Historical Worker Task Cards no longer mirror Primary Answer delivery.
      }
      if (row.selection_id && row.kind === "card_reply") this.context.database.prepare("UPDATE project_selections SET selector_message_id = ?, updated_at = ? WHERE id = ?").run(messageId, now(), row.selection_id);
      if (row.projection_key?.startsWith("command-status:")) this.settleCommandStatusProjection(row, messageId, cardId ?? null);
      if (row.projection_key?.startsWith("human-review:")) {
        const surfaces = new SqliteHumanReviewSurfaceStore(this.context);
        if (this.preparedDeliveryReservation && this.preparedDeliveryConsumer) surfaces.setPreparedDeliveryReservation(this.preparedDeliveryReservation, this.preparedDeliveryConsumer);
        surfaces.checkpoint({ replyId: row.id, projectionKey: row.projection_key, snapshotRevision: row.snapshot_revision, messageId, cardId: cardId ?? null });
      }
      if (row.projection_key?.startsWith("completion-review:") && row.kind === "card_reply") {
        new SqliteCompletionReviewStore(this.context).activatePresentation({
          replyId: row.id, messageId, cardId: cardId ?? null, occurredAt: now()
        });
      }
      if (row.projection_key?.startsWith("conversation-turn:")) this.settleConversationTurnProjection(row, messageId, cardId ?? null);
      if (row.projection_key?.startsWith("input-card:")) this.settleInputCardProjection(row, messageId, cardId ?? null);
      if (row.binding_id && row.target_role === "session_status") {
        const binding = this.dependencies.getBinding(row.binding_id);
        if (!binding) throw new Error(`Binding not found: ${row.binding_id}`);
        if (row.kind === "card_reply") this.dependencies.persistBindingPatch(row.binding_id, { statusMessageId: messageId, statusCardSequence: 0 });
        else if (row.kind === "card_update" && row.card_sequence !== null) this.dependencies.persistBindingPatch(row.binding_id, { statusCardSequence: Math.max(binding.statusCardSequence, row.card_sequence) });
        this.context.database.prepare(`UPDATE topic_views SET state_json = json_set(state_json, '$.deliveredVersion', MAX(COALESCE(json_extract(state_json, '$.deliveredVersion'), 0), ?)), updated_at = ? WHERE binding_id = ?`).run(row.view_version ?? 0, now(), row.binding_id);
      }
      confirmDeliveryRecoveries(this.context, id);
      confirmAnswerRecoveries(this.context, id);
      settleAnswerTimelinePageCheckpoint(this.context, id);
      releaseCompletionNotificationForDeliveredReply(this.context, {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        kind: row.kind,
        payload: row.payload,
        promptId: row.prompt_id,
        workerTurnId: row.worker_turn_id,
        rootMessageId: row.root_message_id,
        projectionKey: row.projection_key
      }, this.preparedDeliveryReservation && this.preparedDeliveryConsumer ? { reservation: this.preparedDeliveryReservation, consumer: this.preparedDeliveryConsumer } : undefined);
      new SqliteProjectionGapStore(this.context).compensateDeliveryForReply(id, row.view_version ?? 0, now());
      return true;
    });
  }

  private settleCommandStatusProjection(row: { projection_key: string | null; snapshot_revision: number; kind: string; binding_id: string | null }, messageId: string, cardId: string | null): void {
    if (!row.projection_key) return;
    const intentId = row.projection_key.slice("command-status:".length);
    if (row.kind === "card_reply") this.context.database.prepare("UPDATE command_status_views SET message_id = COALESCE(message_id, ?), card_id = COALESCE(card_id, ?), delivered_revision = MAX(delivered_revision, ?), updated_at = ? WHERE intent_id = ?").run(messageId, cardId, row.snapshot_revision, now(), intentId);
    else this.context.database.prepare("UPDATE command_status_views SET delivered_revision = MAX(delivered_revision, ?), updated_at = ? WHERE intent_id = ?").run(row.snapshot_revision, now(), intentId);
    const latest = this.context.database.prepare("SELECT message_id, card_json, revision, delivered_revision FROM command_status_views WHERE intent_id = ?").get(intentId) as { message_id: string | null; card_json: string; revision: number; delivered_revision: number } | undefined;
    if (!latest?.message_id || latest.revision <= latest.delivered_revision) return;
    const context = this.context.database.prepare("SELECT context_json FROM swarm_command_intents WHERE id=?").get(intentId) as { context_json: string } | undefined;
    const primary = context ? (JSON.parse(context.context_json) as { primary?: { bindingId?: string; bindingGeneration?: number } | null }).primary : null;
    const bindingId = typeof primary?.bindingId === "string" ? primary.bindingId : null;
    const bindingGeneration = typeof primary?.bindingGeneration === "number" ? primary.bindingGeneration : null;
    const outbound = { id: `${row.projection_key}:update:${latest.revision}`, idempotencyKey: `${row.projection_key}:update:${latest.revision}`, bindingId, bindingGeneration, targetRole: "operation_result" as const, rootMessageId: latest.message_id, kind: "card_update" as const, payload: latest.card_json, projectionKey: row.projection_key, snapshotRevision: latest.revision, laneKeyOverride: row.projection_key };
    if (bindingId && bindingGeneration !== null) this.enqueuePrimary(outbound);
    else this.enqueueGlobal(outbound);
  }

  private settleConversationTurnProjection(row: { projection_key: string | null; snapshot_revision: number; kind: string; binding_id: string | null }, messageId: string, cardId: string | null): void {
    const prefix = "conversation-turn:";
    const suffix = ":answer";
    if (!row.projection_key?.startsWith(prefix) || !row.projection_key.endsWith(suffix)) return;
    const projectionId = row.projection_key.slice(prefix.length, -suffix.length);
    const timestamp = now();
    if (row.kind === "card_reply") {
      this.context.database.prepare(`UPDATE conversation_turn_projections
        SET answer_message_id = COALESCE(answer_message_id, ?), answer_card_id = COALESCE(answer_card_id, ?),
          delivered_revision = MAX(delivered_revision, ?), updated_at = ?
        WHERE projection_id = ?`).run(messageId, cardId, row.snapshot_revision, timestamp, projectionId);
    } else {
      this.context.database.prepare(`UPDATE conversation_turn_projections
        SET delivered_revision = MAX(delivered_revision, ?), updated_at = ?
        WHERE projection_id = ?`).run(row.snapshot_revision, timestamp, projectionId);
    }
    const latest = this.context.database.prepare(`SELECT binding_id, answer_message_id, answer_card_json,
        json_extract(state_json, '$.viewVersion') AS revision, delivered_revision
      FROM conversation_turn_projections WHERE projection_id = ?`).get(projectionId) as {
      binding_id: string | null; answer_message_id: string | null; answer_card_json: string | null;
      revision: number | null; delivered_revision: number;
    } | undefined;
    if (!latest?.binding_id || !latest.answer_message_id || !latest.answer_card_json
      || latest.revision === null || Number(latest.revision) <= Number(latest.delivered_revision)) return;
    const bindingGeneration = (this.context.database.prepare("SELECT binding_generation FROM run_cards WHERE prompt_id=?").get(projectionId) as { binding_generation: number } | undefined)?.binding_generation ?? null;
    this.enqueuePrimary({
      id: `${row.projection_key}:update:${latest.revision}`,
      idempotencyKey: `${row.projection_key}:update:${latest.revision}`,
      bindingId: latest.binding_id,
      bindingGeneration,
      promptId: projectionId,
      cardRole: "answer",
      rootMessageId: latest.answer_message_id,
      kind: "card_update",
      payload: latest.answer_card_json,
      projectionKey: row.projection_key,
      snapshotRevision: Number(latest.revision),
      laneKeyOverride: row.projection_key
    });
  }

  private settleInputCardProjection(row: { projection_key: string | null; snapshot_revision: number; kind: string }, messageId: string, cardId: string | null): void {
    if (!row.projection_key) return;
    const submissionId = row.projection_key.slice("input-card:".length);
    const timestamp = now();
    if (row.kind === "card_reply") {
      this.context.database.prepare(`UPDATE input_card_views
        SET message_id = COALESCE(message_id, ?), card_id = COALESCE(card_id, ?), delivered_revision = MAX(delivered_revision, ?), updated_at = ?
        WHERE submission_id = ?`).run(messageId, cardId, row.snapshot_revision, timestamp, submissionId);
    } else {
      this.context.database.prepare(`UPDATE input_card_views SET delivered_revision = MAX(delivered_revision, ?), updated_at = ? WHERE submission_id = ?`)
        .run(row.snapshot_revision, timestamp, submissionId);
    }
    const latest = this.context.database.prepare("SELECT message_id, card_json, revision, delivered_revision FROM input_card_views WHERE submission_id = ?")
      .get(submissionId) as { message_id: string | null; card_json: string; revision: number; delivered_revision: number } | undefined;
    if (!latest?.message_id || latest.revision <= latest.delivered_revision) return;
    const owner = this.context.database.prepare("SELECT owner_kind,owner_id,owner_generation FROM submission_intents WHERE submission_id=?").get(submissionId) as { owner_kind: "primary" | "worker"; owner_id: string; owner_generation: number } | undefined;
    const primary = owner?.owner_kind === "primary";
    if (primary && !this.hasExactActiveBinding(owner.owner_id, owner.owner_generation)) return;
    const outbound = {
      id: `${row.projection_key}:update:${latest.revision}`,
      idempotencyKey: `${row.projection_key}:update:${latest.revision}`,
      bindingId: primary ? owner.owner_id : null, bindingGeneration: primary ? owner.owner_generation : null,
      targetRole: "operation_result" as const, rootMessageId: latest.message_id, kind: "card_update" as const, payload: latest.card_json,
      projectionKey: row.projection_key, snapshotRevision: latest.revision, laneKeyOverride: row.projection_key
    };
    if (primary) this.enqueuePrimary(outbound);
    else this.enqueueGlobal(outbound);
  }

  checkpointCard(id: string, cardId: string, claim?: OutboundDeliveryClaim): OutboundReply | null {
    return this.context.transaction("sqlite.outbox-delivery-store.write", () => {
      if (!this.queue.matchesClaim(id, claim)) return null;
      const checkpoint = JSON.stringify({ kind: "surface", gatewayId: claim?.reply.gatewayId ?? "feishu:primary", opaqueId: cardId });
      const updated = this.context.database.prepare("UPDATE outbound_replies SET card_id_checkpoint = COALESCE(card_id_checkpoint, ?), gateway_checkpoint_json = COALESCE(gateway_checkpoint_json, ?), updated_at = ? WHERE id = ? AND state = 'pending' AND (card_id_checkpoint IS NULL OR card_id_checkpoint = ?) AND (gateway_checkpoint_json IS NULL OR gateway_checkpoint_json = ?)").run(cardId, checkpoint, now(), id, cardId, checkpoint);
      return updated.changes === 1 ? this.queue.get(id) : null;
    });
  }

  private enqueuePrimary(input: Parameters<SqliteOutboxQueueStore["enqueue"]>[0]): void {
    if (!input.bindingId || input.bindingGeneration === null || input.bindingGeneration === undefined
      || !this.hasExactActiveBinding(input.bindingId, input.bindingGeneration)) return;
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Outbox Delivery prepared delivery is not connected");
    this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply(input));
  }
  private enqueueGlobal(input: Parameters<SqliteOutboxQueueStore["enqueue"]>[0]): void {
    const scoped = { ...input, globalDelivery: true as const };
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Outbox Delivery prepared delivery is not connected");
    this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply(scoped));
  }
  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void { queueMicrotask(() => { for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery); }); }
  private hasExactActiveBinding(id: string, generation: number): boolean { return this.context.database.prepare("SELECT 1 FROM bindings WHERE id=? AND generation=? AND state='active' AND lifecycle='active' AND attachment='attached'").get(id, generation) !== undefined; }

  markFailed(id: string, error: string, retryDelayMs?: number, metadata?: DeliveryFailureMetadata, claim?: OutboundDeliveryClaim): OutboundReply | null {
    return this.context.transaction("sqlite.outbox-delivery-store.write", () => {
      if (!this.queue.matchesClaim(id, claim)) return null;
      const row = this.context.database.prepare("SELECT attempt_count, state FROM outbound_replies WHERE id = ?").get(id) as { attempt_count: number; state: OutboundReply["state"] } | undefined;
      if (!row || row.state !== "pending") return null;
      const timestamp = now();
      const retry = planDeliveryRetry({
        previousAttemptCount: Number(row.attempt_count), nowMs: Date.parse(timestamp),
        ...(retryDelayMs === undefined ? {} : { explicitDelayMs: retryDelayMs })
      });
      const deadLetteredAt = retry.exhausted ? timestamp : null;
      const certainty = deliveryEffectCertainty(metadata);
      const updated = this.context.database.prepare(`UPDATE outbound_replies SET state = CASE WHEN ? THEN 'dead_letter' ELSE state END, error = ?, attempt_count = ?, claim_attempt_id = NULL, claimed_fence = NULL, claimed_owner_id = NULL, claimed_at = NULL, claim_expires_at = NULL, next_attempt_at = ?, failure_class = ?, effect_certainty = ?, http_status = ?, lark_error_code = ?, dead_lettered_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'`).run(retry.exhausted ? 1 : 0, boundedError(error), retry.attemptCount, retry.nextAttemptAt, metadata?.failureClass ?? "unknown", certainty, metadata?.httpStatus ?? null, metadata?.larkErrorCode ?? null, deadLetteredAt, timestamp, id);
      if (updated.changes !== 1) return null;
      if (metadata?.httpStatus === 429 && claim) this.cooldown.extend(retry.nextAttemptAt, error, metadata, timestamp);
      return this.queue.get(id);
    });
  }

  markDeadLetter(id: string, error: string, metadata?: DeliveryFailureMetadata, claim?: OutboundDeliveryClaim): OutboundReply | null {
    return this.context.transaction("sqlite.outbox-delivery-store.write", () => {
      if (!this.queue.matchesClaim(id, claim)) return null;
      const timestamp = now();
      const updated = this.context.database.prepare("UPDATE outbound_replies SET state = 'dead_letter', claim_attempt_id = NULL, claimed_fence = NULL, claimed_owner_id = NULL, claimed_at = NULL, claim_expires_at = NULL, error = ?, failure_class = ?, effect_certainty = ?, http_status = ?, lark_error_code = ?, dead_lettered_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'pending'").run(boundedError(error), metadata?.failureClass ?? "permanent", deliveryEffectCertainty(metadata), metadata?.httpStatus ?? null, metadata?.larkErrorCode ?? null, timestamp, timestamp, id);
      return updated.changes === 1 ? this.queue.get(id) : null;
    });
  }

  private freezeRunCard(promptId: string): void {
    const run = this.dependencies.loadRunCard(promptId);
    if (run) this.dependencies.saveRunCard(freezeRunCardWorkerContext(run, now()));
  }
}

export function boundedOutboxError(value: string | null): string { return (value ?? "Unknown failure").slice(0, 500); }
function boundedError(value: string | null): string { return boundedOutboxError(value); }
function now(): string { return new Date().toISOString(); }
function deliveryEffectCertainty(metadata?: DeliveryFailureMetadata): import("../../domain/delivery.js").DeliveryEffectCertainty {
  if (metadata?.effectCertainty) return metadata.effectCertainty;
  if (metadata?.httpStatus !== null && metadata?.httpStatus !== undefined || metadata?.larkErrorCode !== null && metadata?.larkErrorCode !== undefined || metadata?.failureClass === "permanent") return "rejected";
  return metadata?.failureClass === "transient" ? "not-started" : "uncertain";
}
function streamCardState(payload: string): { pageIndex: number; pageStart: number; elementId: string } | null {
  try {
    const decoded = JSON.parse(payload) as { stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown } };
    const stream = decoded.stream;
    return stream && Number.isInteger(stream.pageIndex) && Number.isInteger(stream.pageStart) && typeof stream.elementId === "string"
      ? { pageIndex: Number(stream.pageIndex), pageStart: Number(stream.pageStart), elementId: stream.elementId } : null;
  } catch { return null; }
}
function parseJsonRecord(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value) as unknown; return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}
