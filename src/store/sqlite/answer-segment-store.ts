import { randomUUID } from "node:crypto";
import { answerElementId } from "../../domain/run-card-view.js";
import type { AnswerSegment, AnswerSegmentBoundary } from "../../domain/answer-segment.js";
import type { OutboundWorkClass } from "../../domain/types.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReceipt, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import { withWorkerTaskProjectionIdentity } from "./worker-task-projection-identity.js";
import { workerTurnElementId } from "../../domain/worker-turn-card-view.js";
import type { EnqueueOutboundReplyInput } from "./outbox-queue-store.js";
import type { SqliteContext } from "./context.js";
import { incrementPrimaryAnswerPageSequence, incrementWorkerTurnPageSequence } from "./answer-page-sequence.js";

type AggregateKind = AnswerSegment["aggregateKind"];

type PrimaryAggregate = {
  aggregateKind: "primary-run";
  aggregateId: string;
  expectedGeneration: number;
  requestText: string;
  bindingId: string;
  viewVersion: number;
  pageIndex: number;
  pageStart: number;
  elementId: string;
  messageId: string | null;
  state: "creating" | "active" | "frozen" | "finished";
};

type WorkerAggregate = {
  aggregateKind: "worker-turn";
  aggregateId: string;
  expectedGeneration: number;
  requestText: string;
  viewVersion: number;
  pageIndex: number;
  messageId: string | null;
  state: "creating" | "active" | "frozen" | "finished";
};

type AggregateState = PrimaryAggregate | WorkerAggregate;

export interface ReserveHumanMessageAnswerSegmentsInput {
  aggregateKind: AggregateKind;
  aggregateId: string;
  expectedGeneration: number;
  boundaries: readonly AnswerSegmentBoundary[];
  previousFinalizedCard: object;
  nextCards: readonly object[];
  rootMessageId: string;
  workClass?: OutboundWorkClass;
}

export interface ReserveHumanMessageAnswerSegmentsResult {
  created: number;
  replyIds: string[];
}

export class SqliteAnswerSegmentStore {
  private preparedDeliveryReservation: PreparedDeliveryReservation | null = null;
  private preparedDeliveryConsumer: PreparedDeliveryConsumer | null = null;
  constructor(private readonly context: SqliteContext) {}

  setPreparedDeliveryReservation(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.preparedDeliveryReservation = reservation;
    this.preparedDeliveryConsumer = consumer;
  }

  listAnswerSegments(
    aggregateKind: AggregateKind,
    aggregateId: string,
  ): AnswerSegment[] {
    return this.context.database
      .prepare(`
        SELECT aggregate_kind, aggregate_id, segment_index, source_human_item_id, request_text,
          start_after_sequence, end_before_sequence, end_before_item_id, state
        FROM answer_segments
        WHERE aggregate_kind = ? AND aggregate_id = ?
        ORDER BY segment_index
      `)
      .all(aggregateKind, aggregateId)
      .map((row) => mapAnswerSegment(row as Record<string, unknown>));
  }

  ensureSegmentZero(
    aggregateKind: AggregateKind,
    aggregateId: string,
    requestText: string,
    startAfterSequence = 0,
  ): void {
    const timestamp = now();
    this.context.database
      .prepare(`
        INSERT OR IGNORE INTO answer_segments(
          aggregate_kind, aggregate_id, segment_index, source_human_item_id, request_text,
          start_after_sequence, end_before_sequence, end_before_item_id, state, created_at, updated_at
        ) VALUES (?, ?, 0, NULL, ?, ?, NULL, NULL, 'open', ?, ?)
      `)
      .run(
        aggregateKind,
        aggregateId,
        requestText,
        startAfterSequence,
        timestamp,
        timestamp,
      );
  }

  reserveHumanMessageAnswerSegments(
    input: ReserveHumanMessageAnswerSegmentsInput,
  ): ReserveHumanMessageAnswerSegmentsResult {
    if (input.boundaries.length === 0) return { created: 0, replyIds: [] };
    if (input.boundaries.length !== input.nextCards.length) {
      throw new Error("Human Message boundary reservation requires one next-card payload per boundary");
    }

    const aggregate = this.loadAggregate(input);
    if (!aggregate) return { created: 0, replyIds: [] };

    this.ensureSegmentZero(
      aggregate.aggregateKind,
      aggregate.aggregateId,
      aggregate.requestText,
    );

    const existing = this.listAnswerSegments(
      aggregate.aggregateKind,
      aggregate.aggregateId,
    );
    const materialized = new Set(
      existing
        .map((segment) => segment.sourceHumanItemId)
        .filter((value): value is string => typeof value === "string"),
    );
    const pending = input.boundaries.filter(
      (boundary) => !materialized.has(boundary.sourceHumanItemId),
    );
    if (pending.length === 0) return { created: 0, replyIds: [] };

    const pendingCards = input.nextCards.filter((_, index) =>
      !materialized.has(input.boundaries[index]!.sourceHumanItemId),
    );
    const timestamp = now();
    const openSegment = existing.at(-1);
    if (!openSegment) throw new Error("Segment zero must exist before reserving Human Message boundaries");

    const currentPageIndex = this.maxPageIndex(
      aggregate.aggregateKind,
      aggregate.aggregateId,
    );
    const currentSegmentIndex = openSegment.segmentIndex;

    this.context.database
      .prepare(`
        UPDATE answer_segments
        SET end_before_sequence = ?, end_before_item_id = ?, state = 'closed', updated_at = ?
        WHERE aggregate_kind = ? AND aggregate_id = ? AND segment_index = ?
      `)
      .run(
        pending[0]!.sequence,
        pending[0]!.sourceHumanItemId,
        timestamp,
        aggregate.aggregateKind,
        aggregate.aggregateId,
        currentSegmentIndex,
      );

    this.freezeCurrentPageIfNeeded(aggregate, currentPageIndex, timestamp);

    const replyIds: string[] = [];
    if (aggregate.messageId !== null && aggregate.state === "active") {
      const cardSequence = aggregate.aggregateKind === "primary-run"
        ? incrementPrimaryAnswerPageSequence(this.context, aggregate.aggregateId, currentPageIndex)
        : incrementWorkerTurnPageSequence(this.context, aggregate.aggregateId, currentPageIndex);
      const reply = this.reserveOutboundReply({
        id: randomUUID(),
        idempotencyKey: finalFoldKey(
          aggregate.aggregateKind,
          aggregate.aggregateId,
          currentPageIndex,
          aggregate.messageId,
        ),
        ...(aggregate.aggregateKind === "primary-run"
          ? {
              bindingId: aggregate.bindingId,
              promptId: aggregate.aggregateId,
              viewVersion: aggregate.viewVersion,
              cardRole: "answer" as const,
              streamPageIndex: currentPageIndex,
            }
          : {
              bindingId: null,
              workerTurnId: aggregate.aggregateId,
              viewVersion: aggregate.viewVersion,
              streamPageIndex: currentPageIndex,
            }),
        ...(input.workClass ? { workClass: input.workClass } : {}),
        cardSequence,
        rootMessageId: aggregate.messageId,
        kind: "card_update",
        payload: JSON.stringify(input.previousFinalizedCard),
      }, aggregate) as { id: string };
      replyIds.push(reply.id);
    }

    let pageIndex = currentPageIndex;
    let segmentIndex = currentSegmentIndex;
    for (let index = 0; index < pending.length; index += 1) {
      const boundary = pending[index]!;
      const nextBoundary = pending[index + 1] ?? null;
      pageIndex += 1;
      segmentIndex += 1;
      this.context.database
        .prepare(`
          INSERT INTO answer_segments(
            aggregate_kind, aggregate_id, segment_index, source_human_item_id, request_text,
            start_after_sequence, end_before_sequence, end_before_item_id, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          aggregate.aggregateKind,
          aggregate.aggregateId,
          segmentIndex,
          boundary.sourceHumanItemId,
          boundary.requestText,
          boundary.sequence,
          nextBoundary?.sequence ?? null,
          nextBoundary?.sourceHumanItemId ?? null,
          nextBoundary ? "closed" : "open",
          timestamp,
          timestamp,
        );
      this.insertPageRow(
        aggregate.aggregateKind,
        aggregate.aggregateId,
        pageIndex,
        segmentIndex,
        boundary.sequence,
        timestamp,
      );
      if (aggregate.aggregateKind === "primary-run" && this.preparedDeliveryReservation) {
        this.stagePreviousPrimaryPageForPreparation(aggregate.aggregateId, pageIndex);
      }
      const reply = this.reserveOutboundReply({
        id: randomUUID(),
        idempotencyKey: createCardKey(
          aggregate.aggregateKind,
          aggregate.aggregateId,
          pageIndex,
        ),
        ...(aggregate.aggregateKind === "primary-run"
          ? {
              bindingId: aggregate.bindingId,
              promptId: aggregate.aggregateId,
              viewVersion: aggregate.viewVersion,
              cardRole: "answer" as const,
              streamPageIndex: pageIndex,
            }
          : {
              bindingId: null,
              workerTurnId: aggregate.aggregateId,
              viewVersion: aggregate.viewVersion,
              streamPageIndex: pageIndex,
            }),
        ...(input.workClass ? { workClass: input.workClass } : {}),
        rootMessageId: input.rootMessageId,
        kind: "stream_card_create",
        payload: JSON.stringify(pendingCards[index]),
      }, aggregate) as { id: string };
      replyIds.push(reply.id);
    }
    if (aggregate.aggregateKind === "primary-run" && this.preparedDeliveryReservation) {
      this.context.database.prepare(`UPDATE run_cards SET answer_page_index=?,answer_page_start=?,answer_element_id=? WHERE prompt_id=? AND binding_generation=?`).run(
        aggregate.pageIndex, aggregate.pageStart, aggregate.elementId, aggregate.aggregateId, aggregate.expectedGeneration
      );
    }

    return { created: pending.length, replyIds };
  }

  private reserveOutboundReply(input: EnqueueOutboundReplyInput, aggregate: AggregateState): unknown {
    if (!this.preparedDeliveryReservation || !this.preparedDeliveryConsumer) throw new Error("Answer Segment prepared delivery is not connected");
    const routed = aggregate.aggregateKind === "worker-turn" ? withWorkerTaskProjectionIdentity(this.context, input) : input;
    const receipt = this.preparedDeliveryReservation.reservePreparedOutboundReply({
      ...routed,
      ...(aggregate.aggregateKind === "primary-run" ? {
        bindingId: aggregate.bindingId,
        bindingGeneration: aggregate.expectedGeneration
      } : {}),
      ...(aggregate.aggregateKind === "primary-run" && routed.kind === "stream_card_create" && routed.streamPageIndex !== null && routed.streamPageIndex !== undefined
        ? { payload: this.primaryContinuationPayload(aggregate.aggregateId, routed.streamPageIndex, routed.payload) }
        : {}),
    });
    this.handoffAfterCommit(receipt);
    return receipt.result;
  }

  private primaryContinuationPayload(promptId: string, pageIndex: number, cardPayload: string): string {
    const page = this.context.database.prepare("SELECT source_start,element_id FROM answer_pages WHERE prompt_id=? AND page_index=? AND state='creating'").get(promptId, pageIndex) as { source_start: number; element_id: string } | undefined;
    if (!page) throw new Error(`Primary Answer continuation page disappeared during preparation: ${promptId}:${pageIndex}`);
    return JSON.stringify({
      card: JSON.parse(cardPayload) as object,
      stream: { pageIndex, pageStart: Number(page.source_start), elementId: page.element_id }
    });
  }

  private stagePreviousPrimaryPageForPreparation(promptId: string, nextPageIndex: number): void {
    const previous = this.context.database.prepare("SELECT page_index,source_start,element_id FROM answer_pages WHERE prompt_id=? AND page_index=?").get(promptId, nextPageIndex - 1) as { page_index: number; source_start: number; element_id: string } | undefined;
    if (!previous) throw new Error(`Primary Answer preceding page disappeared during preparation: ${promptId}:${nextPageIndex - 1}`);
    const changed = this.context.database.prepare("UPDATE run_cards SET answer_page_index=?,answer_page_start=?,answer_element_id=? WHERE prompt_id=?").run(
      Number(previous.page_index), Number(previous.source_start), previous.element_id, promptId
    );
    if (Number(changed.changes) !== 1) throw new Error(`Primary Answer view disappeared during continuation preparation: ${promptId}`);
  }

  private handoffAfterCommit(receipt: PreparedDeliveryReceipt): void {
    queueMicrotask(() => {
      for (const delivery of receipt.consumeEffects()) this.preparedDeliveryConsumer!.enqueuePreparedDelivery(delivery);
    });
  }

  private loadAggregate(
    input: ReserveHumanMessageAnswerSegmentsInput,
  ): AggregateState | null {
    if (input.aggregateKind === "primary-run") {
      const row = this.context.database
        .prepare(`
          SELECT card.prompt_id, card.binding_id, card.binding_generation, card.request_text, card.view_version,
            card.answer_page_index, card.answer_page_start, card.answer_element_id, card.answer_message_id
          FROM run_cards card JOIN bindings binding ON binding.id=card.binding_id
          WHERE card.prompt_id = ? AND binding.generation=card.binding_generation
            AND binding.state='active' AND binding.lifecycle='active' AND binding.attachment='attached'
            AND binding.pane_id IS NOT NULL
        `)
        .get(input.aggregateId) as
        | {
            prompt_id: string;
            binding_id: string;
            binding_generation: number;
            request_text: string;
            view_version: number;
            answer_page_index: number;
            answer_page_start: number;
            answer_element_id: string;
            answer_message_id: string | null;
          }
        | undefined;
      if (!row || Number(row.binding_generation) !== input.expectedGeneration) {
        return null;
      }
      const page = this.context.database
        .prepare(`
          SELECT state FROM answer_pages
          WHERE prompt_id = ? AND page_index = (
            SELECT MAX(page_index) FROM answer_pages WHERE prompt_id = ?
          )
        `)
        .get(input.aggregateId, input.aggregateId) as { state: string } | undefined;
      return {
        aggregateKind: "primary-run",
        aggregateId: row.prompt_id,
        expectedGeneration: Number(row.binding_generation),
        requestText: row.request_text,
        bindingId: row.binding_id,
        viewVersion: Number(row.view_version),
        pageIndex: Number(row.answer_page_index),
        pageStart: Number(row.answer_page_start),
        elementId: row.answer_element_id,
        messageId: row.answer_message_id,
        state: normalizePageState(page?.state),
      };
    }
    const row = this.context.database
      .prepare(`
        SELECT turn_id, instance_generation, request_text, view_version, page_index, message_id
        FROM worker_turn_cards
        WHERE turn_id = ?
      `)
      .get(input.aggregateId) as
      | {
          turn_id: string;
          instance_generation: number;
          request_text: string;
          view_version: number;
          page_index: number;
          message_id: string | null;
        }
      | undefined;
    if (!row || Number(row.instance_generation) !== input.expectedGeneration) {
      return null;
    }
    const page = this.context.database
      .prepare(`
        SELECT state FROM worker_turn_card_pages
        WHERE turn_id = ? AND page_index = (
          SELECT MAX(page_index) FROM worker_turn_card_pages WHERE turn_id = ?
        )
      `)
      .get(input.aggregateId, input.aggregateId) as { state: string } | undefined;
    return {
      aggregateKind: "worker-turn",
      aggregateId: row.turn_id,
      expectedGeneration: Number(row.instance_generation),
      requestText: row.request_text,
      viewVersion: Number(row.view_version),
      pageIndex: Number(row.page_index),
      messageId: row.message_id,
      state: normalizePageState(page?.state),
    };
  }

  private freezeCurrentPageIfNeeded(
    aggregate: AggregateState,
    pageIndex: number,
    timestamp: string,
  ): void {
    if (aggregate.state !== "active") return;
    if (aggregate.aggregateKind === "primary-run") {
      this.context.database
        .prepare(`
          UPDATE answer_pages
          SET state = 'frozen', updated_at = ?
          WHERE prompt_id = ? AND page_index = ? AND state = 'active'
        `)
        .run(timestamp, aggregate.aggregateId, pageIndex);
      return;
    }
    this.context.database
      .prepare(`
        UPDATE worker_turn_card_pages
        SET state = 'frozen', updated_at = ?
        WHERE turn_id = ? AND page_index = ? AND state = 'active'
      `)
      .run(timestamp, aggregate.aggregateId, pageIndex);
  }

  private insertPageRow(
    aggregateKind: AggregateKind,
    aggregateId: string,
    pageIndex: number,
    segmentIndex: number,
    pageStart: number,
    timestamp: string,
  ): void {
    if (aggregateKind === "primary-run") {
      this.context.database
        .prepare(`
          INSERT INTO answer_pages(
            prompt_id, page_index, segment_index, message_id, card_id, element_id,
            source_start, sequence, state, delivery_mode, created_at, updated_at
          ) VALUES (?, ?, ?, NULL, NULL, ?, ?, 0, 'creating', 'streaming', ?, ?)
        `)
        .run(
          aggregateId,
          pageIndex,
          segmentIndex,
          elementIdFor(aggregateKind, aggregateId, pageIndex),
          pageStart,
          timestamp,
          timestamp,
        );
      return;
    }
    this.context.database
      .prepare(`
        INSERT INTO worker_turn_card_pages(
          id, turn_id, page_index, segment_index, page_start, element_id,
          message_id, card_id, delivery_mode, state, sequence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'streaming', 'creating', 0, ?, ?)
      `)
      .run(
        `${aggregateId}:${pageIndex}`,
        aggregateId,
        pageIndex,
        segmentIndex,
        pageStart,
        elementIdFor(aggregateKind, aggregateId, pageIndex),
        timestamp,
        timestamp,
      );
  }

  private maxPageIndex(
    aggregateKind: AggregateKind,
    aggregateId: string,
  ): number {
    if (aggregateKind === "primary-run") {
      const row = this.context.database
        .prepare(
          "SELECT COALESCE(MAX(page_index), 0) AS page_index FROM answer_pages WHERE prompt_id = ?",
        )
        .get(aggregateId) as { page_index: number };
      return Number(row.page_index);
    }
    const row = this.context.database
      .prepare(
        "SELECT COALESCE(MAX(page_index), 0) AS page_index FROM worker_turn_card_pages WHERE turn_id = ?",
      )
      .get(aggregateId) as { page_index: number };
    return Number(row.page_index);
  }
}

function createCardKey(
  aggregateKind: AggregateKind,
  aggregateId: string,
  pageIndex: number,
): string {
  return aggregateKind === "primary-run"
    ? `answer-segment:create:${aggregateId}:${pageIndex}`
    : `worker-answer-segment:create:${aggregateId}:${pageIndex}`;
}

function finalFoldKey(
  aggregateKind: AggregateKind,
  aggregateId: string,
  pageIndex: number,
  messageId: string,
): string {
  return aggregateKind === "primary-run"
    ? `answer-final-fold:${aggregateId}:${pageIndex}:${messageId}`
    : `worker-answer-segment:close:${aggregateId}:${pageIndex}:${messageId}`;
}

function elementIdFor(
  aggregateKind: AggregateKind,
  aggregateId: string,
  pageIndex: number,
): string {
  return aggregateKind === "primary-run"
    ? answerElementId(aggregateId, pageIndex)
    : workerTurnElementId(aggregateId, pageIndex);
}

function mapAnswerSegment(row: Record<string, unknown>): AnswerSegment {
  return {
    aggregateKind: String(row.aggregate_kind) as AggregateKind,
    aggregateId: String(row.aggregate_id),
    segmentIndex: Number(row.segment_index),
    sourceHumanItemId:
      row.source_human_item_id === null
        ? null
        : String(row.source_human_item_id),
    requestText: String(row.request_text),
    startAfterSequence: Number(row.start_after_sequence),
    endBeforeSequence:
      row.end_before_sequence === null
        ? null
        : Number(row.end_before_sequence),
    endBeforeItemId:
      row.end_before_item_id === null ? null : String(row.end_before_item_id),
    state: String(row.state) as AnswerSegment["state"],
  };
}

function normalizePageState(
  value: unknown,
): "creating" | "active" | "frozen" | "finished" {
  if (
    value === "creating" ||
    value === "active" ||
    value === "frozen" ||
    value === "finished"
  ) {
    return value;
  }
  return "creating";
}

function now(): string {
  return new Date().toISOString();
}
