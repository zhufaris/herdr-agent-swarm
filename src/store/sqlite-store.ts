import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BindingStorePort } from "../domain/ports.js";
import type { AgentState, Binding, BindingState, PromptJob, PromptState } from "../domain/types.js";
import type { TopicViewState } from "../domain/topic-view.js";

type SqlValue = string | number | bigint | null;
type BindingRow = Record<string, SqlValue> & {
  id: string; workspace_id: string; chat_id: string; topic_id: string | null; root_message_id: string | null;
  pane_id: string | null; traex_session_id: string | null; title: string; runtime: string; state: string;
  status_message_id: string | null; last_agent_state: string; last_output_fingerprint: string | null;
  created_at: string; updated_at: string;
};
type PromptRow = Record<string, SqlValue> & {
  id: string; binding_id: string; lark_message_id: string; actor_open_id: string; body: string; state: string;
  attempt_count: number; error: string | null; created_at: string; updated_at: string;
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

  hasProcessedEvent(eventId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM processed_events WHERE event_id = ?").get(eventId));
  }

  recordProcessedEvent(eventId: string, messageId: string): void {
    this.database.prepare("INSERT OR IGNORE INTO processed_events(event_id, message_id, created_at) VALUES (?, ?, ?)")
      .run(eventId, messageId, now());
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

  recoverRunningPrompts(): number {
    const result = this.database.prepare(
      "UPDATE prompt_jobs SET state = 'queued', error = 'Recovered after bridge restart', updated_at = ? WHERE state = 'running'"
    ).run(now());
    return Number(result.changes);
  }

  enqueuePrompt(input: Omit<PromptJob, "state" | "attemptCount" | "error" | "createdAt" | "updatedAt">): PromptJob {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, state, attempt_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?)
    `).run(input.id, input.bindingId, input.larkMessageId, input.actorOpenId, input.body, timestamp, timestamp);
    return this.getPrompt(input.id);
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

  updatePrompt(id: string, state: PromptState, error: string | null = null): void {
    this.database.prepare("UPDATE prompt_jobs SET state = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(state, error, now(), id);
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
      CREATE TABLE IF NOT EXISTS processed_events(
        event_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bridge_messages(message_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompt_jobs(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE NOT NULL,
        actor_open_id TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prompt_jobs_queue ON prompt_jobs(binding_id, state, created_at);
      CREATE TABLE IF NOT EXISTS audit_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_open_id TEXT NOT NULL, action TEXT NOT NULL,
        target TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topic_views(
        binding_id TEXT PRIMARY KEY REFERENCES bindings(id), state_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `);
  }
}

function now(): string { return new Date().toISOString(); }

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
    body: row.body, state: row.state as PromptState, attemptCount: Number(row.attempt_count), error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
