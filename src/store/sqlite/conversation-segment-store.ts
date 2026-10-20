import type { ConversationPagePlan, ConversationSegment, ConversationSegmentItem, ConversationSegmentPage } from "../../domain/conversation-segment.js";
import type { ActiveConversationSegmentProjection, BoundedConversationHistoryPage, ConversationSegmentCursorAnchor, ConversationSegmentStore, AdmitLegacyPendingConversationSegmentInput, ConversationSegmentLateRecoveryCandidate, ConversationSegmentPageRecoveryCandidate, ConversationSegmentProjectionNotification, PrimarySegmentCompletionReviewDecision, RejectedTurnCardRootRecovery, SegmentCompletionNotificationRecoveryResult, SegmentCompletionReason, SemanticConversationPageReservation } from "../../domain/ports/conversation-segment.js";
import type { ConversationSegmentProjectionResult } from "../../domain/ports/conversation-segment.js";
import type { CoreEventEnvelope } from "../../domain/core-event-inbox.js";
import { mergeAnswerTimelineItem, type AnswerTimelineItem, type AnswerTimelineDelta } from "../../domain/answer-timeline.js";
import { createHash, randomUUID } from "node:crypto";
import { canonicalHumanInputJson, humanInputMessage } from "../../domain/inbound.js";
import type { ExactRecoveryRoute, HistoricalMissingPageCandidate } from "../../domain/historical-recovery.js";
import type { SqliteContext } from "./context.js";
import type { ConversationSegmentCardView } from "../../domain/ports/conversation-segment.js";
import type { DeliveryEffectCertainty, OutboundReplyKind, OutboundWorkClass } from "../../domain/types.js";
import type { AnswerTimelineCursor, ConversationPageSubject } from "../../domain/delivery.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import { parseTurnCardLateRecoveryProjectionKey, parseTurnCardProjectionKey, parseTurnCardRecoveryProjectionKey, turnCardLateRecoveryProjectionKey, turnCardProjectionKey } from "../../domain/turn-card-projection-key.js";
import type { DeliveryReservationIdentity, PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation, SemanticDeliveryReservationInput } from "../../domain/ports/outbox.js";
import type { PresentationParityDescriptor } from "../../domain/ports/presentation.js";
import { SqliteProjectionGapStore } from "./projection-gap-store.js";
import { isSystemInjectedHumanEnvelope } from "../../domain/system-injected-human-envelope.js";
import { reduceCurrentGoal, type CurrentGoal, type GoalChange } from "../../domain/current-goal.js";
import { canMentionFeishuOpenId } from "../../domain/human-review.js";
import type { SubmissionIntentActor } from "../../domain/submission-intent.js";
import { choicePromptFromLegacyCompletionChoice, completionChoiceSubmissionIdentity, continueChoicePrompt, isFinalMessageCompletionChoice, type ChoicePrompt } from "../../domain/completion-choice.js";
import { loadCompletionChoice, normalizeAndPersistCompletionChoice } from "./completion-choice-store.js";
import { completionReviewActionSetIdentity, type CompletionActionSetRenderState } from "../../domain/completion-action-set.js";
import { assertCompactedPayloadCompatible } from "./retention-payload-compatibility.js";
import { isReplaySafeSupersession } from "../../domain/delivery-replay-safety.js";
import { transferDeliveryPrerequisites } from "./delivery-prerequisites.js";
import { coreEventDiscriminatorSql } from "./core-event-discriminators.js";
import { foldFinalTraceChoiceEvidence } from "../../domain/final-trace-envelope.js";
import { normalizeToolResultForDisplay } from "../../runtime/tool-activity-projector.js";
import { recoverPrimarySegmentCompletionNotification as recoverSegmentCompletionNotification, suppressPrimarySegmentInlineCompletionNotification } from "./completion-notification-store.js";
import { SqliteCompletionReviewStore } from "./completion-review-store.js";
import type { SessionActivityInvalidationFence } from "../../domain/session-activity.js";

type PresentationSnapshotWithPagePlan = import("../../domain/delivery.js").PresentationSnapshot & { pagePlan?: ConversationPagePlan };
type CanonicalProjectionInput = {
  laneId: string; laneSequence: number; event: CoreEventEnvelope; observedAt: string;
  route?: ExactRecoveryRoute; workClass?: OutboundWorkClass; model?: string;
  timelineDeltas?: readonly AnswerTimelineDelta[]; goalChanges?: readonly GoalChange[];
  taskList?: readonly { label: string; state?: string }[];
};

const ACTIONABLE_CONVERSATION_SEGMENT_PAGE_SIZE_CAP = 100;
const CURRENT_OR_LATEST_CONVERSATION_PAGE_JOIN = `
      JOIN conversation_segment_pages p ON p.id = COALESCE(
        (
          SELECT current_or_pending_page.id
          FROM conversation_segment_pages current_or_pending_page
          WHERE current_or_pending_page.segment_id=s.id
            AND (current_or_pending_page.state IN ('creating','active') OR current_or_pending_page.pending_reply_id IS NOT NULL)
          ORDER BY current_or_pending_page.page_index DESC
          LIMIT 1
        ),
        (
          SELECT frozen_page.id
          FROM conversation_segment_pages frozen_page
          WHERE frozen_page.segment_id=s.id AND frozen_page.state='frozen'
          ORDER BY frozen_page.page_index DESC
          LIMIT 1
        )
      )`;
const ACTIONABLE_CONVERSATION_SEGMENT_PAGE_PREDICATE = `
        AND (
          p.pending_reply_id IS NOT NULL
          OR p.state = 'creating'
          OR (
            p.state IN ('active','frozen')
            AND (
              s.timeline_item_count > COALESCE(CAST(json_extract(p.delivered_cursor_json,'$.itemIndex') AS INTEGER), 0)
              OR s.view_version > p.sequence
              OR s.state IN ('completed','failed','cancelled','needs_human','closed')
            )
          )
          OR EXISTS (
            SELECT 1
            FROM completion_notification_obligations obligation
            JOIN conversation_segments segment ON segment.id = obligation.owner_id
              AND segment.owner_generation = obligation.owner_generation
            JOIN conversation_segment_pages page ON page.segment_id = segment.id
            JOIN outbound_reply_prerequisites prerequisite
              ON prerequisite.dependent_reply_id = obligation.notification_reply_id
              AND prerequisite.required_state = 'delivered'
            JOIN outbound_replies reply ON reply.id = prerequisite.prerequisite_reply_id
            JOIN bindings binding ON binding.id = obligation.binding_id
              AND binding.generation = obligation.binding_generation
            WHERE obligation.owner_kind = 'primary-segment'
              AND obligation.notice_kind = 'completion'
              AND obligation.state = 'waiting_for_answer'
              AND obligation.notification_reply_id IS NOT NULL
              AND segment.id = s.id
              AND segment.state = 'completed'
              AND page.state = 'finished'
              AND reply.state = 'delivered'
              AND reply.kind = 'card_update'
              AND binding.state = 'active'
              AND binding.lifecycle = 'active'
              AND binding.attachment = 'attached'
          )
        )`;

function actionableConversationSegmentPageSize(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return 0;
  return Math.min(limit, ACTIONABLE_CONVERSATION_SEGMENT_PAGE_SIZE_CAP);
}

function isTrustedFeishuOpenId(value: unknown): value is string {
  return typeof value === "string" && /^ou_[A-Za-z0-9_-]{1,128}$/.test(value);
}

export class SqliteConversationSegmentStore implements ConversationSegmentStore {
  private readonly completionReviews: SqliteCompletionReviewStore;
  private actionableConversationSegmentCursor: string | null = null;
  private historicalPageRecoveryCursor: { updatedAt: string; id: string } | null = null;
  private projectionNotifier: ((notification: ConversationSegmentProjectionNotification) => void | Promise<void>) | null = null;
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  private initialTurnCardRenderer: ((view: ConversationSegmentCardView, page: ConversationSegmentPage) => object) | null;
  constructor(private readonly context: SqliteContext, private readonly dependencies: {
    enqueueOutboundReply?: (input: EnqueueOutboundReplyInput) => unknown;
    renderInitialTurnCard?: (view: ConversationSegmentCardView, page: ConversationSegmentPage) => object;
  } = {}) {
    this.initialTurnCardRenderer = dependencies.renderInitialTurnCard ?? null;
    this.completionReviews = new SqliteCompletionReviewStore(context);
  }
  setInitialTurnCardRenderer(renderer: (view: ConversationSegmentCardView, page: ConversationSegmentPage) => object): void {
    this.initialTurnCardRenderer = renderer;
  }
  setProjectionNotifier(notifier: (notification: ConversationSegmentProjectionNotification) => void | Promise<void>): void { this.projectionNotifier = notifier; }
  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  admitLegacyPending(input: AdmitLegacyPendingConversationSegmentInput): ConversationSegment {
    const segment = this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const now = input.occurredAt;
      this.context.database.prepare(`INSERT INTO conversation_segments(
        id, producer_key, owner_kind, owner_id, owner_generation, submission_id, human_event_id,
        agent_kind, session_id, request_text, state, view_version, root_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 1, ?, ?, ?)`
      ).run(input.segmentId, input.producerKey, input.owner.kind, input.owner.id, input.owner.generation,
        input.submissionId, input.agentKind, input.expectedSessionId, input.requestText, input.rootMessageId, now, now);
      const projectionKey = turnCardProjectionKey(input.segmentId, 0);
      this.context.database.prepare(`INSERT INTO conversation_segment_pages(
        id, segment_id, page_index, message_id, card_id, element_id, state, sequence,
        start_cursor_json, delivered_cursor_json, pending_reply_id, created_at, updated_at
      ) VALUES (?, ?, 0, NULL, NULL, ?, 'creating', 0, NULL, NULL, NULL, ?, ?)`).run(`${input.segmentId}:page:0`, input.segmentId, projectionKey, now, now);
      const reply = this.enqueueOutboundReply({
        id: `${projectionKey}:create`, idempotencyKey: `${projectionKey}:create`, ...(input.gatewayId ? { gatewayId: input.gatewayId } : {}),
        bindingId: null, targetRole: "operation_result", rootMessageId: input.rootMessageId, kind: "card_reply",
        payload: JSON.stringify(input.card), projectionKey, snapshotRevision: 1,
        viewVersion: 1, laneKeyOverride: projectionKey
      });
      this.context.database.prepare("UPDATE conversation_segment_pages SET pending_reply_id=? WHERE segment_id=? AND page_index=0").run(reply.id, input.segmentId);
      return this.getConversationSegment(input.segmentId)!;
    });
    if (input.requestProjection) this.notifyProjection({ segmentId: input.segmentId, viewVersion: segment.viewVersion, urgency: "immediate" });
    return segment;
  }

  getConversationSegment(id: string): ConversationSegment | null {
    const row = this.context.database.prepare("SELECT * FROM conversation_segments WHERE id=?").get(id) as SegmentRow | undefined;
    return row ? mapSegment(row) : null;
  }
  listConversationSegmentsForProducer(producerKey: string): ConversationSegment[] {
    const rows = this.context.database.prepare(`SELECT * FROM conversation_segments
      WHERE producer_key=? AND start_lane_sequence IS NOT NULL
      ORDER BY start_lane_sequence,start_item_ordinal`).all(producerKey) as unknown as SegmentRow[];
    assertUniqueCanonicalStarts(rows, producerKey);
    return rows.map(mapSegment);
  }
  listConversationSegmentItems(segmentId: string): ConversationSegmentItem[] {
    return (this.context.database.prepare("SELECT * FROM conversation_segment_items WHERE segment_id=? AND payload_compacted_at IS NULL ORDER BY lane_sequence,item_ordinal").all(segmentId) as unknown as ItemRow[]).map((row) => ({ segmentId: row.segment_id, itemId: row.item_id, position: { laneSequence: row.lane_sequence, itemOrdinal: row.item_ordinal }, item: JSON.parse(row.item_json) }));
  }
  listConversationSegmentPages(segmentId: string): ConversationSegmentPage[] {
    return (this.context.database.prepare("SELECT * FROM conversation_segment_pages WHERE segment_id=? ORDER BY page_index").all(segmentId) as unknown as PageRow[]).map(mapPage);
  }

  listHistoricalMissingPageCandidates(input: { limit?: number }): HistoricalMissingPageCandidate[] {
    const limit = Math.max(1, Math.min(128, Math.floor(input.limit ?? 8)));
    const rows = this.context.database.prepare(`WITH exact_pages AS (
        SELECT segment.id AS segment_id,page.page_index,page.element_id,page.start_cursor_json,
          segment.view_version,page.updated_at,'primary' AS owner_kind,binding.id AS owner_id,
          binding.generation AS owner_generation,binding.gateway_id,segment.root_message_id
        FROM conversation_segments segment
        JOIN conversation_segment_pages page ON page.segment_id=segment.id
        JOIN bindings binding ON segment.owner_kind='primary' AND binding.id=segment.owner_id
          AND binding.generation=segment.owner_generation
        WHERE binding.state IN ('active','orphaned') AND binding.lifecycle='active'
          AND segment.root_message_id<>'' AND page.message_id IS NULL AND page.pending_reply_id IS NULL
          AND page.state IN ('creating','finished') AND COALESCE(page.delivery_cohort,'legacy')='legacy'
          AND NOT EXISTS(SELECT 1 FROM outbound_replies reply WHERE reply.projection_key=page.element_id)
        UNION ALL
        SELECT segment.id,page.page_index,page.element_id,page.start_cursor_json,
          segment.view_version,page.updated_at,'worker',worker.id,worker.generation,
          binding.gateway_id,segment.root_message_id
        FROM conversation_segments segment
        JOIN conversation_segment_pages page ON page.segment_id=segment.id
        JOIN agent_instances worker ON segment.owner_kind='worker' AND worker.id=segment.owner_id
          AND worker.generation=segment.owner_generation AND worker.role='worker'
          AND worker.worker_session_lifecycle='active'
        JOIN bindings binding ON binding.id=worker.parent_binding_id
          AND binding.generation=worker.parent_binding_generation
        WHERE binding.state IN ('active','orphaned') AND binding.lifecycle='active'
          AND segment.root_message_id<>'' AND page.message_id IS NULL AND page.pending_reply_id IS NULL
          AND page.state IN ('creating','finished') AND COALESCE(page.delivery_cohort,'legacy')='legacy'
          AND NOT EXISTS(SELECT 1 FROM outbound_replies reply WHERE reply.projection_key=page.element_id)
      ) SELECT * FROM exact_pages ORDER BY updated_at,segment_id,page_index LIMIT ?`).all(limit) as Array<{
        segment_id: string; page_index: number; element_id: string; start_cursor_json: string | null;
        view_version: number; updated_at: string; owner_kind: "primary" | "worker"; owner_id: string;
        owner_generation: number; gateway_id: string; root_message_id: string;
      }>;
    return rows.map((row) => ({
      segmentId: row.segment_id,
      pageIndex: Number(row.page_index),
      elementId: row.element_id,
      startCursor: row.start_cursor_json ? JSON.parse(row.start_cursor_json) as AnswerTimelineCursor : null,
      viewVersion: Number(row.view_version),
      updatedAt: row.updated_at,
      route: {
        ownerKind: row.owner_kind,
        ownerId: row.owner_id,
        ownerGeneration: Number(row.owner_generation),
        gatewayId: row.gateway_id,
        rootMessageId: row.root_message_id
      }
    }));
  }

  reserveHistoricalMissingPage(input: { candidate: HistoricalMissingPageCandidate; card: object; cursor: AnswerTimelineCursor | null }): "reserved" | "stale" {
    return this.context.transaction("sqlite.conversation-segment-store.recover-missing-page", () => {
      const current = this.listHistoricalMissingPageCandidates({ limit: 128 }).find(({ segmentId, pageIndex }) =>
        segmentId === input.candidate.segmentId && pageIndex === input.candidate.pageIndex
      );
      if (!current || current.elementId !== input.candidate.elementId || current.viewVersion !== input.candidate.viewVersion
        || current.route.ownerKind !== input.candidate.route.ownerKind || current.route.ownerId !== input.candidate.route.ownerId
        || current.route.ownerGeneration !== input.candidate.route.ownerGeneration
        || current.route.gatewayId !== input.candidate.route.gatewayId || current.route.rootMessageId !== input.candidate.route.rootMessageId) return "stale";
      const reply = this.enqueueOutboundReply({
        id: randomUUID(), idempotencyKey: `segment:${current.segmentId}:page:${current.pageIndex}:create`,
        gatewayId: current.route.gatewayId, bindingId: null, targetRole: "operation_result",
        rootMessageId: current.route.rootMessageId, kind: "card_reply", payload: JSON.stringify(input.card),
        projectionKey: current.elementId, snapshotRevision: current.viewVersion, viewVersion: current.viewVersion,
        laneKeyOverride: current.elementId, workClass: "history"
      });
      const changed = this.context.database.prepare(`UPDATE conversation_segment_pages SET
          state='creating',sequence=MAX(sequence,?),pending_cursor_json=?,pending_reply_id=?,updated_at=?
        WHERE segment_id=? AND page_index=? AND message_id IS NULL AND pending_reply_id IS NULL
          AND state IN ('creating','finished') AND element_id=?`).run(
        current.viewVersion, input.cursor ? JSON.stringify(input.cursor) : null, reply.id, new Date().toISOString(),
        current.segmentId, current.pageIndex, current.elementId
      );
      if (changed.changes !== 1) throw new Error("Historical missing Turn Card changed during reservation");
      return "reserved";
    });
  }
  getActivePage(segmentId: string): ConversationSegmentPage | null {
    const row = this.context.database.prepare(`SELECT * FROM conversation_segment_pages
      WHERE segment_id=? AND state IN ('creating','active') ORDER BY page_index DESC LIMIT 1`).get(segmentId) as PageRow | undefined;
    return row ? mapPage(row) : null;
  }
  loadCardView(segmentId: string): ConversationSegmentCardView | null {
    return this.loadCardViewWithItems(segmentId, this.listConversationSegmentItems(segmentId).map(({ item }) => item));
  }
  loadActiveProjection(segmentId: string): ActiveConversationSegmentProjection | null {
    const pageRow = this.context.database.prepare(`SELECT * FROM conversation_segment_pages
      WHERE segment_id=? AND state IN ('creating','active') ORDER BY page_index DESC LIMIT 1`).get(segmentId) as PageRow | undefined;
    const pendingRow = this.context.database.prepare(`SELECT * FROM conversation_segment_pages
      WHERE segment_id=? AND (pending_reply_id IS NOT NULL OR (state='creating' AND message_id IS NULL))
      ORDER BY page_index DESC LIMIT 1`).get(segmentId) as PageRow | undefined;
    const frozenRow = this.context.database.prepare(`SELECT * FROM conversation_segment_pages
      WHERE segment_id=? AND state='frozen' ORDER BY page_index DESC LIMIT 1`).get(segmentId) as PageRow | undefined;
    const sourceRow = pageRow ?? frozenRow;
    const cursorBase = pageRow?.cursor_base ?? frozenRow?.continuation_cursor_base ?? 0;
    const anchorLane = pageRow?.start_lane_sequence ?? frozenRow?.continuation_lane_sequence ?? null;
    const anchorOrdinal = pageRow?.start_item_ordinal ?? frozenRow?.continuation_item_ordinal ?? null;
    const anchorInclusive = (pageRow?.start_anchor_inclusive ?? frozenRow?.continuation_anchor_inclusive ?? 1) === 1;
    let rows: ItemRow[] = [];
    if (!sourceRow) {
      rows = this.context.database.prepare(`SELECT * FROM conversation_segment_items
        WHERE segment_id=? AND payload_compacted_at IS NULL ORDER BY lane_sequence,item_ordinal,item_id`).all(segmentId) as unknown as ItemRow[];
    } else {
      if (cursorBase > 0 && (anchorLane === null || anchorOrdinal === null)) {
        throw new Error(`Conversation Segment ${segmentId} active page has no canonical cursor anchor`);
      }
      rows = (cursorBase === 0
        ? this.context.database.prepare(`SELECT * FROM conversation_segment_items
            WHERE segment_id=? AND payload_compacted_at IS NULL ORDER BY lane_sequence,item_ordinal,item_id`).all(segmentId)
        : anchorInclusive
          ? this.context.database.prepare(`SELECT * FROM conversation_segment_items INDEXED BY conversation_segment_items_position
              WHERE segment_id=? AND payload_compacted_at IS NULL AND (lane_sequence,item_ordinal)>=(?,?)
              ORDER BY lane_sequence,item_ordinal,item_id`).all(segmentId, anchorLane, anchorOrdinal)
          : this.context.database.prepare(`SELECT * FROM conversation_segment_items INDEXED BY conversation_segment_items_position
              WHERE segment_id=? AND payload_compacted_at IS NULL AND (lane_sequence,item_ordinal)>(?,?)
              ORDER BY lane_sequence,item_ordinal,item_id`).all(segmentId, anchorLane, anchorOrdinal)) as unknown as ItemRow[];
    }
    const timelineItems = rows.map((row) => JSON.parse(row.item_json) as AnswerTimelineItem);
    const view = this.loadCardViewWithItems(segmentId, timelineItems);
    if (!view) return null;
    const cursorJson = pageRow?.start_cursor_json ?? frozenRow?.delivered_cursor_json ?? null;
    const startCursor = cursorJson ? JSON.parse(cursorJson) as AnswerTimelineCursor : null;
    return {
      view,
      page: pageRow ? mapPage(pageRow) : null,
      pendingPage: pendingRow ? mapPage(pendingRow) : null,
      latestFrozenPage: frozenRow ? mapPage(frozenRow) : null,
      cursorBase,
      localStartCursor: startCursor ? { ...startCursor, itemIndex: 0 } : null,
      startAnchor: anchorLane === null || anchorOrdinal === null ? null : {
        position: { laneSequence: anchorLane, itemOrdinal: anchorOrdinal }, inclusive: anchorInclusive
      },
      itemPositions: rows.map((row) => ({ laneSequence: row.lane_sequence, itemOrdinal: row.item_ordinal }))
    };
  }
  loadHistoryPage(input: { segmentId: string; startCursor: AnswerTimelineCursor; endCursor: AnswerTimelineCursor; limit: number }): BoundedConversationHistoryPage {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit)));
    const priorPart = this.context.database.prepare(`SELECT end_lane_sequence AS lane_sequence,end_item_ordinal AS item_ordinal,
        end_anchor_inclusive AS inclusive,json_extract(end_cursor_json,'$.itemIndex') AS cursor_base
      FROM conversation_segment_page_recovery_parts
      WHERE segment_id=? AND state='delivered' AND end_cursor_json=?
      ORDER BY source_page_index DESC,part_index DESC LIMIT 1`).get(input.segmentId, JSON.stringify(input.startCursor)) as { lane_sequence:number|null; item_ordinal:number|null; inclusive:number; cursor_base:number } | undefined;
    const page = priorPart ?? this.context.database.prepare(`SELECT start_lane_sequence AS lane_sequence,start_item_ordinal AS item_ordinal,
        start_anchor_inclusive AS inclusive,cursor_base
      FROM conversation_segment_pages WHERE segment_id=? AND start_cursor_json=? LIMIT 1`)
      .get(input.segmentId, JSON.stringify(input.startCursor)) as { lane_sequence: number | null; item_ordinal: number | null; inclusive:number; cursor_base: number } | undefined;
    const resolved = page && page.lane_sequence !== null && page.item_ordinal !== null
      ? page
      : (() => {
          const anchor = this.resolveCursorAnchor(input.segmentId, input.startCursor);
          return anchor ? { lane_sequence: anchor.position.laneSequence, item_ordinal: anchor.position.itemOrdinal, inclusive: anchor.inclusive ? 1 : 0, cursor_base: input.startCursor.itemIndex } : null;
        })();
    if (!resolved) throw new Error(`Conversation Segment ${input.segmentId} history cursor has no canonical anchor`);
    const endOffset = input.endCursor.offset ?? input.endCursor.markdownOffset ?? 0;
    const requested = Math.max(0, input.endCursor.itemIndex - input.startCursor.itemIndex + (endOffset > 0 ? 1 : 0));
    const rowLimit = Math.min(limit, requested);
    const rows = (resolved.inclusive === 1
      ? this.context.database.prepare(`SELECT * FROM conversation_segment_items INDEXED BY conversation_segment_items_position
          WHERE segment_id=? AND payload_compacted_at IS NULL AND (lane_sequence,item_ordinal)>=(?,?)
          ORDER BY lane_sequence,item_ordinal,item_id LIMIT ?`).all(input.segmentId, resolved.lane_sequence, resolved.item_ordinal, rowLimit)
      : this.context.database.prepare(`SELECT * FROM conversation_segment_items INDEXED BY conversation_segment_items_position
          WHERE segment_id=? AND payload_compacted_at IS NULL AND (lane_sequence,item_ordinal)>(?,?)
          ORDER BY lane_sequence,item_ordinal,item_id LIMIT ?`).all(input.segmentId, resolved.lane_sequence, resolved.item_ordinal, rowLimit)) as unknown as ItemRow[];
    const selected = rows.slice(0, rowLimit);
    const items = selected.map((row, index) => {
      const item = JSON.parse(row.item_json) as AnswerTimelineItem;
      if (endOffset <= 0 || resolved.cursor_base + index !== input.endCursor.itemIndex || !("markdown" in item) || typeof item.markdown !== "string") return item;
      return { ...item, markdown: item.markdown.slice(0, endOffset) } as AnswerTimelineItem;
    });
    return {
      items,
      itemPositions: selected.map((row) => ({ laneSequence: row.lane_sequence, itemOrdinal: row.item_ordinal })),
      cursorBase: resolved.cursor_base,
      hasMore: requested > rowLimit
    };
  }
  private loadCardViewWithItems(segmentId: string, timelineItems: readonly AnswerTimelineItem[]): ConversationSegmentCardView | null {
    const segment = this.getConversationSegment(segmentId);
    if (!segment) return null;
    let ownerLabel = segment.ownerId;
    let spaceName = segment.producerKey;
    let projectLabel = segment.producerKey;
    let tabLabel: string | null = null;
    let paneToken: string | null = null;
    let model: string | null = null;
    if (segment.ownerKind === "primary") {
      const binding = this.context.database.prepare(`SELECT title,COALESCE(project_id,workspace_id) AS space_name,pane_token
        FROM bindings WHERE id=? AND generation=?`).get(segment.ownerId, segment.ownerGeneration) as { title:string; space_name:string; pane_token:string|null } | undefined;
      const topic = this.context.database.prepare("SELECT state_json FROM topic_views WHERE binding_id=?").get(segment.ownerId) as { state_json:string } | undefined;
      const topicView = topic ? JSON.parse(topic.state_json) as { title?:string; spaceName?:string; paneName?:string|null; paneToken?:string|null; model?:string|null } : null;
      ownerLabel = topicView?.title ?? binding?.title ?? ownerLabel;
      spaceName = topicView?.spaceName ?? binding?.space_name ?? spaceName;
      projectLabel = spaceName;
      tabLabel = topicView?.paneName?.trim() || null;
      paneToken = topicView?.paneToken ?? binding?.pane_token ?? null;
      model = topicView?.model?.trim() || null;
    } else {
      const worker = this.context.database.prepare("SELECT name,project_id,pane_token,model FROM agent_instances WHERE id=? AND generation=?").get(
        segment.ownerId,
        segment.ownerGeneration
      ) as { name:string; project_id:string; pane_token:string|null; model:string|null } | undefined;
      ownerLabel = worker?.name ?? ownerLabel;
      spaceName = worker?.project_id ?? spaceName;
      projectLabel = spaceName;
      tabLabel = worker?.name?.trim() || null;
      paneToken = worker?.pane_token ?? null;
      model = worker?.model?.trim() || null;
    }
    const taskListRow = this.context.database.prepare("SELECT task_list_json,current_goal_json,model FROM conversation_segments WHERE id=?").get(segmentId) as { task_list_json: string | null; current_goal_json: string | null; model: string | null };
    model = taskListRow.model?.trim() || model;
    const taskList = taskListRow.task_list_json === null
      ? undefined
      : JSON.parse(taskListRow.task_list_json) as Array<{ label: string; state?: string }>;
    return {
      segmentId: segment.id, ownerKind: segment.ownerKind, ownerLabel,
      spaceName, projectLabel, tabLabel, paneToken, model, requestText: segment.requestText,
      state: segment.state, timelineItems,
      gapWarning: null, viewVersion: segment.viewVersion,
      currentGoal: taskListRow.current_goal_json === null ? null : JSON.parse(taskListRow.current_goal_json) as CurrentGoal,
      ...(taskList === undefined ? {} : { taskList })
    };
  }
  loadCompletionRenderState(segmentId: string): { mentionOpenId: string; reason: SegmentCompletionReason; completionActions: CompletionActionSetRenderState | null } | null {
    const row = this.context.database.prepare(`SELECT obligation.mention_open_id,segment.owner_generation,segment.state AS segment_state,
        page.message_id,page.page_index,(
          EXISTS(
            SELECT 1 FROM bindings binding
            WHERE segment.owner_kind='primary' AND binding.id=segment.owner_id AND binding.generation=segment.owner_generation
              AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
              AND binding.agent_kind=segment.agent_kind AND binding.agent_session_value=segment.session_id
          ) OR EXISTS(
            SELECT 1 FROM agent_instances worker
            JOIN worker_session_threads thread ON thread.worker_id=worker.id
              AND thread.worker_session_generation=worker.worker_session_generation AND thread.state='active'
            JOIN bindings binding ON binding.id=worker.parent_binding_id AND binding.generation=worker.parent_binding_generation
            WHERE segment.owner_kind='worker' AND worker.id=segment.owner_id AND worker.generation=segment.owner_generation
              AND worker.role='worker' AND worker.desired_state='running' AND worker.worker_session_lifecycle='active'
              AND worker.agent_kind=segment.agent_kind AND worker.native_session_id=segment.session_id
              AND worker.parent_binding_id=obligation.binding_id AND worker.parent_binding_generation=obligation.binding_generation
              AND worker.parent_pane_id=binding.pane_id AND worker.parent_native_session_id=binding.agent_session_value
              AND thread.parent_binding_id=worker.parent_binding_id AND thread.parent_binding_generation=worker.parent_binding_generation
              AND thread.parent_pane_id=worker.parent_pane_id AND thread.root_message_id=segment.root_message_id
              AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
          )
        ) AS runtime_current
      FROM completion_notification_obligations obligation
      JOIN conversation_segments segment ON segment.id=obligation.owner_id
        AND segment.owner_generation=obligation.owner_generation
      LEFT JOIN conversation_segment_pages page ON page.segment_id=segment.id
        AND page.page_index=(SELECT MAX(page_index) FROM conversation_segment_pages WHERE segment_id=segment.id)
      WHERE obligation.owner_kind='primary-segment' AND obligation.owner_id=?
        AND obligation.notice_kind='completion' AND obligation.state IN ('waiting_for_answer','released','suppressed')
        AND obligation.mention_open_id IS NOT NULL AND segment.owner_kind IN ('primary','worker')
        AND segment.state IN ('completed','closed')`).get(segmentId) as {
          mention_open_id: string; owner_generation: number; segment_state: string; message_id: string | null;
          page_index: number | null; runtime_current: number;
        } | undefined;
    if (!row || row.runtime_current !== 1 || row.segment_state !== "completed") return null;
    const stored = this.loadPrimarySegmentAction(segmentId, row.owner_generation);
    const choice = loadCompletionChoice(this.context, "primary-segment", segmentId, row.owner_generation)?.prompt;
    const completion = this.loadCanonicalCompletionEvidence(segmentId);
    const hasTrustedSubmissionActorAuthorization = completion !== null && this.authorizesTrustedSubmissionActorMention(segmentId);
    const reason: SegmentCompletionReason | null = choice ? hasTrustedSubmissionActorAuthorization ? "both" : "human_review" : hasTrustedSubmissionActorAuthorization ? "final_request" : null;
    if (!reason) return null;
    const completionActions = stored
      ? this.mapPrimarySegmentAction(stored, choice)
      : row.segment_state === "completed" && choice && row.message_id ? {
          id: completionReviewActionSetIdentity("primary-segment", segmentId, row.owner_generation), state: "available" as const,
          mentionOpenId: row.mention_open_id, ownerKind: "primary-segment" as const,
          ownerId: segmentId, ownerGeneration: row.owner_generation, cardMessageId: row.message_id,
          choicePrompt: choice, choiceSpecification: choice, presentationKind: "fresh-card" as const
        } : null;
    return { mentionOpenId: row.mention_open_id, reason, completionActions };
  }

  preparePrimarySegmentCompletionActionSet(input: { segmentId: string; pageIndex: number; cardId: string | null; messageId: string; card: object }): CompletionActionSetRenderState | null {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const candidate = this.context.database.prepare(`SELECT obligation.owner_generation,obligation.binding_id,
          obligation.binding_generation,obligation.mention_open_id,segment.state AS segment_state,
          segment.owner_kind,segment.owner_id,segment.owner_generation AS segment_generation,
          page.page_index,page.card_id,page.message_id,page.state AS page_state,
          worker.id AS worker_id,worker.generation AS worker_generation,
          worker.worker_session_generation,worker.name AS worker_name
        FROM completion_notification_obligations obligation
        JOIN conversation_segments segment ON segment.id=obligation.owner_id
        JOIN conversation_segment_pages page ON page.segment_id=segment.id AND page.page_index=?
        LEFT JOIN agent_instances worker ON segment.owner_kind='worker' AND worker.id=segment.owner_id
        LEFT JOIN worker_session_threads thread ON thread.worker_id=worker.id
          AND thread.worker_session_generation=worker.worker_session_generation AND thread.state='active'
        LEFT JOIN bindings parent_binding ON parent_binding.id=worker.parent_binding_id
          AND parent_binding.generation=worker.parent_binding_generation
        WHERE obligation.owner_kind='primary-segment' AND obligation.owner_id=?
          AND obligation.notice_kind='completion' AND obligation.state IN ('waiting_for_answer','released','suppressed')
          AND ((segment.owner_kind='primary' AND EXISTS(
            SELECT 1 FROM bindings binding
            WHERE binding.id=segment.owner_id AND binding.generation=segment.owner_generation
              AND binding.id=obligation.binding_id AND binding.generation=obligation.binding_generation
              AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
              AND binding.agent_kind=segment.agent_kind AND binding.agent_session_value=segment.session_id
          )) OR (segment.owner_kind='worker'
            AND worker.generation=segment.owner_generation AND worker.role='worker'
            AND worker.desired_state='running' AND worker.worker_session_lifecycle='active'
            AND worker.agent_kind=segment.agent_kind AND worker.native_session_id=segment.session_id
            AND worker.parent_binding_id=obligation.binding_id AND worker.parent_binding_generation=obligation.binding_generation
            AND worker.parent_pane_id=parent_binding.pane_id AND worker.parent_native_session_id=parent_binding.agent_session_value
            AND thread.parent_binding_id=worker.parent_binding_id AND thread.parent_binding_generation=worker.parent_binding_generation
            AND thread.parent_pane_id=worker.parent_pane_id AND thread.root_message_id=segment.root_message_id
            AND parent_binding.state='active' AND parent_binding.lifecycle='active' AND parent_binding.attachment='attached'
          ))`).get(
        input.pageIndex, input.segmentId
      ) as {
        owner_generation:number; binding_id:string; binding_generation:number; mention_open_id:string|null;
        segment_state:string; owner_kind:string; owner_id:string; segment_generation:number;
        page_index:number; card_id:string|null; message_id:string|null; page_state:string;
        worker_id:string|null; worker_generation:number|null; worker_session_generation:number|null; worker_name:string|null;
      } | undefined;
      const latest = this.context.database.prepare("SELECT MAX(page_index) AS page_index FROM conversation_segment_pages WHERE segment_id=?").get(input.segmentId) as { page_index:number|null };
      const primary = candidate?.owner_kind === "primary";
      const worker = candidate?.owner_kind === "worker";
      if (!candidate || candidate.segment_state !== "completed" || (!primary && !worker)
        || candidate.owner_generation !== candidate.segment_generation
        || (primary && (candidate.owner_id !== candidate.binding_id || candidate.segment_generation !== candidate.binding_generation))
        || (worker && (!candidate.worker_id || candidate.worker_id !== candidate.owner_id || candidate.worker_generation !== candidate.segment_generation || candidate.worker_session_generation === null))
        || candidate.page_index !== latest.page_index
        || !["active", "finished"].includes(candidate.page_state) || candidate.card_id !== input.cardId
        || candidate.message_id !== input.messageId || !canMentionFeishuOpenId(candidate.mention_open_id)) return null;
      const choice = loadCompletionChoice(this.context, "primary-segment", input.segmentId, candidate.owner_generation);
      if (!choice) return null;
      if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Conversation Segment prepared delivery is not connected");
      const segment = this.getConversationSegment(input.segmentId);
      if (!segment) return null;
      const reserved = this.completionReviews.reservePrimarySegment({
        segmentId: input.segmentId, ownerGeneration: candidate.owner_generation,
        bindingId: candidate.binding_id, bindingGeneration: candidate.binding_generation,
        pageIndex: input.pageIndex, mentionOpenId: candidate.mention_open_id,
        choiceSpecificationId: choice.id, rootMessageId: segment.rootMessageId,
        ...(worker ? { worker: { id: candidate.worker_id!, generation: candidate.worker_generation!, sessionGeneration: candidate.worker_session_generation! } } : {}),
        card: input.card, reserveDelivery: this.preparedDeliveryReservation
      });
      if (reserved.receipt) this.handoffAfterCommit(reserved.receipt);
      return this.mapPrimarySegmentAction(this.loadPrimarySegmentAction(input.segmentId, candidate.owner_generation)!, choice.prompt);
    });
  }

  decidePrimarySegmentCompletionReview(input: { actionSetId: string; optionId: string; messageId: string; actorOpenId: string; chatId: string; occurredAt: string }): PrimarySegmentCompletionReviewDecision {
    return this.completionReviews.decidePrimarySegment(input);
  }

  acceptPrimarySegmentCompletionChoice(input: { actionSetId: string; optionId: string; ownerSegmentId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string; chatId: string; occurredAt: string }): { segmentId: string; submissionId: string; inserted: boolean } {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const submissionId = completionChoiceSubmissionIdentity(input.actionSetId, input.optionId);
      const sourceKey = submissionId;
      const duplicate = this.context.database.prepare(`SELECT action.owner_id,action.result_source_key,intent.submission_id
        FROM completion_action_sets action JOIN submission_intents intent
          ON intent.ingress_source LIKE 'feishu:%' AND intent.source_message_key=action.result_source_key
        JOIN conversation_segments segment ON segment.id=action.owner_id AND segment.owner_kind='primary'
          AND segment.owner_id=action.binding_id AND segment.owner_generation=action.binding_generation
        JOIN bindings binding ON binding.id=segment.owner_id AND binding.generation=segment.owner_generation
          AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
          AND binding.agent_kind=segment.agent_kind AND binding.agent_session_value=segment.session_id
        WHERE action.id=? AND action.owner_kind='primary-segment' AND action.owner_id=?
          AND action.owner_generation=? AND action.card_message_id=? AND action.mention_open_id=?
          AND action.state='consumed' AND action.selected_choice_option_id=? AND action.result_source_key=?`).get(
        input.actionSetId, input.ownerSegmentId, input.ownerGeneration, input.cardMessageId,
        input.actorOpenId, input.optionId, sourceKey
      ) as { owner_id:string; result_source_key:string; submission_id:string } | undefined;
      if (duplicate) return { segmentId: duplicate.owner_id, submissionId: duplicate.submission_id, inserted: false };
      const row = this.context.database.prepare(`SELECT action.owner_id,action.binding_id,action.binding_generation,
          action.page_index,action.card_id,action.card_message_id,action.mention_open_id,option.message,
          segment.submission_id AS owner_submission_id,binding.pane_id,binding.traex_session_id AS terminal_id,binding.agent_kind,
          binding.agent_session_value,intent.ingress_source,intent.actor_json
        FROM completion_action_sets action
        JOIN completion_choice_options option ON option.specification_id=action.choice_specification_id AND option.option_id=?
        JOIN conversation_segments segment ON segment.id=action.owner_id AND segment.owner_kind='primary'
          AND segment.owner_id=action.binding_id AND segment.owner_generation=action.binding_generation
          AND segment.state='completed'
        JOIN conversation_segment_pages page ON page.segment_id=segment.id AND page.page_index=action.page_index
          AND COALESCE(page.card_id,page.message_id)=action.card_id AND page.message_id=action.card_message_id
          AND page.page_index=(SELECT MAX(page_index) FROM conversation_segment_pages WHERE segment_id=segment.id)
        JOIN bindings binding ON binding.id=action.binding_id AND binding.generation=action.binding_generation
          AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
          AND binding.agent_kind=segment.agent_kind AND binding.agent_session_value=segment.session_id
        JOIN submission_intents intent ON intent.submission_id=segment.submission_id
        WHERE action.id=? AND action.owner_kind='primary-segment' AND action.owner_id=?
          AND action.owner_generation=? AND action.card_message_id=? AND action.mention_open_id=? AND action.state='available'`).get(
        input.optionId, input.actionSetId, input.ownerSegmentId, input.ownerGeneration,
        input.cardMessageId, input.actorOpenId
      ) as {
        owner_id:string; binding_id:string; binding_generation:number; page_index:number; card_id:string;
        card_message_id:string; mention_open_id:string; message:string; owner_submission_id:string;
        pane_id:string|null; terminal_id:string|null; agent_kind:"traex"|"pi"|null; agent_session_value:string|null;
        ingress_source:string; actor_json:string;
      } | undefined;
      if (!row || !row.pane_id || !row.terminal_id || !row.agent_kind || !row.agent_session_value) throw new Error("Completion choice is no longer available");
      let actor: SubmissionIntentActor;
      try { actor = JSON.parse(row.actor_json) as SubmissionIntentActor; } catch { throw new Error("Completion choice is no longer available"); }
      if (actor.kind !== "human" || actor.id !== input.actorOpenId || actor.chatId !== input.chatId
        || actor.gatewayId !== row.ingress_source || !actor.gatewayId.startsWith("feishu:")) throw new Error("Completion choice is no longer available");
      const consumed = this.context.database.prepare(`UPDATE completion_action_sets
        SET state='consumed',selected_choice_option_id=?,result_source_key=?,decided_at=?,updated_at=?
        WHERE id=? AND owner_kind='primary-segment' AND owner_id=? AND owner_generation=?
          AND card_message_id=? AND mention_open_id=? AND state='available'`).run(
        input.optionId, sourceKey, input.occurredAt, input.occurredAt, input.actionSetId,
        input.ownerSegmentId, input.ownerGeneration, input.cardMessageId, input.actorOpenId
      );
      if (consumed.changes !== 1) throw new Error("Completion choice is no longer available");
      const humanInput = humanInputMessage(row.message, {
        actionSetId: input.actionSetId,
        optionId: input.optionId,
        sourceMessageId: row.card_message_id
      });
      this.context.database.prepare(`INSERT INTO submission_intents(
        submission_id,ingress_source,source_message_key,actor_json,input_json,text,owner_kind,owner_id,owner_generation,
        pane_id,terminal_id,expected_agent_kind,expected_session_id,state,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'primary',?,?,?,?,?,?,'recorded',?,?)`).run(
        submissionId, actor.gatewayId, sourceKey, JSON.stringify(actor), canonicalHumanInputJson(humanInput), humanInput.text, row.binding_id,
        row.binding_generation, row.pane_id, row.terminal_id, row.agent_kind, row.agent_session_value,
        input.occurredAt, input.occurredAt
      );
      this.markPrimarySegmentActionChanged(row.owner_id, input.occurredAt);
      return { segmentId: row.owner_id, submissionId, inserted: true };
    });
  }

  ignorePrimarySegmentCompletionChoice(input: { actionSetId: string; ownerSegmentId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string; chatId: string; occurredAt: string }): { ownerId: string; changed: boolean } {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const row = this.context.database.prepare(`SELECT action.owner_id,action.state,action.reason,intent.actor_json
        FROM completion_action_sets action
        JOIN conversation_segments segment ON segment.id=action.owner_id AND segment.submission_id IS NOT NULL
        JOIN bindings binding ON binding.id=segment.owner_id AND binding.generation=segment.owner_generation
          AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
          AND binding.agent_kind=segment.agent_kind AND binding.agent_session_value=segment.session_id
        JOIN submission_intents intent ON intent.submission_id=segment.submission_id
        WHERE action.id=? AND action.owner_kind='primary-segment' AND action.owner_id=?
          AND action.owner_generation=? AND action.card_message_id=? AND action.mention_open_id=?`).get(
        input.actionSetId, input.ownerSegmentId, input.ownerGeneration, input.cardMessageId, input.actorOpenId
      ) as { owner_id:string; state:string; reason:string|null; actor_json:string } | undefined;
      let actor: SubmissionIntentActor | null = null;
      try { actor = row ? JSON.parse(row.actor_json) as SubmissionIntentActor : null; } catch { actor = null; }
      if (!row || actor?.kind !== "human" || actor.id !== input.actorOpenId || actor.chatId !== input.chatId) throw new Error("Completion choice is no longer available");
      if (row.state === "consumed" && row.reason === "ignored") return { ownerId: row.owner_id, changed: false };
      if (row.state !== "available") throw new Error("Completion choice is no longer available");
      const changed = this.context.database.prepare(`UPDATE completion_action_sets SET state='consumed',reason='ignored',decided_at=?,updated_at=?
        WHERE id=? AND state='available'`).run(input.occurredAt, input.occurredAt, input.actionSetId);
      if (changed.changes !== 1) throw new Error("Completion choice is no longer available");
      this.markPrimarySegmentActionChanged(row.owner_id, input.occurredAt);
      return { ownerId: row.owner_id, changed: true };
    });
  }


  rebuildRejectedRoot(failedReplyId: string, recoveredAt: string): RejectedTurnCardRootRecovery | null {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const failed = this.context.database.prepare(`SELECT id,gateway_id,gateway_profile_id,idempotency_key,binding_id,worker_id,worker_session_generation,
        target_role,work_class,root_message_id,projection_key,snapshot_revision,state,effect_certainty,auto_recovery_count,
        delivered_message_id,card_id_checkpoint,gateway_checkpoint_json,lane_key,scope_kind,scope_workspace_id,scope_pane_id,
        scope_key,kind,
        delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
        delivery_parent_id,delivery_parent_generation,delivery_parent_session_generation
        FROM outbound_replies WHERE id=?`).get(failedReplyId) as RejectedRootReplyRow | undefined;
      if (!failed || failed.state !== "dead_letter" || failed.auto_recovery_count >= 1
        || failed.effect_certainty !== "rejected" && failed.effect_certainty !== "not-started"
        || failed.delivered_message_id !== null || failed.card_id_checkpoint !== null
        || failed.kind !== "card_reply" || failed.target_role !== "operation_result"
        || failed.root_message_id === null || failed.projection_key === null) return null;
      const recovery = this.context.database.prepare("SELECT 1 FROM delivery_recoveries WHERE failed_reply_id=? AND state='unresolved'").get(failed.id);
      const quarantine = this.context.database.prepare("SELECT 1 FROM outbox_lane_quarantines WHERE lane_key=? AND failed_reply_id=? AND lane_class='immutable' AND state='active'").get(failed.lane_key, failed.id);
      if (!recovery || !quarantine) return null;
      const target = parseTurnCardProjectionKey(failed.projection_key);
      if (!target || target.pageIndex !== 0) return null;
      const segment = this.getConversationSegment(target.segmentId);
      if (!segment || segment.rootMessageId !== failed.root_message_id || failed.snapshot_revision > segment.viewVersion) return null;
      if (!this.matchesCurrentDeliveryOwner(segment, failed)) return null;
      if (this.context.database.prepare("SELECT 1 FROM conversation_segment_pages WHERE segment_id=? AND page_index<>0 LIMIT 1").get(segment.id)) return null;
      const page = this.getPage(segment.id, 0);
      if (page && (page.elementId !== failed.projection_key || page.messageId !== null || page.cardId !== null
        || page.pendingReplyId !== failed.id || page.state !== "creating")) return null;
      const renderer = this.initialTurnCardRenderer;
      if (!renderer) throw new Error("Conversation Segment initial Turn Card renderer is not connected");
      const recoveryGeneration = failed.auto_recovery_count + 1;
      const replacementReplyId = `${failed.projection_key}:recovery:${recoveryGeneration}:create`;
      const recoveryPage: ConversationSegmentPage = page ?? {
        id: `${segment.id}:page:0`, segmentId: segment.id, pageIndex: 0, messageId: null, cardId: null, elementId: failed.projection_key,
        state: "creating", sequence: 0, deliveredSequence: 0, startCursor: null, deliveredCursor: null,
        pendingCursor: null, pendingReplyId: null, createdAt: recoveredAt, updatedAt: recoveredAt
      };
      const view = this.loadActiveProjection(segment.id)?.view;
      if (!view) return null;
      if (!isReplaySafeSupersession({
        effectCertainty: failed.effect_certainty,
        autoRecoveryCount: failed.auto_recovery_count,
        kind: failed.kind,
        idempotencyKey: failed.idempotency_key,
        projectionKey: failed.projection_key,
        reconstructible: true,
        targetFrozen: page?.state === "frozen",
        providerOperationSafe: failed.kind === "card_reply" && failed.target_role === "operation_result",
        ownerCurrent: true,
        hasExternalEffectEvidence: failed.delivered_message_id !== null || failed.card_id_checkpoint !== null || failed.gateway_checkpoint_json !== null,
      })) return null;
      const replacement = this.enqueueOutboundReply({
        id: replacementReplyId, idempotencyKey: replacementReplyId,
        gatewayId: failed.gateway_id, gatewayProfileId: failed.gateway_profile_id,
        bindingId: null, targetRole: "operation_result", rootMessageId: failed.root_message_id, kind: "card_reply",
        payload: JSON.stringify(renderer(view, recoveryPage)), projectionKey: failed.projection_key,
        snapshotRevision: segment.viewVersion, viewVersion: segment.viewVersion,
        laneKeyOverride: failed.projection_key, workClass: failed.work_class
      });
      const prepared = this.context.database.prepare(`SELECT gateway_id,lane_key,scope_kind,scope_key,scope_workspace_id,scope_pane_id,
        delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
        delivery_parent_id,delivery_parent_generation,delivery_parent_session_generation
        FROM outbound_replies WHERE id=? AND state='pending'`).get(replacement.id) as PreparedRootReplyRow | undefined;
      if (!prepared || prepared.gateway_id !== failed.gateway_id || prepared.lane_key !== failed.lane_key
        || prepared.scope_kind !== failed.scope_kind || prepared.scope_key !== failed.scope_key
        || prepared.scope_workspace_id !== failed.scope_workspace_id || prepared.scope_pane_id !== failed.scope_pane_id
        || prepared.delivery_owner_kind !== failed.delivery_owner_kind || prepared.delivery_owner_id !== failed.delivery_owner_id
        || prepared.delivery_owner_generation !== failed.delivery_owner_generation
        || prepared.delivery_owner_session_generation !== failed.delivery_owner_session_generation
        || prepared.delivery_parent_id !== failed.delivery_parent_id
        || prepared.delivery_parent_generation !== failed.delivery_parent_generation
        || prepared.delivery_parent_session_generation !== failed.delivery_parent_session_generation) {
        throw new Error("Rejected Turn Card root successor changed delivery identity");
      }
      transferDeliveryPrerequisites(this.context, failed.id, replacement.id);
      this.context.database.prepare(`INSERT INTO conversation_segment_pages(
        id,segment_id,page_index,message_id,card_id,element_id,state,sequence,start_cursor_json,delivered_cursor_json,pending_reply_id,created_at,updated_at
      ) VALUES(?,?,0,NULL,NULL,?,'creating',0,NULL,NULL,?,?,?)
      ON CONFLICT(segment_id,page_index) DO UPDATE SET message_id=NULL,card_id=NULL,element_id=excluded.element_id,
        state='creating',sequence=0,start_cursor_json=NULL,delivered_cursor_json=NULL,pending_reply_id=excluded.pending_reply_id,updated_at=excluded.updated_at`)
        .run(`${segment.id}:page:0`, segment.id, failed.projection_key, replacement.id, recoveredAt, recoveredAt);
      const dismissed = this.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',
        auto_recovery_count=auto_recovery_count+1,error='Replaced rejected Turn Card root create',updated_at=?
        WHERE id=? AND state='dead_letter' AND effect_certainty IN ('rejected','not-started')
          AND delivered_message_id IS NULL AND card_id_checkpoint IS NULL AND auto_recovery_count < 1`).run(recoveredAt, failed.id);
      if (dismissed.changes !== 1) throw new Error("Rejected Turn Card root changed during recovery");
      this.context.database.prepare(`UPDATE delivery_recoveries SET state='replacement_pending',action='rebuild_turn_card_root',
        replacement_reply_id=?,updated_at=? WHERE failed_reply_id=? AND state IN ('unresolved','replacement_pending')`)
        .run(replacement.id, recoveredAt, failed.id);
      this.context.database.prepare(`UPDATE outbox_lane_quarantines SET state='released',action='turn_card_rebuild',
        released_at=?,updated_at=? WHERE lane_key=? AND failed_reply_id=? AND state='active'`)
        .run(recoveredAt, recoveredAt, failed.lane_key, failed.id);
      return { replacementReplyId: replacement.id, laneKey: failed.lane_key };
    });
  }

  private matchesCurrentDeliveryOwner(segment: ConversationSegment, failed: RejectedRootReplyRow): boolean {
    if (failed.scope_kind !== "pane" || failed.delivery_owner_kind !== segment.ownerKind
      || failed.delivery_owner_id !== segment.ownerId || failed.delivery_owner_generation !== segment.ownerGeneration) return false;
    if (segment.ownerKind === "primary") {
      const binding = this.context.database.prepare(`SELECT id,generation,session_epoch,workspace_id,pane_id,gateway_id
        FROM bindings WHERE id=? AND generation=? AND state='active' AND lifecycle='active' AND attachment='attached'`)
        .get(segment.ownerId, segment.ownerGeneration) as { id:string; generation:number; session_epoch:number; workspace_id:string; pane_id:string|null; gateway_id:string } | undefined;
      return !!binding && binding.pane_id !== null && failed.binding_id === binding.id
        && failed.gateway_id === binding.gateway_id
        && failed.scope_workspace_id === binding.workspace_id && failed.scope_pane_id === binding.pane_id
        && failed.scope_key === JSON.stringify(["pane", binding.workspace_id, binding.pane_id])
        && failed.lane_key === `gateway:${failed.gateway_id}:${failed.projection_key}`
        && failed.delivery_owner_session_generation === binding.session_epoch
        && failed.delivery_parent_id === null && failed.delivery_parent_generation === null && failed.delivery_parent_session_generation === null;
    }
    const worker = this.context.database.prepare(`SELECT worker.id,worker.generation,worker.worker_session_generation,
      worker.parent_binding_id,worker.parent_binding_generation,worker.parent_pane_id,
      binding.workspace_id,binding.pane_id,binding.session_epoch,binding.gateway_id
      FROM agent_instances worker JOIN bindings binding ON binding.id=worker.parent_binding_id AND binding.generation=worker.parent_binding_generation
      WHERE worker.id=? AND worker.generation=? AND worker.role='worker' AND worker.desired_state='running'
        AND worker.worker_session_lifecycle='active' AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'`)
      .get(segment.ownerId, segment.ownerGeneration) as { id:string; generation:number; worker_session_generation:number; parent_binding_id:string; parent_binding_generation:number; parent_pane_id:string; workspace_id:string; pane_id:string|null; session_epoch:number; gateway_id:string } | undefined;
    return !!worker && worker.pane_id !== null && worker.parent_pane_id === worker.pane_id
      && failed.gateway_id === worker.gateway_id
      && failed.worker_id === worker.id && failed.worker_session_generation === worker.worker_session_generation
      && failed.scope_workspace_id === worker.workspace_id && failed.scope_pane_id === worker.pane_id
      && failed.scope_key === JSON.stringify(["pane", worker.workspace_id, worker.pane_id])
      && failed.lane_key === `gateway:${failed.gateway_id}:${failed.projection_key}`
      && failed.delivery_owner_session_generation === worker.worker_session_generation
      && failed.delivery_parent_id === worker.parent_binding_id
      && failed.delivery_parent_generation === worker.parent_binding_generation
      && failed.delivery_parent_session_generation === worker.session_epoch;
  }
  listActionableConversationSegmentPage(input: {
    limit: number;
    after: import("../../domain/ports/conversation-segment.js").ActionableConversationSegmentCursor | null;
    upperBound: import("../../domain/ports/conversation-segment.js").ActionableConversationSegmentCursor | null;
  }): import("../../domain/ports/conversation-segment.js").ActionableConversationSegmentPage {
    const pageSize = actionableConversationSegmentPageSize(input.limit);
    const upperBound = input.upperBound ?? this.getActionableConversationSegmentUpperBound();
    if (!upperBound) return { items: [], nextCursor: null, upperBound: null };
    if (pageSize === 0) return { items: [], nextCursor: null, upperBound };

    if (input.after && input.upperBound) {
      if (input.after.updatedAt > input.upperBound.updatedAt) return { items: [], nextCursor: null, upperBound };
      if (input.after.updatedAt === input.upperBound.updatedAt && input.after.segmentId >= input.upperBound.segmentId) {
        return { items: [], nextCursor: null, upperBound };
      }
    }

    const afterFilter = input.after
      ? "AND (s.updated_at > ? OR (s.updated_at = ? AND s.id > ?))"
      : "";
    const rows = this.context.database.prepare(`
      SELECT s.id AS id, s.updated_at AS updated_at
      FROM conversation_segments s
      ${CURRENT_OR_LATEST_CONVERSATION_PAGE_JOIN}
      WHERE s.root_message_id <> ''
      ${ACTIONABLE_CONVERSATION_SEGMENT_PAGE_PREDICATE}
        AND (s.updated_at < ? OR (s.updated_at = ? AND s.id <= ?))
        ${afterFilter}
      ORDER BY s.updated_at, s.id
      LIMIT ?
    `).all(
      upperBound.updatedAt,
      upperBound.updatedAt,
      upperBound.segmentId,
      ...(input.after ? [input.after.updatedAt, input.after.updatedAt, input.after.segmentId] : []),
      pageSize + 1
    ) as Array<{ id: string; updated_at: string }>;

    const hasMore = rows.length > pageSize;
    const slice = rows.slice(0, pageSize);
    const items = slice.map((row) => row.id);
    const nextCursor = hasMore && slice.length > 0
      ? { updatedAt: slice[slice.length - 1]!.updated_at, segmentId: slice[slice.length - 1]!.id }
      : null;
    return { items, nextCursor, upperBound };
  }

  listActionableConversationSegmentIds(limit = 100): string[] {
    const boundedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1_000) : 0;
    if (boundedLimit === 0) return [];
    const rows = this.context.database.prepare("SELECT s.id,s.state AS segment_state,s.view_version,s.timeline_item_count,p.page_index,p.sequence,p.state,p.pending_reply_id,p.delivered_cursor_json FROM conversation_segments s JOIN conversation_segment_pages p ON p.segment_id=s.id WHERE s.root_message_id <> '' ORDER BY s.id,p.page_index").all() as Array<{ id:string; segment_state:string; view_version:number; timeline_item_count:number; page_index:number; sequence:number; state:string; pending_reply_id:string|null; delivered_cursor_json:string|null }>;
    const actionable = new Set<string>();
    const bySegment = new Map<string, typeof rows>();
    for (const row of rows) (bySegment.get(row.id) ?? (bySegment.set(row.id, []), bySegment.get(row.id)!)).push(row);
    for (const pages of bySegment.values()) {
      const row = pages.filter((p) => p.state === "creating" || p.state === "active" || p.pending_reply_id !== null).at(-1) ?? pages.filter((p) => p.state === "frozen").at(-1);
      if (!row) continue;
      if (row.pending_reply_id || row.state === "creating") { actionable.add(row.id); continue; }
      if (row.state !== "active" && row.state !== "frozen") continue;
      const cursor = row.delivered_cursor_json ? JSON.parse(row.delivered_cursor_json) as { itemIndex?: number } : null;
      const delivered = cursor?.itemIndex ?? 0;
      if (row.timeline_item_count > delivered || row.view_version > row.sequence || ["completed", "failed", "cancelled", "needs_human", "closed"].includes(row.segment_state)) actionable.add(row.id);
    }
    const completionNotifications = this.context.database.prepare(`SELECT obligation.owner_id AS id
      FROM completion_notification_obligations obligation
      JOIN conversation_segments segment ON segment.id=obligation.owner_id
        AND segment.owner_generation=obligation.owner_generation
      JOIN conversation_segment_pages page ON page.segment_id=segment.id
      JOIN outbound_reply_prerequisites prerequisite
        ON prerequisite.dependent_reply_id=obligation.notification_reply_id AND prerequisite.required_state='delivered'
      JOIN outbound_replies reply ON reply.id=prerequisite.prerequisite_reply_id
      JOIN bindings binding ON binding.id=obligation.binding_id
        AND binding.generation=obligation.binding_generation
      WHERE obligation.owner_kind='primary-segment' AND obligation.notice_kind='completion'
        AND obligation.state='waiting_for_answer' AND obligation.notification_reply_id IS NOT NULL
        AND segment.state='completed' AND page.state='finished'
        AND reply.state='delivered' AND reply.kind='card_update'
        AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
      GROUP BY obligation.owner_id
      ORDER BY MIN(obligation.updated_at),obligation.owner_id LIMIT 100`).all() as Array<{ id: string }>;
    for (const row of completionNotifications) actionable.add(row.id);
    const historicalBudget = actionable.size >= boundedLimit
      ? Math.max(1, Math.ceil(boundedLimit / 4))
      : boundedLimit - actionable.size;
    const historical: string[] = [];
    for (const { id } of this.listHistoricalPageRecoveryCandidateIds(historicalBudget)) {
      if (this.nextHistoricalPageRecovery(id)) { actionable.delete(id); historical.push(id); }
    }
    const ordinary = this.rotateActionableConversationSegmentIds([...actionable], boundedLimit - historical.length);
    return [...ordinary, ...historical].sort();
  }

  private getActionableConversationSegmentUpperBound(): { updatedAt: string; segmentId: string } | null {
    const row = this.context.database.prepare(`
      SELECT s.id AS id, s.updated_at AS updated_at
      FROM conversation_segments s
      ${CURRENT_OR_LATEST_CONVERSATION_PAGE_JOIN}
      WHERE s.root_message_id <> ''
      ${ACTIONABLE_CONVERSATION_SEGMENT_PAGE_PREDICATE}
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT 1
    `).get() as { id: string; updated_at: string } | undefined;
    return row ? { updatedAt: row.updated_at, segmentId: row.id } : null;
  }

  private rotateActionableConversationSegmentIds(ids: string[], limit: number): string[] {
    if (limit <= 0 || ids.length === 0) return [];
    ids.sort();
    const cursor = this.actionableConversationSegmentCursor;
    const afterCursor = cursor
      ? ids.findIndex((id) => id > cursor)
      : 0;
    const start = afterCursor < 0 ? 0 : afterCursor;
    const selected = [...ids.slice(start), ...ids.slice(0, start)].slice(0, limit);
    this.actionableConversationSegmentCursor = selected.at(-1) ?? this.actionableConversationSegmentCursor;
    return selected;
  }

  private listHistoricalPageRecoveryCandidateIds(limit: number): Array<{ id: string }> {
    if (limit <= 0) return [];
    const load = (position: "all" | "after" | "through", pageLimit: number): Array<{ id: string; updatedAt: string }> => {
      const boundary = position === "after"
        ? "AND (candidate.updated_at>? OR (candidate.updated_at=? AND candidate.id>?))"
        : position === "through"
          ? "AND (candidate.updated_at<? OR (candidate.updated_at=? AND candidate.id<=?))"
          : "";
      const cursor = this.historicalPageRecoveryCursor;
      const parameters = position === "all" ? [pageLimit] : [cursor!.updatedAt, cursor!.updatedAt, cursor!.id, pageLimit];
      return this.context.database.prepare(`WITH candidates AS (
      SELECT s.id,p.element_id,
        COALESCE((SELECT part.end_cursor_json FROM conversation_segment_page_recovery_parts part
          WHERE part.segment_id=s.id AND part.source_page_index=p.page_index AND part.state='delivered'
          ORDER BY part.part_index DESC LIMIT 1),p.start_cursor_json) AS start_cursor_json,
        COALESCE(p.delivered_cursor_json,
          (SELECT next.start_cursor_json FROM conversation_segment_pages next
            WHERE next.segment_id=s.id AND next.page_index>p.page_index ORDER BY next.page_index LIMIT 1),
          json_object('itemIndex',s.timeline_item_count,'markdownOffset',0)) AS end_cursor_json,
        (SELECT part.end_cursor_json FROM conversation_segment_page_recovery_parts part
          WHERE part.segment_id=s.id AND part.source_page_index=p.page_index AND part.state='delivered'
          ORDER BY part.part_index DESC LIMIT 1) AS recovered_cursor_json,
        (SELECT reply.payload FROM outbound_replies reply
          WHERE reply.projection_key=p.element_id AND reply.state='delivered'
          ORDER BY reply.delivery_order DESC LIMIT 1) AS delivered_payload,
        s.updated_at
      FROM conversation_segments s
      JOIN conversation_segment_pages p ON p.segment_id=s.id
      WHERE p.page_index>0 AND p.state IN ('frozen','finished') AND p.start_cursor_json IS NOT NULL
        AND s.state IN ('completed','failed','cancelled','needs_human','closed')
        AND NOT EXISTS(SELECT 1 FROM conversation_segment_page_recovery_parts pending
          WHERE pending.segment_id=s.id AND pending.state='pending'
            AND NOT EXISTS(SELECT 1 FROM outbound_replies reply
              WHERE reply.id=pending.reply_id AND reply.state='delivered' AND reply.delivered_message_id IS NOT NULL))
    )
    SELECT DISTINCT candidate.id,candidate.updated_at AS updatedAt FROM candidates candidate
    WHERE candidate.delivered_payload IS NOT NULL
      AND (
        CAST(json_extract(candidate.end_cursor_json,'$.itemIndex') AS INTEGER)
          > CAST(json_extract(candidate.start_cursor_json,'$.itemIndex') AS INTEGER)
        OR (CAST(json_extract(candidate.end_cursor_json,'$.itemIndex') AS INTEGER)
            = CAST(json_extract(candidate.start_cursor_json,'$.itemIndex') AS INTEGER)
          AND COALESCE(json_extract(candidate.end_cursor_json,'$.offset'),json_extract(candidate.end_cursor_json,'$.markdownOffset'),0)
            > COALESCE(json_extract(candidate.start_cursor_json,'$.offset'),json_extract(candidate.start_cursor_json,'$.markdownOffset'),0))
      )
      AND (candidate.recovered_cursor_json IS NOT NULL OR (
        json_valid(candidate.delivered_payload)=1
        AND NOT EXISTS(SELECT 1 FROM json_tree(candidate.delivered_payload) proof
          WHERE proof.key IN ('element_id','slot') AND CAST(proof.value AS TEXT)=candidate.element_id)
      ))
      ${boundary}
    ORDER BY candidate.updated_at,candidate.id LIMIT ?`).all(...parameters) as Array<{ id: string; updatedAt: string }>;
    };
    const candidates = load(this.historicalPageRecoveryCursor ? "after" : "all", limit);
    if (this.historicalPageRecoveryCursor && candidates.length < limit) {
      candidates.push(...load("through", limit - candidates.length));
    }
    const last = candidates.at(-1);
    if (last) this.historicalPageRecoveryCursor = { updatedAt: last.updatedAt, id: last.id };
    return candidates.map(({ id }) => ({ id }));
  }

  recoverPrimarySegmentCompletionNotification(segmentId: string): SegmentCompletionNotificationRecoveryResult {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const preparedDelivery = this.preparedDeliveryReservation && this.preparedDeliveryConsumer
        ? { reservation: this.preparedDeliveryReservation, consumer: this.preparedDeliveryConsumer }
        : undefined;
      return recoverSegmentCompletionNotification(this.context, segmentId, preparedDelivery);
    });
  }

  invalidateCurrentPrimarySessionActivity(input: SessionActivityInvalidationFence): ConversationSegmentProjectionNotification | null {
    const notifications = this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const notifications: ConversationSegmentProjectionNotification[] = [];
      const invalidate = (current: {
        id: string; view_version: number; page_index: number; page_state: ConversationSegmentPage["state"];
        sequence: number; delivered_sequence: number; pending_reply_id: string | null;
      }) => {
        const viewVersion = Math.max(current.view_version, current.sequence, current.delivered_sequence) + 1;
        this.context.database.prepare("UPDATE conversation_segments SET view_version=?,updated_at=? WHERE id=?")
          .run(viewVersion, input.occurredAt, current.id);
        if (current.page_state === "finished") {
          if (current.pending_reply_id) {
            this.context.database.prepare(`UPDATE conversation_segment_pages SET sequence=MAX(sequence,?),updated_at=?
              WHERE segment_id=? AND page_index=? AND state='finished'`).run(viewVersion, input.occurredAt, current.id, current.page_index);
          } else {
            this.context.database.prepare(`UPDATE conversation_segment_pages SET state='active',updated_at=?
              WHERE segment_id=? AND page_index=? AND state='finished' AND pending_reply_id IS NULL`).run(input.occurredAt, current.id, current.page_index);
          }
        }
        notifications.push({ segmentId: current.id, viewVersion, urgency: "immediate" });
      };
      const current = this.context.database.prepare(`WITH current_segment AS (
        SELECT segment.id,segment.view_version,segment.root_message_id
        FROM bindings binding
        JOIN conversation_segments segment ON segment.owner_kind='primary'
          AND segment.owner_id=binding.id AND segment.owner_generation=binding.generation
          AND segment.session_id=binding.agent_session_value
        WHERE binding.id=? AND binding.generation=? AND binding.session_epoch=?
          AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
          AND binding.pane_id IS NOT NULL AND segment.start_lane_sequence IS NOT NULL
        ORDER BY segment.start_lane_sequence DESC,segment.start_item_ordinal DESC,segment.created_at DESC,segment.id DESC
        LIMIT 1
      )
        SELECT segment.id,segment.view_version,
          page.page_index,page.state AS page_state,page.sequence,page.delivered_sequence,page.pending_reply_id
        FROM current_segment segment
        JOIN conversation_segment_pages page ON page.segment_id=segment.id
          AND page.page_index=(SELECT MAX(latest.page_index) FROM conversation_segment_pages latest WHERE latest.segment_id=segment.id)
        WHERE segment.root_message_id<>''`).get(input.bindingId, input.bindingGeneration, input.sessionEpoch) as {
          id: string; view_version: number; page_index: number; page_state: ConversationSegmentPage["state"];
          sequence: number; delivered_sequence: number; pending_reply_id: string | null;
        } | undefined;
      if (current) invalidate(current);
      const workerCurrents = this.context.database.prepare(`SELECT segment.id,segment.view_version,
          page.page_index,page.state AS page_state,page.sequence,page.delivered_sequence,page.pending_reply_id
        FROM bindings binding
        JOIN agent_instances worker ON worker.parent_binding_id=binding.id
          AND worker.parent_binding_generation=binding.generation AND worker.parent_pane_id=binding.pane_id
        JOIN session_activity_snapshots activity ON activity.producer_kind='worker' AND activity.producer_id=worker.id
          AND activity.producer_generation=worker.generation AND activity.producer_session_generation=worker.worker_session_generation
          AND activity.runtime_pane_id=worker.pane_id AND activity.binding_id=binding.id
          AND activity.binding_generation=binding.generation AND activity.session_epoch=binding.session_epoch
          AND activity.workspace_id=binding.workspace_id AND activity.pane_id=binding.pane_id
          AND activity.native_session_id=worker.native_session_id AND activity.agent_kind=worker.agent_kind
          AND activity.producer_kind=? AND activity.producer_id=?
          AND activity.producer_generation=? AND activity.producer_session_generation=? AND activity.runtime_pane_id=?
        JOIN conversation_segments segment ON segment.owner_kind='worker' AND segment.owner_id=worker.id
          AND segment.owner_generation=worker.generation AND segment.agent_kind=worker.agent_kind
          AND segment.session_id=worker.native_session_id
          AND segment.id=(SELECT current.id FROM conversation_segments current
            WHERE current.owner_kind='worker' AND current.owner_id=worker.id
              AND current.owner_generation=worker.generation AND current.agent_kind=worker.agent_kind
              AND current.session_id=worker.native_session_id AND current.start_lane_sequence IS NOT NULL
            ORDER BY current.start_lane_sequence DESC,current.start_item_ordinal DESC,current.created_at DESC,current.id DESC
            LIMIT 1)
        JOIN conversation_segment_pages page ON page.segment_id=segment.id
          AND page.page_index=(SELECT MAX(latest.page_index) FROM conversation_segment_pages latest WHERE latest.segment_id=segment.id)
        WHERE binding.id=? AND binding.generation=? AND binding.session_epoch=?
          AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
          AND binding.pane_id IS NOT NULL AND binding.agent_session_kind='id' AND binding.agent_session_value IS NOT NULL
          AND worker.role='worker' AND worker.worker_session_lifecycle='active'
          AND worker.pane_id IS NOT NULL AND worker.native_session_id IS NOT NULL
          AND worker.parent_native_session_id=binding.agent_session_value AND segment.root_message_id<>''`).all(
        input.producer.kind, input.producer.id, input.producer.runtimeGeneration, input.producer.sessionGeneration,
        input.producer.runtimePaneId, input.bindingId, input.bindingGeneration, input.sessionEpoch
      ) as Array<{
          id: string; view_version: number; page_index: number; page_state: ConversationSegmentPage["state"];
          sequence: number; delivered_sequence: number; pending_reply_id: string | null;
        }>;
      for (const workerCurrent of workerCurrents) invalidate(workerCurrent);
      return notifications;
    });
    for (const notification of notifications) this.notifyProjection(notification);
    return notifications[0] ?? null;
  }
  nextHistoricalPageRecovery(segmentId: string): ConversationSegmentPageRecoveryCandidate | null {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => this.findHistoricalPageRecovery(segmentId));
  }
  nextLateItemRecovery(segmentId: string): ConversationSegmentLateRecoveryCandidate | null {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const pending = this.context.database.prepare(`SELECT id,pending_cursor_json,reply_id FROM conversation_segment_late_recoveries
        WHERE segment_id=? AND state='pending' ORDER BY id LIMIT 1`).get(segmentId) as { id:number; pending_cursor_json:string|null; reply_id:string } | undefined;
      if (pending) {
        const reply = this.context.database.prepare("SELECT state,delivered_message_id,effect_certainty FROM outbound_replies WHERE id=?").get(pending.reply_id) as { state:string; delivered_message_id:string|null; effect_certainty:string|null } | undefined;
        if (!reply || reply.state === "dismissed" || reply.state === "dead_letter" && !["rejected", "not-started"].includes(reply.effect_certainty ?? "")) {
          this.context.database.prepare("UPDATE conversation_segment_late_recoveries SET state='failed',updated_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), pending.id);
        } else if (reply.state === "dead_letter") {
          this.context.database.prepare(`UPDATE conversation_segment_late_recoveries SET state='queued',part_index=part_index+1,
            pending_cursor_json=NULL,reply_id=NULL,updated_at=? WHERE id=? AND state='pending'`).run(new Date().toISOString(), pending.id);
        } else {
          if (reply.state !== "delivered" || !reply.delivered_message_id) return null;
          const timestamp = new Date().toISOString();
          if (pending.pending_cursor_json) {
            this.context.database.prepare(`UPDATE conversation_segment_late_recoveries SET state='queued',part_index=part_index+1,
              start_cursor_json=pending_cursor_json,pending_cursor_json=NULL,reply_id=NULL,message_id=?,updated_at=? WHERE id=? AND state='pending'`)
              .run(reply.delivered_message_id, timestamp, pending.id);
          } else {
            this.context.database.prepare("UPDATE conversation_segment_late_recoveries SET state='delivered',message_id=?,updated_at=? WHERE id=? AND state='pending'")
              .run(reply.delivered_message_id, timestamp, pending.id);
            this.context.database.prepare(`UPDATE projection_gaps SET state='compensated',compensated_by_version=0,compensated_at=?
              WHERE stage='turn_recovery' AND owner_kind='turn_card' AND owner_id=?
                AND source_item_id=(SELECT item_id FROM conversation_segment_late_recoveries WHERE id=?) AND state='open'`)
              .run(timestamp, segmentId, pending.id);
          }
        }
      }
      const row = this.context.database.prepare(`SELECT recovery.id,recovery.part_index,recovery.start_cursor_json,recovery.message_id,
          item.item_json,(SELECT message_id FROM conversation_segment_late_recoveries delivered
            WHERE delivered.segment_id=recovery.segment_id AND delivered.message_id IS NOT NULL ORDER BY delivered.id DESC LIMIT 1) AS prior_recovery_message,
          (SELECT message_id FROM conversation_segment_pages page WHERE page.segment_id=recovery.segment_id AND page.message_id IS NOT NULL ORDER BY page.page_index DESC LIMIT 1) AS page_message
        FROM conversation_segment_late_recoveries recovery
        JOIN conversation_segment_items item ON item.segment_id=recovery.segment_id AND item.item_id=recovery.item_id
        WHERE recovery.segment_id=? AND recovery.state='queued'
          AND NOT EXISTS(SELECT 1 FROM conversation_segment_late_recoveries pending WHERE pending.segment_id=recovery.segment_id AND pending.state='pending')
        ORDER BY recovery.id LIMIT 1`).get(segmentId) as {
          id:number; part_index:number; start_cursor_json:string|null; message_id:string|null; item_json:string; prior_recovery_message:string|null; page_message:string|null;
        } | undefined;
      const anchorMessageId = row?.message_id ?? row?.prior_recovery_message ?? row?.page_message;
      if (!row || !anchorMessageId) return null;
      return {
        segmentId, recoveryId: row.id, partIndex: row.part_index, item: JSON.parse(row.item_json) as AnswerTimelineItem,
        startCursor: row.start_cursor_json ? JSON.parse(row.start_cursor_json) as AnswerTimelineCursor : null,
        anchorMessageId, projectionKey: turnCardLateRecoveryProjectionKey(segmentId, row.id, row.part_index)
      };
    });
  }
  reserveLateItemRecovery(input: ConversationSegmentLateRecoveryCandidate & { card:object; nextCursor:AnswerTimelineCursor|null; workClass?:OutboundWorkClass }): "reserved"|"waiting"|"stale" {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const row = this.context.database.prepare("SELECT state,part_index,message_id FROM conversation_segment_late_recoveries WHERE id=? AND segment_id=?")
        .get(input.recoveryId, input.segmentId) as { state:string; part_index:number; message_id:string|null } | undefined;
      if (row?.state === "pending") return "waiting";
      if (!row || row.state !== "queued" || row.part_index !== input.partIndex || input.projectionKey !== turnCardLateRecoveryProjectionKey(input.segmentId, input.recoveryId, input.partIndex)) return "stale";
      const anchorMessageId = row.message_id ?? input.anchorMessageId;
      if (anchorMessageId !== input.anchorMessageId) return "stale";
      const reply = this.enqueueOutboundReply({
        id: randomUUID(), idempotencyKey: input.projectionKey, bindingId: null, targetRole: "operation_result",
        rootMessageId: anchorMessageId, kind: "card_reply", payload: JSON.stringify(input.card), projectionKey: input.projectionKey,
        snapshotRevision: 1, viewVersion: 1, laneKeyOverride: input.projectionKey, ...(input.workClass ? { workClass: input.workClass } : {})
      });
      const changed = this.context.database.prepare(`UPDATE conversation_segment_late_recoveries SET state='pending',reply_id=?,pending_cursor_json=?,updated_at=?
        WHERE id=? AND segment_id=? AND state='queued' AND part_index=?`).run(
          reply.id, input.nextCursor ? JSON.stringify(input.nextCursor) : null, new Date().toISOString(), input.recoveryId, input.segmentId, input.partIndex
        );
      if (changed.changes !== 1) throw new Error("Late Conversation recovery changed during reservation");
      return "reserved";
    });
  }
  reserveHistoricalPageRecovery(input: ConversationSegmentPageRecoveryCandidate & { card:object; endAnchor:ConversationSegmentCursorAnchor; workClass?:OutboundWorkClass }): "reserved"|"waiting"|"stale" {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const existing = this.context.database.prepare("SELECT state FROM conversation_segment_page_recovery_parts WHERE segment_id=? AND source_page_index=? AND part_index=?").get(input.segmentId, input.sourcePageIndex, input.partIndex) as { state:string } | undefined;
      if (existing?.state === "pending") return "waiting";
      if (existing) return "stale";
      const candidate = this.findHistoricalPageRecovery(input.segmentId);
      const endAfterStart = compareTimelineCursor(input.endCursor, input.startCursor);
      const endWithinTarget = compareTimelineCursor(input.endCursor, candidate?.endCursor ?? input.startCursor);
      if (!candidate || candidate.sourcePageIndex !== input.sourcePageIndex || candidate.partIndex !== input.partIndex || candidate.anchorMessageId !== input.anchorMessageId
        || candidate.gatewayId !== input.gatewayId || candidate.projectionKey !== input.projectionKey
        || !sameTimelineCursor(candidate.startCursor, input.startCursor)
        || !Number.isFinite(endAfterStart) || endAfterStart <= 0
        || !Number.isFinite(endWithinTarget) || endWithinTarget > 0) return "stale";
      const reply = this.enqueueOutboundReply({
        id: randomUUID(), idempotencyKey: input.projectionKey, gatewayId: input.gatewayId,
        bindingId: null, targetRole: "operation_result", rootMessageId: input.anchorMessageId,
        kind: "card_reply", payload: JSON.stringify(input.card), projectionKey: input.projectionKey,
        snapshotRevision: 1, viewVersion: 1, laneKeyOverride: input.projectionKey,
        ...(input.workClass ? { workClass: input.workClass } : {})
      });
      const timestamp = new Date().toISOString();
      this.context.database.prepare(`INSERT INTO conversation_segment_page_recovery_parts(
        segment_id,source_page_index,part_index,start_cursor_json,end_cursor_json,reply_id,message_id,state,created_at,updated_at,
        end_lane_sequence,end_item_ordinal,end_anchor_inclusive
      ) VALUES(?,?,?,?,?,?,NULL,'pending',?,?,?,?,?)`).run(
        input.segmentId, input.sourcePageIndex, input.partIndex, JSON.stringify(input.startCursor), JSON.stringify(input.endCursor), reply.id, timestamp, timestamp,
        input.endAnchor.position.laneSequence,input.endAnchor.position.itemOrdinal,input.endAnchor.inclusive ? 1 : 0
      );
      return "reserved";
    });
  }
  checkpointPage(input: { segmentId: string; pageIndex: number; replyId: string; messageId: string; cardId: string | null }): "checkpointed" | "stale" {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const result = settleConversationPageDelivery(this.context, input);
      if (result === "stale") new SqliteProjectionGapStore(this.context).open({
        stage: "turn_recovery", ownerKind: "turn_card", ownerId: input.segmentId,
        sourceItemId: turnCardProjectionKey(input.segmentId, input.pageIndex), failureClass: "permanent",
        failureCode: "immutable_target_mismatch", requiredVersion: 0, occurredAt: new Date().toISOString()
      });
      return result;
    });
  }
  reconcilePageDelivery(segmentId: string, pageIndex: number): "adopted" | "waiting" | "ready" | "stale" {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const row = this.context.database.prepare(`SELECT s.submission_id,s.root_message_id,p.state,p.message_id,p.element_id,p.pending_reply_id
        FROM conversation_segments s JOIN conversation_segment_pages p ON p.segment_id=s.id
        WHERE s.id=? AND p.page_index=?`).get(segmentId, pageIndex) as { submission_id:string|null; root_message_id:string; state:string; message_id:string|null; element_id:string; pending_reply_id:string|null } | undefined;
      if (!row || row.element_id !== turnCardProjectionKey(segmentId, pageIndex)) return "stale";
      if (row.pending_reply_id === null) {
        if (row.message_id !== null || row.state !== "creating") return "ready";
        const admissionOwned = row.submission_id !== null && this.context.database.prepare(`SELECT 1 AS owned
          WHERE EXISTS(SELECT 1 FROM submission_intents WHERE submission_id=?)
             OR EXISTS(SELECT 1 FROM instance_turns WHERE id=?)`).get(row.submission_id, row.submission_id) !== undefined;
        const existingEffect = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE projection_key=? LIMIT 1").get(row.element_id) !== undefined;
        if (!admissionOwned && !existingEffect) return "ready";
        this.openCreateRecoveryGap(segmentId, pageIndex, "missing_initial_create_link");
        return "stale";
      }
      const prior = pageIndex === 0 ? null : this.context.database.prepare("SELECT message_id FROM conversation_segment_pages WHERE segment_id=? AND page_index=?").get(segmentId, pageIndex - 1) as { message_id:string|null } | undefined;
      const reply = this.context.database.prepare(`SELECT id,kind,state,root_message_id,projection_key,delivered_message_id,card_id_checkpoint,failure_class,effect_certainty
        FROM outbound_replies WHERE id=?`).get(row.pending_reply_id) as { id:string; kind:string; state:string; root_message_id:string|null; projection_key:string|null; delivered_message_id:string|null; card_id_checkpoint:string|null; failure_class:string|null; effect_certainty:string|null } | undefined;
      const exactTarget = reply && (reply.kind === "card_reply" ? reply.root_message_id === (pageIndex === 0 ? row.root_message_id : prior?.message_id) : reply.kind === "card_update" && row.message_id !== null && reply.root_message_id === row.message_id);
      const exact = reply && exactTarget && reply.projection_key === row.element_id;
      if (exact && reply.state === "pending") return "waiting";
      if (exact && reply.state === "dead_letter" && (reply.failure_class === "transient" || reply.effect_certainty === "not-started")) return "waiting";
      if (exact && reply.state === "delivered" && reply.delivered_message_id) {
        return this.checkpointPage({ segmentId, pageIndex, replyId: reply.id, messageId: reply.delivered_message_id, cardId: reply.card_id_checkpoint }) === "checkpointed" ? "adopted" : "stale";
      }
      this.openCreateRecoveryGap(segmentId, pageIndex, "pending_reply_link_mismatch");
      return "stale";
    });
  }
  reserveSnapshot(input: { segmentId: string; pageIndex: number; messageId: string|null; card: object; cursor: AnswerTimelineCursor|null; viewVersion: number; cardId?: string|null; elementId?: string; workClass?: OutboundWorkClass }): "reserved"|"waiting"|"noop"|"stale" {
    const result = this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const segment = this.getConversationSegment(input.segmentId); const page = this.getPage(input.segmentId, input.pageIndex);
      if (!segment || !page || page.deliveryCohort === "semantic" || page.state === "frozen" || page.state === "finished" || page.elementId !== turnCardProjectionKey(input.segmentId, input.pageIndex)) return "stale";
      if (page.messageId !== null && (!input.elementId || input.elementId !== page.elementId)) return "stale";
      if (input.elementId && input.elementId !== page.elementId) return "stale";
      if (page.messageId !== null && input.messageId !== page.messageId) return "stale";
      if (page.messageId === null && input.messageId !== null) return "stale";
      if (input.cardId !== undefined && input.cardId !== null && page.cardId !== null && input.cardId !== page.cardId) return "stale";
      const key = `segment:${input.segmentId}:page:${input.pageIndex}:snapshot:${input.viewVersion}`;
      if (page.pendingReplyId) return "waiting";
      if (input.viewVersion <= page.deliveredSequence && !cursorAfter(input.cursor, page.deliveredCursor)) return "noop";
      const projectionKey = turnCardProjectionKey(input.segmentId, input.pageIndex);
      const reply = this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: input.messageId ? key : `segment:${input.segmentId}:page:${input.pageIndex}:create`, bindingId: null, targetRole: "operation_result", rootMessageId: input.messageId ?? segment.rootMessageId, kind: input.messageId ? "card_update" : "card_reply", payload: JSON.stringify(input.card), projectionKey, snapshotRevision: input.viewVersion, viewVersion: input.viewVersion, laneKeyOverride: projectionKey, ...(input.workClass ? { workClass: input.workClass } : {}) });
      if (input.messageId && this.completionPresentationFinalEventId(input.segmentId)) {
        this.requireDeliveredPageCreationPrerequisite(reply.id, input.segmentId, input.pageIndex, input.messageId);
      }
      this.context.database.prepare("UPDATE conversation_segment_pages SET pending_reply_id=? WHERE segment_id=? AND page_index=?").run(reply.id, input.segmentId, input.pageIndex);
      this.context.database.prepare("UPDATE conversation_segment_pages SET pending_cursor_json=?, sequence=MAX(sequence,?), state=CASE WHEN message_id IS NULL THEN 'creating' ELSE 'active' END, updated_at=? WHERE segment_id=? AND page_index=?").run(input.cursor ? JSON.stringify(input.cursor) : null, input.viewVersion, new Date().toISOString(), input.segmentId, input.pageIndex);
      return "reserved";
    });
    return result;
  }
  reserveSemanticSnapshot(input: SemanticConversationPageReservation): "reserved"|"waiting"|"noop"|"stale" {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      if (input.transition === "continuation") return this.reserveSemanticContinuationInTransaction(input);
      const segment = this.getConversationSegment(input.segmentId);
      const page = this.getPage(input.segmentId, input.pageIndex);
      if (!segment || !page || page.deliveryCohort !== "semantic"
        || page.elementId !== turnCardProjectionKey(input.segmentId, input.pageIndex)) return "stale";
      if (page.messageId !== null && input.elementId !== page.elementId) return "stale";
      if (input.elementId !== page.elementId || page.messageId !== input.messageId) return "stale";
      if (input.cardId !== undefined && input.cardId !== null && page.cardId !== null && input.cardId !== page.cardId) return "stale";
      if (page.pendingReplyId) return "waiting";

      if (input.transition === "snapshot") {
        if (page.state === "frozen" || page.state === "finished") return "stale";
        if (input.viewVersion <= page.deliveredSequence && !cursorAfter(input.cursor, page.deliveredCursor)) return "noop";
        const receipt = this.reserveSemanticPageReply(segment, {
          ...input, targetPageIndex: input.pageIndex, revision: input.viewVersion,
          idempotencyKey: input.messageId ? `segment:${input.segmentId}:page:${input.pageIndex}:snapshot:${input.viewVersion}` : `segment:${input.segmentId}:page:${input.pageIndex}:create`,
          rootMessageId: input.messageId ?? segment.rootMessageId, kind: input.messageId ? "card_update" : "card_reply"
        });
        if (input.messageId && this.completionPresentationFinalEventId(input.segmentId)) {
          this.requireDeliveredPageCreationPrerequisite(receipt.result.id, input.segmentId, input.pageIndex, input.messageId);
        }
        this.context.database.prepare("UPDATE conversation_segment_pages SET pending_reply_id=?,pending_cursor_json=?,sequence=MAX(sequence,?),state=CASE WHEN message_id IS NULL THEN 'creating' ELSE 'active' END,updated_at=? WHERE segment_id=? AND page_index=?")
          .run(receipt.result.id, input.cursor ? JSON.stringify(input.cursor) : null, input.viewVersion, new Date().toISOString(), input.segmentId, input.pageIndex);
        return "reserved";
      }

      if (input.transition === "freeze") {
        if (page.state === "frozen") return page.deliveredSequence >= page.sequence ? "noop" : "waiting";
        if (page.state !== "active" || !page.messageId) return "stale";
        const revision = Math.max(page.sequence, page.deliveredSequence) + 1;
        const receipt = this.reserveSemanticPageReply(segment, {
          ...input, targetPageIndex: input.pageIndex, revision,
          idempotencyKey: `segment:${input.segmentId}:page:${input.pageIndex}:freeze`,
          rootMessageId: input.messageId, kind: "card_update"
        });
        this.context.database.prepare(`UPDATE conversation_segment_pages
          SET state='frozen',sequence=?,pending_cursor_json=?,pending_reply_id=?,
            continuation_lane_sequence=?,continuation_item_ordinal=?,continuation_anchor_inclusive=?,continuation_cursor_base=?,updated_at=?
          WHERE segment_id=? AND page_index=?`).run(
          revision, JSON.stringify(input.cursor), receipt.result.id,
          input.cursorAnchor.position.laneSequence, input.cursorAnchor.position.itemOrdinal,
          input.cursorAnchor.inclusive ? 1 : 0, input.cursor.itemIndex, new Date().toISOString(), input.segmentId, input.pageIndex
        );
        return "reserved";
      }

      if (page.state === "finished") return page.deliveredSequence >= page.sequence ? "noop" : "waiting";
      if (page.state !== "active" || !page.messageId) return "stale";
      const revision = page.sequence + 1;
      const finishBaseKey = page.sequence === 1
        ? `segment:${input.segmentId}:page:${input.pageIndex}:finish`
        : `segment:${input.segmentId}:page:${input.pageIndex}:finish:${revision}`;
      const finalEventId = this.completionPresentationFinalEventId(input.segmentId);
      const finishKey = finalEventId ? `${finishBaseKey}:final:${encodeURIComponent(finalEventId)}` : finishBaseKey;
      const receipt = this.reserveSemanticPageReply(segment, {
        ...input, targetPageIndex: input.pageIndex, revision, idempotencyKey: finishKey,
        rootMessageId: input.messageId, kind: "card_update"
      });
      if (finalEventId) this.requireDeliveredPageCreationPrerequisite(receipt.result.id, input.segmentId, input.pageIndex, input.messageId);
      const timestamp = new Date().toISOString();
      this.context.database.prepare("UPDATE conversation_segment_pages SET state='finished',sequence=?,pending_cursor_json=?,pending_reply_id=?,updated_at=? WHERE segment_id=? AND page_index=?")
        .run(revision, JSON.stringify(input.cursor), receipt.result.id, timestamp, input.segmentId, input.pageIndex);
      this.context.database.prepare(`UPDATE completion_notification_obligations
        SET presentation_reply_id=COALESCE(presentation_reply_id,?),updated_at=?
        WHERE owner_kind='primary-segment' AND owner_id=? AND notice_kind='completion'
          AND state IN ('waiting_for_answer','released')
          AND (presentation_reply_id IS NULL OR presentation_reply_id=?)`).run(
          receipt.result.id, timestamp, input.segmentId, receipt.result.id
        );
      if (finalEventId) this.reservePrimarySegmentCompletionNotification(input.segmentId, input.pageIndex, finalEventId, receipt.result.id, input.messageId, timestamp);
      return "reserved";
    });
  }

  private reserveSemanticContinuationInTransaction(input: Extract<SemanticConversationPageReservation, { transition: "continuation" }>): "reserved"|"waiting"|"stale" {
    const segment = this.getConversationSegment(input.segmentId);
    const page = this.getPage(input.segmentId, input.pageIndex);
    if (!segment || !page || page.deliveryCohort !== "semantic" || page.state !== "frozen"
      || page.messageId !== input.messageId || page.pendingReplyId
      || page.elementId !== turnCardProjectionKey(input.segmentId, input.pageIndex)
      || input.nextElementId !== turnCardProjectionKey(input.segmentId, input.nextPageIndex)) return "stale";
    const existingNext = this.getPage(input.segmentId, input.nextPageIndex);
    if (existingNext) {
      return existingNext.deliveryCohort === "semantic" && existingNext.elementId === input.nextElementId
        && existingNext.state === "creating" && existingNext.pendingReplyId ? "waiting" : "stale";
    }
    const timestamp = new Date().toISOString();
    this.context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,start_cursor_json,delivered_cursor_json,pending_reply_id,
      start_lane_sequence,start_item_ordinal,cursor_base,start_anchor_inclusive,delivery_cohort,created_at,updated_at
    ) VALUES(?,?,?,NULL,NULL,?,'creating',1,?,?,NULL,?,?,?,?,'semantic',?,?)`).run(
      `${input.segmentId}:page:${input.nextPageIndex}`, input.segmentId, input.nextPageIndex, input.nextElementId,
      JSON.stringify(input.nextStartCursor), null, input.nextStartAnchor.position.laneSequence, input.nextStartAnchor.position.itemOrdinal,
      input.nextStartCursor?.itemIndex ?? 0, input.nextStartAnchor.inclusive ? 1 : 0, timestamp, timestamp
    );
    const receipt = this.reserveSemanticPageReply(segment, {
      ...input, targetPageIndex: input.nextPageIndex, revision: 1,
      idempotencyKey: `segment:${input.segmentId}:page:${input.nextPageIndex}:create`,
      rootMessageId: input.messageId, kind: "card_reply"
    });
    this.context.database.prepare("UPDATE conversation_segment_pages SET pending_reply_id=?,pending_cursor_json=? WHERE segment_id=? AND page_index=?")
      .run(receipt.result.id, input.cursor ? JSON.stringify(input.cursor) : null, input.segmentId, input.nextPageIndex);
    return "reserved";
  }

  private reserveSemanticPageReply(segment: ConversationSegment, input: SemanticConversationPageReservation & {
    targetPageIndex: number; revision: number; idempotencyKey: string; rootMessageId: string; kind: "card_reply" | "card_update";
  }): PreparedDeliveryReceipt {
    if (!this.preparedDeliveryReservation?.reserveSemanticOutboundReply || !this.preparedDeliveryConsumer) {
      throw new Error("Conversation Segment semantic delivery is not connected");
    }
    const receipt = this.preparedDeliveryReservation.reserveSemanticOutboundReply(this.semanticPageReplyInput(segment, input));
    this.handoffAfterCommit(receipt);
    return receipt;
  }

  previewSemanticShadowDelivery(input: SemanticConversationPageReservation): Omit<PresentationParityDescriptor, "visibleStructureFingerprint" | "committedBounds" | "recomputedBounds"> | null {
    if (!this.preparedDeliveryReservation?.previewSemanticOutboundReply || input.transition !== "snapshot" || input.messageId !== null) return null;
    const segment = this.getConversationSegment(input.segmentId);
    if (!segment) return null;
    const preview = this.preparedDeliveryReservation.previewSemanticOutboundReply(this.semanticPageReplyInput(segment, {
      ...input, targetPageIndex: input.pageIndex, revision: input.viewVersion,
      idempotencyKey: `segment:${input.segmentId}:page:${input.pageIndex}:create`,
      rootMessageId: segment.rootMessageId, kind: "card_reply"
    }));
    const pagePlan = (input.snapshot as PresentationSnapshotWithPagePlan).pagePlan;
    return pagePlan ? reservationParityDescriptor(preview, pagePlan) : null;
  }

  loadLegacyShadowDelivery(segmentId: string, pageIndex: number, viewVersion: number, pagePlan: import("../../domain/conversation-segment.js").ConversationPagePlan): Omit<PresentationParityDescriptor, "visibleStructureFingerprint" | "committedBounds" | "recomputedBounds"> | null {
    if (!this.preparedDeliveryReservation?.getReservedDeliveryIdentity) return null;
    const row = this.context.database.prepare(`SELECT id,projection_key,snapshot_revision FROM outbound_replies WHERE idempotency_key=?`)
      .get(`segment:${segmentId}:page:${pageIndex}:create`) as { id:string;projection_key:string|null;snapshot_revision:number }|undefined;
    if (!row || row.projection_key !== turnCardProjectionKey(segmentId, pageIndex) || row.snapshot_revision !== viewVersion) return null;
    const identity = this.preparedDeliveryReservation.getReservedDeliveryIdentity(row.id);
    return identity ? reservationParityDescriptor(identity, pagePlan) : null;
  }

  private semanticPageReplyInput(segment: ConversationSegment, input: SemanticConversationPageReservation & {
    targetPageIndex: number; revision: number; idempotencyKey: string; rootMessageId: string; kind: "card_reply" | "card_update";
  }): SemanticDeliveryReservationInput {
    const projectionKey = turnCardProjectionKey(input.segmentId, input.targetPageIndex);
    return {
      id: randomUUID(), idempotencyKey: input.idempotencyKey,
      bindingId: null, targetRole: "operation_result", rootMessageId: input.rootMessageId,
      kind: input.kind, payload: "{}", projectionKey,
      snapshotRevision: input.revision, viewVersion: input.revision, laneKeyOverride: projectionKey,
      subject: { kind: "conversation-page", segmentId: input.segmentId, pageIndex: input.targetPageIndex, revision: input.revision },
      snapshot: input.snapshot, plannerPolicyVersion: input.plannerPolicyVersion,
      rendererPolicyVersion: input.rendererPolicyVersion, gatewayProfileVersion: input.gatewayProfileVersion,
      ...(input.workClass ? { workClass: input.workClass } : {}),
      ...(segment.ownerKind === "primary"
        ? { bindingId: segment.ownerId, bindingGeneration: segment.ownerGeneration }
        : this.semanticWorkerRoute(segment))
    };
  }

  getSemanticDeliveryRolloutPhase(): "expansion"|"shadow"|"cohort"|"contraction_ready" {
    const row = this.context.database.prepare("SELECT phase FROM semantic_delivery_rollout WHERE singleton_id=1").get() as { phase:"expansion"|"shadow"|"cohort"|"contraction_ready" };
    return row.phase;
  }

  recordSemanticDeliveryShadowEvidence(input: { segmentId:string; pageIndex:number; viewVersion:number; snapshotSchemaVersion:number; plannerPolicyVersion:number; rendererPolicyVersion:number; gatewayProfileVersion:number; legacyFingerprint:string; semanticFingerprint:string; matched:boolean; details:Readonly<Record<string, unknown>> }): void {
    this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const rollout = this.context.database.prepare("SELECT phase,shadow_epoch FROM semantic_delivery_rollout WHERE singleton_id=1").get() as { phase:string; shadow_epoch:number };
      if (rollout.phase !== "shadow") return;
      const segment=this.getConversationSegment(input.segmentId);
      const projectionKey=turnCardProjectionKey(input.segmentId,input.pageIndex);
      const workerGeneration=segment?.ownerKind==="worker"
        ? (this.context.database.prepare("SELECT worker_session_generation FROM agent_instances WHERE id=? AND generation=?").get(segment.ownerId,segment.ownerGeneration) as { worker_session_generation:number }|undefined)?.worker_session_generation??null
        : null;
      const legacy=this.context.database.prepare(`SELECT kind,root_message_id,projection_key,snapshot_revision,scope_key,delivery_order,
        delivery_owner_kind,delivery_owner_id,delivery_owner_generation FROM outbound_replies
        WHERE idempotency_key=?`).get(`segment:${input.segmentId}:page:${input.pageIndex}:create`) as {
          kind:string;root_message_id:string|null;projection_key:string|null;snapshot_revision:number;scope_key:string|null;delivery_order:number|null;
          delivery_owner_kind:string|null;delivery_owner_id:string|null;delivery_owner_generation:number|null;
        }|undefined;
      const durableLegacyDeliveryMatched=Boolean(segment&&legacy&&legacy.kind==="card_reply"&&legacy.root_message_id===segment.rootMessageId
        &&legacy.projection_key===projectionKey&&legacy.snapshot_revision===input.viewVersion&&legacy.scope_key!==null
        &&Number.isSafeInteger(legacy.delivery_order)&&Number(legacy.delivery_order)>0
        &&legacy.delivery_owner_kind===segment.ownerKind&&legacy.delivery_owner_id===segment.ownerId
        &&legacy.delivery_owner_generation===(segment.ownerKind==="primary"?segment.ownerGeneration:workerGeneration));
      const observedAt = new Date().toISOString();
      this.context.database.prepare(`INSERT INTO semantic_delivery_shadow_evidence(
      segment_id,page_index,view_version,shadow_epoch,snapshot_schema_version,planner_policy_version,renderer_policy_version,gateway_profile_version,
      legacy_fingerprint,semantic_fingerprint,matched,details_json,observed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(segment_id,page_index,view_version) DO UPDATE SET
      shadow_epoch=excluded.shadow_epoch,snapshot_schema_version=excluded.snapshot_schema_version,
      planner_policy_version=excluded.planner_policy_version,renderer_policy_version=excluded.renderer_policy_version,
      gateway_profile_version=excluded.gateway_profile_version,legacy_fingerprint=excluded.legacy_fingerprint,
      semantic_fingerprint=excluded.semantic_fingerprint,matched=excluded.matched,details_json=excluded.details_json,observed_at=excluded.observed_at`)
      .run(input.segmentId,input.pageIndex,input.viewVersion,rollout.shadow_epoch,input.snapshotSchemaVersion,input.plannerPolicyVersion,input.rendererPolicyVersion,input.gatewayProfileVersion,
        input.legacyFingerprint,input.semanticFingerprint,input.matched&&durableLegacyDeliveryMatched?1:0,JSON.stringify({ ...input.details,durableLegacyDeliveryMatched }),observedAt);
    });
  }

  private semanticWorkerRoute(segment: ConversationSegment): { workerId: string; workerSessionGeneration: number } {
    const worker = this.context.database.prepare("SELECT worker_session_generation FROM agent_instances WHERE id=? AND generation=?").get(segment.ownerId, segment.ownerGeneration) as { worker_session_generation: number } | undefined;
    if (!worker) throw new Error("Conversation Segment worker delivery owner is not available");
    return { workerId: segment.ownerId, workerSessionGeneration: worker.worker_session_generation };
  }
  reserveFreeze(input: { segmentId:string; pageIndex:number; messageId:string; cardId?:string|null; elementId:string; card:object; cursor:AnswerTimelineCursor; cursorAnchor?:ConversationSegmentCursorAnchor; workClass?:OutboundWorkClass }): "reserved"|"waiting"|"noop"|"stale" {
    const cursorAnchor = input.cursorAnchor ?? this.resolveCursorAnchor(input.segmentId, input.cursor);
    if (!cursorAnchor) return "stale";
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const page = this.getPage(input.segmentId, input.pageIndex);
      if (page?.deliveryCohort === "semantic") return "stale";
      if (page?.state === "frozen" && page.pendingReplyId) return "waiting";
      if (page?.state === "frozen" && page.deliveredSequence >= page.sequence) return "noop";
      if (!page || page.state !== "active" || !page.messageId || page.messageId !== input.messageId
        || input.cardId !== undefined && input.cardId !== null && page.cardId !== null && page.cardId !== input.cardId
        || page.elementId !== turnCardProjectionKey(input.segmentId, input.pageIndex) || input.elementId !== page.elementId) return "stale";
      if (page.pendingReplyId) return "waiting";
      const revision = Math.max(page.sequence, page.deliveredSequence) + 1;
      const reply = this.enqueueOutboundReply({
        id: randomUUID(), idempotencyKey: `segment:${input.segmentId}:page:${input.pageIndex}:freeze`,
        bindingId: null, targetRole: "operation_result", rootMessageId: input.messageId, kind: "card_update",
        payload: JSON.stringify(input.card), projectionKey: turnCardProjectionKey(input.segmentId, input.pageIndex),
        snapshotRevision: revision, viewVersion: revision, ...(input.workClass ? { workClass: input.workClass } : {})
      });
      this.context.database.prepare(`UPDATE conversation_segment_pages
        SET state='frozen',sequence=?,pending_cursor_json=?,pending_reply_id=?,
          continuation_lane_sequence=?,continuation_item_ordinal=?,continuation_anchor_inclusive=?,continuation_cursor_base=?,updated_at=?
        WHERE segment_id=? AND page_index=?`).run(
        revision, JSON.stringify(input.cursor), reply.id, cursorAnchor.position.laneSequence, cursorAnchor.position.itemOrdinal,
        cursorAnchor.inclusive ? 1 : 0, input.cursor.itemIndex, new Date().toISOString(), input.segmentId, input.pageIndex
      );
      return "reserved";
    });
  }
  reserveContinuation(input: { segmentId:string; pageIndex:number; messageId:string; card:object; nextPageIndex:number; nextElementId:string; nextStartCursor:AnswerTimelineCursor; nextStartAnchor?:ConversationSegmentCursorAnchor; workClass?:OutboundWorkClass }): "reserved"|"waiting"|"stale" {
    const nextStartAnchor = input.nextStartAnchor ?? this.resolveCursorAnchor(input.segmentId, input.nextStartCursor);
    return nextStartAnchor ? this.context.transaction("sqlite.conversation-segment-store.write", () => this.reservePageContinuation({ ...input, nextStartAnchor }, false)) : "stale";
  }
  reserveLateContinuation(input: { segmentId:string; pageIndex:number; messageId:string; card:object; nextPageIndex:number; nextElementId:string; nextStartCursor:AnswerTimelineCursor|null; nextStartAnchor?:ConversationSegmentCursorAnchor; workClass?:OutboundWorkClass }): "reserved"|"waiting"|"stale" {
    const nextStartAnchor = input.nextStartAnchor ?? (input.nextStartCursor ? this.resolveCursorAnchor(input.segmentId, input.nextStartCursor) : null);
    return nextStartAnchor ? this.context.transaction("sqlite.conversation-segment-store.write", () => this.reservePageContinuation({ ...input, nextStartAnchor }, true)) : "stale";
  }
  reserveFinish(input: { segmentId:string; pageIndex:number; messageId:string; card:object; summary:string; cursor:AnswerTimelineCursor; cardId?:string|null; elementId:string; workClass?:OutboundWorkClass }): "reserved"|"waiting"|"noop"|"stale" {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const page = this.getPage(input.segmentId, input.pageIndex);
      if (page?.deliveryCohort === "semantic") return "stale";
      if (page?.state === "finished" && page.pendingReplyId) return "waiting";
      if (page?.state === "finished" && page.deliveredSequence >= page.sequence) return "noop";
      if (!page || page.state !== "active" || !page.messageId || page.messageId !== input.messageId || input.cardId !== undefined && input.cardId !== null && page.cardId !== null && page.cardId !== input.cardId || page.elementId !== turnCardProjectionKey(input.segmentId, input.pageIndex) || input.elementId !== page.elementId) return "stale";
      if (page.pendingReplyId) return "waiting";
      const finishBaseKey = page.sequence === 1
        ? `segment:${input.segmentId}:page:${input.pageIndex}:finish`
        : `segment:${input.segmentId}:page:${input.pageIndex}:finish:${page.sequence + 1}`;
      const finalEventId = this.completionPresentationFinalEventId(input.segmentId);
      const finishKey = finalEventId ? `${finishBaseKey}:final:${encodeURIComponent(finalEventId)}` : finishBaseKey;
      const reply = this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: finishKey, bindingId: null, targetRole: "operation_result", rootMessageId: input.messageId, kind: "card_update", payload: JSON.stringify(input.card), projectionKey: turnCardProjectionKey(input.segmentId, input.pageIndex), snapshotRevision: page.sequence + 1, viewVersion: page.sequence + 1, ...(input.workClass ? { workClass: input.workClass } : {}) });
      if (finalEventId) this.requireDeliveredPageCreationPrerequisite(reply.id, input.segmentId, input.pageIndex, input.messageId);
      const timestamp = new Date().toISOString();
      this.context.database.prepare("UPDATE conversation_segment_pages SET state='finished', sequence=sequence+1, pending_cursor_json=?, pending_reply_id=?, updated_at=? WHERE segment_id=? AND page_index=?")
        .run(JSON.stringify(input.cursor), reply.id, timestamp, input.segmentId, input.pageIndex);
      this.context.database.prepare(`UPDATE completion_notification_obligations
        SET presentation_reply_id=COALESCE(presentation_reply_id,?),updated_at=?
        WHERE owner_kind='primary-segment' AND owner_id=? AND notice_kind='completion'
          AND state IN ('waiting_for_answer','released')
          AND (presentation_reply_id IS NULL OR presentation_reply_id=?)`).run(
            reply.id, timestamp, input.segmentId, reply.id
          );
      if (finalEventId) this.reservePrimarySegmentCompletionNotification(input.segmentId, input.pageIndex, finalEventId, reply.id, input.messageId, timestamp);
      return "reserved";
    });
  }
  private reservePageContinuation(input: { segmentId:string; pageIndex:number; messageId:string; card:object; nextPageIndex:number; nextElementId:string; nextStartCursor:AnswerTimelineCursor|null; nextStartAnchor:ConversationSegmentCursorAnchor; workClass?:OutboundWorkClass }, late: boolean): "reserved"|"waiting"|"stale" {
    if (input.nextElementId !== turnCardProjectionKey(input.segmentId, input.nextPageIndex)) return "stale";
    const page = this.getPage(input.segmentId, input.pageIndex); if (!page || page.deliveryCohort === "semantic" || (late ? page.state !== "frozen" : page.state !== "active") || page.messageId !== input.messageId || page.elementId !== turnCardProjectionKey(input.segmentId, input.pageIndex) || page.pendingReplyId) return "stale";
    const existingNext = this.getPage(input.segmentId, input.nextPageIndex);
    if (existingNext) {
      if (existingNext.elementId !== input.nextElementId || existingNext.pendingReplyId || existingNext.state !== "creating") return "stale";
      return "waiting";
    }
    this.context.database.prepare("UPDATE conversation_segment_pages SET state='frozen', updated_at=? WHERE segment_id=? AND page_index=?").run(new Date().toISOString(), input.segmentId, input.pageIndex);
    this.context.database.prepare(`INSERT OR IGNORE INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,start_cursor_json,delivered_cursor_json,pending_reply_id,
      start_lane_sequence,start_item_ordinal,cursor_base,start_anchor_inclusive,delivery_cohort,created_at,updated_at
    ) VALUES(?,?,?,NULL,NULL,?,'creating',1,?,?,NULL,?,?,?,?,'legacy',?,?)`).run(
      `${input.segmentId}:page:${input.nextPageIndex}`, input.segmentId, input.nextPageIndex, input.nextElementId,
      JSON.stringify(input.nextStartCursor), null, input.nextStartAnchor.position.laneSequence, input.nextStartAnchor.position.itemOrdinal,
      input.nextStartCursor?.itemIndex ?? 0, input.nextStartAnchor.inclusive ? 1 : 0, new Date().toISOString(), new Date().toISOString()
    );
    const reply = this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `segment:${input.segmentId}:page:${input.nextPageIndex}:create`, bindingId: null, targetRole: "operation_result", rootMessageId: input.messageId, kind: "card_reply", payload: JSON.stringify(input.card), projectionKey: turnCardProjectionKey(input.segmentId, input.nextPageIndex), snapshotRevision: 1, viewVersion: 1, ...(input.workClass ? { workClass: input.workClass } : {}) });
    this.context.database.prepare("UPDATE conversation_segment_pages SET pending_reply_id=? WHERE segment_id=? AND page_index=?").run(reply.id, input.segmentId, input.nextPageIndex);
    return "reserved";
  }

  /** Compatibility for direct callers; ordinary convergence supplies a seekable anchor. */
  private resolveCursorAnchor(segmentId: string, cursor: AnswerTimelineCursor): ConversationSegmentCursorAnchor | null {
    const offset = cursor.offset ?? cursor.markdownOffset ?? 0;
    const row = this.context.database.prepare(`SELECT lane_sequence,item_ordinal FROM conversation_segment_items
      WHERE segment_id=? ORDER BY lane_sequence,item_ordinal,item_id LIMIT 1 OFFSET ?`).get(segmentId, cursor.itemIndex) as { lane_sequence:number; item_ordinal:number } | undefined;
    if (row) return { position: { laneSequence: row.lane_sequence, itemOrdinal: row.item_ordinal }, inclusive: true };
    if (offset > 0) return null;
    const last = this.context.database.prepare(`SELECT lane_sequence,item_ordinal FROM conversation_segment_items
      WHERE segment_id=? ORDER BY lane_sequence DESC,item_ordinal DESC,item_id DESC LIMIT 1`).get(segmentId) as { lane_sequence:number; item_ordinal:number } | undefined;
    return last ? { position: { laneSequence: last.lane_sequence, itemOrdinal: last.item_ordinal }, inclusive: false }
      : cursor.itemIndex > 0 ? { position: { laneSequence: 0, itemOrdinal: 0 }, inclusive: false } : null;
  }

  private getPage(segmentId: string, pageIndex: number): ConversationSegmentPage | null {
    const row = this.context.database.prepare("SELECT * FROM conversation_segment_pages WHERE segment_id=? AND page_index=?").get(segmentId, pageIndex) as PageRow | undefined;
    return row ? mapPage(row) : null;
  }

  private openLateBeforeCursorGap(segmentId: string, laneSequence: number, itemOrdinal: number, sourceItemId: string, sourceEventId: string, occurredAt: string): void {
    const cursor = this.context.database.prepare(`SELECT
        segment.start_lane_sequence,segment.start_item_ordinal,segment.state AS segment_state,
        segment.owner_kind,segment.owner_id,segment.owner_generation,
        COALESCE(current.start_lane_sequence,frozen.continuation_lane_sequence) AS lane_sequence,
        COALESCE(current.start_item_ordinal,frozen.continuation_item_ordinal) AS item_ordinal
      FROM conversation_segments segment
      LEFT JOIN conversation_segment_pages current ON current.segment_id=segment.id AND current.state IN ('creating','active')
      LEFT JOIN conversation_segment_pages frozen ON frozen.segment_id=segment.id AND frozen.state='frozen'
        AND frozen.page_index=(SELECT MAX(page_index) FROM conversation_segment_pages WHERE segment_id=segment.id AND state='frozen')
      WHERE segment.id=?`).get(segmentId) as {
        start_lane_sequence:number|null; start_item_ordinal:number|null; lane_sequence:number|null; item_ordinal:number|null;
        segment_state:ConversationSegment["state"];
        owner_kind:"primary"|"worker"; owner_id:string; owner_generation:number;
      } | undefined;
    if (!cursor || cursor.lane_sequence === null || cursor.item_ordinal === null) return;
    if (cursor.segment_state === "closed") return;
    if (cursor.owner_kind === "worker" && !this.context.database.prepare(
      "SELECT 1 FROM agent_instances WHERE id=? AND generation=?"
    ).get(cursor.owner_id, cursor.owner_generation)) return;
    if (cursor.start_lane_sequence === null || cursor.start_item_ordinal === null
      || laneSequence < cursor.start_lane_sequence
      || laneSequence === cursor.start_lane_sequence && itemOrdinal < cursor.start_item_ordinal) return;
    if (laneSequence > cursor.lane_sequence || laneSequence === cursor.lane_sequence && itemOrdinal >= cursor.item_ordinal) return;
    const existing = this.context.database.prepare(`SELECT 1 FROM conversation_segment_late_recoveries
      WHERE segment_id=? AND item_id=? AND source_event_id=? LIMIT 1`).get(segmentId, sourceItemId, sourceEventId);
    if (existing) return;
    new SqliteProjectionGapStore(this.context).open({
      stage: "turn_recovery", ownerKind: "turn_card", ownerId: segmentId, sourceItemId,
      failureClass: "transient", failureCode: "late_timeline_delta_before_active_cursor", requiredVersion: 0, occurredAt
    });
    this.context.database.prepare(`INSERT OR IGNORE INTO conversation_segment_late_recoveries(
      segment_id,item_id,lane_sequence,item_ordinal,source_event_id,state,created_at,updated_at
    ) VALUES(?,?,?,?,?,'queued',?,?)`).run(segmentId, sourceItemId, laneSequence, itemOrdinal, sourceEventId, occurredAt, occurredAt);
  }

  private enqueueOutboundReply(input: EnqueueOutboundReplyInput): { id: string } {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Conversation Segment prepared delivery is not connected");
    const parsed = typeof input.projectionKey === "string"
      ? parseTurnCardProjectionKey(input.projectionKey) ?? parseTurnCardRecoveryProjectionKey(input.projectionKey) ?? parseTurnCardLateRecoveryProjectionKey(input.projectionKey)
      : null;
    const segment = parsed ? this.getConversationSegment(parsed.segmentId) : null;
    if (!segment) throw new Error("Conversation Segment delivery owner is not available");
    const worker = segment.ownerKind === "worker"
      ? this.context.database.prepare("SELECT worker_session_generation FROM agent_instances WHERE id=? AND generation=?").get(segment.ownerId, segment.ownerGeneration) as { worker_session_generation: number } | undefined
      : undefined;
    if (segment.ownerKind === "worker" && !worker) throw new Error("Conversation Segment worker delivery owner is not available");
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply(segment.ownerKind === "primary"
      ? { ...input, bindingId: segment.ownerId, bindingGeneration: segment.ownerGeneration }
      : { ...input, workerId: segment.ownerId, workerSessionGeneration: worker!.worker_session_generation });
    this.handoffAfterCommit(receipt);
    return { id: receipt.result.id };
  }

  private shouldClosePriorSegment(segmentId: string): boolean {
    const segment = this.getConversationSegment(segmentId);
    if (!segment) return false;
    if (segment.state !== "completed") return false;
    const page = this.context.database.prepare(`SELECT state,sequence,delivered_sequence
      FROM conversation_segment_pages WHERE segment_id=? ORDER BY page_index DESC LIMIT 1`).get(segmentId) as {
        state: string; sequence: number; delivered_sequence: number;
      } | undefined;
    return !page || page.state !== "finished" || page.delivered_sequence < page.sequence;
  }

  private reservePrimarySegmentCompletionNotification(segmentId: string, pageIndex: number, finalEventId: string, presentationReplyId: string, rootMessageId: string, timestamp: string): void {
    const notice = this.context.database.prepare(`SELECT owner_generation,binding_id,binding_generation,required_view_version,
        mention_open_id,notification_reply_id,state,
        EXISTS(SELECT 1 FROM completion_choice_specifications choice
          WHERE choice.owner_kind='primary-segment' AND choice.owner_id=owner_id
            AND choice.owner_generation=completion_notification_obligations.owner_generation) AS has_human_review
      FROM completion_notification_obligations
      WHERE owner_kind='primary-segment' AND owner_id=? AND notice_kind='completion'`).get(segmentId) as {
        owner_generation: number; binding_id: string; binding_generation: number; required_view_version: number;
        mention_open_id: string | null; notification_reply_id: string | null; state: string; has_human_review: number;
      } | undefined;
    if (!notice || notice.state !== "waiting_for_answer" || !notice.mention_open_id) return;
    const freshReview = notice.has_human_review === 1
      ? this.context.database.prepare(`SELECT 1 FROM completion_action_sets
          WHERE owner_kind='primary-segment' AND owner_id=? AND owner_generation=?
            AND presentation_kind='fresh-card' AND presentation_reply_id IS NOT NULL`).get(segmentId, notice.owner_generation)
      : undefined;
    if (freshReview) {
      this.context.database.prepare(`UPDATE completion_notification_obligations
        SET state='suppressed',updated_at=? WHERE owner_kind='primary-segment' AND owner_id=?
          AND owner_generation=? AND state='waiting_for_answer'`).run(timestamp, segmentId, notice.owner_generation);
      return;
    }
    const presentationContainsMention = notice.has_human_review === 0 && this.context.database.prepare(`SELECT 1
      FROM outbound_replies
      WHERE id=? AND kind='card_update' AND root_message_id=? AND projection_key=?
        AND (
          delivery_input_kind IS NULL AND (
            instr(payload,?)>0
            OR EXISTS (
              SELECT 1 FROM json_tree(outbound_replies.payload) mention_node
              WHERE mention_node.type='object'
                AND json_extract(mention_node.value,'$.kind')='mention'
                AND json_extract(mention_node.value,'$.userId')=?
            )
          )
          OR delivery_input_kind='semantic-snapshot'
            AND json_extract(presentation_snapshot_json,'$.options.completionNotice.mentionOpenId')=?
            AND json_extract(presentation_snapshot_json,'$.options.completionNotice.reason')='final_request'
        )`).get(
          presentationReplyId, rootMessageId, turnCardProjectionKey(segmentId, pageIndex),
          `<at id=${notice.mention_open_id}></at>`, notice.mention_open_id, notice.mention_open_id
        );
    if (presentationContainsMention) {
      this.context.database.prepare(`UPDATE completion_notification_obligations
        SET state='suppressed',notification_reply_id=NULL,released_at=NULL,updated_at=?
        WHERE owner_kind='primary-segment' AND owner_id=? AND owner_generation=?
          AND state='waiting_for_answer' AND notification_reply_id IS NULL`).run(
            timestamp, segmentId, notice.owner_generation
          );
      return;
    }
    if (notice.has_human_review === 1 && suppressPrimarySegmentInlineCompletionNotification(this.context, {
      segmentId, presentationReplyId, rootMessageId
    })) return;
    const key = `primary-segment-completion:${notice.binding_id}:${notice.binding_generation}:${segmentId}:${finalEventId}`;
    if (!notice.notification_reply_id) {
      if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) {
        throw new Error("Conversation Segment prepared delivery is not connected");
      }
      const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply({
        id: key, idempotencyKey: key, bindingId: notice.binding_id, bindingGeneration: notice.binding_generation,
        targetRole: "operation_result", rootMessageId, kind: "text",
        payload: notice.has_human_review === 1
          ? `<at user_id="${notice.mention_open_id}">用户</at> 需要你的选择。`
          : `<at user_id="${notice.mention_open_id}">用户</at> 你的请求已完成，请查看上方 Turn Card。`
      });
      this.handoffAfterCommit(receipt);
      this.context.database.prepare(`UPDATE completion_notification_obligations
        SET notification_reply_id=?,updated_at=?
        WHERE owner_kind='primary-segment' AND owner_id=? AND owner_generation=?
          AND state='waiting_for_answer' AND notification_reply_id IS NULL`).run(
            receipt.result.id, timestamp, segmentId, notice.owner_generation
          );
    }
    this.context.database.prepare(`INSERT INTO outbound_reply_prerequisites(
      dependent_reply_id,prerequisite_reply_id,required_state,created_at
    ) VALUES(?,?, 'delivered', ?)
    ON CONFLICT(dependent_reply_id,prerequisite_reply_id) DO NOTHING`).run(key, presentationReplyId, timestamp);
  }

  private requireDeliveredPageCreationPrerequisite(dependentReplyId: string, segmentId: string, pageIndex: number, messageId: string): void {
    const projectionKey = turnCardProjectionKey(segmentId, pageIndex);
    const creations = this.context.database.prepare(`SELECT id FROM outbound_replies
      WHERE idempotency_key IN (?,?) AND projection_key=? AND kind='card_reply' AND state='delivered' AND delivered_message_id=?
      ORDER BY id`).all(
        `segment:${segmentId}:page:${pageIndex}:create`, `${projectionKey}:create`, projectionKey, messageId
      ) as Array<{ id: string }>;
    if (creations.length!==1) throw new Error("Completion presentation requires its exact delivered Turn Card creation");
    this.context.database.prepare(`INSERT INTO outbound_reply_prerequisites(
      dependent_reply_id,prerequisite_reply_id,required_state,created_at
    ) VALUES(?,?,'delivered',?) ON CONFLICT(dependent_reply_id,prerequisite_reply_id) DO UPDATE SET required_state='delivered'`).run(
      dependentReplyId, creations[0]!.id, new Date().toISOString()
    );
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

  private findHistoricalPageRecovery(segmentId: string): ConversationSegmentPageRecoveryCandidate | null {
    const timestamp = new Date().toISOString();
    this.context.database.prepare(`UPDATE conversation_segment_page_recovery_parts
      SET state='delivered',message_id=(SELECT delivered_message_id FROM outbound_replies WHERE id=reply_id),updated_at=?
      WHERE segment_id=? AND state='pending'
        AND EXISTS(SELECT 1 FROM outbound_replies WHERE id=reply_id AND state='delivered' AND delivered_message_id IS NOT NULL)`).run(timestamp, segmentId);
    if (this.context.database.prepare("SELECT 1 FROM conversation_segment_page_recovery_parts WHERE segment_id=? AND state='pending' LIMIT 1").get(segmentId)) return null;
    const segment = this.getConversationSegment(segmentId);
    if (!segment || !["completed", "failed", "cancelled", "needs_human", "closed"].includes(segment.state)) return null;
    const pages = this.listConversationSegmentPages(segmentId);
    const itemCount = (this.context.database.prepare("SELECT timeline_item_count FROM conversation_segments WHERE id=?").get(segmentId) as { timeline_item_count:number }).timeline_item_count;
    const lastRecovery = this.context.database.prepare(`SELECT message_id FROM conversation_segment_page_recovery_parts
      WHERE segment_id=? AND state='delivered' AND message_id IS NOT NULL ORDER BY updated_at DESC,source_page_index DESC,part_index DESC LIMIT 1`).get(segmentId) as { message_id:string } | undefined;
    const anchorMessageId = lastRecovery?.message_id ?? [...pages].reverse().find((page) => page.messageId)?.messageId ?? segment.rootMessageId;
    if (!anchorMessageId) return null;
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]!;
      if (page.pageIndex === 0 || !["frozen", "finished"].includes(page.state) || !page.startCursor) continue;
      const targetEndCursor = page.deliveredCursor ?? pages[index + 1]?.startCursor ?? { itemIndex: itemCount, markdownOffset: 0 };
      const priorParts = this.context.database.prepare(`SELECT part_index,end_cursor_json FROM conversation_segment_page_recovery_parts
        WHERE segment_id=? AND source_page_index=? AND state='delivered' ORDER BY part_index`).all(segmentId, page.pageIndex) as Array<{ part_index:number; end_cursor_json:string }>;
      const startCursor = priorParts.length > 0 ? JSON.parse(priorParts.at(-1)!.end_cursor_json) as AnswerTimelineCursor : page.startCursor;
      const remaining = compareTimelineCursor(targetEndCursor, startCursor);
      if (!Number.isFinite(remaining) || remaining <= 0) continue;
      const delivered = this.context.database.prepare(`SELECT gateway_id,payload FROM outbound_replies
        WHERE projection_key=? AND state='delivered' ORDER BY delivery_order DESC LIMIT 1`).get(page.elementId) as { gateway_id:string; payload:string } | undefined;
      if (!delivered || priorParts.length === 0 && payloadContainsElementId(delivered.payload, page.elementId)) continue;
      const partIndex = priorParts.length;
      return {
        segmentId, sourcePageIndex: page.pageIndex, partIndex, startCursor, endCursor: targetEndCursor,
        anchorMessageId, gatewayId: delivered.gateway_id,
        projectionKey: `turn-card-recovery:${segmentId}:source:${page.pageIndex}:part:${partIndex}:create`
      };
    }
    return null;
  }

  private openCreateRecoveryGap(segmentId: string, pageIndex: number, failureCode: string): void {
    new SqliteProjectionGapStore(this.context).open({ stage: "turn_recovery", ownerKind: "turn_card", ownerId: segmentId, sourceItemId: turnCardProjectionKey(segmentId, pageIndex), failureClass: "permanent", failureCode, requiredVersion: 0, occurredAt: new Date().toISOString() });
  }

  projectCanonicalEvent(input: CanonicalProjectionInput): ConversationSegmentProjectionResult {
    const prior = this.openSegment(`lane:${input.laneId}`);
    const hadVisibleAssistantContent = prior
      ? (this.context.database.prepare("SELECT has_visible_assistant_content FROM conversation_segments WHERE id=?").get(prior.id) as { has_visible_assistant_content: number }).has_visible_assistant_content === 1
      : false;
    const closedSegmentIds: string[] = [];
    const result = this.projectCanonicalEventInTransaction(input, closedSegmentIds);
    for (const segmentId of closedSegmentIds) {
      const segment = this.getConversationSegment(segmentId);
      if (segment) this.notifyProjection({
        segmentId,
        viewVersion: segment.viewVersion,
        urgency: "immediate",
        ...(input.workClass ? { workClass: input.workClass } : {})
      });
    }
    if ((result.outcome === "adopted" || result.outcome === "created" || result.outcome === "projected") && result.segmentId) {
      const segment = this.getConversationSegment(result.segmentId);
      if (segment) this.notifyProjection({
        segmentId: result.segmentId,
        viewVersion: segment.viewVersion,
        urgency: projectionUrgency(input, result.outcome, hadVisibleAssistantContent),
        ...(input.workClass ? { workClass: input.workClass } : {})
      });
    }
    return result;
  }

  private projectCanonicalEventInTransaction(input: CanonicalProjectionInput, closedSegmentIds: string[] = []): ConversationSegmentProjectionResult {
    return this.context.transaction("sqlite.conversation-segment-store.write", () => {
      if (!Number.isSafeInteger(input.laneSequence) || input.laneSequence < 0) throw new Error("Invalid canonical lane sequence");
      const payload = input.event.payload as Record<string, unknown>;
      const producerKey = `lane:${input.laneId}`;
      if (payload.type === "human_message") {
        const submissionId = typeof payload.submission_id === "string" ? payload.submission_id : null;
        const messageId = typeof payload.message_id === "string" ? payload.message_id : input.event.eventId;
        const requestText = typeof payload.text === "string" ? payload.text : "";
        if (isSystemInjectedHumanEnvelope(requestText)) return { outcome: "ignored", segmentId: null };
        const byEvent = this.context.database.prepare("SELECT id,submission_id FROM conversation_segments WHERE human_event_id=?").get(input.event.eventId) as { id: string; submission_id: string | null } | undefined;
        if (byEvent) {
          if (submissionId && byEvent.submission_id !== submissionId) {
            if (byEvent.submission_id === null) {
              this.context.database.prepare("UPDATE conversation_segments SET submission_id=? WHERE id=? AND human_event_id=? AND submission_id IS NULL").run(
                submissionId, byEvent.id, input.event.eventId
              );
              return { outcome: "duplicate", segmentId: byEvent.id };
            }
            const canonical = this.context.database.prepare(`SELECT 1 AS present
              FROM canonical_human_message_submissions
              WHERE event_id=? AND submission_id=? AND agent_kind=? AND session_id=?`).get(
              input.event.eventId, submissionId, input.event.agentKind, input.event.sessionId
            ) as { present: number } | undefined;
            if (!canonical) throw new Error("Canonical Conversation Segment submission identity conflict");
            const changed = this.context.database.prepare(`UPDATE conversation_segments SET submission_id=?,updated_at=?
              WHERE id=? AND human_event_id=? AND submission_id IS ?
                AND NOT EXISTS(SELECT 1 FROM conversation_segments WHERE submission_id=? AND id<>?)`).run(
              submissionId, input.observedAt, byEvent.id, input.event.eventId, byEvent.submission_id, submissionId, byEvent.id
            );
            if (changed.changes !== 1) throw new Error("Canonical Conversation Segment submission identity conflict");
          }
          return { outcome: "duplicate", segmentId: byEvent.id };
        }
        const fence = submissionId ? this.context.database.prepare(`SELECT owner_kind,owner_id,owner_generation,producer_key,agent_kind,session_id,id,state,human_event_id
          FROM conversation_segments WHERE submission_id=?`).get(submissionId) as SegmentRow | undefined : undefined;
        const intent = submissionId && !fence ? this.context.database.prepare(`SELECT ingress_source,source_message_key,actor_json,text,
          owner_kind,owner_id,owner_generation,expected_agent_kind,expected_session_id
          FROM submission_intents WHERE submission_id=?`).get(submissionId) as {
            ingress_source: string; source_message_key: string; actor_json: string; text: string;
            owner_kind: "primary" | "worker"; owner_id: string; owner_generation: number;
            expected_agent_kind: string; expected_session_id: string | null;
          } | undefined : undefined;
        const workerIntent = submissionId && !fence && !intent ? this.context.database.prepare(`SELECT turn.canonical_segment_id,turn.canonical_submission_id,
          turn.canonical_agent_kind,turn.canonical_expected_session_id,turn.canonical_root_message_id,turn.canonical_gateway_id,
          turn.text,turn.instance_id,turn.instance_generation
          FROM instance_turns turn
          JOIN agent_instances instance ON instance.id=turn.instance_id AND instance.generation=turn.instance_generation
          WHERE turn.canonical_submission_id=? AND turn.canonical_segment_id IS NOT NULL
            AND instance.role='worker'`).get(submissionId) as {
              canonical_segment_id: string; canonical_submission_id: string; canonical_agent_kind: "traex" | "pi";
              canonical_expected_session_id: string | null; canonical_root_message_id: string; canonical_gateway_id: string;
              text: string; instance_id: string; instance_generation: number;
            } | undefined : undefined;
        if (submissionId && !fence) {
          if (intent && (intent.expected_agent_kind !== input.event.agentKind || intent.expected_session_id !== null && intent.expected_session_id !== input.event.sessionId)) return { outcome: "ignored", segmentId: null };
          if (intent && intent.text !== requestText) return { outcome: "conflict", segmentId: null };
          if (workerIntent && (workerIntent.canonical_agent_kind !== input.event.agentKind || workerIntent.canonical_expected_session_id !== null && workerIntent.canonical_expected_session_id !== input.event.sessionId)) return { outcome: "ignored", segmentId: null };
          if (workerIntent && workerIntent.text !== requestText) return { outcome: "conflict", segmentId: null };
        }
        if (fence) {
          if (fence.agent_kind !== input.event.agentKind || fence.session_id !== input.event.sessionId) return { outcome: "ignored", segmentId: null };
          if (fence.human_event_id && fence.human_event_id !== input.event.eventId) return { outcome: "duplicate", segmentId: fence.id };
          const prior = this.openSegment(producerKey);
          const inheritedTaskList = prior && prior.id !== fence.id ? this.loadTaskListJson(prior.id) : null;
          const inheritedCurrentGoal = prior && prior.id !== fence.id ? this.loadCurrentGoalJson(prior.id) : null;
          if (prior && prior.id !== fence.id && this.shouldClosePriorSegment(prior.id)) {
            this.close(prior, input.laneSequence, input.observedAt);
            this.supersedePrimarySegmentAction(prior.id, input.observedAt);
            closedSegmentIds.push(prior.id);
          }
          this.context.database.prepare(`UPDATE conversation_segments SET producer_key=?, human_event_id=?, start_lane_sequence=?, start_item_ordinal=0,
            task_list_json=COALESCE(task_list_json,?),current_goal_json=COALESCE(current_goal_json,?),state='working',updated_at=? WHERE id=?`).run(
            producerKey, input.event.eventId, input.laneSequence, inheritedTaskList, inheritedCurrentGoal, input.observedAt, fence.id
          );
          const inserted = this.persistItem(fence.id, `human:${messageId}`, input.laneSequence, 0, { kind: "human_message", id: `human:${messageId}`, sequence: 0, canonicalPosition: { laneSequence: input.laneSequence, itemOrdinal: 0 }, markdown: requestText }, null);
          if (inserted) this.context.database.prepare("UPDATE conversation_segments SET timeline_item_count=timeline_item_count+1 WHERE id=?").run(fence.id);
          return { outcome: "adopted", segmentId: fence.id };
        }
        const prior = this.openSegment(producerKey);
        const inheritedTaskList = prior ? this.loadTaskListJson(prior.id) : null;
        const inheritedCurrentGoal = prior ? this.loadCurrentGoalJson(prior.id) : null;
        if (prior && this.shouldClosePriorSegment(prior.id)) {
          this.close(prior, input.laneSequence, input.observedAt);
          this.supersedePrimarySegmentAction(prior.id, input.observedAt);
          closedSegmentIds.push(prior.id);
        }
        const route = intent || workerIntent ? null : input.route ?? this.resolveCanonicalRoute(input.event.agentKind, input.event.sessionId);
        const id = workerIntent?.canonical_segment_id ?? (submissionId && intent ? `segment:${submissionId}` : `segment:${randomUUID()}`);
        const actor = intent ? JSON.parse(intent.actor_json) as { gatewayId?: string; rootMessageId?: string | null } : null;
        const ownerKind = intent?.owner_kind ?? (workerIntent ? "worker" : route?.ownerKind) ?? "primary";
        const ownerId = intent?.owner_id ?? workerIntent?.instance_id ?? route?.ownerId ?? producerKey;
        const ownerGeneration = intent?.owner_generation ?? workerIntent?.instance_generation ?? route?.ownerGeneration ?? 1;
        const rootMessageId = intent ? actor?.rootMessageId ?? intent.source_message_key : workerIntent?.canonical_root_message_id ?? route?.rootMessageId ?? "";
        const gatewayId = actor?.gatewayId ?? workerIntent?.canonical_gateway_id ?? route?.gatewayId;
        this.context.database.prepare(`INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,submission_id,human_event_id,agent_kind,session_id,request_text,start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,task_list_json,current_goal_json,created_at,updated_at)
          VALUES(?,?,?,?,?,?,? ,?,?,?, ?,0,'working',1,?,?,?,?,?)`).run(id, producerKey, ownerKind, ownerId, ownerGeneration, submissionId, input.event.eventId, input.event.agentKind, input.event.sessionId, requestText, input.laneSequence, rootMessageId, inheritedTaskList, inheritedCurrentGoal, input.observedAt, input.observedAt);
        const inserted = this.persistItem(id, `human:${messageId}`, input.laneSequence, 0, { kind: "human_message", id: `human:${messageId}`, sequence: 0, canonicalPosition: { laneSequence: input.laneSequence, itemOrdinal: 0 }, markdown: requestText }, null);
        if (inserted) this.context.database.prepare("UPDATE conversation_segments SET timeline_item_count=timeline_item_count+1 WHERE id=?").run(id);
        if (rootMessageId) {
          const projectionKey = turnCardProjectionKey(id, 0);
          this.context.database.prepare(`INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,card_id,element_id,state,sequence,start_cursor_json,delivered_cursor_json,pending_reply_id,created_at,updated_at)
            VALUES(?,?,0,NULL,NULL,?,'creating',1,NULL,NULL,NULL,?,?)`).run(`${id}:page:0`, id, projectionKey, input.observedAt, input.observedAt);
          const renderer = this.initialTurnCardRenderer;
          if (!renderer) throw new Error("Conversation Segment initial Turn Card renderer is not connected");
          const view = this.loadCardView(id);
          const page = this.listConversationSegmentPages(id)[0];
          if (!view || !page) throw new Error("Canonical Conversation Segment card state is unavailable");
          if (page.deliveryCohort === "semantic") return { outcome: "created", segmentId: id };
          const reply = this.enqueueOutboundReply({
            id: `${projectionKey}:create`, idempotencyKey: `${projectionKey}:create`,
            ...(gatewayId ? { gatewayId } : {}), bindingId: null,
            targetRole: "operation_result", rootMessageId, kind: "card_reply",
            payload: JSON.stringify(renderer(view, page)), projectionKey, snapshotRevision: 1,
            viewVersion: 1, laneKeyOverride: projectionKey,
            ...(input.workClass ? { workClass: input.workClass } : {})
          });
          this.context.database.prepare(`UPDATE conversation_segment_pages SET pending_reply_id=?
            WHERE segment_id=? AND page_index=0`).run(reply.id, id);
        } else {
          this.openCreateRecoveryGap(id, 0, "missing_initial_reply_route");
        }
        return { outcome: "created", segmentId: id };
      }
      if (payload.type === "tool_result") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : typeof payload.callId === "string" ? payload.callId : null;
        if (callId) {
          const rows = this.context.database.prepare("SELECT i.segment_id,i.lane_sequence,i.item_ordinal,i.item_json FROM conversation_segment_items i JOIN conversation_segments s ON s.id=i.segment_id WHERE i.item_id=? AND i.payload_compacted_at IS NULL AND s.agent_kind=? AND s.session_id=?").all(`tool:${callId}`, input.event.agentKind, input.event.sessionId) as Array<{ segment_id:string; lane_sequence:number; item_ordinal:number; item_json:string }>;
          const owners = rows.filter((row) => (JSON.parse(row.item_json) as { kind?: string }).kind === "tool");
          if (owners.length === 1) {
            const owner = owners[0]!;
            const item = JSON.parse(owner.item_json) as Extract<AnswerTimelineItem, { kind: "tool" }>;
            const updated = { ...item, ...(typeof payload.text === "string" ? { result: normalizeToolResultForDisplay(payload.text, payload.truncated === true) } : {}), state: payload.is_error || payload.isError ? "failed" as const : "succeeded" as const };
            if (JSON.stringify(item) === JSON.stringify(updated)) return { outcome: "duplicate", segmentId: owner.segment_id };
            this.persistItem(owner.segment_id, `tool:${callId}`, owner.lane_sequence, owner.item_ordinal, updated, owner);
            this.openLateBeforeCursorGap(owner.segment_id, owner.lane_sequence, owner.item_ordinal, `tool:${callId}`, input.event.eventId, input.observedAt);
            this.context.database.prepare("UPDATE conversation_segments SET view_version=view_version+1,updated_at=? WHERE id=?").run(input.observedAt, owner.segment_id);
            return { outcome: "projected", segmentId: owner.segment_id };
          }
        }
      }
      if (payload.type === "turn_completed" || payload.type === "turn_aborted") {
        const segments = this.context.database.prepare(`SELECT s.*
          FROM conversation_segments s
          JOIN core_event_inbox human ON human.event_id=s.human_event_id
          WHERE s.producer_key=? AND s.agent_kind=? AND s.session_id=?
            AND human.agent_kind=? AND human.session_id=? AND human.turn_id=?
          ORDER BY s.start_lane_sequence,s.start_item_ordinal`).all(
          producerKey,
          input.event.agentKind,
          input.event.sessionId,
          input.event.agentKind,
          input.event.sessionId,
          input.event.turnId
        ) as unknown as SegmentRow[];
        if (segments.length === 0) return { outcome: "ignored", segmentId: null };
        assertUniqueCanonicalStarts(segments, producerKey);
        const cohort = segments.map(mapSegment);
        const segment = cohort.at(-1)!;
        if (segment.state === "closed") return { outcome: "ignored", segmentId: segment.id };
        const state = payload.type === "turn_completed" ? "completed" : "cancelled";
        if (segment.state !== state && segment.state !== "working" && segment.state !== "needs_human") {
          return { outcome: "ignored", segmentId: segment.id };
        }
        for (let index = 0; index < cohort.length - 1; index += 1) {
          const earlier = cohort[index]!;
          const next = cohort[index + 1]!;
          if (earlier.state === "working") {
            const closed = this.context.database.prepare(`UPDATE conversation_segments
              SET end_lane_sequence=?,end_item_ordinal=0,state='closed',view_version=view_version+1,updated_at=?
              WHERE id=? AND state='working'`).run(next.startAt!.laneSequence, input.observedAt, earlier.id);
            if (closed.changes === 1) closedSegmentIds.push(earlier.id);
          }
        }
        const becameCompleted = state === "completed" && segment.state !== "completed";
        let changed = segment.state !== state;
        let insertedItems = 0;
        let becameVisible = false;
        for (const [ordinal, delta] of (input.timelineDeltas ?? []).entries()) {
          const existing = this.context.database.prepare("SELECT lane_sequence,item_ordinal,item_json FROM conversation_segment_items WHERE segment_id=? AND item_id=? AND payload_compacted_at IS NULL").get(segment.id, delta.id) as { lane_sequence: number; item_ordinal: number; item_json: string } | undefined;
          const position = existing ? { laneSequence: existing.lane_sequence, itemOrdinal: existing.item_ordinal } : { laneSequence: input.laneSequence, itemOrdinal: ordinal };
          if (this.isBeforeSegmentStart(segment, position)) continue;
          const item = mergeAnswerTimelineItem(existing ? JSON.parse(existing.item_json) as AnswerTimelineItem : undefined, { ...delta, canonicalPosition: position });
          const itemChanged = this.persistItem(segment.id, delta.id, position.laneSequence, position.itemOrdinal, item, existing ?? null);
          if (itemChanged) this.openLateBeforeCursorGap(segment.id, position.laneSequence, position.itemOrdinal, delta.id, input.event.eventId, input.observedAt);
          changed ||= itemChanged;
          insertedItems += !existing && itemChanged ? 1 : 0;
          becameVisible ||= itemChanged && isVisibleAssistantItem(item);
        }
        if (!changed) return { outcome: "duplicate", segmentId: segment.id };
        this.context.database.prepare(`UPDATE conversation_segments
          SET state=?, timeline_item_count=timeline_item_count+?,
            has_visible_assistant_content=MAX(has_visible_assistant_content,?),
            view_version=view_version+1, updated_at=?
          WHERE id=?`).run(state, insertedItems, becameVisible ? 1 : 0, input.observedAt, segment.id);
        if (becameCompleted) {
          const completion = this.loadCanonicalCompletionEvidence(segment.id, input.laneId, input.laneSequence, input.event.turnId);
          const choicePersisted = completion
            ? this.persistCanonicalCompletionChoice(segment.id, completion.text, completion.choice ?? undefined, input.observedAt)
            : false;
          if (completion && (choicePersisted || this.authorizesTrustedSubmissionActorMention(segment.id))) {
            this.persistCompletionNotice(segment.id, segment.viewVersion + 1, input.observedAt);
          }
        }
        return { outcome: "projected", segmentId: segment.id };
      }
      const prior = this.segmentForCanonicalTurn(producerKey, input.event.agentKind, input.event.sessionId, input.event.turnId)
        ?? this.openSegment(producerKey);
      if (!prior) return { outcome: "ignored", segmentId: null };
      const deltas = input.timelineDeltas ?? [];
      if (deltas.length === 0 && input.model === undefined && input.taskList === undefined && !input.goalChanges?.length) return { outcome: "ignored", segmentId: prior.id };
      let changed = false;
      let insertedItems = 0;
      let becameVisible = false;
      deltas.forEach((delta, ordinal) => {
        const existing = this.context.database.prepare("SELECT lane_sequence,item_ordinal,item_json FROM conversation_segment_items WHERE segment_id=? AND item_id=? AND payload_compacted_at IS NULL").get(prior.id, delta.id) as { lane_sequence: number; item_ordinal: number; item_json: string } | undefined;
        const position = existing ? { laneSequence: existing.lane_sequence, itemOrdinal: existing.item_ordinal } : { laneSequence: input.laneSequence, itemOrdinal: ordinal };
        if (this.isBeforeSegmentStart(prior, position)) return;
        const item = mergeAnswerTimelineItem(existing ? JSON.parse(existing.item_json) as AnswerTimelineItem : undefined, { ...delta, canonicalPosition: position });
        const itemChanged = this.persistItem(prior.id, delta.id, position.laneSequence, position.itemOrdinal, item, existing ?? null);
        if (itemChanged) this.openLateBeforeCursorGap(prior.id, position.laneSequence, position.itemOrdinal, delta.id, input.event.eventId, input.observedAt);
        changed ||= itemChanged;
        insertedItems += !existing && itemChanged ? 1 : 0;
        becameVisible ||= itemChanged && isVisibleAssistantItem(item);
      });
      if (input.model !== undefined) {
        const projectedModel = input.model.trim();
        const existing = this.context.database.prepare("SELECT model FROM conversation_segments WHERE id=?").get(prior.id) as { model: string | null };
        if (projectedModel && existing.model !== projectedModel) {
          this.context.database.prepare("UPDATE conversation_segments SET model=? WHERE id=?").run(projectedModel, prior.id);
          changed = true;
        }
      }
      if (input.taskList !== undefined) {
        const taskListJson = JSON.stringify(input.taskList.map(({ label, state }) => ({ label, ...(state === undefined ? {} : { state }) })));
        const existing = this.context.database.prepare("SELECT task_list_json FROM conversation_segments WHERE id=?").get(prior.id) as { task_list_json: string | null };
        if (existing.task_list_json !== taskListJson) {
          this.context.database.prepare("UPDATE conversation_segments SET task_list_json=? WHERE id=?").run(taskListJson, prior.id);
          changed = true;
        }
      }
      if (input.goalChanges?.length) {
        const currentGoalJson = this.loadCurrentGoalJson(prior.id);
        const currentGoal = currentGoalJson === null ? null : JSON.parse(currentGoalJson) as CurrentGoal;
        let nextGoal = currentGoal;
        for (const goalChange of input.goalChanges) nextGoal = reduceCurrentGoal(nextGoal, goalChange);
        const nextGoalJson = nextGoal === null ? null : JSON.stringify(nextGoal);
        if (currentGoalJson !== nextGoalJson) {
          this.context.database.prepare("UPDATE conversation_segments SET current_goal_json=? WHERE id=?").run(nextGoalJson, prior.id);
          changed = true;
        }
      }
      if (changed) this.context.database.prepare(`UPDATE conversation_segments
        SET timeline_item_count=timeline_item_count+?,
          has_visible_assistant_content=MAX(has_visible_assistant_content,?),
          view_version=view_version+1,updated_at=? WHERE id=?`).run(insertedItems, becameVisible ? 1 : 0, input.observedAt, prior.id);
      return { outcome: changed ? "projected" : "duplicate", segmentId: prior.id };
    });
  }

  private persistCompletionNotice(segmentId: string, requiredViewVersion: number, occurredAt: string): void {
    const row = this.context.database.prepare(`SELECT segment.owner_kind,segment.owner_id,segment.owner_generation,
        segment.submission_id,intent.ingress_source,intent.actor_json,intent.owner_kind AS intent_owner_kind,
        intent.owner_id AS intent_owner_id,intent.owner_generation AS intent_owner_generation
      FROM conversation_segments segment
      LEFT JOIN submission_intents intent ON intent.submission_id=segment.submission_id
      WHERE segment.id=?`).get(segmentId) as {
        owner_kind: "primary" | "worker"; owner_id: string; owner_generation: number; submission_id: string | null;
        ingress_source: string | null; actor_json: string | null; intent_owner_kind: "primary" | "worker" | null;
        intent_owner_id: string | null; intent_owner_generation: number | null;
      } | undefined;
    if (!row || !row.submission_id || !row.actor_json
      || row.intent_owner_kind !== row.owner_kind || row.intent_owner_id !== row.owner_id
      || row.intent_owner_generation !== row.owner_generation) return;
    let actor: SubmissionIntentActor;
    try { actor = JSON.parse(row.actor_json) as SubmissionIntentActor; } catch { return; }
    if (actor.kind !== "human" || actor.gatewayId !== row.ingress_source
      || !actor.gatewayId.startsWith("feishu:") || !canMentionFeishuOpenId(actor.id)) return;
    const parent = row.owner_kind === "primary"
      ? { binding_id: row.owner_id, binding_generation: row.owner_generation }
      : this.context.database.prepare(`SELECT worker.parent_binding_id AS binding_id,worker.parent_binding_generation AS binding_generation
          FROM agent_instances worker
          JOIN bindings binding ON binding.id=worker.parent_binding_id AND binding.generation=worker.parent_binding_generation
          JOIN worker_session_threads thread ON thread.worker_id=worker.id
            AND thread.worker_session_generation=worker.worker_session_generation AND thread.state='active'
          WHERE worker.id=? AND worker.generation=? AND worker.role='worker'
            AND worker.desired_state='running' AND worker.worker_session_lifecycle='active'
            AND worker.native_session_id=(SELECT session_id FROM conversation_segments WHERE id=?)
            AND thread.parent_binding_id=worker.parent_binding_id
            AND thread.parent_binding_generation=worker.parent_binding_generation
            AND thread.parent_pane_id=worker.parent_pane_id
            AND thread.root_message_id=(SELECT root_message_id FROM conversation_segments WHERE id=?)
            AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
            AND worker.parent_pane_id=binding.pane_id
            AND worker.parent_native_session_id=binding.agent_session_value`).get(
          row.owner_id, row.owner_generation, segmentId, segmentId
        ) as { binding_id: string; binding_generation: number } | undefined;
    if (!parent) return;
    this.context.database.prepare(`INSERT OR IGNORE INTO completion_notification_obligations(
      owner_kind,owner_id,owner_generation,binding_id,binding_generation,required_view_version,
      mention_open_id,notice_kind,state,notification_reply_id,presentation_reply_id,created_at,updated_at,released_at
    ) VALUES('primary-segment',?,?,?,?,? ,?,'completion','waiting_for_answer',NULL,NULL,?,?,NULL)`).run(
      segmentId, row.owner_generation, parent.binding_id, parent.binding_generation, requiredViewVersion,
      actor.id, occurredAt, occurredAt
    );
  }

  private completionPresentationFinalEventId(segmentId: string): string | null {
    const eventType = coreEventDiscriminatorSql(this.context.database, "final_inbox", "event_type");
    const channel = coreEventDiscriminatorSql(this.context.database, "final_inbox", "channel");
    const row = this.context.database.prepare(`SELECT final_inbox.event_id
      FROM completion_notification_obligations obligation
      JOIN conversation_segments segment ON segment.id=obligation.owner_id
        AND segment.owner_generation=obligation.owner_generation
      JOIN core_event_inbox human_inbox ON human_inbox.event_id=segment.human_event_id
      JOIN core_event_lane_items final_lane ON final_lane.lane_id=substr(segment.producer_key,6)
      JOIN core_event_inbox final_inbox ON final_inbox.event_id=final_lane.event_id
      WHERE obligation.owner_kind='primary-segment' AND obligation.owner_id=?
        AND obligation.notice_kind='completion' AND obligation.state='waiting_for_answer'
        AND final_inbox.turn_id=human_inbox.turn_id AND ${eventType}='message' AND ${channel}='final'
      ORDER BY final_lane.sequence DESC LIMIT 1`).get(segmentId) as { event_id:string } | undefined;
    return row?.event_id ?? null;
  }

  private loadCanonicalCompletionEvidence(segmentId: string, laneId?: string, terminalSequence?: number, turnId?: string | null): { text: string; choice: ChoicePrompt | null } | null {
    let resolved: { laneId:string; terminalSequence:number; turnId:string } | null = null;
    if (laneId !== undefined && terminalSequence !== undefined && turnId) {
      resolved = { laneId, terminalSequence, turnId };
    } else {
      const identity = this.context.database.prepare(`SELECT substr(segment.producer_key,6) AS lane_id,
          COALESCE((SELECT MIN(next_segment.start_lane_sequence) FROM conversation_segments next_segment
            WHERE next_segment.producer_key=segment.producer_key AND next_segment.start_lane_sequence>segment.start_lane_sequence),9007199254740991) AS terminal_sequence,
          human.turn_id
        FROM conversation_segments segment JOIN core_event_inbox human ON human.event_id=segment.human_event_id
        WHERE segment.id=?`).get(segmentId) as { lane_id:string; terminal_sequence:number; turn_id:string|null } | undefined;
      if (identity?.turn_id) resolved = { laneId: identity.lane_id, terminalSequence: identity.terminal_sequence, turnId: identity.turn_id };
    }
    if (!resolved?.turnId) return null;
    const eventType = coreEventDiscriminatorSql(this.context.database, "inbox", "event_type");
    const channel = coreEventDiscriminatorSql(this.context.database, "inbox", "channel");
    const row = this.context.database.prepare(`SELECT json_extract(inbox.event_json,'$.payload.text') AS text,
        json_extract(inbox.event_json,'$.payload.completion_choice') AS completion_choice,
        json_type(inbox.event_json,'$.payload.completion_choice') AS completion_choice_type
      FROM core_event_lane_items lane JOIN core_event_inbox inbox ON inbox.event_id=lane.event_id
      WHERE lane.lane_id=? AND lane.sequence<? AND inbox.turn_id=?
        AND inbox.payload_compacted_at IS NULL
        AND ${eventType}='message'
        AND ${channel}='final'
        AND json_type(inbox.event_json,'$.payload.text')='text'
      ORDER BY lane.sequence DESC LIMIT 1`).get(resolved.laneId, resolved.terminalSequence, resolved.turnId) as {
        text:string; completion_choice:unknown; completion_choice_type:string|null;
      } | undefined;
    if (!row) return null;
    let completionChoice: ChoicePrompt | null = null;
    if (row.completion_choice_type === "object") {
      try {
        if (typeof row.completion_choice !== "string") throw new Error("native completion choice object was not serialized");
        const value = JSON.parse(row.completion_choice) as unknown;
        completionChoice = isFinalMessageCompletionChoice(value) ? choicePromptFromLegacyCompletionChoice(value) : null;
      } catch { completionChoice = null; }
    } else if (row.completion_choice_type === null) {
      const evidence = this.context.database.prepare(`SELECT lane.sequence AS lane_sequence,
          json_extract(inbox.event_json,'$.payload.text') AS text,
          json_extract(inbox.event_json,'$.payload.truncated') AS truncated
        FROM core_event_lane_items lane JOIN core_event_inbox inbox ON inbox.event_id=lane.event_id
        WHERE lane.lane_id=? AND lane.sequence<? AND inbox.turn_id=?
          AND inbox.payload_compacted_at IS NULL
          AND ${eventType}='message' AND ${channel} IN ('commentary','final')
          AND json_type(inbox.event_json,'$.payload.text')='text'
        ORDER BY lane.sequence`).all(resolved.laneId, resolved.terminalSequence, resolved.turnId) as Array<{
          lane_sequence:number; text:string; truncated:number;
        }>;
      const folded = foldFinalTraceChoiceEvidence(evidence.map((item) => ({
        order: item.lane_sequence, text: item.text, truncated: item.truncated === 1
      })));
      completionChoice = folded.decision === "selected" ? folded.choice : folded.decision === "explicit-none" ? continueChoicePrompt() : null;
    }
    return { text: row.text, choice: completionChoice };
  }

  private authorizesTrustedSubmissionActorMention(segmentId: string): boolean {
    const row = this.context.database.prepare(`SELECT intent.ingress_source,intent.actor_json
      FROM conversation_segments segment JOIN submission_intents intent ON intent.submission_id=segment.submission_id
      WHERE segment.id=? AND segment.owner_kind='primary'
        AND intent.owner_kind='primary' AND intent.owner_id=segment.owner_id
        AND intent.owner_generation=segment.owner_generation`).get(segmentId) as { ingress_source:string; actor_json:string } | undefined;
    if (!row) return false;
    let actor: SubmissionIntentActor;
    try { actor = JSON.parse(row.actor_json) as SubmissionIntentActor; } catch { return false; }
    if (actor.kind !== "human" || actor.gatewayId !== row.ingress_source
      || !actor.gatewayId.startsWith("feishu:") || !isTrustedFeishuOpenId(actor.id)) return false;
    return true;
  }

  private persistCanonicalCompletionChoice(segmentId: string, answer: string, completionChoice: ChoicePrompt | undefined, occurredAt: string): boolean {
    const segment = this.getConversationSegment(segmentId);
    if (!segment) return false;
    return normalizeAndPersistCompletionChoice({
      context: this.context, ownerKind: "primary-segment", ownerId: segmentId,
      ownerGeneration: segment.ownerGeneration, answer, ...(completionChoice ? { completionChoice } : {}), occurredAt
    }).choice !== null;
  }

  private loadPrimarySegmentAction(segmentId: string, ownerGeneration: number): PrimarySegmentActionRow | null {
    return this.context.database.prepare(`SELECT id,owner_kind,owner_id,owner_generation,card_message_id,
      mention_open_id,presentation_kind,presentation_message_id,state,selected_choice_option_id,reason
      FROM completion_action_sets WHERE owner_kind='primary-segment' AND owner_id=? AND owner_generation=?`).get(
      segmentId, ownerGeneration
    ) as PrimarySegmentActionRow | undefined ?? null;
  }

  private mapPrimarySegmentAction(row: PrimarySegmentActionRow, choice: import("../../domain/completion-choice.js").ChoicePrompt | undefined): CompletionActionSetRenderState | null {
    const identity = { id: row.id, ownerKind: "primary-segment" as const, ownerId: row.owner_id,
      ownerGeneration: row.owner_generation, cardMessageId: row.presentation_kind === "fresh-card" ? row.presentation_message_id ?? "pending" : row.card_message_id ?? "pending" };
    if (["available", "provisional", "presenting", "active"].includes(row.state) && row.mention_open_id && choice) return {
      ...identity, state: "available", mentionOpenId: row.mention_open_id,
      choicePrompt: choice, choiceSpecification: choice, presentationKind: row.presentation_kind
    };
    if (row.state === "consumed" && row.reason === "ignored") return { ...identity, state: "consumed", ignored: true };
    if (row.state === "consumed" && choice && row.selected_choice_option_id) {
      const selected = [choice.defaultOption, ...choice.alternatives].find((option) => option.id === row.selected_choice_option_id);
      return selected ? { ...identity, state: "consumed", selectedChoice: { id: selected.id, label: selected.label } } : null;
    }
    return null;
  }

  private supersedePrimarySegmentAction(segmentId: string, occurredAt: string): void {
    this.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',
      error='Completion Review became obsolete before first delivery attempt',updated_at=?
      WHERE id=(SELECT presentation_reply_id FROM completion_action_sets
          WHERE owner_kind='primary-segment' AND owner_id=? AND presentation_kind='fresh-card'
            AND state IN ('provisional','presenting','active'))
        AND state='pending' AND claim_attempt_id IS NULL AND first_claimed_at IS NULL
        AND attempt_count=0 AND card_id_checkpoint IS NULL AND gateway_checkpoint_json IS NULL`).run(occurredAt, segmentId);
    const changed = this.context.database.prepare(`UPDATE completion_action_sets
      SET state='superseded',reason='newer-segment',decided_at=?,updated_at=?
      WHERE owner_kind='primary-segment' AND owner_id=? AND state IN ('available','provisional','presenting','active')`).run(occurredAt, occurredAt, segmentId);
    this.context.database.prepare(`UPDATE outbound_replies SET state='dismissed',
      error='Human Review mention became obsolete before first delivery attempt',updated_at=?
      WHERE id=(SELECT notification_reply_id FROM completion_notification_obligations
          WHERE owner_kind='primary-segment' AND owner_id=? AND state='waiting_for_answer')
        AND state='pending' AND kind='text' AND target_role='operation_result'
        AND claim_attempt_id IS NULL AND first_claimed_at IS NULL AND attempt_count=0`).run(occurredAt, segmentId);
    this.context.database.prepare(`UPDATE completion_notification_obligations
      SET state='suppressed',updated_at=?
      WHERE owner_kind='primary-segment' AND owner_id=? AND state='waiting_for_answer'
        AND (notification_reply_id IS NULL OR EXISTS(
          SELECT 1 FROM outbound_replies reply WHERE reply.id=notification_reply_id
            AND reply.state='dismissed'
        ))`).run(occurredAt, segmentId);
    if (changed.changes > 0) this.markPrimarySegmentActionChanged(segmentId, occurredAt);
  }

  private markPrimarySegmentActionChanged(segmentId: string, occurredAt: string): void {
    this.context.database.prepare("UPDATE conversation_segments SET view_version=view_version+1,updated_at=? WHERE id=?").run(occurredAt, segmentId);
    this.context.database.prepare(`UPDATE conversation_segment_pages
      SET state=CASE WHEN pending_reply_id IS NULL THEN 'active' ELSE state END,
        sequence=CASE WHEN pending_reply_id IS NULL THEN sequence ELSE sequence+1 END,updated_at=?
      WHERE segment_id=? AND page_index=(SELECT MAX(page_index) FROM conversation_segment_pages WHERE segment_id=?)
        AND state='finished'`).run(occurredAt, segmentId, segmentId);
  }

  /** Rehydrates a result-only replay from the durable Tool item when projector call state was lost on restart. */
  recoverToolResult(input: { laneId: string; laneSequence: number; event: CoreEventEnvelope; observedAt: string }): ConversationSegmentProjectionResult {
    const result: ConversationSegmentProjectionResult = this.context.transaction("sqlite.conversation-segment-store.write", () => {
      const payload = input.event.payload as Record<string, unknown>;
      const callId = typeof payload.call_id === "string" ? payload.call_id : typeof payload.callId === "string" ? payload.callId : null;
      if (payload.type !== "tool_result" || !callId) return { outcome: "ignored", segmentId: null };
      const segment = this.openSegment(`lane:${input.laneId}`);
      if (!segment) return { outcome: "ignored", segmentId: null };
      const row = this.context.database.prepare("SELECT lane_sequence,item_ordinal,item_json FROM conversation_segment_items WHERE segment_id=? AND item_id=? AND payload_compacted_at IS NULL").get(segment.id, `tool:${callId}`) as { lane_sequence: number; item_ordinal: number; item_json: string } | undefined;
      if (!row) return { outcome: "ignored", segmentId: segment.id };
      const item = JSON.parse(row.item_json) as AnswerTimelineItem;
      if (item.kind !== "tool") return { outcome: "ignored", segmentId: segment.id };
      const updated = { ...item, ...(typeof payload.text === "string" ? { result: normalizeToolResultForDisplay(payload.text, payload.truncated === true) } : {}), state: payload.is_error || payload.isError ? "failed" as const : "succeeded" as const };
      const changed = this.persistItem(segment.id, `tool:${callId}`, row.lane_sequence, row.item_ordinal, updated, row);
      if (changed) {
        this.openLateBeforeCursorGap(segment.id, row.lane_sequence, row.item_ordinal, `tool:${callId}`, input.event.eventId, input.observedAt);
        this.context.database.prepare("UPDATE conversation_segments SET view_version=view_version+1,updated_at=? WHERE id=?").run(input.observedAt, segment.id);
      }
      return { outcome: changed ? "projected" : "duplicate", segmentId: segment.id };
    });
    if (result.outcome === "projected" && result.segmentId) {
      const segment = this.getConversationSegment(result.segmentId);
      if (segment) this.notifyProjection({ segmentId: segment.id, viewVersion: segment.viewVersion, urgency: "trailing" });
    }
    return result;
  }

  listOpenSegments(producerKey: string): ConversationSegment[] { return this.listConversationSegmentsForProducer(producerKey).filter((segment) => segment.state !== "closed"); }

  private openSegment(producerKey: string): ConversationSegment | null {
    const rows = this.context.database.prepare(`SELECT * FROM conversation_segments
      WHERE producer_key=? AND state <> 'closed' AND start_lane_sequence IS NOT NULL
      ORDER BY start_lane_sequence DESC,start_item_ordinal DESC LIMIT 2`).all(producerKey) as unknown as SegmentRow[];
    assertUniqueCanonicalStarts(rows, producerKey);
    return rows[0] ? mapSegment(rows[0]) : null;
  }
  private segmentForCanonicalTurn(producerKey: string, agentKind: "traex" | "pi", sessionId: string, turnId: string | null | undefined): ConversationSegment | null {
    if (!turnId) return null;
    const rows = this.context.database.prepare(`SELECT segment.*
      FROM conversation_segments segment
      JOIN core_event_inbox human ON human.event_id=segment.human_event_id
      WHERE segment.producer_key=? AND segment.agent_kind=? AND segment.session_id=?
        AND human.agent_kind=? AND human.session_id=? AND human.turn_id=?
        AND segment.state <> 'closed'`).all(
      producerKey, agentKind, sessionId, agentKind, sessionId, turnId
    ) as unknown as SegmentRow[];
    return rows.length === 1 ? mapSegment(rows[0]!) : null;
  }
  private loadTaskListJson(segmentId: string): string | null {
    return (this.context.database.prepare("SELECT task_list_json FROM conversation_segments WHERE id=?").get(segmentId) as { task_list_json:string|null } | undefined)?.task_list_json ?? null;
  }
  private loadCurrentGoalJson(segmentId: string): string | null {
    return (this.context.database.prepare("SELECT current_goal_json FROM conversation_segments WHERE id=?").get(segmentId) as { current_goal_json:string|null } | undefined)?.current_goal_json ?? null;
  }
  private notifyProjection(notification: ConversationSegmentProjectionNotification): void {
    try {
      const result = this.projectionNotifier?.(notification);
      if (result && typeof (result as Promise<void>).then === "function") void (result as Promise<void>).catch(() => undefined);
    } catch { /* durable segment remains recoverable */ }
  }
  private resolveCanonicalRoute(agentKind: "traex" | "pi", sessionId: string): {
    ownerKind: "primary" | "worker"; ownerId: string; ownerGeneration: number; gatewayId: string; rootMessageId: string;
  } | null {
    const primary = this.context.database.prepare(`SELECT id,generation,gateway_id,root_message_id
      FROM bindings
      WHERE agent_kind=? AND agent_session_value=? AND state='active' AND lifecycle='active'
        AND attachment='attached' AND root_message_id IS NOT NULL`).all(agentKind, sessionId) as Array<{
          id: string; generation: number; gateway_id: string; root_message_id: string;
        }>;
    const workers = this.context.database.prepare(`SELECT worker.id,worker.generation,binding.gateway_id,thread.root_message_id
      FROM agent_instances worker
      JOIN worker_session_threads thread
        ON thread.worker_id=worker.id AND thread.worker_session_generation=worker.worker_session_generation AND thread.state='active'
      JOIN bindings binding
        ON binding.id=thread.parent_binding_id AND binding.generation=thread.parent_binding_generation
      WHERE worker.role='worker' AND worker.agent_kind=? AND worker.native_session_id=?
        AND worker.desired_state='running' AND worker.worker_session_lifecycle='active'
        AND binding.state='active' AND binding.lifecycle='active' AND thread.root_message_id IS NOT NULL`).all(agentKind, sessionId) as Array<{
          id: string; generation: number; gateway_id: string; root_message_id: string;
        }>;
    const candidates = [
      ...primary.map((row) => ({ ownerKind: "primary" as const, ownerId: row.id, ownerGeneration: row.generation, gatewayId: row.gateway_id, rootMessageId: row.root_message_id })),
      ...workers.map((row) => ({ ownerKind: "worker" as const, ownerId: row.id, ownerGeneration: row.generation, gatewayId: row.gateway_id, rootMessageId: row.root_message_id }))
    ];
    return candidates.length === 1 ? candidates[0]! : null;
  }
  private close(segment: ConversationSegment, laneSequence: number, updatedAt: string): void {
    if (segment.startAt && laneSequence === segment.startAt.laneSequence && segment.startAt.itemOrdinal === 0) throw new Error(`Conversation segment ${segment.id} has equal start/end boundary`);
    this.context.database.prepare("UPDATE conversation_segments SET end_lane_sequence=?,end_item_ordinal=0,state='closed',view_version=view_version+1,updated_at=? WHERE id=? AND state <> 'closed'").run(laneSequence, updatedAt, segment.id);
  }
  private isBeforeSegmentStart(segment: ConversationSegment, position: { laneSequence: number; itemOrdinal: number }): boolean {
    return segment.startAt !== null && (position.laneSequence < segment.startAt.laneSequence
      || position.laneSequence === segment.startAt.laneSequence && position.itemOrdinal < segment.startAt.itemOrdinal);
  }
  private persistItem(segmentId: string, itemId: string, laneSequence: number, itemOrdinal: number, item: AnswerTimelineItem, existing: Pick<ItemRow, "item_json"> | null): boolean {
    const itemJson = JSON.stringify(item);
    if (existing?.item_json === itemJson) return false;
    if (existing) {
      this.context.database.prepare("UPDATE conversation_segment_items SET item_json=? WHERE segment_id=? AND item_id=?").run(itemJson, segmentId, itemId);
      return true;
    }
    if (this.context.database.prepare("SELECT 1 FROM conversation_segment_items WHERE segment_id=? AND item_id=? AND payload_compacted_at IS NOT NULL").get(segmentId, itemId)) {
      assertCompactedPayloadCompatible(this.context, "conversation_segment_item", JSON.stringify(["conversation_segment_item", segmentId, itemId]), itemJson);
      return false;
    }
    this.context.database.prepare(`INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json)
      VALUES(?,?,?,?,?)`).run(segmentId, itemId, laneSequence, itemOrdinal, itemJson);
    return true;
  }
}

function isVisibleAssistantItem(item: AnswerTimelineItem): boolean {
  return (item.kind === "agent_message" || item.kind === "final_answer") && item.markdown.length > 0;
}

export function settleConversationPageDelivery(
  context: SqliteContext,
  input: { segmentId: string; pageIndex: number; replyId: string; messageId: string; cardId: string | null },
  subject?: ConversationPageSubject
): "checkpointed" | "stale" {
  const page = context.database.prepare(`SELECT p.state,p.sequence,p.message_id,p.card_id,p.element_id,p.pending_reply_id,p.pending_cursor_json,p.delivered_sequence,s.root_message_id,
    (SELECT prior.message_id FROM conversation_segment_pages prior WHERE prior.segment_id=p.segment_id AND prior.page_index=p.page_index-1) AS prior_message_id
    FROM conversation_segment_pages p JOIN conversation_segments s ON s.id=p.segment_id
    WHERE p.segment_id=? AND p.page_index=?`).get(input.segmentId, input.pageIndex) as { state: string; sequence:number; message_id: string|null; card_id: string|null; element_id: string; pending_reply_id: string|null; pending_cursor_json:string|null; delivered_sequence:number; root_message_id:string; prior_message_id:string|null } | undefined;
  const reply = context.database.prepare(`SELECT id,kind,state,root_message_id,projection_key,delivered_message_id,card_id_checkpoint,snapshot_revision,
    delivery_input_kind,subject_kind,subject_json,subject_revision FROM outbound_replies WHERE id=?`).get(input.replyId) as {
      id:string; kind:string; state:string; root_message_id:string|null; projection_key:string|null; delivered_message_id:string|null;
      card_id_checkpoint:string|null; snapshot_revision:number; delivery_input_kind:string|null; subject_kind:string|null; subject_json:string|null; subject_revision:number|null;
    } | undefined;
  const exactTarget = page && reply && (reply.kind === "card_reply"
    ? reply.root_message_id === (input.pageIndex === 0 ? page.root_message_id : page.prior_message_id)
    : reply.kind === "card_update" && page.message_id !== null && reply.root_message_id === page.message_id);
  const semanticIdentity = subject !== undefined
    && reply?.delivery_input_kind === "semantic-snapshot" && reply.subject_kind === subject.kind
    && reply.subject_json === JSON.stringify(subject) && reply.subject_revision === subject.revision
    && reply.snapshot_revision === subject.revision && page?.sequence === subject.revision;
  const legacyIdentity = subject === undefined
    && page?.element_id === turnCardProjectionKey(input.segmentId, input.pageIndex) && reply?.projection_key === page.element_id;
  const exactIdentity = page && reply && (semanticIdentity || legacyIdentity) && exactTarget
    && reply.state === "delivered" && reply.delivered_message_id === input.messageId && reply.card_id_checkpoint === input.cardId
    && (page.pending_reply_id === input.replyId || subject === undefined && page.pending_reply_id === null && page.message_id === input.messageId)
    && (subject !== undefined || !page.message_id || page.message_id === input.messageId)
    && (subject !== undefined || !page.card_id || !input.cardId || page.card_id === input.cardId);
  if (!page || !exactIdentity || !["creating", "active", "frozen", "finished"].includes(page.state)) return "stale";
  const timestamp = new Date().toISOString();
  const updated = context.database.prepare(`UPDATE conversation_segment_pages SET
      message_id=CASE WHEN ? THEN ? ELSE COALESCE(message_id,?) END,
      card_id=CASE WHEN ? THEN COALESCE(?,card_id) ELSE COALESCE(card_id,?) END,
      delivered_sequence=MAX(delivered_sequence,?), delivered_cursor_json=CASE WHEN pending_reply_id=? THEN pending_cursor_json ELSE delivered_cursor_json END,
      pending_cursor_json=CASE WHEN pending_reply_id=? THEN NULL ELSE pending_cursor_json END,
      pending_reply_id=CASE WHEN pending_reply_id=? THEN NULL ELSE pending_reply_id END,
      state=CASE WHEN state='creating' THEN 'active' WHEN state='finished' AND ? < sequence THEN 'active' ELSE state END,
      updated_at=? WHERE segment_id=? AND page_index=? AND (?=0 OR (pending_reply_id=? AND sequence=?))`)
    .run(subject !== undefined ? 1 : 0, input.messageId, input.messageId, subject !== undefined ? 1 : 0, input.cardId, input.cardId,
      reply.snapshot_revision, input.replyId, input.replyId, input.replyId, reply.snapshot_revision, timestamp,
      input.segmentId, input.pageIndex, subject !== undefined ? 1 : 0, input.replyId, reply.snapshot_revision);
  return updated.changes === 1 ? "checkpointed" : "stale";
}

function reservationParityDescriptor(identity: DeliveryReservationIdentity, pagePlan: ConversationPagePlan): Omit<PresentationParityDescriptor, "visibleStructureFingerprint" | "committedBounds" | "recomputedBounds"> {
  return Object.freeze({
    deliveryTarget: Object.freeze({ kind: identity.deliveryTarget.kind, identityFingerprint: parityHash(identity.deliveryTarget) }),
    scopeOrder: Object.freeze({
      scopeFingerprint: parityHash(identity.scope),
      ownerFingerprint: parityHash(identity.ownerFence),
      orderingIdentityFingerprint: parityHash(identity.orderingIdentity)
    }),
    idempotencyFingerprint: parityHash(identity.idempotencyKey),
    canonicalPageInterval: Object.freeze({
      pageIndex: pagePlan.pageIndex,
      startCursor: pagePlan.startCursor ? Object.freeze({ ...pagePlan.startCursor }) : null,
      endCursor: pagePlan.endCursor ? Object.freeze({ ...pagePlan.endCursor }) : null,
      hasContinuation: pagePlan.hasContinuation
    })
  });
}
function parityHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

interface SegmentRow { id: string; producer_key: string; owner_kind: "primary"|"worker"; owner_id: string; owner_generation: number; submission_id: string|null; human_event_id: string|null; agent_kind: "traex"|"pi"; session_id: string|null; request_text: string; start_lane_sequence: number|null; start_item_ordinal: number|null; end_lane_sequence: number|null; end_item_ordinal: number|null; state: ConversationSegment["state"]; view_version: number; root_message_id: string; created_at: string; updated_at: string }
interface ItemRow { segment_id: string; item_id: string; lane_sequence: number; item_ordinal: number; item_json: string }
interface PageRow { id: string; segment_id: string; page_index: number; message_id: string|null; card_id: string|null; element_id: string; state: ConversationSegmentPage["state"]; sequence: number; delivered_sequence: number; start_cursor_json: string|null; delivered_cursor_json: string|null; pending_cursor_json:string|null; pending_reply_id: string|null; created_at: string; updated_at: string; start_lane_sequence: number|null; start_item_ordinal: number|null; cursor_base: number; start_anchor_inclusive:number; continuation_lane_sequence:number|null; continuation_item_ordinal:number|null; continuation_anchor_inclusive:number; continuation_cursor_base:number|null; delivery_cohort:"legacy"|"semantic"|null }
interface PrimarySegmentActionRow {
  id:string; owner_kind:"primary-segment"; owner_id:string; owner_generation:number; card_message_id:string|null;
  mention_open_id:string|null; presentation_kind:"legacy-inline"|"fresh-card"; presentation_message_id:string|null;
  state:"available"|"provisional"|"presenting"|"active"|"consumed"|"superseded"|"unavailable";
  selected_choice_option_id:string|null; reason:string|null;
}
interface RejectedRootReplyRow {
  id:string; gateway_id:string; gateway_profile_id:string; idempotency_key:string; binding_id:string|null; worker_id:string|null; worker_session_generation:number|null;
  target_role:string|null; work_class:OutboundWorkClass; root_message_id:string|null; projection_key:string|null; snapshot_revision:number;
  state:string; effect_certainty:DeliveryEffectCertainty|null; auto_recovery_count:number; delivered_message_id:string|null; card_id_checkpoint:string|null; gateway_checkpoint_json:string|null; lane_key:string;
  scope_kind:string|null; scope_key:string|null; scope_workspace_id:string|null; scope_pane_id:string|null; kind:OutboundReplyKind; delivery_owner_kind:string|null; delivery_owner_id:string|null;
  delivery_owner_generation:number|null; delivery_owner_session_generation:number|null; delivery_parent_id:string|null;
  delivery_parent_generation:number|null; delivery_parent_session_generation:number|null;
}
type PreparedRootReplyRow = Pick<RejectedRootReplyRow,
  "gateway_id"|"lane_key"|"scope_kind"|"scope_key"|"scope_workspace_id"|"scope_pane_id"|
  "delivery_owner_kind"|"delivery_owner_id"|"delivery_owner_generation"|"delivery_owner_session_generation"|
  "delivery_parent_id"|"delivery_parent_generation"|"delivery_parent_session_generation">;
function mapSegment(r: SegmentRow): ConversationSegment { return { id:r.id, producerKey:r.producer_key, ownerKind:r.owner_kind, ownerId:r.owner_id, ownerGeneration:r.owner_generation, submissionId:r.submission_id, humanEventId:r.human_event_id, agentKind:r.agent_kind, sessionId:r.session_id, requestText:r.request_text, startAt:r.start_lane_sequence===null?null:{laneSequence:r.start_lane_sequence,itemOrdinal:r.start_item_ordinal!}, endBefore:r.end_lane_sequence===null?null:{laneSequence:r.end_lane_sequence,itemOrdinal:r.end_item_ordinal!}, state:r.state, viewVersion:r.view_version, rootMessageId:r.root_message_id, createdAt:r.created_at, updatedAt:r.updated_at }; }
function primarySegmentActionSetId(segmentId: string, ownerGeneration: number): string { return `primary-segment-action:${segmentId}:${ownerGeneration}`; }
function assertUniqueCanonicalStarts(rows: readonly SegmentRow[], producerKey: string): void {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!; const current = rows[index]!;
    if (previous.start_lane_sequence === current.start_lane_sequence && previous.start_item_ordinal === current.start_item_ordinal) {
      throw new Error(`Conversation segments for ${producerKey} share a canonical start position`);
    }
  }
}
function mapPage(r: PageRow): ConversationSegmentPage { return { id:r.id, segmentId:r.segment_id, pageIndex:r.page_index, messageId:r.message_id, cardId:r.card_id, elementId:r.element_id, state:r.state, sequence:r.sequence, deliveredSequence:r.delivered_sequence, startCursor:r.start_cursor_json?JSON.parse(r.start_cursor_json):null, deliveredCursor:r.delivered_cursor_json?JSON.parse(r.delivered_cursor_json):null, pendingCursor:r.pending_cursor_json?JSON.parse(r.pending_cursor_json):null, pendingReplyId:r.pending_reply_id, createdAt:r.created_at, updatedAt:r.updated_at, deliveryCohort:r.delivery_cohort??"legacy" }; }

function projectionUrgency(
  input: { event: CoreEventEnvelope; timelineDeltas?: readonly AnswerTimelineDelta[] },
  outcome: ConversationSegmentProjectionResult["outcome"],
  hadVisibleAssistantContent: boolean
): ConversationSegmentProjectionNotification["urgency"] {
  if (outcome === "created" || outcome === "adopted") return "immediate";
  const payload = input.event.payload as Record<string, unknown>;
  if (payload.type === "turn_completed" || payload.type === "turn_aborted"
    || payload.type === "context_compacted" || payload.type === "model_changed") return "immediate";
  if (payload.type === "agent_activity" && ["completed", "failed", "cancelled", "interrupted"].includes(String(payload.state))) return "immediate";
  const firstVisibleAssistantContent = !hadVisibleAssistantContent && (input.timelineDeltas ?? []).some((item) =>
    (item.kind === "agent_message" || item.kind === "final_answer") && item.markdown.length > 0
  );
  return firstVisibleAssistantContent ? "immediate" : "trailing";
}

function cursorAfter(candidate: AnswerTimelineCursor | null, acknowledged: AnswerTimelineCursor | null): boolean {
  if (!candidate) return false;
  if (!acknowledged) return true;
  return candidate.itemIndex > acknowledged.itemIndex
    || candidate.itemIndex === acknowledged.itemIndex && candidate.markdownOffset > acknowledged.markdownOffset;
}

function sameTimelineCursor(left: AnswerTimelineCursor, right: AnswerTimelineCursor): boolean {
  return left.itemIndex === right.itemIndex
    && (left.offset ?? left.markdownOffset ?? 0) === (right.offset ?? right.markdownOffset ?? 0)
    && (left.section ?? "message") === (right.section ?? "message");
}

function compareTimelineCursor(left: AnswerTimelineCursor, right: AnswerTimelineCursor): number {
  if (!Number.isSafeInteger(left.itemIndex) || !Number.isSafeInteger(right.itemIndex) || left.itemIndex < 0 || right.itemIndex < 0) return Number.NaN;
  if ((left.section ?? "message") !== "message" || (right.section ?? "message") !== "message") return Number.NaN;
  if (left.itemIndex !== right.itemIndex) return left.itemIndex - right.itemIndex;
  return (left.offset ?? left.markdownOffset ?? 0) - (right.offset ?? right.markdownOffset ?? 0);
}

function payloadContainsElementId(payload: string, elementId: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return true; }
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (!Array.isArray(value)) {
      const node = value as Record<string, unknown>;
      if (node.element_id === elementId || node.slot === elementId) return true;
    }
    return Object.values(value).some(visit);
  };
  return visit(parsed);
}
