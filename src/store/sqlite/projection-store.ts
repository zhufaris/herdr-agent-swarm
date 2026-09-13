import { randomUUID } from "node:crypto";
import type { OutboxStore } from "../../domain/ports/outbox.js";
import type { AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, Binding, MainCardReservationOutcome, OutboundReplyState, OutboundWorkClass } from "../../domain/types.js";
import type { MainCardLiveStatus, RunCardView } from "../../domain/run-card-view.js";
import { initialTopicView, type TopicViewState } from "../../domain/topic-view.js";
import type { ModelPreference } from "../../domain/model-selection.js";
import { mapAnswerPage, type AnswerPageRow } from "../sqlite-records.js";
import { outboundLaneKey } from "../outbox-lanes.js";
import type { SqliteContext } from "./context.js";
import { linkAnswerRecovery, recordAnswerCoverage } from "./delivery-recovery-evidence.js";

export class SqliteProjectionStore {
  constructor(
    private readonly context: SqliteContext,
    private readonly dependencies: {
      enqueueOutboundReply(input: Parameters<OutboxStore["enqueueOutboundReply"]>[0] & { laneKeyOverride?: string }): unknown;
      hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean;
      getBinding(id: string): Binding | null;
      getModelPreference(bindingId: string): ModelPreference | null;
      refreshOutboxLaneHead(laneKey: string): void;
    }
  ) {}

  getBinding(id: string): Binding | null { return this.dependencies.getBinding(id); }
  getModelPreference(bindingId: string): ModelPreference | null { return this.dependencies.getModelPreference(bindingId); }

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

  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object, workClass?: OutboundWorkClass, paneEntryCard?: object): MainCardReservationOutcome {
    return this.context.transaction(() => {
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
        this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `status-card:${view.bindingId}`, bindingId: view.bindingId, viewVersion: current.viewVersion, targetRole: "session_status", ...outboundWorkClass(workClass), rootMessageId, kind: "card_reply", payload: JSON.stringify(card) });
        reserved = true;
      } else {
        this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `main-card:update:${view.bindingId}:${current.viewVersion}`, bindingId: view.bindingId, viewVersion: current.viewVersion, cardSequence: this.nextMainCardSequence(binding), targetRole: "session_status", ...outboundWorkClass(workClass), rootMessageId: binding.statusMessageId, kind: "card_update", payload: JSON.stringify(card) });
        reserved = true;
      }
    }
    for (const alias of paneEntryCard ? this.listActivePaneEntryTargets(binding) : []) {
      const idempotencyKey = `pane-entry:update:${alias.id}:${current.viewVersion}`;
      const existing = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key = ?").get(idempotencyKey);
      if (existing) { waiting = true; continue; }
      const createAtCurrentVersion = this.context.database.prepare("SELECT 1 FROM outbound_replies WHERE thread_alias_id = ? AND kind = 'group_card_create' AND view_version >= ? LIMIT 1").get(alias.id, current.viewVersion);
      if (createAtCurrentVersion) continue;
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey, bindingId: binding.id, viewVersion: current.viewVersion, ...outboundWorkClass(workClass), rootMessageId: alias.rootMessageId, kind: "card_update", payload: JSON.stringify(paneEntryCard), laneKeyOverride: `pane-entry:${alias.id}` });
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
    return this.context.transaction(() => {
      this.context.database.prepare(`UPDATE run_cards SET binding_generation = ?, conversion_parent_prompt_id = ?, queue_feedback_json = ?, lark_message_id = ?, answer_message_id = ?, answer_card_id = ?, answer_element_id = ?, answer_sequence = ?, answer_page_index = ?, answer_page_start = ?, phase = ?, title = ?, session_title = ?, request_text = ?, workspace_id = ?, space_name = ?, pane_id = ?, answer = ?, answer_segments_json = ?, answer_draft = ?, answer_draft_transient = ?, progress_events_json = ?, progress_summary_json = ?, queue_position = ?, started_at = ?, finished_at = ?, notice = ?, worker_activity_json = ?, worker_dependency_revision = ?, worker_context_frozen_at = ?, activity_at = ?, view_version = ?, delivered_version = ?, answer_delivered_version = ?, updated_at = ? WHERE prompt_id = ?`)
        .run(view.bindingGeneration, view.conversionParentPromptId, view.queueFeedback === null ? null : JSON.stringify(view.queueFeedback), view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.sessionTitle ?? null, view.requestText, view.workspaceId, view.spaceName, view.paneId, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), JSON.stringify(view.progressSummary), view.queuePosition, view.startedAt, view.finishedAt, view.notice, JSON.stringify(view.workerActivity), view.workerDependencyRevision, view.workerContextFrozenAt, view.activityAt, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.updatedAt, view.promptId);
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

  listActionableStartupRunCards(bindingId: string): RunCardView[] {
    const rows = this.context.database.prepare(`
      SELECT view.state_json
      FROM run_cards AS card
      JOIN run_cards_view AS view ON view.prompt_id = card.prompt_id
      WHERE card.binding_id = ? AND (
        card.phase IN ('queued','running','blocked')
        OR card.answer_message_id IS NULL
        OR EXISTS (
          SELECT 1 FROM answer_pages page
          WHERE page.prompt_id = card.prompt_id
            AND (page.state = 'creating' OR (page.state = 'active' AND page.delivery_mode = 'streaming'))
        )
        OR (card.view_version > card.answer_delivered_version AND EXISTS (
          SELECT 1 FROM answer_pages page
          WHERE page.prompt_id = card.prompt_id AND page.state = 'active'
        ))
        OR EXISTS (
          SELECT 1 FROM outbound_replies pending
          WHERE pending.prompt_id = card.prompt_id AND pending.state = 'pending'
        )
        OR (card.answer_card_id IS NULL AND card.answer_message_id IS NOT NULL AND card.view_version > card.answer_delivered_version)
        OR EXISTS (
          SELECT 1 FROM delivery_recoveries recovery
          JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id
          WHERE failed.prompt_id = card.prompt_id AND (
            recovery.state = 'replacement_pending'
            OR EXISTS (
              SELECT 1 FROM outbox_lane_quarantines quarantine
              WHERE quarantine.failed_reply_id = recovery.failed_reply_id AND quarantine.state = 'active'
            )
          )
        )
      )
      ORDER BY card.created_at, card.prompt_id
    `).all(bindingId) as Array<{ state_json: string }>;
    return rows.map((row) => JSON.parse(row.state_json) as RunCardView);
  }

  loadStartupMainRunCard(bindingId: string, preferredPromptId: string | null): RunCardView | null {
    const row = this.context.database.prepare(`
      SELECT view.state_json
      FROM run_cards AS card
      JOIN run_cards_view AS view ON view.prompt_id = card.prompt_id
      WHERE card.binding_id = ?
      ORDER BY
        CASE
          WHEN card.prompt_id = ? AND card.phase IN ('running','blocked') THEN 0
          WHEN card.phase IN ('running','blocked') THEN 1
          ELSE 2
        END,
        CASE WHEN card.phase IN ('running','blocked') THEN card.created_at END ASC,
        CASE WHEN card.phase NOT IN ('running','blocked') THEN card.created_at END DESC,
        CASE WHEN card.phase IN ('running','blocked') THEN card.prompt_id END ASC,
        CASE WHEN card.phase NOT IN ('running','blocked') THEN card.prompt_id END DESC
      LIMIT 1
    `).get(bindingId, preferredPromptId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as RunCardView : null;
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
      if (row.kind === "card_update" && (row.idempotency_key === `answer-final-fold:${promptId}:${pageIndex}:${page.card_id}` || row.idempotency_key.startsWith(`answer-final-fold:${promptId}:${pageIndex}:${page.card_id}:revision:`)) && finalUpdateState === null) finalUpdateState = row.state;
      if (Number(payload.pageIndex ?? pageIndex) !== pageIndex) continue;
      if (row.kind === "stream_finish" && row.state === "pending") finishPending = true;
      if (row.kind === "stream_content" && latestContent === null && (payload.elementId === page.element_id || payload.pageIndex === pageIndex)) latestContent = { content: typeof payload.content === "string" ? payload.content : "", sequence: Number(payload.sequence ?? row.view_version ?? 0), state: row.state, sourceEnd: Number.isInteger(payload.sourceEnd) ? Number(payload.sourceEnd) : null };
    }
    return { latestContent, finishPending, continuationPending, finalUpdateState };
  }

  reserveAnswerContent(input: { promptId: string; pageIndex: number; cardId: string; elementId: string; content: string; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || page.cardId !== input.cardId || page.elementId !== input.elementId) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.latestContent?.state === "pending" || facts.latestContent?.content === input.content) return "waiting";
      const sequence = page.sequence + 1;
      this.context.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND sequence = ?").run(sequence, now(), input.promptId, input.pageIndex, page.sequence);
      this.context.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?").run(sequence, now(), input.promptId, input.pageIndex);
      const id = randomUUID();
      this.dependencies.enqueueOutboundReply({ id, idempotencyKey: `stream:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: sequence, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.cardId, kind: "stream_content", payload: JSON.stringify({ pageIndex: input.pageIndex, elementId: input.elementId, content: input.content, sequence }) });
      if (input.source !== undefined) recordAnswerCoverage(this.context, { replyId: id, promptId: input.promptId, bindingGeneration: view.bindingGeneration, pageIndex: input.pageIndex, sourceStart: page.sourceStart, source: input.source });
      return "reserved";
    });
  }

  reserveAnswerFinish(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || page.cardId !== input.cardId || page.messageId !== input.messageId) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.finishPending || page.state === "finished") return "waiting";
      const sequence = page.sequence + 1;
      this.context.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND sequence = ?").run(sequence, now(), input.promptId, input.pageIndex, page.sequence);
      this.context.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?").run(sequence, now(), input.promptId, input.pageIndex);
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-finish:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: sequence, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.cardId, kind: "stream_finish", payload: JSON.stringify({ pageIndex: input.pageIndex, summary: input.summary, sequence }) });
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `answer-final-fold:${input.promptId}:${input.pageIndex}:${input.cardId}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: view.viewVersion, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.messageId, kind: "card_update", payload: JSON.stringify(input.finalizedCard), laneKeyOverride: `answer:${input.promptId}` });
      return "reserved";
    });
  }

  reserveAnswerContinuation(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.deliveryMode !== "streaming" || page.cardId !== input.cardId || page.messageId !== input.messageId || input.nextPageIndex !== input.pageIndex + 1 || input.nextPageStart <= page.sourceStart) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if ((facts.latestContent && facts.latestContent.state !== "delivered") || facts.finishPending || facts.continuationPending) return "waiting";
      const sequence = page.sequence + 1;
      this.context.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND sequence = ?").run(sequence, now(), input.promptId, input.pageIndex, page.sequence);
      this.context.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?").run(sequence, now(), input.promptId, input.pageIndex);
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-finish:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: sequence, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.cardId, kind: "stream_finish", payload: JSON.stringify({ pageIndex: input.pageIndex, summary: input.summary, sequence }) });
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `answer-final-fold:${input.promptId}:${input.pageIndex}:${input.cardId}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: view.viewVersion, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.messageId, kind: "card_update", payload: JSON.stringify(input.finalizedCard), laneKeyOverride: `answer:${input.promptId}` });
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-card:${input.promptId}:${input.nextPageIndex}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: input.viewVersion, cardRole: "answer", ...outboundWorkClass(input.workClass), rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.nextPageStart, elementId: input.nextElementId } }) });
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
      this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-rebuild:${input.promptId}:${input.nextPageIndex}`, workClass: input.workClass ?? "history", bindingId: view.bindingId, promptId: input.promptId, viewVersion: input.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.sourceStart, elementId: input.nextElementId } }) });
      return "reserved";
    });
  }

  reserveFinalAnswerCardUpdate(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.context.transaction(() => {
      const page = this.context.database.prepare("SELECT state, card_id, message_id FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.pageIndex) as { state: string; card_id: string | null; message_id: string | null } | undefined;
      const view = this.loadRunCard(input.promptId);
      if (!page || !view || !["active", "frozen", "finished"].includes(page.state) || page.card_id !== input.cardId || page.message_id !== input.messageId) return "stale";
      const key = `answer-final-fold:${input.promptId}:${input.pageIndex}:${input.cardId}`;
      if (page.state === "frozen") return "waiting";
      return this.reserveAnswerSnapshot(key, view, input.messageId, input.card, input.workClass);
    });
  }

  reserveClosedAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.context.transaction(() => {
      const page = this.context.database.prepare("SELECT state, message_id FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.pageIndex) as { state: string; message_id: string | null } | undefined;
      const view = this.loadRunCard(input.promptId);
      if (!page || !view || page.state !== "finished" || page.message_id !== input.messageId) return "stale";
      const key = `answer-closed:${input.promptId}:${input.pageIndex}:${input.messageId}`;
      return this.reserveAnswerSnapshot(key, view, input.messageId, input.card, input.workClass);
    });
  }

  reserveStaticAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; source?: string; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.context.transaction(() => {
      const page = this.context.database.prepare("SELECT state, message_id, delivery_mode, source_start FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.pageIndex) as { state: string; message_id: string | null; delivery_mode: string; source_start: number } | undefined;
      const view = this.loadRunCard(input.promptId);
      if (!page || !view || page.state !== "active" || page.delivery_mode !== "static" || page.message_id !== input.messageId) return "stale";
      const key = `answer-static:${input.promptId}:${input.pageIndex}:${input.messageId}`;
      const outcome = this.reserveAnswerSnapshot(key, view, input.messageId, input.card, input.workClass);
      if (outcome === "reserved" && input.source !== undefined) {
        const reply = this.context.database.prepare("SELECT id FROM outbound_replies WHERE projection_key = ? ORDER BY snapshot_revision DESC LIMIT 1").get(key) as { id: string };
        recordAnswerCoverage(this.context, { replyId: reply.id, promptId: input.promptId, bindingGeneration: view.bindingGeneration, pageIndex: input.pageIndex, sourceStart: Number(page.source_start), source: input.source });
      }
      return outcome;
    });
  }

  private reserveAnswerSnapshot(key: string, view: RunCardView, messageId: string, card: object, workClass?: OutboundWorkClass): AnswerPageReservationOutcome {
    const payload = JSON.stringify(card);
    const expired = this.context.database.prepare(`SELECT 1 FROM delivery_recoveries recovery JOIN outbound_replies failed ON failed.id = recovery.failed_reply_id WHERE failed.projection_key = ? AND recovery.action = 'expired_view_target' AND recovery.state = 'dismissed' LIMIT 1`).get(key);
    if (expired) return "waiting";
    const existing = this.context.database.prepare("SELECT id, payload, snapshot_revision FROM outbound_replies WHERE projection_key = ? OR idempotency_key = ? ORDER BY snapshot_revision DESC LIMIT 1").get(key, key) as { id: string; payload: string; snapshot_revision: number } | undefined;
    if (existing?.payload === payload) return "waiting";
    if (existing) this.context.database.prepare("UPDATE outbound_replies SET projection_key = ? WHERE id = ?").run(key, existing.id);
    const revision = (existing?.snapshot_revision ?? 0) + 1;
    const id = randomUUID();
    this.dependencies.enqueueOutboundReply({ id, idempotencyKey: revision === 1 ? key : `${key}:revision:${revision}`, bindingId: view.bindingId, promptId: view.promptId, viewVersion: view.viewVersion, cardRole: "answer", ...outboundWorkClass(workClass), rootMessageId: messageId, kind: "card_update", payload });
    this.context.database.prepare("UPDATE outbound_replies SET projection_key = ?, snapshot_revision = ? WHERE id = ?").run(key, revision, id);
    return "reserved";
  }

  reserveStaticAnswerReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; workClass?: OutboundWorkClass | undefined }): AnswerPageReservationOutcome {
    return this.context.transaction(() => {
      const previous = this.context.database.prepare("SELECT state, delivery_mode, source_start FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.previousPageIndex) as { state: string; delivery_mode: string; source_start: number } | undefined;
      const view = this.loadRunCard(input.promptId);
      if (!previous || !view || previous.state !== "frozen" || previous.delivery_mode !== "static" || input.nextPageIndex !== input.previousPageIndex + 1 || input.sourceStart !== Number(previous.source_start)) return "stale";
      const existing = this.context.database.prepare("SELECT state, element_id, source_start, delivery_mode FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(input.promptId, input.nextPageIndex) as { state: string; element_id: string; source_start: number; delivery_mode: string } | undefined;
      const idempotencyKey = `answer-static-rebuild:${input.promptId}:${input.nextPageIndex}`;
      const payload = JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.sourceStart, elementId: input.nextElementId, deliveryMode: "static" } });
      if (existing) {
        if (existing.state !== "creating" || existing.element_id !== input.nextElementId || Number(existing.source_start) !== input.sourceStart || existing.delivery_mode !== "static") return "stale";
        return "waiting";
      }
      const replacement = this.dependencies.enqueueOutboundReply({ id: randomUUID(), idempotencyKey, workClass: input.workClass ?? "history", bindingId: view.bindingId, promptId: input.promptId, viewVersion: input.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload }) as { id: string; laneKey: string };
      linkAnswerRecovery(this.context, input.promptId, view.bindingGeneration, input.previousPageIndex, input.nextPageIndex, replacement.id);
      this.context.database.prepare("UPDATE answer_pages SET delivery_mode = 'static', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'creating'").run(now(), input.promptId, input.nextPageIndex);
      this.dependencies.refreshOutboxLaneHead(replacement.laneKey);
      return "reserved";
    });
  }

  listAnswerPages(promptId: string): AnswerPage[] {
    return (this.context.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? ORDER BY page_index").all(promptId) as AnswerPageRow[]).map(mapAnswerPage);
  }

  insertRunCard(view: RunCardView): void {
    this.context.database.prepare(`INSERT INTO run_cards(prompt_id, binding_id, binding_generation, conversion_parent_prompt_id, queue_feedback_json, lark_message_id, answer_message_id, answer_card_id, answer_element_id, answer_sequence, answer_page_index, answer_page_start, phase, title, session_title, request_text, workspace_id, space_name, pane_id, answer, answer_segments_json, answer_draft, answer_draft_transient, progress_events_json, progress_summary_json, queue_position, started_at, finished_at, notice, worker_activity_json, worker_dependency_revision, worker_context_frozen_at, activity_at, view_version, delivered_version, answer_delivered_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(view.promptId, view.bindingId, view.bindingGeneration, view.conversionParentPromptId, view.queueFeedback === null ? null : JSON.stringify(view.queueFeedback), view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.sessionTitle ?? null, view.requestText, view.workspaceId, view.spaceName, view.paneId, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), JSON.stringify(view.progressSummary), view.queuePosition, view.startedAt, view.finishedAt, view.notice, JSON.stringify(view.workerActivity), view.workerDependencyRevision, view.workerContextFrozenAt, view.activityAt, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.createdAt, view.updatedAt);
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

  private requireBinding(id: string): Binding {
    const binding = this.dependencies.getBinding(id);
    if (!binding) throw new Error(`Binding not found: ${id}`);
    return binding;
  }

  private nextMainCardSequence(binding: Binding): number {
    const row = this.context.database.prepare(`SELECT MAX(COALESCE(card_sequence, 0)) AS sequence FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND root_message_id = ? AND kind = 'card_update' AND state = 'pending'`).get(binding.id, binding.statusMessageId) as { sequence: number | null };
    return Math.max(binding.statusCardSequence, Number(row.sequence ?? 0)) + 1;
  }
}

function now(): string { return new Date().toISOString(); }

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
