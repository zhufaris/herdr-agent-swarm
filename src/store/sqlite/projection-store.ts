import { randomUUID } from "node:crypto";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, OutboundReplyState } from "../../domain/types.js";
import type { MainCardLiveStatus, RunCardView } from "../../domain/run-card-view.js";
import { initialTopicView, type TopicViewState } from "../../domain/topic-view.js";
import { mapAnswerPage, type AnswerPageRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

export class SqliteProjectionStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): unknown;
      hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean;
    }
  ) {}

  saveTopicView(view: TopicViewState): void {
    const current = this.loadTopicView(view.bindingId);
    if (current && current.viewVersion > view.viewVersion) return;
    const persisted = { ...view, deliveredVersion: Math.max(view.deliveredVersion, current?.deliveredVersion ?? 0) };
    this.context.database.prepare(`
      INSERT INTO topic_views(binding_id, state_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(view.bindingId, JSON.stringify(persisted), now());
  }

  loadTopicView(bindingId: string): TopicViewState | null {
    const row = this.context.database.prepare("SELECT state_json FROM topic_views WHERE binding_id = ?").get(bindingId) as { state_json: string } | undefined;
    if (!row) return null;
    const stored = JSON.parse(row.state_json) as Partial<TopicViewState>;
    const view = { ...initialTopicView(bindingId), ...stored, bindingId };
    return {
      ...view,
      recentProgress: Array.isArray(view.recentProgress) ? view.recentProgress : [],
      liveStatus: normalizeLiveStatus(view.liveStatus),
      viewVersion: Number.isInteger(stored.viewVersion) ? stored.viewVersion! : 1,
      deliveredVersion: Number.isInteger(stored.deliveredVersion) ? stored.deliveredVersion! : 0
    };
  }

  saveRunCard(view: RunCardView): RunCardView {
    return this.context.transaction(() => {
      this.context.database.prepare(`UPDATE run_cards SET binding_generation = ?, conversion_parent_prompt_id = ?, steering_origin = ?, steering_failure_kind = ?, queue_feedback_json = ?, lark_message_id = ?, answer_message_id = ?, answer_card_id = ?, answer_element_id = ?, answer_sequence = ?, answer_page_index = ?, answer_page_start = ?, phase = ?, title = ?, session_title = ?, request_text = ?, workspace_id = ?, space_name = ?, pane_id = ?, answer = ?, answer_segments_json = ?, answer_draft = ?, answer_draft_transient = ?, progress_events_json = ?, progress_summary_json = ?, queue_position = ?, started_at = ?, finished_at = ?, notice = ?, worker_activity_json = ?, worker_dependency_revision = ?, worker_context_frozen_at = ?, activity_at = ?, view_version = ?, delivered_version = ?, answer_delivered_version = ?, updated_at = ? WHERE prompt_id = ?`)
        .run(view.bindingGeneration, view.conversionParentPromptId, view.steeringOrigin, view.steeringFailureKind, view.queueFeedback === null ? null : JSON.stringify(view.queueFeedback), view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.sessionTitle ?? null, view.requestText, view.workspaceId, view.spaceName, view.paneId, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), JSON.stringify(view.progressSummary), view.queuePosition, view.startedAt, view.finishedAt, view.notice, JSON.stringify(view.workerActivity), view.workerDependencyRevision, view.workerContextFrozenAt, view.activityAt, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.updatedAt, view.promptId);
      return this.loadRunCard(view.promptId)!;
    });
  }

  loadRunCard(promptId: string): RunCardView | null {
    const row = this.context.database.prepare("SELECT state_json FROM run_cards_view WHERE prompt_id = ?").get(promptId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as RunCardView : null;
  }

  listRunCards(bindingId: string): RunCardView[] {
    return (this.context.database.prepare("SELECT state_json FROM run_cards_view WHERE binding_id = ? ORDER BY created_at, prompt_id").all(bindingId) as Array<{ state_json: string }>).map((row) => JSON.parse(row.state_json) as RunCardView);
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
    return rows.map((row) => JSON.parse(row.state_json) as RunCardView);
  }

  getActiveAnswerPage(promptId: string): AnswerPage | null {
    const row = this.context.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? AND state = 'active' ORDER BY page_index DESC LIMIT 1").get(promptId) as AnswerPageRow | undefined;
    return row ? mapAnswerPage(row) : null;
  }

  getAnswerPageDeliveryFacts(promptId: string, pageIndex: number): AnswerPageDeliveryFacts {
    const page = this.context.database.prepare("SELECT card_id, element_id FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(promptId, pageIndex) as { card_id: string | null; element_id: string } | undefined;
    if (!page) return { latestContent: null, finishPending: false, continuationPending: false, finalUpdateState: null };
    const rows = this.context.database.prepare("SELECT idempotency_key, kind, payload, state, view_version FROM outbound_replies WHERE prompt_id = ? AND card_role = 'answer' AND state IN ('pending','delivered','dead_letter','dismissed') ORDER BY delivery_order DESC").all(promptId) as Array<{ idempotency_key: string; kind: string; payload: string; state: OutboundReplyState; view_version: number | null }>;
    let latestContent: AnswerPageDeliveryFacts["latestContent"] = null;
    let finishPending = false;
    let continuationPending = false;
    let finalUpdateState: AnswerPageDeliveryFacts["finalUpdateState"] = null;
    for (const row of rows) {
      const payload = parseJsonRecord(row.payload);
      if (row.kind === "stream_card_create" && row.state === "pending" && Number((payload.stream as Record<string, unknown> | undefined)?.pageIndex) === pageIndex + 1) continuationPending = true;
      if (row.kind === "card_update" && row.idempotency_key === `answer-final-fold:${promptId}:${pageIndex}:${page.card_id}` && finalUpdateState === null && row.state !== "delivered") finalUpdateState = row.state;
      if (Number(payload.pageIndex ?? pageIndex) !== pageIndex) continue;
      if (row.kind === "stream_finish" && row.state === "pending") finishPending = true;
      if (row.kind === "stream_content" && latestContent === null && (payload.elementId === page.element_id || payload.pageIndex === pageIndex)) latestContent = { content: typeof payload.content === "string" ? payload.content : "", sequence: Number(payload.sequence ?? row.view_version ?? 0), state: row.state, sourceEnd: Number.isInteger(payload.sourceEnd) ? Number(payload.sourceEnd) : null };
    }
    return { latestContent, finishPending, continuationPending, finalUpdateState };
  }

  reserveAnswerContent(input: { promptId: string; pageIndex: number; cardId: string; elementId: string; content: string }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || page.cardId !== input.cardId || page.elementId !== input.elementId) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.latestContent?.state === "pending" || facts.latestContent?.content === input.content) return "waiting";
      const sequence = page.sequence + 1;
      this.context.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND sequence = ?").run(sequence, now(), input.promptId, input.pageIndex, page.sequence);
      this.context.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?").run(sequence, now(), input.promptId, input.pageIndex);
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: sequence, cardRole: "answer", rootMessageId: input.cardId, kind: "stream_content", payload: JSON.stringify({ pageIndex: input.pageIndex, elementId: input.elementId, content: input.content, sequence }) });
      return "reserved";
    });
  }

  reserveAnswerFinish(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || page.cardId !== input.cardId || page.messageId !== input.messageId) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.finishPending || page.state === "finished") return "waiting";
      const sequence = page.sequence + 1;
      this.context.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND sequence = ?").run(sequence, now(), input.promptId, input.pageIndex, page.sequence);
      this.context.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?").run(sequence, now(), input.promptId, input.pageIndex);
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-finish:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: sequence, cardRole: "answer", rootMessageId: input.cardId, kind: "stream_finish", payload: JSON.stringify({ pageIndex: input.pageIndex, summary: input.summary, sequence }) });
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `answer-final-fold:${input.promptId}:${input.pageIndex}:${input.cardId}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: view.viewVersion, cardRole: "answer", rootMessageId: input.messageId, kind: "card_update", payload: JSON.stringify(input.finalizedCard), laneKeyOverride: `answer:${input.promptId}` });
      return "reserved";
    });
  }

  reserveAnswerContinuation(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || page.cardId !== input.cardId || page.messageId !== input.messageId || input.nextPageIndex !== input.pageIndex + 1 || input.nextPageStart <= page.sourceStart) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if ((facts.latestContent && facts.latestContent.state !== "delivered") || facts.finishPending || facts.continuationPending) return "waiting";
      const sequence = page.sequence + 1;
      this.context.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND sequence = ?").run(sequence, now(), input.promptId, input.pageIndex, page.sequence);
      this.context.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?").run(sequence, now(), input.promptId, input.pageIndex);
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-finish:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: sequence, cardRole: "answer", rootMessageId: input.cardId, kind: "stream_finish", payload: JSON.stringify({ pageIndex: input.pageIndex, summary: input.summary, sequence }) });
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `answer-final-fold:${input.promptId}:${input.pageIndex}:${input.cardId}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: view.viewVersion, cardRole: "answer", rootMessageId: input.messageId, kind: "card_update", payload: JSON.stringify(input.finalizedCard), laneKeyOverride: `answer:${input.promptId}` });
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-card:${input.promptId}:${input.nextPageIndex}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: input.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.nextPageStart, elementId: input.nextElementId } }) });
      return "reserved";
    });
  }

  reserveAnswerRebuild(input: { promptId: string; pageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || input.nextPageIndex !== input.pageIndex + 1 || input.sourceStart !== page.sourceStart) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.latestContent && facts.latestContent.state !== "delivered") return "waiting";
      if (this.dependencies.hasPendingAnswerContinuation(input.promptId, input.nextPageIndex)) return "waiting";
      const timestamp = now();
      this.context.database.prepare("UPDATE answer_pages SET state = 'frozen', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active'").run(timestamp, input.promptId, input.pageIndex);
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-rebuild:${input.promptId}:${input.nextPageIndex}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: input.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.sourceStart, elementId: input.nextElementId } }) });
      return "reserved";
    });
  }

  listAnswerPages(promptId: string): AnswerPage[] {
    return (this.context.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? ORDER BY page_index").all(promptId) as AnswerPageRow[]).map(mapAnswerPage);
  }

  insertRunCard(view: RunCardView): void {
    this.context.database.prepare(`INSERT INTO run_cards(prompt_id, binding_id, binding_generation, conversion_parent_prompt_id, steering_origin, steering_failure_kind, queue_feedback_json, lark_message_id, answer_message_id, answer_card_id, answer_element_id, answer_sequence, answer_page_index, answer_page_start, phase, title, session_title, request_text, workspace_id, space_name, pane_id, answer, answer_segments_json, answer_draft, answer_draft_transient, progress_events_json, progress_summary_json, queue_position, started_at, finished_at, notice, worker_activity_json, worker_dependency_revision, worker_context_frozen_at, activity_at, view_version, delivered_version, answer_delivered_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(view.promptId, view.bindingId, view.bindingGeneration, view.conversionParentPromptId, view.steeringOrigin, view.steeringFailureKind, view.queueFeedback === null ? null : JSON.stringify(view.queueFeedback), view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.sessionTitle ?? null, view.requestText, view.workspaceId, view.spaceName, view.paneId, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), JSON.stringify(view.progressSummary), view.queuePosition, view.startedAt, view.finishedAt, view.notice, JSON.stringify(view.workerActivity), view.workerDependencyRevision, view.workerContextFrozenAt, view.activityAt, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.createdAt, view.updatedAt);
    this.context.database.prepare("INSERT OR IGNORE INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'streaming', ?, ?)")
      .run(view.promptId, view.answerPageIndex, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerPageStart, view.answerSequence, view.answerCardId ? "active" : "creating", view.createdAt, view.updatedAt);
  }

  private reserveAnswerPageIntent(promptId: string, pageIndex: number, reserve: (page: AnswerPage, view: RunCardView) => AnswerPageReservationOutcome): AnswerPageReservationOutcome {
    return this.context.transaction(() => {
      const pageRow = this.context.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? AND page_index = ? AND state = 'active'").get(promptId, pageIndex) as AnswerPageRow | undefined;
      const view = this.loadRunCard(promptId);
      return pageRow && view ? reserve(mapAnswerPage(pageRow), view) : "stale";
    });
  }
}

function now(): string { return new Date().toISOString(); }

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
