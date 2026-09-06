import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { estimateQueueWait } from "../domain/queue-wait-estimate.js";
import type { AcceptInstanceTurnWithCardInput, BindingStorePort, ClassifiedPromptAcceptance, ClassifiedPromptInput } from "../domain/ports.js";
import type { TurnControlStore } from "../domain/ports/turn-control.js";
import type { AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, Binding, BindingMetadataPatch, BindingState, BindingTitleProjectionInput, BindingTitleProjectionResult, CardInteraction, CardInteractionActionKind, DeadLetterActionOutcome, DeliveryFailureClass, DeliveryFailureMetadata, DurablePromptWorkScan, ExternalTurnAdoption, FailureSummary, HerdrPane, IncomingLarkMessage, InstanceLease, MainCardReservationOutcome, OperationalSummary, OrphanBindingProjectionInput, OrphanBindingProjectionResult, OutboundFailureTransition, OutboxLaneClass, OutboundReply, OutboundReplyState, OutboundTargetRole, PaneCloseOperation, PaneControlOperation, PaneControlOperationKind, ProjectSelection, ProjectSelectionClaim, PromptDispatchKind, PromptJob, PromptObservationState, PromptState, PromptWorkHint, RecoverOrphanBindingProjectionInput, RecoverOrphanBindingProjectionResult, RetiredPaneCleanupOperation, RetiredPaneCleanupState, RuntimeDegradationInput, RuntimeDegradationResult, RuntimeObservationApplication, SessionOperation, SessionOperationKind, SessionOperationState, SessionSummary, SqliteIntegrityInspection, StalePromptClaim, TranscriptTurnClaimOutcome } from "../domain/types.js";
import type { TopicViewState } from "../domain/topic-view.js";
import type { MainCardLiveStatus } from "../domain/run-card-view.js";
import type { RunCardView } from "../domain/run-card-view.js";
import { answerElementId, freezeRunCardWorkerContext, reduceRunCard } from "../domain/run-card-view.js";
import { initialTopicView, mirrorRunCardToTopic } from "../domain/topic-view.js";
import type { BridgeEvent } from "../domain/events.js";
import { transitionSession, type AttachmentState, type SessionLifecycle, type SessionTransition } from "../domain/pane-thread-lifecycle.js";
import { ANSWER_RECOVERY_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage } from "../runtime/answer-stream.js";
import { paneControlOutcomeSources, type PaneControlOutcome } from "../domain/pane-control-lifecycle.js";
import { outboundLaneKey, outboundLaneKeySql } from "./outbox-lanes.js";
import { mapAnswerPage, mapBinding, mapCardInteraction, mapCommandIntent, mapInstanceLease, mapModelPreference, mapOutboundReply, mapPaneControlOperation, mapProjectSelection, mapPrompt, mapRetiredPaneCleanup, mapSessionOperation, mapTurnControlOperation, type AnswerPageRow, type BindingRow, type CardInteractionRow, type CommandIntentRow, type ModelPreferenceRow, type OutboundReplyRow, type PaneControlOperationRow, type ProjectSelectionRow, type PromptRow, type RetiredPaneCleanupRow, type SessionOperationRow, type SqlValue, type TurnControlOperationRow } from "./sqlite-records.js";
import type { ModelPreference } from "../domain/model-selection.js";
import { acceptModelSelection } from "../domain/model-selection.js";
import type { AgentInstance, CreateAgentInstanceInput, InstanceProvisioningCheckpoint, InstanceRemovalPlan, WorkspaceLease, WorkspaceLeaseState } from "../domain/agent-instance.js";
import { mapAgentInstance, mapWorkspaceLease, type AgentInstanceRow, type WorkspaceLeaseRow } from "./instance-records.js";
import type { ControlActor } from "../domain/commands.js";
import type { InstanceEvent, InstanceEventKind, InstanceOperation, InstanceTurn, InstanceTurnState, InstanceTurnSummary } from "../domain/instance-turn.js";
import type { ApprovalGrant, ApprovalIdentity, ApprovalRequest } from "../domain/approval-policy.js";
import { reduceWorkerTurnCard, updateWorkerTurnCardTargets, type WorkerTurnCardChange, type WorkerTurnCardPage, type WorkerTurnCardView } from "../domain/worker-turn-card-view.js";
import type { WorkerMainView } from "../domain/worker-main-view.js";
import type { CardContextInvalidation, CardContextTarget } from "../domain/card-context-invalidation.js";
import { selectPrimaryWorkerActivity, selectPrimaryWorkerSummaries } from "../domain/card-context-summary.js";
import { selectWorkerMainView } from "../domain/worker-main-selector.js";
import { updateTopicWorkerContext } from "../domain/topic-view.js";
import { updateRunCardWorkerContext } from "../domain/run-card-view.js";
import { inspectSqliteIntegrity } from "./sqlite-integrity.js";
import { sessionOperationRejection } from "../domain/session-operation-policy.js";
import type { AcceptTurnControlOperationInput, TurnControlOperation, TurnControlState, TurnTarget } from "../domain/turn-control.js";
import type { AcceptCommandIntentInput, AcceptCommandIntentResult, CommandIntent, CommandIntentTerminalState } from "../domain/command-intent.js";
import { SqliteContext } from "./sqlite/context.js";
import { SqliteApprovalStore } from "./sqlite/approval-store.js";
import { SqliteLeaseStore } from "./sqlite/lease-store.js";
import { SqliteMigrations } from "./sqlite/migrations.js";
import { SqliteOperationsStore } from "./sqlite/operations-store.js";
import { SqliteCommandIntentStore } from "./sqlite/command-intent-store.js";
import { SqliteSessionOperationStore } from "./sqlite/session-operation-store.js";
import { SqliteWorkerTurnStore } from "./sqlite/worker-turn-store.js";
import { SqliteProjectionStore } from "./sqlite/projection-store.js";
import { SqlitePromptStore } from "./sqlite/prompt-store.js";
import { SqliteOutboxStore } from "./sqlite/outbox-store.js";
const TRAEX_COMPATIBLE_AGENT_KINDS = new Set(["traex", "codex", "claude", "pi"]);

const BINDING_COLUMNS: Record<keyof Binding, string> = {
  id: "id", creatorOpenId: "creator_open_id", projectId: "project_id", workspaceId: "workspace_id", chatId: "chat_id", topicId: "topic_id",
    rootMessageId: "root_message_id", retiredTopicId: "retired_topic_id", retiredRootMessageId: "retired_root_message_id", replacesBindingId: "replaces_binding_id", reservedTopicId: "reserved_topic_id", reservedRootMessageId: "reserved_root_message_id", resetMessageId: "reset_message_id", paneId: "pane_id", traexSessionId: "traex_session_id",
  agentSessionSource: "agent_session_source", agentSessionAgent: "agent_session_agent", agentSessionKind: "agent_session_kind", agentSessionValue: "agent_session_value",
  title: "title", runtime: "runtime", state: "state", statusMessageId: "status_message_id", statusCardSequence: "status_card_sequence",
  lastAgentState: "last_agent_state", lastOutputFingerprint: "last_output_fingerprint",
  lifecycle: "lifecycle", attachment: "attachment", generation: "generation", provisioningCheckpoint: "provisioning_checkpoint",
  degradationCount: "degradation_count", hasCompletedTurn: "has_completed_turn", lastObservedAt: "last_observed_at",
  archivedAt: "archived_at", lastActivityAt: "last_activity_at",
  createdAt: "created_at", updatedAt: "updated_at"
};

export class SqliteBindingStore implements BindingStorePort, TurnControlStore {
  readonly database: DatabaseSync;
  private readonly context: SqliteContext;
  private readonly approvals: SqliteApprovalStore;
  private readonly leases: SqliteLeaseStore;
  private readonly migrations: SqliteMigrations;
  private readonly operations: SqliteOperationsStore;
  private readonly commandIntents: SqliteCommandIntentStore;
  private readonly sessionOperations: SqliteSessionOperationStore;
  private readonly workerTurns: SqliteWorkerTurnStore;
  private readonly projections: SqliteProjectionStore;
  private readonly prompts: SqlitePromptStore;
  private readonly outbox: SqliteOutboxStore;

  constructor(path: string) {
    this.context = new SqliteContext(path);
    this.database = this.context.database;
    this.migrations = new SqliteMigrations(this.context);
    this.migrations.run();
    this.operations = new SqliteOperationsStore(this.context);
    this.commandIntents = new SqliteCommandIntentStore(this.context);
    this.sessionOperations = new SqliteSessionOperationStore(this.context, (id) => this.getBinding(id));
    this.projections = new SqliteProjectionStore(this.context, {
      enqueueOutboundReply: (input) => this.enqueueOutboundReply(input),
      hasPendingAnswerContinuation: (promptId, pageIndex) => this.hasPendingAnswerContinuation(promptId, pageIndex),
      getBinding: (id) => this.getBinding(id),
      refreshOutboxLaneHead: (laneKey) => this.outbox.refreshOutboxLaneHead(laneKey)
    });
    this.outbox = new SqliteOutboxStore(this.context, {
      getBinding: (id) => this.getBinding(id),
      loadRunCard: (promptId) => this.projections.loadRunCard(promptId),
      getActiveAnswerPage: (promptId) => this.projections.getActiveAnswerPage(promptId),
      loadWorkerTurnCard: (turnId) => this.workerTurns.loadWorkerTurnCard(turnId),
      listWorkerTurnCardPages: (turnId) => this.workerTurns.listWorkerTurnCardPages(turnId),
      loadWorkerMainView: (workerId, generation) => this.loadWorkerMainView(workerId, generation),
      saveRunCard: (view) => this.projections.saveRunCard(view),
      persistBindingPatch: (id, patch) => this.persistBindingPatch(id, patch),
      invalidateCardContexts: (targets) => this.invalidateCardContexts(targets)
    });
    this.prompts = new SqlitePromptStore(this.context, this.projections, {
      getBinding: (id) => this.getBinding(id),
      persistBindingPatch: (id, patch) => this.persistBindingPatch(id, patch),
      transitionBinding: (id, transition) => this.transitionBinding(id, transition),
      loadCardContextInvalidation: (target) => this.loadCardContextInvalidation(target),
      loadPrimaryWorkerActivity: (promptId, bindingGeneration) => this.loadPrimaryWorkerActivity(promptId, bindingGeneration),
      enqueueOutboundReply: (input) => this.enqueueOutboundReply(input)
    });
    this.workerTurns = new SqliteWorkerTurnStore(this.context, {
      getAgentInstance: (id) => this.getAgentInstance(id),
      enqueueOutboundReply: (input) => this.enqueueOutboundReply(input),
      invalidateWorkerCardContexts: (view, reason) => this.invalidateWorkerCardContexts(view, reason)
    });
    this.approvals = new SqliteApprovalStore(this.context);
    this.leases = new SqliteLeaseStore(this.context);
  }

  close(): void { this.context.close(); }

  createApprovalRequest(input: ApprovalIdentity & { id: string; expiresAt: string }): ApprovalRequest {
    return this.approvals.createApprovalRequest(input);
  }

  resolveApprovalRequest(input: { requestId: string; actorId: string; approved: boolean; now: string; grantId: string }): { outcome: "approved" | "rejected" | "missing" | "unauthorized" | "expired" | "duplicate"; request: ApprovalRequest | null; grant: ApprovalGrant | null } {
    return this.approvals.resolveApprovalRequest(input);
  }

  consumeApprovalGrant(input: ApprovalIdentity & { grantId: string; now: string }): "consumed" | "missing" | "expired" | "used" | "mismatch" {
    return this.approvals.consumeApprovalGrant(input);
  }

  activateWriteFence(ownerId: string, fencingToken: number): void {
    this.leases.activateWriteFence(ownerId, fencingToken);
  }

  deactivateWriteFence(): void {
    this.leases.deactivateWriteFence();
  }

  acquireInstanceLease(ownerId: string, currentTime: string, expiresAt: string): InstanceLease | null {
    return this.leases.acquireInstanceLease(ownerId, currentTime, expiresAt);
  }

  renewInstanceLease(ownerId: string, fencingToken: number, currentTime: string, expiresAt: string): InstanceLease | null {
    return this.leases.renewInstanceLease(ownerId, fencingToken, currentTime, expiresAt);
  }

  releaseInstanceLease(ownerId: string, fencingToken: number): boolean {
    return this.leases.releaseInstanceLease(ownerId, fencingToken);
  }

  createAgentInstance(input: CreateAgentInstanceInput): AgentInstance {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO agent_instances(
          id, project_id, name, role, agent_kind, model, source_primary_pane_label, parent_binding_id, parent_binding_generation, parent_pane_id, parent_native_session_id, worker_session_lifecycle, desired_state, observed_state, workspace_lease_id, generation, created_at, updated_at
          , provisioning_checkpoint, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unprovisioned', ?, 1, ?, ?, 'recorded', NULL)
      `).run(input.id, input.projectId, input.name, input.role, input.agentKind, input.model, input.sourcePrimaryPaneLabel ?? null, input.parent?.bindingId ?? null, input.parent?.bindingGeneration ?? null, input.parent?.paneId ?? null, input.parent?.nativeSessionId ?? null, input.workerSessionLifecycle ?? (input.role === "worker" ? "legacy" : null), input.desiredState, input.workspace.id, timestamp, timestamp);
      this.database.prepare(`
        INSERT INTO workspace_leases(id, project_id, instance_id, kind, cwd, branch, base_commit, state, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'allocating', 1, ?, ?)
      `).run(input.workspace.id, input.projectId, input.id, input.workspace.kind, input.workspace.cwd, input.workspace.branch, input.workspace.baseCommit, timestamp, timestamp);
      this.database.exec("COMMIT");
      return this.getAgentInstance(input.id)!;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  createWorkerAgentInstance(input: CreateAgentInstanceInput & { role: "worker" }, maxWorkers: number): { outcome: "created"; instance: AgentInstance } | { outcome: "limit-reached" } | { outcome: "duplicate-name" } {
    if (!input.parent) throw new Error("Worker parent identity is required");
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const count = this.database.prepare("SELECT COUNT(*) AS count FROM agent_instances WHERE project_id = ? AND role = 'worker' AND worker_session_lifecycle = 'active'").get(input.projectId) as { count: number };
      if (count.count >= maxWorkers) { this.database.exec("COMMIT"); return { outcome: "limit-reached" }; }
      const duplicate = this.database.prepare("SELECT 1 FROM agent_instances WHERE role = 'worker' AND worker_session_lifecycle = 'active' AND parent_binding_id = ? AND parent_pane_id = ? AND name = ? LIMIT 1").get(input.parent.bindingId, input.parent.paneId, input.name);
      if (duplicate) { this.database.exec("COMMIT"); return { outcome: "duplicate-name" }; }
      this.database.prepare(`
        INSERT INTO agent_instances(
          id, project_id, name, role, agent_kind, model, source_primary_pane_label, parent_binding_id, parent_binding_generation, parent_pane_id, parent_native_session_id, worker_session_lifecycle, desired_state, observed_state, workspace_lease_id, generation, created_at, updated_at,
          provisioning_checkpoint, last_error
        ) VALUES (?, ?, ?, 'worker', ?, ?, ?, ?, ?, ?, ?, 'active', ?, 'unprovisioned', ?, 1, ?, ?, 'recorded', NULL)
      `).run(input.id, input.projectId, input.name, input.agentKind, input.model, input.sourcePrimaryPaneLabel ?? null, input.parent.bindingId, input.parent.bindingGeneration ?? null, input.parent.paneId, input.parent.nativeSessionId, input.desiredState, input.workspace.id, timestamp, timestamp);
      this.database.prepare(`
        INSERT INTO workspace_leases(id, project_id, instance_id, kind, cwd, branch, base_commit, state, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'allocating', 1, ?, ?)
      `).run(input.workspace.id, input.projectId, input.id, input.workspace.kind, input.workspace.cwd, input.workspace.branch, input.workspace.baseCommit, timestamp, timestamp);
      const instance = this.getAgentInstance(input.id)!;
      this.invalidateWorkerInstanceContexts(instance, "worker.created");
      this.database.exec("COMMIT");
      return { outcome: "created", instance };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  getAgentInstance(id: string): AgentInstance | null {
    const row = this.database.prepare("SELECT * FROM agent_instances WHERE id = ?").get(id) as AgentInstanceRow | undefined;
    return row ? mapAgentInstance(row) : null;
  }

  loadWorkerMainView(workerId: string, workerSessionGeneration: number): WorkerMainView | null {
    const row = this.database.prepare("SELECT state_json FROM worker_main_views WHERE worker_id = ? AND worker_session_generation = ?").get(workerId, workerSessionGeneration) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as WorkerMainView : null;
  }

  saveWorkerMainView(view: WorkerMainView): WorkerMainView | null {
    const instance = this.getAgentInstance(view.workerId);
    if (!instance || instance.role !== "worker" || instance.workerSessionGeneration !== view.workerSessionGeneration
      || instance.parent?.bindingId !== view.parentBindingId || instance.parent.paneId !== view.parentPaneId) return null;
    const result = this.database.prepare(`
      INSERT INTO worker_main_views(worker_id, worker_session_generation, parent_binding_id, parent_binding_generation, parent_pane_id, state_json, view_version, delivered_version, message_id, card_id, frozen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id, worker_session_generation) DO UPDATE SET
        state_json=excluded.state_json, view_version=excluded.view_version, delivered_version=excluded.delivered_version, message_id=excluded.message_id, card_id=excluded.card_id, frozen_at=excluded.frozen_at, updated_at=excluded.updated_at
      WHERE worker_main_views.frozen_at IS NULL AND excluded.view_version >= worker_main_views.view_version
    `).run(view.workerId, view.workerSessionGeneration, view.parentBindingId, view.parentBindingGeneration, view.parentPaneId, JSON.stringify(view), view.viewVersion, view.deliveredVersion, view.messageId, view.cardId, view.frozenAt, view.createdAt, view.updatedAt);
    return result.changes === 1 ? this.loadWorkerMainView(view.workerId, view.workerSessionGeneration) : null;
  }

  reserveWorkerMainCard(view: WorkerMainView, rootMessageId: string, card: object): WorkerMainView | null {
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const saved = this.saveWorkerMainView(view);
      if (!saved) { if (ownsTransaction) this.database.exec("COMMIT"); return null; }
      const creating = saved.messageId === null;
      this.enqueueOutboundReply({
        id: randomUUID(),
        idempotencyKey: creating ? `worker-main:create:${saved.workerId}:${saved.workerSessionGeneration}` : `worker-main:update:${saved.workerId}:${saved.workerSessionGeneration}:${saved.viewVersion}`,
        bindingId: saved.parentBindingId, workerId: saved.workerId, workerSessionGeneration: saved.workerSessionGeneration, viewVersion: saved.viewVersion,
        rootMessageId: creating ? rootMessageId : saved.messageId!, kind: creating ? "card_reply" : "card_update", payload: JSON.stringify(card)
      });
      if (ownsTransaction) this.database.exec("COMMIT");
      return saved;
    } catch (error) { if (ownsTransaction && this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  invalidateCardContexts(targets: readonly (CardContextTarget & { reason: string })[]): CardContextInvalidation[] {
    if (targets.length === 0) return [];
    const timestamp = now();
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.database.prepare(`
        INSERT INTO card_context_invalidations(target_kind, target_id, target_generation, requested_dependency_revision, projected_dependency_revision, reason, created_at, updated_at)
        VALUES (?, ?, ?, 1, 0, ?, ?, ?)
        ON CONFLICT(target_kind, target_id, target_generation) DO UPDATE SET
          requested_dependency_revision = card_context_invalidations.requested_dependency_revision + 1, reason = excluded.reason, updated_at = excluded.updated_at
      `);
      for (const target of targets) statement.run(target.targetKind, target.targetId, target.targetGeneration, target.reason, timestamp, timestamp);
      const invalidations = targets.map((target) => this.loadCardContextInvalidation(target)!).filter(Boolean);
      if (ownsTransaction) this.database.exec("COMMIT");
      return invalidations;
    } catch (error) { if (ownsTransaction && this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  private invalidateWorkerCardContexts(view: WorkerTurnCardView, reason: string): void {
    const instance = this.getAgentInstance(view.instanceId);
    const targets: Array<CardContextTarget & { reason: string }> = [
      { targetKind: "worker-turn", targetId: view.turnId, targetGeneration: view.instanceGeneration, reason },
      { targetKind: "worker-session", targetId: view.instanceId, targetGeneration: view.workerSessionGeneration, reason }
    ];
    if (instance?.parent?.bindingGeneration) targets.push({ targetKind: "primary-session", targetId: instance.parent.bindingId, targetGeneration: instance.parent.bindingGeneration, reason });
    if (view.primaryAnswer) targets.push({ targetKind: "primary-turn", targetId: view.primaryAnswer.aggregateId, targetGeneration: view.primaryAnswer.generation, reason });
    this.invalidateCardContexts(targets);
  }

  private invalidateWorkerInstanceContexts(instance: AgentInstance, reason: string): void {
    if (instance.role !== "worker" || !instance.parent?.bindingGeneration) return;
    this.invalidateCardContexts([
      { targetKind: "worker-session", targetId: instance.id, targetGeneration: instance.workerSessionGeneration, reason },
      { targetKind: "primary-session", targetId: instance.parent.bindingId, targetGeneration: instance.parent.bindingGeneration, reason }
    ]);
  }

  listPendingCardContextInvalidations(limit = 100): CardContextInvalidation[] {
    const bounded = Math.max(1, Math.min(limit, 500));
    return (this.database.prepare(`SELECT * FROM card_context_invalidations WHERE projected_dependency_revision < requested_dependency_revision ORDER BY updated_at, target_kind, target_id, target_generation LIMIT ?`).all(bounded) as Array<Record<string, unknown>>).map(mapCardContextInvalidation);
  }

  markCardContextProjected(target: CardContextTarget, dependencyRevision: number): boolean {
    if (!Number.isInteger(dependencyRevision) || dependencyRevision < 1) return false;
    return this.database.prepare(`UPDATE card_context_invalidations SET projected_dependency_revision = MAX(projected_dependency_revision, MIN(requested_dependency_revision, ?)), updated_at = ? WHERE target_kind = ? AND target_id = ? AND target_generation = ?`).run(dependencyRevision, now(), target.targetKind, target.targetId, target.targetGeneration).changes === 1;
  }

  projectCardContext(invalidation: CardContextInvalidation, renderers: { workerMain(view: WorkerMainView): object; workerTask(view: WorkerTurnCardView): object; primaryMain(view: TopicViewState): object; primaryAnswer(view: RunCardView): object }): "reserved" | "current" | "stale" {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const currentInvalidation = this.loadCardContextInvalidation(invalidation);
      if (!currentInvalidation || currentInvalidation.projectedDependencyRevision >= invalidation.requestedDependencyRevision) { this.database.exec("COMMIT"); return "current"; }
      let reserved = false;
      if (invalidation.targetKind === "worker-session") {
        const source = this.loadWorkerMainProjectionSource(invalidation.targetId, invalidation.targetGeneration);
        if (!source) { this.markCardContextProjected(invalidation, invalidation.requestedDependencyRevision); this.database.exec("COMMIT"); return "stale"; }
        const previous = this.loadWorkerMainView(invalidation.targetId, invalidation.targetGeneration);
        const next = selectWorkerMainView(source, previous, invalidation.requestedDependencyRevision, now());
        const binding = this.getBinding(source.parentBindingId);
        if (!binding?.rootMessageId) { this.markCardContextProjected(invalidation, invalidation.requestedDependencyRevision); this.database.exec("COMMIT"); return "stale"; }
        if (next !== previous || next.viewVersion > next.deliveredVersion) { this.reserveWorkerMainCard(next, binding.rootMessageId, renderers.workerMain(next)); reserved = next.viewVersion > next.deliveredVersion; }
      } else if (invalidation.targetKind === "worker-turn") {
        const previous = this.loadWorkerTurnCard(invalidation.targetId);
        if (!previous || previous.instanceGeneration !== invalidation.targetGeneration) { this.markCardContextProjected(invalidation, invalidation.requestedDependencyRevision); this.database.exec("COMMIT"); return "stale"; }
        const main = this.loadWorkerMainView(previous.instanceId, previous.workerSessionGeneration);
        const answer = previous.primaryAnswer ? this.loadRunCard(previous.primaryAnswer.aggregateId) : null;
        const workerMain = { ...previous.workerMain, messageId: main?.messageId ?? null };
        const primaryAnswer = previous.primaryAnswer ? { ...previous.primaryAnswer, messageId: answer?.answerMessageId ?? null } : null;
        const next = updateWorkerTurnCardTargets(previous, workerMain, primaryAnswer, now());
        if (next !== previous) this.saveWorkerTurnCard(next);
        if (next.messageId && next.viewVersion > next.deliveredVersion) {
          this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-turn:update:${next.turnId}:${next.viewVersion}`, bindingId: null, workerTurnId: next.turnId, viewVersion: next.viewVersion, rootMessageId: next.messageId, kind: "card_update", payload: JSON.stringify(renderers.workerTask(next)) });
          reserved = true;
        }
      } else if (invalidation.targetKind === "primary-session") {
        const binding = this.getBinding(invalidation.targetId);
        const previous = this.loadTopicView(invalidation.targetId);
        if (!binding || binding.generation !== invalidation.targetGeneration || !previous || !binding.rootMessageId) { this.markCardContextProjected(invalidation, invalidation.requestedDependencyRevision); this.database.exec("COMMIT"); return "stale"; }
        const selected = selectPrimaryWorkerSummaries(this.loadPrimaryWorkerSummaries(binding.id, binding.generation));
        const next = updateTopicWorkerContext(previous, selected.workers, selected.overflowCount, invalidation.requestedDependencyRevision);
        this.saveTopicView(next);
        reserved = this.reserveMainCardInTransaction(next, binding.rootMessageId, renderers.primaryMain(next)) === "reserved";
      } else if (invalidation.targetKind === "primary-turn") {
        const previous = this.loadRunCard(invalidation.targetId);
        const page = previous ? this.database.prepare("SELECT state FROM answer_pages WHERE prompt_id = ? AND page_index = ?").get(previous.promptId, previous.answerPageIndex) as { state: string } | undefined : undefined;
        if (!previous || previous.bindingGeneration !== invalidation.targetGeneration || previous.workerContextFrozenAt !== null || page?.state === "frozen" || page?.state === "finished") { this.markCardContextProjected(invalidation, invalidation.requestedDependencyRevision); this.database.exec("COMMIT"); return "stale"; }
        const activity = selectPrimaryWorkerActivity(this.loadPrimaryWorkerActivity(previous.promptId, invalidation.targetGeneration));
        const next = updateRunCardWorkerContext(previous, activity, invalidation.requestedDependencyRevision, now());
        if (next !== previous) this.saveRunCard(next);
        if (next.answerMessageId && next.viewVersion > next.answerDeliveredVersion) {
          this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:update:${next.promptId}:answer:${next.viewVersion}`, bindingId: next.bindingId, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: next.answerMessageId, kind: "card_update", payload: JSON.stringify(renderers.primaryAnswer(next)) });
          reserved = true;
        }
      }
      this.markCardContextProjected(invalidation, invalidation.requestedDependencyRevision);
      this.database.exec("COMMIT");
      return reserved ? "reserved" : "current";
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  private loadCardContextInvalidation(target: CardContextTarget): CardContextInvalidation | null {
    const row = this.database.prepare("SELECT * FROM card_context_invalidations WHERE target_kind = ? AND target_id = ? AND target_generation = ?").get(target.targetKind, target.targetId, target.targetGeneration) as Record<string, unknown> | undefined;
    return row ? mapCardContextInvalidation(row) : null;
  }

  loadWorkerMainProjectionSource(workerId: string, workerSessionGeneration: number): import("../domain/worker-main-selector.js").WorkerMainProjectionSource | null {
    const instance = this.getAgentInstance(workerId);
    if (!instance || instance.role !== "worker" || instance.workerSessionGeneration !== workerSessionGeneration || !instance.parent?.bindingGeneration) return null;
    const lease = this.getWorkspaceLease(instance.workspaceLeaseId);
    if (!lease) return null;
    const cards = (this.database.prepare("SELECT * FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? ORDER BY created_at DESC, turn_id DESC").all(workerId, workerSessionGeneration) as Array<Record<string, unknown>>).map(mapWorkerTurnCard).filter((value): value is WorkerTurnCardView => value !== null);
    const active = ["blocked", "running", "preparing"]
      .flatMap((phase) => cards.filter((card) => card.phase === phase))
      .at(0) ?? cards.filter(({ phase }) => phase === "queued").at(-1) ?? null;
    const summary = (view: WorkerTurnCardView): import("../domain/worker-main-view.js").WorkerMainTaskSummary => ({
      turnId: view.turnId, title: summarizeTaskTitle(view.requestText), phase: view.phase, durationSeconds: durationSeconds(view.startedAt, view.finishedAt),
      taskCard: { aggregateKind: "worker-turn", aggregateId: view.turnId, generation: view.instanceGeneration, messageId: view.messageId }, updatedAt: view.updatedAt
    });
    const binding = this.getBinding(instance.parent.bindingId);
    return {
      workerId, workerSessionGeneration, workerName: instance.name, model: instance.model, runtimeGeneration: instance.generation, runtimeState: instance.observedState, paneId: instance.runtimeRef?.paneId ?? null,
      lifecycle: instance.workerSessionLifecycle ?? "legacy", parentBindingId: instance.parent.bindingId, parentBindingGeneration: instance.parent.bindingGeneration, parentPaneId: instance.parent.paneId, ownerName: binding?.title ?? "Primary",
      workspace: lease.cwd, branch: lease.branch, currentTask: active ? summary(active) : null, queueCount: cards.filter(({ phase }) => phase === "queued").length, nextTaskTitle: cards.filter(({ phase }) => phase === "queued").reverse().map(({ requestText }) => summarizeTaskTitle(requestText))[0] ?? null,
      recentTasks: cards.filter(({ phase }) => ["completed", "failed", "cancelled", "dispatch-uncertain"].includes(phase)).slice(0, 5).map(summary), createdAt: cards.at(-1)?.createdAt ?? now()
    };
  }

  loadPrimaryWorkerSummaries(bindingId: string, bindingGeneration: number): import("../domain/card-context-summary.js").PrimaryWorkerSummary[] {
    const binding = this.getBinding(bindingId);
    if (!binding || binding.generation !== bindingGeneration || !binding.paneId) return [];
    return this.listWorkerInstancesByParent({ bindingId, paneId: binding.paneId }).filter((worker) => worker.parent?.bindingGeneration === bindingGeneration).flatMap((worker) => {
      const source = this.loadWorkerMainProjectionSource(worker.id, worker.workerSessionGeneration ?? 1);
      const main = this.loadWorkerMainView(worker.id, worker.workerSessionGeneration ?? 1);
      if (!source) return [];
      const state = source.currentTask?.phase === "blocked" ? "blocked" as const
        : source.currentTask?.phase === "running" || source.currentTask?.phase === "preparing" ? "working" as const
          : source.currentTask?.phase === "queued" || (worker.observedState === "idle" && source.queueCount > 0) ? "queued" as const
            : worker.observedState;
      return [{ workerId: worker.id, workerSessionGeneration: worker.workerSessionGeneration ?? 1, name: worker.name, state, currentTaskTitle: source.currentTask?.title ?? null, queueCount: source.queueCount, workerMain: { aggregateKind: "worker-session" as const, aggregateId: worker.id, generation: worker.workerSessionGeneration ?? 1, messageId: main?.messageId ?? null }, createdAt: source.createdAt }];
    });
  }

  loadPrimaryWorkerActivity(promptId: string, bindingGeneration: number): import("../domain/card-context-summary.js").PrimaryWorkerActivitySummary[] {
    const run = this.loadRunCard(promptId);
    const binding = run ? this.getBinding(run.bindingId) : null;
    if (!run || run.bindingGeneration !== bindingGeneration || !binding || binding.generation !== bindingGeneration || !binding.paneId) return [];
    const rows = this.database.prepare(`
      SELECT c.* FROM worker_turn_cards c
      JOIN instance_turns t ON t.id = c.turn_id
      JOIN agent_instances worker ON worker.id = c.instance_id
      WHERE json_extract(t.actor_json, '$.kind') = 'thread-primary'
        AND json_extract(t.actor_json, '$.parentPromptId') = ?
        AND json_extract(t.actor_json, '$.bindingId') = ?
        AND json_extract(t.actor_json, '$.bindingGeneration') = ?
        AND worker.role = 'worker' AND worker.parent_binding_id = ? AND worker.parent_binding_generation = ? AND worker.parent_pane_id = ?
        AND worker.worker_session_generation = c.worker_session_generation
      ORDER BY c.updated_at DESC, c.turn_id
    `).all(promptId, run.bindingId, bindingGeneration, run.bindingId, bindingGeneration, binding.paneId) as Array<Record<string, unknown>>;
    const grouped = new Map<string, WorkerTurnCardView[]>();
    for (const row of rows) { const view = mapWorkerTurnCard(row); if (view) grouped.set(`${view.instanceId}:${view.workerSessionGeneration}`, [...(grouped.get(`${view.instanceId}:${view.workerSessionGeneration}`) ?? []), view]); }
    return [...grouped.values()].map((cards) => { const latest = cards[0]!; return { workerId: latest.instanceId, workerSessionGeneration: latest.workerSessionGeneration, name: latest.workerName, latestPhase: latest.phase, taskCount: cards.length, latestTaskTitle: summarizeTaskTitle(latest.requestText), latestTaskCard: { aggregateKind: "worker-turn", aggregateId: latest.turnId, generation: latest.instanceGeneration, messageId: latest.messageId }, updatedAt: latest.updatedAt }; });
  }

  findAgentInstanceByPane(paneId: string): AgentInstance | null {
    const row = this.database.prepare(`
      SELECT * FROM agent_instances
      WHERE pane_id = ? OR (
        pane_id IS NULL AND pending_pane_id = ? AND role = 'worker'
        AND worker_session_lifecycle = 'active' AND desired_state = 'running'
        AND provisioning_checkpoint IN ('pane-allocated', 'runtime-started')
      )
      ORDER BY CASE WHEN pane_id = ? THEN 0 ELSE 1 END, created_at, id
      LIMIT 1
    `).get(paneId, paneId, paneId) as AgentInstanceRow | undefined;
    return row ? mapAgentInstance(row) : null;
  }

  listWorkerInstancesByParent(input: { bindingId: string; paneId: string }): AgentInstance[] {
    return (this.database.prepare("SELECT * FROM agent_instances WHERE role = 'worker' AND worker_session_lifecycle = 'active' AND parent_binding_id = ? AND parent_pane_id = ? ORDER BY created_at, id").all(input.bindingId, input.paneId) as AgentInstanceRow[]).map(mapAgentInstance);
  }

  listAgentInstances(projectId: string): AgentInstance[] {
    return (this.database.prepare("SELECT * FROM agent_instances WHERE project_id = ? ORDER BY created_at, id").all(projectId) as AgentInstanceRow[]).map(mapAgentInstance);
  }

  setPrimaryAgentInstance(projectId: string, instanceId: string): AgentInstance {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const target = this.database.prepare("SELECT project_id FROM agent_instances WHERE id = ?").get(instanceId) as { project_id: string } | undefined;
      if (!target || target.project_id !== projectId) throw new Error(`Agent instance not found in project: ${instanceId}`);
      const timestamp = now();
      this.database.prepare("UPDATE agent_instances SET role = 'worker', updated_at = ? WHERE project_id = ? AND role = 'primary' AND id <> ?").run(timestamp, projectId, instanceId);
      this.database.prepare("UPDATE agent_instances SET role = 'primary', updated_at = ? WHERE id = ? AND project_id = ?").run(timestamp, instanceId, projectId);
      this.database.exec("COMMIT");
      return this.getAgentInstance(instanceId)!;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  attachAgentInstanceRuntime(input: { instanceId: string; expectedGeneration: number; herdrWorkspaceId: string; paneId: string; nativeSessionId: string | null }): AgentInstance | null {
    const nextGeneration = input.expectedGeneration + 1;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE agent_instances SET herdr_workspace_id = ?, pane_id = ?, native_session_id = ?, pending_herdr_workspace_id = NULL, pending_pane_id = NULL, generation = ?, observed_state = 'idle', provisioning_checkpoint = 'verified', last_error = NULL, updated_at = ?
        WHERE id = ? AND generation = ?
      `).run(input.herdrWorkspaceId, input.paneId, input.nativeSessionId, nextGeneration, now(), input.instanceId, input.expectedGeneration);
      const instance = result.changes === 1 ? this.getAgentInstance(input.instanceId) : null;
      if (instance) this.invalidateWorkerInstanceContexts(instance, "worker.runtime-attached");
      this.database.exec("COMMIT");
      return instance;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  checkpointAgentInstance(input: { instanceId: string; expectedGeneration: number; checkpoint: InstanceProvisioningCheckpoint; observedState?: AgentInstance["observedState"]; pendingPaneId?: string | null; pendingWorkspaceId?: string | null; lastError?: string | null }): AgentInstance | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`UPDATE agent_instances SET provisioning_checkpoint = ?, observed_state = COALESCE(?, observed_state), pending_pane_id = COALESCE(?, pending_pane_id), pending_herdr_workspace_id = COALESCE(?, pending_herdr_workspace_id), last_error = ?, updated_at = ? WHERE id = ? AND generation = ?`)
        .run(input.checkpoint, input.observedState ?? null, input.pendingPaneId ?? null, input.pendingWorkspaceId ?? null, input.lastError ?? null, now(), input.instanceId, input.expectedGeneration);
      const instance = result.changes === 1 ? this.getAgentInstance(input.instanceId) : null;
      if (instance) this.invalidateWorkerInstanceContexts(instance, "worker.provisioning-changed");
      this.database.exec("COMMIT");
      return instance;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  updateAgentInstanceLifecycle(input: { instanceId: string; expectedGeneration: number; desiredState: AgentInstance["desiredState"]; observedState: AgentInstance["observedState"]; clearRuntime?: boolean; lastError?: string | null }): AgentInstance | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`UPDATE agent_instances SET desired_state = ?, observed_state = ?, herdr_workspace_id = CASE WHEN ? THEN NULL ELSE herdr_workspace_id END, pane_id = CASE WHEN ? THEN NULL ELSE pane_id END, native_session_id = CASE WHEN ? THEN NULL ELSE native_session_id END, pending_herdr_workspace_id = CASE WHEN ? THEN NULL ELSE pending_herdr_workspace_id END, pending_pane_id = CASE WHEN ? THEN NULL ELSE pending_pane_id END, last_error = ?, updated_at = ? WHERE id = ? AND generation = ?`)
        .run(input.desiredState, input.observedState, input.clearRuntime ? 1 : 0, input.clearRuntime ? 1 : 0, input.clearRuntime ? 1 : 0, input.clearRuntime ? 1 : 0, input.clearRuntime ? 1 : 0, input.lastError ?? null, now(), input.instanceId, input.expectedGeneration);
      const instance = result.changes === 1 ? this.getAgentInstance(input.instanceId) : null;
      if (instance) this.invalidateWorkerInstanceContexts(instance, "worker.lifecycle-changed");
      this.database.exec("COMMIT");
      return instance;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  updateAgentInstanceObservation(input: { instanceId: string; expectedGeneration: number; observedState: AgentInstance["observedState"]; lastError?: string | null }): AgentInstance | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare("UPDATE agent_instances SET observed_state = ?, last_error = ?, updated_at = ? WHERE id = ? AND generation = ?").run(input.observedState, input.lastError ?? null, now(), input.instanceId, input.expectedGeneration);
      const instance = result.changes === 1 ? this.getAgentInstance(input.instanceId) : null;
      if (instance) this.invalidateWorkerInstanceContexts(instance, "worker.runtime-observed");
      this.database.exec("COMMIT");
      return instance;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  reserveAgentInstanceStop(instanceId: string, expectedGeneration: number): { outcome: "reserved"; instance: AgentInstance } | { outcome: "busy" | "stale" } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const instance = this.getAgentInstance(instanceId);
      if (!instance || instance.generation !== expectedGeneration) { this.database.exec("COMMIT"); return { outcome: "stale" }; }
      const active = this.database.prepare("SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked','dispatch-uncertain') LIMIT 1").get(instanceId, expectedGeneration);
      if (active) { this.database.exec("COMMIT"); return { outcome: "busy" }; }
      const changed = this.database.prepare("UPDATE agent_instances SET desired_state = 'stopped', last_error = NULL, updated_at = ? WHERE id = ? AND generation = ?").run(now(), instanceId, expectedGeneration);
      const reserved = changed.changes === 1 ? this.getAgentInstance(instanceId) : null;
      this.database.exec("COMMIT");
      return reserved ? { outcome: "reserved", instance: reserved } : { outcome: "stale" };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  finishAgentInstanceStop(instanceId: string, expectedGeneration: number): AgentInstance | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`UPDATE agent_instances SET observed_state = 'stopped', herdr_workspace_id = NULL, pane_id = NULL, native_session_id = NULL, pending_herdr_workspace_id = NULL, pending_pane_id = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND generation = ? AND desired_state = 'stopped'`).run(now(), instanceId, expectedGeneration);
      const instance = result.changes === 1 ? this.getAgentInstance(instanceId) : null;
      if (instance) this.invalidateWorkerInstanceContexts(instance, "worker.stopped");
      this.database.exec("COMMIT");
      return instance;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  rollbackAgentInstanceStop(instanceId: string, expectedGeneration: number, error: string): AgentInstance | null {
    const result = this.database.prepare("UPDATE agent_instances SET desired_state = 'running', last_error = ?, updated_at = ? WHERE id = ? AND generation = ? AND desired_state = 'stopped' AND (pane_id IS NOT NULL OR pending_pane_id IS NOT NULL)").run(error, now(), instanceId, expectedGeneration);
    return result.changes === 1 ? this.getAgentInstance(instanceId) : null;
  }

  detachAgentInstanceRuntime(input: { instanceId: string; expectedGeneration: number; reason: string }): AgentInstance | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const instance = this.getAgentInstance(input.instanceId);
      if (!instance || instance.generation !== input.expectedGeneration) { this.database.exec("COMMIT"); return null; }
      const nextGeneration = input.expectedGeneration + 1;
      this.database.prepare(`UPDATE instance_turns SET state = 'dispatch-uncertain', error = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked')`)
        .run(input.reason, now(), instance.id, input.expectedGeneration);
      this.database.prepare(`UPDATE instance_turns SET instance_generation = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state = 'queued'`)
        .run(nextGeneration, now(), instance.id, input.expectedGeneration);
      const changed = this.database.prepare(`UPDATE agent_instances SET generation = ?, observed_state = 'detached', herdr_workspace_id = NULL, pane_id = NULL, native_session_id = NULL, pending_herdr_workspace_id = NULL, pending_pane_id = NULL, last_error = ?, updated_at = ? WHERE id = ? AND generation = ?`)
        .run(nextGeneration, input.reason, now(), instance.id, input.expectedGeneration);
      const detached = changed.changes === 1 ? this.getAgentInstance(instance.id) : null;
      if (detached) this.invalidateWorkerInstanceContexts(detached, "worker.runtime-detached");
      this.database.exec("COMMIT");
      return detached;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  terminateWorkerSession(input: { instanceId: string; expectedGeneration: number; reason: string }): { instance: AgentInstance; cancelledTurnIds: string[]; uncertainTurnIds: string[] } | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const instance = this.getAgentInstance(input.instanceId);
      if (!instance || instance.role !== "worker" || instance.generation !== input.expectedGeneration) { this.database.exec("COMMIT"); return null; }
      const turns = this.database.prepare("SELECT id, state FROM instance_turns WHERE instance_id = ? AND instance_generation = ? ORDER BY created_at, rowid").all(instance.id, instance.generation) as Array<{ id: string; state: string }> ;
      const cancelledTurnIds = turns.filter(({ state }) => state === "queued").map(({ id }) => id);
      const uncertainTurnIds = turns.filter(({ state }) => ["claimed", "dispatching", "running", "blocked"].includes(state)).map(({ id }) => id);
      const timestamp = now();
      const nextGeneration = instance.generation + 1;
      this.database.prepare("UPDATE instance_turns SET state = 'cancelled', error = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state = 'queued'").run(input.reason, timestamp, instance.id, instance.generation);
      this.database.prepare("UPDATE instance_turns SET state = 'dispatch-uncertain', error = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked')").run(input.reason, timestamp, instance.id, instance.generation);
      const changed = this.database.prepare("UPDATE agent_instances SET desired_state = 'stopped', observed_state = 'stopped', worker_session_lifecycle = 'terminated', generation = ?, herdr_workspace_id = NULL, pane_id = NULL, native_session_id = NULL, pending_herdr_workspace_id = NULL, pending_pane_id = NULL, last_error = ?, updated_at = ? WHERE id = ? AND generation = ?").run(nextGeneration, input.reason, timestamp, instance.id, instance.generation);
      const terminated = changed.changes === 1 ? this.getAgentInstance(instance.id) : null;
      if (terminated) this.invalidateWorkerInstanceContexts(terminated, "worker.terminated");
      this.database.exec("COMMIT");
      return terminated ? { instance: terminated, cancelledTurnIds, uncertainTurnIds } : null;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  getWorkspaceLease(id: string): WorkspaceLease | null {
    const row = this.database.prepare("SELECT * FROM workspace_leases WHERE id = ?").get(id) as WorkspaceLeaseRow | undefined;
    return row ? mapWorkspaceLease(row) : null;
  }

  updateWorkspaceLease(input: { id: string; expectedGeneration: number; state: WorkspaceLeaseState; cwd?: string; branch?: string | null; baseCommit?: string }): WorkspaceLease | null {
    const current = this.getWorkspaceLease(input.id);
    if (!current || current.generation !== input.expectedGeneration) return null;
    const result = this.database.prepare(`UPDATE workspace_leases SET state = ?, cwd = ?, branch = ?, base_commit = ?, updated_at = ? WHERE id = ? AND generation = ?`)
      .run(input.state, input.cwd ?? current.cwd, input.branch === undefined ? current.branch : input.branch, input.baseCommit ?? current.baseCommit, now(), input.id, input.expectedGeneration);
    return result.changes === 1 ? this.getWorkspaceLease(input.id) : null;
  }

  createInstanceRemovalPlan(plan: InstanceRemovalPlan): InstanceRemovalPlan {
    this.database.prepare(`INSERT INTO instance_removal_plans(id, instance_id, instance_generation, workspace_generation, worktree_fingerprint, safe, reason, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(plan.id, plan.instanceId, plan.instanceGeneration, plan.workspaceGeneration, plan.worktreeFingerprint, plan.safe ? 1 : 0, plan.reason, plan.state, plan.createdAt);
    return this.getInstanceRemovalPlan(plan.id)!;
  }

  getInstanceRemovalPlan(id: string): InstanceRemovalPlan | null {
    const row = this.database.prepare("SELECT * FROM instance_removal_plans WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), instanceId: String(row.instance_id), instanceGeneration: Number(row.instance_generation), workspaceGeneration: Number(row.workspace_generation), worktreeFingerprint: row.worktree_fingerprint === null ? null : String(row.worktree_fingerprint), safe: Number(row.safe) === 1, reason: String(row.reason) as InstanceRemovalPlan["reason"], state: String(row.state) as InstanceRemovalPlan["state"], createdAt: String(row.created_at) } : null;
  }

  consumeInstanceRemovalPlan(input: { id: string; instanceId: string; instanceGeneration: number; workspaceGeneration: number; worktreeFingerprint: string | null }): InstanceRemovalPlan | null {
    const result = this.database.prepare(`UPDATE instance_removal_plans SET state = 'consumed' WHERE id = ? AND state = 'pending' AND safe = 1 AND instance_id = ? AND instance_generation = ? AND workspace_generation = ? AND worktree_fingerprint IS ?`)
      .run(input.id, input.instanceId, input.instanceGeneration, input.workspaceGeneration, input.worktreeFingerprint);
    return result.changes === 1 ? this.getInstanceRemovalPlan(input.id) : null;
  }

  removeAgentInstance(input: { instanceId: string; expectedGeneration: number; expectedWorkspaceGeneration: number }): boolean {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const instance = this.getAgentInstance(input.instanceId);
      if (!instance || instance.generation !== input.expectedGeneration || instance.desiredState !== "stopped" || instance.runtimeRef || instance.pendingRuntimeRef) { this.database.exec("COMMIT"); return false; }
      const lease = this.getWorkspaceLease(instance.workspaceLeaseId);
      if (!lease || lease.generation !== input.expectedWorkspaceGeneration) { this.database.exec("COMMIT"); return false; }
      this.database.prepare("DELETE FROM workspace_leases WHERE id = ? AND generation = ?").run(lease.id, lease.generation);
      const removed = this.database.prepare("DELETE FROM agent_instances WHERE id = ? AND generation = ?").run(instance.id, instance.generation).changes === 1;
      this.database.exec("COMMIT"); return removed;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  acceptInstanceTurn(input: { id: string; idempotencyKey: string; actor: ControlActor; projectId: string; instanceId: string; instanceGeneration: number; kind: InstanceTurn["kind"]; priority?: InstanceTurn["priority"]; text: string; maxQueueDepth?: number }): { turn: InstanceTurn; inserted: boolean } { return this.workerTurns.acceptInstanceTurn(input); }
  acceptInstanceTurnWithCard(input: AcceptInstanceTurnWithCardInput & { maxQueueDepth?: number }): { turn: InstanceTurn; view: WorkerTurnCardView; inserted: boolean } { return this.workerTurns.acceptInstanceTurnWithCard(input); }
  getInstanceTurn(id: string): InstanceTurn | null { return this.workerTurns.getInstanceTurn(id); }
  claimInstanceTurnTranscript(input: { turnId: string; expectedGeneration: number; runtimeTurnId: string; startedAt: string }): InstanceTurn | null { return this.workerTurns.claimInstanceTurnTranscript(input); }
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null { return this.workerTurns.loadWorkerTurnCard(turnId); }
  findWorkerTurnByCardMessage(messageId: string): { turn: InstanceTurn; view: WorkerTurnCardView } | null { return this.workerTurns.findWorkerTurnByCardMessage(messageId); }
  listWorkerTurnCardPages(turnId: string): WorkerTurnCardPage[] { return this.workerTurns.listWorkerTurnCardPages(turnId); }
  getWorkerTurnCardDeliveryFacts(turnId: string, pageIndex: number): AnswerPageDeliveryFacts { return this.workerTurns.getWorkerTurnCardDeliveryFacts(turnId, pageIndex); }
  reserveWorkerTurnContent(input: { turnId: string; pageIndex: number; cardId: string; elementId: string; content: string; sourceEnd: number }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnContent(input); }
  reserveWorkerTurnProgress(input: { turnId: string; pageIndex: number; cardId: string; elementId: string; content: string }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnProgress(input); }
  reserveWorkerTurnFinish(input: { turnId: string; pageIndex: number; cardId: string; summary: string }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnFinish(input); }
  reserveWorkerTurnCardHydration(input: { turnId: string; pageIndex: number; cardId: string; messageId: string; card: object }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnCardHydration(input); }
  reserveWorkerTurnContinuation(input: { turnId: string; pageIndex: number; cardId: string; summary: string; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnContinuation(input); }
  applyInstanceTurnProjection(input: { turnId: string; expectedGeneration: number; expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string; change: WorkerTurnCardChange; render(view: WorkerTurnCardView): object }): WorkerTurnCardView | null { return this.workerTurns.applyInstanceTurnProjection(input); }
  transitionInstanceTurnWithProjection(input: { turnId: string; expectedGeneration: number; expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string; state: InstanceTurnState; result?: string | null; error?: string | null; eventKind: InstanceEventKind; change: WorkerTurnCardChange; render(view: WorkerTurnCardView): object }): { turn: InstanceTurn; view: WorkerTurnCardView } | null { return this.workerTurns.transitionInstanceTurnWithProjection(input); }
  listInstanceTurns(instanceId: string, options: { limit?: number; after?: { createdAt: string; id: string } } = {}): { items: InstanceTurn[]; nextCursor: { createdAt: string; id: string } | null } { return this.workerTurns.listInstanceTurns(instanceId, options); }
  listRecentInstanceTurnSummaries(instanceId: string, requestedLimit = 5): InstanceTurnSummary[] { return this.workerTurns.listRecentInstanceTurnSummaries(instanceId, requestedLimit); }
  getActiveInstanceTurn(instanceId: string, expectedGeneration: number): InstanceTurn | null { return this.workerTurns.getActiveInstanceTurn(instanceId, expectedGeneration); }
  private saveWorkerTurnCard(view: WorkerTurnCardView): void { this.workerTurns.saveWorkerTurnCard(view); }
  setBindingPrimaryToolCapability(input: { bindingId: string; expectedGeneration: number; capabilityHash: string }): boolean {
    const binding = this.getBinding(input.bindingId);
    if (!binding || (binding.generation !== input.expectedGeneration && binding.generation + 1 !== input.expectedGeneration)) return false;
    this.database.prepare("INSERT INTO primary_tool_capabilities(binding_id, binding_generation, capability_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(binding_id, binding_generation) DO UPDATE SET capability_hash = excluded.capability_hash, created_at = excluded.created_at").run(input.bindingId, input.expectedGeneration, input.capabilityHash, now());
    return true;
  }
  verifyBindingPrimaryToolCapability(input: { bindingId: string; expectedGeneration: number; capabilityHash: string }): boolean {
    const row = this.database.prepare("SELECT 1 FROM primary_tool_capabilities c JOIN bindings b ON b.id = c.binding_id WHERE c.binding_id = ? AND c.binding_generation = ? AND c.capability_hash = ? AND b.generation = c.binding_generation AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached'").get(input.bindingId, input.expectedGeneration, input.capabilityHash);
    return Boolean(row);
  }
  hasBindingPrimaryToolCapability(bindingId: string, expectedGeneration: number): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM primary_tool_capabilities WHERE binding_id = ? AND binding_generation = ?").get(bindingId, expectedGeneration));
  }
  revokeBindingPrimaryToolCapability(bindingId: string, expectedGeneration: number): boolean {
    return Number(this.database.prepare("DELETE FROM primary_tool_capabilities WHERE binding_id = ? AND binding_generation = ?").run(bindingId, expectedGeneration).changes) > 0;
  }
  getActiveOrdinaryPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    return this.prompts.getActiveOrdinaryPrompt(bindingId, expectedGeneration);
  }

  getActiveExternalPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    return this.prompts.getActiveExternalPrompt(bindingId, expectedGeneration);
  }

  claimNextInstanceTurn(instanceId: string, expectedGeneration: number): InstanceTurn | null { return this.workerTurns.claimNextInstanceTurn(instanceId, expectedGeneration); }
  recoverInterruptedInstanceTurns(): { requeuedTurnIds: string[]; observableTurns: InstanceTurn[] } { return this.workerTurns.recoverInterruptedInstanceTurns(); }
  listObservableInstanceTurns(): InstanceTurn[] { return this.workerTurns.listObservableInstanceTurns(); }
  listObservableInstanceTurnsByPaneIds(paneIds: readonly string[]): InstanceTurn[] { return this.workerTurns.listObservableInstanceTurnsByPaneIds(paneIds); }
  getInstanceTurnDiagnostics(): { queuedTurns: number; activeTurns: number; uncertainTurns: number } { return this.workerTurns.getInstanceTurnDiagnostics(); }
  updateInstanceTurn(input: { turnId: string; expectedGeneration: number; expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string; state: InstanceTurnState; result?: string | null; error?: string | null; eventKind: InstanceEventKind }): InstanceTurn | null { return this.workerTurns.updateInstanceTurn(input); }
  completeInstanceTurn(input: { turnId: string; expectedGeneration: number; result: string }): InstanceTurn | null { return this.workerTurns.completeInstanceTurn(input); }
  listInstanceEvents(instanceId: string, afterId = 0): InstanceEvent[] { return this.workerTurns.listInstanceEvents(instanceId, afterId); }
  countPendingInstanceTurns(instanceId: string, expectedGeneration?: number): number { return this.workerTurns.countPendingInstanceTurns(instanceId, expectedGeneration); }
  acceptInstanceOperation(input: { id: string; idempotencyKey: string; actor: ControlActor; projectId: string; instanceId: string; instanceGeneration: number; kind: InstanceOperation["kind"]; payload: string | null }): { operation: InstanceOperation; inserted: boolean } {
    const timestamp = now();
    const instance = this.getAgentInstance(input.instanceId);
    if (!instance || instance.projectId !== input.projectId || instance.generation !== input.instanceGeneration) throw new Error("Instance generation changed before operation acceptance");
    const inserted = this.database.prepare(`INSERT INTO instance_operations(id, idempotency_key, project_id, instance_id, instance_generation, actor_json, kind, payload, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(input.id, input.idempotencyKey, input.projectId, input.instanceId, input.instanceGeneration, JSON.stringify(input.actor), input.kind, input.payload, timestamp, timestamp).changes === 1;
    const row = this.database.prepare("SELECT * FROM instance_operations WHERE idempotency_key = ?").get(input.idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Accepted instance operation could not be loaded");
    const operation = this.mapInstanceOperation(row);
    if (operation.instanceId !== input.instanceId || operation.kind !== input.kind || operation.payload !== input.payload) throw new Error("Idempotency key belongs to a different instance operation");
    return { operation, inserted };
  }
  claimInstanceOperation(id: string, expectedGeneration: number): InstanceOperation | null {
    const changed = this.database.prepare(`UPDATE instance_operations SET state = 'running', result = 'running', updated_at = ? WHERE id = ? AND instance_generation = ? AND state = 'accepted' AND EXISTS (SELECT 1 FROM agent_instances i WHERE i.id = instance_operations.instance_id AND i.generation = ?)`)
      .run(now(), id, expectedGeneration, expectedGeneration);
    if (changed.changes !== 1) return null;
    return this.mapInstanceOperation(this.database.prepare("SELECT * FROM instance_operations WHERE id = ?").get(id) as Record<string, unknown>);
  }
  updateInstanceOperation(input: { id: string; expectedGeneration: number; state: InstanceOperation["state"]; result: string }): InstanceOperation | null {
    const changed = this.database.prepare("UPDATE instance_operations SET state = ?, result = ?, updated_at = ? WHERE id = ? AND instance_generation = ?").run(input.state, input.result, now(), input.id, input.expectedGeneration);
    if (changed.changes !== 1) return null;
    return this.mapInstanceOperation(this.database.prepare("SELECT * FROM instance_operations WHERE id = ?").get(input.id) as Record<string, unknown>);
  }
  acceptTurnControlOperation(input: AcceptTurnControlOperationInput): { operation: TurnControlOperation; inserted: boolean } {
    if ((input.kind === "steer") !== (input.payload !== null)) throw new Error("Steer requires a payload and interrupt forbids one");
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.turnTargetExists(input.target)) throw new Error("Turn control target changed before acceptance");
      const inserted = this.database.prepare(`INSERT INTO turn_control_operations(
        id, idempotency_key, kind, owner_kind, owner_id, project_id, pane_id, generation,
        agent_session_source, agent_session_agent, agent_session_kind, agent_session_value, logical_turn_id, runtime_turn_id,
        actor_json, payload, source_message_id, source_card_id, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`).run(
        input.id, input.idempotencyKey, input.kind, input.target.owner.kind, input.target.owner.id, input.target.projectId, input.target.paneId, input.target.generation,
        input.target.agentSession.source, input.target.agentSession.agent, input.target.agentSession.kind, input.target.agentSession.value, input.target.logicalTurnId, input.target.runtimeTurnId,
        JSON.stringify(input.actor), input.payload, input.sourceMessageId ?? null, input.sourceCardId ?? null, timestamp, timestamp
      ).changes === 1;
      const row = this.database.prepare("SELECT * FROM turn_control_operations WHERE idempotency_key = ?").get(input.idempotencyKey) as TurnControlOperationRow | undefined;
      if (!row) throw new Error("Accepted turn control operation could not be loaded");
      const operation = mapTurnControlOperation(row);
      if (!sameTurnControlRequest(operation, input)) throw new Error("Idempotency key belongs to a different turn control operation");
      if (inserted && input.result) this.enqueueTurnControlResult(operation, input.result.card, input.result.targetMessageId, input.result.bindingId ?? null);
      this.database.exec("COMMIT");
      return { operation, inserted };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  getTurnControlOperation(id: string): TurnControlOperation | null {
    const row = this.database.prepare("SELECT * FROM turn_control_operations WHERE id = ?").get(id) as TurnControlOperationRow | undefined;
    return row ? mapTurnControlOperation(row) : null;
  }
  getTurnControlOperationByIdempotencyKey(idempotencyKey: string): TurnControlOperation | null {
    const row = this.database.prepare("SELECT * FROM turn_control_operations WHERE idempotency_key = ?").get(idempotencyKey) as TurnControlOperationRow | undefined;
    return row ? mapTurnControlOperation(row) : null;
  }
  getPrioritySteer(owner: import("../domain/turn-control.js").TurnControlOwner, idempotencyKey: string): { logicalTurnId: string; text: string } | null {
    if (owner.kind === "binding") {
      const row = this.database.prepare("SELECT id, body FROM prompt_jobs WHERE binding_id = ? AND lark_message_id = ? AND priority = 'priority'").get(owner.id, `priority-steer:${idempotencyKey}`) as { id: string; body: string } | undefined;
      return row ? { logicalTurnId: row.id, text: row.body } : null;
    }
    const row = this.database.prepare("SELECT id, text FROM instance_turns WHERE instance_id = ? AND idempotency_key = ? AND priority = 'priority'").get(owner.id, idempotencyKey) as { id: string; text: string } | undefined;
    return row ? { logicalTurnId: row.id, text: row.text } : null;
  }
  claimTurnControlOperation(id: string): TurnControlOperation | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const operation = this.getTurnControlOperation(id);
      if (!operation || operation.state !== "accepted" || !this.turnTargetExists(operation.target)) { this.database.exec("COMMIT"); return null; }
      const changed = this.database.prepare("UPDATE turn_control_operations SET state = 'dispatching', updated_at = ? WHERE id = ? AND state = 'accepted'").run(now(), id);
      this.database.exec("COMMIT");
      return changed.changes === 1 ? this.getTurnControlOperation(id) : null;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  rejectAcceptedTurnControlOperation(input: { id: string; result: Record<string, unknown>; card?: object }): TurnControlOperation | null {
    return this.finishTurnControlTransition(input.id, "accepted", "rejected", input.result, input.card);
  }
  finishTurnControlOperation(input: { id: string; state: Extract<TurnControlState, "delivered" | "rejected" | "uncertain">; result: Record<string, unknown>; card?: object }): TurnControlOperation | null {
    return this.finishTurnControlTransition(input.id, "dispatching", input.state, input.result, input.card);
  }
  convertTurnControlToPrimaryPriority(input: { operationId: string; prompt: Parameters<BindingStorePort["acceptPrompt"]>[0]["prompt"]; view: RunCardView; rootMessageId: string; answerCard: object; maxQueueDepth: number; expectedBindingGeneration: number; result: Record<string, unknown>; card?: object }): { operation: TurnControlOperation; prompt: PromptJob } | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const operation = this.getTurnControlOperation(input.operationId);
      if (!operation || operation.state !== "dispatching" || operation.kind !== "steer" || operation.target.owner.kind !== "binding" || operation.target.owner.id !== input.prompt.bindingId) { this.database.exec("COMMIT"); return null; }
      const binding = this.getBinding(input.prompt.bindingId);
      if (!binding || binding.generation !== input.expectedBindingGeneration || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached" || binding.paneId !== operation.target.paneId || !bindingSessionMatches(binding, operation.target.agentSession)) { this.database.exec("COMMIT"); return null; }
      if (this.countPendingPrompts(input.prompt.bindingId) >= input.maxQueueDepth) throw new Error("This topic's prompt queue is full");
      if (this.database.prepare("SELECT 1 FROM prompt_jobs WHERE binding_id = ? AND priority = 'priority' AND state IN ('queued','running') LIMIT 1").get(input.prompt.bindingId)) throw new Error("Primary binding already has a live priority turn");
      const timestamp = now();
      this.database.prepare("INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, priority, parent_prompt_id, steering_origin, source_prompt_id, was_detached, state, observation_state, attempt_count, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'turn', 'priority', NULL, NULL, NULL, 0, 'queued', 'not_started', 0, NULL, ?, ?)")
        .run(input.prompt.id, input.prompt.bindingId, input.prompt.larkMessageId, input.prompt.actorOpenId, input.prompt.body, timestamp, timestamp);
      this.insertRunCard(input.view);
      this.database.prepare("INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, card_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'answer', ?, 'stream_card_create', ?, ?, 'pending', 0, ?, ?, ?)")
        .run(randomUUID(), `run-card:create:${input.prompt.id}:answer`, input.prompt.bindingId, input.prompt.id, input.view.viewVersion, input.rootMessageId, JSON.stringify(input.answerCard), `answer:${input.prompt.id}`, timestamp, timestamp, timestamp);
      this.database.prepare("UPDATE turn_control_operations SET state = 'delivered', result_json = ?, updated_at = ? WHERE id = ? AND state = 'dispatching'").run(JSON.stringify(input.result), timestamp, input.operationId);
      const converted = this.getTurnControlOperation(input.operationId)!;
      if (input.card) this.updateTurnControlResult(converted, input.card);
      this.database.exec("COMMIT");
      return { operation: converted, prompt: this.requirePrompt(input.prompt.id) };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  convertTurnControlToWorkerPriority(input: { operationId: string; turn: Omit<AcceptInstanceTurnWithCardInput, "view" | "card"> & { view?: AcceptInstanceTurnWithCardInput["view"]; card?: object }; maxQueueDepth: number; result: Record<string, unknown>; card?: object }): { operation: TurnControlOperation; logicalTurnId: string } | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const operation = this.getTurnControlOperation(input.operationId);
      if (!operation || operation.state !== "dispatching" || operation.kind !== "steer" || operation.target.owner.kind !== "instance" || operation.target.owner.id !== input.turn.instanceId) { this.database.exec("COMMIT"); return null; }
      const instance = this.getAgentInstance(input.turn.instanceId);
      if (!instance || instance.generation !== input.turn.instanceGeneration || instance.projectId !== input.turn.projectId || instance.runtimeRef?.paneId !== operation.target.paneId || instance.runtimeRef.nativeSessionId !== operation.target.agentSession.value) { this.database.exec("COMMIT"); return null; }
      if (this.countPendingInstanceTurns(input.turn.instanceId, input.turn.instanceGeneration) >= input.maxQueueDepth) throw new Error("Target instance queue is full");
      if (this.database.prepare("SELECT 1 FROM instance_turns WHERE instance_id = ? AND instance_generation = ? AND priority = 'priority' AND state IN ('queued','claimed','dispatching','running','blocked','dispatch-uncertain') LIMIT 1").get(input.turn.instanceId, input.turn.instanceGeneration)) throw new Error("Target instance already has a live priority turn");
      const timestamp = now();
      this.database.prepare("INSERT INTO instance_turns(id, idempotency_key, project_id, instance_id, instance_generation, actor_json, kind, priority, text, state, parent_turn_id, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'priority', ?, 'queued', ?, ?, ?, ?)")
        .run(input.turn.id, input.turn.idempotencyKey, input.turn.projectId, input.turn.instanceId, input.turn.instanceGeneration, JSON.stringify(input.turn.actor), input.turn.kind, input.turn.text, input.turn.parentTurnId, input.turn.sourceMessageId, timestamp, timestamp);
      this.insertInstanceEvent(input.turn.projectId, input.turn.instanceId, input.turn.id, "turn.accepted", { kind: input.turn.kind });
      if ((input.turn.view === undefined) !== (input.turn.card === undefined)) throw new Error("Worker priority card view and payload must be provided together");
      if (input.turn.view && input.turn.card) {
        this.saveWorkerTurnCard(input.turn.view);
        this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `worker-turn:create:${input.turn.id}:0`, bindingId: null, workerTurnId: input.turn.id, viewVersion: input.turn.view.viewVersion, rootMessageId: input.turn.view.rootMessageId, kind: "stream_card_create", payload: JSON.stringify({ card: input.turn.card, stream: { pageIndex: 0, pageStart: 0, elementId: input.turn.view.elementId } }) });
        this.invalidateWorkerCardContexts(input.turn.view, "turn.accepted");
      }
      this.database.prepare("UPDATE turn_control_operations SET state = 'delivered', result_json = ?, updated_at = ? WHERE id = ? AND state = 'dispatching'").run(JSON.stringify(input.result), timestamp, input.operationId);
      const converted = this.getTurnControlOperation(input.operationId)!;
      if (input.card) this.updateTurnControlResult(converted, input.card);
      this.database.exec("COMMIT");
      return { operation: converted, logicalTurnId: input.turn.id };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  recoverTurnControlOperations(renderResult?: (operation: TurnControlOperation) => object): { accepted: TurnControlOperation[]; uncertain: TurnControlOperation[] } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE turn_control_operations SET state = 'uncertain', result_json = ?, updated_at = ? WHERE state = 'dispatching'")
        .run(JSON.stringify({ status: "delivery-uncertain", reason: "Bridge restarted after native control dispatch began" }), now());
      const accepted = (this.database.prepare("SELECT * FROM turn_control_operations WHERE state = 'accepted' ORDER BY created_at, rowid").all() as TurnControlOperationRow[]).map(mapTurnControlOperation);
      const uncertain = (this.database.prepare("SELECT * FROM turn_control_operations WHERE state = 'uncertain' ORDER BY created_at, rowid").all() as TurnControlOperationRow[]).map(mapTurnControlOperation);
      if (renderResult) for (const operation of uncertain) this.updateTurnControlResult(operation, renderResult(operation));
      this.database.exec("COMMIT");
      return { accepted, uncertain };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  private finishTurnControlTransition(id: string, source: TurnControlState, state: Extract<TurnControlState, "delivered" | "rejected" | "uncertain">, result: Record<string, unknown>, card?: object): TurnControlOperation | null {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.database.prepare("UPDATE turn_control_operations SET state = ?, result_json = ?, updated_at = ? WHERE id = ? AND state = ?")
        .run(state, JSON.stringify(result), now(), id, source);
      if (changed.changes !== 1) { this.database.exec("COMMIT"); return null; }
      const operation = this.getTurnControlOperation(id)!;
      if (card) this.updateTurnControlResult(operation, card);
      this.database.exec("COMMIT");
      return operation;
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }
  private enqueueTurnControlResult(operation: TurnControlOperation, card: object, targetMessageId: string, bindingId: string | null): void {
    this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `turn-control:${operation.id}:result`, bindingId, targetRole: "operation_result", rootMessageId: targetMessageId, kind: "card_reply", payload: JSON.stringify(card) });
  }
  private updateTurnControlResult(operation: TurnControlOperation, card: object): void {
    const initial = this.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key = ?").get(`turn-control:${operation.id}:result`) as OutboundReplyRow | undefined;
    if (!initial) return;
    if (initial.state === "pending") { this.enqueueTurnControlResult(operation, card, initial.root_message_id, initial.binding_id); return; }
    if (initial.state === "delivered" && initial.delivered_message_id) {
      this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `turn-control:${operation.id}:result:${operation.state}`, bindingId: initial.binding_id, targetRole: "operation_result", rootMessageId: initial.delivered_message_id, kind: "card_update", payload: JSON.stringify(card) });
    }
  }
  private turnTargetExists(target: TurnTarget): boolean {
    if (target.owner.kind === "binding") {
      return Boolean(this.database.prepare(`SELECT 1 FROM bindings b JOIN prompt_jobs p ON p.id = ? AND p.binding_id = b.id
        WHERE b.id = ? AND b.project_id = ? AND b.pane_id = ? AND b.generation = ?
          AND b.agent_session_source = ? AND b.agent_session_agent = ? AND b.agent_session_kind = ? AND b.agent_session_value = ?
          AND p.transcript_turn_id = ? AND p.state = 'running'`).get(
        target.logicalTurnId, target.owner.id, target.projectId, target.paneId, target.generation, target.agentSession.source, target.agentSession.agent, target.agentSession.kind, target.agentSession.value, target.runtimeTurnId
      ));
    }
    return Boolean(this.database.prepare(`SELECT 1 FROM agent_instances i JOIN instance_turns t ON t.id = ? AND t.instance_id = i.id AND t.instance_generation = i.generation
      WHERE i.id = ? AND i.project_id = ? AND i.pane_id = ? AND i.generation = ? AND i.native_session_id = ?
        AND t.runtime_turn_id = ? AND t.state IN ('dispatching','running','blocked','dispatch-uncertain')`).get(
      target.logicalTurnId, target.owner.id, target.projectId, target.paneId, target.generation, target.agentSession.value, target.runtimeTurnId
    ));
  }
  private mapInstanceOperation(row: Record<string, unknown>): InstanceOperation { return { id: String(row.id), idempotencyKey: String(row.idempotency_key), projectId: String(row.project_id), instanceId: String(row.instance_id), instanceGeneration: Number(row.instance_generation), actor: JSON.parse(String(row.actor_json)) as ControlActor, kind: String(row.kind) as InstanceOperation["kind"], payload: row.payload === null ? null : String(row.payload), state: String(row.state) as InstanceOperation["state"], result: row.result === null ? null : String(row.result), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
  getConversationTarget(chatId: string): { projectId: string; target: import("../domain/agent-instance.js").InstanceTarget } | null {
    const row = this.database.prepare("SELECT project_id, target_kind, instance_id, instance_generation FROM conversation_targets WHERE chat_id = ?").get(chatId) as { project_id: string; target_kind: string; instance_id: string | null; instance_generation: number | null } | undefined;
    if (!row) return null;
    return { projectId: row.project_id, target: row.target_kind === "primary" ? { kind: "primary" } : { kind: "instance", instanceId: row.instance_id!, ...(row.instance_generation === null ? {} : { expectedGeneration: Number(row.instance_generation) }) } };
  }
  setConversationTarget(input: { chatId: string; projectId: string; target: import("../domain/agent-instance.js").InstanceTarget }): void {
    this.database.prepare(`INSERT INTO conversation_targets(chat_id, project_id, target_kind, instance_id, instance_generation, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET project_id = excluded.project_id, target_kind = excluded.target_kind, instance_id = excluded.instance_id, instance_generation = excluded.instance_generation, updated_at = excluded.updated_at`)
      .run(input.chatId, input.projectId, input.target.kind, input.target.kind === "instance" ? input.target.instanceId : null, input.target.kind === "instance" ? input.target.expectedGeneration ?? null : null, now());
  }
  private insertInstanceEvent(projectId: string, instanceId: string, turnId: string | null, kind: InstanceEventKind, payload: Record<string, unknown>): void { this.database.prepare("INSERT INTO instance_events(project_id, instance_id, turn_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(projectId, instanceId, turnId, kind, JSON.stringify(payload), now()); }
  private mapInstanceTurn(row: Record<string, unknown> | undefined): InstanceTurn | null { return row ? { id: String(row.id), idempotencyKey: String(row.idempotency_key), projectId: String(row.project_id), instanceId: String(row.instance_id), instanceGeneration: Number(row.instance_generation), actor: JSON.parse(String(row.actor_json)) as ControlActor, kind: String(row.kind) as InstanceTurn["kind"], priority: String(row.priority ?? "normal") as InstanceTurn["priority"], text: String(row.text), state: String(row.state) as InstanceTurnState, result: row.result === null ? null : String(row.result), error: row.error === null ? null : String(row.error), parentTurnId: row.parent_turn_id === null || row.parent_turn_id === undefined ? null : String(row.parent_turn_id), sourceMessageId: row.source_message_id === null || row.source_message_id === undefined ? null : String(row.source_message_id), runtimeTurnId: row.runtime_turn_id === null || row.runtime_turn_id === undefined ? null : String(row.runtime_turn_id), runtimeTurnStartedAt: row.runtime_turn_started_at === null || row.runtime_turn_started_at === undefined ? null : String(row.runtime_turn_started_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at) } : null; }

  projectLegacyBindingAsAgentInstance(bindingId: string): AgentInstance | null {
    const binding = this.getBinding(bindingId);
    if (!binding?.projectId) return null;
    return {
      id: `legacy:${binding.id}`, projectId: binding.projectId, name: binding.title, role: "worker", agentKind: "traex", model: null, sourcePrimaryPaneLabel: null,
      parent: null, workerSessionLifecycle: "legacy", workerSessionGeneration: 1,
      desiredState: binding.state === "archived" ? "stopped" : "running",
      observedState: binding.state === "failed" ? "failed" : binding.state === "archived" ? "stopped" : binding.lastAgentState === "done" ? "idle" : binding.lastAgentState === "unknown" ? "detached" : binding.lastAgentState,
      workspaceLeaseId: `legacy:${binding.id}:workspace`, generation: binding.generation,
      runtimeRef: binding.paneId ? { herdrWorkspaceId: binding.workspaceId, paneId: binding.paneId, nativeSessionId: binding.traexSessionId, generation: binding.generation } : null,
      pendingRuntimeRef: null, provisioningCheckpoint: "verified", lastError: null
    };
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

  createPendingBinding(input: { id: string; projectId?: string | null; workspaceId: string; chatId: string; topicId: string | null; rootMessageId: string | null; title: string; creatorOpenId?: string | null }): Binding {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO bindings(
        id, creator_open_id, project_id, workspace_id, chat_id, topic_id, root_message_id, title, runtime, state, last_agent_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'traex', 'pending', 'unknown', ?, ?)
    `).run(input.id, input.creatorOpenId ?? null, input.projectId ?? null, input.workspaceId, input.chatId, input.topicId, input.rootMessageId, input.title, timestamp, timestamp);
    return this.requireBinding(input.id);
  }

  createCardInteraction(input: { id: string; bindingId: string; bindingGeneration: number; actorOpenId: string; actionKind: CardInteractionActionKind; parentPromptId: string | null; targetPromptId: string | null; expiresAt: string }): CardInteraction {
    return this.sessionOperations.createInteraction(input);
  }

  getCardInteraction(id: string): CardInteraction | null {
    return this.sessionOperations.getInteraction(id);
  }

  consumeCardInteraction(input: { id: string; actorOpenId: string; bindingId: string; bindingGeneration: number; now: string; resultCode: string }): { outcome: "consumed" | "duplicate" | "missing" | "unauthorized" | "expired" | "stale"; interaction: CardInteraction | null } { return this.sessionOperations.consumeInteraction(input); }

  acceptSessionOperation(input: { id: string; idempotencyKey: string; interactionId: string; actorOpenId: string; bindingId: string; bindingGeneration: number; expectedPaneId: string | null; expectedTerminalId: string | null; kind: SessionOperationKind; argument: string | null; now: string }): { outcome: "accepted" | "duplicate" | "missing" | "unauthorized" | "expired" | "stale"; operation: SessionOperation | null } { return this.sessionOperations.accept(input); }

  getSessionOperation(id: string): SessionOperation | null { return this.sessionOperations.get(id); }

  claimNextSessionOperation(bindingId?: string): SessionOperation | null { return this.sessionOperations.claimNext(bindingId); }

  finishSessionOperation(id: string, state: Extract<SessionOperationState, "succeeded" | "rejected" | "failed" | "uncertain">, detail: string | null = null): SessionOperation | null { return this.sessionOperations.finish(id, state, detail); }

  listRecoverableSessionOperations(): SessionOperation[] { return this.sessionOperations.listRecoverable(); }

  acceptCommandIntent(input: AcceptCommandIntentInput): AcceptCommandIntentResult {
    return this.commandIntents.accept(input);
  }

  getCommandIntent(id: string): CommandIntent | null {
    return this.commandIntents.get(id);
  }

  claimNextCommandIntent(laneKey?: string): CommandIntent | null {
    return this.commandIntents.claimNext(laneKey);
  }

  finishCommandIntent(id: string, state: CommandIntentTerminalState, outcome: CommandIntent["outcome"]): CommandIntent | null {
    return this.commandIntents.finish(id, state, outcome);
  }

  listRecoverableCommandIntents(): CommandIntent[] {
    return this.commandIntents.listRecoverable();
  }

  recoverExecutingCommandIntents(recoveredAt: string): number {
    return this.commandIntents.recoverExecuting(recoveredAt);
  }

  pruneTerminalSessionOperations(cutoff: string, limit: number): number { return this.sessionOperations.pruneTerminal(cutoff, limit); }

  convertFailedSteeringToTurn(input: { interactionId: string; actorOpenId: string; bindingId: string; bindingGeneration: number; sourcePromptId: string; newPromptId: string; newLarkMessageId: string; now: string; view: RunCardView; rootMessageId: string; answerCardFor(view: RunCardView): object }): { outcome: "converted" | "duplicate" | "missing" | "unauthorized" | "stale"; prompt: PromptJob | null } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const interaction = this.getCardInteraction(input.interactionId);
      if (!interaction) { this.database.exec("COMMIT"); return { outcome: "missing", prompt: null }; }
      if (interaction.actorOpenId !== input.actorOpenId) { this.database.exec("COMMIT"); return { outcome: "unauthorized", prompt: null }; }
      const source = this.database.prepare(`SELECT p.*, c.steering_origin AS card_steering_origin, c.steering_failure_kind FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id WHERE p.id = ?`).get(input.sourcePromptId) as (PromptRow & { card_steering_origin: string | null; steering_failure_kind: string | null }) | undefined;
      if (source && source.actor_open_id !== input.actorOpenId) { this.database.exec("COMMIT"); return { outcome: "unauthorized", prompt: null }; }
      const existing = this.database.prepare("SELECT * FROM prompt_jobs WHERE source_prompt_id = ?").get(input.sourcePromptId) as PromptRow | undefined;
      if (interaction.state === "consumed" || existing) { this.database.exec("COMMIT"); return { outcome: "duplicate", prompt: existing ? mapPrompt(existing) : null }; }
      const binding = this.getBinding(input.bindingId);
      const valid = interaction.bindingId === input.bindingId && interaction.bindingGeneration === input.bindingGeneration
        && interaction.actionKind === "enqueue_failed_steering" && interaction.targetPromptId === input.sourcePromptId
        && binding?.generation === input.bindingGeneration && binding.state === "active" && binding.lifecycle === "active" && binding.attachment === "attached" && binding.rootMessageId === input.rootMessageId
        && source?.binding_id === input.bindingId && source.state === "failed" && source.dispatch_kind === "steering"
        && source.steering_origin === "automatic" && source.card_steering_origin === "automatic" && source.steering_failure_kind === "rejected";
      if (!valid) { this.database.exec("COMMIT"); return { outcome: "stale", prompt: null }; }
      const queuePosition = Number((this.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' AND dispatch_kind = 'turn'").get(input.bindingId) as { count: number }).count) + 1;
      const view: RunCardView = { ...input.view, steeringOrigin: null, steeringFailureKind: null, queuePosition, createdAt: input.now, updatedAt: input.now, activityAt: input.now };
      this.database.prepare(`INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, state, observation_state, attempt_count, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'turn', NULL, NULL, ?, 0, 'queued', 'not_started', 0, NULL, ?, ?)`)
        .run(input.newPromptId, input.bindingId, input.newLarkMessageId, input.actorOpenId, source.body, input.sourcePromptId, input.now, input.now);
      this.insertRunCard(view);
      this.database.prepare(`INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, card_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'answer', ?, 'stream_card_create', ?, ?, 'pending', 0, ?, ?, ?)`)
        .run(randomUUID(), `run-card:create:${input.newPromptId}:answer`, input.bindingId, input.newPromptId, view.viewVersion, input.rootMessageId, JSON.stringify(input.answerCardFor(view)), `answer:${input.newPromptId}`, input.now, input.now, input.now);
      this.database.prepare("UPDATE card_interactions SET state = 'consumed', result_code = 'converted', consumed_at = ? WHERE id = ? AND state = 'active'").run(input.now, input.interactionId);
      const prompt = this.requirePrompt(input.newPromptId);
      this.database.exec("COMMIT");
      return { outcome: "converted", prompt };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
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
      this.database.prepare("UPDATE prompt_jobs SET observation_state = 'detached', was_detached = 1, error = ?, updated_at = ? WHERE binding_id = ? AND state = 'running'")
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

  createProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; initialPromptText?: string | null; expiresAt: string; card: object }): ProjectSelection {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT * FROM project_selections WHERE command_message_id = ?").get(input.commandMessageId) as ProjectSelectionRow | undefined;
      if (existing) { this.database.exec("COMMIT"); return mapProjectSelection(existing); }
      const timestamp = now();
      this.database.prepare(`INSERT INTO project_selections(id, command_message_id, chat_id, topic_id, root_message_id, actor_open_id, requested_title, initial_prompt_text, state, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
        .run(input.id, input.commandMessageId, input.chatId, input.topicId, input.rootMessageId, input.actorOpenId, input.requestedTitle, input.initialPromptText ?? null, input.expiresAt, timestamp, timestamp);
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

  listCompletedProjectSelectionsWithInitialPrompt(): ProjectSelection[] {
    return (this.database.prepare("SELECT * FROM project_selections WHERE state = 'completed' AND initial_prompt_text IS NOT NULL ORDER BY created_at").all() as ProjectSelectionRow[]).map(mapProjectSelection);
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

  createAutomaticPaneCloseOperation(input: { id: string; bindingId: string; paneId: string; now: string }): void {
    this.database.prepare(`INSERT INTO pane_close_requests(id, binding_id, pane_id, actor_open_id, code_hash, state, expires_at, consumed_at, created_at, updated_at, detail) VALUES (?, ?, ?, 'system:auto-close', '', 'executing', ?, ?, ?, ?, 'automatic retention policy')`)
      .run(input.id, input.bindingId, input.paneId, input.now, input.now, input.now, input.now);
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

  beginWorkerPaneCloseCascade(input: { operationId: string; bindingId: string; paneId: string; reason: string }): Array<{ workerId: string; paneId: string }> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const workers = (this.database.prepare("SELECT id, generation, pane_id FROM agent_instances WHERE role = 'worker' AND parent_binding_id = ? AND parent_pane_id = ? AND worker_session_lifecycle = 'active' ORDER BY created_at, id").all(input.bindingId, input.paneId) as Array<{ id: string; generation: number; pane_id: string | null }>);
      const timestamp = now();
      for (const worker of workers) {
        this.database.prepare("UPDATE instance_turns SET state = 'cancelled', error = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state = 'queued'").run(input.reason, timestamp, worker.id, worker.generation);
        this.database.prepare("UPDATE instance_turns SET state = 'dispatch-uncertain', error = ?, updated_at = ? WHERE instance_id = ? AND instance_generation = ? AND state IN ('claimed','dispatching','running','blocked')").run(input.reason, timestamp, worker.id, worker.generation);
        this.database.prepare("UPDATE agent_instances SET desired_state = 'stopped', observed_state = 'stopped', worker_session_lifecycle = 'terminated', generation = generation + 1, herdr_workspace_id = NULL, pane_id = NULL, native_session_id = NULL, pending_herdr_workspace_id = NULL, pending_pane_id = NULL, last_error = ?, updated_at = ? WHERE id = ? AND generation = ?").run(input.reason, timestamp, worker.id, worker.generation);
        if (worker.pane_id) this.database.prepare("INSERT OR IGNORE INTO worker_pane_close_steps(operation_id, binding_id, parent_pane_id, worker_id, pane_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'executing', ?, ?)").run(input.operationId, input.bindingId, input.paneId, worker.id, worker.pane_id, timestamp, timestamp);
      }
      this.database.exec("COMMIT");
      return workers.filter((worker): worker is { id: string; generation: number; pane_id: string } => worker.pane_id !== null).map((worker) => ({ workerId: worker.id, paneId: worker.pane_id }));
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  listUnresolvedWorkerPaneCloseSteps(): Array<{ operationId: string; bindingId: string; parentPaneId: string; workerId: string; paneId: string; state: "executing" | "uncertain" }> {
    return (this.database.prepare("SELECT operation_id, binding_id, parent_pane_id, worker_id, pane_id, state FROM worker_pane_close_steps WHERE state IN ('executing','uncertain') ORDER BY created_at, worker_id").all() as Array<{ operation_id: string; binding_id: string; parent_pane_id: string; worker_id: string; pane_id: string; state: "executing" | "uncertain" }>).map((row) => ({ operationId: row.operation_id, bindingId: row.binding_id, parentPaneId: row.parent_pane_id, workerId: row.worker_id, paneId: row.pane_id, state: row.state }));
  }

  finishWorkerPaneCloseStep(input: { operationId: string; workerId: string; paneId: string; state: "succeeded" | "uncertain"; detail?: string }): void {
    this.database.prepare("UPDATE worker_pane_close_steps SET state = ?, detail = ?, updated_at = ? WHERE operation_id = ? AND worker_id = ? AND pane_id = ? AND state IN ('executing','uncertain')").run(input.state, input.detail ?? null, now(), input.operationId, input.workerId, input.paneId);
  }

  listUnresolvedPaneCloseOperations(): PaneCloseOperation[] {
    return (this.database.prepare("SELECT id, binding_id, pane_id, state FROM pane_close_requests WHERE state IN ('executing','uncertain') ORDER BY created_at, id").all() as Array<{ id: string; binding_id: string; pane_id: string; state: PaneCloseOperation["state"] }>)
      .map((row) => ({ id: row.id, bindingId: row.binding_id, paneId: row.pane_id, state: row.state }));
  }

  /** Legacy test/setup escape hatch; workflows must use explicit ports below. */
  updateBinding(id: string, patch: Partial<Binding>): Binding { return this.persistBindingPatch(id, patch); }

  private persistBindingPatch(id: string, patch: Partial<Binding>): Binding {
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

  updateBindingMetadata(id: string, patch: BindingMetadataPatch): Binding { return this.persistBindingPatch(id, patch); }

  replaceProvisioningPane(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: HerdrPane }): Binding {
    const timestamp = now();
    const result = this.database.prepare(`UPDATE bindings SET
      pane_id = ?, traex_session_id = ?,
      agent_session_source = ?, agent_session_agent = ?, agent_session_kind = ?, agent_session_value = ?,
      workspace_id = ?, generation = generation + 1, last_agent_state = ?, last_observed_at = NULL, updated_at = ?
      WHERE id = ? AND pane_id = ? AND generation = ? AND lifecycle = 'provisioning' AND provisioning_checkpoint = 'pane_created'`)
      .run(
        input.pane.paneId, input.pane.terminalId ?? null, input.pane.agentSession?.source ?? null, input.pane.agentSession?.agent ?? null,
        input.pane.agentSession?.kind ?? null, input.pane.agentSession?.value ?? null, input.pane.workspaceId, input.pane.agentState, timestamp,
        input.bindingId, input.expectedPaneId, input.expectedGeneration
      );
    if (result.changes !== 1) throw new Error(`Provisioning pane replacement lost ownership for binding ${input.bindingId}`);
    return this.requireBinding(input.bindingId);
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
    return this.persistBindingPatch(id, {
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
        this.database.exec("COMMIT");
        return { outcome: "terminal_identity_changed", binding };
      }
      const nativeSessionMismatch = Boolean(persistedSession && observedSession && !sameSession);
      if (terminalIdentityRefreshed || (!persistedSession && observedSession)) binding = this.persistBindingPatch(binding.id, {
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

  reconcileBindingTitleWithProjection(input: BindingTitleProjectionInput): BindingTitleProjectionResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let binding = this.requireBinding(input.bindingId);
      if (!this.matchesRuntimeFence(binding, input.expectedPaneId, input.expectedGeneration)) {
        this.database.exec("COMMIT");
        return { outcome: "stale_binding", binding, outboxReserved: false };
      }
      if (binding.title === input.title) {
        this.database.exec("COMMIT");
        return { outcome: "unchanged", binding, outboxReserved: false };
      }
      this.database.prepare("UPDATE bindings SET title = ?, updated_at = ? WHERE id = ?").run(input.title, now(), input.bindingId);
      binding = this.requireBinding(input.bindingId);
      this.saveTopicView(input.view);
      const reservation = this.reserveMainCardInTransaction(input.view, input.rootMessageId, input.card);
      this.database.exec("COMMIT");
      return { outcome: "projected", binding, outboxReserved: reservation === "reserved" };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  degradeBindingWithProjection(input: RuntimeDegradationInput): RuntimeDegradationResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let binding = this.requireBinding(input.bindingId);
      if (!this.matchesRuntimeFence(binding, input.expectedPaneId, input.expectedGeneration)) {
        this.database.exec("COMMIT");
        return { outcome: "stale", binding, view: this.loadTopicView(input.bindingId), outboxReserved: false };
      }
      const current = this.loadTopicView(input.bindingId) ?? initialTopicView(input.bindingId);
      if (binding.attachment === "degraded" && current.phase === input.view.phase && current.notice === input.view.notice) {
        this.database.exec("COMMIT");
        return { outcome: "unchanged", binding, view: current, outboxReserved: false };
      }
      if (current.viewVersion > input.view.viewVersion) {
        this.database.exec("COMMIT");
        return { outcome: "stale", binding, view: current, outboxReserved: false };
      }
      binding = this.transitionBinding(input.bindingId, { type: "agent_unregistered" });
      this.saveTopicView(input.view);
      const reservation = this.reserveMainCardInTransaction(input.view, input.rootMessageId, input.mainCard);
      this.database.exec("COMMIT");
      return { outcome: "degraded", binding, view: this.loadTopicView(input.bindingId), outboxReserved: reservation === "reserved" };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  orphanBindingWithProjection(input: OrphanBindingProjectionInput): OrphanBindingProjectionResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let binding = this.requireBinding(input.bindingId);
      if (binding.paneId !== input.expectedPaneId || binding.generation !== input.expectedGeneration) { this.database.exec("COMMIT"); return { outcome: "stale", binding: null, view: null, updatedPromptIds: [], outboxReserved: false }; }
      if (binding.attachment === "orphaned") { this.database.exec("COMMIT"); return { outcome: "unchanged", binding, view: this.loadTopicView(input.bindingId), updatedPromptIds: [], outboxReserved: false }; }
      const current = this.loadTopicView(input.bindingId) ?? initialTopicView(input.bindingId);
      if (current.viewVersion > input.view.viewVersion) { this.database.exec("COMMIT"); return { outcome: "stale", binding, view: current, updatedPromptIds: [], outboxReserved: false }; }
      binding = this.transitionBinding(input.bindingId, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 2 });
      if (binding.attachment !== "orphaned") { this.database.exec("COMMIT"); return { outcome: "unchanged", binding, view: this.loadTopicView(input.bindingId), updatedPromptIds: [], outboxReserved: false }; }
      this.database.prepare(`
        UPDATE prompt_jobs SET
          state = CASE state WHEN 'queued' THEN 'cancelled' ELSE 'failed' END,
          observation_state = 'completed', error = ?, updated_at = ?
        WHERE binding_id = ? AND state IN ('running', 'queued')
      `).run(input.reason, input.occurredAt, input.bindingId);
      const updatedPromptIds: string[] = [];
      let answerOutboxReserved = false;
      for (const view of this.listRunCardsByPhases(input.bindingId, ["running", "blocked", "queued"])) {
        const next = { ...view, phase: "failed" as const, notice: input.reason, finishedAt: input.occurredAt, queuePosition: 0, activityAt: input.occurredAt, viewVersion: view.viewVersion + 1, updatedAt: input.occurredAt };
        this.saveRunCard(next);
        updatedPromptIds.push(next.promptId);
        if (!next.answerCardId && next.answerMessageId) {
          this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:update:${next.promptId}:answer:${next.viewVersion}`, bindingId: next.bindingId, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: next.answerMessageId, kind: "card_update", payload: JSON.stringify(input.renderRunCard(next)) });
          answerOutboxReserved = true;
        } else if (!next.answerCardId && !next.answerMessageId && input.rootMessageId) {
          this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:create:${next.promptId}:answer`, bindingId: next.bindingId, promptId: next.promptId, viewVersion: next.viewVersion, cardRole: "answer", rootMessageId: input.rootMessageId, kind: "stream_card_create", payload: JSON.stringify(input.renderRunCard(next)) });
          answerOutboxReserved = true;
        }
      }
      this.saveTopicView(input.view);
      const reservation = this.reserveMainCardInTransaction(input.view, input.rootMessageId, input.mainCard);
      this.database.exec("COMMIT");
      return { outcome: "orphaned", binding, view: this.loadTopicView(input.bindingId), updatedPromptIds, outboxReserved: answerOutboxReserved || reservation === "reserved" };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
  }

  recoverOrphanBindingWithProjection(input: RecoverOrphanBindingProjectionInput): RecoverOrphanBindingProjectionResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      let binding = this.requireBinding(input.bindingId);
      if (binding.paneId !== input.expectedPaneId || input.pane.paneId !== input.expectedPaneId || binding.generation !== input.expectedGeneration
        || binding.lifecycle !== "active" || binding.attachment !== "orphaned" || binding.workspaceId !== input.pane.workspaceId) {
        this.database.exec("COMMIT");
        return { outcome: "stale", binding, view: this.loadTopicView(input.bindingId), outboxReserved: false };
      }
      const persistedSession = binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
        ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
        : null;
      const observedSession = input.pane.agentSession ?? null;
      const nativeSessionMatches = !persistedSession || Boolean(observedSession
        && persistedSession.source === observedSession.source && persistedSession.agent === observedSession.agent
        && persistedSession.kind === observedSession.kind && persistedSession.value === observedSession.value);
      if (!binding.traexSessionId || !input.pane.terminalId || binding.traexSessionId !== input.pane.terminalId
        || !nativeSessionMatches || !isTraexCompatibleNativeAgent(input.pane)) {
        this.database.exec("COMMIT");
        return { outcome: "identity_mismatch", binding, view: this.loadTopicView(input.bindingId), outboxReserved: false };
      }
      binding = this.transitionBinding(input.bindingId, { type: "pane_reattached", replacement: false });
      binding = this.transitionBinding(input.bindingId, { type: "pane_observed", runtime: input.pane.agentState });
      this.saveTopicView(input.view);
      const reservation = this.reserveMainCardInTransaction(input.view, input.rootMessageId, input.mainCard);
      this.database.exec("COMMIT");
      return { outcome: "recovered", binding, view: this.loadTopicView(input.bindingId), outboxReserved: reservation === "reserved" };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: BridgeEvent; view: TopicViewState; messageId: string; card: object }): Binding {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const binding = this.transitionBinding(input.id, input.transition);
      this.database.prepare("INSERT OR IGNORE INTO lifecycle_events(event_id, binding_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)")
        .run(input.event.eventId, input.id, input.event.type, JSON.stringify(input.event.payload), input.event.occurredAt);
      this.saveTopicView(input.view);
      this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `main-card:update:${input.id}:${input.view.viewVersion}`, bindingId: input.id, viewVersion: input.view.viewVersion, targetRole: "session_status", rootMessageId: input.messageId, kind: "card_update", payload: JSON.stringify(input.card) });
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
      if (!replacement) this.database.prepare("DELETE FROM primary_tool_capabilities WHERE binding_id = ? AND binding_generation = ?").run(id, suspended.generation);
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
    return this.prompts.countPendingPrompts(bindingId);
  }

  listQueuedTurnPromptIds(bindingId: string): string[] {
    return this.prompts.listQueuedTurnPromptIds(bindingId);
  }

  listQueuedTurnRunCards(bindingId: string): RunCardView[] {
    return this.prompts.listQueuedTurnRunCards(bindingId);
  }

  listCompletedOrdinaryTurnDurations(bindingId: string, limit: number): number[] {
    return this.prompts.listCompletedOrdinaryTurnDurations(bindingId, limit);
  }

  loadQueueFeedbackInputs(bindingId: string): { activeStartedAt: string | null; queued: RunCardView[]; durationsMs: number[] } {
    return this.prompts.loadQueueFeedbackInputs(bindingId);
  }

  projectQueuedRunCards(input: { bindingId: string; projections: Array<{ expectedViewVersion: number; view: RunCardView; card: object | null }> }): { projected: RunCardView[]; stalePromptIds: string[]; outboxReserved: boolean } {
    if (input.projections.length === 0) return { projected: [], stalePromptIds: [], outboxReserved: false };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const projected: RunCardView[] = [];
      const stalePromptIds: string[] = [];
      let outboxReserved = false;
      for (const projection of input.projections) {
        const current = this.loadRunCard(projection.view.promptId);
        if (!current || current.bindingId !== input.bindingId || current.phase !== "queued" || current.viewVersion !== projection.expectedViewVersion) {
          stalePromptIds.push(projection.view.promptId);
          continue;
        }
        const view = this.saveRunCard(projection.view);
        projected.push(view);
        if (view.answerMessageId && projection.card) {
          const reply = this.enqueueOutboundReply({ id: randomUUID(), idempotencyKey: `run-card:update:${view.promptId}:answer:${view.viewVersion}`, bindingId: view.bindingId, promptId: view.promptId, viewVersion: view.viewVersion, cardRole: "answer", rootMessageId: view.answerMessageId, kind: "card_update", payload: JSON.stringify(projection.card) });
          outboxReserved ||= reply.state === "pending";
        }
      }
      this.database.exec("COMMIT");
      return { projected, stalePromptIds, outboxReserved };
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
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
    return this.prompts.recoverRunningPrompts();
  }

  scanDurablePromptWork(): DurablePromptWorkScan {
    return this.prompts.scanDurablePromptWork();
  }

  listStaleUndispatchedPromptClaims(updatedBefore: string, limit: number): StalePromptClaim[] {
    return this.prompts.listStaleUndispatchedPromptClaims(updatedBefore, limit);
  }

  requeueStaleUndispatchedPromptClaim(candidate: StalePromptClaim): boolean {
    return this.prompts.requeueStaleUndispatchedPromptClaim(candidate);
  }

  listDetachedPrompts(): PromptJob[] {
    return this.prompts.listDetachedPrompts();
  }

  skipOldestDetachedPrompt(input: { bindingId: string; expectedBindingGeneration: number; actorOpenId: string; sourceMessageId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): import("../domain/ports/prompt.js").DetachedPromptSkipResult {
    return this.prompts.skipOldestDetachedPrompt(input);
  }

  settleDetachedPrompt(input: { promptId: string; bindingId: string; runtime: Binding["lastAgentState"]; occurredAt: string; terminal: { kind: "completed"; answer: string; outputFingerprint: string } | { kind: "failed"; error: string } }): boolean {
    return this.prompts.settleDetachedPrompt(input);
  }

  markPromptObservationDetached(id: string, notice: string): void {
    this.prompts.markPromptObservationDetached(id, notice);
  }

  markPromptDispatched(id: string): void;
  markPromptDispatched(id: string, dispatchedAt: string): void;
  markPromptDispatched(id: string, dispatchedAt = now()): void {
    this.prompts.markPromptDispatched(id, dispatchedAt);
  }

  markModelPromptPrepared(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string }): boolean {
    return this.prompts.markModelPromptPrepared(input);
  }

  markModelPromptAccepted(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string; turnId: string }): boolean {
    return this.prompts.markModelPromptAccepted(input);
  }

  rollbackPreparedModelPrompt(input: { bindingId: string; bindingGeneration: number; promptId: string; revision: number; operationId: string }): boolean {
    return this.prompts.rollbackPreparedModelPrompt(input);
  }

  claimPromptTranscriptTurn(input: { promptId: string; bindingId: string; turnId: string; startedAt: string }): TranscriptTurnClaimOutcome {
    return this.prompts.claimPromptTranscriptTurn(input);
  }

  adoptExternalTurn(input: Parameters<BindingStorePort["adoptExternalTurn"]>[0]): ExternalTurnAdoption {
    return this.prompts.adoptExternalTurn(input);
  }

  recoverLegacyElementIdDeadLetters(): number {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.migrations.canonicalizeLegacyAnswerTargets(timestamp);
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

  enqueuePrompt(input: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "priority" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin"> & Partial<Pick<PromptJob, "dispatchKind" | "priority" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached" | "executionOrigin">>): { prompt: PromptJob; inserted: boolean } {
    return this.prompts.enqueuePrompt(input);
  }

  acceptPrompt(input: Parameters<BindingStorePort["acceptPrompt"]>[0]): { prompt: PromptJob; view: RunCardView; inserted: boolean } {
    return this.prompts.acceptPrompt(input);
  }

  acceptClassifiedPrompt(input: ClassifiedPromptInput): ClassifiedPromptAcceptance {
    return this.prompts.acceptClassifiedPrompt(input);
  }

  ensureAnswerCard(promptId: string, rootMessageId: string, card: object): void {
    const view = this.loadRunCard(promptId);
    if (!view || view.answerMessageId) return;
    const existing = this.database.prepare("SELECT view_version FROM outbound_replies WHERE idempotency_key = ?").get(`run-card:create:${promptId}:answer`) as { view_version: number | null } | undefined;
    if (existing && (existing.view_version ?? 0) >= view.viewVersion) return;
    const prompt = this.requirePrompt(promptId);
    this.enqueueOutboundReply({
      id: randomUUID(), idempotencyKey: `run-card:create:${promptId}:answer`, bindingId: prompt.bindingId, promptId, viewVersion: view.viewVersion,
      cardRole: "answer", rootMessageId, kind: "card_reply", payload: JSON.stringify(card)
    });
  }

  claimNextDispatchablePrompt(bindingId: string): { binding: Binding; prompt: PromptJob; model: { name: string; revision: number } | null } | null {
    return this.prompts.claimNextDispatchablePrompt(bindingId);
  }

  claimNextReadySteering(bindingId: string, parentPromptId: string): PromptJob | null {
    return this.prompts.claimNextReadySteering(bindingId, parentPromptId);
  }

  failQueuedSteering(bindingId: string, parentPromptId: string, notice: string): string[] {
    return this.prompts.failQueuedSteering(bindingId, parentPromptId, notice);
  }

  updatePrompt(id: string, state: PromptState, error: string | null = null): void {
    this.prompts.updatePrompt(id, state, error);
  }

  completeTurn(input: { promptId: string; bindingId: string; answer: string; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): Binding {
    return this.prompts.completeTurn(input);
  }

  failPrompt(input: { promptId: string; error: string; occurredAt: string; steeringFailureKind?: "rejected" | "uncertain" }): void {
    this.prompts.failPrompt(input);
  }

  completeSteering(input: { promptId: string; notice: string; occurredAt: string }): void {
    this.prompts.completeSteering(input);
  }

  cancelQueuedPromptsWithProjection(input: { bindingId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): { cancelledPromptIds: string[]; outboxReserved: boolean } {
    return this.prompts.cancelQueuedPromptsWithProjection(input);
  }

  enqueueOutboundReply(input: Omit<OutboundReply, "laneKey" | "promptId" | "workerTurnId" | "workerId" | "workerSessionGeneration" | "viewVersion" | "cardSequence" | "selectionId" | "cardRole" | "targetRole" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "cardIdCheckpoint" | "failureClass" | "httpStatus" | "larkErrorCode" | "autoRecoveryCount" | "deadLetteredAt" | "nextAttemptAt" | "createdAt" | "updatedAt"> & { promptId?: string | null; workerTurnId?: string | null; workerId?: string | null; workerSessionGeneration?: number | null; viewVersion?: number | null; cardSequence?: number | null; selectionId?: string | null; cardRole?: OutboundReply["cardRole"]; targetRole?: OutboundReply["targetRole"]; laneKeyOverride?: string }): OutboundReply {
    return this.outbox.enqueueOutboundReply(input);
  }

  listPendingOutboundReplies(): OutboundReply[] {
    return this.outbox.listPendingOutboundReplies();
  }

  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean {
    return this.outbox.hasPendingAnswerContinuation(promptId, pageIndex);
  }

  dismissSupersededAnswerStream(replyId: string): boolean {
    return this.outbox.dismissSupersededAnswerStream(replyId);
  }

  listOutboundLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys: readonly string[] = []): OutboundReply[] {
    return this.outbox.listOutboundLaneHeads(limit, dueAt, excludedLaneKeys);
  }

  getNextOutboundLaneHeadAttemptAt(): string | null {
    return this.outbox.getNextOutboundLaneHeadAttemptAt();
  }

  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string): void {
    this.outbox.markOutboundReplyDelivered(id, messageId, cardId);
  }


  checkpointOutboundReplyCard(id: string, cardId: string): OutboundReply | null {
    return this.outbox.checkpointOutboundReplyCard(id, cardId);
  }

  markOutboundReplyFailed(id: string, error: string, retryDelayMs?: number, metadata?: DeliveryFailureMetadata): OutboundReply | null {
    return this.outbox.markOutboundReplyFailed(id, error, retryDelayMs, metadata);
  }

  markOutboundReplyDeadLetter(id: string, error: string, metadata?: DeliveryFailureMetadata): OutboundReply | null {
    return this.outbox.markOutboundReplyDeadLetter(id, error, metadata);
  }

  markOutboundReplyFailedWithQuarantine(id: string, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number): OutboundFailureTransition | null {
    return this.outbox.markOutboundReplyFailedWithQuarantine(id, error, metadata, retryDelayMs);
  }

  private refreshOutboxLaneHead(laneKey: string): void {
    this.outbox.refreshOutboxLaneHead(laneKey);
  }

  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[] {
    return this.outbox.recoverEligibleDeadLetters(cutoff, limit);
  }

  recoverUnsupportedWorkerCardCreates(render: (view: WorkerTurnCardView) => object): string[] {
    return this.outbox.recoverUnsupportedWorkerCardCreates(render);
  }

  convergeWorkerTaskCardRenderer(revision: string, render: (view: WorkerTurnCardView, page?: WorkerTurnCardPage) => object): string[] {
    return this.outbox.convergeWorkerTaskCardRenderer(revision, render);
  }

  recoverStaleOutboxQuarantines(): import("../domain/types.js").StaleOutboxQuarantineRecovery {
    return this.outbox.recoverStaleOutboxQuarantines();
  }

  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.outbox.retryDeadLetter(id, chatId, actorOpenId);
  }

  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.outbox.dismissDeadLetter(id, chatId, actorOpenId);
  }

  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number {
    return this.outbox.pruneDeliveredOutboundReplies(cutoff, limit);
  }

  pruneAcceptedInboundMessages(cutoff: string, limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) return 0;
    const result = this.database.prepare(`
      DELETE FROM inbound_messages
      WHERE event_id IN (
        SELECT event_id FROM inbound_messages
        WHERE state = 'accepted' AND updated_at < ?
        ORDER BY updated_at, event_id
        LIMIT ?
      )
    `).run(cutoff, limit);
    return Number(result.changes);
  }

  inspectIntegrity(limit: number): SqliteIntegrityInspection { return this.operations.inspectIntegrity(limit); }

  getOperationalSummary(): OperationalSummary { return this.operations.getOperationalSummary(); }

  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void { this.operations.audit(input); }

  saveTopicView(view: TopicViewState): void {
    this.projections.saveTopicView(view);
  }

  loadTopicView(bindingId: string): TopicViewState | null {
    return this.projections.loadTopicView(bindingId);
  }

  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object): MainCardReservationOutcome {
    return this.projections.reserveMainCard(view, rootMessageId, card);
  }

  private matchesRuntimeFence(binding: Binding, expectedPaneId: string, expectedGeneration: number): boolean {
    return binding.paneId === expectedPaneId && binding.generation === expectedGeneration
      && (binding.lifecycle === "active" || binding.lifecycle === "draining") && binding.attachment !== "orphaned";
  }

  private reserveMainCardInTransaction(view: TopicViewState, rootMessageId: string | null, card: object): MainCardReservationOutcome {
    return this.projections.reserveMainCardIntent(view, rootMessageId, card);
  }

  saveRunCard(view: RunCardView): RunCardView {
    return this.projections.saveRunCard(view);
  }

  loadRunCard(promptId: string): RunCardView | null {
    return this.projections.loadRunCard(promptId);
  }

  listRunCards(bindingId: string): RunCardView[] {
    return this.projections.listRunCards(bindingId);
  }

  listRunCardsByPhases(bindingId: string, phases: readonly RunCardView["phase"][]): RunCardView[] {
    return this.projections.listRunCardsByPhases(bindingId, phases);
  }

  getActiveAnswerPage(promptId: string): AnswerPage | null {
    return this.projections.getActiveAnswerPage(promptId);
  }

  getAnswerPageDeliveryFacts(promptId: string, pageIndex: number): AnswerPageDeliveryFacts {
    return this.projections.getAnswerPageDeliveryFacts(promptId, pageIndex);
  }

  reserveAnswerContent(input: { promptId: string; pageIndex: number; cardId: string; elementId: string; content: string }): AnswerPageReservationOutcome {
    return this.projections.reserveAnswerContent(input);
  }

  reserveAnswerFinish(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object }): AnswerPageReservationOutcome {
    return this.projections.reserveAnswerFinish(input);
  }

  reserveAnswerContinuation(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.projections.reserveAnswerContinuation(input);
  }

  reserveAnswerRebuild(input: { promptId: string; pageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.projections.reserveAnswerRebuild(input);
  }

  reserveFinalAnswerCardUpdate(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; card: object }): AnswerPageReservationOutcome {
    return this.projections.reserveFinalAnswerCardUpdate(input);
  }

  reserveClosedAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object }): AnswerPageReservationOutcome {
    return this.projections.reserveClosedAnswerCardUpdate(input);
  }

  reserveStaticAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object }): AnswerPageReservationOutcome {
    return this.projections.reserveStaticAnswerCardUpdate(input);
  }

  reserveStaticAnswerReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.projections.reserveStaticAnswerReplacement(input);
  }

  listAnswerPages(promptId: string): AnswerPage[] {
    return this.projections.listAnswerPages(promptId);
  }

  private insertRunCard(view: RunCardView): void {
    this.projections.insertRunCard(view);
  }

  private requireBinding(id: string): Binding {
    const row = this.database.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as BindingRow | undefined;
    if (!row) throw new Error(`Binding not found: ${id}`);
    return mapBinding(row);
  }

  getPrompt(id: string): PromptJob | null {
    return this.prompts.getPrompt(id);
  }

  getModelPreference(bindingId: string): ModelPreference | null {
    const row = this.database.prepare("SELECT * FROM binding_model_preferences WHERE binding_id = ?").get(bindingId) as ModelPreferenceRow | undefined;
    return row ? mapModelPreference(row) : null;
  }

  acceptModelPreference(input: { bindingId: string; bindingGeneration: number; model: string }): { outcome: "accepted" | "busy" | "stale"; preference: ModelPreference | null } {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const binding = this.database.prepare("SELECT generation FROM bindings WHERE id = ?").get(input.bindingId) as { generation: number } | undefined;
      const existing = this.getModelPreference(input.bindingId);
      const decision = acceptModelSelection(existing, { ...input, currentBindingGeneration: Number(binding?.generation ?? -1), updatedAt: now() });
      if (decision.outcome !== "accepted") {
        this.database.exec("COMMIT");
        return decision;
      }
      const next = decision.preference;
      this.database.prepare(`
        INSERT INTO binding_model_preferences(binding_id, binding_generation, desired_model, desired_revision, effective_model, effective_revision, state, dispatch_prompt_id, prepared_operation_id, updated_at)
        VALUES (?, ?, ?, ?, NULL, NULL, 'pending', NULL, NULL, ?)
        ON CONFLICT(binding_id) DO UPDATE SET binding_generation = excluded.binding_generation, desired_model = excluded.desired_model, desired_revision = excluded.desired_revision,
          effective_model = CASE WHEN binding_model_preferences.binding_generation = excluded.binding_generation THEN binding_model_preferences.effective_model ELSE NULL END,
          effective_revision = CASE WHEN binding_model_preferences.binding_generation = excluded.binding_generation THEN binding_model_preferences.effective_revision ELSE NULL END,
          state = 'pending', dispatch_prompt_id = NULL, prepared_operation_id = NULL, updated_at = excluded.updated_at
      `).run(next.bindingId, next.bindingGeneration, next.desiredModel, next.desiredRevision, next.updatedAt);
      const preference = this.getModelPreference(input.bindingId);
      this.database.exec("COMMIT");
      return { outcome: "accepted", preference };
    } catch (error) { if (this.database.isTransaction) this.database.exec("ROLLBACK"); throw error; }
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

  private requireRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation {
    const row = this.database.prepare("SELECT * FROM retired_pane_cleanup_operations WHERE id = ?").get(id) as RetiredPaneCleanupRow | undefined;
    if (!row) throw new Error(`Retired pane cleanup ${id} not found`);
    return mapRetiredPaneCleanup(row);
  }

}

function now(): string { return new Date().toISOString(); }
function summarizeTaskTitle(text: string): string { return text.trim().split(/\r?\n/, 1)[0]!.slice(0, 120) || "Untitled task"; }
function durationSeconds(startedAt: string | null, finishedAt: string | null): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt); const finish = Date.parse(finishedAt ?? now());
  return Number.isFinite(start) && Number.isFinite(finish) ? Math.max(0, Math.floor((finish - start) / 1_000)) : null;
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
function boundedError(value: string | null): string { return (value ?? "Unknown failure").slice(0, 500); }
function retryAt(attempt: number, explicitDelayMs?: number): string {
  const exponential = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
  const jittered = Math.round(exponential * (0.8 + Math.random() * 0.4));
  const delay = explicitDelayMs === undefined ? jittered : Math.max(exponential, Math.min(3_600_000, explicitDelayMs));
  return new Date(Date.now() + delay).toISOString();
}

function outboundLaneClass(reply: OutboundReply): OutboxLaneClass {
  if (reply.cardRole === "answer" && reply.promptId && (reply.kind === "stream_content" || reply.kind === "stream_finish")) return "answer_stream";
  if (reply.targetRole === "session_status" && reply.kind === "card_update") return "main_card";
  if (reply.kind === "card_update") return "replaceable_card";
  return "immutable";
}
function streamCardState(payload: string): { pageIndex: number; pageStart: number; elementId: string } | null {
  try {
    const decoded = JSON.parse(payload) as { stream?: { pageIndex?: unknown; pageStart?: unknown; elementId?: unknown } };
    const stream = decoded.stream;
    return stream && Number.isInteger(stream.pageIndex) && Number.isInteger(stream.pageStart) && typeof stream.elementId === "string"
      ? { pageIndex: Number(stream.pageIndex), pageStart: Number(stream.pageStart), elementId: stream.elementId } : null;
  } catch { return null; }
}

function streamContentPageIndex(payload: string): number | null {
  try {
    const decoded = JSON.parse(payload) as { pageIndex?: unknown };
    return Number.isInteger(decoded.pageIndex) ? Number(decoded.pageIndex) : null;
  } catch { return null; }
}

function mapWorkerTurnCard(row: Record<string, unknown> | undefined): WorkerTurnCardView | null {
  if (!row) return null;
  return {
    turnId: String(row.turn_id), instanceId: String(row.instance_id), instanceGeneration: Number(row.instance_generation), workerSessionGeneration: Number(row.worker_session_generation ?? 1), workerName: String(row.worker_name),
    parentTurnId: row.parent_turn_id === null ? null : String(row.parent_turn_id), rootMessageId: String(row.root_message_id),
    messageId: row.message_id === null ? null : String(row.message_id), cardId: row.card_id === null ? null : String(row.card_id), elementId: String(row.element_id), progressSequence: Number(row.progress_sequence ?? 0),
    phase: String(row.phase) as WorkerTurnCardView["phase"], requestText: String(row.request_text), answer: String(row.answer), statusTitle: row.status_title === null || row.status_title === undefined ? null : String(row.status_title), progressEvents: parseWorkerProgress(row.progress_json), progressSummary: summarizeWorkerProgress(parseWorkerProgress(row.progress_json)), queuePosition: Number(row.queue_position),
    startedAt: row.started_at === null ? null : String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at), notice: row.notice === null ? null : String(row.notice),
    resultCapture: String(row.result_capture) as WorkerTurnCardView["resultCapture"],
    workerMain: parseCardTargetRef(row.worker_main_ref_json) ?? { aggregateKind: "worker-session", aggregateId: String(row.instance_id), generation: 1, messageId: null },
    primaryAnswer: parseCardTargetRef(row.primary_answer_ref_json), pageIndex: Number(row.page_index), pageStart: Number(row.page_start), sequence: Number(row.sequence),
    viewVersion: Number(row.view_version), deliveredVersion: Number(row.delivered_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}
function parseCardTargetRef(value: unknown): import("../domain/card-target-ref.js").CardTargetRef | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.aggregateKind === "string" && typeof parsed.aggregateId === "string" && typeof parsed.generation === "number"
      ? parsed as unknown as import("../domain/card-target-ref.js").CardTargetRef : null;
  } catch { return null; }
}
function mapCardContextInvalidation(row: Record<string, unknown>): CardContextInvalidation {
  return {
    targetKind: String(row.target_kind) as CardContextInvalidation["targetKind"], targetId: String(row.target_id), targetGeneration: Number(row.target_generation),
    requestedDependencyRevision: Number(row.requested_dependency_revision), projectedDependencyRevision: Number(row.projected_dependency_revision), reason: String(row.reason),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}
function parseWorkerProgress(value: unknown): import("../domain/run-card-view.js").RunProgressEvent[] {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is import("../domain/run-card-view.js").RunProgressEvent => isRecord(entry) && typeof entry.key === "string" && typeof entry.label === "string" && typeof entry.kind === "string" && typeof entry.state === "string" && typeof entry.occurredAt === "string") : [];
  } catch { return []; }
}
function summarizeWorkerProgress(events: readonly import("../domain/run-card-view.js").RunProgressEvent[]): import("../domain/run-card-view.js").RunProgressSummary {
  let stepTotal = 0; let stepDone = 0;
  for (const event of events) if (event.kind === "step") { stepTotal += 1; if (event.state === "done") stepDone += 1; }
  return { total: events.length, stepTotal, stepDone };
}

function mapWorkerTurnCardPage(row: Record<string, unknown>): WorkerTurnCardPage {
  return {
    id: String(row.id), turnId: String(row.turn_id), pageIndex: Number(row.page_index), pageStart: Number(row.page_start), elementId: String(row.element_id),
    messageId: row.message_id === null ? null : String(row.message_id), cardId: row.card_id === null ? null : String(row.card_id),
    state: String(row.state) as WorkerTurnCardPage["state"], sequence: Number(row.sequence), createdAt: String(row.created_at), updatedAt: String(row.updated_at)
  };
}
function matchesExpectedRuntimeTurn(turn: InstanceTurn, input: { expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string }): boolean {
  return (input.expectedRuntimeTurnId === undefined || turn.runtimeTurnId === input.expectedRuntimeTurnId)
    && (input.expectedRuntimeTurnStartedAt === undefined || turn.runtimeTurnStartedAt === input.expectedRuntimeTurnStartedAt);
}
function sameTurnControlRequest(operation: TurnControlOperation, input: AcceptTurnControlOperationInput): boolean {
  const left = operation.target;
  const right = input.target;
  return operation.kind === input.kind && operation.payload === input.payload
    && operation.sourceMessageId === (input.sourceMessageId ?? null) && operation.sourceCardId === (input.sourceCardId ?? null)
    && left.owner.kind === right.owner.kind && left.owner.id === right.owner.id && left.projectId === right.projectId
    && left.paneId === right.paneId && left.generation === right.generation && left.logicalTurnId === right.logicalTurnId && left.runtimeTurnId === right.runtimeTurnId
    && left.agentSession.source === right.agentSession.source && left.agentSession.agent === right.agentSession.agent
    && left.agentSession.kind === right.agentSession.kind && left.agentSession.value === right.agentSession.value;
}

function bindingSessionMatches(binding: Binding, expected: import("../domain/types.js").HerdrAgentSession): boolean {
  return binding.agentSessionSource === expected.source && binding.agentSessionAgent === expected.agent
    && binding.agentSessionKind === expected.kind && binding.agentSessionValue === expected.value;
}

function parseJsonRecord(payload: string): Record<string, unknown> {
  try { const value = JSON.parse(payload) as unknown; return isRecord(value) ? value : {}; } catch { return {}; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isTraexCompatibleNativeAgent(pane: HerdrPane): boolean {
  return pane.agentKind !== null && pane.agentKind !== undefined && TRAEX_COMPATIBLE_AGENT_KINDS.has(pane.agentKind);
}
