import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BindingStorePort } from "../domain/ports.js";
import type { AgentState, Binding, BindingState, IncomingLarkMessage, OutboundReply, OutboundReplyKind, OutboundReplyState, PromptDispatchKind, PromptJob, PromptState } from "../domain/types.js";
import type { TopicViewState } from "../domain/topic-view.js";
import type { RunCardView } from "../domain/run-card-view.js";

type SqlValue = string | number | bigint | null;
type BindingRow = Record<string, SqlValue> & {
  id: string; workspace_id: string; chat_id: string; topic_id: string | null; root_message_id: string | null;
  pane_id: string | null; traex_session_id: string | null; title: string; runtime: string; state: string;
  status_message_id: string | null; last_agent_state: string; last_output_fingerprint: string | null;
  created_at: string; updated_at: string;
};
type PromptRow = Record<string, SqlValue> & {
  id: string; binding_id: string; lark_message_id: string; actor_open_id: string; body: string; state: string;
  dispatch_kind: string; parent_prompt_id: string | null;
  attempt_count: number; error: string | null; created_at: string; updated_at: string;
};
type OutboundReplyRow = Record<string, SqlValue> & {
  id: string; idempotency_key: string; binding_id: string | null; prompt_id: string | null; view_version: number | null; root_message_id: string; kind: string; payload: string; state: string;
  attempt_count: number; error: string | null; delivered_message_id: string | null; next_attempt_at: string; created_at: string; updated_at: string;
};

const BINDING_COLUMNS: Record<keyof Binding, string> = {
  id: "id", workspaceId: "workspace_id", chatId: "chat_id", topicId: "topic_id",
  rootMessageId: "root_message_id", paneId: "pane_id", traexSessionId: "traex_session_id",
  title: "title", runtime: "runtime", state: "state", statusMessageId: "status_message_id",
  lastAgentState: "last_agent_state", lastOutputFingerprint: "last_output_fingerprint",
  createdAt: "created_at", updatedAt: "updated_at"
};

export class SqliteBindingStore implements BindingStorePort {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void { this.database.close(); }

  recordInboundMessage(message: IncomingLarkMessage): boolean {
    const result = this.database.prepare(`
      INSERT INTO inbound_messages(event_id, message_id, payload_json, state, created_at, updated_at)
      VALUES (?, ?, ?, 'received', ?, ?) ON CONFLICT(event_id) DO NOTHING
    `).run(message.eventId, message.messageId, JSON.stringify(message), now(), now());
    return result.changes === 1;
  }

  claimNextInboundMessage(): IncomingLarkMessage | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT event_id, payload_json FROM inbound_messages WHERE state = 'received' ORDER BY created_at, event_id LIMIT 1").get() as { event_id: string; payload_json: string } | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      this.database.prepare("UPDATE inbound_messages SET state = 'processing', error = NULL, updated_at = ? WHERE event_id = ?").run(now(), row.event_id);
      this.database.exec("COMMIT");
      return JSON.parse(row.payload_json) as IncomingLarkMessage;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markInboundMessageAccepted(eventId: string): void {
    this.database.prepare("UPDATE inbound_messages SET state = 'accepted', error = NULL, updated_at = ? WHERE event_id = ?").run(now(), eventId);
  }

  releaseInboundMessage(eventId: string, error: string): void {
    this.database.prepare("UPDATE inbound_messages SET state = 'received', error = ?, updated_at = ? WHERE event_id = ?").run(error, now(), eventId);
  }

  recoverProcessingInboundMessages(): number {
    const result = this.database.prepare("UPDATE inbound_messages SET state = 'received', error = 'Interrupted during inbound acceptance; retrying', updated_at = ? WHERE state = 'processing'").run(now());
    return Number(result.changes);
  }

  isBridgeMessage(messageId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM bridge_messages WHERE message_id = ?").get(messageId));
  }

  recordBridgeMessage(messageId: string): void {
    this.database.prepare("INSERT OR IGNORE INTO bridge_messages(message_id, created_at) VALUES (?, ?)")
      .run(messageId, now());
  }

  createPendingBinding(input: { id: string; workspaceId: string; chatId: string; topicId: string | null; rootMessageId: string | null; title: string }): Binding {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO bindings(
        id, workspace_id, chat_id, topic_id, root_message_id, title, runtime, state, last_agent_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'traex', 'pending', 'unknown', ?, ?)
    `).run(input.id, input.workspaceId, input.chatId, input.topicId, input.rootMessageId, input.title, timestamp, timestamp);
    return this.getBinding(input.id);
  }

  updateBinding(id: string, patch: Partial<Binding>): Binding {
    const entries = Object.entries(patch).filter(([key]) => key !== "id" && key !== "createdAt");
    entries.push(["updatedAt", now()]);
    if (entries.length === 0) return this.getBinding(id);
    const assignments = entries.map(([key]) => `${BINDING_COLUMNS[key as keyof Binding]} = ?`).join(", ");
    const values = entries.map(([, value]) => value as SqlValue);
    const result = this.database.prepare(`UPDATE bindings SET ${assignments} WHERE id = ?`).run(...values, id);
    if (result.changes === 0) throw new Error(`Binding not found: ${id}`);
    return this.getBinding(id);
  }

  findBindingByTopic(topicId: string): Binding | null {
    const row = this.database.prepare("SELECT * FROM bindings WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1").get(topicId) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null {
    if (!topicId && !rootMessageId) return null;
    const row = this.database.prepare(`
      SELECT * FROM bindings
      WHERE (? IS NOT NULL AND topic_id = ?) OR (? IS NOT NULL AND root_message_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(topicId, topicId, rootMessageId, rootMessageId) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  findBindingByPane(paneId: string): Binding | null {
    const row = this.database.prepare("SELECT * FROM bindings WHERE pane_id = ? ORDER BY created_at DESC LIMIT 1").get(paneId) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  listBindings(): Binding[] {
    return (this.database.prepare("SELECT * FROM bindings ORDER BY created_at").all() as BindingRow[]).map(mapBinding);
  }

  countPendingPrompts(bindingId: string): number {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM prompt_jobs WHERE binding_id = ? AND state IN ('queued','running')"
    ).get(bindingId) as { count: number };
    return Number(row.count);
  }

  listQueuedTurnPromptIds(bindingId: string): string[] {
    return (this.database.prepare("SELECT id FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' AND dispatch_kind = 'turn' ORDER BY created_at, rowid").all(bindingId) as Array<{ id: string }>).map((row) => row.id);
  }

  recoverRunningPrompts(): number {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE prompt_jobs SET dispatch_kind = 'turn', parent_prompt_id = NULL, updated_at = ? WHERE state = 'queued' AND dispatch_kind = 'steering'").run(timestamp);
      const running = this.database.prepare("SELECT id, dispatch_kind FROM prompt_jobs WHERE state = 'running'").all() as Array<{ id: string; dispatch_kind: string }>;
      const result = this.database.prepare("UPDATE prompt_jobs SET state = 'failed', error = CASE dispatch_kind WHEN 'steering' THEN 'Steering delivery was interrupted and may already have reached Herdr; inspect the pane before retrying' ELSE 'Interrupted by bridge restart; resend the Lark message to retry' END, updated_at = ? WHERE state = 'running'").run(timestamp);
      for (const prompt of running) {
        const notice = prompt.dispatch_kind === "steering" ? "Steering 投递结果无法确认，请检查 Herdr pane 后按需重试" : "Bridge 重启导致本次执行中断";
        this.database.prepare("UPDATE run_cards SET phase = 'failed', notice = ?, finished_at = ?, queue_position = 0, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?").run(notice, timestamp, timestamp, prompt.id);
      }
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  enqueuePrompt(input: Omit<PromptJob, "state" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId">>): { prompt: PromptJob; inserted: boolean } {
    const timestamp = now();
    const result = this.database.prepare(`
      INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, state, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?) ON CONFLICT(lark_message_id) DO NOTHING
    `);
    const inserted = result.run(input.id, input.bindingId, input.larkMessageId, input.actorOpenId, input.body, input.dispatchKind ?? "turn", input.parentPromptId ?? null, timestamp, timestamp).changes === 1;
    const row = this.database.prepare("SELECT * FROM prompt_jobs WHERE lark_message_id = ?").get(input.larkMessageId) as PromptRow | undefined;
    if (!row) throw new Error(`Prompt not found: ${input.larkMessageId}`);
    return { prompt: mapPrompt(row), inserted };
  }

  acceptPrompt(input: { prompt: Omit<PromptJob, "state" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId">>; view: RunCardView; rootMessageId: string; card: object }): { prompt: PromptJob; view: RunCardView; inserted: boolean } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT * FROM prompt_jobs WHERE lark_message_id = ?").get(input.prompt.larkMessageId) as PromptRow | undefined;
      if (existing) {
        const view = this.loadRunCard(existing.id);
        if (!view) throw new Error(`Run card missing for prompt: ${existing.id}`);
        this.database.exec("COMMIT");
        return { prompt: mapPrompt(existing), view, inserted: false };
      }
      const timestamp = now();
      this.database.prepare(`INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, state, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`)
        .run(input.prompt.id, input.prompt.bindingId, input.prompt.larkMessageId, input.prompt.actorOpenId, input.prompt.body, input.prompt.dispatchKind ?? "turn", input.prompt.parentPromptId ?? null, timestamp, timestamp);
      this.insertRunCard(input.view);
      this.database.prepare(`
        INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, root_message_id, kind, payload, state, attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'card_reply', ?, 'pending', 0, ?, ?, ?)
      `).run(randomUUID(), `run-card:create:${input.prompt.id}`, input.prompt.bindingId, input.prompt.id, input.view.viewVersion, input.rootMessageId, JSON.stringify(input.card), timestamp, timestamp, timestamp);
      this.database.exec("COMMIT");
      return { prompt: this.getPrompt(input.prompt.id), view: this.loadRunCard(input.prompt.id)!, inserted: true };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextPrompt(bindingId: string): PromptJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(
        "SELECT * FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' ORDER BY created_at, id LIMIT 1"
      ).get(bindingId) as PromptRow | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      this.database.prepare("UPDATE prompt_jobs SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?")
        .run(now(), row.id);
      this.database.exec("COMMIT");
      return this.getPrompt(row.id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextReadyPrompt(bindingId: string): PromptJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT p.* FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
        WHERE p.binding_id = ? AND p.state = 'queued' AND p.dispatch_kind = 'turn'
        ORDER BY p.created_at, p.rowid LIMIT 1
      `).get(bindingId) as PromptRow | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      const ready = this.database.prepare("SELECT lark_message_id FROM run_cards WHERE prompt_id = ?").get(row.id) as { lark_message_id: string | null };
      if (!ready.lark_message_id) { this.database.exec("COMMIT"); return null; }
      this.database.prepare("UPDATE prompt_jobs SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(now(), row.id);
      this.database.exec("COMMIT");
      return this.getPrompt(row.id);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  claimNextReadySteering(bindingId: string, parentPromptId: string): PromptJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT p.* FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
        WHERE p.binding_id = ? AND p.parent_prompt_id = ? AND p.dispatch_kind = 'steering' AND p.state = 'queued'
          AND c.lark_message_id IS NOT NULL
        ORDER BY p.created_at, p.rowid LIMIT 1
      `).get(bindingId, parentPromptId) as PromptRow | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      this.database.prepare("UPDATE prompt_jobs SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(now(), row.id);
      this.database.exec("COMMIT");
      return this.getPrompt(row.id);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  requeueSteeringAsTurn(promptId: string): void {
    this.database.prepare("UPDATE prompt_jobs SET dispatch_kind = 'turn', parent_prompt_id = NULL, state = 'queued', error = NULL, updated_at = ? WHERE id = ? AND dispatch_kind = 'steering'")
      .run(now(), promptId);
  }

  requeueQueuedSteering(bindingId: string, parentPromptId: string): number {
    const result = this.database.prepare("UPDATE prompt_jobs SET dispatch_kind = 'turn', parent_prompt_id = NULL, updated_at = ? WHERE binding_id = ? AND parent_prompt_id = ? AND dispatch_kind = 'steering' AND state = 'queued'")
      .run(now(), bindingId, parentPromptId);
    return Number(result.changes);
  }

  updatePrompt(id: string, state: PromptState, error: string | null = null): void {
    this.database.prepare("UPDATE prompt_jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(state, error, now(), id);
  }

  enqueueOutboundReply(input: Omit<OutboundReply, "promptId" | "viewVersion" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "nextAttemptAt" | "createdAt" | "updatedAt"> & { promptId?: string | null; viewVersion?: number | null }): OutboundReply {
    const timestamp = now();
    if (input.kind === "card_update" && input.promptId && input.viewVersion !== undefined && input.viewVersion !== null) {
      this.database.prepare("DELETE FROM outbound_replies WHERE prompt_id = ? AND kind = 'card_update' AND state = 'pending' AND COALESCE(view_version, 0) < ?")
        .run(input.promptId, input.viewVersion);
    }
    this.database.prepare(`
      INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, root_message_id, kind, payload, state, attempt_count, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        payload = CASE WHEN outbound_replies.state = 'pending' THEN excluded.payload ELSE outbound_replies.payload END,
        view_version = CASE WHEN outbound_replies.state = 'pending' THEN excluded.view_version ELSE outbound_replies.view_version END,
        updated_at = CASE WHEN outbound_replies.state = 'pending' THEN excluded.updated_at ELSE outbound_replies.updated_at END
    `).run(input.id, input.idempotencyKey, input.bindingId ?? null, input.promptId ?? null, input.viewVersion ?? null, input.rootMessageId, input.kind, input.payload, timestamp, timestamp, timestamp);
    const row = this.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key = ?").get(input.idempotencyKey) as OutboundReplyRow | undefined;
    if (!row) throw new Error(`Outbound reply not found: ${input.idempotencyKey}`);
    return mapOutboundReply(row);
  }

  listPendingOutboundReplies(): OutboundReply[] {
    return (this.database.prepare("SELECT * FROM outbound_replies WHERE state = 'pending' ORDER BY next_attempt_at, created_at, id").all() as OutboundReplyRow[]).map(mapOutboundReply);
  }

  listDueOutboundReplies(): OutboundReply[] {
    return (this.database.prepare("SELECT * FROM outbound_replies WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, created_at, id").all(now()) as OutboundReplyRow[]).map(mapOutboundReply);
  }

  markOutboundReplyDelivered(id: string, messageId: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT prompt_id, view_version, kind FROM outbound_replies WHERE id = ?").get(id) as { prompt_id: string | null; view_version: number | null; kind: string } | undefined;
      this.database.prepare("UPDATE outbound_replies SET state = 'delivered', delivered_message_id = ?, error = NULL, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(messageId, now(), id);
      if (row?.prompt_id) {
        if (row.kind === "card_reply") this.database.prepare("UPDATE run_cards SET lark_message_id = ?, delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(messageId, row.view_version ?? 0, now(), row.prompt_id);
        else this.database.prepare("UPDATE run_cards SET delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(row.view_version ?? 0, now(), row.prompt_id);
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  markOutboundReplyFailed(id: string, error: string): void {
    const row = this.database.prepare("SELECT attempt_count FROM outbound_replies WHERE id = ?").get(id) as { attempt_count: number } | undefined;
    if (!row) return;
    const attempts = Number(row.attempt_count) + 1;
    const timestamp = now();
    if (attempts >= 5) {
      this.database.prepare("UPDATE outbound_replies SET state = 'dead_letter', error = ?, attempt_count = ?, updated_at = ? WHERE id = ?").run(error, attempts, timestamp, id);
      return;
    }
    this.database.prepare("UPDATE outbound_replies SET error = ?, attempt_count = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
      .run(error, attempts, retryAt(attempts), timestamp, id);
  }

  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void {
    this.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.actorOpenId, input.action, input.target, input.outcome, now());
  }

  saveTopicView(view: TopicViewState): void {
    this.database.prepare(`
      INSERT INTO topic_views(binding_id, state_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at
    `).run(view.bindingId, JSON.stringify(view), now());
  }

  loadTopicView(bindingId: string): TopicViewState | null {
    const row = this.database.prepare("SELECT state_json FROM topic_views WHERE binding_id = ?").get(bindingId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as TopicViewState : null;
  }

  saveRunCard(view: RunCardView): RunCardView {
    this.database.prepare(`UPDATE run_cards SET lark_message_id = ?, phase = ?, title = ?, request_text = ?, workspace_id = ?, pane_id = ?, answer = ?, progress_events_json = ?, queue_position = ?, started_at = ?, finished_at = ?, notice = ?, view_version = ?, delivered_version = ?, updated_at = ? WHERE prompt_id = ?`)
      .run(view.larkMessageId, view.phase, view.title, view.requestText, view.workspaceId, view.paneId, view.answer, JSON.stringify(view.progressEvents), view.queuePosition, view.startedAt, view.finishedAt, view.notice, view.viewVersion, view.deliveredVersion, view.updatedAt, view.promptId);
    return this.loadRunCard(view.promptId)!;
  }

  loadRunCard(promptId: string): RunCardView | null {
    const row = this.database.prepare("SELECT state_json FROM run_cards_view WHERE prompt_id = ?").get(promptId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as RunCardView : null;
  }

  listRunCards(bindingId: string): RunCardView[] {
    return (this.database.prepare("SELECT state_json FROM run_cards_view WHERE binding_id = ? ORDER BY created_at, prompt_id").all(bindingId) as Array<{ state_json: string }>).map((row) => JSON.parse(row.state_json) as RunCardView);
  }

  private insertRunCard(view: RunCardView): void {
    this.database.prepare(`INSERT INTO run_cards(prompt_id, binding_id, lark_message_id, phase, title, request_text, workspace_id, pane_id, answer, progress_events_json, queue_position, started_at, finished_at, notice, view_version, delivered_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(view.promptId, view.bindingId, view.larkMessageId, view.phase, view.title, view.requestText, view.workspaceId, view.paneId, view.answer, JSON.stringify(view.progressEvents), view.queuePosition, view.startedAt, view.finishedAt, view.notice, view.viewVersion, view.deliveredVersion, view.createdAt, view.updatedAt);
  }

  private getBinding(id: string): Binding {
    const row = this.database.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as BindingRow | undefined;
    if (!row) throw new Error(`Binding not found: ${id}`);
    return mapBinding(row);
  }

  private getPrompt(id: string): PromptJob {
    const row = this.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(id) as PromptRow | undefined;
    if (!row) throw new Error(`Prompt not found: ${id}`);
    return mapPrompt(row);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS bindings(
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id TEXT UNIQUE,
        root_message_id TEXT, pane_id TEXT UNIQUE, traex_session_id TEXT, title TEXT NOT NULL,
        runtime TEXT NOT NULL CHECK(runtime = 'traex'),
        state TEXT NOT NULL CHECK(state IN ('pending','active','archived','orphaned','failed')),
        status_message_id TEXT,
        last_agent_state TEXT NOT NULL CHECK(last_agent_state IN ('idle','working','blocked','done','unknown')),
        last_output_fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbound_messages(
        event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('received','processing','accepted')), error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbound_messages_pending ON inbound_messages(state, created_at);
      CREATE TABLE IF NOT EXISTS bridge_messages(message_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompt_jobs(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE NOT NULL,
        actor_open_id TEXT NOT NULL, body TEXT NOT NULL, dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering')), parent_prompt_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prompt_jobs_queue ON prompt_jobs(binding_id, state, created_at);
      CREATE TABLE IF NOT EXISTS outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, view_version INTEGER, root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update')), payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter')), attempt_count INTEGER NOT NULL DEFAULT 0,
        error TEXT, delivered_message_id TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbound_replies_pending ON outbound_replies(state, created_at);
      CREATE TABLE IF NOT EXISTS audit_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_open_id TEXT NOT NULL, action TEXT NOT NULL,
        target TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topic_views(
        binding_id TEXT PRIMARY KEY REFERENCES bindings(id), state_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_cards(
        prompt_id TEXT PRIMARY KEY REFERENCES prompt_jobs(id), binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT,
        phase TEXT NOT NULL CHECK(phase IN ('queued','running','blocked','completed','failed')), title TEXT NOT NULL, request_text TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL, pane_id TEXT,
        answer TEXT NOT NULL, progress_events_json TEXT NOT NULL, queue_position INTEGER NOT NULL, started_at TEXT, finished_at TEXT, notice TEXT,
        view_version INTEGER NOT NULL, delivered_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_cards_binding ON run_cards(binding_id, created_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `);
    this.ensureOutboundReplyColumns();
    this.ensureRequestCardOutboxColumns();
    this.ensureRunCardRequestText();
    this.ensurePromptDispatchColumns();
  }

  private ensurePromptDispatchColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("dispatch_kind")) this.database.exec("ALTER TABLE prompt_jobs ADD COLUMN dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering'))");
    if (!names.has("parent_prompt_id")) this.database.exec("ALTER TABLE prompt_jobs ADD COLUMN parent_prompt_id TEXT");
    this.database.exec("CREATE INDEX IF NOT EXISTS prompt_jobs_dispatch ON prompt_jobs(binding_id, dispatch_kind, parent_prompt_id, state, created_at)");
  }

  private ensureRequestCardOutboxColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("prompt_id")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN prompt_id TEXT");
    if (!names.has("view_version")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN view_version INTEGER");
  }

  private ensureRunCardRequestText(): void {
    const columns = this.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "request_text")) {
      this.database.exec("ALTER TABLE run_cards ADD COLUMN request_text TEXT NOT NULL DEFAULT ''");
    }
    this.database.exec(`
      UPDATE run_cards SET request_text = COALESCE((SELECT body FROM prompt_jobs WHERE prompt_jobs.id = run_cards.prompt_id), '') WHERE request_text = '';
      DROP VIEW IF EXISTS run_cards_view;
      CREATE VIEW run_cards_view AS SELECT *, json_object(
        'promptId', prompt_id, 'bindingId', binding_id, 'larkMessageId', lark_message_id, 'phase', phase, 'title', title, 'requestText', request_text,
        'workspaceId', workspace_id, 'paneId', pane_id, 'answer', answer, 'progressEvents', json(progress_events_json),
        'queuePosition', queue_position, 'startedAt', started_at, 'finishedAt', finished_at, 'notice', notice,
        'viewVersion', view_version, 'deliveredVersion', delivered_version, 'createdAt', created_at, 'updatedAt', updated_at
      ) AS state_json FROM run_cards;
    `);
  }

  private ensureOutboundReplyColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (names.has("binding_id") && names.has("next_attempt_at")) return;
    this.database.exec(`
      BEGIN;
      ALTER TABLE outbound_replies RENAME TO outbound_replies_legacy;
      CREATE TABLE outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update')), payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter')), attempt_count INTEGER NOT NULL DEFAULT 0,
        error TEXT, delivered_message_id TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO outbound_replies(id, idempotency_key, binding_id, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, next_attempt_at, created_at, updated_at)
      SELECT id, idempotency_key, NULL, root_message_id, CASE kind WHEN 'card' THEN 'card_reply' ELSE kind END, payload, state, attempt_count, error, delivered_message_id, updated_at, created_at, updated_at
      FROM outbound_replies_legacy;
      DROP TABLE outbound_replies_legacy;
      CREATE INDEX IF NOT EXISTS outbound_replies_pending ON outbound_replies(state, next_attempt_at, created_at);
      COMMIT;
    `);
  }
}

function now(): string { return new Date().toISOString(); }
function retryAt(attempt: number): string { return new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** (attempt - 1))).toISOString(); }

function mapBinding(row: BindingRow): Binding {
  return {
    id: row.id, workspaceId: row.workspace_id, chatId: row.chat_id, topicId: row.topic_id,
    rootMessageId: row.root_message_id, paneId: row.pane_id, traexSessionId: row.traex_session_id,
    title: row.title, runtime: "traex", state: row.state as BindingState, statusMessageId: row.status_message_id,
    lastAgentState: row.last_agent_state as AgentState, lastOutputFingerprint: row.last_output_fingerprint,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapPrompt(row: PromptRow): PromptJob {
  return {
    id: row.id, bindingId: row.binding_id, larkMessageId: row.lark_message_id, actorOpenId: row.actor_open_id,
    body: row.body, dispatchKind: row.dispatch_kind as PromptDispatchKind, parentPromptId: row.parent_prompt_id, state: row.state as PromptState, attemptCount: Number(row.attempt_count), error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapOutboundReply(row: OutboundReplyRow): OutboundReply {
  return {
    id: row.id, idempotencyKey: row.idempotency_key, bindingId: row.binding_id, rootMessageId: row.root_message_id,
    promptId: row.prompt_id, viewVersion: row.view_version === null ? null : Number(row.view_version), kind: row.kind as OutboundReplyKind, payload: row.payload, state: row.state as OutboundReplyState,
    attemptCount: Number(row.attempt_count), error: row.error, deliveredMessageId: row.delivered_message_id, nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
