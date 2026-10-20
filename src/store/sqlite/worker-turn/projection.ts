import { randomUUID } from "node:crypto";
import type { AnswerSegment } from "../../../domain/answer-segment.js";
import type { AnswerTimelineItem } from "../../../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../../../domain/delivery.js";
import type { OutboxStore, PreparedDeliveryConsumer, PreparedDeliveryReservation } from "../../../domain/ports/outbox.js";
import type {
  AnswerPageDeliveryFacts,
  AnswerPageReservationOutcome,
  AnswerTimelinePageCheckpoint,
  OutboundReply,
  OutboundReplyState,
} from "../../../domain/types.js";
import type {
  WorkerTurnCardPage,
  WorkerTurnCardView,
} from "../../../domain/worker-turn-card-view.js";
import { SqliteAnswerSegmentStore, type ReserveHumanMessageAnswerSegmentsInput, type ReserveHumanMessageAnswerSegmentsResult } from "../answer-segment-store.js";
import { SqliteAnswerTimelinePageStore } from "../answer-timeline-page-store.js";
import { SqliteAnswerTimelineStore } from "../answer-timeline-store.js";
import type { SqliteContext } from "../context.js";
import { incrementWorkerTurnPageSequence } from "../answer-page-sequence.js";
import type { EnqueueOutboundReplyInput } from "../outbox-queue-store.js";
import {
  mapWorkerTurnCard,
  mapWorkerTurnCardPage,
  parseJsonRecord,
} from "./records.js";

export class WorkerTurnProjection {
  private readonly timelines: SqliteAnswerTimelineStore;
  private readonly timelinePages: SqliteAnswerTimelinePageStore;
  private readonly segments: SqliteAnswerSegmentStore;
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      enqueueOutboundReply(input: EnqueueOutboundReplyInput): unknown;
    },
  ) {
    this.timelines = new SqliteAnswerTimelineStore(context);
    this.timelinePages = new SqliteAnswerTimelinePageStore(context);
    this.segments = new SqliteAnswerSegmentStore(context);
  }

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.segments.setPreparedDeliveryReservation(reservation, consumer);
  }

  private enqueueOutboundReply(input: EnqueueOutboundReplyInput): OutboundReply {
    return this.dependencies.enqueueOutboundReply(input) as OutboundReply;
  }

  load(turnId: string): WorkerTurnCardView | null {
    const view = mapWorkerTurnCard(
      this.context.database
        .prepare("SELECT * FROM worker_turn_cards WHERE turn_id = ?")
        .get(turnId) as Record<string, unknown> | undefined,
    );
    return view
      ? { ...view, timelineItems: this.timelines.load("worker-turn", turnId) }
      : null;
  }
  findTurnIdByMessage(messageId: string): string | null {
    const rows = this.context.database
      .prepare(
        "SELECT turn_id FROM worker_turn_card_pages WHERE message_id = ? UNION SELECT turn_id FROM worker_turn_cards WHERE message_id = ?",
      )
      .all(messageId, messageId) as Array<{ turn_id: string }>;
    return rows.length === 1 ? rows[0]!.turn_id : null;
  }
  listPages(turnId: string): WorkerTurnCardPage[] {
    return (
      this.context.database
        .prepare(
          "SELECT * FROM worker_turn_card_pages WHERE turn_id = ? ORDER BY page_index",
        )
        .all(turnId) as Array<Record<string, unknown>>
    ).map(mapWorkerTurnCardPage);
  }
  listAnswerSegments(
    aggregateKind: "primary-run" | "worker-turn",
    aggregateId: string,
  ): AnswerSegment[] {
    return this.segments.listAnswerSegments(aggregateKind, aggregateId);
  }
  reserveHumanMessageAnswerSegments(
    input: ReserveHumanMessageAnswerSegmentsInput,
  ): ReserveHumanMessageAnswerSegmentsResult {
    return this.segments.reserveHumanMessageAnswerSegments(input);
  }
  listActionableIds(): string[] {
    return (
      this.context.database
        .prepare(
          `SELECT DISTINCT card.turn_id FROM worker_turn_cards card
           JOIN worker_turn_card_pages page ON page.turn_id = card.turn_id
           JOIN instance_turns turn ON turn.id = card.turn_id
             AND turn.instance_id = card.instance_id AND turn.instance_generation = card.instance_generation
           JOIN agent_instances worker ON worker.id = card.instance_id
             AND worker.role = 'worker' AND worker.generation = card.instance_generation
             AND worker.worker_session_generation = card.worker_session_generation
             AND worker.worker_session_lifecycle = 'active'
           JOIN bindings parent ON parent.id = worker.parent_binding_id
             AND parent.generation = worker.parent_binding_generation
             AND parent.pane_id = worker.parent_pane_id
             AND parent.state = 'active' AND parent.lifecycle = 'active' AND parent.attachment = 'attached'
           LEFT JOIN completion_notification_obligations obligation ON obligation.owner_kind = 'worker-turn' AND obligation.owner_id = card.turn_id
           LEFT JOIN completion_action_sets action ON action.owner_kind = 'worker-turn' AND action.owner_id = card.turn_id
           WHERE page.card_id IS NOT NULL AND (
             page.state = 'active'
             OR (page.state = 'finished' AND (obligation.state IN ('waiting_for_answer','missing_mention_target')
               OR (obligation.state = 'released' AND action.id IS NULL AND EXISTS (
                 SELECT 1 FROM outbound_replies legacy
                 WHERE legacy.id = obligation.notification_reply_id AND legacy.state = 'pending'
                   AND legacy.kind = 'text' AND legacy.target_role='operation_result'
                   AND legacy.payload LIKE '%需要你的选择%'
                   AND legacy.claim_attempt_id IS NULL AND legacy.claimed_owner_id IS NULL AND legacy.claimed_fence IS NULL
                   AND legacy.claimed_at IS NULL AND legacy.first_claimed_at IS NULL AND legacy.attempt_count = 0
                   AND legacy.delivered_message_id IS NULL AND legacy.card_id_checkpoint IS NULL AND legacy.gateway_checkpoint_json IS NULL
                   AND COALESCE(legacy.effect_certainty,'not-started') IN ('not-started','rejected')
               ))
               OR (action.state IN ('available','consumed','superseded') AND card.delivered_version < card.view_version)))
           ) ORDER BY card.updated_at, card.turn_id`,
        )
        .all() as Array<{ turn_id: string }>
    ).map(({ turn_id }) => turn_id);
  }
  listRecoverableIds(limit: number): string[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    return (this.context.database.prepare(`
      SELECT DISTINCT failed.worker_turn_id
      FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      JOIN worker_turn_cards card ON card.turn_id = failed.worker_turn_id
      JOIN instance_turns turn ON turn.id = card.turn_id
        AND turn.instance_id = card.instance_id AND turn.instance_generation = card.instance_generation
      JOIN agent_instances worker ON worker.id = card.instance_id
        AND worker.role = 'worker' AND worker.generation = card.instance_generation
        AND worker.worker_session_generation = card.worker_session_generation
      JOIN worker_turn_card_pages page ON page.turn_id = card.turn_id
        AND page.page_index = failed.stream_page_index AND page.state = 'frozen'
      WHERE recovery.state IN ('unresolved','replacement_pending')
        AND recovery.action = 'rebuild_worker_task'
        AND failed.worker_turn_id IS NOT NULL
      ORDER BY recovery.updated_at, failed.worker_turn_id
      LIMIT ?`).all(limit) as Array<{ worker_turn_id: string }>).map(({ worker_turn_id }) => worker_turn_id);
  }
  listRecoverableIdsForBinding(bindingId: string, limit: number): string[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    return (this.context.database.prepare(`
      SELECT DISTINCT failed.worker_turn_id
      FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      JOIN worker_turn_cards card ON card.turn_id = failed.worker_turn_id
      JOIN instance_turns turn ON turn.id = card.turn_id
        AND turn.instance_id = card.instance_id AND turn.instance_generation = card.instance_generation
      JOIN agent_instances worker ON worker.id = card.instance_id
        AND worker.role = 'worker' AND worker.generation = card.instance_generation
        AND worker.worker_session_generation = card.worker_session_generation
        AND worker.parent_binding_id = ?
      JOIN worker_turn_card_pages page ON page.turn_id = card.turn_id
        AND page.page_index = failed.stream_page_index AND page.state = 'frozen'
      WHERE recovery.state IN ('unresolved','replacement_pending')
        AND recovery.action = 'rebuild_worker_task'
        AND failed.worker_turn_id IS NOT NULL
      ORDER BY recovery.updated_at, failed.worker_turn_id
      LIMIT ?`).all(bindingId, limit) as Array<{ worker_turn_id: string }>).map(({ worker_turn_id }) => worker_turn_id);
  }
  getDeliveryFacts(turnId: string, pageIndex: number): AnswerPageDeliveryFacts {
    const page = this.context.database
      .prepare(
        "SELECT element_id FROM worker_turn_card_pages WHERE turn_id = ? AND page_index = ?",
      )
      .get(turnId, pageIndex) as { element_id: string } | undefined;
    if (!page)
      return {
        latestContent: null,
        finishPending: false,
        continuationPending: false,
        finalUpdateState: null,
      };
    const row = this.context.database
      .prepare(
        "SELECT payload, state, view_version FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_content' AND stream_page_index = ? AND selection_id IS NULL AND state IN ('pending','delivered','dead_letter') ORDER BY delivery_order DESC LIMIT 1",
      )
      .get(turnId, pageIndex) as
      | {
          payload: string;
          state: OutboundReplyState;
          view_version: number | null;
        }
      | undefined;
    const payload = row ? parseJsonRecord(row.payload) : null;
    const latestContent =
      row && payload
        ? {
            content: typeof payload.content === "string" ? payload.content : "",
            sequence: Number(payload.sequence ?? row.view_version ?? 0),
            state: row.state,
            sourceEnd: Number.isInteger(payload.sourceEnd)
              ? Number(payload.sourceEnd)
              : null,
          }
        : null;
    const finalRow = this.context.database.prepare(`SELECT state FROM outbound_replies
      WHERE worker_turn_id = ? AND kind = 'card_update' AND stream_page_index = ?
        AND view_version = (SELECT view_version FROM worker_turn_cards WHERE turn_id = ?)
        AND idempotency_key LIKE ? AND state IN ('pending','delivered','dead_letter','dismissed')
      ORDER BY delivery_order DESC LIMIT 1`).get(turnId, pageIndex, turnId, `worker-turn:hydrate:${turnId}:${pageIndex}:%`) as { state: OutboundReplyState } | undefined;
    return {
      latestContent,
      finishPending:
        this.context.database
          .prepare(
            "SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_finish' AND stream_page_index = ? AND state = 'pending' LIMIT 1",
          )
          .get(turnId, pageIndex) !== undefined,
      continuationPending:
        this.context.database
          .prepare(
            "SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_card_create' AND stream_page_index = ? AND state = 'pending' LIMIT 1",
          )
          .get(turnId, pageIndex + 1) !== undefined,
      finalUpdateState: finalRow?.state ?? null,
    };
  }
  getTimelinePage(
    turnId: string,
    pageIndex: number,
  ): AnswerTimelinePageCheckpoint {
    return this.timelinePages.load("worker-turn", turnId, pageIndex);
  }
  listFrozenTimelineItems(turnId: string, beforePageIndex: number) {
    return this.timelinePages.frozenItems(
      "worker-turn",
      turnId,
      beforePageIndex,
    );
  }
  reserveTimelineCard(input: {
    turnId: string;
    pageIndex: number;
    messageId: string;
    card: object;
    cursor: AnswerTimelineCursor | null;
    items: readonly AnswerTimelineItem[];
  }): AnswerPageReservationOutcome {
    const page = this.context.database
      .prepare(
        "SELECT state, message_id FROM worker_turn_card_pages WHERE turn_id = ? AND page_index = ?",
      )
      .get(input.turnId, input.pageIndex) as
      | { state: string; message_id: string | null }
      | undefined;
    const view = this.load(input.turnId);
    if (
      !page ||
      !view ||
      page.state !== "active" ||
      page.message_id !== input.messageId
    )
      return "stale";
    this.timelinePages.ensure("worker-turn", input.turnId, input.pageIndex, {
      itemIndex: 0,
      markdownOffset: 0,
    });
    if (
      this.timelinePages.load("worker-turn", input.turnId, input.pageIndex)
        .pending ||
      this.timelinePages.isDelivered(
        "worker-turn",
        input.turnId,
        input.pageIndex,
        input.cursor,
        input.items,
      )
    )
      return "waiting";
    const cardSequence = incrementWorkerTurnPageSequence(this.context, input.turnId, input.pageIndex);
    const reply = this.enqueueOutboundReply({
      id: randomUUID(),
      idempotencyKey: `worker-turn:timeline:${input.turnId}:${input.pageIndex}:${view.viewVersion}`,
      bindingId: null,
      workerTurnId: input.turnId,
      viewVersion: view.viewVersion,
      cardSequence,
      streamPageIndex: input.pageIndex,
      rootMessageId: input.messageId,
      kind: "card_update",
      payload: JSON.stringify(input.card),
      laneKeyOverride: `worker-turn:${input.turnId}:${input.pageIndex}`,
    }) as OutboundReply;
    this.timelinePages.reserve(
      "worker-turn",
      input.turnId,
      input.pageIndex,
      reply.id,
      input.cursor,
      input.items,
    );
    return "reserved";
  }
  reserveContent(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    elementId: string;
    content: string;
    sourceEnd: number;
  }): AnswerPageReservationOutcome {
    return this.reservePage(input.turnId, input.pageIndex, (page) => {
      if (page.cardId !== input.cardId || page.elementId !== input.elementId)
        return "stale";
      const facts = this.getDeliveryFacts(input.turnId, input.pageIndex);
      if (
        facts.latestContent?.state === "pending" ||
        facts.latestContent?.content === input.content
      )
        return "waiting";
      const sequence = this.incrementSequence(page);
      this.enqueueOutboundReply({
        id: randomUUID(),
        idempotencyKey: `worker-turn:stream:${input.turnId}:${input.pageIndex}:${sequence}`,
        bindingId: null,
        workerTurnId: input.turnId,
        viewVersion: sequence,
        cardSequence: sequence,
        rootMessageId: input.cardId,
        kind: "stream_content",
        payload: JSON.stringify({
          pageIndex: input.pageIndex,
          elementId: input.elementId,
          content: input.content,
          sourceEnd: input.sourceEnd,
          sequence,
        }),
      });
      return "reserved";
    });
  }
  reserveProgress(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    elementId: string;
    content: string;
  }): AnswerPageReservationOutcome {
    return this.reservePage(input.turnId, input.pageIndex, (page, view) => {
      if (page.cardId !== input.cardId) return "stale";
      const row = this.context.database
        .prepare(
          "SELECT payload, state FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_content' AND stream_page_index = ? AND selection_id = 'worker-progress' AND state IN ('pending','delivered','dead_letter') ORDER BY delivery_order DESC LIMIT 1",
        )
        .get(input.turnId, input.pageIndex) as
        | { payload: string; state: OutboundReplyState }
        | undefined;
      const latest = row
        ? { ...row, payload: parseJsonRecord(row.payload) }
        : undefined;
      if (
        latest?.state === "pending" ||
        latest?.state === "dead_letter" ||
        latest?.payload.content === input.content
      )
        return "waiting";
      const sequence = page.sequence + 1;
      if (
        this.context.database
          .prepare(
            "UPDATE worker_turn_cards SET progress_sequence = ?, updated_at = ? WHERE turn_id = ? AND progress_sequence = ?",
          )
          .run(sequence, now(), input.turnId, view.progressSequence).changes !== 1
      )
        return "stale";
      if (incrementWorkerTurnPageSequence(this.context, input.turnId, input.pageIndex) !== sequence) {
        throw new Error("Worker Task progress sequence allocation diverged");
      }
      this.enqueueOutboundReply({
        id: randomUUID(),
        idempotencyKey: `worker-turn:progress:${input.turnId}:${input.pageIndex}:${sequence}`,
        bindingId: null,
        workerTurnId: input.turnId,
        selectionId: "worker-progress",
        viewVersion: sequence,
        cardSequence: sequence,
        rootMessageId: input.cardId,
        kind: "stream_content",
        payload: JSON.stringify({
          workerElement: "progress",
          pageIndex: input.pageIndex,
          elementId: input.elementId,
          content: input.content,
          sequence,
        }),
      });
      return "reserved";
    });
  }
  reserveFinish(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    summary: string;
  }): AnswerPageReservationOutcome {
    return this.reservePage(input.turnId, input.pageIndex, (page) => {
      if (page.cardId !== input.cardId) return "stale";
      if (this.getDeliveryFacts(input.turnId, input.pageIndex).finishPending)
        return "waiting";
      const sequence = this.incrementSequence(page);
      this.enqueueOutboundReply({
        id: randomUUID(),
        idempotencyKey: `worker-turn:finish:${input.turnId}:${input.pageIndex}:${sequence}`,
        bindingId: null,
        workerTurnId: input.turnId,
        viewVersion: sequence,
        cardSequence: sequence,
        rootMessageId: input.cardId,
        kind: "stream_finish",
        payload: JSON.stringify({
          pageIndex: input.pageIndex,
          summary: input.summary,
          sequence,
        }),
      });
      return "reserved";
    });
  }
  reserveHydration(input: {
    turnId: string;
    pageIndex: number;
    cardId: string | null;
    messageId: string;
    card: object;
  }): AnswerPageReservationOutcome {
    const row = this.context.database
      .prepare(
        "SELECT * FROM worker_turn_card_pages WHERE turn_id = ? AND page_index = ?",
      )
      .get(input.turnId, input.pageIndex) as
      | Record<string, unknown>
      | undefined;
    const view = this.load(input.turnId);
    if (!row || !view) return "stale";
    const page = mapWorkerTurnCardPage(row);
    const live =
      page.pageIndex > 0 &&
      page.state === "active" &&
      (view.phase === "running" || view.phase === "blocked");
    const done =
      ["active", "finished"].includes(page.state) &&
      ["completed", "failed", "cancelled", "dispatch-uncertain"].includes(view.phase);
    if (
      (!live && !done) ||
      page.cardId !== input.cardId ||
      page.messageId !== input.messageId
    )
      return "stale";
    const key = `worker-turn:hydrate:${input.turnId}:${input.pageIndex}:${input.cardId}:${view.viewVersion}:${view.phase}:${page.state}`;
    if (
      this.context.database
        .prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key = ?")
        .get(key)
    )
      return "waiting";
    const cardSequence = incrementWorkerTurnPageSequence(this.context, input.turnId, input.pageIndex);
    this.enqueueOutboundReply({
      id: randomUUID(),
      idempotencyKey: key,
      bindingId: null,
      workerTurnId: input.turnId,
      viewVersion: view.viewVersion,
      cardSequence,
      streamPageIndex: input.pageIndex,
      rootMessageId: input.messageId,
      kind: "card_update",
      payload: JSON.stringify(input.card),
      laneKeyOverride: `worker-turn:${input.turnId}:${input.pageIndex}`,
    });
    return "reserved";
  }
  reserveContinuation(input: {
    turnId: string;
    pageIndex: number;
    cardId: string;
    summary: string;
    nextPageIndex: number;
    nextPageStart: number;
    nextElementId: string;
    rootMessageId: string;
    viewVersion: number;
    card: object;
    timelineStartCursor?: AnswerTimelineCursor;
    timelineEndCursor?: AnswerTimelineCursor | null;
    timelineItems?: readonly AnswerTimelineItem[];
  }): AnswerPageReservationOutcome {
    return this.reservePage(input.turnId, input.pageIndex, (page) => {
      if (
        page.cardId !== input.cardId ||
        input.nextPageIndex !== input.pageIndex + 1 ||
        input.nextPageStart <= page.pageStart
      )
        return "stale";
      const facts = this.getDeliveryFacts(input.turnId, input.pageIndex);
      if (
        (facts.latestContent && facts.latestContent.state !== "delivered") ||
        facts.finishPending ||
        facts.continuationPending
      )
        return "waiting";
      const sequence = this.incrementSequence(page);
      this.enqueueOutboundReply({
        id: randomUUID(),
        idempotencyKey: `worker-turn:finish:${input.turnId}:${input.pageIndex}:${sequence}`,
        bindingId: null,
        workerTurnId: input.turnId,
        viewVersion: sequence,
        cardSequence: sequence,
        rootMessageId: input.cardId,
        kind: "stream_finish",
        payload: JSON.stringify({
          pageIndex: input.pageIndex,
          summary: input.summary,
          sequence,
        }),
      });
      const create = this.enqueueOutboundReply({
        id: randomUUID(),
        idempotencyKey: `worker-turn:create:${input.turnId}:${input.nextPageIndex}`,
        bindingId: null,
        workerTurnId: input.turnId,
        viewVersion: input.viewVersion,
        rootMessageId: input.rootMessageId,
        kind: "stream_card_create",
        payload: JSON.stringify({
          card: input.card,
          stream: {
            pageIndex: input.nextPageIndex,
            pageStart: input.nextPageStart,
            elementId: input.nextElementId,
          },
        }),
      }) as OutboundReply;
      if (input.timelineStartCursor) {
        this.timelinePages.ensure(
          "worker-turn",
          input.turnId,
          input.nextPageIndex,
          input.timelineStartCursor,
        );
        this.timelinePages.reserve(
          "worker-turn",
          input.turnId,
          input.nextPageIndex,
          create.id,
          input.timelineEndCursor ?? null,
          input.timelineItems ?? [],
        );
      }
      return "reserved";
    });
  }
  reserveRecovery(input: {
    turnId: string;
    previousPageIndex: number;
    nextPageIndex: number;
    pageStart: number;
    nextElementId: string;
    rootMessageId: string;
    viewVersion: number;
    card: object;
  }): AnswerPageReservationOutcome {
    const previous = this.context.database.prepare(`SELECT state, page_start FROM worker_turn_card_pages
      WHERE turn_id = ? AND page_index = ?`).get(input.turnId, input.previousPageIndex) as { state: string; page_start: number } | undefined;
    const view = this.load(input.turnId);
    if (!previous || !view || previous.state !== "frozen" || input.nextPageIndex !== input.previousPageIndex + 1
      || input.pageStart !== Number(previous.page_start) || input.rootMessageId !== view.rootMessageId || input.viewVersion !== view.viewVersion) return "stale";
    const recoverable = this.context.database.prepare(`SELECT 1 FROM delivery_recoveries recovery
      JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
      JOIN worker_turn_cards card ON card.turn_id = failed.worker_turn_id
      JOIN instance_turns turn ON turn.id = card.turn_id
        AND turn.instance_id = card.instance_id AND turn.instance_generation = card.instance_generation
      JOIN agent_instances worker ON worker.id = card.instance_id
        AND worker.role = 'worker' AND worker.generation = card.instance_generation
        AND worker.worker_session_generation = card.worker_session_generation
      WHERE recovery.action = 'rebuild_worker_task' AND recovery.state IN ('unresolved','replacement_pending')
        AND failed.worker_turn_id = ? AND failed.stream_page_index = ? LIMIT 1`).get(input.turnId, input.previousPageIndex);
    if (!recoverable) return "stale";
    const idempotencyKey = `worker-turn:recovery:${input.turnId}:${input.nextPageIndex}`;
    const existing = this.context.database.prepare("SELECT id, state FROM outbound_replies WHERE idempotency_key = ?").get(idempotencyKey) as { id: string; state: OutboundReplyState } | undefined;
    if (existing) return existing.state === "pending" || existing.state === "delivered" ? "waiting" : "stale";
    const replacement = this.enqueueOutboundReply({
      id: randomUUID(),
      idempotencyKey,
      workClass: "history",
      bindingId: null,
      workerTurnId: input.turnId,
      viewVersion: input.viewVersion,
      rootMessageId: input.rootMessageId,
      kind: "stream_card_create",
      payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.pageStart, elementId: input.nextElementId } })
    }) as OutboundReply;
    this.context.database.prepare(`UPDATE delivery_recoveries SET state = 'replacement_pending', replacement_reply_id = ?, updated_at = ?
      WHERE action = 'rebuild_worker_task' AND state IN ('unresolved','replacement_pending')
        AND failed_reply_id IN (SELECT id FROM outbound_replies WHERE worker_turn_id = ? AND stream_page_index = ?)`
    ).run(replacement.id, now(), input.turnId, input.previousPageIndex);
    return "reserved";
  }
  save(view: WorkerTurnCardView): void {
    this.context.database
      .prepare(
        `INSERT INTO worker_turn_cards(turn_id, instance_id, instance_generation, worker_session_generation, worker_name, parent_turn_id, root_message_id, message_id, card_id, element_id, progress_sequence, phase, request_text, answer, status_title, token_count, progress_json, queue_position, started_at, finished_at, notice, result_capture, worker_main_ref_json, primary_answer_ref_json, page_index, page_start, sequence, view_version, delivered_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(turn_id) DO UPDATE SET message_id=excluded.message_id, card_id=excluded.card_id, phase=excluded.phase, answer=excluded.answer, status_title=excluded.status_title, token_count=excluded.token_count, progress_json=excluded.progress_json, queue_position=excluded.queue_position, started_at=excluded.started_at, finished_at=excluded.finished_at, notice=excluded.notice, result_capture=excluded.result_capture, worker_main_ref_json=excluded.worker_main_ref_json, primary_answer_ref_json=excluded.primary_answer_ref_json, page_index=excluded.page_index, page_start=excluded.page_start, sequence=excluded.sequence, view_version=excluded.view_version, delivered_version=excluded.delivered_version, updated_at=excluded.updated_at`,
      )
      .run(
        view.turnId,
        view.instanceId,
        view.instanceGeneration,
        view.workerSessionGeneration,
        view.workerName,
        view.parentTurnId,
        view.rootMessageId,
        view.messageId,
        view.cardId,
        view.elementId,
        view.progressSequence,
        view.phase,
        view.requestText,
        view.answer,
        view.statusTitle,
        view.tokenCount,
        JSON.stringify(view.progressEvents),
        view.queuePosition,
        view.startedAt,
        view.finishedAt,
        view.notice,
        view.resultCapture,
        JSON.stringify(view.workerMain),
        view.primaryAnswer ? JSON.stringify(view.primaryAnswer) : null,
        view.pageIndex,
        view.pageStart,
        view.sequence,
        view.viewVersion,
        view.deliveredVersion,
        view.createdAt,
        view.updatedAt,
      );
    this.timelines.save("worker-turn", view.turnId, view.timelineItems ?? []);
    this.segments.ensureSegmentZero("worker-turn", view.turnId, view.requestText);
    this.context.database
      .prepare(
        `INSERT OR IGNORE INTO worker_turn_card_pages(id, turn_id, page_index, segment_index, page_start, element_id, message_id, card_id, delivery_mode, state, sequence, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'streaming', ?, ?, ?, ?)`,
      )
      .run(
        `${view.turnId}:${view.pageIndex}`,
        view.turnId,
        view.pageIndex,
        view.pageStart,
        view.elementId,
        view.messageId,
        view.cardId,
        view.cardId ? "active" : "creating",
        view.sequence,
        view.createdAt,
        view.updatedAt,
      );
  }
  private reservePage(
    turnId: string,
    pageIndex: number,
    reserve: (
      page: WorkerTurnCardPage,
      view: WorkerTurnCardView,
    ) => AnswerPageReservationOutcome,
  ): AnswerPageReservationOutcome {
    const row = this.context.database
      .prepare(
        "SELECT * FROM worker_turn_card_pages WHERE turn_id = ? AND page_index = ? AND state = 'active'",
      )
      .get(turnId, pageIndex) as Record<string, unknown> | undefined;
    const view = this.load(turnId);
    return row && view ? reserve(mapWorkerTurnCardPage(row), view) : "stale";
  }
  private incrementSequence(page: WorkerTurnCardPage): number {
    const sequence = incrementWorkerTurnPageSequence(
      this.context,
      page.turnId,
      page.pageIndex,
    );
    if (sequence === null) throw new Error("Worker Task page missing during sequence allocation");
    return sequence;
  }
}
function now(): string {
  return new Date().toISOString();
}
