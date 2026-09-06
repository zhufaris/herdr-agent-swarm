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
import type { ControlActor } from "../domain/commands.js";
import type { InstanceEvent, InstanceEventKind, InstanceOperation, InstanceTurn, InstanceTurnState, InstanceTurnSummary } from "../domain/instance-turn.js";
import type { ApprovalGrant, ApprovalIdentity, ApprovalRequest } from "../domain/approval-policy.js";
import { reduceWorkerTurnCard, type WorkerTurnCardChange, type WorkerTurnCardPage, type WorkerTurnCardView } from "../domain/worker-turn-card-view.js";
import type { WorkerMainView } from "../domain/worker-main-view.js";
import type { CardContextInvalidation, CardContextTarget } from "../domain/card-context-invalidation.js";
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
import { SqliteInstanceStore } from "./sqlite/instance-store.js";
import { SqliteCardContextStore } from "./sqlite/card-context-store.js";
import { SqliteInboundProjectStore } from "./sqlite/inbound-project-store.js";
import { SqlitePaneOperationStore } from "./sqlite/pane-operation-store.js";
import { SqliteBindingLifecycleStore } from "./sqlite/binding-store.js";
import { SqliteBindingProjectionStore } from "./sqlite/binding-projection-store.js";
import { SqliteInstanceOperationStore } from "./sqlite/instance-operation-store.js";
import { SqliteTurnControlStore } from "./sqlite/turn-control-store.js";
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
  private readonly instances: SqliteInstanceStore;
  private readonly cardContexts: SqliteCardContextStore;
  private readonly inboundProjects: SqliteInboundProjectStore;
  private readonly paneOperations: SqlitePaneOperationStore;
  private readonly bindings: SqliteBindingLifecycleStore;
  private readonly bindingProjections: SqliteBindingProjectionStore;
  private readonly instanceOperations: SqliteInstanceOperationStore;
  private readonly turnControls: SqliteTurnControlStore;

  constructor(path: string) {
    this.context = new SqliteContext(path);
    this.database = this.context.database;
    this.migrations = new SqliteMigrations(this.context);
    this.migrations.run();
    this.bindings = new SqliteBindingLifecycleStore(this.context);
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
    this.bindingProjections = new SqliteBindingProjectionStore(this.context, this.bindings, this.projections, {
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input),
      listRunCardsByPhases: (bindingId, phases) => this.listRunCardsByPhases(bindingId, phases)
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
      invalidateWorkerCardContexts: (view, reason) => this.cardContexts.invalidateWorkerCardContexts(view, reason)
    });
    this.instances = new SqliteInstanceStore(this.context, {
      invalidateWorkerInstanceContexts: (instance, reason) => this.cardContexts.invalidateWorkerInstanceContexts(instance, reason)
    });
    this.instanceOperations = new SqliteInstanceOperationStore(this.context, (id) => this.instances.getAgentInstance(id));
    this.cardContexts = new SqliteCardContextStore(this.context, {
      getAgentInstance: (id) => this.instances.getAgentInstance(id),
      getWorkspaceLease: (id) => this.instances.getWorkspaceLease(id),
      getBinding: (id) => this.getBinding(id),
      listWorkerInstancesByParent: (input) => this.instances.listWorkerInstancesByParent(input),
      loadWorkerTurnCard: (id) => this.workerTurns.loadWorkerTurnCard(id),
      saveWorkerTurnCard: (view) => this.workerTurns.saveWorkerTurnCard(view),
      loadTopicView: (id) => this.projections.loadTopicView(id),
      saveTopicView: (view) => this.projections.saveTopicView(view),
      loadRunCard: (id) => this.projections.loadRunCard(id),
      saveRunCard: (view) => this.projections.saveRunCard(view),
      reserveMainCard: (view, rootMessageId, card) => this.projections.reserveMainCardIntent(view, rootMessageId, card),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input)
    });
    this.turnControls = new SqliteTurnControlStore(this.context, {
      getBinding: (id) => this.bindings.getBinding(id),
      getAgentInstance: (id) => this.instances.getAgentInstance(id),
      countPendingPrompts: (id) => this.prompts.countPendingPrompts(id),
      countPendingInstanceTurns: (id, generation) => this.workerTurns.countPendingInstanceTurns(id, generation),
      insertRunCard: (view) => this.projections.insertRunCard(view),
      saveWorkerTurnCard: (view) => this.workerTurns.saveWorkerTurnCard(view),
      invalidateWorkerCardContexts: (view, reason) => this.cardContexts.invalidateWorkerCardContexts(view, reason),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input),
      getPrompt: (id) => this.prompts.getPrompt(id)
    });
    this.inboundProjects = new SqliteInboundProjectStore(this.context);
    this.paneOperations = new SqlitePaneOperationStore(this.context, {
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input)
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
    return this.instances.createAgentInstance(input);
  }

  createWorkerAgentInstance(input: CreateAgentInstanceInput & { role: "worker" }, maxWorkers: number): { outcome: "created"; instance: AgentInstance } | { outcome: "limit-reached" } | { outcome: "duplicate-name" } {
    return this.instances.createWorkerAgentInstance(input, maxWorkers);
  }

  getAgentInstance(id: string): AgentInstance | null {
    return this.instances.getAgentInstance(id);
  }

  loadWorkerMainView(workerId: string, workerSessionGeneration: number): WorkerMainView | null {
    return this.cardContexts.loadWorkerMainView(workerId, workerSessionGeneration);
  }

  saveWorkerMainView(view: WorkerMainView): WorkerMainView | null {
    return this.cardContexts.saveWorkerMainView(view);
  }

  reserveWorkerMainCard(view: WorkerMainView, rootMessageId: string, card: object): WorkerMainView | null {
    return this.cardContexts.reserveWorkerMainCard(view, rootMessageId, card);
  }

  invalidateCardContexts(targets: readonly (CardContextTarget & { reason: string })[]): CardContextInvalidation[] {
    return this.cardContexts.invalidateCardContexts(targets);
  }

  listPendingCardContextInvalidations(limit = 100): CardContextInvalidation[] {
    return this.cardContexts.listPendingCardContextInvalidations(limit);
  }

  markCardContextProjected(target: CardContextTarget, dependencyRevision: number): boolean {
    return this.cardContexts.markCardContextProjected(target, dependencyRevision);
  }

  projectCardContext(invalidation: CardContextInvalidation, renderers: { workerMain(view: WorkerMainView): object; workerTask(view: WorkerTurnCardView): object; primaryMain(view: TopicViewState): object; primaryAnswer(view: RunCardView): object }): "reserved" | "current" | "stale" {
    return this.cardContexts.projectCardContext(invalidation, renderers);
  }

  private loadCardContextInvalidation(target: CardContextTarget): CardContextInvalidation | null {
    return this.cardContexts.loadCardContextInvalidation(target);
  }

  loadWorkerMainProjectionSource(workerId: string, workerSessionGeneration: number): import("../domain/worker-main-selector.js").WorkerMainProjectionSource | null {
    return this.cardContexts.loadWorkerMainProjectionSource(workerId, workerSessionGeneration);
  }

  loadPrimaryWorkerSummaries(bindingId: string, bindingGeneration: number): import("../domain/card-context-summary.js").PrimaryWorkerSummary[] {
    return this.cardContexts.loadPrimaryWorkerSummaries(bindingId, bindingGeneration);
  }

  loadPrimaryWorkerActivity(promptId: string, bindingGeneration: number): import("../domain/card-context-summary.js").PrimaryWorkerActivitySummary[] {
    return this.cardContexts.loadPrimaryWorkerActivity(promptId, bindingGeneration);
  }

  findAgentInstanceByPane(paneId: string): AgentInstance | null {
    return this.instances.findAgentInstanceByPane(paneId);
  }

  listWorkerInstancesByParent(input: { bindingId: string; paneId: string }): AgentInstance[] {
    return this.instances.listWorkerInstancesByParent(input);
  }

  listAgentInstances(projectId: string): AgentInstance[] {
    return this.instances.listAgentInstances(projectId);
  }

  setPrimaryAgentInstance(projectId: string, instanceId: string): AgentInstance {
    return this.instances.setPrimaryAgentInstance(projectId, instanceId);
  }

  attachAgentInstanceRuntime(input: { instanceId: string; expectedGeneration: number; herdrWorkspaceId: string; paneId: string; nativeSessionId: string | null }): AgentInstance | null {
    return this.instances.attachAgentInstanceRuntime(input);
  }

  checkpointAgentInstance(input: { instanceId: string; expectedGeneration: number; checkpoint: InstanceProvisioningCheckpoint; observedState?: AgentInstance["observedState"]; pendingPaneId?: string | null; pendingWorkspaceId?: string | null; lastError?: string | null }): AgentInstance | null {
    return this.instances.checkpointAgentInstance(input);
  }

  updateAgentInstanceLifecycle(input: { instanceId: string; expectedGeneration: number; desiredState: AgentInstance["desiredState"]; observedState: AgentInstance["observedState"]; clearRuntime?: boolean; lastError?: string | null }): AgentInstance | null {
    return this.instances.updateAgentInstanceLifecycle(input);
  }

  updateAgentInstanceObservation(input: { instanceId: string; expectedGeneration: number; observedState: AgentInstance["observedState"]; lastError?: string | null }): AgentInstance | null {
    return this.instances.updateAgentInstanceObservation(input);
  }

  reserveAgentInstanceStop(instanceId: string, expectedGeneration: number): { outcome: "reserved"; instance: AgentInstance } | { outcome: "busy" | "stale" } {
    return this.instances.reserveAgentInstanceStop(instanceId, expectedGeneration);
  }

  finishAgentInstanceStop(instanceId: string, expectedGeneration: number): AgentInstance | null {
    return this.instances.finishAgentInstanceStop(instanceId, expectedGeneration);
  }

  rollbackAgentInstanceStop(instanceId: string, expectedGeneration: number, error: string): AgentInstance | null {
    return this.instances.rollbackAgentInstanceStop(instanceId, expectedGeneration, error);
  }

  detachAgentInstanceRuntime(input: { instanceId: string; expectedGeneration: number; reason: string }): AgentInstance | null {
    return this.instances.detachAgentInstanceRuntime(input);
  }

  terminateWorkerSession(input: { instanceId: string; expectedGeneration: number; reason: string }): { instance: AgentInstance; cancelledTurnIds: string[]; uncertainTurnIds: string[] } | null {
    return this.instances.terminateWorkerSession(input);
  }

  getWorkspaceLease(id: string): WorkspaceLease | null {
    return this.instances.getWorkspaceLease(id);
  }

  updateWorkspaceLease(input: { id: string; expectedGeneration: number; state: WorkspaceLeaseState; cwd?: string; branch?: string | null; baseCommit?: string }): WorkspaceLease | null {
    return this.instances.updateWorkspaceLease(input);
  }

  createInstanceRemovalPlan(plan: InstanceRemovalPlan): InstanceRemovalPlan {
    return this.instances.createInstanceRemovalPlan(plan);
  }

  getInstanceRemovalPlan(id: string): InstanceRemovalPlan | null {
    return this.instances.getInstanceRemovalPlan(id);
  }

  consumeInstanceRemovalPlan(input: { id: string; instanceId: string; instanceGeneration: number; workspaceGeneration: number; worktreeFingerprint: string | null }): InstanceRemovalPlan | null {
    return this.instances.consumeInstanceRemovalPlan(input);
  }

  removeAgentInstance(input: { instanceId: string; expectedGeneration: number; expectedWorkspaceGeneration: number }): boolean {
    return this.instances.removeAgentInstance(input);
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
    return this.instanceOperations.acceptInstanceOperation(input);
  }
  claimInstanceOperation(id: string, expectedGeneration: number): InstanceOperation | null {
    return this.instanceOperations.claimInstanceOperation(id, expectedGeneration);
  }
  updateInstanceOperation(input: { id: string; expectedGeneration: number; state: InstanceOperation["state"]; result: string }): InstanceOperation | null {
    return this.instanceOperations.updateInstanceOperation(input);
  }
  acceptTurnControlOperation(input: AcceptTurnControlOperationInput): { operation: TurnControlOperation; inserted: boolean } {
    return this.turnControls.accept(input);
  }
  getTurnControlOperation(id: string): TurnControlOperation | null {
    return this.turnControls.get(id);
  }
  getTurnControlOperationByIdempotencyKey(idempotencyKey: string): TurnControlOperation | null {
    return this.turnControls.getByIdempotencyKey(idempotencyKey);
  }
  getPrioritySteer(owner: import("../domain/turn-control.js").TurnControlOwner, idempotencyKey: string): { logicalTurnId: string; text: string } | null {
    return this.turnControls.getPrioritySteer(owner, idempotencyKey);
  }
  claimTurnControlOperation(id: string): TurnControlOperation | null {
    return this.turnControls.claim(id);
  }
  rejectAcceptedTurnControlOperation(input: { id: string; result: Record<string, unknown>; card?: object }): TurnControlOperation | null {
    return this.turnControls.rejectAccepted(input);
  }
  finishTurnControlOperation(input: { id: string; state: Extract<TurnControlState, "delivered" | "rejected" | "uncertain">; result: Record<string, unknown>; card?: object }): TurnControlOperation | null {
    return this.turnControls.finish(input);
  }
  convertTurnControlToPrimaryPriority(input: { operationId: string; prompt: Parameters<BindingStorePort["acceptPrompt"]>[0]["prompt"]; view: RunCardView; rootMessageId: string; answerCard: object; maxQueueDepth: number; expectedBindingGeneration: number; result: Record<string, unknown>; card?: object }): { operation: TurnControlOperation; prompt: PromptJob } | null {
    return this.turnControls.convertToPrimaryPriority(input);
  }
  convertTurnControlToWorkerPriority(input: { operationId: string; turn: Omit<AcceptInstanceTurnWithCardInput, "view" | "card"> & { view?: AcceptInstanceTurnWithCardInput["view"]; card?: object }; maxQueueDepth: number; result: Record<string, unknown>; card?: object }): { operation: TurnControlOperation; logicalTurnId: string } | null {
    return this.turnControls.convertToWorkerPriority(input);
  }
  recoverTurnControlOperations(renderResult?: (operation: TurnControlOperation) => object): { accepted: TurnControlOperation[]; uncertain: TurnControlOperation[] } {
    return this.turnControls.recover(renderResult);
  }
  getConversationTarget(chatId: string): { projectId: string; target: import("../domain/agent-instance.js").InstanceTarget } | null {
    return this.instanceOperations.getConversationTarget(chatId);
  }
  setConversationTarget(input: { chatId: string; projectId: string; target: import("../domain/agent-instance.js").InstanceTarget }): void {
    this.instanceOperations.setConversationTarget(input);
  }
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
    return this.inboundProjects.recordInboundMessage(message);
  }

  claimNextInboundMessage(): IncomingLarkMessage | null {
    return this.inboundProjects.claimNextInboundMessage();
  }

  markInboundMessageAccepted(eventId: string): void {
    this.inboundProjects.markInboundMessageAccepted(eventId);
  }

  releaseInboundMessage(eventId: string, error: string): void {
    this.inboundProjects.releaseInboundMessage(eventId, error);
  }

  recoverProcessingInboundMessages(): number {
    return this.inboundProjects.recoverProcessingInboundMessages();
  }

  isBridgeMessage(messageId: string): boolean {
    return this.inboundProjects.isBridgeMessage(messageId);
  }

  recordBridgeMessage(messageId: string): void {
    this.inboundProjects.recordBridgeMessage(messageId);
  }

  createPendingBinding(input: { id: string; projectId?: string | null; workspaceId: string; chatId: string; topicId: string | null; rootMessageId: string | null; title: string; creatorOpenId?: string | null }): Binding {
    return this.bindings.createPendingBinding(input);
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
    return this.context.transaction(() => {
      const interaction = this.getCardInteraction(input.interactionId);
      if (!interaction) {return { outcome: "missing", prompt: null }; }
      if (interaction.actorOpenId !== input.actorOpenId) {return { outcome: "unauthorized", prompt: null }; }
      const source = this.database.prepare(`SELECT p.*, c.steering_origin AS card_steering_origin, c.steering_failure_kind FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id WHERE p.id = ?`).get(input.sourcePromptId) as (PromptRow & { card_steering_origin: string | null; steering_failure_kind: string | null }) | undefined;
      if (source && source.actor_open_id !== input.actorOpenId) {return { outcome: "unauthorized", prompt: null }; }
      const existing = this.database.prepare("SELECT * FROM prompt_jobs WHERE source_prompt_id = ?").get(input.sourcePromptId) as PromptRow | undefined;
      if (interaction.state === "consumed" || existing) {return { outcome: "duplicate", prompt: existing ? mapPrompt(existing) : null }; }
      const binding = this.getBinding(input.bindingId);
      const valid = interaction.bindingId === input.bindingId && interaction.bindingGeneration === input.bindingGeneration
        && interaction.actionKind === "enqueue_failed_steering" && interaction.targetPromptId === input.sourcePromptId
        && binding?.generation === input.bindingGeneration && binding.state === "active" && binding.lifecycle === "active" && binding.attachment === "attached" && binding.rootMessageId === input.rootMessageId
        && source?.binding_id === input.bindingId && source.state === "failed" && source.dispatch_kind === "steering"
        && source.steering_origin === "automatic" && source.card_steering_origin === "automatic" && source.steering_failure_kind === "rejected";
      if (!valid) {return { outcome: "stale", prompt: null }; }
      const queuePosition = Number((this.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' AND dispatch_kind = 'turn'").get(input.bindingId) as { count: number }).count) + 1;
      const view: RunCardView = { ...input.view, steeringOrigin: null, steeringFailureKind: null, queuePosition, createdAt: input.now, updatedAt: input.now, activityAt: input.now };
      this.database.prepare(`INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, state, observation_state, attempt_count, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'turn', NULL, NULL, ?, 0, 'queued', 'not_started', 0, NULL, ?, ?)`)
        .run(input.newPromptId, input.bindingId, input.newLarkMessageId, input.actorOpenId, source.body, input.sourcePromptId, input.now, input.now);
      this.insertRunCard(view);
      this.database.prepare(`INSERT INTO outbound_replies(id, idempotency_key, binding_id, prompt_id, view_version, card_role, root_message_id, kind, payload, lane_key, state, attempt_count, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'answer', ?, 'stream_card_create', ?, ?, 'pending', 0, ?, ?, ?)`)
        .run(randomUUID(), `run-card:create:${input.newPromptId}:answer`, input.bindingId, input.newPromptId, view.viewVersion, input.rootMessageId, JSON.stringify(input.answerCardFor(view)), `answer:${input.newPromptId}`, input.now, input.now, input.now);
      this.database.prepare("UPDATE card_interactions SET state = 'consumed', result_code = 'converted', consumed_at = ? WHERE id = ? AND state = 'active'").run(input.now, input.interactionId);
      const prompt = this.requirePrompt(input.newPromptId);

      return { outcome: "converted", prompt };
    });
  }

  createResetCandidate(input: { oldBindingId: string; newBindingId: string; title: string; actorOpenId: string; resetMessageId: string }): { previous: Binding; replacement: Binding; created: boolean } {
    return this.bindings.createResetCandidate(input);
  }

  cutoverResetCandidate(input: { oldBindingId: string; newBindingId: string; cleanupOperationId: string; actorOpenId: string; expectedCwd: string }): { previous: Binding; replacement: Binding; cleanup: RetiredPaneCleanupOperation; cancelledPromptIds: string[] } {
    return this.bindings.cutoverResetCandidate(input);
  }

  listRetiredPaneCleanupOperations(states: readonly RetiredPaneCleanupState[] = ["pending", "waiting_busy", "executing"]): RetiredPaneCleanupOperation[] {
    return this.bindings.listRetiredPaneCleanupOperations(states);
  }

  claimRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null {
    return this.bindings.claimRetiredPaneCleanup(id);
  }

  updateRetiredPaneCleanup(id: string, state: RetiredPaneCleanupState, detail: string | null = null): RetiredPaneCleanupOperation | null {
    return this.bindings.updateRetiredPaneCleanup(id, state, detail);
  }

  completeRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null {
    return this.bindings.completeRetiredPaneCleanup(id);
  }

  createProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; initialPromptText?: string | null; expiresAt: string; card: object }): ProjectSelection {
    return this.inboundProjects.createProjectSelection(input);
  }

  getProjectSelection(id: string): ProjectSelection | null {
    return this.inboundProjects.getProjectSelection(id);
  }

  claimProjectSelection(input: { selectionId: string; projectId: string; messageId: string; chatId: string; actorOpenId: string; allowedProjectIds: string[] }): ProjectSelectionClaim {
    return this.inboundProjects.claimProjectSelection(input);
  }

  recoverProcessingProjectSelections(): number {
    return this.inboundProjects.recoverProcessingProjectSelections();
  }

  listProcessingProjectSelections(): ProjectSelection[] {
    return this.inboundProjects.listProcessingProjectSelections();
  }

  listCompletedProjectSelectionsWithInitialPrompt(): ProjectSelection[] {
    return this.inboundProjects.listCompletedProjectSelectionsWithInitialPrompt();
  }

  linkProjectSelectionBinding(id: string, bindingId: string): ProjectSelection {
    return this.inboundProjects.linkProjectSelectionBinding(id, bindingId);
  }

  pauseProjectSelection(id: string, error: string): ProjectSelection {
    return this.inboundProjects.pauseProjectSelection(id, error);
  }

  completeProjectSelection(id: string, bindingId: string): ProjectSelection {
    return this.inboundProjects.completeProjectSelection(id, bindingId);
  }

  failProjectSelection(id: string, error: string): ProjectSelection {
    return this.inboundProjects.failProjectSelection(id, error);
  }

  createPaneCloseRequest(input: { id: string; bindingId: string; paneId: string; actorOpenId: string; codeHash: string; expiresAt: string }): void {
    this.paneOperations.createPaneCloseRequest(input);
  }

  createAutomaticPaneCloseOperation(input: { id: string; bindingId: string; paneId: string; now: string }): void {
    this.paneOperations.createAutomaticPaneCloseOperation(input);
  }

  consumePaneCloseRequest(input: { bindingId: string; paneId: string; actorOpenId: string; codeHash: string; now: string }):
    | { outcome: "consumed"; operationId: string; paneId: string }
    | { outcome: "invalid" | "unauthorized" | "expired" | "stale" } {
    return this.paneOperations.consumePaneCloseRequest(input);
  }

  finishPaneCloseRequest(operationId: string, state: "succeeded" | "rejected" | "uncertain", detail: string | undefined = undefined): void {
    this.paneOperations.finishPaneCloseRequest(operationId, state, detail);
  }

  beginWorkerPaneCloseCascade(input: { operationId: string; bindingId: string; paneId: string; reason: string }): Array<{ workerId: string; paneId: string }> {
    return this.paneOperations.beginWorkerPaneCloseCascade(input);
  }

  listUnresolvedWorkerPaneCloseSteps(): Array<{ operationId: string; bindingId: string; parentPaneId: string; workerId: string; paneId: string; state: "executing" | "uncertain" }> {
    return this.paneOperations.listUnresolvedWorkerPaneCloseSteps();
  }

  finishWorkerPaneCloseStep(input: { operationId: string; workerId: string; paneId: string; state: "succeeded" | "uncertain"; detail?: string }): void {
    this.paneOperations.finishWorkerPaneCloseStep(input);
  }

  listUnresolvedPaneCloseOperations(): PaneCloseOperation[] {
    return this.paneOperations.listUnresolvedPaneCloseOperations();
  }

  /** Legacy test/setup escape hatch; workflows must use explicit ports below. */
  updateBinding(id: string, patch: Partial<Binding>): Binding { return this.bindings.updateBinding(id, patch); }

  private persistBindingPatch(id: string, patch: Partial<Binding>): Binding {
    return this.bindings.persistBindingPatch(id, patch);
  }

  updateBindingMetadata(id: string, patch: BindingMetadataPatch): Binding { return this.bindings.updateBindingMetadata(id, patch); }

  replaceProvisioningPane(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: HerdrPane }): Binding {
    return this.bindings.replaceProvisioningPane(input);
  }

  transitionBinding(id: string, transition: SessionTransition): Binding {
    return this.bindings.transitionBinding(id, transition);
  }

  applyRuntimeObservation(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: HerdrPane }): RuntimeObservationApplication {
    return this.bindings.applyRuntimeObservation(input);
  }

  reconcileBindingTitleWithProjection(input: BindingTitleProjectionInput): BindingTitleProjectionResult {
    return this.bindingProjections.reconcileBindingTitleWithProjection(input);
  }

  degradeBindingWithProjection(input: RuntimeDegradationInput): RuntimeDegradationResult {
    return this.bindingProjections.degradeBindingWithProjection(input);
  }

  orphanBindingWithProjection(input: OrphanBindingProjectionInput): OrphanBindingProjectionResult {
    return this.bindingProjections.orphanBindingWithProjection(input);
  }

  recoverOrphanBindingWithProjection(input: RecoverOrphanBindingProjectionInput): RecoverOrphanBindingProjectionResult {
    return this.bindingProjections.recoverOrphanBindingWithProjection(input);
  }

  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: BridgeEvent; view: TopicViewState; messageId: string; card: object }): Binding {
    return this.bindingProjections.transitionBindingWithOutbox(input);
  }

  attachBindingPane(id: string, pane: import("../domain/types.js").HerdrPane, replacement: boolean): Binding {
    return this.bindings.attachBindingPane(id, pane, replacement);
  }

  findBindingByTopic(topicId: string): Binding | null {
    return this.bindings.findBindingByTopic(topicId);
  }

  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null {
    return this.bindings.findBindingByLarkScope(topicId, rootMessageId);
  }

  findBindingByPane(paneId: string): Binding | null {
    return this.bindings.findBindingByPane(paneId);
  }

  getBinding(id: string): Binding | null {
    return this.bindings.getBinding(id);
  }

  listBindings(): Binding[] {
    return this.bindings.listBindings();
  }

  listBindingsByState(state: Binding["state"]): Binding[] {
    return this.bindings.listBindingsByState(state);
  }

  listSessions(chatId: string): SessionSummary[] {
    return this.bindings.listSessions(chatId);
  }

  listFailures(chatId: string): FailureSummary[] {
    return this.bindings.listFailures(chatId);
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
    return this.context.transaction(() => {
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

      return { projected, stalePromptIds, outboxReserved };
    });
  }

  acceptPaneControlOperation(input: { id: string; idempotencyKey: string; bindingId: string; paneId: string; terminalId: string | null; bindingGeneration: number; kind: PaneControlOperationKind; payload?: string | null; parentPromptId?: string | null; actorOpenId: string; sourceMessageId: string }): { operation: PaneControlOperation; inserted: boolean } {
    return this.paneOperations.acceptPaneControlOperation(input);
  }

  claimNextPaneControlOperation(bindingId?: string): PaneControlOperation | null {
    return this.paneOperations.claimNextPaneControlOperation(bindingId);
  }

  claimPaneControlOperation(id: string): PaneControlOperation | null {
    return this.paneOperations.claimPaneControlOperation(id);
  }

  claimAppliedPaneControlOperation(id: string): PaneControlOperation | null {
    return this.paneOperations.claimAppliedPaneControlOperation(id);
  }

  rejectAppliedPaneControlOperation(id: string, detail: string): PaneControlOperation | null {
    return this.paneOperations.rejectAppliedPaneControlOperation(id, detail);
  }

  getPaneControlOperation(id: string): PaneControlOperation | null {
    return this.paneOperations.getPaneControlOperation(id);
  }

  listRecoverablePaneControlOperations(): PaneControlOperation[] {
    return this.paneOperations.listRecoverablePaneControlOperations();
  }

  finishPaneControlOperation(id: string, state: PaneControlOutcome, detail: string | null = null): boolean {
    return this.paneOperations.finishPaneControlOperation(id, state, detail);
  }

  finishPaneControlWithResult(input: {
    operationId: string;
    state: PaneControlOutcome;
    detail?: string | null;
    result: { kind: "card_reply" | "card_update"; targetMessageId: string; idempotencyKey: string; targetRole?: OutboundTargetRole | null; card: object };
  }): boolean {
    return this.paneOperations.finishPaneControlWithResult(input);
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
    return this.context.transaction(() => {
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

      return Number(result.changes);
    });
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
    const binding = this.bindings.getBinding(id);
    if (!binding) throw new Error(`Binding not found: ${id}`);
    return binding;
  }

  getPrompt(id: string): PromptJob | null {
    return this.prompts.getPrompt(id);
  }

  getModelPreference(bindingId: string): ModelPreference | null {
    const row = this.database.prepare("SELECT * FROM binding_model_preferences WHERE binding_id = ?").get(bindingId) as ModelPreferenceRow | undefined;
    return row ? mapModelPreference(row) : null;
  }

  acceptModelPreference(input: { bindingId: string; bindingGeneration: number; model: string }): { outcome: "accepted" | "busy" | "stale"; preference: ModelPreference | null } {
    return this.context.transaction(() => {
      const binding = this.database.prepare("SELECT generation FROM bindings WHERE id = ?").get(input.bindingId) as { generation: number } | undefined;
      const existing = this.getModelPreference(input.bindingId);
      const decision = acceptModelSelection(existing, { ...input, currentBindingGeneration: Number(binding?.generation ?? -1), updatedAt: now() });
      if (decision.outcome !== "accepted") {

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

      return { outcome: "accepted", preference };
    });
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

function matchesExpectedRuntimeTurn(turn: InstanceTurn, input: { expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string }): boolean {
  return (input.expectedRuntimeTurnId === undefined || turn.runtimeTurnId === input.expectedRuntimeTurnId)
    && (input.expectedRuntimeTurnStartedAt === undefined || turn.runtimeTurnStartedAt === input.expectedRuntimeTurnStartedAt);
}
function parseJsonRecord(payload: string): Record<string, unknown> {
  try { const value = JSON.parse(payload) as unknown; return isRecord(value) ? value : {}; } catch { return {}; }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isTraexCompatibleNativeAgent(pane: HerdrPane): boolean {
  return pane.agentKind !== null && pane.agentKind !== undefined && TRAEX_COMPATIBLE_AGENT_KINDS.has(pane.agentKind);
}
