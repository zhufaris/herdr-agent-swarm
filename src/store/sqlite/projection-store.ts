import { randomUUID } from "node:crypto";
import type { AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, AnswerTimelinePageCheckpoint, Binding, MainCardReservationOutcome, OutboundReply, OutboundReplyState, OutboundWorkClass } from "../../domain/types.js";
import type { AnswerSegment } from "../../domain/answer-segment.js";
import type { AnswerTimelineItem } from "../../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../../domain/delivery.js";
import type { MainCardLiveStatus, RunCardView } from "../../domain/run-card-view.js";
import { initialTopicView, type TopicViewState } from "../../domain/topic-view.js";
import type { ModelPreference } from "../../domain/model-selection.js";
import { mapAnswerPage, mapBinding, type AnswerPageRow, type BindingRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";
import { incrementPrimaryAnswerPageSequence } from "./answer-page-sequence.js";
import { linkAnswerRecovery, linkAnswerRecoverySnapshot, linkExpiredAnswerRecoverySnapshot, recordAnswerCoverage } from "./delivery-recovery-evidence.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import { SqliteAnswerSegmentStore, type ReserveHumanMessageAnswerSegmentsInput, type ReserveHumanMessageAnswerSegmentsResult } from "./answer-segment-store.js";
import { SqliteAnswerTimelineStore } from "./answer-timeline-store.js";
import { SqliteCoreEventInboxStore } from "./core-event-inbox-store.js";
import { CORE_EVENT_REDUCER_REVISION, type CoreEventProjectionOwner, type CoreEventProjectionResult, type CoreEventProjectionSettlement } from "../../domain/core-event-inbox.js";
import { SqliteAnswerTimelinePageStore } from "./answer-timeline-page-store.js";
import { SqliteProjectionGapStore } from "./projection-gap-store.js";
import type { ProjectionGapQuery, ProjectionGapSummary } from "../../domain/projection-gap.js";
import { listPromptIdentityPromptIds, resolvedPromptReferenceSql } from "./prompt-identity-corrections.js";
import { COMPLETION_ACTION_SELECTIONS, completionReviewActionSetIdentity, type CompletionActionSelection, type CompletionActionSetRenderState } from "../../domain/completion-action-set.js";
import { canMentionFeishuOpenId } from "../../domain/human-review.js";
import { loadCompletionChoice } from "./completion-choice-store.js";
import { actionablePrimaryAnswerProjectionDebtSql } from "./primary-answer-recovery-sql.js";
import { recoverCompletionNotification } from "./completion-notification-store.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import { SqliteCompletionReviewStore } from "./completion-review-store.js";
import type { PrimaryCompletionReviewDecision } from "../../domain/ports/workflow.js";

const noFrozenCurrentAnswerEffectSql = `NOT EXISTS (
  SELECT 1 FROM outbound_replies frozen
  WHERE frozen.prompt_id = card.prompt_id
    AND frozen.kind = 'card_update' AND frozen.card_role = 'answer'
    AND frozen.view_version = card.view_version
    AND frozen.state IN ('delivered','dead_letter','dismissed')
    AND (frozen.gateway_plan_json IS NOT NULL OR frozen.gateway_plan_hash IS NOT NULL
      OR frozen.first_claimed_at IS NOT NULL OR frozen.attempt_count > 0 OR frozen.card_id_checkpoint IS NOT NULL)
)`;

export const answerPageDeliveryFactsSql = {
  latestContent: `
    SELECT payload, state, view_version
    FROM outbound_replies INDEXED BY outbound_replies_prompt_kind_state_updated
    WHERE prompt_id = ? AND card_role = 'answer' AND kind = 'stream_content'
      AND state IN ('pending','delivered','dead_letter','dismissed')
      AND (
        stream_page_index = ?
        OR (stream_page_index IS NULL AND json_valid(payload)
          AND (json_extract(payload, '$.elementId') = ? OR json_extract(payload, '$.pageIndex') = ?))
      )
    ORDER BY delivery_order DESC LIMIT 1
  `,
  pendingFinish: `
    SELECT 1 FROM outbound_replies INDEXED BY outbound_replies_prompt_kind_state_updated
    WHERE prompt_id = ? AND card_role = 'answer' AND kind = 'stream_finish' AND state = 'pending'
      AND (stream_page_index = ? OR (stream_page_index IS NULL AND CASE
        WHEN json_valid(payload) THEN json_extract(payload, '$.pageIndex') IS NULL OR json_extract(payload, '$.pageIndex') = ?
        ELSE 1
      END))
    LIMIT 1
  `,
  pendingContinuation: `
    SELECT 1 FROM outbound_replies INDEXED BY outbound_replies_prompt_kind_state_updated
    WHERE prompt_id = ? AND card_role = 'answer' AND kind = 'stream_card_create' AND state = 'pending'
      AND (stream_page_index = ? OR (stream_page_index IS NULL AND json_valid(payload) AND json_extract(payload, '$.stream.pageIndex') = ?))
    LIMIT 1
  `,
  finalUpdate: `
    SELECT state FROM outbound_replies INDEXED BY outbound_replies_prompt_kind_state_updated
    WHERE prompt_id = ? AND card_role = 'answer' AND kind = 'card_update'
      AND state IN ('pending','delivered','dead_letter','dismissed')
      AND (idempotency_key = ? OR substr(idempotency_key, 1, length(?)) = ?)
    ORDER BY delivery_order DESC LIMIT 1
  `
} as const;

export class SqliteProjectionStore {
  private readonly timelines: SqliteAnswerTimelineStore;
  private readonly timelinePages: SqliteAnswerTimelinePageStore;
  private readonly segments: SqliteAnswerSegmentStore;
  private readonly completionReviews: SqliteCompletionReviewStore;
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      enqueueOutboundReply(input: EnqueueOutboundReplyInput): unknown;
      hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean;
      getBinding(id: string): Binding | null;
      getModelPreference(bindingId: string): ModelPreference | null;
    }
  ) {
    this.timelines = new SqliteAnswerTimelineStore(context);
    this.timelinePages = new SqliteAnswerTimelinePageStore(context);
    this.segments = new SqliteAnswerSegmentStore(context);
    this.completionReviews = new SqliteCompletionReviewStore(context);
  }

  setPreparedMainCardDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
    this.segments.setPreparedDeliveryReservation(reservation, consumer);
  }

  listRecoverablePrimaryAnswerPromptIds(limit: number): readonly string[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const rows = this.context.database.prepare(`
      SELECT candidate.prompt_id
      FROM (
        SELECT failed.prompt_id, recovery.updated_at
        FROM delivery_recoveries recovery
        JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
        WHERE recovery.state IN ('unresolved','replacement_pending')
          AND recovery.action IN ('rebuild_answer','expired_view_target')
          AND failed.card_role = 'answer' AND failed.prompt_id IS NOT NULL
        UNION ALL
        SELECT card.prompt_id, card.updated_at
        ${actionablePrimaryAnswerProjectionDebtSql}
      ) candidate
      GROUP BY candidate.prompt_id
      ORDER BY MIN(candidate.updated_at), candidate.prompt_id
      LIMIT ?
    `).all(limit) as Array<{ prompt_id: string }>;
    return rows.map(({ prompt_id }) => prompt_id);
  }

  listRecoverablePrimaryAnswerPromptIdsForBinding(bindingId: string, limit: number): readonly string[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const rows = this.context.database.prepare(`
      SELECT candidate.prompt_id
      FROM (
        SELECT failed.prompt_id, recovery.updated_at
        FROM delivery_recoveries recovery
        JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
        WHERE recovery.state IN ('unresolved','replacement_pending')
          AND recovery.action IN ('rebuild_answer','expired_view_target')
          AND failed.card_role = 'answer' AND failed.prompt_id IS NOT NULL
          AND failed.binding_id = ?
        UNION ALL
        SELECT card.prompt_id, card.updated_at
        ${actionablePrimaryAnswerProjectionDebtSql}
          AND card.binding_id = ?
      ) candidate
      GROUP BY candidate.prompt_id
      ORDER BY MIN(candidate.updated_at), candidate.prompt_id
      LIMIT ?
    `).all(bindingId, bindingId, limit) as Array<{ prompt_id: string }>;
    return rows.map(({ prompt_id }) => prompt_id);
  }

  getBinding(id: string): Binding | null { return this.dependencies.getBinding(id); }
  getModelPreference(bindingId: string): ModelPreference | null { return this.dependencies.getModelPreference(bindingId); }
  listAnswerSegments(aggregateKind: "primary-run" | "worker-turn", aggregateId: string): AnswerSegment[] {
    return this.segments.listAnswerSegments(aggregateKind, aggregateId);
  }
  reserveHumanMessageAnswerSegments(input: ReserveHumanMessageAnswerSegmentsInput): ReserveHumanMessageAnswerSegmentsResult {
    return this.context.transaction("sqlite.projection-store.write", () => this.segments.reserveHumanMessageAnswerSegments(input));
  }

  projectCoreEvent<Result>(settlement: CoreEventProjectionSettlement, projectionOwner: CoreEventProjectionOwner, operation: () => Result): CoreEventProjectionResult<Result> {
    return this.context.transaction("sqlite.projection-store.write", () => {
      const eventIds = [...new Set(settlement.eventIds)];
      const applied = eventIds.filter((eventId) => this.context.database.prepare(`SELECT 1 FROM core_event_owner_projections
        WHERE owner_kind = ? AND owner_id = ? AND event_id = ? AND reducer_revision = ?`).get(
          projectionOwner.kind, projectionOwner.id, eventId, CORE_EVENT_REDUCER_REVISION
        ));
      if (applied.length > 0 && applied.length !== eventIds.length) throw new Error("Core event projection settlement mixes current and unapplied events");
      const current = applied.length === eventIds.length;
      const value = current ? undefined : operation();
      if (!current) {
        const insert = this.context.database.prepare(`INSERT INTO core_event_owner_projections(
          owner_kind, owner_id, event_id, reducer_revision, projected_at
        ) VALUES (?, ?, ?, ?, ?)`);
        for (const eventId of eventIds) insert.run(projectionOwner.kind, projectionOwner.id, eventId, CORE_EVENT_REDUCER_REVISION, settlement.occurredAt);
      }
      new SqliteCoreEventInboxStore(this.context).acknowledge(
        settlement.laneId,
        settlement.eventIds,
        "projected",
        settlement.occurredAt,
        undefined,
        settlement.owner
      );
      return current ? { outcome: "current" } : { outcome: "projected", value: value! };
    });
  }

  listStartupViewBindings(bindingIds?: readonly string[]): Binding[] {
    if (bindingIds?.length === 0) return [];
    const idFilter = bindingIds ? `AND binding.id IN (${bindingIds.map(() => "?").join(", ")})` : "";
    const rows = this.context.database.prepare(`
      SELECT binding.* FROM bindings binding
      LEFT JOIN topic_views topic ON topic.binding_id = binding.id
      WHERE NOT (binding.lifecycle IN ('archived','closed','failed') AND binding.pane_id IS NULL)
        AND (
        binding.lifecycle NOT IN ('archived','closed','failed')
        OR topic.binding_id IS NULL
        OR COALESCE(json_extract(topic.state_json, '$.viewVersion'), 1) > COALESCE(json_extract(topic.state_json, '$.deliveredVersion'), 0)
        OR EXISTS (SELECT 1 FROM run_cards card WHERE card.binding_id = binding.id AND (
          card.phase IN ('queued','submitted','running','recovering','uncertain','blocked') OR card.answer_message_id IS NULL
          OR card.view_version > card.answer_delivered_version
          OR EXISTS (SELECT 1 FROM answer_pages page WHERE page.prompt_id = card.prompt_id AND (page.state = 'creating' OR (page.state = 'active' AND page.delivery_mode = 'streaming')))
        ))
        OR EXISTS (SELECT 1 FROM outbound_replies reply WHERE reply.binding_id = binding.id AND reply.state = 'pending')
        OR EXISTS (SELECT 1 FROM delivery_recoveries recovery JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id WHERE failed.binding_id = binding.id AND (
          recovery.state = 'replacement_pending'
          OR EXISTS (SELECT 1 FROM outbox_lane_quarantines quarantine WHERE quarantine.failed_reply_id = recovery.failed_reply_id AND quarantine.state = 'active')
        ))
      ) ${idFilter}
      ORDER BY binding.created_at, binding.id
    `).all(...(bindingIds ?? [])) as BindingRow[];
    return rows.map(mapBinding);
  }

  saveTopicView(view: TopicViewState): void {
    const current = this.loadTopicView(view.bindingId);
    if (current && current.viewVersion > view.viewVersion) return;
    const persisted = { ...view, deliveredVersion: Math.max(view.deliveredVersion, current?.deliveredVersion ?? 0) };
    this.context.database.prepare(`
      INSERT INTO topic_views(binding_id, state_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(view.bindingId, JSON.stringify(persisted), now());
  }

  saveGoalProjection(topic: TopicViewState, runCards: readonly RunCardView[]): RunCardView[] {
    return this.context.transaction("sqlite.projection-store.write", () => {
      const binding = this.getBinding(topic.bindingId);
      if (!binding || binding.generation !== topic.bindingGeneration) return [];
      this.saveTopicView(topic);
      return runCards
        .filter((run) => run.bindingId === topic.bindingId && run.bindingGeneration === binding.generation && ["queued", "submitted", "running", "recovering", "uncertain", "blocked"].includes(run.phase))
        .map((run) => this.saveRunCard(run));
    });
  }

  loadTopicView(bindingId: string): TopicViewState | null {
    const row = this.context.database.prepare("SELECT state_json FROM topic_views WHERE binding_id = ?").get(bindingId) as { state_json: string } | undefined;
    if (!row) return null;
    const stored = JSON.parse(row.state_json) as Partial<TopicViewState>;
    const view = { ...initialTopicView(bindingId), ...stored, bindingId };
    return {
      ...view,
      nativeInputBacklog: view.nativeInputBacklog && Number.isInteger(view.nativeInputBacklog.unbatchedInputCount) && Number.isInteger(view.nativeInputBacklog.pendingBatchCount)
        ? view.nativeInputBacklog
        : { unbatchedInputCount: 0, pendingBatchCount: 0 },
      recentProgress: Array.isArray(view.recentProgress) ? view.recentProgress : [],
      timelineItems: Array.isArray(view.timelineItems) ? view.timelineItems : [],
      liveStatus: normalizeLiveStatus(view.liveStatus),
      viewVersion: Number.isInteger(stored.viewVersion) ? stored.viewVersion! : 1,
      deliveredVersion: Number.isInteger(stored.deliveredVersion) ? stored.deliveredVersion! : 0
    };
  }

  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object, workClass?: OutboundWorkClass, paneEntryCard?: object): MainCardReservationOutcome {
    return this.context.transaction("sqlite.projection-store.write", () => {
      this.saveTopicView(view);
      return this.reserveMainCardIntent(view, rootMessageId, card, workClass, paneEntryCard);
    });
  }

  reserveMainCardIntent(view: TopicViewState, rootMessageId: string | null, card: object, workClass?: OutboundWorkClass, paneEntryCard?: object): MainCardReservationOutcome {
    if (!rootMessageId) return "current";
    const current = this.loadTopicView(view.bindingId);
    if (!current || current.viewVersion !== view.viewVersion) return "waiting";
    const binding = this.requireBinding(view.bindingId);
    let reserved = false;
    let waiting = false;
    if (current.viewVersion > current.deliveredVersion) {
      const replacementPending = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND kind = 'card_reply' AND state = 'pending' LIMIT 1").get(view.bindingId);
      const existingCurrent = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND view_version >= ? LIMIT 1").get(view.bindingId, current.viewVersion);
      if (replacementPending || existingCurrent) waiting = true;
      else if (!binding.statusMessageId) {
        this.reserveMainCardDelivery({ id: randomUUID(), idempotencyKey: `status-card:${view.bindingId}`, bindingId: view.bindingId, bindingGeneration: binding.generation, viewVersion: current.viewVersion, targetRole: "session_status", ...outboundWorkClass(workClass), rootMessageId, kind: "card_reply", payload: JSON.stringify(card) });
        reserved = true;
      } else {
        this.reserveMainCardDelivery({ id: randomUUID(), idempotencyKey: `main-card:update:${view.bindingId}:${current.viewVersion}`, bindingId: view.bindingId, bindingGeneration: binding.generation, viewVersion: current.viewVersion, cardSequence: this.nextMainCardSequence(binding), targetRole: "session_status", ...outboundWorkClass(workClass), rootMessageId: binding.statusMessageId, kind: "card_update", payload: JSON.stringify(card) });
        reserved = true;
      }
    }
    for (const alias of paneEntryCard ? this.listActivePaneEntryTargets(binding) : []) {
      const idempotencyKey = `pane-entry:update:${alias.id}:${current.viewVersion}`;
      const existing = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key = ?").get(idempotencyKey);
      if (existing) { waiting = true; continue; }
      const createAtCurrentVersion = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE thread_alias_id = ? AND kind = 'group_card_create' AND view_version >= ? LIMIT 1").get(alias.id, current.viewVersion);
      if (createAtCurrentVersion) continue;
      this.reserveMainCardDelivery({ id: randomUUID(), idempotencyKey, bindingId: binding.id, bindingGeneration: binding.generation, viewVersion: current.viewVersion, threadAliasId: alias.id, ...outboundWorkClass(workClass), rootMessageId: alias.rootMessageId, kind: "card_update", payload: JSON.stringify(paneEntryCard), laneKeyOverride: `pane-entry:${alias.id}` });
      reserved = true;
    }
    return reserved ? "reserved" : waiting ? "waiting" : "current";
  }

  private listActivePaneEntryTargets(binding: Binding): Array<{ id: string; rootMessageId: string }> {
    if (!binding.paneId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return [];
    return this.context.database.prepare(`SELECT id, root_message_id
      FROM binding_thread_aliases
      WHERE binding_id = ? AND binding_generation = ? AND pane_id = ?
        AND state = 'active' AND root_message_id IS NOT NULL
      ORDER BY created_at, id`).all(binding.id, binding.generation, binding.paneId)
      .map((row) => ({ id: String((row as { id: string }).id), rootMessageId: String((row as { root_message_id: string }).root_message_id) }));
  }

  saveRunCard(view: RunCardView): RunCardView {
    return this.context.transaction("sqlite.projection-store.write", () => {
      this.context.database.prepare(`UPDATE run_cards SET binding_generation = ?, conversion_parent_prompt_id = ?, queue_feedback_json = ?, lark_message_id = ?, answer_message_id = ?, answer_card_id = ?, answer_element_id = ?, answer_sequence = ?, answer_page_index = ?, answer_page_start = ?, phase = ?, title = ?, session_title = ?, agent_kind = ?, request_text = ?, reply_context = ?, workspace_id = ?, space_name = ?, pane_id = ?, pane_token = ?, answer = ?, answer_segments_json = ?, answer_draft = ?, answer_draft_transient = ?, progress_events_json = ?, task_list_json = ?, task_list_title = ?, current_goal_json = ?, progress_summary_json = ?, queue_position = ?, started_at = ?, finished_at = ?, notice = ?, worker_activity_json = ?, worker_dependency_revision = ?, worker_context_frozen_at = ?, activity_at = ?, view_version = ?, delivered_version = ?, answer_delivered_version = ?, updated_at = ? WHERE prompt_id = ?`)
        .run(view.bindingGeneration, view.conversionParentPromptId, view.queueFeedback === null ? null : JSON.stringify(view.queueFeedback), view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.sessionTitle ?? null, view.agentKind, view.requestText, view.replyContext ?? null, view.workspaceId, view.spaceName, view.paneId, view.paneToken ?? null, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), JSON.stringify(view.taskList), view.taskListTitle, view.currentGoal === null ? null : JSON.stringify(view.currentGoal), JSON.stringify(view.progressSummary), view.queuePosition, view.startedAt, view.finishedAt, view.notice, JSON.stringify(view.workerActivity), view.workerDependencyRevision, view.workerContextFrozenAt, view.activityAt, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.updatedAt, view.promptId);
      this.timelines.save("primary-run", view.promptId, view.timelineItems ?? []);
      this.segments.ensureSegmentZero("primary-run", view.promptId, view.requestText);
      return this.loadRunCard(view.promptId)!;
    });
  }

  loadRunCard(promptId: string): RunCardView | null {
    const row = this.context.database.prepare("SELECT state_json FROM run_cards_view WHERE prompt_id = ?").get(promptId) as { state_json: string } | undefined;
    return row ? this.hydrateRunCard(row.state_json) : null;
  }

  preparePrimaryCompletionActionSet(input: {
    promptId: string;
    pageIndex: number;
    cardId: string;
    messageId: string;
    card?: object | ((review: { actionSetId: string; mentionOpenId: string; choicePrompt: import("../../domain/completion-choice.js").ChoicePrompt; choiceSpecification: import("../../domain/completion-choice.js").ChoicePrompt }) => object);
  }): CompletionActionSetRenderState | null {
    return this.context.transaction("sqlite.projection-store.write", () => {
      let existing = this.context.database.prepare(`SELECT id, owner_kind, owner_id, owner_generation, card_message_id, mention_open_id, presentation_kind, state, selected_action, selected_choice_option_id, reason
        FROM completion_action_sets WHERE owner_kind = 'primary-prompt' AND owner_id = ?`).get(input.promptId) as {
          id: string; owner_kind: "primary-prompt"; owner_id: string; owner_generation: number; card_message_id: string | null;
          mention_open_id: string | null; state: "available" | "consumed" | "superseded" | "unavailable"; selected_action: string | null; selected_choice_option_id: string | null; reason: string | null;
          presentation_kind: string;
        } | undefined;
      if (existing && (!input.card || existing.presentation_kind !== "fresh-card")) {
        if (existing.card_message_id !== input.messageId) return null;
        recoverCompletionNotification(
          this.context,
          "primary-prompt",
          input.promptId,
          this.preparedDeliveryReservation && this.preparedDeliveryConsumer
            ? { reservation: this.preparedDeliveryReservation, consumer: this.preparedDeliveryConsumer }
            : undefined
        );
        existing = this.context.database.prepare(`SELECT id, owner_kind, owner_id, owner_generation, card_message_id, mention_open_id, presentation_kind, state, selected_action, selected_choice_option_id, reason
          FROM completion_action_sets WHERE owner_kind = 'primary-prompt' AND owner_id = ?`).get(input.promptId) as typeof existing;
        if (!existing) return null;
        const current = existing;
        const choice = loadCompletionChoice(this.context, current.owner_kind, current.owner_id, current.owner_generation)?.prompt;
        if (current.state === "available" && current.mention_open_id && current.card_message_id) return { id: current.id, state: "available", mentionOpenId: current.mention_open_id, ownerKind: current.owner_kind, ownerId: current.owner_id, ownerGeneration: current.owner_generation, cardMessageId: current.card_message_id, ...(choice ? { choicePrompt: choice, choiceSpecification: choice } : {}) };
        if (current.state === "consumed" && current.reason === "ignored" && current.card_message_id) return { id: current.id, state: "consumed", ignored: true, ownerKind: current.owner_kind, ownerId: current.owner_id, ownerGeneration: current.owner_generation, cardMessageId: current.card_message_id };
        if (current.state === "consumed" && choice && current.selected_choice_option_id) {
          const selected = [choice.defaultOption, ...choice.alternatives].find(({ id }) => id === current.selected_choice_option_id);
          if (selected && current.card_message_id) return { id: current.id, state: "consumed", selectedChoice: { id: selected.id, label: selected.label }, ownerKind: current.owner_kind, ownerId: current.owner_id, ownerGeneration: current.owner_generation, cardMessageId: current.card_message_id };
        }
        if (current.state === "consumed" && current.card_message_id && COMPLETION_ACTION_SELECTIONS.includes(current.selected_action as CompletionActionSelection)) return { id: current.id, state: "consumed", selectedAction: current.selected_action as CompletionActionSelection, ownerKind: current.owner_kind, ownerId: current.owner_id, ownerGeneration: current.owner_generation, cardMessageId: current.card_message_id };
        return null;
      }
      const obligation = this.context.database.prepare(`SELECT owner_generation, binding_id, binding_generation, state, notification_reply_id
        FROM completion_notification_obligations WHERE owner_kind = 'primary-prompt' AND owner_id = ?`).get(input.promptId) as {
          owner_generation: number; binding_id: string; binding_generation: number; state: string; notification_reply_id: string | null;
        } | undefined;
      const page = this.context.database.prepare(`SELECT page_index, card_id, message_id, state FROM answer_pages
        WHERE prompt_id = ? AND page_index = ?`).get(input.promptId, input.pageIndex) as { page_index: number; card_id: string | null; message_id: string | null; state: string } | undefined;
      const latest = this.context.database.prepare("SELECT MAX(page_index) AS page_index FROM answer_pages WHERE prompt_id = ?").get(input.promptId) as { page_index: number | null };
      const view = this.loadRunCard(input.promptId);
      const binding = obligation ? this.dependencies.getBinding(obligation.binding_id) : null;
      const prompt = obligation ? this.context.database.prepare("SELECT session_epoch, ingress_source, actor_open_id, state, created_at, rowid FROM prompt_jobs WHERE id = ? AND binding_id = ?").get(input.promptId, obligation.binding_id) as { session_epoch: number; ingress_source: string | null; actor_open_id: string; state: string; created_at: string; rowid: number } | undefined : undefined;
      const legacyPending = obligation?.state === "released" && obligation.notification_reply_id
        ? this.context.database.prepare(`SELECT 1 FROM outbound_replies WHERE id = ? AND state = 'pending'
            AND kind = 'text' AND target_role='operation_result' AND payload LIKE '%需要你的选择%'
            AND claim_attempt_id IS NULL AND claimed_owner_id IS NULL AND claimed_fence IS NULL
            AND claimed_at IS NULL AND first_claimed_at IS NULL AND attempt_count = 0
            AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL
            AND COALESCE(effect_certainty,'not-started') IN ('not-started','rejected')`).get(obligation.notification_reply_id) !== undefined
        : false;
      if (!obligation || !page || !view || !binding || !prompt
        || obligation.state === "suppressed" && existing?.presentation_kind !== "fresh-card"
        || obligation.state === "released" && !legacyPending
        || prompt.state !== "delivered" || view.phase !== "completed" || page.page_index !== latest.page_index
        || !["active", "finished"].includes(page.state) || page.card_id !== input.cardId || page.message_id !== input.messageId
        || binding.generation !== obligation.binding_generation || view.bindingGeneration !== obligation.binding_generation || prompt.session_epoch !== binding.sessionEpoch
        || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached"
        || view.paneId !== binding.paneId || view.agentKind !== binding.agentKind) return null;
      const successor = this.context.database.prepare(`SELECT 1 FROM prompt_jobs p
        JOIN run_cards r ON r.prompt_id = p.id
        WHERE p.binding_id = ? AND p.id != ? AND p.ingress_source != 'herdr' AND r.binding_generation = ?
          AND (p.created_at > ? OR (p.created_at = ? AND p.rowid > ?)) LIMIT 1`).get(
          binding.id, input.promptId, binding.generation, prompt.created_at, prompt.created_at, prompt.rowid
        );
      const mentionOpenId = prompt.ingress_source === "feishu" && canMentionFeishuOpenId(prompt.actor_open_id)
        ? prompt.actor_open_id
        : canMentionFeishuOpenId(binding.creatorOpenId) ? binding.creatorOpenId : null;
      const state = successor ? "superseded" : mentionOpenId ? "available" : "unavailable";
      const timestamp = now();
      const choice = loadCompletionChoice(this.context, "primary-prompt", input.promptId, obligation.owner_generation);
      if (input.card && mentionOpenId && choice && !successor) {
        if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Completion Review prepared delivery is not connected");
        const actionSetId = completionReviewActionSetIdentity("primary-prompt", input.promptId, obligation.owner_generation);
        const card = typeof input.card === "function"
          ? input.card({ actionSetId, mentionOpenId, choicePrompt: choice.prompt, choiceSpecification: choice.prompt })
          : input.card;
        const reserved = this.completionReviews.reservePrimaryPrompt({
          promptId: input.promptId, ownerGeneration: obligation.owner_generation,
          bindingId: binding.id, bindingGeneration: binding.generation,
          pageIndex: input.pageIndex, mentionOpenId, choiceSpecificationId: choice.id,
          rootMessageId: binding.rootMessageId!, card,
          reserveDelivery: this.preparedDeliveryReservation
        });
        if (reserved.receipt) this.handoffAfterCommit(reserved.receipt);
        return { id: reserved.actionSetId, state: "available", presentationKind: "fresh-card", mentionOpenId,
          ownerKind: "primary-prompt", ownerId: input.promptId, ownerGeneration: obligation.owner_generation,
          cardMessageId: input.messageId, choicePrompt: choice.prompt, choiceSpecification: choice.prompt };
      }
      const id = randomUUID();
      this.context.database.prepare(`INSERT INTO completion_action_sets(
        id, owner_kind, owner_id, owner_generation, binding_id, binding_generation, page_index, card_id, card_message_id,
        mention_open_id, state, selected_action, result_source_key, reason, created_at, updated_at, decided_at, choice_specification_id, selected_choice_option_id
      ) VALUES (?, 'primary-prompt', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)`)
        .run(id, input.promptId, obligation.owner_generation, binding.id, binding.generation, input.pageIndex, input.cardId, input.messageId,
          mentionOpenId, state, successor ? "successor-present" : mentionOpenId ? null : "missing-mention-target", timestamp, timestamp,
          state === "available" ? null : timestamp, choice?.id ?? null);
      this.context.database.prepare(`UPDATE completion_notification_obligations SET state = ?, released_at = ?, updated_at = ?
        WHERE owner_kind = 'primary-prompt' AND owner_id = ? AND owner_generation = ? AND state IN ('waiting_for_answer','missing_mention_target')`)
        .run(state === "available" ? "waiting_for_answer" : successor ? "suppressed" : "missing_mention_target", null, timestamp, input.promptId, obligation.owner_generation);
      return state === "available" && mentionOpenId
        ? { id, state: "available", mentionOpenId, ownerKind: "primary-prompt", ownerId: input.promptId, ownerGeneration: obligation.owner_generation, cardMessageId: input.messageId, ...(choice ? { choicePrompt: choice.prompt, choiceSpecification: choice.prompt } : {}) }
        : null;
    });
  }

  decidePrimaryCompletionReview(input: { actionSetId: string; optionId: string; messageId: string; actorOpenId: string; chatId: string; occurredAt: string }): PrimaryCompletionReviewDecision {
    return this.completionReviews.decidePrimary(input);
  }

  getCompletionReviewOwnerKind(actionSetId: string): "primary-segment" | "primary-prompt" | "worker-turn" | null {
    return this.completionReviews.getOwnerKind(actionSetId);
  }

  getProjectionGapSummary(input: ProjectionGapQuery & { pageIndex?: number }): ProjectionGapSummary {
    return new SqliteProjectionGapStore(this.context).summarize({
      ...input,
      ...(input.promptId !== undefined && input.pageIndex !== undefined
        ? { answerPage: { promptId: input.promptId, pageIndex: input.pageIndex } }
        : {})
    });
  }

  listRunCards(bindingId: string): RunCardView[] {
    return (this.context.database.prepare("SELECT state_json FROM run_cards_view WHERE binding_id = ? ORDER BY created_at, prompt_id").all(bindingId) as Array<{ state_json: string }>).map((row) => this.hydrateRunCard(row.state_json));
  }

  listActionableStartupRunCards(bindingId: string): RunCardView[] {
    const rows = this.context.database.prepare(`
      SELECT view.state_json
      FROM run_cards AS card
      JOIN run_cards_view AS view ON view.prompt_id = card.prompt_id
      JOIN bindings AS binding ON binding.id = card.binding_id AND binding.generation = card.binding_generation
      WHERE card.binding_id = ?
        AND binding.state = 'active' AND binding.lifecycle = 'active'
        AND binding.attachment = 'attached' AND binding.pane_id IS NOT NULL
        AND (
        card.phase IN ('queued','submitted','running','recovering','uncertain','blocked')
        OR card.answer_message_id IS NULL
        OR (EXISTS (
          SELECT 1 FROM answer_pages page
          WHERE page.prompt_id = card.prompt_id
            AND (page.state = 'creating' OR (page.state = 'active' AND page.delivery_mode = 'streaming'))
        ) AND ${noFrozenCurrentAnswerEffectSql})
        OR (card.view_version > card.answer_delivered_version AND EXISTS (
          SELECT 1 FROM answer_pages page
          WHERE page.prompt_id = card.prompt_id AND page.state IN ('active','finished')
        ) AND ${noFrozenCurrentAnswerEffectSql})
        OR EXISTS (
          SELECT 1 FROM outbound_replies pending
          WHERE pending.prompt_id = card.prompt_id AND pending.state = 'pending'
        )
        OR EXISTS (
          SELECT 1 FROM completion_notification_obligations obligation
          JOIN outbound_replies legacy ON legacy.id = obligation.notification_reply_id
          WHERE obligation.owner_kind = 'primary-prompt' AND obligation.owner_id = card.prompt_id
            AND obligation.state = 'released' AND legacy.state = 'pending'
            AND legacy.kind = 'card_reply'
            AND legacy.idempotency_key LIKE 'primary-next-input:%'
            AND legacy.claim_attempt_id IS NULL AND legacy.first_claimed_at IS NULL
            AND legacy.attempt_count = 0 AND legacy.card_id_checkpoint IS NULL
        )
        OR (card.answer_card_id IS NULL AND card.answer_message_id IS NOT NULL
          AND card.view_version > card.answer_delivered_version AND ${noFrozenCurrentAnswerEffectSql})
        OR EXISTS (
          SELECT 1 FROM delivery_recoveries recovery
          JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
          WHERE failed.prompt_id = card.prompt_id AND (
            (recovery.state = 'replacement_pending' AND recovery.replacement_reply_id IS NULL)
            OR EXISTS (
              SELECT 1 FROM outbox_lane_quarantines quarantine
              WHERE quarantine.failed_reply_id = recovery.failed_reply_id AND quarantine.state = 'active'
            )
          )
        )
      )
      ORDER BY card.created_at, card.prompt_id
    `).all(bindingId) as Array<{ state_json: string }>;
    return rows.map((row) => this.hydrateRunCard(row.state_json));
  }

  getPromptProjectionState(id: string): { state: import("../../domain/types.js").PromptState; error: string | null } | null {
    const row = this.context.database.prepare("SELECT state, error FROM prompt_jobs WHERE id = ?").get(id) as { state: import("../../domain/types.js").PromptState; error: string | null } | undefined;
    return row ?? null;
  }

  loadStartupMainRunCard(bindingId: string, preferredPromptId: string | null): RunCardView | null {
    const row = this.context.database.prepare(`
      SELECT view.state_json
      FROM run_cards AS card
      JOIN run_cards_view AS view ON view.prompt_id = card.prompt_id
      WHERE card.binding_id = ?
      ORDER BY
        CASE
          WHEN card.prompt_id = ? AND card.phase IN ('submitted','running','blocked') THEN 0
          WHEN card.phase IN ('submitted','running','blocked') THEN 1
          ELSE 2
        END,
        CASE WHEN card.phase IN ('submitted','running','blocked') THEN card.created_at END ASC,
        CASE WHEN card.phase NOT IN ('submitted','running','blocked') THEN card.created_at END DESC,
        CASE WHEN card.phase IN ('submitted','running','blocked') THEN card.prompt_id END ASC,
        CASE WHEN card.phase NOT IN ('submitted','running','blocked') THEN card.prompt_id END DESC
      LIMIT 1
    `).get(bindingId, preferredPromptId) as { state_json: string } | undefined;
    return row ? this.hydrateRunCard(row.state_json) : null;
  }

  listRunCardsByPhases(bindingId: string, phases: readonly RunCardView["phase"][]): RunCardView[] {
    if (phases.length === 0) return [];
    const placeholders = phases.map(() => "?").join(", " );
    const rows = this.context.database.prepare(`
      SELECT view.state_json FROM run_cards AS card INDEXED BY run_cards_binding_phase_created
      JOIN run_cards_view AS view ON view.prompt_id = card.prompt_id
      WHERE card.binding_id = ? AND card.phase IN (${placeholders})
      ORDER BY card.created_at, card.prompt_id
    `).all(bindingId, ...phases) as Array<{ state_json: string }>;
    return rows.map((row) => this.hydrateRunCard(row.state_json));
  }

  getActiveAnswerPage(promptId: string): AnswerPage | null {
    const row = this.context.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? AND state = 'active' ORDER BY page_index DESC LIMIT 1").get(promptId) as AnswerPageRow | undefined;
    return row ? mapAnswerPage(row) : null;
  }

  getAnswerPage(promptId: string, pageIndex: number): AnswerPage | null {
    const row = this.context.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(promptId, pageIndex) as AnswerPageRow | undefined;
    return row ? mapAnswerPage(row) : null;
  }

  getAnswerPageDeliveryFacts(promptId: string, pageIndex: number): AnswerPageDeliveryFacts {
    const page = this.context.database.prepare("SELECT message_id, card_id, element_id FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(promptId, pageIndex) as { message_id: string | null; card_id: string | null; element_id: string } | undefined;
    if (!page) return { latestContent: null, finishPending: false, continuationPending: false, finalUpdateState: null };
    const promptIds = listPromptIdentityPromptIds(this.context, promptId);
    const contentRow = this.context.database.prepare(`
      SELECT payload, state, view_version
      FROM outbound_replies INDEXED BY outbound_replies_prompt_kind_state_updated
      WHERE ${promptIdMembershipSql("prompt_id", promptIds)} AND card_role = 'answer' AND kind = 'stream_content'
        AND state IN ('pending','delivered','dead_letter','dismissed')
        AND (
          stream_page_index = ?
          OR (stream_page_index IS NULL AND json_valid(payload)
            AND (json_extract(payload, '$.elementId') = ? OR json_extract(payload, '$.pageIndex') = ?))
        )
      ORDER BY delivery_order DESC LIMIT 1
    `).get(...promptIds, pageIndex, page.element_id, pageIndex) as { payload: string; state: OutboundReplyState; view_version: number | null } | undefined;
    const payload = contentRow ? parseJsonRecord(contentRow.payload) : null;
    const latestContent = contentRow && payload ? { content: typeof payload.content === "string" ? payload.content : "", sequence: Number(payload.sequence ?? contentRow.view_version ?? 0), state: contentRow.state, sourceEnd: Number.isInteger(payload.sourceEnd) ? Number(payload.sourceEnd) : null } : null;
    const finishPending = this.context.database.prepare(`
      SELECT 1 FROM outbound_replies INDEXED BY outbound_replies_prompt_kind_state_updated
      WHERE ${promptIdMembershipSql("prompt_id", promptIds)} AND card_role = 'answer' AND kind = 'stream_finish' AND state = 'pending'
        AND (stream_page_index = ? OR (stream_page_index IS NULL AND CASE
          WHEN json_valid(payload) THEN json_extract(payload, '$.pageIndex') IS NULL OR json_extract(payload, '$.pageIndex') = ?
          ELSE 1
        END))
      LIMIT 1
    `).get(...promptIds, pageIndex, pageIndex) !== undefined;
    const continuationPending = this.context.database.prepare(`
      SELECT 1 FROM outbound_replies INDEXED BY outbound_replies_prompt_kind_state_updated
      WHERE ${promptIdMembershipSql("prompt_id", promptIds)} AND card_role = 'answer' AND kind = 'stream_card_create' AND state = 'pending'
        AND (stream_page_index = ? OR (stream_page_index IS NULL AND json_valid(payload) AND json_extract(payload, '$.stream.pageIndex') = ?))
      LIMIT 1
    `).get(...promptIds, pageIndex + 1, pageIndex + 1) !== undefined;
    const finalPrefixes = page.card_id ? promptIds.map((id) => answerFinalFoldKey(id, pageIndex, page.card_id!)) : [];
    const finalRows = this.context.database.prepare(`
      SELECT idempotency_key, projection_key, state
      FROM outbound_replies INDEXED BY outbound_replies_prompt_kind_state_updated
      WHERE ${promptIdMembershipSql("prompt_id", promptIds)} AND card_role = 'answer' AND kind = 'card_update'
        AND state IN ('pending','delivered','dead_letter','dismissed')
        AND (
          stream_page_index = ?
          OR (
            stream_page_index IS NULL
            AND root_message_id IN (?, ?)
          )
        )
      ORDER BY delivery_order DESC LIMIT 16
    `).all(...promptIds, pageIndex, page.card_id, page.message_id) as Array<{ idempotency_key: string; projection_key: string | null; state: OutboundReplyState }>;
    const finalUpdateState = finalRows.find((row) => finalPrefixes.some((prefix) =>
      row.projection_key === prefix
      || row.idempotency_key === prefix
      || row.idempotency_key.startsWith(`${prefix}:revision:`)
    ))?.state ?? null;
    return { latestContent, finishPending, continuationPending, finalUpdateState };
  }

  getAnswerTimelinePage(promptId: string, pageIndex: number): AnswerTimelinePageCheckpoint {
    return this.timelinePages.load("primary-run", promptId, pageIndex);
  }
  listFrozenAnswerTimelineItems(promptId: string, beforePageIndex: number) { return this.timelinePages.frozenItems("primary-run", promptId, beforePageIndex); }

  reserveAnswerTimelineCard(input: { promptId: string; pageIndex: number; messageId: string; card: object; cursor: AnswerTimelineCursor | null; items: readonly AnswerTimelineItem[]; source?: string; workClass?: OutboundWorkClass }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.projection-store.write", () => {
      const page = this.context.database.prepare("SELECT state, message_id, source_start FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.pageIndex) as { state: string; message_id: string | null; source_start: number } | undefined;
      const view = this.loadRunCard(input.promptId);
      if (!page || !view || (this.preparedDeliveryReservation && !this.hasExactActivePrimaryView(view)) || page.state !== "active" || page.message_id !== input.messageId) return "stale";
      this.timelinePages.ensure("primary-run", input.promptId, input.pageIndex, { itemIndex: 0, markdownOffset: 0 });
      if (this.timelinePages.load("primary-run", input.promptId, input.pageIndex).pending || this.timelinePages.isDelivered("primary-run", input.promptId, input.pageIndex, input.cursor, input.items)) return "waiting";
      const baseKey = `answer-timeline:${input.promptId}:${input.pageIndex}:${view.viewVersion}`;
      const payload = JSON.stringify(input.card);
      const existing = this.context.database.prepare(`SELECT payload, snapshot_revision FROM outbound_replies
        WHERE idempotency_key = ? OR idempotency_key LIKE ?
        ORDER BY snapshot_revision DESC, delivery_order DESC LIMIT 1`).get(baseKey, `${baseKey}:revision:%`) as { payload: string; snapshot_revision: number } | undefined;
      if (existing?.payload === payload) return "waiting";
      const revision = (existing?.snapshot_revision ?? 0) + 1;
      const id = randomUUID();
      const cardSequence = incrementPrimaryAnswerPageSequence(this.context, input.promptId, input.pageIndex);
      const reply = this.reserveAnswerDelivery({ id, idempotencyKey: revision === 1 ? baseKey : `${baseKey}:revision:${revision}`, bindingId: view.bindingId, promptId: input.promptId, bindingGeneration: view.bindingGeneration, viewVersion: view.viewVersion, cardSequence, cardRole: "answer", workClass: input.workClass ?? "live", rootMessageId: input.messageId, kind: "card_update", payload, projectionKey: `answer-timeline:${input.promptId}:${input.pageIndex}`, snapshotRevision: revision, streamPageIndex: input.pageIndex, laneKeyOverride: answerPageLaneKey(input.promptId, input.pageIndex) });
      if (input.source !== undefined) recordAnswerCoverage(this.context, { replyId: reply.id, promptId: input.promptId, bindingGeneration: view.bindingGeneration, pageIndex: input.pageIndex, sourceStart: page.source_start, source: input.source });
      this.timelinePages.reserve("primary-run", input.promptId, input.pageIndex, reply.id, input.cursor, input.items);
      return "reserved";
    });
  }

  reserveAnswerContent(input: { promptId: string; pageIndex: number; cardId: string; elementId: string; content: string; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || page.cardId !== input.cardId || page.elementId !== input.elementId) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.latestContent?.state === "pending" || facts.latestContent?.content === input.content) return "waiting";
      const sequence = incrementPrimaryAnswerPageSequence(this.context, input.promptId, input.pageIndex)!;
      const id = randomUUID();
      this.reserveAnswerDelivery({ id, idempotencyKey: `stream:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, bindingGeneration: view.bindingGeneration, viewVersion: sequence, cardSequence: sequence, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.cardId, kind: "stream_content", payload: JSON.stringify({ pageIndex: input.pageIndex, elementId: input.elementId, content: input.content, sequence }), streamPageIndex: input.pageIndex });
      if (input.source !== undefined) recordAnswerCoverage(this.context, { replyId: id, promptId: input.promptId, bindingGeneration: view.bindingGeneration, pageIndex: input.pageIndex, sourceStart: page.sourceStart, source: input.source });
      return "reserved";
    });
  }

  reserveAnswerFinish(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || page.cardId !== input.cardId || page.messageId !== input.messageId) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.finishPending || facts.finalUpdateState !== null || page.state === "finished") return "waiting";
      const sequence = incrementPrimaryAnswerPageSequence(this.context, input.promptId, input.pageIndex)!;
      this.reserveAnswerDelivery({ id: randomUUID(), idempotencyKey: `stream-finish:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, bindingGeneration: view.bindingGeneration, viewVersion: sequence, cardSequence: sequence, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.cardId, kind: "stream_finish", payload: JSON.stringify({ pageIndex: input.pageIndex, summary: input.summary, sequence }), streamPageIndex: input.pageIndex });
      const finalSequence = incrementPrimaryAnswerPageSequence(this.context, input.promptId, input.pageIndex)!;
      this.reserveAnswerDelivery({ id: randomUUID(), idempotencyKey: answerFinalFoldKey(input.promptId, input.pageIndex, input.cardId), bindingId: view.bindingId, promptId: input.promptId, bindingGeneration: view.bindingGeneration, viewVersion: view.viewVersion, cardSequence: finalSequence, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.messageId, kind: "card_update", payload: JSON.stringify(input.finalizedCard), projectionKey: answerFinalFoldKey(input.promptId, input.pageIndex, input.cardId), snapshotRevision: view.viewVersion, streamPageIndex: input.pageIndex, laneKeyOverride: answerPageLaneKey(input.promptId, input.pageIndex) });
      return "reserved";
    });
  }

  reserveAnswerContinuation(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; timelineStartCursor?: AnswerTimelineCursor; timelineEndCursor?: AnswerTimelineCursor | null; timelineItems?: readonly AnswerTimelineItem[]; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || page.cardId !== input.cardId || page.messageId !== input.messageId || input.nextPageIndex !== input.pageIndex + 1 || input.nextPageStart <= page.sourceStart) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if ((facts.latestContent && facts.latestContent.state !== "delivered") || facts.finishPending || facts.continuationPending || facts.finalUpdateState !== null) return "waiting";
      const sequence = incrementPrimaryAnswerPageSequence(this.context, input.promptId, input.pageIndex)!;
      this.reserveAnswerDelivery({ id: randomUUID(), idempotencyKey: `stream-finish:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, bindingGeneration: view.bindingGeneration, viewVersion: sequence, cardSequence: sequence, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.cardId, kind: "stream_finish", payload: JSON.stringify({ pageIndex: input.pageIndex, summary: input.summary, sequence }), streamPageIndex: input.pageIndex });
      const finalSequence = incrementPrimaryAnswerPageSequence(this.context, input.promptId, input.pageIndex)!;
      this.reserveAnswerDelivery({ id: randomUUID(), idempotencyKey: answerFinalFoldKey(input.promptId, input.pageIndex, input.cardId), bindingId: view.bindingId, promptId: input.promptId, bindingGeneration: view.bindingGeneration, viewVersion: view.viewVersion, cardSequence: finalSequence, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.messageId, kind: "card_update", payload: JSON.stringify(input.finalizedCard), projectionKey: answerFinalFoldKey(input.promptId, input.pageIndex, input.cardId), snapshotRevision: view.viewVersion, streamPageIndex: input.pageIndex, laneKeyOverride: answerPageLaneKey(input.promptId, input.pageIndex) });
      const create = this.reserveAnswerDelivery({ id: randomUUID(), idempotencyKey: `stream-card:${input.promptId}:${input.nextPageIndex}`, bindingId: view.bindingId, promptId: input.promptId, bindingGeneration: view.bindingGeneration, viewVersion: input.viewVersion, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.nextPageStart, elementId: input.nextElementId } }), streamPageIndex: input.nextPageIndex }) as OutboundReply;
      if (input.timelineStartCursor) {
        this.timelinePages.ensure("primary-run", input.promptId, input.nextPageIndex, input.timelineStartCursor);
        this.timelinePages.reserve("primary-run", input.promptId, input.nextPageIndex, create.id, input.timelineEndCursor ?? null, input.timelineItems ?? []);
      }
      return "reserved";
    });
  }

  reserveAnswerRebuild(input: { promptId: string; pageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || input.nextPageIndex !== input.pageIndex + 1 || input.sourceStart !== page.sourceStart) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.latestContent && facts.latestContent.state !== "delivered") return "waiting";
      if (this.dependencies.hasPendingAnswerContinuation(input.promptId, input.nextPageIndex)) return "waiting";
      const timestamp = now();
      this.context.database.prepare("UPDATE answer_pages SET state = 'frozen', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active'").run(timestamp, input.promptId, input.pageIndex);
      this.reserveAnswerDelivery({ id: randomUUID(), idempotencyKey: `stream-rebuild:${input.promptId}:${input.nextPageIndex}`, workClass: input.workClass ?? "history", bindingId: view.bindingId, promptId: input.promptId, bindingGeneration: view.bindingGeneration, viewVersion: input.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.sourceStart, elementId: input.nextElementId } }), streamPageIndex: input.nextPageIndex });
      return "reserved";
    });
  }

  reserveFinalAnswerCardUpdate(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; card: object; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.projection-store.write", () => {
      const page = this.context.database.prepare("SELECT state, card_id, message_id FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.pageIndex) as { state: string; card_id: string | null; message_id: string | null } | undefined;
      const view = this.loadRunCard(input.promptId);
      if (!page || !view || (this.preparedDeliveryReservation && !this.hasExactActivePrimaryView(view)) || !["active", "frozen", "finished"].includes(page.state) || page.card_id !== input.cardId || page.message_id !== input.messageId) return "stale";
      const key = answerFinalFoldKey(input.promptId, input.pageIndex, input.cardId);
      if (page.state === "frozen") return "waiting";
      return this.reserveAnswerSnapshot(key, view, input.pageIndex, input.messageId, input.card, input.workClass, input.source);
    });
  }

  reserveClosedAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.projection-store.write", () => {
      const page = this.context.database.prepare("SELECT state, message_id FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.pageIndex) as { state: string; message_id: string | null } | undefined;
      const view = this.loadRunCard(input.promptId);
      if (!page || !view || (this.preparedDeliveryReservation && !this.hasExactActivePrimaryView(view)) || page.state !== "finished" || page.message_id !== input.messageId) return "stale";
      const key = `answer-closed:${input.promptId}:${input.pageIndex}:${input.messageId}`;
      return this.reserveAnswerSnapshot(key, view, input.pageIndex, input.messageId, input.card, input.workClass, input.source);
    });
  }

  reserveStaticAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.projection-store.write", () => {
      const page = this.context.database.prepare("SELECT state, message_id, delivery_mode, source_start FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.pageIndex) as { state: string; message_id: string | null; delivery_mode: string; source_start: number } | undefined;
      const view = this.loadRunCard(input.promptId);
      if (!page || !view || (this.preparedDeliveryReservation && !this.hasExactActivePrimaryView(view)) || page.state !== "active" || page.delivery_mode !== "static" || page.message_id !== input.messageId) return "stale";
      const key = `answer-static:${input.promptId}:${input.pageIndex}:${input.messageId}`;
      const outcome = this.reserveAnswerSnapshot(key, view, input.pageIndex, input.messageId, input.card, input.workClass);
      if (outcome === "reserved" && input.source !== undefined) {
        const reply = this.context.database.prepare("SELECT id FROM outbound_replies WHERE projection_key = ? ORDER BY snapshot_revision DESC LIMIT 1").get(key) as { id: string };
        recordAnswerCoverage(this.context, { replyId: reply.id, promptId: input.promptId, bindingGeneration: view.bindingGeneration, pageIndex: input.pageIndex, sourceStart: Number(page.source_start), source: input.source });
      }
      return outcome;
    });
  }

  private reserveAnswerSnapshot(key: string, view: RunCardView, pageIndex: number, messageId: string, card: object, workClass?: OutboundWorkClass, source?: string): AnswerPageReservationOutcome {
    const payload = JSON.stringify(card);
    const projectionKeys = listPromptIdentityPromptIds(this.context, view.promptId).map((promptId) => replacePromptScopedKey(key, view.promptId, promptId));
    const expired = this.context.database.prepare(`SELECT 1 FROM delivery_recoveries recovery JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id WHERE failed.projection_key IN (${projectionKeys.map(() => "?").join(", ")}) AND recovery.action = 'expired_view_target' AND recovery.state = 'dismissed' LIMIT 1`).get(...projectionKeys);
    if (expired) return "waiting";
    this.context.database.prepare("UPDATE outbound_replies SET projection_key = ? WHERE idempotency_key = ? AND projection_key IS NULL").run(key, key);
    const existing = this.context.database.prepare("SELECT id, payload, snapshot_revision FROM outbound_replies WHERE projection_key = ? OR idempotency_key = ? ORDER BY snapshot_revision DESC LIMIT 1").get(key, key) as { id: string; payload: string; snapshot_revision: number } | undefined;
    if (existing?.payload === payload) return "waiting";
    const revision = (existing?.snapshot_revision ?? 0) + 1;
    this.context.database.prepare(`
      UPDATE outbound_replies
      SET state = 'dismissed',
        error = 'Coalesced unclaimed prompt snapshot before first attempt',
        updated_at = ?
      WHERE projection_key = ? AND state = 'pending'
        AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
        AND attempt_count = 0 AND card_id_checkpoint IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM delivery_recoveries recovery
          WHERE recovery.replacement_reply_id = outbound_replies.id
            AND recovery.state IN ('unresolved', 'replacement_pending')
        )
    `).run(now(), key);
    const id = randomUUID();
    const cardSequence = incrementPrimaryAnswerPageSequence(this.context, view.promptId, pageIndex);
    this.reserveAnswerDelivery({ id, idempotencyKey: revision === 1 ? key : `${key}:revision:${revision}`, bindingId: view.bindingId, promptId: view.promptId, bindingGeneration: view.bindingGeneration, viewVersion: view.viewVersion, cardSequence, cardRole: "answer", ...outboundWorkClass(workClass), rootMessageId: messageId, kind: "card_update", payload, projectionKey: key, snapshotRevision: revision, streamPageIndex: pageIndex, laneKeyOverride: answerPageLaneKey(view.promptId, pageIndex) });
    if (source !== undefined) {
      const page = this.context.database.prepare("SELECT source_start FROM answer_pages WHERE prompt_id=? AND page_index=?").get(view.promptId, pageIndex) as { source_start: number } | undefined;
      if (page) recordAnswerCoverage(this.context, { replyId: id, promptId: view.promptId, bindingGeneration: view.bindingGeneration, pageIndex, sourceStart: Number(page.source_start), source });
    }
    return "reserved";
  }

  reserveStaticAnswerReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; source?: string; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.projection-store.write", () => {
      const previous = this.context.database.prepare("SELECT state, delivery_mode, source_start FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.previousPageIndex) as { state: string; delivery_mode: string; source_start: number } | undefined;
      const view = this.loadRunCard(input.promptId);
      if (!previous || !view || (this.preparedDeliveryReservation && !this.hasExactActivePrimaryView(view)) || previous.state !== "frozen" || previous.delivery_mode !== "static" || input.nextPageIndex !== input.previousPageIndex + 1 || input.sourceStart !== Number(previous.source_start)) return "stale";
      const existing = this.context.database.prepare("SELECT state, element_id, source_start, delivery_mode FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.nextPageIndex) as { state: string; element_id: string; source_start: number; delivery_mode: string } | undefined;
      const idempotencyKey = `answer-static-rebuild:${input.promptId}:${input.nextPageIndex}`;
      const payload = JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.sourceStart, elementId: input.nextElementId, deliveryMode: "static" } });
      if (existing) {
        if (existing.state !== "creating" || existing.element_id !== input.nextElementId || Number(existing.source_start) !== input.sourceStart || existing.delivery_mode !== "static") return "stale";
        const replacement = this.context.database.prepare("SELECT id FROM outbound_replies WHERE idempotency_key = ? AND prompt_id = ? AND kind = 'stream_card_create'").get(idempotencyKey, input.promptId) as { id: string } | undefined;
        if (replacement && input.source !== undefined) linkExpiredAnswerRecoverySnapshot(this.context, { promptId: input.promptId, generation: view.bindingGeneration, previousPage: input.previousPageIndex, nextPage: input.nextPageIndex, replacementId: replacement.id, sourceStart: input.sourceStart, source: input.source });
        return "waiting";
      }
      const replacement = this.reserveAnswerDelivery({ id: randomUUID(), idempotencyKey, workClass: input.workClass ?? "history", bindingId: view.bindingId, promptId: input.promptId, bindingGeneration: view.bindingGeneration, viewVersion: input.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload, streamPageIndex: input.nextPageIndex });
      linkAnswerRecovery(this.context, input.promptId, view.bindingGeneration, input.previousPageIndex, input.nextPageIndex, replacement.id);
      if (input.source !== undefined) linkExpiredAnswerRecoverySnapshot(this.context, { promptId: input.promptId, generation: view.bindingGeneration, previousPage: input.previousPageIndex, nextPage: input.nextPageIndex, replacementId: replacement.id, sourceStart: input.sourceStart, source: input.source });
      this.context.database.prepare("UPDATE answer_pages SET delivery_mode = 'static', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'creating'").run(now(), input.promptId, input.nextPageIndex);
      return "reserved";
    });
  }

  reserveClosedAnswerStreamReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; source?: string; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.projection-store.write", () => {
      const previous = this.context.database.prepare("SELECT state, delivery_mode, source_start FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.previousPageIndex) as { state: string; delivery_mode: string; source_start: number } | undefined;
      const view = this.loadRunCard(input.promptId);
      if (!previous || !view || (this.preparedDeliveryReservation && !this.hasExactActivePrimaryView(view)) || previous.state !== "frozen" || previous.delivery_mode !== "static" || input.nextPageIndex !== input.previousPageIndex + 1 || input.sourceStart !== Number(previous.source_start)) return "stale";
      const promptIds = listPromptIdentityPromptIds(this.context, input.promptId);
      const recovery = this.context.database.prepare(`SELECT 1 FROM delivery_recoveries recovery
        JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
        JOIN run_cards card ON card.prompt_id = ${resolvedPromptReferenceSql("failed.prompt_id")}
        WHERE recovery.action = 'rebuild_answer' AND recovery.state = 'unresolved'
          AND ${promptIdMembershipSql("failed.prompt_id", promptIds)}
          AND card.binding_generation = ? AND failed.stream_page_index = ? LIMIT 1`).get(...promptIds, view.bindingGeneration, input.previousPageIndex);
      if (!recovery) return "stale";
      const existing = this.context.database.prepare("SELECT state, element_id, source_start, delivery_mode FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.nextPageIndex) as { state: string; element_id: string; source_start: number; delivery_mode: string } | undefined;
      if (existing) {
        if (existing.state !== "creating" || existing.element_id !== input.nextElementId || Number(existing.source_start) !== input.sourceStart || !["streaming", "static"].includes(existing.delivery_mode)) return "stale";
        const pending = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key=? AND state='pending'").get(`answer-stream-rebuild:${input.promptId}:${input.nextPageIndex}`);
        if (existing.delivery_mode === "static" && pending) return "waiting";
      }
      this.context.database.prepare("UPDATE answer_pages SET delivery_mode = 'static', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'creating'").run(now(), input.promptId, input.nextPageIndex);
      const replacement = this.reserveAnswerDelivery({
        id: randomUUID(), idempotencyKey: `answer-stream-rebuild:${input.promptId}:${input.nextPageIndex}`, workClass: input.workClass ?? "history",
        bindingId: view.bindingId, promptId: input.promptId, bindingGeneration: view.bindingGeneration, viewVersion: input.viewVersion,
        cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create",
        payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.sourceStart, elementId: input.nextElementId, deliveryMode: "static" } })
      }) as { id: string; laneKey: string };
      linkAnswerRecovery(this.context, input.promptId, view.bindingGeneration, input.previousPageIndex, input.nextPageIndex, replacement.id);
      if (input.source !== undefined) linkAnswerRecoverySnapshot(this.context, {
        promptId: input.promptId,
        generation: view.bindingGeneration,
        previousPage: input.previousPageIndex,
        nextPage: input.nextPageIndex,
        replacementId: replacement.id,
        sourceStart: input.sourceStart,
        source: input.source
      });
      return "reserved";
    });
  }

  listAnswerPages(promptId: string): AnswerPage[] {
    return (this.context.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? ORDER BY page_index").all(promptId) as AnswerPageRow[]).map(mapAnswerPage);
  }

  hasPendingExpiredAnswerTarget(promptId: string, pageIndex: number): boolean {
    const promptIds = listPromptIdentityPromptIds(this.context, promptId);
    return this.context.database.prepare(`SELECT 1 FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id=recovery.failed_reply_id
      WHERE recovery.action='expired_view_target' AND recovery.state='unresolved'
        AND ${promptIdMembershipSql("failed.prompt_id", promptIds)} AND failed.stream_page_index=? LIMIT 1`).get(...promptIds, pageIndex) !== undefined;
  }

  insertRunCard(view: RunCardView): void {
    this.context.transaction("sqlite.projection-store.write", () => {
      this.context.database.prepare(`INSERT INTO run_cards(prompt_id, binding_id, binding_generation, conversion_parent_prompt_id, queue_feedback_json, lark_message_id, answer_message_id, answer_card_id, answer_element_id, answer_sequence, answer_page_index, answer_page_start, phase, title, session_title, agent_kind, request_text, reply_context, workspace_id, space_name, pane_id, pane_token, answer, answer_segments_json, answer_draft, answer_draft_transient, progress_events_json, task_list_json, task_list_title, current_goal_json, progress_summary_json, queue_position, started_at, finished_at, notice, worker_activity_json, worker_dependency_revision, worker_context_frozen_at, activity_at, view_version, delivered_version, answer_delivered_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(view.promptId, view.bindingId, view.bindingGeneration, view.conversionParentPromptId, view.queueFeedback === null ? null : JSON.stringify(view.queueFeedback), view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.sessionTitle ?? null, view.agentKind, view.requestText, view.replyContext ?? null, view.workspaceId, view.spaceName, view.paneId, view.paneToken ?? null, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), JSON.stringify(view.taskList), view.taskListTitle, view.currentGoal === null ? null : JSON.stringify(view.currentGoal), JSON.stringify(view.progressSummary), view.queuePosition, view.startedAt, view.finishedAt, view.notice, JSON.stringify(view.workerActivity), view.workerDependencyRevision, view.workerContextFrozenAt, view.activityAt, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.createdAt, view.updatedAt);
      this.timelines.save("primary-run", view.promptId, view.timelineItems ?? []);
      this.segments.ensureSegmentZero("primary-run", view.promptId, view.requestText);
      this.context.database.prepare("INSERT OR IGNORE INTO answer_pages(prompt_id, page_index, segment_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, 'streaming', ?, ?)")
        .run(view.promptId, view.answerPageIndex, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerPageStart, view.answerSequence, view.answerCardId ? "active" : "creating", view.createdAt, view.updatedAt);
    });
  }

  private reserveAnswerPageIntent(promptId: string, pageIndex: number, reserve: (page: AnswerPage, view: RunCardView) => AnswerPageReservationOutcome): AnswerPageReservationOutcome {
    return this.context.transaction("sqlite.projection-store.write", () => {
      const pageRow = this.context.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? AND page_index = ? AND state = 'active'").get(promptId, pageIndex) as AnswerPageRow | undefined;
      const view = this.loadRunCard(promptId);
      return pageRow && view && (!this.preparedDeliveryReservation || this.hasExactActivePrimaryView(view)) ? reserve(mapAnswerPage(pageRow), view) : "stale";
    });
  }

  private requireBinding(id: string): Binding {
    const binding = this.dependencies.getBinding(id);
    if (!binding) throw new Error(`Binding not found: ${id}`);
    return binding;
  }

  private hydrateRunCard(stateJson: string): RunCardView {
    const view = JSON.parse(stateJson) as RunCardView;
    return { ...view, timelineItems: Array.isArray(view.timelineItems) ? view.timelineItems : [], taskListTitle: view.taskListTitle ?? null, currentGoal: view.currentGoal ?? null };
  }

  private nextMainCardSequence(binding: Binding): number {
    const row = this.context.database.prepare(`SELECT MAX(COALESCE(card_sequence, 0)) AS sequence FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND root_message_id = ? AND kind = 'card_update' AND state = 'pending'`).get(binding.id, binding.statusMessageId) as { sequence: number | null };
    return Math.max(binding.statusCardSequence, Number(row.sequence ?? 0)) + 1;
  }

  private reserveMainCardDelivery(input: EnqueueOutboundReplyInput & { bindingGeneration: number }): void {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Projection prepared delivery is not connected");
    const projectionKey = input.targetRole === "session_status"
      ? `primary-main:${input.bindingId}:${input.bindingGeneration}`
      : input.laneKeyOverride;
    this.handoffAfterCommit(this.preparedDeliveryReservation.reservePreparedOutboundReply({
      ...input,
      ...(projectionKey ? { projectionKey, snapshotRevision: input.viewVersion ?? 1 } : {})
    }));
  }

  private reserveAnswerDelivery(input: EnqueueOutboundReplyInput & { bindingGeneration: number }): OutboundReply {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Projection prepared delivery is not connected");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(input);
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private hasExactActivePrimaryView(view: RunCardView): boolean {
    return this.context.database.prepare(`SELECT 1 FROM bindings
      WHERE id=? AND generation=? AND workspace_id=? AND pane_id=?
        AND state='active' AND lifecycle='active' AND attachment='attached'`
    ).get(view.bindingId, view.bindingGeneration, view.workspaceId, view.paneId) !== undefined;
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }
}

function now(): string { return new Date().toISOString(); }

function promptIdMembershipSql(column: string, promptIds: readonly string[]): string {
  return `${column} IN (${promptIds.map(() => "?").join(", ")})`;
}

function replacePromptScopedKey(key: string, currentPromptId: string, nextPromptId: string): string {
  return nextPromptId === currentPromptId ? key : key.replace(currentPromptId, nextPromptId);
}

function answerFinalFoldKey(promptId: string, pageIndex: number, cardId: string): string {
  return `answer-final-fold:${promptId}:${pageIndex}:${cardId}`;
}

function answerPageLaneKey(promptId: string, pageIndex: number): string {
  return `answer:${promptId}:${pageIndex}`;
}

function outboundWorkClass(workClass: OutboundWorkClass | undefined): { workClass?: OutboundWorkClass } {
  return workClass ? { workClass } : {};
}

function normalizeLiveStatus(value: unknown): MainCardLiveStatus | null {
  if (!isRecord(value)) return null;
  const statusTitle = typeof value.statusTitle === "string" ? value.statusTitle : null;
  const elapsedSeconds = typeof value.elapsedSeconds === "number" && Number.isFinite(value.elapsedSeconds) && value.elapsedSeconds >= 0 ? Math.floor(value.elapsedSeconds) : null;
  const tokenCount = typeof value.tokenCount === "number" && Number.isFinite(value.tokenCount) && value.tokenCount >= 0 ? Math.floor(value.tokenCount) : null;
  const planSteps = Array.isArray(value.planSteps) ? value.planSteps.filter((step): step is MainCardLiveStatus["planSteps"][number] => {
    if (!isRecord(step)) return false;
    return typeof step.key === "string" && step.kind === "step" && typeof step.label === "string"
      && ["pending", "active", "done", "failed"].includes(String(step.state)) && typeof step.occurredAt === "string";
  }) : [];
  return statusTitle || planSteps.length || elapsedSeconds !== null || tokenCount !== null
    ? { statusTitle, planSteps, elapsedSeconds, tokenCount } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(payload: string): Record<string, unknown> {
  try {
    const value = JSON.parse(payload) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
