import type { AnswerPage } from "../../domain/types.js";
import type { MainCardLiveStatus, RunCardView } from "../../domain/run-card-view.js";
import { initialTopicView, type TopicViewState } from "../../domain/topic-view.js";
import { mapAnswerPage, type AnswerPageRow } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

export class SqliteProjectionStore {
  constructor(private readonly context: SqliteContext) {}

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

  listAnswerPages(promptId: string): AnswerPage[] {
    return (this.context.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? ORDER BY page_index").all(promptId) as AnswerPageRow[]).map(mapAnswerPage);
  }

  insertRunCard(view: RunCardView): void {
    this.context.database.prepare(`INSERT INTO run_cards(prompt_id, binding_id, binding_generation, conversion_parent_prompt_id, steering_origin, steering_failure_kind, queue_feedback_json, lark_message_id, answer_message_id, answer_card_id, answer_element_id, answer_sequence, answer_page_index, answer_page_start, phase, title, session_title, request_text, workspace_id, space_name, pane_id, answer, answer_segments_json, answer_draft, answer_draft_transient, progress_events_json, progress_summary_json, queue_position, started_at, finished_at, notice, worker_activity_json, worker_dependency_revision, worker_context_frozen_at, activity_at, view_version, delivered_version, answer_delivered_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(view.promptId, view.bindingId, view.bindingGeneration, view.conversionParentPromptId, view.steeringOrigin, view.steeringFailureKind, view.queueFeedback === null ? null : JSON.stringify(view.queueFeedback), view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.sessionTitle ?? null, view.requestText, view.workspaceId, view.spaceName, view.paneId, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), JSON.stringify(view.progressSummary), view.queuePosition, view.startedAt, view.finishedAt, view.notice, JSON.stringify(view.workerActivity), view.workerDependencyRevision, view.workerContextFrozenAt, view.activityAt, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.createdAt, view.updatedAt);
    this.context.database.prepare("INSERT OR IGNORE INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'streaming', ?, ?)")
      .run(view.promptId, view.answerPageIndex, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerPageStart, view.answerSequence, view.answerCardId ? "active" : "creating", view.createdAt, view.updatedAt);
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
