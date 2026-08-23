import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BindingStorePort } from "../domain/ports.js";
import type { AgentState, Binding, BindingState, DeadLetterActionOutcome, FailureSummary, IncomingLarkMessage, InstanceLease, OperationalSummary, OutboundReply, OutboundReplyKind, OutboundReplyState, PaneCloseOperation, ProjectSelection, ProjectSelectionClaim, ProjectSelectionState, PromptDispatchKind, PromptJob, PromptObservationState, PromptState, RequestCardRole, SessionSummary } from "../domain/types.js";
import type { TopicViewState } from "../domain/topic-view.js";
import type { RunCardView } from "../domain/run-card-view.js";
import type { BridgeEvent } from "../domain/events.js";
import { transitionSession, type AttachmentState, type ProvisioningCheckpoint, type SessionLifecycle, type SessionTransition } from "../domain/pane-thread-lifecycle.js";

type SqlValue = string | number | bigint | null;
type BindingRow = Record<string, SqlValue> & {
  id: string; project_id: string | null; workspace_id: string; chat_id: string; topic_id: string | null; root_message_id: string | null;
  pane_id: string | null; traex_session_id: string | null; title: string; runtime: string; state: string;
  status_message_id: string | null; last_agent_state: string; last_output_fingerprint: string | null;
  lifecycle: string; attachment: string; generation: number; provisioning_checkpoint: string; degradation_count: number;
  has_completed_turn: number; last_observed_at: string | null; archived_at: string | null; last_activity_at: string;
  created_at: string; updated_at: string;
};
type PromptRow = Record<string, SqlValue> & {
  id: string; binding_id: string; lark_message_id: string; actor_open_id: string; body: string; state: string;
  dispatch_kind: string; parent_prompt_id: string | null;
  observation_state: string;
  attempt_count: number; error: string | null; created_at: string; updated_at: string;
};
type OutboundReplyRow = Record<string, SqlValue> & {
  id: string; idempotency_key: string; binding_id: string | null; prompt_id: string | null; view_version: number | null; selection_id: string | null; card_role: string | null; root_message_id: string; kind: string; payload: string; state: string;
  attempt_count: number; error: string | null; delivered_message_id: string | null; next_attempt_at: string; created_at: string; updated_at: string;
};
type ProjectSelectionRow = Record<string, SqlValue> & {
  id: string; command_message_id: string; selector_message_id: string | null; chat_id: string; topic_id: string | null; root_message_id: string; actor_open_id: string;
  requested_title: string | null; selected_project_id: string | null; binding_id: string | null; state: string; error: string | null; expires_at: string; created_at: string; updated_at: string;
};

const FENCED_TABLES = [
  "bindings", "inbound_messages", "bridge_messages", "prompt_jobs", "outbound_replies",
  "project_selections", "pane_close_requests", "audit_log", "lifecycle_events", "topic_views", "run_cards"
] as const;

const BINDING_COLUMNS: Record<keyof Binding, string> = {
  id: "id", projectId: "project_id", workspaceId: "workspace_id", chatId: "chat_id", topicId: "topic_id",
  rootMessageId: "root_message_id", paneId: "pane_id", traexSessionId: "traex_session_id",
  title: "title", runtime: "runtime", state: "state", statusMessageId: "status_message_id",
  lastAgentState: "last_agent_state", lastOutputFingerprint: "last_output_fingerprint",
  lifecycle: "lifecycle", attachment: "attachment", generation: "generation", provisioningCheckpoint: "provisioning_checkpoint",
  degradationCount: "degradation_count", hasCompletedTurn: "has_completed_turn", lastObservedAt: "last_observed_at",
  archivedAt: "archived_at", lastActivityAt: "last_activity_at",
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

  activateWriteFence(ownerId: string, fencingToken: number): void {
    this.deactivateWriteFence();
    this.database.exec("CREATE TEMP TABLE bridge_write_fence(owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL)");
    this.database.prepare("INSERT INTO temp.bridge_write_fence(owner_id, fencing_token) VALUES (?, ?)").run(ownerId, fencingToken);
    for (const table of FENCED_TABLES) for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
      const trigger = `bridge_fence_${table}_${operation.toLowerCase()}`;
      this.database.exec(`
        CREATE TEMP TRIGGER ${trigger} BEFORE ${operation} ON main.${table}
        BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM main.instance_lease AS lease, temp.bridge_write_fence AS fence
            WHERE lease.singleton_id = 1 AND lease.owner_id = fence.owner_id
              AND lease.fencing_token = fence.fencing_token
              AND julianday(lease.expires_at) > julianday('now')
          ) THEN RAISE(ABORT, 'stale_instance_lease') END;
        END;
      `);
    }
    try { this.assertWriteFence(); }
    catch (error) { this.deactivateWriteFence(); throw error; }
  }

  deactivateWriteFence(): void {
    for (const table of FENCED_TABLES) for (const operation of ["insert", "update", "delete"] as const) {
      this.database.exec(`DROP TRIGGER IF EXISTS temp.bridge_fence_${table}_${operation}`);
    }
    this.database.exec("DROP TABLE IF EXISTS temp.bridge_write_fence");
  }

  private assertWriteFence(): void {
    const valid = this.database.prepare(`
      SELECT 1 FROM main.instance_lease AS lease, temp.bridge_write_fence AS fence
      WHERE lease.singleton_id = 1 AND lease.owner_id = fence.owner_id
        AND lease.fencing_token = fence.fencing_token
        AND julianday(lease.expires_at) > julianday('now')
    `).get();
    if (!valid) throw new Error("stale_instance_lease");
  }

  acquireInstanceLease(ownerId: string, currentTime: string, expiresAt: string): InstanceLease | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT owner_id, fencing_token, expires_at, updated_at FROM instance_lease WHERE singleton_id = 1").get() as { owner_id: string; fencing_token: number; expires_at: string; updated_at: string } | undefined;
      if (!row) {
        this.database.prepare("INSERT INTO instance_lease(singleton_id, owner_id, fencing_token, expires_at, updated_at) VALUES (1, ?, 1, ?, ?)").run(ownerId, expiresAt, currentTime);
      } else if (row.owner_id === ownerId) {
        this.database.prepare("UPDATE instance_lease SET expires_at = ?, updated_at = ? WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ?").run(expiresAt, currentTime, ownerId, row.fencing_token);
      } else if (row.expires_at <= currentTime) {
        this.database.prepare("UPDATE instance_lease SET owner_id = ?, fencing_token = fencing_token + 1, expires_at = ?, updated_at = ? WHERE singleton_id = 1 AND fencing_token = ? AND expires_at <= ?").run(ownerId, expiresAt, currentTime, row.fencing_token, currentTime);
      } else {
        this.database.exec("COMMIT");
        return null;
      }
      const acquired = this.database.prepare("SELECT owner_id, fencing_token, expires_at, updated_at FROM instance_lease WHERE singleton_id = 1 AND owner_id = ?").get(ownerId) as { owner_id: string; fencing_token: number; expires_at: string; updated_at: string } | undefined;
      this.database.exec("COMMIT");
      return acquired ? mapInstanceLease(acquired) : null;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  renewInstanceLease(ownerId: string, fencingToken: number, currentTime: string, expiresAt: string): InstanceLease | null {
    const result = this.database.prepare("UPDATE instance_lease SET expires_at = ?, updated_at = ? WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ? AND expires_at > ?")
      .run(expiresAt, currentTime, ownerId, fencingToken, currentTime);
    if (result.changes !== 1) return null;
    const row = this.database.prepare("SELECT owner_id, fencing_token, expires_at, updated_at FROM instance_lease WHERE singleton_id = 1").get() as { owner_id: string; fencing_token: number; expires_at: string; updated_at: string };
    return mapInstanceLease(row);
  }

  releaseInstanceLease(ownerId: string, fencingToken: number): boolean {
    return this.database.prepare("DELETE FROM instance_lease WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ?").run(ownerId, fencingToken).changes === 1;
  }

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

  createPendingBinding(input: { id: string; projectId?: string | null; workspaceId: string; chatId: string; topicId: string | null; rootMessageId: string | null; title: string }): Binding {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO bindings(
        id, project_id, workspace_id, chat_id, topic_id, root_message_id, title, runtime, state, last_agent_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'traex', 'pending', 'unknown', ?, ?)
    `).run(input.id, input.projectId ?? null, input.workspaceId, input.chatId, input.topicId, input.rootMessageId, input.title, timestamp, timestamp);
    return this.requireBinding(input.id);
  }

  createProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; expiresAt: string; card: object }): ProjectSelection {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT * FROM project_selections WHERE command_message_id = ?").get(input.commandMessageId) as ProjectSelectionRow | undefined;
      if (existing) { this.database.exec("COMMIT"); return mapProjectSelection(existing); }
      const timestamp = now();
      this.database.prepare(`INSERT INTO project_selections(id, command_message_id, chat_id, topic_id, root_message_id, actor_open_id, requested_title, state, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(input.id, input.commandMessageId, input.chatId, input.topicId, input.rootMessageId, input.actorOpenId, input.requestedTitle, input.expiresAt, timestamp, timestamp);
      this.database.prepare(`INSERT INTO outbound_replies(id, idempotency_key, selection_id, root_message_id, kind, payload, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'card_reply', ?, 'pending', 0, ?, ?, ?)`)
        .run(randomUUID(), `project-selection:create:${input.id}`, input.id, input.rootMessageId, JSON.stringify(input.card), timestamp, timestamp, timestamp);
      this.database.exec("COMMIT");
      return this.getProjectSelection(input.id)!;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  getProjectSelection(id: string): ProjectSelection | null {
    const row = this.database.prepare("SELECT * FROM project_selections WHERE id = ?").get(id) as ProjectSelectionRow | undefined;
    return row ? mapProjectSelection(row) : null;
  }

  claimProjectSelection(input: { selectionId: string; projectId: string; messageId: string; chatId: string; actorOpenId: string; allowedProjectIds: string[] }): ProjectSelectionClaim {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM project_selections WHERE id = ?").get(input.selectionId) as ProjectSelectionRow | undefined;
      if (!row) { this.database.exec("COMMIT"); return { outcome: "missing", selection: null }; }
      const selection = mapProjectSelection(row);
      if (selection.chatId !== input.chatId || selection.selectorMessageId !== input.messageId || !input.allowedProjectIds.includes(input.projectId)) { this.database.exec("COMMIT"); return { outcome: "invalid", selection }; }
      if (selection.actorOpenId !== input.actorOpenId) { this.database.exec("COMMIT"); return { outcome: "unauthorized", selection }; }
      if (selection.state === "completed") { this.database.exec("COMMIT"); return { outcome: "completed", selection }; }
      if (selection.state === "processing") { this.database.exec("COMMIT"); return { outcome: "processing", selection }; }
      if (selection.state !== "pending") { this.database.exec("COMMIT"); return { outcome: selection.state === "expired" ? "expired" : "invalid", selection }; }
      if (Date.parse(selection.expiresAt) <= Date.now()) {
        this.database.prepare("UPDATE project_selections SET state = 'expired', updated_at = ? WHERE id = ?").run(now(), selection.id);
        this.database.exec("COMMIT");
        return { outcome: "expired", selection: { ...selection, state: "expired" } };
      }
      this.database.prepare("UPDATE project_selections SET state = 'processing', selected_project_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(input.projectId, now(), selection.id);
      this.database.exec("COMMIT");
      return { outcome: "claimed", selection: this.getProjectSelection(selection.id)! };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  recoverProcessingProjectSelections(): number {
    return Number(this.database.prepare("UPDATE project_selections SET state = 'failed', error = 'Interrupted during project creation; inspect Herdr before retrying', updated_at = ? WHERE state = 'processing'").run(now()).changes);
  }

  listProcessingProjectSelections(): ProjectSelection[] {
    return (this.database.prepare("SELECT * FROM project_selections WHERE state = 'processing' ORDER BY created_at").all() as ProjectSelectionRow[]).map(mapProjectSelection);
  }

  linkProjectSelectionBinding(id: string, bindingId: string): ProjectSelection {
    this.database.prepare("UPDATE project_selections SET binding_id = ?, updated_at = ? WHERE id = ? AND state = 'processing'").run(bindingId, now(), id);
    const selection = this.getProjectSelection(id);
    if (!selection) throw new Error(`Project selection not found: ${id}`);
    return selection;
  }

  pauseProjectSelection(id: string, error: string): ProjectSelection {
    this.database.prepare("UPDATE project_selections SET error = ?, updated_at = ? WHERE id = ? AND state = 'processing'").run(error, now(), id);
    const selection = this.getProjectSelection(id);
    if (!selection) throw new Error(`Project selection not found: ${id}`);
    return selection;
  }

  completeProjectSelection(id: string, bindingId: string): ProjectSelection {
    this.database.prepare("UPDATE project_selections SET state = 'completed', binding_id = ?, error = NULL, updated_at = ? WHERE id = ? AND state = 'processing'").run(bindingId, now(), id);
    const selection = this.getProjectSelection(id);
    if (!selection) throw new Error(`Project selection not found: ${id}`);
    return selection;
  }

  failProjectSelection(id: string, error: string): ProjectSelection {
    this.database.prepare("UPDATE project_selections SET state = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
    const selection = this.getProjectSelection(id);
    if (!selection) throw new Error(`Project selection not found: ${id}`);
    return selection;
  }

  createPaneCloseRequest(input: { id: string; bindingId: string; paneId: string; actorOpenId: string; codeHash: string; expiresAt: string }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = now();
      this.database.prepare("UPDATE pane_close_requests SET state = 'cancelled', updated_at = ? WHERE binding_id = ? AND state = 'pending'")
        .run(timestamp, input.bindingId);
      this.database.prepare(`
        INSERT INTO pane_close_requests(id, binding_id, pane_id, actor_open_id, code_hash, state, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(input.id, input.bindingId, input.paneId, input.actorOpenId, input.codeHash, input.expiresAt, timestamp, timestamp);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  consumePaneCloseRequest(input: { bindingId: string; paneId: string; actorOpenId: string; codeHash: string; now: string }):
    | { outcome: "consumed"; operationId: string; paneId: string }
    | { outcome: "invalid" | "unauthorized" | "expired" | "stale" } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT id, pane_id, actor_open_id, code_hash, expires_at FROM pane_close_requests WHERE binding_id = ? AND state = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1")
        .get(input.bindingId) as { id: string; pane_id: string; actor_open_id: string; code_hash: string; expires_at: string } | undefined;
      if (!row) { this.database.exec("COMMIT"); return { outcome: "stale" }; }
      if (row.actor_open_id !== input.actorOpenId) { this.database.exec("COMMIT"); return { outcome: "unauthorized" }; }
      if (row.pane_id !== input.paneId || row.code_hash !== input.codeHash) { this.database.exec("COMMIT"); return { outcome: "invalid" }; }
      if (row.expires_at <= input.now) {
        this.database.prepare("UPDATE pane_close_requests SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'pending'").run(input.now, row.id);
        this.database.exec("COMMIT");
        return { outcome: "expired" };
      }
      const result = this.database.prepare("UPDATE pane_close_requests SET state = 'executing', consumed_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'")
        .run(input.now, input.now, row.id);
      this.database.exec("COMMIT");
      return result.changes === 1 ? { outcome: "consumed", operationId: row.id, paneId: row.pane_id } : { outcome: "stale" };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  finishPaneCloseRequest(operationId: string, state: "succeeded" | "rejected" | "uncertain", detail: string | undefined = undefined): void {
    this.database.prepare("UPDATE pane_close_requests SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state IN ('executing','uncertain')")
      .run(state, detail ?? null, now(), operationId);
  }

  listUnresolvedPaneCloseOperations(): PaneCloseOperation[] {
    return (this.database.prepare("SELECT id, binding_id, pane_id, state FROM pane_close_requests WHERE state IN ('executing','uncertain') ORDER BY created_at, id").all() as Array<{ id: string; binding_id: string; pane_id: string; state: PaneCloseOperation["state"] }>)
      .map((row) => ({ id: row.id, bindingId: row.binding_id, paneId: row.pane_id, state: row.state }));
  }

  updateBinding(id: string, patch: Partial<Binding>): Binding {
    const normalized = { ...patch };
    if (patch.state && patch.lifecycle === undefined) {
      if (patch.state === "active") { normalized.lifecycle = "active"; normalized.provisioningCheckpoint = "activated"; if (patch.paneId) normalized.attachment = "attached"; }
      else if (patch.state === "archived") { normalized.lifecycle = "archived"; normalized.archivedAt = patch.archivedAt ?? now(); }
      else if (patch.state === "orphaned") { normalized.lifecycle = "active"; normalized.attachment = "orphaned"; }
      else if (patch.state === "failed") normalized.lifecycle = "failed";
    }
    const entries = Object.entries(normalized).filter(([key]) => key !== "id" && key !== "createdAt");
    entries.push(["updatedAt", now()]);
    if (entries.length === 0) return this.requireBinding(id);
    const assignments = entries.map(([key]) => `${BINDING_COLUMNS[key as keyof Binding]} = ?`).join(", ");
    const values = entries.map(([, value]) => typeof value === "boolean" ? Number(value) : value as SqlValue);
    const result = this.database.prepare(`UPDATE bindings SET ${assignments} WHERE id = ?`).run(...values, id);
    if (result.changes === 0) throw new Error(`Binding not found: ${id}`);
    return this.requireBinding(id);
  }

  transitionBinding(id: string, transition: SessionTransition): Binding {
    const binding = this.requireBinding(id);
    const next = transitionSession({
      lifecycle: binding.lifecycle, attachment: binding.attachment, runtime: binding.lastAgentState, generation: binding.generation,
      provisioningCheckpoint: binding.provisioningCheckpoint, degradationCount: binding.degradationCount, hasCompletedTurn: binding.hasCompletedTurn
    }, transition);
    const legacyState: BindingState = next.attachment === "orphaned" && next.lifecycle !== "archived" && next.lifecycle !== "closed"
      ? "orphaned"
      : next.lifecycle === "provisioning" ? "pending"
        : next.lifecycle === "active" || next.lifecycle === "draining" ? "active"
          : next.lifecycle === "archived" || next.lifecycle === "closed" ? "archived" : "failed";
    return this.updateBinding(id, {
      lifecycle: next.lifecycle, attachment: next.attachment, lastAgentState: next.runtime, generation: next.generation,
      provisioningCheckpoint: next.provisioningCheckpoint, degradationCount: next.degradationCount, hasCompletedTurn: next.hasCompletedTurn,
      state: legacyState, lastObservedAt: transition.type === "pane_observed" ? now() : binding.lastObservedAt,
      archivedAt: next.lifecycle === "archived" ? binding.archivedAt ?? now() : binding.archivedAt
    });
  }

  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: BridgeEvent; view: TopicViewState; messageId: string; card: object }): Binding {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const binding = this.transitionBinding(input.id, input.transition);
      const timestamp = now();
      this.database.prepare("INSERT OR IGNORE INTO lifecycle_events(event_id, binding_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)")
        .run(input.event.eventId, input.id, input.event.type, JSON.stringify(input.event.payload), input.event.occurredAt);
      this.database.prepare(`INSERT INTO topic_views(binding_id, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(binding_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
        .run(input.id, JSON.stringify(input.view), timestamp);
      this.database.prepare(`INSERT INTO outbound_replies(id, idempotency_key, binding_id, root_message_id, kind, payload, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'card_update', ?, 'pending', 0, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`)
        .run(randomUUID(), `card-update:${input.messageId}:${input.event.eventId}`, input.id, input.messageId, JSON.stringify(input.card), timestamp, timestamp, timestamp);
      this.database.exec("COMMIT");
      return binding;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  attachBindingPane(id: string, pane: import("../domain/types.js").HerdrPane, replacement: boolean): Binding {
    const binding = this.requireBinding(id);
    const next = transitionSession({
      lifecycle: binding.lifecycle, attachment: binding.attachment, runtime: binding.lastAgentState, generation: binding.generation,
      provisioningCheckpoint: binding.provisioningCheckpoint, degradationCount: binding.degradationCount, hasCompletedTurn: binding.hasCompletedTurn
    }, { type: "pane_reattached", replacement });
    const suspended = transitionSession(next, { type: "archive_requested", hasActiveTurn: false });
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`UPDATE bindings SET pane_id = ?, traex_session_id = ?, workspace_id = ?, lifecycle = ?, attachment = ?, state = 'archived', generation = ?, last_agent_state = ?, degradation_count = 0, last_observed_at = ?, archived_at = ?, updated_at = ? WHERE id = ?`)
        .run(pane.paneId, pane.terminalId ?? null, pane.workspaceId, suspended.lifecycle, suspended.attachment, suspended.generation, suspended.runtime, now(), now(), now(), id);
      this.database.exec("COMMIT");
      return this.requireBinding(id);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
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

  getBinding(id: string): Binding | null {
    const row = this.database.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  listBindings(): Binding[] {
    return (this.database.prepare("SELECT * FROM bindings ORDER BY created_at").all() as BindingRow[]).map(mapBinding);
  }

  listBindingsByState(state: Binding["state"]): Binding[] {
    return (this.database.prepare("SELECT * FROM bindings WHERE state = ? ORDER BY created_at, id").all(state) as BindingRow[]).map(mapBinding);
  }

  listSessions(chatId: string): SessionSummary[] {
    const rows = this.database.prepare(`
      SELECT b.*, (SELECT COUNT(*) FROM prompt_jobs p WHERE p.binding_id = b.id AND p.state IN ('queued','running')) AS queue_depth,
        COALESCE((SELECT r.space_name FROM run_cards r WHERE r.binding_id = b.id ORDER BY r.created_at DESC LIMIT 1), b.project_id, b.workspace_id) AS space_name
      FROM bindings b WHERE b.chat_id = ?
      ORDER BY CASE b.attachment WHEN 'degraded' THEN 0 WHEN 'orphaned' THEN 2 ELSE 1 END,
        CASE b.lifecycle WHEN 'active' THEN 0 WHEN 'provisioning' THEN 1 WHEN 'draining' THEN 2 WHEN 'archived' THEN 3 WHEN 'closed' THEN 4 ELSE 5 END,
        b.last_activity_at DESC, b.id
    `).all(chatId) as Array<BindingRow & { queue_depth: number; space_name: string }>;
    return rows.map((row) => ({ binding: mapBinding(row), queueDepth: Number(row.queue_depth), spaceName: row.space_name }));
  }

  listFailures(chatId: string): FailureSummary[] {
    const outbound = this.database.prepare(`
      SELECT o.id, o.binding_id, o.attempt_count, o.updated_at, o.error, b.pane_id, b.title,
        COALESCE((SELECT r.space_name FROM run_cards r WHERE r.binding_id = b.id ORDER BY r.created_at DESC LIMIT 1), b.project_id, b.workspace_id) AS space_name FROM outbound_replies o
      LEFT JOIN bindings b ON b.id = o.binding_id
      LEFT JOIN project_selections s ON s.id = o.selection_id
      WHERE o.state = 'dead_letter' AND (b.chat_id = ? OR s.chat_id = ?)
      ORDER BY o.updated_at DESC
    `).all(chatId, chatId) as Array<{ id: string; binding_id: string | null; attempt_count: number; updated_at: string; error: string | null; pane_id: string | null; title: string | null; space_name: string | null }>;
    const prompts = this.database.prepare(`SELECT p.id, p.binding_id, p.updated_at, p.error, b.pane_id, b.title, COALESCE((SELECT r.space_name FROM run_cards r WHERE r.binding_id = b.id ORDER BY r.created_at DESC LIMIT 1), b.project_id, b.workspace_id) AS space_name FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE b.chat_id = ? AND p.state IN ('failed','cancelled') ORDER BY p.updated_at DESC`).all(chatId) as Array<{ id: string; binding_id: string; updated_at: string; error: string | null; pane_id: string | null; title: string; space_name: string }>;
    const sessions = this.database.prepare(`SELECT b.id, b.updated_at, b.lifecycle, b.attachment, b.pane_id, b.title, COALESCE((SELECT r.space_name FROM run_cards r WHERE r.binding_id = b.id ORDER BY r.created_at DESC LIMIT 1), b.project_id, b.workspace_id) AS space_name FROM bindings b WHERE b.chat_id = ? AND (b.lifecycle IN ('failed','provisioning') OR b.attachment IN ('degraded','orphaned')) ORDER BY b.updated_at DESC`).all(chatId) as Array<{ id: string; updated_at: string; lifecycle: string; attachment: string; pane_id: string | null; title: string; space_name: string }>;
    return [
      ...outbound.map((row): FailureSummary => ({ kind: "outbound", id: row.id, bindingId: row.binding_id, attemptCount: Number(row.attempt_count), updatedAt: row.updated_at, error: boundedError(row.error), ...(row.space_name ? { spaceName: row.space_name } : {}), ...(row.pane_id !== undefined ? { paneId: row.pane_id } : {}), ...(row.title ? { title: row.title } : {}) })),
      ...prompts.map((row): FailureSummary => ({ kind: "prompt", id: row.id, bindingId: row.binding_id, updatedAt: row.updated_at, error: boundedError(row.error), spaceName: row.space_name, paneId: row.pane_id, title: row.title })),
      ...sessions.map((row): FailureSummary => ({ kind: "session", id: `session:${row.id}`, bindingId: row.id, updatedAt: row.updated_at, error: `Session is ${row.lifecycle}/${row.attachment}`, spaceName: row.space_name, paneId: row.pane_id, title: row.title }))
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
      const undispatched = this.database.prepare("SELECT id FROM prompt_jobs WHERE state = 'running' AND observation_state = 'not_started'").all() as Array<{ id: string }>;
      this.database.prepare("UPDATE prompt_jobs SET state = 'queued', observation_state = 'not_started', error = NULL, updated_at = ? WHERE state = 'running' AND observation_state = 'not_started'").run(timestamp);
      for (const prompt of undispatched) {
        this.database.prepare("UPDATE run_cards SET phase = 'queued', started_at = NULL, notice = NULL, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?").run(timestamp, prompt.id);
      }
      const running = this.database.prepare("SELECT id, dispatch_kind FROM prompt_jobs WHERE state = 'running'").all() as Array<{ id: string; dispatch_kind: string }>;
      const result = this.database.prepare("UPDATE prompt_jobs SET state = CASE dispatch_kind WHEN 'steering' THEN 'failed' ELSE state END, observation_state = CASE dispatch_kind WHEN 'steering' THEN 'completed' ELSE 'detached' END, error = CASE dispatch_kind WHEN 'steering' THEN 'Steering delivery may already have reached Herdr; inspect the pane before retrying' ELSE 'Bridge restarted after dispatch; observing the existing TraeX turn without replay' END, updated_at = ? WHERE state = 'running'").run(timestamp);
      for (const prompt of running) {
        const notice = prompt.dispatch_kind === "steering" ? "Steering 投递结果无法确认，请检查 Herdr pane 后按需重试" : "Bridge 已重连，正在观察原 TraeX 任务；不会重复发送请求";
        this.database.prepare("UPDATE run_cards SET phase = CASE WHEN ? = 'steering' THEN 'failed' ELSE 'running' END, finished_at = CASE WHEN ? = 'steering' THEN ? ELSE NULL END, queue_position = 0, notice = ?, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?")
          .run(prompt.dispatch_kind, prompt.dispatch_kind, timestamp, notice, timestamp, prompt.id);
      }
      this.database.exec("COMMIT");
      return undispatched.length + Number(result.changes);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  listDetachedPrompts(): PromptJob[] {
    return (this.database.prepare("SELECT * FROM prompt_jobs WHERE state = 'running' AND observation_state = 'detached' ORDER BY created_at, id").all() as PromptRow[]).map(mapPrompt);
  }

  markPromptObservationDetached(id: string, notice: string): void {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare("UPDATE prompt_jobs SET observation_state = 'detached', error = ?, updated_at = ? WHERE id = ? AND state = 'running' AND observation_state = 'attached'").run(notice, timestamp, id);
      if (result.changes > 0) this.database.prepare("UPDATE run_cards SET notice = ?, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ? AND phase IN ('running','blocked')").run(notice, timestamp, id);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  markPromptDispatched(id: string): void {
    this.database.prepare("UPDATE prompt_jobs SET observation_state = 'attached', error = NULL, updated_at = ? WHERE id = ? AND state = 'running'").run(now(), id);
  }

  enqueuePrompt(input: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId">>): { prompt: PromptJob; inserted: boolean } {
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

  acceptPrompt(input: { prompt: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId">>; view: RunCardView; rootMessageId: string; taskCard?: object; answerCard: object }): { prompt: PromptJob; view: RunCardView; inserted: boolean } {
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
      const createCard = this.database.prepare(`
        INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, card_role, root_message_id, kind, payload, state, attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `);
      createCard.run(randomUUID(), `run-card:create:${input.prompt.id}:answer`, input.prompt.bindingId, input.prompt.id, input.view.viewVersion, "answer", input.rootMessageId, "stream_card_create", JSON.stringify(input.answerCard), timestamp, timestamp, timestamp);
      this.database.exec("COMMIT");
      return { prompt: this.getPrompt(input.prompt.id), view: this.loadRunCard(input.prompt.id)!, inserted: true };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  ensureAnswerCard(promptId: string, rootMessageId: string, card: object): void {
    const view = this.loadRunCard(promptId);
    if (!view || view.answerMessageId) return;
    const existing = this.database.prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key = ?").get(`run-card:create:${promptId}:answer`);
    if (existing) return;
    const prompt = this.getPrompt(promptId);
    this.enqueueOutboundReply({
      id: randomUUID(), idempotencyKey: `run-card:create:${promptId}:answer`, bindingId: prompt.bindingId, promptId, viewVersion: view.viewVersion,
      cardRole: "answer", rootMessageId, kind: "card_reply", payload: JSON.stringify(card)
    });
  }

  claimNextPrompt(bindingId: string): PromptJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(
        "SELECT * FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' ORDER BY created_at, id LIMIT 1"
      ).get(bindingId) as PromptRow | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      this.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'not_started', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?")
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
          AND NOT EXISTS (SELECT 1 FROM prompt_jobs active WHERE active.binding_id = p.binding_id AND active.state = 'running')
        ORDER BY p.created_at, p.rowid LIMIT 1
      `).get(bindingId) as PromptRow | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      const ready = this.database.prepare("SELECT lark_message_id, answer_message_id, answer_card_id FROM run_cards WHERE prompt_id = ?").get(row.id) as { lark_message_id: string | null; answer_message_id: string | null; answer_card_id: string | null };
      if (!ready.answer_message_id || (!ready.answer_card_id && !ready.lark_message_id)) { this.database.exec("COMMIT"); return null; }
      this.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'not_started', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(now(), row.id);
      this.database.exec("COMMIT");
      return this.getPrompt(row.id);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  claimNextDispatchablePrompt(bindingId: string): { binding: Binding; prompt: PromptJob } | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const bindingRow = this.database.prepare(`
        SELECT * FROM bindings WHERE id = ? AND state = 'active' AND lifecycle = 'active'
          AND attachment = 'attached' AND pane_id IS NOT NULL AND last_agent_state IN ('idle','done')
      `).get(bindingId) as BindingRow | undefined;
      if (!bindingRow) { this.database.exec("COMMIT"); return null; }
      const row = this.database.prepare(`
        SELECT p.* FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
        WHERE p.binding_id = ? AND p.state = 'queued' AND p.dispatch_kind = 'turn'
          AND c.answer_message_id IS NOT NULL AND (c.answer_card_id IS NOT NULL OR c.lark_message_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM prompt_jobs active WHERE active.binding_id = p.binding_id AND active.state = 'running')
        ORDER BY p.created_at, p.rowid LIMIT 1
      `).get(bindingId) as PromptRow | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      const claimed = this.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'not_started', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'queued'")
        .run(now(), row.id);
      if (Number(claimed.changes) !== 1) throw new Error(`Prompt ${row.id} was not atomically claimed`);
      const promptRow = this.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(row.id) as PromptRow;
      this.database.exec("COMMIT");
      return { binding: mapBinding(bindingRow), prompt: mapPrompt(promptRow) };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  claimNextReadySteering(bindingId: string, parentPromptId: string): PromptJob | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT p.* FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
        WHERE p.binding_id = ? AND p.parent_prompt_id = ? AND p.dispatch_kind = 'steering' AND p.state = 'queued'
          AND c.answer_message_id IS NOT NULL AND (c.answer_card_id IS NOT NULL OR c.lark_message_id IS NOT NULL)
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
    const observationState: PromptObservationState = state === "queued" ? "not_started" : state === "running" ? "attached" : "completed";
    this.database.prepare("UPDATE prompt_jobs SET state = ?, observation_state = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(state, observationState, error, now(), id);
  }

  cancelQueuedPrompts(bindingId: string, reason: string): number {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare("UPDATE prompt_jobs SET state = 'cancelled', error = ?, updated_at = ? WHERE binding_id = ? AND state = 'queued'").run(reason, timestamp, bindingId);
      this.database.prepare("UPDATE run_cards SET phase = 'failed', notice = ?, finished_at = ?, queue_position = 0, view_version = view_version + 1, updated_at = ? WHERE binding_id = ? AND phase = 'queued'").run(reason, timestamp, timestamp, bindingId);
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  enqueueOutboundReply(input: Omit<OutboundReply, "promptId" | "viewVersion" | "selectionId" | "cardRole" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "nextAttemptAt" | "createdAt" | "updatedAt"> & { promptId?: string | null; viewVersion?: number | null; selectionId?: string | null; cardRole?: OutboundReply["cardRole"] }): OutboundReply {
    const timestamp = now();
    if ((input.kind === "card_update" || input.kind === "stream_content") && input.promptId && input.viewVersion !== undefined && input.viewVersion !== null) {
      this.database.prepare("DELETE FROM outbound_replies WHERE prompt_id = ? AND root_message_id = ? AND kind = ? AND state = 'pending' AND card_role IS ? AND COALESCE(view_version, 0) < ?")
        .run(input.promptId, input.rootMessageId, input.kind, input.cardRole ?? null, input.viewVersion);
    }
    this.database.prepare(`
      INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, selection_id, card_role, root_message_id, kind, payload, state, attempt_count, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO UPDATE SET
        payload = CASE WHEN outbound_replies.state = 'pending' THEN excluded.payload ELSE outbound_replies.payload END,
        view_version = CASE WHEN outbound_replies.state = 'pending' THEN excluded.view_version ELSE outbound_replies.view_version END,
        updated_at = CASE WHEN outbound_replies.state = 'pending' THEN excluded.updated_at ELSE outbound_replies.updated_at END
    `).run(input.id, input.idempotencyKey, input.bindingId ?? null, input.promptId ?? null, input.viewVersion ?? null, input.selectionId ?? null, input.cardRole ?? null, input.rootMessageId, input.kind, input.payload, timestamp, timestamp, timestamp);
    const row = this.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key = ?").get(input.idempotencyKey) as OutboundReplyRow | undefined;
    if (!row) throw new Error(`Outbound reply not found: ${input.idempotencyKey}`);
    return mapOutboundReply(row);
  }

  listPendingOutboundReplies(): OutboundReply[] {
    return (this.database.prepare("SELECT * FROM outbound_replies WHERE state = 'pending' ORDER BY next_attempt_at, created_at, CASE card_role WHEN 'task' THEN 0 WHEN 'answer' THEN 1 ELSE 2 END, id").all() as OutboundReplyRow[]).map(mapOutboundReply);
  }

  listDueOutboundReplies(): OutboundReply[] {
    return (this.database.prepare("SELECT * FROM outbound_replies WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at, created_at, CASE card_role WHEN 'task' THEN 0 WHEN 'answer' THEN 1 ELSE 2 END, id").all(now()) as OutboundReplyRow[]).map(mapOutboundReply);
  }

  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT prompt_id, view_version, selection_id, card_role, kind, payload FROM outbound_replies WHERE id = ?").get(id) as { prompt_id: string | null; view_version: number | null; selection_id: string | null; card_role: string | null; kind: string; payload: string } | undefined;
      this.database.prepare("UPDATE outbound_replies SET state = 'delivered', delivered_message_id = ?, error = NULL, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(messageId, now(), id);
      if (row?.prompt_id) {
        if (row.card_role === "answer") {
          if (row.kind === "card_reply" || row.kind === "stream_card_create") {
            const stream = row.kind === "stream_card_create" ? streamCardState(row.payload) : null;
            this.database.prepare("UPDATE run_cards SET answer_message_id = ?, answer_card_id = COALESCE(?, answer_card_id), answer_element_id = COALESCE(?, answer_element_id), answer_sequence = CASE WHEN ? IS NULL THEN answer_sequence ELSE 0 END, answer_page_index = COALESCE(?, answer_page_index), answer_page_start = COALESCE(?, answer_page_start), lark_message_id = CASE WHEN ? IS NULL THEN COALESCE(lark_message_id, ?) ELSE lark_message_id END, answer_delivered_version = MAX(answer_delivered_version, ?), updated_at = ? WHERE prompt_id = ?")
              .run(messageId, cardId ?? null, stream?.elementId ?? null, stream ? 1 : null, stream?.pageIndex ?? null, stream?.pageStart ?? null, cardId ?? null, messageId, row.view_version ?? 0, now(), row.prompt_id);
          }
          else this.database.prepare("UPDATE run_cards SET answer_delivered_version = MAX(answer_delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(row.view_version ?? 0, now(), row.prompt_id);
        } else if (row.kind === "card_reply") this.database.prepare("UPDATE run_cards SET lark_message_id = ?, delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(messageId, row.view_version ?? 0, now(), row.prompt_id);
        else this.database.prepare("UPDATE run_cards SET delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(row.view_version ?? 0, now(), row.prompt_id);
      }
      if (row?.selection_id && row.kind === "card_reply") this.database.prepare("UPDATE project_selections SET selector_message_id = ?, updated_at = ? WHERE id = ?").run(messageId, now(), row.selection_id);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  markOutboundReplyFailed(id: string, error: string): OutboundReply | null {
    const row = this.database.prepare("SELECT attempt_count FROM outbound_replies WHERE id = ?").get(id) as { attempt_count: number } | undefined;
    if (!row) return null;
    const attempts = Number(row.attempt_count) + 1;
    const timestamp = now();
    if (attempts >= 5) {
      this.database.prepare("UPDATE outbound_replies SET state = 'dead_letter', error = ?, attempt_count = ?, updated_at = ? WHERE id = ?").run(error, attempts, timestamp, id);
      return this.getOutboundReply(id);
    }
    this.database.prepare("UPDATE outbound_replies SET error = ?, attempt_count = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
      .run(error, attempts, retryAt(attempts), timestamp, id);
    return this.getOutboundReply(id);
  }

  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.changeDeadLetter(id, chatId, actorOpenId, "retry");
  }

  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.changeDeadLetter(id, chatId, actorOpenId, "dismiss");
  }

  private changeDeadLetter(id: string, chatId: string, actorOpenId: string, action: "retry" | "dismiss"): DeadLetterActionOutcome {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`SELECT o.state, COALESCE(b.chat_id, s.chat_id) AS chat_id FROM outbound_replies o LEFT JOIN bindings b ON b.id = o.binding_id LEFT JOIN project_selections s ON s.id = o.selection_id WHERE o.id = ?`).get(id) as { state: OutboundReplyState; chat_id: string | null } | undefined;
      let outcome: DeadLetterActionOutcome;
      if (!row) outcome = "missing";
      else if (row.chat_id !== chatId) outcome = "unauthorized";
      else if (row.state !== "dead_letter") outcome = "stale";
      else {
        const nextState = action === "retry" ? "pending" : "dismissed";
        this.database.prepare("UPDATE outbound_replies SET state = ?, error = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND state = 'dead_letter'").run(nextState, now(), now(), id);
        outcome = action === "retry" ? "retried" : "dismissed";
      }
      this.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, ?, ?, ?, ?)").run(actorOpenId, `outbound.${action}`, id, outcome, now());
      this.database.exec("COMMIT");
      return outcome;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  getOperationalSummary(): OperationalSummary {
    const groupedCounts = <T extends string>(table: string, column: string, values: readonly T[]): Record<T, number> => {
      const result = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
      const rows = this.database.prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all() as Array<{ value: T; count: number }>;
      for (const row of rows) result[row.value] = Number(row.count);
      return result;
    };
    const recentFailedPrompt = this.database.prepare("SELECT id, binding_id, updated_at, error FROM prompt_jobs WHERE state = 'failed' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as { id: string; binding_id: string; updated_at: string; error: string | null } | undefined;
    const recentDeadLetter = this.database.prepare("SELECT id, binding_id, prompt_id, attempt_count, updated_at, error FROM outbound_replies WHERE state = 'dead_letter' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as { id: string; binding_id: string | null; prompt_id: string | null; attempt_count: number; updated_at: string; error: string | null } | undefined;
    const oldestPending = this.database.prepare("SELECT MIN(created_at) AS value FROM outbound_replies WHERE state = 'pending'").get() as { value: string | null };
    const outbound = groupedCounts<OutboundReplyState>("outbound_replies", "state", ["pending", "delivered", "dead_letter", "dismissed"]);
    const oldestInactive = this.database.prepare("SELECT MIN(last_activity_at) AS value FROM bindings WHERE lifecycle != 'active' OR attachment != 'attached'").get() as { value: string | null };
    const recoverableProvisioning = this.database.prepare("SELECT COUNT(*) AS count FROM project_selections WHERE state = 'processing' AND binding_id IS NOT NULL").get() as { count: number };
    const archivedPanesPresent = this.database.prepare("SELECT COUNT(*) AS count FROM bindings WHERE lifecycle = 'archived' AND pane_id IS NOT NULL").get() as { count: number };
    const cleanupCandidates = this.database.prepare("SELECT COUNT(*) AS count FROM bindings WHERE lifecycle = 'archived' AND pane_id IS NOT NULL AND archived_at <= datetime('now', '-30 days')").get() as { count: number };
    return {
      bindings: groupedCounts<BindingState>("bindings", "state", ["pending", "active", "archived", "orphaned", "failed"]),
      prompts: groupedCounts<PromptState>("prompt_jobs", "state", ["queued", "running", "delivered", "failed", "cancelled"]),
      promptDispatch: groupedCounts<PromptDispatchKind>("prompt_jobs", "dispatch_kind", ["turn", "steering"]),
      outbound, pendingOutbox: outbound.pending, deadLetters: outbound.dead_letter, oldestPendingAt: oldestPending.value,
      lifecycle: groupedCounts<SessionLifecycle>("bindings", "lifecycle", ["provisioning", "active", "draining", "archived", "closed", "failed"]),
      attachment: groupedCounts<AttachmentState>("bindings", "attachment", ["unattached", "attached", "degraded", "orphaned"]),
      recoverableProvisioning: Number(recoverableProvisioning.count), archivedPanesPresent: Number(archivedPanesPresent.count),
      cleanupCandidates: Number(cleanupCandidates.count), oldestInactiveAt: oldestInactive.value,
      recentFailedPrompt: recentFailedPrompt ? { promptId: recentFailedPrompt.id, bindingId: recentFailedPrompt.binding_id, updatedAt: recentFailedPrompt.updated_at, error: boundedError(recentFailedPrompt.error) } : null,
      recentDeadLetter: recentDeadLetter ? { replyId: recentDeadLetter.id, bindingId: recentDeadLetter.binding_id, promptId: recentDeadLetter.prompt_id, attemptCount: Number(recentDeadLetter.attempt_count), updatedAt: recentDeadLetter.updated_at, error: boundedError(recentDeadLetter.error) } : null
    };
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
    this.database.prepare(`UPDATE run_cards SET lark_message_id = ?, answer_message_id = ?, answer_card_id = ?, answer_element_id = ?, answer_sequence = ?, answer_page_index = ?, answer_page_start = ?, phase = ?, title = ?, request_text = ?, workspace_id = ?, space_name = ?, pane_id = ?, answer = ?, answer_segments_json = ?, answer_draft = ?, answer_draft_transient = ?, progress_events_json = ?, queue_position = ?, started_at = ?, finished_at = ?, notice = ?, view_version = ?, delivered_version = ?, answer_delivered_version = ?, updated_at = ? WHERE prompt_id = ?`)
      .run(view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.requestText, view.workspaceId, view.spaceName, view.paneId, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), view.queuePosition, view.startedAt, view.finishedAt, view.notice, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.updatedAt, view.promptId);
    return this.loadRunCard(view.promptId)!;
  }

  loadRunCard(promptId: string): RunCardView | null {
    const row = this.database.prepare("SELECT state_json FROM run_cards_view WHERE prompt_id = ?").get(promptId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as RunCardView : null;
  }

  listRunCards(bindingId: string): RunCardView[] {
    return (this.database.prepare("SELECT state_json FROM run_cards_view WHERE binding_id = ? ORDER BY created_at, prompt_id").all(bindingId) as Array<{ state_json: string }>).map((row) => JSON.parse(row.state_json) as RunCardView);
  }

  listRunCardsByPhases(bindingId: string, phases: readonly RunCardView["phase"][]): RunCardView[] {
    if (phases.length === 0) return [];
    const placeholders = phases.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT view.state_json FROM run_cards AS card INDEXED BY run_cards_binding_phase_created
      JOIN run_cards_view AS view ON view.prompt_id = card.prompt_id
      WHERE card.binding_id = ? AND card.phase IN (${placeholders})
      ORDER BY card.created_at, card.prompt_id
    `)
      .all(bindingId, ...phases) as Array<{ state_json: string }>;
    return rows.map((row) => JSON.parse(row.state_json) as RunCardView);
  }

  private insertRunCard(view: RunCardView): void {
    this.database.prepare(`INSERT INTO run_cards(prompt_id, binding_id, lark_message_id, answer_message_id, answer_card_id, answer_element_id, answer_sequence, answer_page_index, answer_page_start, phase, title, request_text, workspace_id, space_name, pane_id, answer, answer_segments_json, answer_draft, answer_draft_transient, progress_events_json, queue_position, started_at, finished_at, notice, view_version, delivered_version, answer_delivered_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(view.promptId, view.bindingId, view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.requestText, view.workspaceId, view.spaceName, view.paneId, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), view.queuePosition, view.startedAt, view.finishedAt, view.notice, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.createdAt, view.updatedAt);
  }

  private requireBinding(id: string): Binding {
    const row = this.database.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as BindingRow | undefined;
    if (!row) throw new Error(`Binding not found: ${id}`);
    return mapBinding(row);
  }

  private getPrompt(id: string): PromptJob {
    const row = this.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(id) as PromptRow | undefined;
    if (!row) throw new Error(`Prompt not found: ${id}`);
    return mapPrompt(row);
  }

  private getOutboundReply(id: string): OutboundReply | null {
    const row = this.database.prepare("SELECT * FROM outbound_replies WHERE id = ?").get(id) as OutboundReplyRow | undefined;
    return row ? mapOutboundReply(row) : null;
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS instance_lease(
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1), owner_id TEXT NOT NULL, fencing_token INTEGER NOT NULL,
        expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bindings(
        id TEXT PRIMARY KEY, project_id TEXT, workspace_id TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id TEXT UNIQUE,
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
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed','cancelled')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prompt_jobs_queue ON prompt_jobs(binding_id, state, created_at);
      CREATE TABLE IF NOT EXISTS outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, view_version INTEGER, selection_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0,
        error TEXT, delivered_message_id TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbound_replies_pending ON outbound_replies(state, created_at);
      CREATE TABLE IF NOT EXISTS project_selections(
        id TEXT PRIMARY KEY, command_message_id TEXT UNIQUE NOT NULL, selector_message_id TEXT, chat_id TEXT NOT NULL, topic_id TEXT, root_message_id TEXT NOT NULL, actor_open_id TEXT NOT NULL,
        requested_title TEXT, selected_project_id TEXT, binding_id TEXT REFERENCES bindings(id), state TEXT NOT NULL CHECK(state IN ('pending','processing','completed','failed','expired')),
        error TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pane_close_requests(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), pane_id TEXT NOT NULL, actor_open_id TEXT NOT NULL, code_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','consumed','executing','succeeded','rejected','uncertain','expired','cancelled')), detail TEXT, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pane_close_requests_binding_state ON pane_close_requests(binding_id, state, created_at);
      CREATE TABLE IF NOT EXISTS audit_log(
        id INTEGER PRIMARY KEY AUTOINCREMENT, actor_open_id TEXT NOT NULL, action TEXT NOT NULL,
        target TEXT NOT NULL, outcome TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lifecycle_events(
        event_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topic_views(
        binding_id TEXT PRIMARY KEY REFERENCES bindings(id), state_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_cards(
        prompt_id TEXT PRIMARY KEY REFERENCES prompt_jobs(id), binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT, answer_message_id TEXT, answer_card_id TEXT, answer_element_id TEXT NOT NULL DEFAULT '', answer_sequence INTEGER NOT NULL DEFAULT 0, answer_page_index INTEGER NOT NULL DEFAULT 0, answer_page_start INTEGER NOT NULL DEFAULT 0,
        phase TEXT NOT NULL CHECK(phase IN ('queued','running','blocked','completed','failed')), title TEXT NOT NULL, request_text TEXT NOT NULL DEFAULT '', workspace_id TEXT NOT NULL, space_name TEXT NOT NULL DEFAULT 'unknown', pane_id TEXT,
        answer TEXT NOT NULL, answer_segments_json TEXT NOT NULL DEFAULT '[]', answer_draft TEXT NOT NULL DEFAULT '', answer_draft_transient INTEGER NOT NULL DEFAULT 0, progress_events_json TEXT NOT NULL, queue_position INTEGER NOT NULL, started_at TEXT, finished_at TEXT, notice TEXT,
        view_version INTEGER NOT NULL, delivered_version INTEGER NOT NULL, answer_delivered_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_cards_binding ON run_cards(binding_id, created_at);
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `);
    this.ensureOutboundReplyColumns();
    this.ensureRequestCardOutboxColumns();
    this.ensureRunCardRequestText();
    this.ensureRunCardSpaceName();
    this.ensureDualRequestCardColumns();
    this.ensureRunCardAnswerState();
    this.ensureStreamingCardColumns();
    this.ensurePromptDispatchColumns();
    this.ensureProjectSelectionColumns();
    this.ensureBindingLifecycleColumns();
    this.ensurePromptCancelledState();
    this.ensurePromptObservationColumn();
    this.ensureOutboundDismissedState();
    this.ensurePaneCloseOperationState();
    this.ensureQueryIndexes();
  }

  private ensureQueryIndexes(): void {
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS bindings_state_created ON bindings(state, created_at, id);
      CREATE INDEX IF NOT EXISTS bindings_root_created ON bindings(root_message_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS run_cards_binding_phase_created ON run_cards(binding_id, phase, created_at, prompt_id);
    `);
  }

  private ensureOutboundDismissedState(): void {
    const schema = this.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_replies'").get() as { sql: string } | undefined;
    if (schema?.sql.includes("'dismissed'") && schema.sql.includes("'stream_card_create'")) return;
    this.database.exec(`
      PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;
      CREATE TABLE outbound_replies_next(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, view_version INTEGER, selection_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO outbound_replies_next(id, idempotency_key, binding_id, prompt_id, view_version, selection_id, card_role, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, next_attempt_at, created_at, updated_at)
      SELECT id, idempotency_key, binding_id, prompt_id, view_version, selection_id, card_role, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, next_attempt_at, created_at, updated_at FROM outbound_replies;
      DROP TABLE outbound_replies; ALTER TABLE outbound_replies_next RENAME TO outbound_replies;
      CREATE INDEX outbound_replies_pending ON outbound_replies(state, next_attempt_at, created_at); COMMIT; PRAGMA foreign_keys = ON;
    `);
    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) throw new Error(`Outbound-state migration produced a foreign-key violation: ${JSON.stringify(violation)}`);
  }

  private ensureStreamingCardColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("answer_card_id")) this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_card_id TEXT");
    if (!names.has("answer_element_id")) this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_element_id TEXT NOT NULL DEFAULT ''");
    if (!names.has("answer_sequence")) this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_sequence INTEGER NOT NULL DEFAULT 0");
    if (!names.has("answer_page_index")) this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_page_index INTEGER NOT NULL DEFAULT 0");
    if (!names.has("answer_page_start")) this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_page_start INTEGER NOT NULL DEFAULT 0");
    this.database.exec("UPDATE run_cards SET answer_element_id = 'answer-content-' || replace(prompt_id, ':', '-') WHERE answer_element_id = ''");
    this.recreateRunCardsView();
  }

  private ensurePromptCancelledState(): void {
    const schema = this.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'prompt_jobs'").get() as { sql: string } | undefined;
    if (schema?.sql.includes("'cancelled'")) return;
    this.database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE prompt_jobs_next(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE NOT NULL,
        actor_open_id TEXT NOT NULL, body TEXT NOT NULL, dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering')), parent_prompt_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed','cancelled')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO prompt_jobs_next(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, state, attempt_count, error, created_at, updated_at) SELECT id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, state, attempt_count, error, created_at, updated_at FROM prompt_jobs;
      DROP TABLE prompt_jobs;
      ALTER TABLE prompt_jobs_next RENAME TO prompt_jobs;
      CREATE INDEX prompt_jobs_queue ON prompt_jobs(binding_id, state, created_at);
      CREATE INDEX prompt_jobs_dispatch ON prompt_jobs(binding_id, dispatch_kind, parent_prompt_id, state, created_at);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) throw new Error(`Prompt-state migration produced a foreign-key violation: ${JSON.stringify(violation)}`);
  }

  private ensureBindingLifecycleColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("lifecycle")) this.database.exec("ALTER TABLE bindings ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'provisioning' CHECK(lifecycle IN ('provisioning','active','draining','archived','closed','failed'))");
    if (!names.has("attachment")) this.database.exec("ALTER TABLE bindings ADD COLUMN attachment TEXT NOT NULL DEFAULT 'unattached' CHECK(attachment IN ('unattached','attached','degraded','orphaned'))");
    if (!names.has("generation")) this.database.exec("ALTER TABLE bindings ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
    if (!names.has("provisioning_checkpoint")) this.database.exec("ALTER TABLE bindings ADD COLUMN provisioning_checkpoint TEXT NOT NULL DEFAULT 'selected' CHECK(provisioning_checkpoint IN ('selected','pane_created','runtime_started','thread_created','activated'))");
    if (!names.has("degradation_count")) this.database.exec("ALTER TABLE bindings ADD COLUMN degradation_count INTEGER NOT NULL DEFAULT 0");
    if (!names.has("has_completed_turn")) this.database.exec("ALTER TABLE bindings ADD COLUMN has_completed_turn INTEGER NOT NULL DEFAULT 0");
    if (!names.has("last_observed_at")) this.database.exec("ALTER TABLE bindings ADD COLUMN last_observed_at TEXT");
    if (!names.has("archived_at")) this.database.exec("ALTER TABLE bindings ADD COLUMN archived_at TEXT");
    if (!names.has("last_activity_at")) this.database.exec("ALTER TABLE bindings ADD COLUMN last_activity_at TEXT");
    this.database.exec(`
      UPDATE bindings SET
        lifecycle = CASE state WHEN 'active' THEN 'active' WHEN 'archived' THEN 'archived' WHEN 'failed' THEN 'failed' WHEN 'orphaned' THEN 'active' ELSE lifecycle END,
        attachment = CASE WHEN state = 'orphaned' THEN 'orphaned' WHEN pane_id IS NOT NULL THEN 'attached' ELSE attachment END,
        provisioning_checkpoint = CASE WHEN state IN ('active','archived','orphaned') THEN 'activated' WHEN pane_id IS NOT NULL THEN 'pane_created' ELSE provisioning_checkpoint END,
        archived_at = CASE WHEN state = 'archived' THEN COALESCE(archived_at, updated_at) ELSE archived_at END,
        last_activity_at = COALESCE(last_activity_at, updated_at);
    `);
  }

  private ensureProjectSelectionColumns(): void {
    const bindingColumns = this.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>;
    if (!bindingColumns.some((column) => column.name === "project_id")) this.database.exec("ALTER TABLE bindings ADD COLUMN project_id TEXT");
    const outboundColumns = this.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!outboundColumns.some((column) => column.name === "selection_id")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN selection_id TEXT");
  }

  private ensurePromptDispatchColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("dispatch_kind")) this.database.exec("ALTER TABLE prompt_jobs ADD COLUMN dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering'))");
    if (!names.has("parent_prompt_id")) this.database.exec("ALTER TABLE prompt_jobs ADD COLUMN parent_prompt_id TEXT");
    this.database.exec("CREATE INDEX IF NOT EXISTS prompt_jobs_dispatch ON prompt_jobs(binding_id, dispatch_kind, parent_prompt_id, state, created_at)");
  }

  private ensurePromptObservationColumn(): void {
    const columns = this.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "observation_state")) {
      this.database.exec("ALTER TABLE prompt_jobs ADD COLUMN observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed'))");
    }
    this.database.exec("UPDATE prompt_jobs SET observation_state = CASE WHEN state = 'running' THEN 'attached' WHEN state = 'queued' THEN 'not_started' ELSE 'completed' END WHERE observation_state = 'not_started' AND state != 'queued'");
  }

  private ensurePaneCloseOperationState(): void {
    const columns = this.database.prepare("PRAGMA table_info(pane_close_requests)").all() as Array<{ name: string }>;
    const schema = this.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pane_close_requests'").get() as { sql: string } | undefined;
    if (columns.some((column) => column.name === "detail") && schema?.sql.includes("'uncertain'")) return;
    this.database.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      ALTER TABLE pane_close_requests RENAME TO pane_close_requests_legacy;
      CREATE TABLE pane_close_requests(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), pane_id TEXT NOT NULL, actor_open_id TEXT NOT NULL, code_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','consumed','executing','succeeded','rejected','uncertain','expired','cancelled')), detail TEXT, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO pane_close_requests(id, binding_id, pane_id, actor_open_id, code_hash, state, expires_at, consumed_at, created_at, updated_at)
      SELECT id, binding_id, pane_id, actor_open_id, code_hash, state, expires_at, consumed_at, created_at, updated_at FROM pane_close_requests_legacy;
      DROP TABLE pane_close_requests_legacy;
      CREATE INDEX pane_close_requests_binding_state ON pane_close_requests(binding_id, state, created_at);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  private ensureRequestCardOutboxColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("prompt_id")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN prompt_id TEXT");
    if (!names.has("view_version")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN view_version INTEGER");
    if (!names.has("card_role")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN card_role TEXT CHECK(card_role IN ('task','answer'))");
  }

  private ensureDualRequestCardColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("answer_message_id")) this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_message_id TEXT");
    if (!names.has("answer_delivered_version")) this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_delivered_version INTEGER NOT NULL DEFAULT 0");
    this.recreateRunCardsView();
  }

  private ensureRunCardAnswerState(): void {
    const columns = this.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("answer_segments_json")) this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_segments_json TEXT NOT NULL DEFAULT '[]'");
    if (!names.has("answer_draft")) this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_draft TEXT NOT NULL DEFAULT ''");
    if (!names.has("answer_draft_transient")) this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_draft_transient INTEGER NOT NULL DEFAULT 0");
    this.database.exec("UPDATE run_cards SET answer_segments_json = json_array(answer) WHERE answer <> '' AND answer_segments_json = '[]' AND answer_draft = ''");
    this.recreateRunCardsView();
  }

  private ensureRunCardRequestText(): void {
    const columns = this.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "request_text")) {
      this.database.exec("ALTER TABLE run_cards ADD COLUMN request_text TEXT NOT NULL DEFAULT ''");
    }
    this.database.exec("UPDATE run_cards SET request_text = COALESCE((SELECT body FROM prompt_jobs WHERE prompt_jobs.id = run_cards.prompt_id), '') WHERE request_text = ''");
  }

  private ensureRunCardSpaceName(): void {
    const columns = this.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "space_name")) this.database.exec("ALTER TABLE run_cards ADD COLUMN space_name TEXT NOT NULL DEFAULT 'unknown'");
  }

  private recreateRunCardsView(): void {
    this.database.exec(`
      DROP VIEW IF EXISTS run_cards_view;
      CREATE VIEW run_cards_view AS SELECT *, json_object(
        'promptId', prompt_id, 'bindingId', binding_id, 'larkMessageId', lark_message_id, 'answerMessageId', answer_message_id, 'answerCardId', answer_card_id, 'answerElementId', answer_element_id, 'answerSequence', answer_sequence, 'answerPageIndex', answer_page_index, 'answerPageStart', answer_page_start, 'phase', phase, 'title', title, 'requestText', request_text,
        'workspaceId', workspace_id, 'spaceName', space_name, 'paneId', pane_id, 'answer', answer, 'answerSegments', json(answer_segments_json), 'answerDraft', answer_draft, 'answerDraftTransient', CASE WHEN answer_draft_transient = 1 THEN json('true') ELSE json('false') END, 'progressEvents', json(progress_events_json),
        'queuePosition', queue_position, 'startedAt', started_at, 'finishedAt', finished_at, 'notice', notice,
        'viewVersion', view_version, 'deliveredVersion', delivered_version, 'answerDeliveredVersion', answer_delivered_version, 'createdAt', created_at, 'updatedAt', updated_at
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
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL,
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
function mapInstanceLease(row: { owner_id: string; fencing_token: number; expires_at: string; updated_at: string }): InstanceLease {
  return { ownerId: row.owner_id, fencingToken: Number(row.fencing_token), expiresAt: row.expires_at, updatedAt: row.updated_at };
}
function boundedError(value: string | null): string { return (value ?? "Unknown failure").slice(0, 500); }
function retryAt(attempt: number): string { return new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** (attempt - 1))).toISOString(); }
function streamCardState(payload: string): { pageIndex: number; pageStart: number; elementId: string } | null {
  try {
    const decoded = JSON.parse(payload) as { stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown } };
    const stream = decoded.stream;
    return stream && Number.isInteger(stream.pageIndex) && Number.isInteger(stream.pageStart) && typeof stream.elementId === "string"
      ? { pageIndex: Number(stream.pageIndex), pageStart: Number(stream.pageStart), elementId: stream.elementId } : null;
  } catch { return null; }
}

function mapBinding(row: BindingRow): Binding {
  return {
    id: row.id, projectId: row.project_id, workspaceId: row.workspace_id, chatId: row.chat_id, topicId: row.topic_id,
    rootMessageId: row.root_message_id, paneId: row.pane_id, traexSessionId: row.traex_session_id,
    title: row.title, runtime: "traex", state: row.state as BindingState, statusMessageId: row.status_message_id,
    lastAgentState: row.last_agent_state as AgentState, lastOutputFingerprint: row.last_output_fingerprint,
    lifecycle: row.lifecycle as SessionLifecycle, attachment: row.attachment as AttachmentState, generation: Number(row.generation),
    provisioningCheckpoint: row.provisioning_checkpoint as ProvisioningCheckpoint, degradationCount: Number(row.degradation_count),
    hasCompletedTurn: Boolean(row.has_completed_turn), lastObservedAt: row.last_observed_at, archivedAt: row.archived_at, lastActivityAt: row.last_activity_at,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapPrompt(row: PromptRow): PromptJob {
  return {
    id: row.id, bindingId: row.binding_id, larkMessageId: row.lark_message_id, actorOpenId: row.actor_open_id,
    body: row.body, dispatchKind: row.dispatch_kind as PromptDispatchKind, parentPromptId: row.parent_prompt_id, observationState: row.observation_state as PromptObservationState, state: row.state as PromptState, attemptCount: Number(row.attempt_count), error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapOutboundReply(row: OutboundReplyRow): OutboundReply {
  return {
    id: row.id, idempotencyKey: row.idempotency_key, bindingId: row.binding_id, rootMessageId: row.root_message_id,
    promptId: row.prompt_id, viewVersion: row.view_version === null ? null : Number(row.view_version), selectionId: row.selection_id, cardRole: row.card_role as RequestCardRole | null, kind: row.kind as OutboundReplyKind, payload: row.payload, state: row.state as OutboundReplyState,
    attemptCount: Number(row.attempt_count), error: row.error, deliveredMessageId: row.delivered_message_id, nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function mapProjectSelection(row: ProjectSelectionRow): ProjectSelection {
  return {
    id: row.id, commandMessageId: row.command_message_id, selectorMessageId: row.selector_message_id, chatId: row.chat_id, topicId: row.topic_id, rootMessageId: row.root_message_id,
    actorOpenId: row.actor_open_id, requestedTitle: row.requested_title, selectedProjectId: row.selected_project_id, bindingId: row.binding_id,
    state: row.state as ProjectSelectionState, error: row.error, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at
  };
}
