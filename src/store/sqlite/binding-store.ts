import { transitionSession, type SessionTransition } from "../../domain/pane-thread-lifecycle.js";
import type { Binding, BindingMetadataPatch, BindingState, FailureSummary, HerdrPane, RetiredPaneCleanupOperation, RetiredPaneCleanupState, RuntimeObservationApplication, SessionSummary } from "../../domain/types.js";
import { mapBinding, mapRetiredPaneCleanup, type BindingRow, type RetiredPaneCleanupRow, type SqlValue } from "../sqlite-records.js";
import type { SqliteContext } from "./context.js";

const TRAEX_COMPATIBLE_AGENT_KINDS = new Set(["traex", "codex", "claude", "pi"]);
const BINDING_COLUMNS: Record<keyof Binding, string> = {
  id: "id", creatorOpenId: "creator_open_id", projectId: "project_id", workspaceId: "workspace_id", chatId: "chat_id", topicId: "topic_id", rootMessageId: "root_message_id", retiredTopicId: "retired_topic_id", retiredRootMessageId: "retired_root_message_id", replacesBindingId: "replaces_binding_id", reservedTopicId: "reserved_topic_id", reservedRootMessageId: "reserved_root_message_id", resetMessageId: "reset_message_id", paneId: "pane_id", traexSessionId: "traex_session_id", agentSessionSource: "agent_session_source", agentSessionAgent: "agent_session_agent", agentSessionKind: "agent_session_kind", agentSessionValue: "agent_session_value", title: "title", runtime: "runtime", state: "state", statusMessageId: "status_message_id", statusCardSequence: "status_card_sequence", lastAgentState: "last_agent_state", lastOutputFingerprint: "last_output_fingerprint", lifecycle: "lifecycle", attachment: "attachment", generation: "generation", provisioningCheckpoint: "provisioning_checkpoint", degradationCount: "degradation_count", hasCompletedTurn: "has_completed_turn", lastObservedAt: "last_observed_at", archivedAt: "archived_at", lastActivityAt: "last_activity_at", createdAt: "created_at", updatedAt: "updated_at"
};

export class SqliteBindingLifecycleStore {
  constructor(private readonly context: SqliteContext) {}
  private get database() { return this.context.database; }

  createPendingBinding(input: { id: string; projectId?: string | null; workspaceId: string; chatId: string; topicId: string | null; rootMessageId: string | null; title: string; creatorOpenId?: string | null }): Binding {
    const timestamp = now();
    this.database.prepare(`INSERT INTO bindings(id, creator_open_id, project_id, workspace_id, chat_id, topic_id, root_message_id, title, runtime, state, last_agent_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'traex', 'pending', 'unknown', ?, ?)` ).run(input.id, input.creatorOpenId ?? null, input.projectId ?? null, input.workspaceId, input.chatId, input.topicId, input.rootMessageId, input.title, timestamp, timestamp);
    return this.requireBinding(input.id);
  }

  updateBinding(id: string, patch: Partial<Binding>): Binding { return this.persistBindingPatch(id, patch); }
  updateBindingMetadata(id: string, patch: BindingMetadataPatch): Binding { return this.persistBindingPatch(id, patch); }
  setPrimaryToolCapability(input: { bindingId: string; expectedGeneration: number; capabilityHash: string }): boolean {
    const binding = this.getBinding(input.bindingId);
    if (!binding || (binding.generation !== input.expectedGeneration && binding.generation + 1 !== input.expectedGeneration)) return false;
    this.database.prepare("INSERT INTO primary_tool_capabilities(binding_id, binding_generation, capability_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(binding_id, binding_generation) DO UPDATE SET capability_hash = excluded.capability_hash, created_at = excluded.created_at").run(input.bindingId, input.expectedGeneration, input.capabilityHash, now());
    return true;
  }
  verifyPrimaryToolCapability(input: { bindingId: string; expectedGeneration: number; capabilityHash: string }): boolean { return Boolean(this.database.prepare("SELECT 1 FROM primary_tool_capabilities c JOIN bindings b ON b.id = c.binding_id WHERE c.binding_id = ? AND c.binding_generation = ? AND c.capability_hash = ? AND b.generation = c.binding_generation AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'").get(input.bindingId, input.expectedGeneration, input.capabilityHash)); }
  hasPrimaryToolCapability(bindingId: string, expectedGeneration: number): boolean { return Boolean(this.database.prepare("SELECT 1 FROM primary_tool_capabilities WHERE binding_id = ? AND binding_generation = ?").get(bindingId, expectedGeneration)); }
  revokePrimaryToolCapability(bindingId: string, expectedGeneration: number): boolean { return Number(this.database.prepare("DELETE FROM primary_tool_capabilities WHERE binding_id = ? AND binding_generation = ?").run(bindingId, expectedGeneration).changes) > 0; }
  persistBindingPatch(id: string, patch: Partial<Binding>): Binding {
    const normalized = { ...patch };
    if (patch.state && patch.lifecycle === undefined) {
      if (patch.state === "active") { normalized.lifecycle = "active"; normalized.provisioningCheckpoint = "activated"; if (patch.paneId) normalized.attachment = "attached"; }
      else if (patch.state === "archived") { normalized.lifecycle = "archived"; normalized.archivedAt = patch.archivedAt ?? now(); }
      else if (patch.state === "orphaned") { normalized.lifecycle = "active"; normalized.attachment = "orphaned"; }
      else if (patch.state === "failed") normalized.lifecycle = "failed";
    }
    const entries = Object.entries(normalized).filter(([key]) => key !== "id" && key !== "createdAt");
    entries.push(["updatedAt", now()]);
    const assignments = entries.map(([key]) => `${BINDING_COLUMNS[key as keyof Binding]} = ?`).join(", ");
    const values = entries.map(([, value]) => typeof value === "boolean" ? Number(value) : value as SqlValue);
    const result = this.database.prepare(`UPDATE bindings SET ${assignments} WHERE id = ?`).run(...values, id);
    if (result.changes === 0) throw new Error(`Binding not found: ${id}`);
    return this.requireBinding(id);
  }

  replaceProvisioningPane(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: HerdrPane }): Binding {
    const timestamp = now();
    const result = this.database.prepare(`UPDATE bindings SET pane_id = ?, traex_session_id = ?, agent_session_source = ?, agent_session_agent = ?, agent_session_kind = ?, agent_session_value = ?, workspace_id = ?, generation = generation + 1, last_agent_state = ?, last_observed_at = NULL, updated_at = ? WHERE id = ? AND pane_id = ? AND generation = ? AND lifecycle = 'provisioning' AND provisioning_checkpoint = 'pane_created'`).run(input.pane.paneId, input.pane.terminalId ?? null, input.pane.agentSession?.source ?? null, input.pane.agentSession?.agent ?? null, input.pane.agentSession?.kind ?? null, input.pane.agentSession?.value ?? null, input.pane.workspaceId, input.pane.agentState, timestamp, input.bindingId, input.expectedPaneId, input.expectedGeneration);
    if (result.changes !== 1) throw new Error(`Provisioning pane replacement lost ownership for binding ${input.bindingId}`);
    return this.requireBinding(input.bindingId);
  }

  transitionBinding(id: string, transition: SessionTransition): Binding {
    const binding = this.requireBinding(id);
    const next = transitionSession({ lifecycle: binding.lifecycle, attachment: binding.attachment, runtime: binding.lastAgentState, generation: binding.generation, provisioningCheckpoint: binding.provisioningCheckpoint, degradationCount: binding.degradationCount, hasCompletedTurn: binding.hasCompletedTurn }, transition);
    const state: BindingState = next.attachment === "orphaned" && next.lifecycle !== "archived" && next.lifecycle !== "closed" ? "orphaned" : next.lifecycle === "provisioning" ? "pending" : next.lifecycle === "active" || next.lifecycle === "draining" ? "active" : next.lifecycle === "archived" || next.lifecycle === "closed" ? "archived" : "failed";
    return this.persistBindingPatch(id, { lifecycle: next.lifecycle, attachment: next.attachment, lastAgentState: next.runtime, generation: next.generation, provisioningCheckpoint: next.provisioningCheckpoint, degradationCount: next.degradationCount, hasCompletedTurn: next.hasCompletedTurn, state, lastObservedAt: transition.type === "pane_observed" ? now() : binding.lastObservedAt, archivedAt: next.lifecycle === "archived" ? binding.archivedAt ?? now() : binding.archivedAt });
  }

  applyRuntimeObservation(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: HerdrPane }): RuntimeObservationApplication {
    return this.context.transaction(() => {
      let binding = this.requireBinding(input.bindingId);
      if (binding.paneId !== input.expectedPaneId || input.pane.paneId !== input.expectedPaneId || binding.generation !== input.expectedGeneration || (binding.lifecycle !== "active" && binding.lifecycle !== "draining") || binding.attachment === "orphaned") return { outcome: "stale_binding" };
      const persisted = binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } : null;
      const observed = input.pane.agentSession ?? null;
      const sameSession = Boolean(persisted && observed && persisted.source === observed.source && persisted.agent === observed.agent && persisted.kind === observed.kind && persisted.value === observed.value);
      const terminalIdentityRefreshed = Boolean(binding.traexSessionId && input.pane.terminalId && binding.traexSessionId !== input.pane.terminalId && sameSession);
      if (binding.traexSessionId && input.pane.terminalId && binding.traexSessionId !== input.pane.terminalId && !sameSession) return { outcome: "terminal_identity_changed", binding };
      const nativeSessionMismatch = Boolean(persisted && observed && !sameSession);
      if (terminalIdentityRefreshed || (!persisted && observed)) binding = this.persistBindingPatch(binding.id, { ...(terminalIdentityRefreshed ? { traexSessionId: input.pane.terminalId ?? null } : {}), ...(!persisted && observed ? { agentSessionSource: observed.source, agentSessionAgent: observed.agent, agentSessionKind: observed.kind, agentSessionValue: observed.value } : {}) });
      binding = this.transitionBinding(binding.id, { type: "pane_observed", runtime: input.pane.agentState });
      return { outcome: "applied", binding, terminalIdentityRefreshed, nativeSessionMismatch };
    });
  }

  attachBindingPane(id: string, pane: HerdrPane, replacement: boolean): Binding {
    const binding = this.requireBinding(id);
    const next = transitionSession({ lifecycle: binding.lifecycle, attachment: binding.attachment, runtime: binding.lastAgentState, generation: binding.generation, provisioningCheckpoint: binding.provisioningCheckpoint, degradationCount: binding.degradationCount, hasCompletedTurn: binding.hasCompletedTurn }, { type: "pane_reattached", replacement });
    const suspended = transitionSession(next, { type: "archive_requested", hasActiveTurn: false });
    return this.context.transaction(() => {
      const timestamp = now();
      this.database.prepare(`UPDATE bindings SET pane_id = ?, traex_session_id = ?, agent_session_source = ?, agent_session_agent = ?, agent_session_kind = ?, agent_session_value = ?, workspace_id = ?, lifecycle = ?, attachment = ?, state = 'archived', generation = ?, last_agent_state = ?, degradation_count = 0, last_observed_at = ?, archived_at = ?, updated_at = ? WHERE id = ?`).run(pane.paneId, pane.terminalId ?? null, pane.agentSession?.source ?? null, pane.agentSession?.agent ?? null, pane.agentSession?.kind ?? null, pane.agentSession?.value ?? null, pane.workspaceId, suspended.lifecycle, suspended.attachment, suspended.generation, suspended.runtime, timestamp, timestamp, timestamp, id);
      if (!replacement) this.database.prepare("DELETE FROM primary_tool_capabilities WHERE binding_id = ? AND binding_generation = ?").run(id, suspended.generation);
      return this.requireBinding(id);
    });
  }

  getBinding(id: string): Binding | null { const row = this.database.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as BindingRow | undefined; return row ? mapBinding(row) : null; }
  findBindingByTopic(topicId: string): Binding | null { const row = this.database.prepare("SELECT * FROM bindings WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1").get(topicId) as BindingRow | undefined; return row ? mapBinding(row) : null; }
  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null { if (!topicId && !rootMessageId) return null; const row = this.database.prepare("SELECT * FROM bindings WHERE (? IS NOT NULL AND topic_id = ?) OR (? IS NOT NULL AND root_message_id = ?) ORDER BY created_at DESC LIMIT 1").get(topicId, topicId, rootMessageId, rootMessageId) as BindingRow | undefined; return row ? mapBinding(row) : null; }
  findBindingByPane(paneId: string): Binding | null { const row = this.database.prepare("SELECT * FROM bindings WHERE pane_id = ? ORDER BY created_at DESC LIMIT 1").get(paneId) as BindingRow | undefined; return row ? mapBinding(row) : null; }
  listBindings(): Binding[] { return (this.database.prepare("SELECT * FROM bindings ORDER BY created_at").all() as BindingRow[]).map(mapBinding); }
  listBindingsByState(state: Binding["state"]): Binding[] { return (this.database.prepare("SELECT * FROM bindings WHERE state = ? ORDER BY created_at, id").all(state) as BindingRow[]).map(mapBinding); }

  listSessions(chatId: string): SessionSummary[] {
    const rows = this.database.prepare(`SELECT b.*, (SELECT COUNT(*) FROM prompt_jobs p WHERE p.binding_id = b.id AND p.state IN ('queued','running')) AS queue_depth, COALESCE((SELECT r.space_name FROM run_cards r WHERE r.binding_id = b.id ORDER BY r.created_at DESC LIMIT 1), b.project_id, b.workspace_id) AS space_name FROM bindings b WHERE b.chat_id = ? ORDER BY CASE b.attachment WHEN 'degraded' THEN 0 WHEN 'orphaned' THEN 2 ELSE 1 END, CASE b.lifecycle WHEN 'active' THEN 0 WHEN 'provisioning' THEN 1 WHEN 'draining' THEN 2 WHEN 'archived' THEN 3 WHEN 'closed' THEN 4 ELSE 5 END, b.last_activity_at DESC, b.id`).all(chatId) as Array<BindingRow & { queue_depth: number; space_name: string }>;
    return rows.map((row) => ({ binding: mapBinding(row), queueDepth: Number(row.queue_depth), spaceName: row.space_name }));
  }

  listFailures(chatId: string): FailureSummary[] {
    const outbound = this.database.prepare(`SELECT o.id, o.binding_id, o.attempt_count, o.updated_at, o.error, b.pane_id, b.title, COALESCE((SELECT r.space_name FROM run_cards r WHERE r.binding_id = b.id ORDER BY r.created_at DESC LIMIT 1), b.project_id, b.workspace_id) AS space_name FROM outbound_replies o LEFT JOIN bindings b ON b.id = o.binding_id LEFT JOIN project_selections s ON s.id = o.selection_id WHERE o.state = 'dead_letter' AND (b.chat_id = ? OR s.chat_id = ?) ORDER BY o.updated_at DESC`).all(chatId, chatId) as Array<{ id: string; binding_id: string | null; attempt_count: number; updated_at: string; error: string | null; pane_id: string | null; title: string | null; space_name: string | null }>;
    const prompts = this.database.prepare(`SELECT p.id, p.binding_id, p.updated_at, p.error, b.pane_id, b.title, COALESCE((SELECT r.space_name FROM run_cards r WHERE r.binding_id = b.id ORDER BY r.created_at DESC LIMIT 1), b.project_id, b.workspace_id) AS space_name FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id WHERE b.chat_id = ? AND p.state IN ('failed','cancelled') ORDER BY p.updated_at DESC`).all(chatId) as Array<{ id: string; binding_id: string; updated_at: string; error: string | null; pane_id: string | null; title: string; space_name: string }>;
    const sessions = this.database.prepare(`SELECT b.id, b.updated_at, b.lifecycle, b.attachment, b.pane_id, b.title, COALESCE((SELECT r.space_name FROM run_cards r WHERE r.binding_id = b.id ORDER BY r.created_at DESC LIMIT 1), b.project_id, b.workspace_id) AS space_name FROM bindings b WHERE b.chat_id = ? AND (b.lifecycle IN ('failed','provisioning') OR b.attachment IN ('degraded','orphaned')) ORDER BY b.updated_at DESC`).all(chatId) as Array<{ id: string; updated_at: string; lifecycle: string; attachment: string; pane_id: string | null; title: string; space_name: string }>;
    return [...outbound.map((row): FailureSummary => ({ kind: "outbound", id: row.id, bindingId: row.binding_id, attemptCount: Number(row.attempt_count), updatedAt: row.updated_at, error: boundedError(row.error), ...(row.space_name ? { spaceName: row.space_name } : {}), paneId: row.pane_id, ...(row.title ? { title: row.title } : {}) })), ...prompts.map((row): FailureSummary => ({ kind: "prompt", id: row.id, bindingId: row.binding_id, updatedAt: row.updated_at, error: boundedError(row.error), spaceName: row.space_name, paneId: row.pane_id, title: row.title })), ...sessions.map((row): FailureSummary => ({ kind: "session", id: `session:${row.id}`, bindingId: row.id, updatedAt: row.updated_at, error: `Session is ${row.lifecycle}/${row.attachment}`, spaceName: row.space_name, paneId: row.pane_id, title: row.title }))].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  createResetCandidate(input: { oldBindingId: string; newBindingId: string; title: string; actorOpenId: string; resetMessageId: string }): { previous: Binding; replacement: Binding; created: boolean } {
    return this.context.transaction(() => {
      const previous = this.requireBinding(input.oldBindingId);
      const existing = this.database.prepare("SELECT * FROM bindings WHERE reset_message_id = ?").get(input.resetMessageId) as BindingRow | undefined;
      if (existing) return { previous, replacement: mapBinding(existing), created: false };
      if (previous.lifecycle !== "active" || previous.state !== "active" || !previous.projectId || !previous.topicId || !previous.rootMessageId) throw new Error("Binding is not eligible for in-topic reset");
      const timestamp = now();
      this.database.prepare(`INSERT INTO bindings(id, project_id, workspace_id, chat_id, topic_id, root_message_id, replaces_binding_id, reserved_topic_id, reserved_root_message_id, reset_message_id, title, runtime, state, last_agent_state, lifecycle, attachment, generation, provisioning_checkpoint, degradation_count, has_completed_turn, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 'traex', 'pending', 'unknown', 'provisioning', 'unattached', 1, 'selected', 0, 0, ?, ?, ?)` ).run(input.newBindingId, previous.projectId, previous.workspaceId, previous.chatId, previous.id, previous.topicId, previous.rootMessageId, input.resetMessageId, input.title, timestamp, timestamp, timestamp);
      this.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, 'binding.reset.candidate', ?, 'created', ?)").run(input.actorOpenId, `${previous.id}:${input.newBindingId}`, timestamp);
      return { previous, replacement: this.requireBinding(input.newBindingId), created: true };
    });
  }

  cutoverResetCandidate(input: { oldBindingId: string; newBindingId: string; cleanupOperationId: string; actorOpenId: string; expectedCwd: string }): { previous: Binding; replacement: Binding; cleanup: RetiredPaneCleanupOperation; cancelledPromptIds: string[] } {
    return this.context.transaction(() => {
      const previous = this.requireBinding(input.oldBindingId); const candidate = this.requireBinding(input.newBindingId);
      if (previous.lifecycle !== "active" || previous.state !== "active" || !previous.projectId || !previous.topicId || !previous.rootMessageId || !previous.paneId || !previous.traexSessionId) throw new Error("Binding is not eligible for reset cutover");
      if (candidate.replacesBindingId !== previous.id || candidate.reservedTopicId !== previous.topicId || candidate.reservedRootMessageId !== previous.rootMessageId || candidate.lifecycle !== "provisioning" || candidate.provisioningCheckpoint !== "runtime_started" || !candidate.paneId || !candidate.traexSessionId) throw new Error("Reset candidate is not ready for cutover");
      const timestamp = now();
      const cancelledPromptIds = (this.database.prepare("SELECT id FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' ORDER BY created_at, id").all(previous.id) as Array<{ id: string }>).map((row) => row.id);
      this.database.prepare("UPDATE prompt_jobs SET state = 'cancelled', error = ?, updated_at = ? WHERE binding_id = ? AND state = 'queued'").run("话题已开启新会话，排队请求未提交给 TraeX。", timestamp, previous.id);
      this.database.prepare("UPDATE prompt_jobs SET observation_state = 'detached', was_detached = 1, error = ?, updated_at = ? WHERE binding_id = ? AND state = 'running'").run("话题已开启新会话；Bridge 不再观察该 TraeX 请求，也不会重放。", timestamp, previous.id);
      this.database.prepare("UPDATE outbound_replies SET state = 'dismissed', error = ?, updated_at = ? WHERE binding_id = ? AND state = 'pending'").run("话题已开启新会话；不再投递旧会话更新。", timestamp, previous.id);
      this.database.prepare(`UPDATE bindings SET topic_id = NULL, root_message_id = NULL, retired_topic_id = ?, retired_root_message_id = ?, lifecycle = 'archived', state = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`).run(previous.topicId, previous.rootMessageId, timestamp, timestamp, previous.id);
      this.database.prepare(`UPDATE bindings SET topic_id = ?, root_message_id = ?, status_message_id = ?, lifecycle = 'active', attachment = 'attached', state = 'active', provisioning_checkpoint = 'activated', updated_at = ? WHERE id = ?`).run(previous.topicId, previous.rootMessageId, previous.rootMessageId, timestamp, candidate.id);
      this.database.prepare(`INSERT INTO retired_pane_cleanup_operations(id, old_binding_id, replacement_binding_id, pane_id, expected_workspace_id, expected_project_id, expected_cwd, expected_terminal_id, actor_open_id, state, attempt_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)` ).run(input.cleanupOperationId, previous.id, candidate.id, previous.paneId, previous.workspaceId, previous.projectId, input.expectedCwd, previous.traexSessionId, input.actorOpenId, timestamp, timestamp);
      this.database.prepare("INSERT INTO audit_log(actor_open_id, action, target, outcome, created_at) VALUES (?, 'binding.reset', ?, 'cutover', ?)").run(input.actorOpenId, `${previous.id}:${input.newBindingId}`, timestamp);
      return { previous: this.requireBinding(previous.id), replacement: this.requireBinding(input.newBindingId), cleanup: this.requireRetiredPaneCleanup(input.cleanupOperationId), cancelledPromptIds };
    });
  }

  listRetiredPaneCleanupOperations(states: readonly RetiredPaneCleanupState[] = ["pending", "waiting_busy", "executing"]): RetiredPaneCleanupOperation[] { if (states.length === 0) return []; const placeholders = states.map(() => "?").join(","); return (this.database.prepare(`SELECT * FROM retired_pane_cleanup_operations WHERE state IN (${placeholders}) ORDER BY created_at, id`).all(...states) as RetiredPaneCleanupRow[]).map(mapRetiredPaneCleanup); }
  claimRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null { const result = this.database.prepare("UPDATE retired_pane_cleanup_operations SET state = 'executing', attempt_count = attempt_count + 1, detail = NULL, updated_at = ? WHERE id = ? AND state IN ('pending','waiting_busy')").run(now(), id); return result.changes === 1 ? this.requireRetiredPaneCleanup(id) : null; }
  updateRetiredPaneCleanup(id: string, state: RetiredPaneCleanupState, detail: string | null = null): RetiredPaneCleanupOperation | null { const result = this.database.prepare("UPDATE retired_pane_cleanup_operations SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state IN ('pending','waiting_busy','executing')").run(state, detail, now(), id); return result.changes === 1 ? this.requireRetiredPaneCleanup(id) : null; }
  completeRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null { return this.context.transaction(() => { const operation = this.requireRetiredPaneCleanup(id); if (operation.state !== "executing") return null; const binding = this.requireBinding(operation.oldBindingId); if (binding.lifecycle !== "archived" || binding.paneId !== operation.paneId) throw new Error("Retired pane cleanup binding identity changed"); const timestamp = now(); this.database.prepare("UPDATE bindings SET lifecycle = 'closed', attachment = 'unattached', state = 'archived', last_agent_state = 'unknown', updated_at = ? WHERE id = ?").run(timestamp, binding.id); this.database.prepare("UPDATE retired_pane_cleanup_operations SET state = 'succeeded', detail = NULL, updated_at = ? WHERE id = ? AND state = 'executing'").run(timestamp, id); return this.requireRetiredPaneCleanup(id); }); }

  private requireBinding(id: string): Binding { const binding = this.getBinding(id); if (!binding) throw new Error(`Binding not found: ${id}`); return binding; }
  private requireRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation { const row = this.database.prepare("SELECT * FROM retired_pane_cleanup_operations WHERE id = ?").get(id) as RetiredPaneCleanupRow | undefined; if (!row) throw new Error(`Retired pane cleanup ${id} not found`); return mapRetiredPaneCleanup(row); }
}

function now(): string { return new Date().toISOString(); }
function boundedError(value: string | null): string { return (value ?? "Unknown failure").slice(0, 500); }
