import { randomUUID } from "node:crypto";
import type { AnswerTimelineItem } from "../../../domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../../../domain/delivery.js";
import type { OutboxStore } from "../../../domain/ports/outbox.js";
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
import { SqliteAnswerTimelinePageStore } from "../answer-timeline-page-store.js";
import { SqliteAnswerTimelineStore } from "../answer-timeline-store.js";
import type { RichTextDocument } from "../../../domain/rich-text.js";
import { initialRichTextAnswerPayload } from "../../../domain/rich-text.js";
import { shouldRefreshRichText } from "../../../runtime/answer-rich-text.js";
import type { SqliteContext } from "../context.js";
import type { EnqueueOutboundReplyInput } from "../outbox-queue-store.js";
import {
  mapWorkerTurnCard,
  mapWorkerTurnCardPage,
  parseJsonRecord,
} from "./records.js";

export class WorkerTurnProjection {
  private readonly timelines: SqliteAnswerTimelineStore;
  private readonly timelinePages: SqliteAnswerTimelinePageStore;
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      enqueueOutboundReply(input: EnqueueOutboundReplyInput): unknown;
    },
  ) {
    this.timelines = new SqliteAnswerTimelineStore(context);
    this.timelinePages = new SqliteAnswerTimelinePageStore(context);
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
  listActionableIds(): string[] {
    return (
      this.context.database
        .prepare(
          `SELECT DISTINCT card.turn_id FROM worker_turn_cards card JOIN worker_turn_card_pages page ON page.turn_id = card.turn_id WHERE page.state = 'active' AND page.message_id IS NOT NULL AND (page.delivery_mode = 'rich_post' OR page.card_id IS NOT NULL) ORDER BY card.updated_at, card.turn_id`,
        )
        .all() as Array<{ turn_id: string }>
    ).map(({ turn_id }) => turn_id);
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
      finalUpdateState: null,
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
    const reply = this.dependencies.enqueueOutboundReply({
      id: randomUUID(),
      idempotencyKey: `worker-turn:timeline:${input.turnId}:${input.pageIndex}:${view.viewVersion}`,
      bindingId: null,
      workerTurnId: input.turnId,
      viewVersion: view.viewVersion,
      rootMessageId: input.messageId,
      kind: "card_update",
      payload: JSON.stringify(input.card),
      laneKeyOverride: `worker-turn:${input.turnId}`,
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
  reserveRichTextUpdate(input: { turnId: string; pageIndex: number; messageId: string; document: RichTextDocument; cursor: AnswerTimelineCursor | null; items: readonly AnswerTimelineItem[]; sourceEnd?: number; pageState: "active" | "finished" }): AnswerPageReservationOutcome {
    const page = this.listPages(input.turnId).find((candidate) => candidate.state === "active" && candidate.pageIndex === input.pageIndex);
    const view = this.load(input.turnId);
    if (!page || !view || page.deliveryMode !== "rich_post" || page.messageId !== input.messageId) return "stale";
    this.timelinePages.ensure("worker-turn", input.turnId, input.pageIndex, { itemIndex: 0, markdownOffset: 0 });
    const key = `worker-rich:${input.turnId}:${input.pageIndex}`;
    const payload = JSON.stringify({ pageIndex: input.pageIndex, pageStart: page.pageStart, elementId: page.elementId, ...(input.sourceEnd === undefined ? {} : { sourceEnd: input.sourceEnd }), pageState: input.pageState, terminal: input.pageState === "finished", document: input.document });
    const existing = this.context.database.prepare("SELECT payload, snapshot_revision, state, updated_at FROM outbound_replies WHERE projection_key = ? ORDER BY snapshot_revision DESC, delivery_order DESC LIMIT 1").get(key) as { payload: string; snapshot_revision: number; state: OutboundReplyState; updated_at: string } | undefined;
    if (existing?.payload === payload || existing?.state === "pending") return "waiting";
    if (input.pageState === "active" && existing?.state === "delivered" && !shouldRefreshRichText(existing.payload, input.document, existing.updated_at)) return "waiting";
    const revision = (existing?.snapshot_revision ?? 0) + 1;
    const reply = this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `${key}:revision:${revision}`, bindingId: null, workerTurnId: input.turnId, viewVersion: view.viewVersion, rootMessageId: input.messageId, kind: "card_update", intentKind: "rich-text-update", payload, projectionKey: key, snapshotRevision: revision, laneKeyOverride: `worker-turn:${input.turnId}` }) as OutboundReply;
    this.timelinePages.reserve("worker-turn", input.turnId, input.pageIndex, reply.id, input.cursor, input.items);
    return "reserved";
  }
  reserveRichTextContinuation(input: { turnId: string; pageIndex: number; messageId: string; document: RichTextDocument; cursor: AnswerTimelineCursor; items: readonly AnswerTimelineItem[]; sourceEnd?: number; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number }): AnswerPageReservationOutcome {
    const page = this.listPages(input.turnId).find((candidate) => candidate.state === "active" && candidate.pageIndex === input.pageIndex);
    const view = this.load(input.turnId);
    if (!page || !view || page.deliveryMode !== "rich_post" || page.messageId !== input.messageId || input.nextPageIndex !== input.pageIndex + 1) return "stale";
    const key = `worker-rich:${input.turnId}:${input.pageIndex}:freeze`;
    if (this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE projection_key = ? AND state IN ('pending','delivered')").get(key)) return "waiting";
    const payload = JSON.stringify({ pageIndex: page.pageIndex, pageStart: page.pageStart, elementId: page.elementId, ...(input.sourceEnd === undefined ? {} : { sourceEnd: input.sourceEnd }), pageState: "frozen", document: input.document });
    const update = this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: key, bindingId: null, workerTurnId: input.turnId, viewVersion: view.viewVersion, rootMessageId: input.messageId, kind: "card_update", intentKind: "rich-text-update", payload, projectionKey: key, snapshotRevision: 1, laneKeyOverride: `worker-turn:${input.turnId}` }) as OutboundReply;
    this.timelinePages.reserve("worker-turn", input.turnId, input.pageIndex, update.id, input.cursor, input.items);
    this.timelinePages.ensure("worker-turn", input.turnId, input.nextPageIndex, input.cursor);
    this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `answer-post:${input.turnId}:${input.nextPageIndex}`, bindingId: null, workerTurnId: input.turnId, viewVersion: input.viewVersion, rootMessageId: input.rootMessageId, kind: "text", intentKind: "rich-text-reply", payload: JSON.stringify(initialRichTextAnswerPayload(input.nextPageIndex, input.nextPageStart, input.nextElementId)), laneKeyOverride: `worker-turn:${input.turnId}` });
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
      this.dependencies.enqueueOutboundReply({
        id: randomUUID(),
        idempotencyKey: `worker-turn:stream:${input.turnId}:${input.pageIndex}:${sequence}`,
        bindingId: null,
        workerTurnId: input.turnId,
        viewVersion: sequence,
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
      const sequence = view.progressSequence + 1;
      if (
        this.context.database
          .prepare(
            "UPDATE worker_turn_cards SET progress_sequence = ?, updated_at = ? WHERE turn_id = ? AND progress_sequence = ?",
          )
          .run(sequence, now(), input.turnId, view.progressSequence).changes !==
        1
      )
        return "stale";
      this.dependencies.enqueueOutboundReply({
        id: randomUUID(),
        idempotencyKey: `worker-turn:progress:${input.turnId}:${input.pageIndex}:${sequence}`,
        bindingId: null,
        workerTurnId: input.turnId,
        selectionId: "worker-progress",
        viewVersion: sequence,
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
      this.dependencies.enqueueOutboundReply({
        id: randomUUID(),
        idempotencyKey: `worker-turn:finish:${input.turnId}:${input.pageIndex}:${sequence}`,
        bindingId: null,
        workerTurnId: input.turnId,
        viewVersion: sequence,
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
    cardId: string;
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
      ["active", "finished"].includes(page.state) && view.phase === "completed";
    if (
      (!live && !done) ||
      page.cardId !== input.cardId ||
      page.messageId !== input.messageId
    )
      return "stale";
    const key = `worker-turn:hydrate:${input.turnId}:${input.pageIndex}:${input.cardId}:${view.phase}:${page.state}`;
    if (
      this.context.database
        .prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key = ?")
        .get(key)
    )
      return "waiting";
    this.dependencies.enqueueOutboundReply({
      id: randomUUID(),
      idempotencyKey: key,
      bindingId: null,
      workerTurnId: input.turnId,
      viewVersion: view.viewVersion,
      rootMessageId: input.messageId,
      kind: "card_update",
      payload: JSON.stringify(input.card),
      laneKeyOverride: `worker-turn:${input.turnId}`,
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
      this.dependencies.enqueueOutboundReply({
        id: randomUUID(),
        idempotencyKey: `worker-turn:finish:${input.turnId}:${input.pageIndex}:${sequence}`,
        bindingId: null,
        workerTurnId: input.turnId,
        viewVersion: sequence,
        rootMessageId: input.cardId,
        kind: "stream_finish",
        payload: JSON.stringify({
          pageIndex: input.pageIndex,
          summary: input.summary,
          sequence,
        }),
      });
      const create = this.dependencies.enqueueOutboundReply({
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
    const sequence = page.sequence + 1;
    this.context.database
      .prepare(
        "UPDATE worker_turn_card_pages SET sequence = ?, updated_at = ? WHERE turn_id = ? AND page_index = ? AND state = 'active' AND sequence = ?",
      )
      .run(sequence, now(), page.turnId, page.pageIndex, page.sequence);
    this.context.database
      .prepare(
        "UPDATE worker_turn_cards SET sequence = ?, updated_at = ? WHERE turn_id = ? AND page_index = ?",
      )
      .run(sequence, now(), page.turnId, page.pageIndex);
    return sequence;
  }
}
function now(): string {
  return new Date().toISOString();
}
