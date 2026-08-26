import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BindingStorePort } from "../domain/ports.js";
import type { AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, Binding, BindingMetadataPatch, BindingState, DeadLetterActionOutcome, DeliveryFailureClass, DeliveryFailureMetadata, DurablePromptWorkScan, FailureSummary, HerdrPane, IncomingLarkMessage, InstanceLease, OperationalSummary, OutboundReply, OutboundReplyState, OutboundTargetRole, PaneCloseOperation, PaneControlOperation, PaneControlOperationKind, PaneControlOperationState, ProjectSelection, ProjectSelectionClaim, PromptDispatchKind, PromptJob, PromptObservationState, PromptState, PromptWorkHint, RequestCardRole, RetiredPaneCleanupOperation, RetiredPaneCleanupState, RuntimeObservationApplication, SessionSummary } from "../domain/types.js";
import type { TopicViewState } from "../domain/topic-view.js";
import type { RunCardView } from "../domain/run-card-view.js";
import { answerElementId, reduceRunCard } from "../domain/run-card-view.js";
import { mirrorRunCardToTopic } from "../domain/topic-view.js";
import type { BridgeEvent } from "../domain/events.js";
import { transitionSession, type AttachmentState, type SessionLifecycle, type SessionTransition } from "../domain/pane-thread-lifecycle.js";
import { normalizeLarkCardElementIds, normalizeLarkElementId } from "../runtime/lark-card-id.js";
import { paneControlOutcomeSources, type PaneControlOutcome } from "../domain/pane-control-lifecycle.js";
import { outboundLaneKey, outboundLaneKeySql } from "./outbox-lanes.js";
import { mapAnswerPage, mapBinding, mapInstanceLease, mapOutboundReply, mapPaneControlOperation, mapProjectSelection, mapPrompt, mapRetiredPaneCleanup, type AnswerPageRow, type BindingRow, type OutboundReplyRow, type PaneControlOperationRow, type ProjectSelectionRow, type PromptRow, type RetiredPaneCleanupRow, type SqlValue } from "./sqlite-records.js";

const FENCED_TABLES = [
  "bindings", "inbound_messages", "bridge_messages", "prompt_jobs", "outbound_replies",
  "outbox_lane_heads",
  "project_selections", "pane_close_requests", "pane_control_operations", "retired_pane_cleanup_operations", "audit_log", "lifecycle_events", "topic_views", "run_cards", "answer_pages"
] as const;

const BINDING_COLUMNS: Record<keyof Binding, string> = {
  id: "id", projectId: "project_id", workspaceId: "workspace_id", chatId: "chat_id", topicId: "topic_id",
    rootMessageId: "root_message_id", retiredTopicId: "retired_topic_id", retiredRootMessageId: "retired_root_message_id", replacesBindingId: "replaces_binding_id", reservedTopicId: "reserved_topic_id", reservedRootMessageId: "reserved_root_message_id", resetMessageId: "reset_message_id", paneId: "pane_id", traexSessionId: "traex_session_id",
  agentSessionSource: "agent_session_source", agentSessionAgent: "agent_session_agent", agentSessionKind: "agent_session_kind", agentSessionValue: "agent_session_value",
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
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT 1 FROM inbound_messages WHERE event_id = ? OR message_id = ?").get(message.eventId, message.messageId);
      if (existing) { this.database.exec("COMMIT"); return false; }
      const timestamp = now();
      const result = this.database.prepare(`
        INSERT INTO inbound_messages(event_id, message_id, payload_json, state, created_at, updated_at)
        VALUES (?, ?, ?, 'received', ?, ?)
      `).run(message.eventId, message.messageId, JSON.stringify(message), timestamp, timestamp);
      this.database.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
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

  createResetCandidate(input: { oldBindingId: string; newBindingId: string; title: string; actorOpenId: string; resetMessageId: string }): { previous: Binding; replacement: Binding; created: boolean } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.requireBinding(input.oldBindingId);
      const existing = this.database.prepare("SELECT * FROM bindings WHERE reset_message_id = ?").get(input.resetMessageId) as BindingRow | undefined;
      if (existing) { this.database.exec("COMMIT"); return { previous, replacement: mapBinding(existing), created: false }; }
      if (previous.lifecycle !== "active" || previous.state !== "active" || !previous.projectId || !previous.topicId || !previous.rootMessageId) throw new Error("Binding is not eligible for in-topic reset");
      const timestamp = now();
      this.database.prepare(`INSERT INTO bindings(id, project_id, workspace_id, chat_id, topic_id, root_message_id, replaces_binding_id, reserved_topic_id, reserved_root_message_id, reset_message_id, title, runtime, state, last_agent_state, lifecycle, attachment, generation, provisioning_checkpoint, degradation_count, has_completed_turn, last_activity_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'traex', 'pending', 'unknown', 'provisioning', 'unattached', 1, 'selected', 0, 0, ?, ?, ?)` )
        .run(input.newBindingId, previous.projectId, previous.workspaceId, previous.chatId, previous.id, previous.topicId, previous.rootMessageId, input.resetMessageId, input.title, timestamp, timestamp, timestamp);
      this.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, 'binding.reset.candidate', ?, 'created', ?)")
        .run(input.actorOpenId, `${previous.id}:${input.newBindingId}`, timestamp);
      this.database.exec("COMMIT");
      return { previous, replacement: this.requireBinding(input.newBindingId), created: true };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  cutoverResetCandidate(input: { oldBindingId: string; newBindingId: string; cleanupOperationId: string; actorOpenId: string; expectedCwd: string }): { previous: Binding; replacement: Binding; cleanup: RetiredPaneCleanupOperation; cancelledPromptIds: string[] } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.requireBinding(input.oldBindingId);
      const candidate = this.requireBinding(input.newBindingId);
      if (previous.lifecycle !== "active" || previous.state !== "active" || !previous.projectId || !previous.topicId || !previous.rootMessageId || !previous.paneId || !previous.traexSessionId) throw new Error("Binding is not eligible for reset cutover");
      if (candidate.replacesBindingId !== previous.id || candidate.reservedTopicId !== previous.topicId || candidate.reservedRootMessageId !== previous.rootMessageId || candidate.lifecycle !== "provisioning" || candidate.provisioningCheckpoint !== "runtime_started" || !candidate.paneId || !candidate.traexSessionId) throw new Error("Reset candidate is not ready for cutover");
      const timestamp = now();
      const cancelledPromptIds = (this.database.prepare("SELECT id FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' ORDER BY created_at, id").all(previous.id) as Array<{ id: string }>).map((row) => row.id);
      this.database.prepare("UPDATE prompt_jobs SET state = 'cancelled', error = ?, updated_at = ? WHERE binding_id = ? AND state = 'queued'")
        .run("话题已开启新会话，排队请求未提交给 TraeX。", timestamp, previous.id);
      this.database.prepare("UPDATE prompt_jobs SET observation_state = 'detached', error = ?, updated_at = ? WHERE binding_id = ? AND state = 'running'")
        .run("话题已开启新会话；Bridge 不再观察该 TraeX 请求，也不会重放。", timestamp, previous.id);
      this.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = ?, updated_at = ? WHERE binding_id = ? AND state = 'pending'")
        .run("话题已开启新会话；不再投递旧会话更新。", timestamp, previous.id);
      this.database.prepare(`UPDATE bindings SET topic_id = NULL, root_message_id = NULL, retired_topic_id = ?, retired_root_message_id = ?, lifecycle = 'archived', state = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`)
        .run(previous.topicId, previous.rootMessageId, timestamp, timestamp, previous.id);
      this.database.prepare(`UPDATE bindings SET topic_id = ?, root_message_id = ?, status_message_id = ?, lifecycle = 'active', attachment = 'attached', state = 'active', provisioning_checkpoint = 'activated', updated_at = ? WHERE id = ?`)
        .run(previous.topicId, previous.rootMessageId, previous.rootMessageId, timestamp, candidate.id);
      this.database.prepare(`INSERT INTO retired_pane_cleanup_operations(id, old_binding_id, replacement_binding_id, pane_id, expected_workspace_id, expected_project_id, expected_cwd, expected_terminal_id, actor_open_id, state, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)` )
        .run(input.cleanupOperationId, previous.id, candidate.id, previous.paneId, previous.workspaceId, previous.projectId, input.expectedCwd, previous.traexSessionId, input.actorOpenId, timestamp, timestamp);
      this.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, 'binding.reset', ?, 'cutover', ?)")
        .run(input.actorOpenId, `${previous.id}:${input.newBindingId}`, timestamp);
      this.database.exec("COMMIT");
      return { previous: this.requireBinding(previous.id), replacement: this.requireBinding(input.newBindingId), cleanup: this.requireRetiredPaneCleanup(input.cleanupOperationId), cancelledPromptIds };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  listRetiredPaneCleanupOperations(states: readonly RetiredPaneCleanupState[] = ["pending", "waiting_busy", "executing"]): RetiredPaneCleanupOperation[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    return (this.database.prepare(`SELECT * FROM retired_pane_cleanup_operations WHERE state IN (${placeholders}) ORDER BY created_at, id`).all(...states) as RetiredPaneCleanupRow[]).map(mapRetiredPaneCleanup);
  }

  claimRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null {
    const result = this.database.prepare("UPDATE retired_pane_cleanup_operations SET state = 'executing', attempt_count = attempt_count + 1, detail = NULL, updated_at = ? WHERE id = ? AND state IN ('pending','waiting_busy')").run(now(), id);
    return result.changes === 1 ? this.requireRetiredPaneCleanup(id) : null;
  }

  updateRetiredPaneCleanup(id: string, state: RetiredPaneCleanupState, detail: string | null = null): RetiredPaneCleanupOperation | null {
    const result = this.database.prepare("UPDATE retired_pane_cleanup_operations SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state IN ('pending','waiting_busy','executing')").run(state, detail, now(), id);
    return result.changes === 1 ? this.requireRetiredPaneCleanup(id) : null;
  }

  completeRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const operation = this.requireRetiredPaneCleanup(id);
      if (operation.state !== "executing") { this.database.exec("COMMIT"); return null; }
      const binding = this.requireBinding(operation.oldBindingId);
      if (binding.lifecycle !== "archived" || binding.paneId !== operation.paneId) throw new Error("Retired pane cleanup binding identity changed");
      const timestamp = now();
      this.database.prepare("UPDATE bindings SET lifecycle = 'closed', attachment = 'unattached', state = 'archived', last_agent_state = 'unknown', updated_at = ? WHERE id = ?").run(timestamp, binding.id);
      this.database.prepare("UPDATE retired_pane_cleanup_operations SET state = 'succeeded', detail = NULL, updated_at = ? WHERE id = ? AND state = 'executing'").run(timestamp, id);
      this.database.exec("COMMIT");
      return this.requireRetiredPaneCleanup(id);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  createProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; expiresAt: string; card: object }): ProjectSelection {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT * FROM project_selections WHERE command_message_id = ?").get(input.commandMessageId) as ProjectSelectionRow | undefined;
      if (existing) { this.database.exec("COMMIT"); return mapProjectSelection(existing); }
      const timestamp = now();
      this.database.prepare(`INSERT INTO project_selections(id, command_message_id, chat_id, topic_id, root_message_id, actor_open_id, requested_title, state, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(input.id, input.commandMessageId, input.chatId, input.topicId, input.rootMessageId, input.actorOpenId, input.requestedTitle, input.expiresAt, timestamp, timestamp);
      this.database.prepare(`INSERT INTO outbound_replies(id, idempotency_key, selection_id, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'card_reply', ?, ?, 'pending', 0, ?, ?, ?)`)
        .run(randomUUID(), `project-selection:create:${input.id}`, input.id, input.rootMessageId, JSON.stringify(input.card), `message:${input.rootMessageId}`, timestamp, timestamp, timestamp);
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

  updateBindingMetadata(id: string, patch: BindingMetadataPatch): Binding { return this.updateBinding(id, patch); }

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

  applyRuntimeObservation(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: HerdrPane }): RuntimeObservationApplication {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let binding = this.requireBinding(input.bindingId);
      if (binding.paneId !== input.expectedPaneId || input.pane.paneId !== input.expectedPaneId || binding.generation !== input.expectedGeneration || (binding.lifecycle !== "active" && binding.lifecycle !== "draining") || binding.attachment === "orphaned") {
        this.database.exec("COMMIT");
        return { outcome: "stale_binding" };
      }
      const persistedSession = binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
        ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
        : null;
      const observedSession = input.pane.agentSession ?? null;
      const sameSession = Boolean(persistedSession && observedSession
        && persistedSession.source === observedSession.source && persistedSession.agent === observedSession.agent
        && persistedSession.kind === observedSession.kind && persistedSession.value === observedSession.value);
      const terminalIdentityRefreshed = Boolean(binding.traexSessionId && input.pane.terminalId && binding.traexSessionId !== input.pane.terminalId && sameSession);
      if (binding.traexSessionId && input.pane.terminalId && binding.traexSessionId !== input.pane.terminalId && !sameSession) {
        binding = this.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 2 });
        this.database.exec("COMMIT");
        return { outcome: "terminal_identity_changed", binding };
      }
      const nativeSessionMismatch = Boolean(persistedSession && observedSession && !sameSession);
      if (terminalIdentityRefreshed || (!persistedSession && observedSession)) binding = this.updateBinding(binding.id, {
        ...(terminalIdentityRefreshed ? { traexSessionId: input.pane.terminalId ?? null } : {}),
        ...(!persistedSession && observedSession ? { agentSessionSource: observedSession.source, agentSessionAgent: observedSession.agent, agentSessionKind: observedSession.kind, agentSessionValue: observedSession.value } : {})
      });
      binding = this.transitionBinding(binding.id, { type: "pane_observed", runtime: input.pane.agentState });
      this.database.exec("COMMIT");
      return { outcome: "applied", binding, terminalIdentityRefreshed, nativeSessionMismatch };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  checkpointRuntimeOutput(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; fingerprint: string }): boolean {
    const result = this.database.prepare(`
      UPDATE bindings SET last_output_fingerprint = ?, updated_at = ?
      WHERE id = ? AND pane_id = ? AND generation = ?
        AND lifecycle IN ('active', 'draining') AND attachment != 'orphaned'
    `).run(input.fingerprint, now(), input.bindingId, input.expectedPaneId, input.expectedGeneration);
    return Number(result.changes) === 1;
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
      this.database.prepare(`INSERT INTO outbound_replies(id, idempotency_key, binding_id, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'card_update', ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`)
        .run(randomUUID(), `card-update:${input.messageId}:${input.event.eventId}`, input.id, input.messageId, JSON.stringify(input.card), `message:${input.messageId}`, timestamp, timestamp, timestamp);
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
      this.database.prepare(`UPDATE bindings SET pane_id = ?, traex_session_id = ?, agent_session_source = ?, agent_session_agent = ?, agent_session_kind = ?, agent_session_value = ?, workspace_id = ?, lifecycle = ?, attachment = ?, state = 'archived', generation = ?, last_agent_state = ?, degradation_count = 0, last_observed_at = ?, archived_at = ?, updated_at = ? WHERE id = ?`)
        .run(pane.paneId, pane.terminalId ?? null, pane.agentSession?.source ?? null, pane.agentSession?.agent ?? null, pane.agentSession?.kind ?? null, pane.agentSession?.value ?? null, pane.workspaceId, suspended.lifecycle, suspended.attachment, suspended.generation, suspended.runtime, now(), now(), now(), id);
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

  listQueuedTurnRunCards(bindingId: string): RunCardView[] {
    const rows = this.database.prepare(`
      SELECT view.state_json FROM prompt_jobs AS prompt
      JOIN run_cards_view AS view ON view.prompt_id = prompt.id
      WHERE prompt.binding_id = ? AND prompt.state = 'queued' AND prompt.dispatch_kind = 'turn'
      ORDER BY prompt.created_at, prompt.rowid
    `).all(bindingId) as Array<{ state_json: string }>;
    return rows.map((row) => JSON.parse(row.state_json) as RunCardView);
  }

  acceptPaneControlOperation(input: { id: string; idempotencyKey: string; bindingId: string; paneId: string; terminalId: string | null; bindingGeneration: number; kind: PaneControlOperationKind; payload?: string | null; parentPromptId?: string | null; actorOpenId: string; sourceMessageId: string }): { operation: PaneControlOperation; inserted: boolean } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const timestamp = now();
      const result = this.database.prepare(`
        INSERT INTO pane_control_operations(id, idempotency_key, binding_id, pane_id, terminal_id, binding_generation, kind, payload, parent_prompt_id, state, attempt_count, actor_open_id, source_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 0, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `).run(input.id, input.idempotencyKey, input.bindingId, input.paneId, input.terminalId, input.bindingGeneration, input.kind, input.payload ?? null, input.parentPromptId ?? null, input.actorOpenId, input.sourceMessageId, timestamp, timestamp);
      const row = this.database.prepare("SELECT * FROM pane_control_operations WHERE idempotency_key = ?").get(input.idempotencyKey) as PaneControlOperationRow | undefined;
      if (!row) throw new Error(`Pane control operation not found: ${input.idempotencyKey}`);
      this.database.exec("COMMIT");
      return { operation: mapPaneControlOperation(row), inserted: result.changes === 1 };
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  claimNextPaneControlOperation(bindingId?: string): PaneControlOperation | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const scope = bindingId ? "AND operation.binding_id = ?" : "";
      const row = this.database.prepare(`
        SELECT operation.* FROM pane_control_operations AS operation
        JOIN bindings AS binding ON binding.id = operation.binding_id
        WHERE operation.state = 'accepted' ${scope}
          AND binding.state = 'active' AND binding.lifecycle = 'active' AND binding.attachment = 'attached'
          AND binding.pane_id = operation.pane_id AND binding.generation = operation.binding_generation
          AND (operation.kind != 'model' OR NOT EXISTS (
            SELECT 1 FROM prompt_jobs active_prompt
            WHERE active_prompt.binding_id = operation.binding_id AND active_prompt.state = 'running'
          ))
          AND (operation.kind = 'stop' OR NOT EXISTS (
            SELECT 1 FROM pane_control_operations active
            WHERE active.binding_id = operation.binding_id AND active.kind != 'stop' AND active.state = 'running'
          ))
        ORDER BY CASE operation.kind WHEN 'stop' THEN 0 WHEN 'steer' THEN 1 ELSE 2 END, operation.created_at, operation.rowid
        LIMIT 1
      `).get(...(bindingId ? [bindingId] : [])) as PaneControlOperationRow | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      const result = this.database.prepare("UPDATE pane_control_operations SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'accepted'").run(now(), row.id);
      if (result.changes !== 1) throw new Error(`Pane control operation ${row.id} was not atomically claimed`);
      const claimed = this.database.prepare("SELECT * FROM pane_control_operations WHERE id = ?").get(row.id) as PaneControlOperationRow;
      this.database.exec("COMMIT");
      return mapPaneControlOperation(claimed);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  claimPaneControlOperation(id: string): PaneControlOperation | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM pane_control_operations WHERE id = ? AND state = 'accepted'").get(id) as PaneControlOperationRow | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      const result = this.database.prepare("UPDATE pane_control_operations SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'accepted'").run(now(), id);
      if (result.changes !== 1) { this.database.exec("COMMIT"); return null; }
      const claimed = this.database.prepare("SELECT * FROM pane_control_operations WHERE id = ?").get(id) as PaneControlOperationRow;
      this.database.exec("COMMIT");
      return mapPaneControlOperation(claimed);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  claimAppliedPaneControlOperation(id: string): PaneControlOperation | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT * FROM pane_control_operations WHERE id = ? AND state = 'applied'").get(id) as PaneControlOperationRow | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      const result = this.database.prepare("UPDATE pane_control_operations SET state = 'running', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND state = 'applied'").run(now(), id);
      if (result.changes !== 1) { this.database.exec("COMMIT"); return null; }
      const claimed = this.database.prepare("SELECT * FROM pane_control_operations WHERE id = ?").get(id) as PaneControlOperationRow;
      this.database.exec("COMMIT");
      return mapPaneControlOperation(claimed);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  rejectAppliedPaneControlOperation(id: string, detail: string): PaneControlOperation | null {
    const result = this.database.prepare("UPDATE pane_control_operations SET state = 'rejected', detail = ?, updated_at = ? WHERE id = ? AND state = 'applied'").run(detail, now(), id);
    return result.changes === 1 ? this.getPaneControlOperation(id) : null;
  }

  getPaneControlOperation(id: string): PaneControlOperation | null {
    const row = this.database.prepare("SELECT * FROM pane_control_operations WHERE id = ?").get(id) as PaneControlOperationRow | undefined;
    return row ? mapPaneControlOperation(row) : null;
  }

  listRecoverablePaneControlOperations(): PaneControlOperation[] {
    return (this.database.prepare("SELECT * FROM pane_control_operations WHERE state IN ('running', 'applied') ORDER BY updated_at, id").all() as PaneControlOperationRow[]).map(mapPaneControlOperation);
  }

  finishPaneControlOperation(id: string, state: PaneControlOutcome, detail: string | null = null): boolean {
    const sources = paneControlOutcomeSources(state);
    const placeholders = sources.map(() => "?").join(", ");
    const result = this.database.prepare(`UPDATE pane_control_operations SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state IN (${placeholders})`)
      .run(state, detail, now(), id, ...sources);
    return Number(result.changes) === 1;
  }

  finishPaneControlWithResult(input: {
    operationId: string;
    state: PaneControlOutcome;
    detail?: string | null;
    result: { kind: "card_reply" | "card_update"; targetMessageId: string; idempotencyKey: string; targetRole?: OutboundTargetRole | null; card: object };
  }): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const operation = this.getPaneControlOperation(input.operationId);
      if (!operation) throw new Error(`Pane control operation not found: ${input.operationId}`);
      if (operation.state !== input.state && !this.finishPaneControlOperation(input.operationId, input.state, input.detail ?? null)) {
        this.database.exec("COMMIT");
        return false;
      }
      this.enqueueOutboundReply({
        id: randomUUID(), idempotencyKey: input.result.idempotencyKey, bindingId: operation.bindingId,
        targetRole: input.result.targetRole ?? null, rootMessageId: input.result.targetMessageId,
        kind: input.result.kind, payload: JSON.stringify(input.result.card)
      });
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recoverRunningPrompts(): number {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ?, updated_at = ? WHERE state = 'queued' AND dispatch_kind = 'steering'")
        .run("Bridge 重启，本次 `/swarm steer` 未注入，也不会转为普通任务。", timestamp);
      const orphanedSteering = this.database.prepare("SELECT prompt_id FROM run_cards c JOIN prompt_jobs p ON p.id = c.prompt_id WHERE p.dispatch_kind = 'steering' AND p.state = 'failed' AND c.phase = 'queued'").all() as Array<{ prompt_id: string }>;
      for (const card of orphanedSteering) {
        this.database.prepare("UPDATE run_cards SET phase = 'failed', notice = ?, finished_at = ?, queue_position = 0, view_version = view_version + 1, updated_at = ? WHERE prompt_id = ?")
          .run("Bridge 重启，本次 `/swarm steer` 未注入，也不会转为普通任务。", timestamp, timestamp, card.prompt_id);
      }
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

  scanDurablePromptWork(): DurablePromptWorkScan {
    const timestamp = now();
    const reason = "Session can no longer dispatch queued work";
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const terminalBindings = `
        SELECT id FROM bindings
        WHERE state IN ('archived', 'orphaned', 'failed')
          OR lifecycle IN ('archived', 'closed', 'failed')
          OR attachment = 'orphaned'
      `;
      const result = this.database.prepare(`
        UPDATE prompt_jobs SET state = 'cancelled', observation_state = 'completed', error = ?, updated_at = ?
        WHERE state = 'queued' AND binding_id IN (${terminalBindings})
      `).run(reason, timestamp);
      this.database.prepare(`
        UPDATE run_cards SET phase = 'failed', notice = ?, finished_at = ?, queue_position = 0,
          view_version = view_version + 1, updated_at = ?
        WHERE phase = 'queued' AND binding_id IN (${terminalBindings})
      `).run(reason, timestamp, timestamp);
      const hints: PromptWorkHint[] = [];
      const detached = this.database.prepare(`
        SELECT p.id, p.binding_id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
        WHERE p.state = 'running' AND p.dispatch_kind = 'turn' AND p.observation_state = 'detached'
          AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL
        ORDER BY p.created_at, p.id
      `).all() as Array<{ id: string; binding_id: string }>;
      for (const row of detached) hints.push({ kind: "detached-observer-ready", bindingId: row.binding_id, promptId: row.id });
      const steering = this.database.prepare(`
        SELECT DISTINCT p.binding_id, p.parent_prompt_id FROM prompt_jobs p
        JOIN bindings b ON b.id = p.binding_id
        JOIN prompt_jobs parent ON parent.id = p.parent_prompt_id AND parent.binding_id = p.binding_id
        WHERE p.state = 'queued' AND p.dispatch_kind = 'steering' AND p.parent_prompt_id IS NOT NULL
          AND parent.state = 'running' AND parent.dispatch_kind = 'turn'
          AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL
        ORDER BY p.binding_id, p.parent_prompt_id
      `).all() as Array<{ binding_id: string; parent_prompt_id: string }>;
      for (const row of steering) hints.push({ kind: "steering-ready", bindingId: row.binding_id, parentPromptId: row.parent_prompt_id });
      const turns = this.database.prepare(`
        SELECT DISTINCT p.binding_id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
        WHERE p.state = 'queued' AND p.dispatch_kind = 'turn'
          AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM prompt_jobs active WHERE active.binding_id = p.binding_id AND active.state = 'running')
        ORDER BY p.binding_id
      `).all() as Array<{ binding_id: string }>;
      for (const row of turns) hints.push({ kind: "prompt-ready", bindingId: row.binding_id });
      this.database.exec("COMMIT");
      return { cancelled: Number(result.changes), hints };
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

  recoverLegacyElementIdDeadLetters(): number {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.canonicalizeLegacyAnswerTargets(timestamp);
      const result = this.database.prepare(`
        UPDATE outbound_replies
        SET state = 'pending', attempt_count = 0, error = NULL, next_attempt_at = ?, updated_at = ?
        WHERE state = 'dead_letter' AND kind = 'stream_card_create' AND card_role = 'answer'
          AND error LIKE '%elementID format error%'
          AND prompt_id IN (
            SELECT p.id FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
            WHERE p.state = 'queued' AND c.answer_message_id IS NULL AND c.answer_card_id IS NULL
          )
      `).run(timestamp, timestamp);
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
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
        INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, card_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `);
      createCard.run(randomUUID(), `run-card:create:${input.prompt.id}:answer`, input.prompt.bindingId, input.prompt.id, input.view.viewVersion, "answer", input.rootMessageId, "stream_card_create", JSON.stringify(input.answerCard), `answer:${input.prompt.id}`, timestamp, timestamp, timestamp);
      this.database.exec("COMMIT");
      return { prompt: this.requirePrompt(input.prompt.id), view: this.loadRunCard(input.prompt.id)!, inserted: true };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  ensureAnswerCard(promptId: string, rootMessageId: string, card: object): void {
    const view = this.loadRunCard(promptId);
    if (!view || view.answerMessageId) return;
    const existing = this.database.prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key = ?").get(`run-card:create:${promptId}:answer`);
    if (existing) return;
    const prompt = this.requirePrompt(promptId);
    this.enqueueOutboundReply({
      id: randomUUID(), idempotencyKey: `run-card:create:${promptId}:answer`, bindingId: prompt.bindingId, promptId, viewVersion: view.viewVersion,
      cardRole: "answer", rootMessageId, kind: "card_reply", payload: JSON.stringify(card)
    });
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
          AND NOT EXISTS (SELECT 1 FROM pane_control_operations control WHERE control.binding_id = p.binding_id AND control.kind = 'model' AND control.state IN ('accepted','running','applied'))
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
      return this.requirePrompt(row.id);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  failQueuedSteering(bindingId: string, parentPromptId: string, notice: string): string[] {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare("SELECT id FROM prompt_jobs WHERE binding_id = ? AND parent_prompt_id = ? AND dispatch_kind = 'steering' AND state = 'queued'")
        .all(bindingId, parentPromptId) as Array<{ id: string }>;
      const timestamp = now();
      for (const row of rows) {
        this.database.prepare("UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ?, updated_at = ? WHERE id = ?").run(notice, timestamp, row.id);
        this.persistTerminalRunCard(row.id, { type: "failed", occurredAt: timestamp, notice });
      }
      this.database.exec("COMMIT");
      return rows.map((row) => row.id);
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  updatePrompt(id: string, state: PromptState, error: string | null = null): void {
    const observationState: PromptObservationState = state === "queued" ? "not_started" : state === "running" ? "attached" : "completed";
    this.database.prepare("UPDATE prompt_jobs SET state = ?, observation_state = ?, error = ?, updated_at = ? WHERE id = ?")
      .run(state, observationState, error, now(), id);
  }

  completeTurn(input: { promptId: string; bindingId: string; answer: string; occurredAt: string; outputFingerprint: string }): Binding {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE prompt_jobs SET state = 'delivered', observation_state = 'completed', error = NULL, updated_at = ? WHERE id = ? AND binding_id = ?")
        .run(input.occurredAt, input.promptId, input.bindingId);
      this.updateBinding(input.bindingId, { lastOutputFingerprint: input.outputFingerprint });
      const binding = this.transitionBinding(input.bindingId, { type: "turn_completed" });
      this.persistTerminalRunCard(input.promptId, { type: "completed", occurredAt: input.occurredAt, answer: input.answer });
      this.database.exec("COMMIT");
      return binding;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ?, updated_at = ? WHERE id = ?")
        .run(input.error, input.occurredAt, input.promptId);
      this.persistTerminalRunCard(input.promptId, { type: "failed", occurredAt: input.occurredAt, notice: input.error });
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  completeSteering(input: { promptId: string; notice: string; occurredAt: string }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE prompt_jobs SET state = 'delivered', observation_state = 'completed', error = NULL, updated_at = ? WHERE id = ?")
        .run(input.occurredAt, input.promptId);
      this.persistTerminalRunCard(input.promptId, { type: "steering-delivered", occurredAt: input.occurredAt, notice: input.notice });
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private persistTerminalRunCard(promptId: string, change: Parameters<typeof reduceRunCard>[1]): void {
    const current = this.loadRunCard(promptId);
    if (!current) throw new Error(`Run card missing for prompt: ` + promptId);
    const next = reduceRunCard(current, change);
    if (next !== current) this.saveRunCard(next);
    const topic = this.loadTopicView(current.bindingId);
    if (topic) this.saveTopicView(mirrorRunCardToTopic(topic, next));
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

  enqueueOutboundReply(input: Omit<OutboundReply, "promptId" | "viewVersion" | "selectionId" | "cardRole" | "targetRole" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "cardIdCheckpoint" | "failureClass" | "httpStatus" | "larkErrorCode" | "autoRecoveryCount" | "deadLetteredAt" | "nextAttemptAt" | "createdAt" | "updatedAt"> & { promptId?: string | null; viewVersion?: number | null; selectionId?: string | null; cardRole?: OutboundReply["cardRole"]; targetRole?: OutboundReply["targetRole"] }): OutboundReply {
    const timestamp = now();
    const laneKey = outboundLaneKey(input);
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      if (input.kind === "card_update" && input.bindingId && !input.promptId) {
        // Preserve the oldest pending row as an in-flight-safe lane barrier,
        // then keep only the newest snapshot behind it. Pruning and insertion
        // share this transaction so a failed insert cannot lose the successor.
        this.database.prepare(`
          DELETE FROM outbound_replies
          WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
            AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            AND delivery_order > (
              SELECT MIN(delivery_order) FROM outbound_replies
              WHERE binding_id = ? AND prompt_id IS NULL AND root_message_id = ?
                AND lane_key = ? AND kind = 'card_update' AND state = 'pending'
            )
        `).run(input.bindingId, input.rootMessageId, laneKey, input.bindingId, input.rootMessageId, laneKey);
      }
      if (input.kind === "card_update" && input.promptId && input.viewVersion !== undefined && input.viewVersion !== null) {
        this.database.prepare("DELETE FROM outbound_replies WHERE prompt_id = ? AND root_message_id = ? AND kind = ? AND state = 'pending' AND card_role IS ? AND COALESCE(view_version, 0) < ?")
          .run(input.promptId, input.rootMessageId, input.kind, input.cardRole ?? null, input.viewVersion);
      }
      this.database.prepare(`
        INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, selection_id, card_role, target_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO UPDATE SET
          payload = CASE WHEN outbound_replies.state = 'pending' THEN excluded.payload ELSE outbound_replies.payload END,
          view_version = CASE WHEN outbound_replies.state = 'pending' THEN excluded.view_version ELSE outbound_replies.view_version END,
          updated_at = CASE WHEN outbound_replies.state = 'pending' THEN excluded.updated_at ELSE outbound_replies.updated_at END
      `).run(input.id, input.idempotencyKey, input.bindingId ?? null, input.promptId ?? null, input.viewVersion ?? null, input.selectionId ?? null, input.cardRole ?? null, input.targetRole ?? null, input.rootMessageId, input.kind, input.payload, laneKey, timestamp, timestamp, timestamp);
      const row = this.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key = ?").get(input.idempotencyKey) as OutboundReplyRow | undefined;
      if (!row) throw new Error(`Outbound reply not found: ${input.idempotencyKey}`);
      if (input.kind === "stream_card_create" && input.promptId) {
        const stream = streamCardState(input.payload);
        const pageIndex = stream?.pageIndex ?? 0;
        const view = this.loadRunCard(input.promptId);
        const elementId = stream?.elementId ?? view?.answerElementId;
        if (!view || !elementId) throw new Error(`Answer page metadata missing for prompt: ${input.promptId}`);
        this.database.prepare(`INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, created_at, updated_at)
          VALUES (?, ?, NULL, NULL, ?, ?, 0, 'creating', ?, ?) ON CONFLICT(prompt_id, page_index) DO NOTHING`)
          .run(input.promptId, pageIndex, elementId, stream?.pageStart ?? 0, timestamp, timestamp);
      }
      if (ownsTransaction) this.database.exec("COMMIT");
      return mapOutboundReply(row);
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listPendingOutboundReplies(): OutboundReply[] {
    return (this.database.prepare("SELECT * FROM outbound_replies WHERE state = 'pending' ORDER BY delivery_order").all() as OutboundReplyRow[]).map(mapOutboundReply);
  }

  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean {
    const row = this.database.prepare(`
      SELECT 1
      FROM outbound_replies
      WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending'
        AND json_extract(payload, '$.stream.pageIndex') = ?
      LIMIT 1
    `).get(promptId, pageIndex) as { 1: number } | undefined;
    return row !== undefined;
  }

  dismissSupersededAnswerStream(replyId: string): boolean {
    const updated = this.database.prepare(`
      UPDATE outbound_replies
      SET state = 'dismissed', error = 'Answer stream superseded by a continuation page', updated_at = ?
      WHERE id = ? AND state = 'pending' AND kind IN ('stream_content', 'stream_finish')
        AND prompt_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM run_cards
          WHERE run_cards.prompt_id = outbound_replies.prompt_id
            AND run_cards.answer_page_index > 0
            AND run_cards.answer_card_id IS NOT NULL
            AND run_cards.answer_card_id != outbound_replies.root_message_id
        )
    `).run(now(), replyId);
    return Number(updated.changes) === 1;
  }

  listOutboundLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys: readonly string[] = []): OutboundReply[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    const exclusions = excludedLaneKeys.length > 0 ? `AND h.lane_key NOT IN (${excludedLaneKeys.map(() => "?").join(", " )})` : "";
    const due = dueAt === null ? "" : "AND h.next_attempt_at <= ?";
    const parameters: SqlValue[] = [...excludedLaneKeys];
    if (dueAt !== null) parameters.push(dueAt);
    parameters.push(limit);
    return (this.database.prepare(`
      SELECT o.* FROM outbox_lane_heads h
      JOIN outbound_replies o ON o.id = h.reply_id
      WHERE 1 = 1 ${exclusions} ${due}
      ORDER BY h.delivery_order LIMIT ?
    `).all(...parameters) as OutboundReplyRow[]).map(mapOutboundReply);
  }

  getNextOutboundLaneHeadAttemptAt(): string | null {
    const row = this.database.prepare("SELECT MIN(next_attempt_at) AS next_attempt_at FROM outbox_lane_heads").get() as { next_attempt_at: string | null };
    return row.next_attempt_at;
  }

  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT binding_id, prompt_id, view_version, selection_id, card_role, target_role, kind, payload FROM outbound_replies WHERE id = ?").get(id) as { binding_id: string | null; prompt_id: string | null; view_version: number | null; selection_id: string | null; card_role: string | null; target_role: string | null; kind: string; payload: string } | undefined;
      this.database.prepare("UPDATE outbound_replies SET state = 'delivered', delivered_message_id = ?, error = NULL, failure_class = NULL, http_status = NULL, lark_error_code = NULL, dead_lettered_at = NULL, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?").run(messageId, now(), id);
      if (row?.prompt_id) {
        if (row.card_role === "answer") {
          if (row.kind === "card_reply" || row.kind === "stream_card_create") {
            const stream = row.kind === "stream_card_create" ? streamCardState(row.payload) : null;
            const expectedPageIndex = stream && stream.pageIndex > 0 ? stream.pageIndex - 1 : null;
            const pageIndex = stream?.pageIndex ?? 0;
            const updated = this.database.prepare("UPDATE run_cards SET answer_message_id = ?, answer_card_id = COALESCE(?, answer_card_id), answer_element_id = COALESCE(?, answer_element_id), answer_sequence = CASE WHEN ? IS NULL THEN answer_sequence ELSE 0 END, answer_page_index = COALESCE(?, answer_page_index), answer_page_start = COALESCE(?, answer_page_start), lark_message_id = CASE WHEN ? IS NULL THEN COALESCE(lark_message_id, ?) ELSE lark_message_id END, answer_delivered_version = MAX(answer_delivered_version, ?), updated_at = ? WHERE prompt_id = ? AND (? IS NULL OR answer_page_index = ?)")
              .run(messageId, cardId ?? null, stream?.elementId ?? null, stream ? 1 : null, stream?.pageIndex ?? null, stream?.pageStart ?? null, cardId ?? null, messageId, row.view_version ?? 0, now(), row.prompt_id, expectedPageIndex, expectedPageIndex);
            if (updated.changes > 0) {
              if (pageIndex > 0) this.database.prepare("UPDATE answer_pages SET state = 'frozen', updated_at = ? WHERE prompt_id = ? AND state = 'active' AND page_index < ?").run(now(), row.prompt_id, pageIndex);
              this.database.prepare("UPDATE answer_pages SET message_id = ?, card_id = COALESCE(?, card_id), sequence = CASE WHEN ? IS NULL THEN sequence ELSE 0 END, state = 'active', updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'creating'")
                .run(messageId, cardId ?? null, cardId ?? null, now(), row.prompt_id, pageIndex);
            }
          }
          else {
            this.database.prepare("UPDATE run_cards SET answer_delivered_version = MAX(answer_delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(row.view_version ?? 0, now(), row.prompt_id);
            const payload = parseJsonRecord(row.payload);
            const pageIndex = Number.isInteger(payload.pageIndex) ? Number(payload.pageIndex) : null;
            if (row.kind === "stream_content") this.database.prepare("UPDATE answer_pages SET sequence = MAX(sequence, ?), updated_at = ? WHERE prompt_id = ? AND state = 'active' AND (? IS NULL OR page_index = ?)").run(row.view_version ?? 0, now(), row.prompt_id, pageIndex, pageIndex);
            if (row.kind === "stream_finish") {
              const pendingContinuation = this.database.prepare("SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' LIMIT 1").get(row.prompt_id);
              this.database.prepare("UPDATE answer_pages SET sequence = MAX(sequence, ?), state = ?, updated_at = ? WHERE prompt_id = ? AND state = 'active' AND (? IS NULL OR page_index = ?)").run(row.view_version ?? 0, pendingContinuation ? "frozen" : "finished", now(), row.prompt_id, pageIndex, pageIndex);
            }
          }
        } else if (row.kind === "card_reply") this.database.prepare("UPDATE run_cards SET lark_message_id = ?, delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(messageId, row.view_version ?? 0, now(), row.prompt_id);
        else this.database.prepare("UPDATE run_cards SET delivered_version = MAX(delivered_version, ?), updated_at = ? WHERE prompt_id = ?").run(row.view_version ?? 0, now(), row.prompt_id);
      }
      if (row?.selection_id && row.kind === "card_reply") this.database.prepare("UPDATE project_selections SET selector_message_id = ?, updated_at = ? WHERE id = ?").run(messageId, now(), row.selection_id);
      if (row?.binding_id && row.kind === "card_reply" && row.target_role === "session_status") this.updateBinding(row.binding_id, { statusMessageId: messageId });
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  checkpointOutboundReplyCard(id: string, cardId: string): OutboundReply | null {
    this.database.prepare("UPDATE outbound_replies SET card_id_checkpoint = COALESCE(card_id_checkpoint, ?), updated_at = ? WHERE id = ? AND state = 'pending'")
      .run(cardId, now(), id);
    return this.getOutboundReply(id);
  }

  markOutboundReplyFailed(id: string, error: string, retryDelayMs?: number, metadata?: DeliveryFailureMetadata): OutboundReply | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare("SELECT attempt_count FROM outbound_replies WHERE id = ?").get(id) as { attempt_count: number } | undefined;
      if (!row) { this.database.exec("COMMIT"); return null; }
      const attempts = Number(row.attempt_count) + 1;
      const timestamp = now();
      const deadLetteredAt = attempts >= 5 ? timestamp : null;
      this.database.prepare(`UPDATE outbound_replies SET state = CASE WHEN ? >= 5 THEN 'dead_letter' ELSE state END, error = ?, attempt_count = ?, next_attempt_at = ?, failure_class = ?, http_status = ?, lark_error_code = ?, dead_lettered_at = ?, updated_at = ? WHERE id = ?`)
        .run(attempts, boundedError(error), attempts, retryAt(attempts, retryDelayMs), metadata?.failureClass ?? "unknown", metadata?.httpStatus ?? null, metadata?.larkErrorCode ?? null, deadLetteredAt, timestamp, id);
      const result = this.getOutboundReply(id);
      this.database.exec("COMMIT");
      return result;
    } catch (cause) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw cause; }
  }

  markOutboundReplyDeadLetter(id: string, error: string, metadata?: DeliveryFailureMetadata): OutboundReply | null {
    const timestamp = now();
    this.database.prepare("UPDATE outbound_replies SET state = 'dead_letter', error = ?, failure_class = ?, http_status = ?, lark_error_code = ?, dead_lettered_at = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?")
      .run(boundedError(error), metadata?.failureClass ?? "permanent", metadata?.httpStatus ?? null, metadata?.larkErrorCode ?? null, timestamp, timestamp, id);
    return this.getOutboundReply(id);
  }

  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] {
    if (!Number.isInteger(limit) || limit <= 0) return [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare(`SELECT id FROM outbound_replies WHERE state = 'dead_letter' AND failure_class = 'transient' AND auto_recovery_count = 0 AND dead_lettered_at IS NOT NULL AND dead_lettered_at <= ? ORDER BY dead_lettered_at, delivery_order LIMIT ?`).all(cutoff, limit) as Array<{ id: string }>;
      const recovered: OutboundReply[] = [];
      for (const row of rows) {
        const updated = this.database.prepare(`UPDATE outbound_replies SET state = 'pending', attempt_count = 0, error = NULL, next_attempt_at = ?, auto_recovery_count = 1, updated_at = ? WHERE id = ? AND state = 'dead_letter' AND failure_class = 'transient' AND auto_recovery_count = 0 AND dead_lettered_at <= ?`).run(now(), now(), row.id, cutoff);
        if (updated.changes === 1) { const reply = this.getOutboundReply(row.id); if (reply) recovered.push(reply); }
      }
      this.database.exec("COMMIT");
      return recovered;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.changeDeadLetter(id, chatId, actorOpenId, "retry");
  }

  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.changeDeadLetter(id, chatId, actorOpenId, "dismiss");
  }

  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    const result = this.database.prepare(`
      DELETE FROM outbound_replies
      WHERE id IN (
        SELECT id FROM outbound_replies
        WHERE state IN ('delivered', 'dismissed') AND updated_at < ?
        ORDER BY updated_at, delivery_order
        LIMIT ?
      )
    `).run(cutoff, limit);
    return Number(result.changes);
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
        this.database.prepare("UPDATE outbound_replies SET state = ?, error = NULL, failure_class = NULL, http_status = NULL, lark_error_code = NULL, attempt_count = CASE WHEN ? = 'pending' THEN 0 ELSE attempt_count END, next_attempt_at = ?, updated_at = ? WHERE id = ? AND state = 'dead_letter'").run(nextState, nextState, now(), now(), id);
        outcome = action === "retry" ? "retried" : "dismissed";
      }
      this.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, ?, ?, ?, ?)").run(actorOpenId, `outbound.${action}`, id, outcome, now());
      this.database.exec("COMMIT");
      return outcome;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  getOperationalSummary(): OperationalSummary {
    const observedAt = now();
    const groupedCounts = <T extends string>(table: string, column: string, values: readonly T[]): Record<T, number> => {
      const result = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
      const rows = this.database.prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all() as Array<{ value: T; count: number }>;
      for (const row of rows) result[row.value] = Number(row.count);
      return result;
    };
    const recentFailedPrompt = this.database.prepare("SELECT id, binding_id, updated_at, error FROM prompt_jobs WHERE state = 'failed' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as { id: string; binding_id: string; updated_at: string; error: string | null } | undefined;
    const recentDeadLetter = this.database.prepare("SELECT id, binding_id, prompt_id, attempt_count, updated_at, error FROM outbound_replies WHERE state = 'dead_letter' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as { id: string; binding_id: string | null; prompt_id: string | null; attempt_count: number; updated_at: string; error: string | null } | undefined;
    const oldestPending = this.database.prepare("SELECT MIN(created_at) AS value FROM outbound_replies WHERE state = 'pending'").get() as { value: string | null };
    const laneHealth = this.database.prepare(`
      SELECT COUNT(*) AS pending,
        SUM(CASE WHEN h.next_attempt_at <= ? THEN 1 ELSE 0 END) AS eligible,
        SUM(CASE WHEN o.error IS NOT NULL OR h.next_attempt_at > ? THEN 1 ELSE 0 END) AS blocked,
        MIN(CASE WHEN h.next_attempt_at > ? THEN h.next_attempt_at END) AS next_attempt_at,
        MIN(h.created_at) AS oldest_head_at
      FROM outbox_lane_heads h
      JOIN outbound_replies o ON o.id = h.reply_id
    `).get(observedAt, observedAt, observedAt) as { pending: number; eligible: number | null; blocked: number | null; next_attempt_at: string | null; oldest_head_at: string | null };
    const outbound = groupedCounts<OutboundReplyState>("outbound_replies", "state", ["pending", "delivered", "dead_letter", "dismissed"]);
    const deadLettersByClass = { transient: 0, permanent: 0, unknown: 0, legacy: 0 };
    const failureRows = this.database.prepare("SELECT failure_class, COUNT(*) AS count FROM outbound_replies WHERE state = 'dead_letter' GROUP BY failure_class").all() as Array<{ failure_class: DeliveryFailureClass | null; count: number }>;
    for (const row of failureRows) deadLettersByClass[row.failure_class ?? "legacy"] = Number(row.count);
    const eligibleRecoveries = this.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE state = 'dead_letter' AND failure_class = 'transient' AND auto_recovery_count = 0 AND dead_lettered_at IS NOT NULL AND dead_lettered_at <= ?").get(new Date(Date.parse(observedAt) - 300_000).toISOString()) as { count: number };
    const oldestInactive = this.database.prepare("SELECT MIN(last_activity_at) AS value FROM bindings WHERE lifecycle != 'active' OR attachment != 'attached'").get() as { value: string | null };
    const recoverableProvisioning = this.database.prepare("SELECT COUNT(*) AS count FROM project_selections WHERE state = 'processing' AND binding_id IS NOT NULL").get() as { count: number };
    const archivedPanesPresent = this.database.prepare("SELECT COUNT(*) AS count FROM bindings WHERE lifecycle = 'archived' AND pane_id IS NOT NULL").get() as { count: number };
    const cleanupCandidates = this.database.prepare("SELECT COUNT(*) AS count FROM bindings WHERE lifecycle = 'archived' AND pane_id IS NOT NULL AND archived_at <= datetime('now', '-30 days')").get() as { count: number };
    const oldestActiveCleanup = this.database.prepare("SELECT MIN(created_at) AS value FROM retired_pane_cleanup_operations WHERE state IN ('pending','waiting_busy','executing')").get() as { value: string | null };
    const latestCleanup = this.database.prepare("SELECT id, state, updated_at, detail FROM retired_pane_cleanup_operations ORDER BY updated_at DESC, rowid DESC LIMIT 1").get() as { id: string; state: RetiredPaneCleanupState; updated_at: string; detail: string | null } | undefined;
    return {
      bindings: groupedCounts<BindingState>("bindings", "state", ["pending", "active", "archived", "orphaned", "failed"]),
      prompts: groupedCounts<PromptState>("prompt_jobs", "state", ["queued", "running", "delivered", "failed", "cancelled"]),
      promptDispatch: groupedCounts<PromptDispatchKind>("prompt_jobs", "dispatch_kind", ["turn", "steering"]),
      outbound, pendingOutbox: outbound.pending, deadLetters: outbound.dead_letter, deadLettersByClass, eligibleDeadLetterRecoveries: Number(eligibleRecoveries.count), oldestPendingAt: oldestPending.value,
      outboxLanes: {
        pending: Number(laneHealth.pending), eligible: Number(laneHealth.eligible ?? 0), blocked: Number(laneHealth.blocked ?? 0),
        nextAttemptAt: laneHealth.next_attempt_at, oldestHeadAt: laneHealth.oldest_head_at,
        oldestHeadAgeSeconds: laneHealth.oldest_head_at === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(laneHealth.oldest_head_at)) / 1_000))
      },
      lifecycle: groupedCounts<SessionLifecycle>("bindings", "lifecycle", ["provisioning", "active", "draining", "archived", "closed", "failed"]),
      attachment: groupedCounts<AttachmentState>("bindings", "attachment", ["unattached", "attached", "degraded", "orphaned"]),
      recoverableProvisioning: Number(recoverableProvisioning.count), archivedPanesPresent: Number(archivedPanesPresent.count),
      cleanupCandidates: Number(cleanupCandidates.count), oldestInactiveAt: oldestInactive.value,
      retiredPaneCleanup: {
        states: groupedCounts<RetiredPaneCleanupState>("retired_pane_cleanup_operations", "state", ["pending", "waiting_busy", "executing", "succeeded", "retained"]),
        oldestActiveAt: oldestActiveCleanup.value,
        oldestActiveAgeSeconds: oldestActiveCleanup.value === null ? null : Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(oldestActiveCleanup.value)) / 1_000)),
        latestOutcome: latestCleanup ? { operationId: latestCleanup.id, state: latestCleanup.state, updatedAt: latestCleanup.updated_at, detail: latestCleanup.detail } : null
      },
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
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`UPDATE run_cards SET lark_message_id = ?, answer_message_id = ?, answer_card_id = ?, answer_element_id = ?, answer_sequence = ?, answer_page_index = ?, answer_page_start = ?, phase = ?, title = ?, request_text = ?, workspace_id = ?, space_name = ?, pane_id = ?, answer = ?, answer_segments_json = ?, answer_draft = ?, answer_draft_transient = ?, progress_events_json = ?, queue_position = ?, started_at = ?, finished_at = ?, notice = ?, view_version = ?, delivered_version = ?, answer_delivered_version = ?, updated_at = ? WHERE prompt_id = ?`)
        .run(view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.requestText, view.workspaceId, view.spaceName, view.paneId, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), view.queuePosition, view.startedAt, view.finishedAt, view.notice, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.updatedAt, view.promptId);
      const result = this.loadRunCard(view.promptId)!;
      if (ownsTransaction) this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
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

  getActiveAnswerPage(promptId: string): AnswerPage | null {
    const row = this.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? AND state = 'active' ORDER BY page_index DESC LIMIT 1").get(promptId) as AnswerPageRow | undefined;
    return row ? mapAnswerPage(row) : null;
  }

  getAnswerPageDeliveryFacts(promptId: string, pageIndex: number): AnswerPageDeliveryFacts {
    const page = this.database.prepare("SELECT card_id, element_id FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(promptId, pageIndex) as { card_id: string | null; element_id: string } | undefined;
    if (!page) return { latestContent: null, finishPending: false, continuationPending: false };
    const rows = this.database.prepare("SELECT kind, payload, state, view_version FROM outbound_replies WHERE prompt_id = ? AND card_role = 'answer' AND state IN ('pending','delivered') ORDER BY delivery_order DESC").all(promptId) as Array<{ kind: string; payload: string; state: OutboundReplyState; view_version: number | null }>;
    let latestContent: AnswerPageDeliveryFacts["latestContent"] = null;
    let finishPending = false;
    let continuationPending = false;
    for (const row of rows) {
      const payload = parseJsonRecord(row.payload);
      if (row.kind === "stream_card_create" && row.state === "pending" && Number((payload.stream as Record<string, unknown> | undefined)?.pageIndex) === pageIndex + 1) continuationPending = true;
      if (Number(payload.pageIndex ?? pageIndex) !== pageIndex) continue;
      if (row.kind === "stream_finish" && row.state === "pending") finishPending = true;
      if (row.kind === "stream_content" && latestContent === null && (payload.elementId === page.element_id || payload.pageIndex === pageIndex)) {
        latestContent = { content: typeof payload.content === "string" ? payload.content : "", sequence: Number(payload.sequence ?? row.view_version ?? 0), state: row.state };
      }
    }
    return { latestContent, finishPending, continuationPending };
  }

  reserveAnswerContent(input: { promptId: string; pageIndex: number; cardId: string; elementId: string; content: string }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.cardId !== input.cardId || page.elementId !== input.elementId) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.latestContent?.state === "pending" || facts.latestContent?.content === input.content) return "waiting";
      const sequence = page.sequence + 1;
      this.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND sequence = ?")
        .run(sequence, now(), input.promptId, input.pageIndex, page.sequence);
      this.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?")
        .run(sequence, now(), input.promptId, input.pageIndex);
      this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: sequence, cardRole: "answer", rootMessageId: input.cardId, kind: "stream_content", payload: JSON.stringify({ pageIndex: input.pageIndex, elementId: input.elementId, content: input.content, sequence }) });
      return "reserved";
    });
  }

  reserveAnswerFinish(input: { promptId: string; pageIndex: number; cardId: string; summary: string }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.cardId !== input.cardId) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.finishPending || page.state === "finished") return "waiting";
      const sequence = page.sequence + 1;
      this.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND sequence = ?")
        .run(sequence, now(), input.promptId, input.pageIndex, page.sequence);
      this.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?")
        .run(sequence, now(), input.promptId, input.pageIndex);
      this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-finish:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: sequence, cardRole: "answer", rootMessageId: input.cardId, kind: "stream_finish", payload: JSON.stringify({ pageIndex: input.pageIndex, summary: input.summary, sequence }) });
      return "reserved";
    });
  }

  reserveAnswerContinuation(input: { promptId: string; pageIndex: number; cardId: string; summary: string; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.reserveAnswerPageIntent(input.promptId, input.pageIndex, (page, view) => {
      if (page.cardId !== input.cardId || input.nextPageIndex !== input.pageIndex + 1 || input.nextPageStart <= page.sourceStart) return "stale";
      const facts = this.getAnswerPageDeliveryFacts(input.promptId, input.pageIndex);
      if (facts.finishPending || facts.continuationPending) return "waiting";
      const sequence = page.sequence + 1;
      this.database.prepare("UPDATE answer_pages SET sequence = ?, updated_at = ? WHERE prompt_id = ? AND page_index = ? AND state = 'active' AND sequence = ?")
        .run(sequence, now(), input.promptId, input.pageIndex, page.sequence);
      this.database.prepare("UPDATE run_cards SET answer_sequence = ?, updated_at = ? WHERE prompt_id = ? AND answer_page_index = ?")
        .run(sequence, now(), input.promptId, input.pageIndex);
      this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-finish:${input.promptId}:${input.cardId}:${sequence}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: sequence, cardRole: "answer", rootMessageId: input.cardId, kind: "stream_finish", payload: JSON.stringify({ pageIndex: input.pageIndex, summary: input.summary, sequence }) });
      this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `stream-card:${input.promptId}:${input.nextPageIndex}`, bindingId: view.bindingId, promptId: input.promptId, viewVersion: input.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.card, stream: { pageIndex: input.nextPageIndex, pageStart: input.nextPageStart, elementId: input.nextElementId } }) });
      return "reserved";
    });
  }

  private reserveAnswerPageIntent(promptId: string, pageIndex: number, reserve: (page: AnswerPage, view: RunCardView) => AnswerPageReservationOutcome): AnswerPageReservationOutcome {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const pageRow = this.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? AND page_index = ? AND state = 'active'").get(promptId, pageIndex) as AnswerPageRow | undefined;
      const view = this.loadRunCard(promptId);
      const outcome = pageRow && view ? reserve(mapAnswerPage(pageRow), view) : "stale";
      this.database.exec("COMMIT");
      return outcome;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  listAnswerPages(promptId: string): AnswerPage[] {
    return (this.database.prepare("SELECT * FROM answer_pages WHERE prompt_id = ? ORDER BY page_index").all(promptId) as AnswerPageRow[]).map(mapAnswerPage);
  }

  private insertRunCard(view: RunCardView): void {
    this.database.prepare(`INSERT INTO run_cards(prompt_id, binding_id, lark_message_id, answer_message_id, answer_card_id, answer_element_id, answer_sequence, answer_page_index, answer_page_start, phase, title, request_text, workspace_id, space_name, pane_id, answer, answer_segments_json, answer_draft, answer_draft_transient, progress_events_json, queue_position, started_at, finished_at, notice, view_version, delivered_version, answer_delivered_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(view.promptId, view.bindingId, view.larkMessageId, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerSequence, view.answerPageIndex, view.answerPageStart, view.phase, view.title, view.requestText, view.workspaceId, view.spaceName, view.paneId, view.answer, JSON.stringify(view.answerSegments), view.answerDraft, view.answerDraftTransient ? 1 : 0, JSON.stringify(view.progressEvents), view.queuePosition, view.startedAt, view.finishedAt, view.notice, view.viewVersion, view.deliveredVersion, view.answerDeliveredVersion, view.createdAt, view.updatedAt);
    this.database.prepare("INSERT OR IGNORE INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(view.promptId, view.answerPageIndex, view.answerMessageId, view.answerCardId, view.answerElementId, view.answerPageStart, view.answerSequence, view.answerCardId ? "active" : "creating", view.createdAt, view.updatedAt);
  }

  private requireBinding(id: string): Binding {
    const row = this.database.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as BindingRow | undefined;
    if (!row) throw new Error(`Binding not found: ${id}`);
    return mapBinding(row);
  }

  getPrompt(id: string): PromptJob | null {
    const row = this.database.prepare("SELECT * FROM prompt_jobs WHERE id = ?").get(id) as PromptRow | undefined;
    return row ? mapPrompt(row) : null;
  }

  private requirePrompt(id: string): PromptJob {
    const prompt = this.getPrompt(id);
    if (!prompt) throw new Error(`Prompt not found: ${id}`);
    return prompt;
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
        root_message_id TEXT, retired_topic_id TEXT, retired_root_message_id TEXT, replaces_binding_id TEXT REFERENCES bindings(id), reserved_topic_id TEXT, reserved_root_message_id TEXT, reset_message_id TEXT, pane_id TEXT UNIQUE, traex_session_id TEXT, agent_session_source TEXT, agent_session_agent TEXT, agent_session_kind TEXT CHECK(agent_session_kind IN ('id','path')), agent_session_value TEXT, title TEXT NOT NULL,
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
      CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_message_id ON inbound_messages(message_id);
      CREATE TABLE IF NOT EXISTS bridge_messages(message_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompt_jobs(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE NOT NULL,
        actor_open_id TEXT NOT NULL, body TEXT NOT NULL, dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering')), parent_prompt_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed','cancelled')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prompt_jobs_queue ON prompt_jobs(binding_id, state, created_at);
      CREATE TABLE IF NOT EXISTS outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, view_version INTEGER, selection_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), target_role TEXT CHECK(target_role IN ('session_status','operation_result')), root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0,
        error TEXT, delivered_message_id TEXT, card_id_checkpoint TEXT, delivery_order INTEGER, lane_key TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        failure_class TEXT CHECK(failure_class IN ('transient','permanent','unknown')), http_status INTEGER, lark_error_code TEXT, auto_recovery_count INTEGER NOT NULL DEFAULT 0, dead_lettered_at TEXT
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
      CREATE TABLE IF NOT EXISTS pane_control_operations(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT NOT NULL REFERENCES bindings(id), pane_id TEXT NOT NULL, terminal_id TEXT, binding_generation INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('stop','steer','model')), payload TEXT, parent_prompt_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('accepted','running','applied','confirmed','rejected','failed','uncertain')), attempt_count INTEGER NOT NULL DEFAULT 0, detail TEXT,
        actor_open_id TEXT NOT NULL, source_message_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pane_control_operations_claim ON pane_control_operations(state, binding_id, kind, created_at);
      CREATE INDEX IF NOT EXISTS pane_control_operations_recovery ON pane_control_operations(state, updated_at);
      CREATE TABLE IF NOT EXISTS retired_pane_cleanup_operations(
        id TEXT PRIMARY KEY, old_binding_id TEXT NOT NULL UNIQUE REFERENCES bindings(id), replacement_binding_id TEXT NOT NULL REFERENCES bindings(id),
        pane_id TEXT NOT NULL, expected_workspace_id TEXT NOT NULL, expected_project_id TEXT NOT NULL, expected_cwd TEXT NOT NULL, expected_terminal_id TEXT NOT NULL, actor_open_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','waiting_busy','executing','succeeded','retained')), attempt_count INTEGER NOT NULL DEFAULT 0, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS retired_pane_cleanup_state_created ON retired_pane_cleanup_operations(state, created_at, id);
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
      CREATE TABLE IF NOT EXISTS answer_pages(
        prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id), page_index INTEGER NOT NULL, message_id TEXT, card_id TEXT, element_id TEXT NOT NULL,
        source_start INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN ('creating','active','frozen','finished')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(prompt_id, page_index)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS answer_pages_active ON answer_pages(prompt_id) WHERE state = 'active';
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `);
    this.ensureOutboundReplyColumns();
    this.ensureInboundMessageIdempotency();
    this.ensureOutboundCardCheckpoint();
    this.ensureRequestCardOutboxColumns();
    this.ensureOutboundTargetRole();
    this.ensureRunCardRequestText();
    this.ensureRunCardSpaceName();
    this.ensureDualRequestCardColumns();
    this.ensureRunCardAnswerState();
    this.ensureStreamingCardColumns();
    this.ensureAnswerPages();
    this.ensurePromptDispatchColumns();
    this.ensureProjectSelectionColumns();
    this.ensureBindingLifecycleColumns();
    this.ensureAgentSessionColumns();
    this.ensureBindingResetColumns();
    this.ensureTwoPhaseResetState();
    this.ensurePromptCancelledState();
    this.ensurePromptObservationColumn();
    this.ensureOutboundDeliveryOrder();
    this.ensureOutboundDismissedState();
    this.ensureOutboundDeliveryOrder();
    this.ensureOutboundLaneKey();
    this.ensureOutboxLaneHeads();
    this.ensureOutboundFailureMetadata();
    this.ensurePaneCloseOperationState();
    this.ensurePaneControlOperationState();
    this.ensureRunCardsView();
    this.ensureQueryIndexes();
    const answerTargetMigration = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 2").get();
    if (!answerTargetMigration) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.canonicalizeLegacyAnswerTargets(now());
        this.database.prepare("INSERT INTO schema_migrations(version) VALUES (2)").run();
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
    const answerFinishMigration = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get();
    if (!answerFinishMigration) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.finishLegacyDeliveredAnswerPages(now());
        this.database.prepare("INSERT INTO schema_migrations(version) VALUES (3)").run();
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
    const answerDeadLetterMigration = this.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get();
    if (!answerDeadLetterMigration) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.dismissStreamsForFinishedAnswerPages(now());
        this.database.prepare("INSERT INTO schema_migrations(version) VALUES (4)").run();
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    }
  }

  private finishLegacyDeliveredAnswerPages(timestamp: string): void {
    this.database.prepare(`
      UPDATE answer_pages AS page
      SET state = 'finished',
          sequence = MAX(sequence, COALESCE((
            SELECT MAX(COALESCE(reply.view_version, json_extract(reply.payload, '$.sequence'), 0))
            FROM outbound_replies AS reply
            WHERE reply.prompt_id = page.prompt_id AND reply.card_role = 'answer'
              AND reply.kind = 'stream_finish' AND reply.state = 'delivered'
              AND reply.root_message_id = page.card_id
              AND json_extract(reply.payload, '$.pageIndex') IS NULL
              AND json_extract(reply.payload, '$.summary') IN ('Completed', 'Failed')
          ), sequence)),
          updated_at = ?
      WHERE page.state = 'active'
        AND EXISTS (SELECT 1 FROM run_cards AS card WHERE card.prompt_id = page.prompt_id AND card.phase IN ('completed', 'failed'))
        AND EXISTS (
          SELECT 1 FROM outbound_replies AS reply
          WHERE reply.prompt_id = page.prompt_id AND reply.card_role = 'answer'
            AND reply.kind = 'stream_finish' AND reply.state = 'delivered'
            AND reply.root_message_id = page.card_id
            AND json_extract(reply.payload, '$.pageIndex') IS NULL
            AND json_extract(reply.payload, '$.summary') IN ('Completed', 'Failed')
        )
    `).run(timestamp);
    this.dismissStreamsForFinishedAnswerPages(timestamp);
  }

  private dismissStreamsForFinishedAnswerPages(timestamp: string): void {
    this.database.prepare(`
      UPDATE outbound_replies
      SET state = 'dismissed', error = 'Answer stream targets a legacy page that was already finished', updated_at = ?
      WHERE state IN ('pending', 'dead_letter') AND kind IN ('stream_content', 'stream_finish')
        AND EXISTS (
          SELECT 1 FROM answer_pages AS page
          WHERE page.prompt_id = outbound_replies.prompt_id AND page.state = 'finished'
            AND page.card_id = outbound_replies.root_message_id
        )
    `).run(timestamp);
  }

  private canonicalizeLegacyAnswerTargets(timestamp: string): void {
    let afterPromptId = "";
    while (true) {
      const cards = this.database.prepare("SELECT prompt_id, answer_element_id, answer_page_index FROM run_cards WHERE answer_element_id != '' AND prompt_id > ? ORDER BY prompt_id LIMIT 100")
        .all(afterPromptId) as Array<{ prompt_id: string; answer_element_id: string; answer_page_index: number }>;
      if (cards.length === 0) return;
      for (const card of cards) {
        const canonical = answerElementId(card.prompt_id, Number(card.answer_page_index));
        if (canonical !== card.answer_element_id) this.database.prepare("UPDATE run_cards SET answer_element_id = ?, updated_at = ? WHERE prompt_id = ?").run(canonical, timestamp, card.prompt_id);
        const replies = this.database.prepare("SELECT id, kind, payload FROM outbound_replies INDEXED BY outbound_replies_prompt_role_state WHERE prompt_id = ? AND card_role = 'answer' AND state IN ('pending','dead_letter')").all(card.prompt_id) as Array<{ id: string; kind: string; payload: string }>;
        for (const reply of replies) {
          const payload = canonicalizeAnswerPayload(reply.kind, reply.payload, card.prompt_id, canonical);
          if (payload !== reply.payload) this.database.prepare("UPDATE outbound_replies SET payload = ?, updated_at = ? WHERE id = ?").run(payload, timestamp, reply.id);
        }
      }
      afterPromptId = cards.at(-1)!.prompt_id;
    }
  }

  private ensureBindingResetColumns(): void {
    const columns = new Set((this.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("retired_topic_id")) this.database.exec("ALTER TABLE bindings ADD COLUMN retired_topic_id TEXT");
    if (!columns.has("retired_root_message_id")) this.database.exec("ALTER TABLE bindings ADD COLUMN retired_root_message_id TEXT");
  }

  private ensureInboundMessageIdempotency(): void {
    this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS inbound_messages_message_id ON inbound_messages(message_id)");
  }

  private ensureOutboundTargetRole(): void {
    const columns = new Set((this.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("target_role")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN target_role TEXT CHECK(target_role IN ('session_status','operation_result'))");
    this.database.prepare("UPDATE outbound_replies SET target_role = 'session_status' WHERE target_role IS NULL AND kind = 'card_reply' AND idempotency_key LIKE 'status-card:%'").run();
    this.database.prepare("UPDATE outbound_replies SET target_role = 'operation_result' WHERE target_role IS NULL AND kind = 'card_reply' AND idempotency_key LIKE 'model:%'").run();
    this.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = 'Status update target was an operation result', updated_at = ? WHERE state = 'pending' AND kind = 'card_update' AND prompt_id IS NULL AND root_message_id IN (SELECT delivered_message_id FROM outbound_replies WHERE target_role = 'operation_result' AND delivered_message_id IS NOT NULL)").run(now());
    this.database.prepare("UPDATE bindings SET status_message_id = root_message_id, updated_at = ? WHERE root_message_id IS NOT NULL AND status_message_id IN (SELECT delivered_message_id FROM outbound_replies WHERE target_role = 'operation_result' AND delivered_message_id IS NOT NULL)").run(now());
  }

  private ensureTwoPhaseResetState(): void {
    const columns = new Set((this.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("replaces_binding_id")) this.database.exec("ALTER TABLE bindings ADD COLUMN replaces_binding_id TEXT REFERENCES bindings(id)");
    if (!columns.has("reserved_topic_id")) this.database.exec("ALTER TABLE bindings ADD COLUMN reserved_topic_id TEXT");
    if (!columns.has("reserved_root_message_id")) this.database.exec("ALTER TABLE bindings ADD COLUMN reserved_root_message_id TEXT");
    if (!columns.has("reset_message_id")) this.database.exec("ALTER TABLE bindings ADD COLUMN reset_message_id TEXT");
    this.database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_reset_message ON bindings(reset_message_id) WHERE reset_message_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_unfinished_reset_predecessor ON bindings(replaces_binding_id) WHERE replaces_binding_id IS NOT NULL AND lifecycle = 'provisioning';
      CREATE TABLE IF NOT EXISTS retired_pane_cleanup_operations(
        id TEXT PRIMARY KEY, old_binding_id TEXT NOT NULL UNIQUE REFERENCES bindings(id), replacement_binding_id TEXT NOT NULL REFERENCES bindings(id),
        pane_id TEXT NOT NULL, expected_workspace_id TEXT NOT NULL, expected_project_id TEXT NOT NULL, expected_cwd TEXT NOT NULL, expected_terminal_id TEXT NOT NULL, actor_open_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','waiting_busy','executing','succeeded','retained')), attempt_count INTEGER NOT NULL DEFAULT 0, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS retired_pane_cleanup_state_created ON retired_pane_cleanup_operations(state, created_at, id);
    `);
  }

  private ensureQueryIndexes(): void {
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS bindings_state_created ON bindings(state, created_at, id);
      CREATE INDEX IF NOT EXISTS bindings_root_created ON bindings(root_message_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS run_cards_binding_phase_created ON run_cards(binding_id, phase, created_at, prompt_id);
      CREATE INDEX IF NOT EXISTS outbound_replies_prompt_role_state ON outbound_replies(prompt_id, card_role, state);
    `);
  }

  private ensureOutboundDismissedState(): void {
    const schema = this.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_replies'").get() as { sql: string } | undefined;
    if (schema?.sql.includes("'dismissed'") && schema.sql.includes("'stream_card_create'")) return;
    this.database.exec(`
      PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;
      CREATE TABLE outbound_replies_next(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT REFERENCES bindings(id), prompt_id TEXT, view_version INTEGER, selection_id TEXT, card_role TEXT CHECK(card_role IN ('task','answer')), target_role TEXT CHECK(target_role IN ('session_status','operation_result')), root_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update','stream_card_create','stream_content','stream_finish')), payload TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter','dismissed')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT, card_id_checkpoint TEXT, delivery_order INTEGER, lane_key TEXT, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO outbound_replies_next(id, idempotency_key, binding_id, prompt_id, view_version, selection_id, card_role, target_role, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, lane_key, next_attempt_at, created_at, updated_at)
      SELECT id, idempotency_key, binding_id, prompt_id, view_version, selection_id, card_role, target_role, root_message_id, kind, payload, state, attempt_count, error, delivered_message_id, card_id_checkpoint, delivery_order, ${outboundLaneKeySql()}, next_attempt_at, created_at, updated_at FROM outbound_replies;
      DROP TABLE outbound_replies; ALTER TABLE outbound_replies_next RENAME TO outbound_replies;
      CREATE INDEX outbound_replies_pending ON outbound_replies(state, next_attempt_at, created_at); COMMIT; PRAGMA foreign_keys = ON;
    `);
    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) throw new Error(`Outbound-state migration produced a foreign-key violation: ${JSON.stringify(violation)}`);
  }

  private ensureStreamingCardColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    let changed = false;
    if (!names.has("answer_card_id")) { this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_card_id TEXT"); changed = true; }
    if (!names.has("answer_element_id")) { this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_element_id TEXT NOT NULL DEFAULT ''"); changed = true; }
    if (!names.has("answer_sequence")) { this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_sequence INTEGER NOT NULL DEFAULT 0"); changed = true; }
    if (!names.has("answer_page_index")) { this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_page_index INTEGER NOT NULL DEFAULT 0"); changed = true; }
    if (!names.has("answer_page_start")) { this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_page_start INTEGER NOT NULL DEFAULT 0"); changed = true; }
    this.database.exec("UPDATE run_cards SET answer_element_id = 'answer-content-' || replace(prompt_id, ':', '-') WHERE answer_element_id = ''");
    if (changed) this.recreateRunCardsView();
  }

  private ensureAnswerPages(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS answer_pages(
        prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id), page_index INTEGER NOT NULL, message_id TEXT, card_id TEXT, element_id TEXT NOT NULL,
        source_start INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN ('creating','active','frozen','finished')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(prompt_id, page_index)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS answer_pages_active ON answer_pages(prompt_id) WHERE state = 'active';
      INSERT OR IGNORE INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, created_at, updated_at)
      SELECT prompt_id, answer_page_index, answer_message_id, answer_card_id, answer_element_id, answer_page_start, answer_sequence,
        CASE WHEN answer_card_id IS NULL THEN 'creating' ELSE 'active' END, created_at, updated_at FROM run_cards;
    `);
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

  private ensureAgentSessionColumns(): void {
    const names = new Set((this.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("agent_session_source")) this.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_source TEXT");
    if (!names.has("agent_session_agent")) this.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_agent TEXT");
    if (!names.has("agent_session_kind")) this.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_kind TEXT CHECK(agent_session_kind IN ('id','path'))");
    if (!names.has("agent_session_value")) this.database.exec("ALTER TABLE bindings ADD COLUMN agent_session_value TEXT");
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

  private ensurePaneControlOperationState(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS pane_control_operations(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT NOT NULL REFERENCES bindings(id), pane_id TEXT NOT NULL, terminal_id TEXT, binding_generation INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('stop','steer','model')), payload TEXT, parent_prompt_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('accepted','running','applied','confirmed','rejected','failed','uncertain')), attempt_count INTEGER NOT NULL DEFAULT 0, detail TEXT,
        actor_open_id TEXT NOT NULL, source_message_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pane_control_operations_claim ON pane_control_operations(state, binding_id, kind, created_at);
      CREATE INDEX IF NOT EXISTS pane_control_operations_recovery ON pane_control_operations(state, updated_at);
    `);
  }

  private ensureRequestCardOutboxColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("prompt_id")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN prompt_id TEXT");
    if (!names.has("view_version")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN view_version INTEGER");
    if (!names.has("card_role")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN card_role TEXT CHECK(card_role IN ('task','answer'))");
  }

  private ensureOutboundCardCheckpoint(): void {
    const columns = this.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "card_id_checkpoint")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN card_id_checkpoint TEXT");
  }

  private ensureOutboundDeliveryOrder(): void {
    const columns = this.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "delivery_order")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN delivery_order INTEGER");
    this.database.exec(`
      UPDATE outbound_replies SET delivery_order = rowid WHERE delivery_order IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS outbound_replies_delivery_order ON outbound_replies(delivery_order);
      CREATE TRIGGER IF NOT EXISTS outbound_replies_assign_delivery_order
      AFTER INSERT ON outbound_replies WHEN NEW.delivery_order IS NULL
      BEGIN
        UPDATE outbound_replies SET delivery_order = (SELECT COALESCE(MAX(delivery_order), 0) + 1 FROM outbound_replies WHERE id != NEW.id) WHERE id = NEW.id;
      END;
    `);
  }

  private ensureOutboundLaneKey(): void {
    const columns = this.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "lane_key")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN lane_key TEXT");
    this.database.exec(`
      UPDATE outbound_replies SET lane_key = ${outboundLaneKeySql()} WHERE lane_key IS NULL OR lane_key = '';
      CREATE INDEX IF NOT EXISTS outbound_replies_lane_order ON outbound_replies(state, lane_key, delivery_order);
    `);
  }

  private ensureOutboxLaneHeads(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS outbox_lane_heads(
        lane_key TEXT PRIMARY KEY, reply_id TEXT NOT NULL UNIQUE REFERENCES outbound_replies(id) ON DELETE CASCADE,
        delivery_order INTEGER NOT NULL, next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbox_lane_heads_delivery_order ON outbox_lane_heads(delivery_order);
      CREATE INDEX IF NOT EXISTS outbox_lane_heads_next_attempt ON outbox_lane_heads(next_attempt_at, delivery_order);
      CREATE TRIGGER IF NOT EXISTS outbox_lane_heads_after_insert AFTER INSERT ON outbound_replies
      WHEN NEW.delivery_order IS NOT NULL
      BEGIN
        DELETE FROM outbox_lane_heads WHERE lane_key = NEW.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = NEW.lane_key AND state = 'pending'
          ORDER BY delivery_order LIMIT 1;
      END;
      CREATE TRIGGER IF NOT EXISTS outbox_lane_heads_after_update AFTER UPDATE OF state, lane_key, delivery_order, next_attempt_at ON outbound_replies
      BEGIN
        DELETE FROM outbox_lane_heads WHERE lane_key = OLD.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = OLD.lane_key AND state = 'pending'
          ORDER BY delivery_order LIMIT 1;
        DELETE FROM outbox_lane_heads WHERE lane_key = NEW.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = NEW.lane_key AND state = 'pending'
          ORDER BY delivery_order LIMIT 1;
      END;
      CREATE TRIGGER IF NOT EXISTS outbox_lane_heads_after_delete AFTER DELETE ON outbound_replies
      BEGIN
        DELETE FROM outbox_lane_heads WHERE lane_key = OLD.lane_key;
        INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
          SELECT lane_key, id, delivery_order, next_attempt_at, created_at
          FROM outbound_replies
          WHERE lane_key = OLD.lane_key AND state = 'pending'
          ORDER BY delivery_order LIMIT 1;
      END;
      DELETE FROM outbox_lane_heads;
      INSERT INTO outbox_lane_heads(lane_key, reply_id, delivery_order, next_attempt_at, created_at)
        SELECT pending.lane_key, pending.id, pending.delivery_order, pending.next_attempt_at, pending.created_at
        FROM outbound_replies pending
        WHERE pending.state = 'pending'
          AND pending.delivery_order = (
            SELECT MIN(candidate.delivery_order)
            FROM outbound_replies candidate
            WHERE candidate.state = 'pending' AND candidate.lane_key = pending.lane_key
          );
    `);
  }

  private ensureOutboundFailureMetadata(): void {
    const names = new Set((this.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!names.has("failure_class")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN failure_class TEXT CHECK(failure_class IN ('transient','permanent','unknown'))");
    if (!names.has("http_status")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN http_status INTEGER");
    if (!names.has("lark_error_code")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN lark_error_code TEXT");
    if (!names.has("auto_recovery_count")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN auto_recovery_count INTEGER NOT NULL DEFAULT 0");
    if (!names.has("dead_lettered_at")) this.database.exec("ALTER TABLE outbound_replies ADD COLUMN dead_lettered_at TEXT");
    this.database.exec("CREATE INDEX IF NOT EXISTS outbound_replies_auto_recovery ON outbound_replies(state, failure_class, auto_recovery_count, dead_lettered_at)");
  }

  private ensureDualRequestCardColumns(): void {
    const columns = this.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    let changed = false;
    if (!names.has("answer_message_id")) { this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_message_id TEXT"); changed = true; }
    if (!names.has("answer_delivered_version")) { this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_delivered_version INTEGER NOT NULL DEFAULT 0"); changed = true; }
    if (changed) this.recreateRunCardsView();
  }

  private ensureRunCardAnswerState(): void {
    const columns = this.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    let changed = false;
    if (!names.has("answer_segments_json")) { this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_segments_json TEXT NOT NULL DEFAULT '[]'"); changed = true; }
    if (!names.has("answer_draft")) { this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_draft TEXT NOT NULL DEFAULT ''"); changed = true; }
    if (!names.has("answer_draft_transient")) { this.database.exec("ALTER TABLE run_cards ADD COLUMN answer_draft_transient INTEGER NOT NULL DEFAULT 0"); changed = true; }
    this.database.exec("UPDATE run_cards SET answer_segments_json = json_array(answer) WHERE answer <> '' AND answer_segments_json = '[]' AND answer_draft = ''");
    if (changed) this.recreateRunCardsView();
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

  private ensureRunCardsView(): void {
    const view = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'run_cards_view'").get();
    if (!view) this.recreateRunCardsView();
  }

  private requireRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation {
    const row = this.database.prepare("SELECT * FROM retired_pane_cleanup_operations WHERE id = ?").get(id) as RetiredPaneCleanupRow | undefined;
    if (!row) throw new Error(`Retired pane cleanup ${id} not found`);
    return mapRetiredPaneCleanup(row);
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
function boundedError(value: string | null): string { return (value ?? "Unknown failure").slice(0, 500); }
function retryAt(attempt: number, explicitDelayMs?: number): string {
  const exponential = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
  const jittered = Math.round(exponential * (0.8 + Math.random() * 0.4));
  const delay = explicitDelayMs === undefined ? jittered : Math.max(exponential, Math.min(3_600_000, explicitDelayMs));
  return new Date(Date.now() + delay).toISOString();
}
function streamCardState(payload: string): { pageIndex: number; pageStart: number; elementId: string } | null {
  try {
    const decoded = JSON.parse(payload) as { stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown } };
    const stream = decoded.stream;
    return stream && Number.isInteger(stream.pageIndex) && Number.isInteger(stream.pageStart) && typeof stream.elementId === "string"
      ? { pageIndex: Number(stream.pageIndex), pageStart: Number(stream.pageStart), elementId: stream.elementId } : null;
  } catch { return null; }
}
function parseJsonRecord(payload: string): Record<string, unknown> {
  try { const value = JSON.parse(payload) as unknown; return isRecord(value) ? value : {}; } catch { return {}; }
}
function canonicalizeAnswerPayload(kind: string, payload: string, promptId: string, fallbackElementId: string): string {
  try {
    const decoded = JSON.parse(payload) as unknown;
    const pageIndex = isRecord(decoded) && isRecord(decoded.stream) && Number.isInteger(decoded.stream.pageIndex)
      ? Number(decoded.stream.pageIndex) : null;
    const elementId = pageIndex === null ? fallbackElementId : answerElementId(promptId, pageIndex);
    const normalized = replaceCardElementIds(normalizeLarkCardElementIds(decoded), elementId);
    if (!isRecord(normalized)) return payload;
    if ((kind === "stream_card_create" || kind === "stream_content") && isRecord(normalized.stream) && typeof normalized.stream.elementId === "string") {
      normalized.stream.elementId = elementId;
    }
    if (kind === "stream_content" && typeof normalized.elementId === "string") normalized.elementId = elementId;
    return JSON.stringify(normalized);
  } catch { return payload; }
}
function replaceCardElementIds(value: unknown, elementId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceCardElementIds(item, elementId));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, key === "element_id" && typeof item === "string" ? elementId : replaceCardElementIds(item, elementId)
  ]));
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
