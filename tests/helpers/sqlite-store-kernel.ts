import type { OutboxTestDriver } from "./outbox-test-driver.js";
import { DatabaseSync } from "node:sqlite";
import type { AcceptInstanceTurnWithCardInput, TransitionInstanceTurnWithProjectionInput, TransitionInstanceTurnWithProjectionResult } from "../../src/domain/ports.js";
import type { AcceptPromptInput } from "../../src/domain/ports/prompt.js";
import type { BindingProvisioningStore, RuntimeReconciliationStore } from "../../src/domain/ports/binding.js";
import type { CurrentRuntimeIdentityClaim, RuntimeIdentityClaim, RuntimeIdentityOwner } from "../../src/domain/runtime-identity-claim.js";
import type { AcceptedPromptSourceIdentity } from "../../src/domain/ports/prompt-acceptance.js";
import type { AdoptExternalTurnInput } from "../../src/domain/ports/workflow.js";
import type { TurnControlStore } from "../../src/domain/ports/turn-control.js";
import type { AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, AnswerTimelinePageCheckpoint, Binding, BindingMetadataPatch, BindingTitleProjectionInput, BindingTitleProjectionResult, CardInteraction, CardInteractionActionKind, DeadLetterActionOutcome, DurablePromptWorkScan, ExternalTurnAdoption, FailureSummary, HerdrPane, MainCardReservationOutcome, OrphanBindingProjectionInput, OrphanBindingProjectionResult, OutboundTargetRole, OutboundWorkClass, PaneCloseOperation, PaneControlOperation, PaneControlOperationKind, ProjectSelection, ProjectSelectionClaim, PromptJob, PromptState, RecoverOrphanBindingProjectionInput, RecoverOrphanBindingProjectionResult, RetiredPaneCleanupOperation, RetiredPaneCleanupState, RuntimeDegradationInput, RuntimeDegradationResult, RuntimeObservationApplication, SessionOperation, SessionOperationKind, SessionSummary, StalePromptClaim, TranscriptTurnClaimOutcome } from "../../src/domain/types.js";
import { sessionOperationRejection } from "../../src/domain/session-operation-policy.js";
import type { AnswerTimelineItem } from "../../src/domain/answer-timeline.js";
import type { AnswerTimelineCursor } from "../../src/domain/delivery.js";
import type { ProjectionGapSummary } from "../../src/domain/projection-gap.js";
import type { TopicViewState } from "../../src/domain/topic-view.js";
import type { RunCardView } from "../../src/domain/run-card-view.js";
import type { BridgeEvent } from "../../src/domain/events.js";
import type { CoreEventProjectionOwner, CoreEventProjectionResult, CoreEventProjectionSettlement } from "../../src/domain/core-event-inbox.js";
import type { SessionTransition } from "../../src/domain/pane-thread-lifecycle.js";
import type { PaneControlOutcome } from "../../src/domain/pane-control-lifecycle.js";
import type { ModelDispatchEvidenceCommand, ModelPreference } from "../../src/domain/model-selection.js";
import type { AgentInstance } from "../../src/domain/agent-instance.js";
import type { AnswerSegment, AnswerSegmentBoundary } from "../../src/domain/answer-segment.js";
import type { ControlActor } from "../../src/domain/commands.js";
import type { InstanceEvent, InstanceEventKind, InstanceTurn, InstanceTurnState, InstanceTurnSummary } from "../../src/domain/instance-turn.js";
import type { WorkerTurnCardChange, WorkerTurnCardPage, WorkerTurnCardView } from "../../src/domain/worker-turn-card-view.js";
import type { WorkerMainView } from "../../src/domain/worker-main-view.js";
import type { CardContextInvalidation, CardContextTarget } from "../../src/domain/card-context-invalidation.js";
import type { AcceptTurnControlOperationInput, TurnControlOperation, TurnControlState } from "../../src/domain/turn-control.js";
import { SqliteCapabilityGraph } from "../../src/store/sqlite/capability-graph.js";
import type { SqliteMigrations } from "../../src/store/sqlite/migrations.js";
import type { SqliteOperationsStore } from "../../src/store/sqlite/operations-store.js";
import type { SqliteSessionOperationStore } from "../../src/store/sqlite/session-operation-store.js";
import type { SqliteWorkerTurnStore } from "../../src/store/sqlite/worker-turn-store.js";
import type { SqliteProjectionStore } from "../../src/store/sqlite/projection-store.js";
import type { SqlitePromptStore } from "../../src/store/sqlite/prompt-store.js";
import type { SqlitePromptRecoveryStore } from "../../src/store/sqlite/prompt-recovery-store.js";
import type { SqlitePromptAcceptanceStore } from "../../src/store/sqlite/prompt-acceptance-store.js";
import type { SqliteExternalTurnAdoptionStore } from "../../src/store/sqlite/external-turn-adoption-store.js";
import type { SqlitePromptDispatchStore } from "../../src/store/sqlite/prompt-dispatch-store.js";
import type { SqliteOutboxStore } from "../../src/store/sqlite/outbox-store.js";
import type { SqlitePreparedDeliveryStore } from "../../src/store/sqlite/prepared-delivery-store.js";
import type { SqliteInstanceStore } from "../../src/store/sqlite/instance-store.js";
import type { SqliteCardContextStore } from "../../src/store/sqlite/card-context-store.js";
import type { SqliteInboundProjectStore } from "../../src/store/sqlite/inbound-project-store.js";
import type { SqlitePaneOperationStore } from "../../src/store/sqlite/pane-operation-store.js";
import type { SqliteBindingLifecycleStore } from "../../src/store/sqlite/binding-store.js";
import type { SqliteBindingProjectionStore } from "../../src/store/sqlite/binding-projection-store.js";
import type { SqliteTurnControlStore } from "../../src/store/sqlite/turn-control-store.js";
import { applicationPresentation, primaryPresentation, workerPresentation } from "./presentation.js";
import { connectPreparedDeliveryProducers } from "../../src/composition/create-outbound-runtime.js";
import type { GatewayDeliveryIntent } from "../../src/gateways/contract/plugin.js";
export class SqliteStoreKernel implements TurnControlStore {
  readonly database: DatabaseSync;
  private readonly graph: SqliteCapabilityGraph;
  private readonly migrations: SqliteMigrations;
  private readonly operations: SqliteOperationsStore;
  private readonly sessionOperations: SqliteSessionOperationStore;
  private readonly workerTurns: SqliteWorkerTurnStore;
  private readonly projections: SqliteProjectionStore;
  private readonly prompts: SqlitePromptStore;
  private readonly promptRecovery: SqlitePromptRecoveryStore;
  private readonly promptAcceptance: SqlitePromptAcceptanceStore;
  private readonly externalTurnAdoption: SqliteExternalTurnAdoptionStore;
  private readonly promptDispatch: SqlitePromptDispatchStore;
  private readonly outbox: SqliteOutboxStore;
  readonly preparedDeliveries: SqlitePreparedDeliveryStore;
  private readonly instances: SqliteInstanceStore;
  private readonly cardContexts: SqliteCardContextStore;
  private readonly inboundProjects: SqliteInboundProjectStore;
  private readonly paneOperations: SqlitePaneOperationStore;
  private readonly bindings: SqliteBindingLifecycleStore;
  private readonly bindingProjections: SqliteBindingProjectionStore;
  private readonly turnControls: SqliteTurnControlStore;

  constructor(path: string) {
    this.graph = new SqliteCapabilityGraph(path);
    this.graph.conversationSegments.setInitialTurnCardRenderer(applicationPresentation.turnCard);
    this.database = this.graph.database;
    this.migrations = this.graph.migrations;
    this.bindings = this.graph.bindings;
    this.operations = this.graph.operations;
    this.sessionOperations = this.graph.sessionOperations;
    this.projections = this.graph.projections;
    this.outbox = this.graph.outbox;
    this.preparedDeliveries = this.graph.preparedDeliveries;
    this.bindingProjections = this.graph.bindingProjections;
    this.prompts = this.graph.prompts;
    this.promptRecovery = this.graph.promptRecovery;
    this.promptAcceptance = this.graph.promptAcceptance;
    this.externalTurnAdoption = this.graph.externalTurnAdoption;
    this.promptDispatch = this.graph.promptDispatch;
    this.workerTurns = this.graph.workerTurns;
    this.instances = this.graph.instances;
    this.cardContexts = this.graph.cardContexts;
    this.turnControls = this.graph.turnControls;
    this.inboundProjects = this.graph.inboundProjects;
    this.paneOperations = this.graph.paneOperations;
    connectPreparedDeliveryProducers(this.graph.capabilityModules().outbox, this.graph, {
      prepare: (intent: GatewayDeliveryIntent) => ({
        protocolVersion: 1,
        gatewayId: "feishu:primary",
        profileId: "feishu-cardkit-v1",
        rendererRevision: 1,
        operation: intent.kind,
        intent
      })
    }, { enqueuePreparedDelivery() {} });
  }

  /** Concrete capabilities that already satisfy a complete consumer port. */
  capabilityModules() {
    return this.graph.capabilityModules();
  }

  close(): void { this.graph.context.close(); }

  declare claimOutboundReply: OutboxTestDriver["claimOutboundReply"];
  declare markOutboundReplyDelivered: OutboxTestDriver["markOutboundReplyDelivered"];
  declare checkpointOutboundReplyCard: OutboxTestDriver["checkpointOutboundReplyCard"];
  declare markOutboundReplyFailedWithQuarantine: OutboxTestDriver["markOutboundReplyFailedWithQuarantine"];
  declare rejectUnclaimedOutboundReply: OutboxTestDriver["rejectUnclaimedOutboundReply"];

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

  loadWorkerMainProjectionSource(workerId: string, workerSessionGeneration: number): import("../domain/worker-main-selector.js").WorkerMainProjectionSource | null {
    return this.cardContexts.loadWorkerMainProjectionSource(workerId, workerSessionGeneration);
  }

  loadPrimaryWorkerSummaries(bindingId: string, bindingGeneration: number): import("../domain/card-context-summary.js").PrimaryWorkerSummary[] {
    return this.cardContexts.loadPrimaryWorkerSummaries(bindingId, bindingGeneration);
  }

  loadPrimaryWorkerActivity(promptId: string, bindingGeneration: number): import("../domain/card-context-summary.js").PrimaryWorkerActivitySummary[] {
    return this.cardContexts.loadPrimaryWorkerActivity(promptId, bindingGeneration);
  }

  acceptInstanceTurn(input: { id: string; idempotencyKey: string; actor: ControlActor; projectId: string; instanceId: string; instanceGeneration: number; kind: InstanceTurn["kind"]; priority?: InstanceTurn["priority"]; text: string; maxQueueDepth?: number }) { return this.workerTurns.acceptInstanceTurn(input); }
  acceptInstanceTurnWithCard(input: AcceptInstanceTurnWithCardInput & { maxQueueDepth?: number }) { return this.workerTurns.acceptInstanceTurnWithCard(input); }
  acceptWorkerCompletionAction(input: import("../../src/domain/ports/instance.js").WorkerCompletionActionAcceptanceInput) { return this.workerTurns.acceptWorkerCompletionAction(input); }
  ignoreWorkerCompletionAction(input: Parameters<SqliteWorkerTurnStore["ignoreWorkerCompletionAction"]>[0]) { return this.workerTurns.ignoreWorkerCompletionAction(input); }
  resolveWorkerCompletionChoice(input: Parameters<SqliteWorkerTurnStore["resolveWorkerCompletionChoice"]>[0]) { return this.workerTurns.resolveWorkerCompletionChoice(input); }
  getInstanceTurn(id: string): InstanceTurn | null { return this.workerTurns.getInstanceTurn(id); }
  claimInstanceTurnTranscript(input: { turnId: string; expectedGeneration: number; runtimeTurnId: string; startedAt: string }): InstanceTurn | null { return this.workerTurns.claimInstanceTurnTranscript(input); }
  loadWorkerTurnCard(turnId: string): WorkerTurnCardView | null { return this.workerTurns.loadWorkerTurnCard(turnId); }
  findWorkerTurnByCardMessage(messageId: string): { turn: InstanceTurn; view: WorkerTurnCardView } | null { return this.workerTurns.findWorkerTurnByCardMessage(messageId); }
  listWorkerTurnCardPages(turnId: string): WorkerTurnCardPage[] { return this.workerTurns.listWorkerTurnCardPages(turnId); }
  prepareWorkerCompletionActionSet(input: { turnId: string; pageIndex: number; cardId: string; messageId: string }) { return this.workerTurns.prepareWorkerCompletionActionSet(input); }
  listAnswerSegments(aggregateKind: "primary-run" | "worker-turn", aggregateId: string): AnswerSegment[] {
    if (aggregateKind === "primary-run") return this.projections.listAnswerSegments(aggregateKind, aggregateId);
    return this.workerTurns.listAnswerSegments(aggregateKind, aggregateId);
  }
  getWorkerTurnCardDeliveryFacts(turnId: string, pageIndex: number): AnswerPageDeliveryFacts { return this.workerTurns.getWorkerTurnCardDeliveryFacts(turnId, pageIndex); }
  getWorkerAnswerTimelinePage(turnId: string, pageIndex: number): AnswerTimelinePageCheckpoint { return this.workerTurns.getWorkerAnswerTimelinePage(turnId, pageIndex); }
  listFrozenWorkerAnswerTimelineItems(turnId: string, beforePageIndex: number) { return this.workerTurns.listFrozenWorkerAnswerTimelineItems(turnId, beforePageIndex); }
  reserveWorkerAnswerTimelineCard(input: { turnId: string; pageIndex: number; messageId: string; card: object; cursor: AnswerTimelineCursor | null; items: readonly AnswerTimelineItem[] }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerAnswerTimelineCard(input); }
  reserveHumanMessageAnswerSegments(input: {
    aggregateKind: "primary-run" | "worker-turn";
    aggregateId: string;
    expectedGeneration: number;
    boundaries: readonly AnswerSegmentBoundary[];
    previousFinalizedCard: object;
    nextCards: readonly object[];
    rootMessageId: string;
    workClass?: OutboundWorkClass;
  }): { created: number; replyIds: string[] } {
    if (input.aggregateKind === "primary-run") return this.projections.reserveHumanMessageAnswerSegments(input);
    return this.workerTurns.reserveHumanMessageAnswerSegments(input);
  }
  reserveWorkerTurnContent(input: { turnId: string; pageIndex: number; cardId: string; elementId: string; content: string; sourceEnd: number }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnContent(input); }
  listActionableWorkerTurnCardIds(): string[] { return this.workerTurns.listActionableWorkerTurnCardIds(); }
  listRecoverableWorkerTurnIds(limit: number): string[] { return this.workerTurns.listRecoverableWorkerTurnIds(limit); }
  listRecoverableWorkerTurnIdsForBinding(bindingId: string, limit: number): string[] { return this.workerTurns.listRecoverableWorkerTurnIdsForBinding(bindingId, limit); }
  reserveWorkerTurnProgress(input: { turnId: string; pageIndex: number; cardId: string; elementId: string; content: string }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnProgress(input); }
  reserveWorkerTurnFinish(input: { turnId: string; pageIndex: number; cardId: string; summary: string }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnFinish(input); }
  reserveWorkerTurnCardHydration(input: { turnId: string; pageIndex: number; cardId: string | null; messageId: string; card: object }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnCardHydration(input); }
  reserveWorkerTurnContinuation(input: { turnId: string; pageIndex: number; cardId: string; summary: string; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnContinuation(input); }
  reserveWorkerTurnRecovery(input: { turnId: string; previousPageIndex: number; nextPageIndex: number; pageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome { return this.workerTurns.reserveWorkerTurnRecovery(input); }
  applyInstanceTurnProjection(input: { turnId: string; expectedGeneration: number; expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string; change: WorkerTurnCardChange; render(view: WorkerTurnCardView): object }): WorkerTurnCardView | null { return this.workerTurns.applyInstanceTurnProjection(input); }
  transitionInstanceTurnWithProjection(input: TransitionInstanceTurnWithProjectionInput): TransitionInstanceTurnWithProjectionResult | null { return this.workerTurns.transitionInstanceTurnWithProjection(input); }
  listInstanceTurns(instanceId: string, options: { limit?: number; after?: { createdAt: string; id: string } } = {}): { items: InstanceTurn[]; nextCursor: { createdAt: string; id: string } | null } { return this.workerTurns.listInstanceTurns(instanceId, options); }
  listRecentInstanceTurnSummaries(instanceId: string, requestedLimit = 5): InstanceTurnSummary[] { return this.workerTurns.listRecentInstanceTurnSummaries(instanceId, requestedLimit); }
  getActiveInstanceTurn(instanceId: string, expectedGeneration: number): InstanceTurn | null { return this.workerTurns.getActiveInstanceTurn(instanceId, expectedGeneration); }
  hasBindingPrimaryToolCapability(bindingId: string, expectedGeneration: number): boolean {
    return this.bindings.hasPrimaryToolCapability(bindingId, expectedGeneration);
  }
  revokeBindingPrimaryToolCapability(bindingId: string, expectedGeneration: number): boolean {
    return this.bindings.revokePrimaryToolCapability(bindingId, expectedGeneration);
  }
  getActiveOrdinaryPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    return this.promptDispatch.getActiveOrdinaryPrompt(bindingId, expectedGeneration);
  }

  getActiveBridgePrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    return this.promptDispatch.getActiveBridgePrompt(bindingId, expectedGeneration);
  }

  getActiveExternalPrompt(bindingId: string, expectedGeneration: number): PromptJob | null {
    return this.externalTurnAdoption.getActiveExternalPrompt(bindingId, expectedGeneration);
  }

  repairProjectedExternalTurn(input: Parameters<SqlitePromptDispatchStore["repairProjectedExternalTurn"]>[0]) {
    return this.promptDispatch.repairProjectedExternalTurn(input);
  }

  isExternalTurnRecoveryDue(input: Parameters<SqliteExternalTurnAdoptionStore["isExternalTurnRecoveryDue"]>[0]): boolean {
    return this.externalTurnAdoption.isExternalTurnRecoveryDue(input);
  }

  deferExternalTurnRecovery(input: Parameters<SqliteExternalTurnAdoptionStore["deferExternalTurnRecovery"]>[0]) {
    return this.externalTurnAdoption.deferExternalTurnRecovery(input);
  }

  correctExternalTurnStartedAt(input: Parameters<SqliteExternalTurnAdoptionStore["correctExternalTurnStartedAt"]>[0]): { promptId: string } | null {
    return this.externalTurnAdoption.correctExternalTurnStartedAt(input);
  }

  clearExternalTurnRecovery(promptId: string): void {
    this.externalTurnAdoption.clearExternalTurnRecovery(promptId);
  }

  claimNextInstanceTurn(instanceId: string, expectedGeneration: number): InstanceTurn | null { return this.workerTurns.claimNextInstanceTurn(instanceId, expectedGeneration); }
  recoverInterruptedInstanceTurns(): { requeuedTurnIds: string[]; cancelledLegacyTurnIds: string[]; observableTurns: InstanceTurn[] } { return this.workerTurns.recoverInterruptedInstanceTurns(); }
  listObservableInstanceTurns(): InstanceTurn[] { return this.workerTurns.listObservableInstanceTurns(); }
  listObservableInstanceTurnsByPaneIds(paneIds: readonly string[]): InstanceTurn[] { return this.workerTurns.listObservableInstanceTurnsByPaneIds(paneIds); }
  getInstanceTurnDiagnostics(): { queuedTurns: number; activeTurns: number; uncertainTurns: number } { return this.workerTurns.getInstanceTurnDiagnostics(); }
  updateInstanceTurn(input: { turnId: string; expectedGeneration: number; expectedRuntimeTurnId?: string; expectedRuntimeTurnStartedAt?: string; state: InstanceTurnState; result?: string | null; error?: string | null; eventKind: InstanceEventKind }): InstanceTurn | null { return this.workerTurns.updateInstanceTurn(input); }
  completeInstanceTurn(input: { turnId: string; expectedGeneration: number; result: string }): InstanceTurn | null { return this.workerTurns.completeInstanceTurn(input); }
  listInstanceEvents(instanceId: string, afterId = 0): InstanceEvent[] { return this.workerTurns.listInstanceEvents(instanceId, afterId); }
  countPendingInstanceTurns(instanceId: string, expectedGeneration?: number): number { return this.workerTurns.countPendingInstanceTurns(instanceId, expectedGeneration); }
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
  convertTurnControlToPrimaryPriority(input: { operationId: string; prompt: AcceptPromptInput["prompt"]; view: RunCardView; rootMessageId: string; answerCard: object; maxQueueDepth: number; expectedBindingGeneration: number; result: Record<string, unknown>; card?: object }): { operation: TurnControlOperation; prompt: PromptJob } | null {
    return this.turnControls.convertToPrimaryPriority(input);
  }
  convertTurnControlToWorkerPriority(input: { operationId: string; turn: Omit<AcceptInstanceTurnWithCardInput, "view" | "render"> & { view?: AcceptInstanceTurnWithCardInput["view"]; render?: AcceptInstanceTurnWithCardInput["render"] }; maxQueueDepth: number; result: Record<string, unknown>; card?: object }): { operation: TurnControlOperation; logicalTurnId: string } | null {
    return this.turnControls.convertToWorkerPriority(input);
  }
  listAcceptedTurnControlOperations(owner: import("../../src/domain/turn-control.js").TurnControlOwner): TurnControlOperation[] { return this.turnControls.listAccepted(owner); }
  recoverTurnControlOperations(renderResult?: (operation: TurnControlOperation) => object): { accepted: TurnControlOperation[]; uncertain: TurnControlOperation[] } {
    return this.turnControls.recover(renderResult);
  }
  isBridgeMessage(messageId: string): boolean { return this.inboundProjects.isBridgeMessage(messageId); }
  recordBridgeMessage(messageId: string): void { this.inboundProjects.recordBridgeMessage(messageId); }

  createPendingBinding(input: { id: string; kind?: Binding["kind"]; gatewayId?: string; projectId?: string | null; workspaceId: string; chatId: string; topicId: string | null; rootMessageId: string | null; title: string; creatorOpenId?: string | null }): Binding {
    return this.bindings.createPendingBinding(input);
  }

  createOrGetPendingOrchestratorBinding(input: { id: string; gatewayId: string; projectId: string; workspaceId: string; chatId: string; title: string; creatorOpenId: string }) {
    return this.bindings.createOrGetPendingOrchestratorBinding(input);
  }

  findOrchestratorBinding(gatewayId: string, chatId: string): Binding | null {
    return this.bindings.findOrchestratorBinding(gatewayId, chatId);
  }

  createCardInteraction(input: { id: string; bindingId: string; bindingGeneration: number; actorOpenId: string; actionKind: CardInteractionActionKind; parentPromptId: string | null; targetPromptId: string | null; expiresAt: string }): CardInteraction {
    return this.sessionOperations.createInteraction(input);
  }

  getCardInteraction(id: string): CardInteraction | null {
    return this.sessionOperations.getInteraction(id);
  }

  consumeCardInteraction(input: { id: string; actorOpenId: string; bindingId: string; bindingGeneration: number; now: string; resultCode: string }): { outcome: "consumed" | "duplicate" | "missing" | "unauthorized" | "expired" | "stale"; interaction: CardInteraction | null } { return this.sessionOperations.consumeInteraction(input); }

  acceptLegacySessionOperationForTest(input: { id: string; idempotencyKey: string; interactionId: string; actorOpenId: string; bindingId: string; bindingGeneration: number; expectedPaneId: string | null; expectedTerminalId: string | null; kind: SessionOperationKind; argument: string | null; now: string }): { outcome: "accepted" | "duplicate" | "missing" | "unauthorized" | "expired" | "stale"; operation: SessionOperation | null } {
    const requiresArgument = input.kind === "rename" || input.kind === "reattach";
    if (requiresArgument && (!input.argument || input.argument !== input.argument.trim())) throw new Error(`Session operation ${input.kind} requires a trimmed argument`);
    if (!requiresArgument && input.argument !== null) throw new Error(`Session operation ${input.kind} does not accept an argument`);
    if (input.argument !== null && input.argument.length > 500) throw new Error("Session operation argument exceeds 500 characters");
    return this.graph.context.transaction(() => {
      const interaction = this.sessionOperations.getInteraction(input.interactionId);
      if (!interaction) return { outcome: "missing", operation: null };
      if (interaction.actorOpenId !== input.actorOpenId) return { outcome: "unauthorized", operation: null };
      const existing = this.database.prepare("SELECT id, idempotency_key, kind, binding_id, binding_generation FROM session_operations WHERE interaction_id = ?").get(input.interactionId) as { id: string; idempotency_key: string; kind: SessionOperationKind; binding_id: string; binding_generation: number } | undefined;
      if (existing) {
        const exactDuplicate = existing.idempotency_key === input.idempotencyKey && existing.kind === input.kind
          && existing.binding_id === input.bindingId && existing.binding_generation === input.bindingGeneration;
        return exactDuplicate ? { outcome: "duplicate", operation: this.sessionOperations.get(existing.id) } : { outcome: "stale", operation: null };
      }
      if (interaction.state === "consumed") return { outcome: "stale", operation: null };
      if (interaction.expiresAt <= input.now) {
        this.database.prepare("UPDATE card_interactions SET state = 'expired' WHERE id = ? AND state = 'active'").run(input.interactionId);
        return { outcome: "expired", operation: null };
      }
      const binding = this.bindings.getBinding(input.bindingId);
      const identityMatches = interaction.state === "active" && interaction.actionKind === "more_actions"
        && interaction.bindingId === input.bindingId && interaction.bindingGeneration === input.bindingGeneration
        && binding?.generation === input.bindingGeneration && binding.paneId === input.expectedPaneId
        && binding.traexSessionId === input.expectedTerminalId;
      if (!identityMatches || sessionOperationRejection(binding, input.kind)) return { outcome: "stale", operation: null };
      this.database.prepare(`
        INSERT INTO session_operations(
          id, idempotency_key, interaction_id, binding_id, binding_generation, expected_pane_id, expected_terminal_id,
          actor_open_id, kind, argument, state, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 0, ?, ?)
      `).run(input.id, input.idempotencyKey, input.interactionId, input.bindingId, input.bindingGeneration, input.expectedPaneId, input.expectedTerminalId, input.actorOpenId, input.kind, input.argument, input.now, input.now);
      const consumed = this.database.prepare("UPDATE card_interactions SET state = 'consumed', result_code = ?, consumed_at = ? WHERE id = ? AND state = 'active'").run(input.kind, input.now, input.interactionId);
      if (consumed.changes !== 1) throw new Error(`Session interaction acceptance lost ownership: ${input.interactionId}`);
      return { outcome: "accepted", operation: this.sessionOperations.get(input.id) };
    });
  }

  createResetCandidate(input: { oldBindingId: string; newBindingId: string; title: string; actorOpenId: string; resetMessageId: string }): { previous: Binding; replacement: Binding; created: boolean } {
    return this.bindings.createResetCandidate(input);
  }

  cutoverResetCandidate(input: { oldBindingId: string; newBindingId: string; cleanupOperationId: string; actorOpenId: string; expectedCwd: string }): { previous: Binding; replacement: Binding; cleanup: RetiredPaneCleanupOperation; cancelledPromptIds: string[] } {
    return this.bindings.cutoverResetCandidate(input);
  }
  cutoverAttachedPaneThread(input: Parameters<BindingProvisioningStore["cutoverAttachedPaneThread"]>[0]): ReturnType<BindingProvisioningStore["cutoverAttachedPaneThread"]> { return this.bindings.cutoverAttachedPaneThread(input); }

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

  createAutomaticProjectSelection(input: Parameters<SqliteInboundProjectStore["createAutomaticProjectSelection"]>[0]): ProjectSelection {
    return this.inboundProjects.createAutomaticProjectSelection(input);
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

  countWorkerPanesForClose(input: { bindingId: string; bindingGeneration: number; paneId: string }): number {
    return this.paneOperations.countWorkerPanesForClose(input);
  }

  reserveWorkerPaneClose(instanceId: string, expectedGeneration: number) {
    return this.instances.reserveWorkerPaneClose(instanceId, expectedGeneration);
  }

  beginWorkerPaneCloseCascade(input: { operationId: string; bindingId: string; bindingGeneration: number; paneId: string }): Array<{ workerId: string; paneId: string; instanceGeneration: number }> {
    return this.paneOperations.beginWorkerPaneCloseCascade(input);
  }

  listUnresolvedWorkerPaneCloseSteps(): Array<{ operationId: string; bindingId: string; parentPaneId: string; workerId: string; paneId: string; instanceGeneration: number; state: "executing" | "uncertain" }> {
    return this.paneOperations.listUnresolvedWorkerPaneCloseSteps();
  }

  finishWorkerPaneCloseStep(input: { operationId: string; workerId: string; paneId: string; state: "succeeded" | "retained" | "uncertain"; detail?: string }): void {
    this.paneOperations.finishWorkerPaneCloseStep(input);
  }

  listUnresolvedPaneCloseOperations(): PaneCloseOperation[] {
    return this.paneOperations.listUnresolvedPaneCloseOperations();
  }

  /** Legacy test/setup escape hatch; workflows must use explicit ports below. */
  updateBinding(id: string, patch: Partial<Binding>): Binding { return this.bindings.updateBinding(id, patch); }

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

  reconcileRuntimeIdentity(input: Parameters<RuntimeReconciliationStore["reconcileRuntimeIdentity"]>[0]): ReturnType<RuntimeReconciliationStore["reconcileRuntimeIdentity"]> {
    return this.graph.capabilityModules().runtimeReconciliation.reconcileRuntimeIdentity(input);
  }

  applyRuntimeIdentityTransition(input: Parameters<BindingProvisioningStore["applyRuntimeIdentityTransition"]>[0]): ReturnType<BindingProvisioningStore["applyRuntimeIdentityTransition"]> {
    return this.graph.capabilityModules().bindingProvisioning.applyRuntimeIdentityTransition(input);
  }

  /** Test-only fixture access to the concrete RuntimeIdentityClaim aggregate. */
  loadRuntimeIdentityClaim(owner: RuntimeIdentityOwner): RuntimeIdentityClaim | null {
    return this.graph.runtimeIdentityClaims.loadRuntimeIdentityClaim(owner);
  }

  /** Test-only fixture access to seed a current RuntimeIdentityClaim. */
  claimCurrentRuntimeIdentity(input: { claim: CurrentRuntimeIdentityClaim; paneToken: string | null }): ReturnType<SqliteCapabilityGraph["runtimeIdentityClaims"]["claimCurrentRuntimeIdentity"]> {
    return this.graph.runtimeIdentityClaims.claimCurrentRuntimeIdentity(input);
  }

  backfillRunCardPaneToken(input: Parameters<SqliteBindingProjectionStore["backfillRunCardPaneToken"]>[0]): ReturnType<SqliteBindingProjectionStore["backfillRunCardPaneToken"]> {
    return this.bindingProjections.backfillRunCardPaneToken(input);
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
    return this.bindings.findBindingByLarkScope(topicId, rootMessageId) ?? this.graph.threadAliases.findBindingByScope(topicId, rootMessageId);
  }
  isBindingThreadAlias(topicId: string | null, rootMessageId: string | null): boolean { return this.graph.threadAliases.isActiveScope(topicId, rootMessageId); }
  reservePaneThreadAlias(input: Parameters<SqliteOutboxStore["reservePaneThreadAlias"]>[0]): ReturnType<SqliteOutboxStore["reservePaneThreadAlias"]> { return this.outbox.reservePaneThreadAlias(input); }

  findBindingByPane(paneId: string): Binding | null {
    return this.bindings.findBindingByPane(paneId);
  }

  getBinding(id: string): Binding | null {
    return this.bindings.getBinding(id);
  }

  listBindings(): Binding[] { return this.bindings.listBindings(); }

  listBindingsByState(state: Binding["state"]): Binding[] {
    return this.bindings.listBindingsByState(state);
  }

  listSessions(chatId: string, cursor: string | null = null): ReturnType<SqliteBindingLifecycleStore["listSessions"]> {
    return this.bindings.listSessions(chatId, cursor);
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
    return this.prompts.projectQueuedRunCards(input);
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
    return this.promptRecovery.recoverRunningPrompts();
  }

  scanDurablePromptWork(): DurablePromptWorkScan {
    return this.promptRecovery.scanDurablePromptWork();
  }

  listStaleUndispatchedPromptClaims(updatedBefore: string, limit: number): StalePromptClaim[] {
    return this.promptRecovery.listStaleUndispatchedPromptClaims(updatedBefore, limit);
  }

  requeueStaleUndispatchedPromptClaim(candidate: StalePromptClaim): boolean {
    return this.promptRecovery.requeueStaleUndispatchedPromptClaim(candidate);
  }

  releaseUndispatchedPromptClaim(candidate: StalePromptClaim): boolean {
    return this.promptRecovery.releaseUndispatchedPromptClaim(candidate);
  }

  listDetachedPrompts(): PromptJob[] {
    return this.promptRecovery.listDetachedPrompts();
  }

  skipOldestDetachedPrompt(input: { bindingId: string; expectedBindingGeneration: number; actorOpenId: string; sourceMessageId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): import("../domain/ports/prompt.js").DetachedPromptSkipResult {
    return this.promptRecovery.skipOldestDetachedPrompt(input);
  }

  advanceDetachedPromptRecovery(input: import("../domain/ports/prompt.js").AdvanceDetachedPromptRecoveryInput): import("../domain/ports/prompt.js").DetachedPromptRecoveryResult {
    return this.promptRecovery.advanceDetachedPromptRecovery(input);
  }

  markDetachedPromptRecoveryNeedsHuman(input: Parameters<SqlitePromptRecoveryStore["markDetachedPromptRecoveryNeedsHuman"]>[0]) {
    return this.promptRecovery.markDetachedPromptRecoveryNeedsHuman(input);
  }

  recoverProjectedBridgeTurn(input: Parameters<SqlitePromptRecoveryStore["recoverProjectedBridgeTurn"]>[0]) {
    return this.promptRecovery.recoverProjectedBridgeTurn(input);
  }

  settleDetachedPrompt(input: Parameters<SqlitePromptRecoveryStore["settleDetachedPrompt"]>[0]): ReturnType<SqlitePromptRecoveryStore["settleDetachedPrompt"]> {
    return this.promptRecovery.settleDetachedPrompt(input);
  }

  markPromptObservationDetached(id: string, notice: string): void {
    this.promptRecovery.markPromptObservationDetached(id, notice);
  }

  markPromptDispatched(id: string): void;
  markPromptDispatched(id: string, dispatchedAt: string): void;
  markPromptDispatched(id: string, dispatchedAt = now()): void {
    this.promptDispatch.markPromptDispatched(id, dispatchedAt);
  }

  recordModelDispatchEvidence(input: ModelDispatchEvidenceCommand): boolean {
    return this.promptDispatch.recordModelDispatchEvidence(input);
  }

  claimPromptTranscriptTurn(input: { promptId: string; bindingId: string; turnId: string; startedAt: string }): TranscriptTurnClaimOutcome {
    return this.promptDispatch.claimPromptTranscriptTurn(input);
  }

  adoptExternalTurn(input: AdoptExternalTurnInput): ExternalTurnAdoption {
    return this.externalTurnAdoption.adoptExternalTurn(input);
  }

  loadConversationTurnProjection(...args: Parameters<SqliteExternalTurnAdoptionStore["loadConversationTurnProjection"]>): ReturnType<SqliteExternalTurnAdoptionStore["loadConversationTurnProjection"]> {
    return this.externalTurnAdoption.loadConversationTurnProjection(...args);
  }

  projectConversationTurn(...args: Parameters<SqliteExternalTurnAdoptionStore["projectConversationTurn"]>): ReturnType<SqliteExternalTurnAdoptionStore["projectConversationTurn"]> {
    return this.externalTurnAdoption.projectConversationTurn(...args);
  }

  replaceAuthoritativeTurnSnapshot(...args: Parameters<import("../../src/store/sqlite/authoritative-turn-snapshot-store.js").SqliteAuthoritativeTurnSnapshotStore["replaceAuthoritativeTurnSnapshot"]>): ReturnType<import("../../src/store/sqlite/authoritative-turn-snapshot-store.js").SqliteAuthoritativeTurnSnapshotStore["replaceAuthoritativeTurnSnapshot"]> {
    return this.capabilityModules().turnSnapshots.replaceAuthoritativeTurnSnapshot(...args);
  }

  recoverLegacyElementIdDeadLetters(): number {
    return this.operations.recoverLegacyElementIdDeadLetters((timestamp) => this.migrations.canonicalizeLegacyAnswerTargets(timestamp));
  }

  enqueuePrompt(input: Omit<PromptJob, "sessionEpoch" | "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "priority" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin"> & Partial<Pick<PromptJob, "priority" | "wasDetached" | "executionOrigin">>): { prompt: PromptJob; inserted: boolean } {
    return this.promptAcceptance.enqueuePrompt(input);
  }

  acceptPrompt(input: AcceptPromptInput): { prompt: PromptJob; view: RunCardView; inserted: boolean } {
    return this.promptAcceptance.acceptPrompt(input);
  }

  acceptPromptWithEffects(input: AcceptPromptInput): import("../domain/ports/prompt-acceptance.js").PromptAcceptanceReceipt {
    return this.promptAcceptance.acceptPromptWithEffects(input);
  }

  acceptImmediateNativeInputBatch(input: Parameters<SqlitePromptAcceptanceStore["acceptImmediateNativeInputBatch"]>[0]): ReturnType<SqlitePromptAcceptanceStore["acceptImmediateNativeInputBatch"]> {
    return this.promptAcceptance.acceptImmediateNativeInputBatch(input);
  }

  acceptCollectingNativeInput(input: Parameters<SqlitePromptAcceptanceStore["acceptCollectingNativeInput"]>[0]): ReturnType<SqlitePromptAcceptanceStore["acceptCollectingNativeInput"]> {
    return this.promptAcceptance.acceptCollectingNativeInput(input);
  }

  formDueNativeInputBatch(input: Parameters<SqlitePromptAcceptanceStore["formDueNativeInputBatch"]>[0]): ReturnType<SqlitePromptAcceptanceStore["formDueNativeInputBatch"]> {
    return this.promptAcceptance.formDueNativeInputBatch(input);
  }

  hasAcceptedPromptSource(identity: AcceptedPromptSourceIdentity): boolean {
    return this.promptAcceptance.getPromptInputBySource(identity.ingressSource, identity.sourceMessageKey) !== null;
  }

  getNativeInputBacklog(...args: Parameters<SqlitePromptAcceptanceStore["getNativeInputBacklog"]>): ReturnType<SqlitePromptAcceptanceStore["getNativeInputBacklog"]> {
    return this.promptAcceptance.getNativeInputBacklog(...args);
  }

  getPromptInputBySource(...args: Parameters<SqlitePromptAcceptanceStore["getPromptInputBySource"]>): ReturnType<SqlitePromptAcceptanceStore["getPromptInputBySource"]> {
    return this.promptAcceptance.getPromptInputBySource(...args);
  }

  getNativeInputBatch(batchId: string): ReturnType<SqlitePromptAcceptanceStore["getNativeInputBatch"]> {
    return this.promptAcceptance.getNativeInputBatch(batchId);
  }

  listNativeInputBatchMembers(batchId: string): ReturnType<SqlitePromptAcceptanceStore["listNativeInputBatchMembers"]> {
    return this.promptAcceptance.listNativeInputBatchMembers(batchId);
  }

  acceptInterruptedContinuation(input: Parameters<SqlitePromptAcceptanceStore["acceptInterruptedContinuation"]>[0]): ReturnType<SqlitePromptAcceptanceStore["acceptInterruptedContinuation"]> {
    return this.promptAcceptance.acceptInterruptedContinuation(input);
  }
  acceptPrimaryCompletionAction(input: Parameters<SqlitePromptAcceptanceStore["acceptPrimaryCompletionAction"]>[0]): ReturnType<SqlitePromptAcceptanceStore["acceptPrimaryCompletionAction"]> {
    return this.promptAcceptance.acceptPrimaryCompletionAction(input);
  }
  ignorePrimaryCompletionAction(input: Parameters<SqlitePromptAcceptanceStore["ignorePrimaryCompletionAction"]>[0]): ReturnType<SqlitePromptAcceptanceStore["ignorePrimaryCompletionAction"]> {
    return this.promptAcceptance.ignorePrimaryCompletionAction(input);
  }
  resolvePrimaryCompletionChoice(input: Parameters<SqlitePromptAcceptanceStore["resolvePrimaryCompletionChoice"]>[0]): ReturnType<SqlitePromptAcceptanceStore["resolvePrimaryCompletionChoice"]> {
    return this.promptAcceptance.resolvePrimaryCompletionChoice(input);
  }

  ensureAnswerCard(promptId: string, rootMessageId: string, card: object, workClass?: OutboundWorkClass): void {
    this.prompts.ensureAnswerCard(promptId, rootMessageId, card, workClass);
  }

  claimNextDispatchablePrompt(bindingId: string, options?: { nativeInputBatchOnly?: boolean }): import("../../src/domain/ports/prompt-acceptance.js").ClaimedPrompt | null {
    return this.promptDispatch.claimNextDispatchablePrompt(bindingId, options);
  }

  markPromptNativeQueued(input: Parameters<SqlitePromptDispatchStore["markPromptNativeQueued"]>[0]): boolean {
    return this.promptDispatch.markPromptNativeQueued(input);
  }

  applyPromptNativeSubmissionReceipt(input: Parameters<SqlitePromptDispatchStore["applyPromptNativeSubmissionReceipt"]>[0]): boolean {
    return this.promptDispatch.applyPromptNativeSubmissionReceipt(input);
  }

  fencePromptNativeSubmission(input: Parameters<SqlitePromptDispatchStore["fencePromptNativeSubmission"]>[0]): boolean {
    return this.promptDispatch.fencePromptNativeSubmission(input);
  }

  releaseRejectedNativeSubmission(input: Parameters<SqlitePromptDispatchStore["releaseRejectedNativeSubmission"]>[0]): boolean {
    return this.promptDispatch.releaseRejectedNativeSubmission(input);
  }

  updatePrompt(id: string, state: PromptState, error: string | null = null): void {
    this.promptDispatch.updatePrompt(id, state, error);
  }

  completeTurn(input: Parameters<SqlitePromptDispatchStore["completeTurn"]>[0]): ReturnType<SqlitePromptDispatchStore["completeTurn"]> {
    return this.promptDispatch.completeTurn(input);
  }

  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void {
    this.promptDispatch.failPrompt(input);
  }

  failExternalTurnWithoutTerminalEvent(input: Parameters<ExternalTurnObservationStore["failExternalTurnWithoutTerminalEvent"]>[0]): boolean {
    return this.promptDispatch.failExternalTurnWithoutTerminalEvent(input);
  }

  cancelQueuedPromptsWithProjection(input: { bindingId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): { cancelledPromptIds: string[]; outboxReserved: boolean } {
    return this.prompts.cancelQueuedPromptsWithProjection(input);
  }

  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean {
    return this.outbox.hasPendingAnswerContinuation(promptId, pageIndex);
  }

  hasPendingOutboundReplyForWorkerTurn(turnId: string): boolean {
    return this.outbox.hasPendingOutboundReplyForWorkerTurn(turnId);
  }

  retireUndeliveredWorkerTaskCardIntents(): number { return this.outbox.retireUndeliveredWorkerTaskCardIntents(); }
  dismissEligibleLegacyCompletionNotifications(bindingIds?: readonly string[]): number { return this.outbox.dismissEligibleLegacyCompletionNotifications(bindingIds); }

  recoverStaleOutboxQuarantines(): import("../domain/types.js").StaleOutboxQuarantineRecovery {
    return this.outbox.recoverStaleOutboxQuarantines();
  }

  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.outbox.retryDeadLetter(id, chatId, actorOpenId);
  }

  dismissDeadLetter(id: string, chatId: string, actorOpenId: string, sourceMessageId?: string): DeadLetterActionOutcome {
    return this.outbox.dismissDeadLetter(id, chatId, actorOpenId, sourceMessageId);
  }

  getOperationalSummary(): import("../domain/types.js").OperationalSummary { return this.operations.getOperationalSummary(); }
  getRecoveryDurableEvidence(): import("../../src/domain/recovery.js").RecoveryDurableEvidence { return this.operations.getRecoveryDurableEvidence(); }
  getRecoveryStageForBinding(bindingId: string): import("../../src/domain/recovery.js").RecoveryStage | null { return this.operations.getRecoveryStageForBinding(bindingId); }

  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void { this.operations.audit(input); }

  saveTopicView(view: TopicViewState): void {
    this.projections.saveTopicView(view);
  }

  saveGoalProjection(topic: TopicViewState, runCards: readonly RunCardView[]): RunCardView[] {
    return this.projections.saveGoalProjection(topic, runCards);
  }

  projectCoreEvent<Result>(settlement: CoreEventProjectionSettlement, projectionOwner: CoreEventProjectionOwner, operation: () => Result): CoreEventProjectionResult<Result> {
    return this.projections.projectCoreEvent(settlement, projectionOwner, operation);
  }

  loadTopicView(bindingId: string): TopicViewState | null {
    return this.projections.loadTopicView(bindingId);
  }

  getCurrentGoal(bindingId: string) {
    return this.projections.loadTopicView(bindingId)?.currentGoal ?? null;
  }

  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object, workClass?: OutboundWorkClass, paneEntryCard?: object): MainCardReservationOutcome {
    return this.projections.reserveMainCard(view, rootMessageId, card, workClass, paneEntryCard);
  }

  saveRunCard(view: RunCardView): RunCardView {
    return this.projections.saveRunCard(view);
  }

  loadRunCard(promptId: string): RunCardView | null {
    return this.projections.loadRunCard(promptId);
  }

  getProjectionGapSummary(input: { bindingId?: string; promptId?: string; pageIndex?: number }): ProjectionGapSummary {
    return this.projections.getProjectionGapSummary(input);
  }

  getWorkerProjectionGapSummary(turnId: string): ProjectionGapSummary {
    return this.workerTurns.getWorkerProjectionGapSummary(turnId);
  }

  listRunCards(bindingId: string): RunCardView[] {
    return this.projections.listRunCards(bindingId);
  }

  listActionableStartupRunCards(bindingId: string): RunCardView[] {
    return this.projections.listActionableStartupRunCards(bindingId);
  }

  getPromptProjectionState(id: string) {
    return this.projections.getPromptProjectionState(id);
  }

  listStartupViewBindings(bindingIds?: readonly string[]): Binding[] {
    return this.projections.listStartupViewBindings(bindingIds);
  }

  loadStartupMainRunCard(bindingId: string, preferredPromptId: string | null): RunCardView | null {
    return this.projections.loadStartupMainRunCard(bindingId, preferredPromptId);
  }

  listRunCardsByPhases(bindingId: string, phases: readonly RunCardView["phase"][]): RunCardView[] {
    return this.projections.listRunCardsByPhases(bindingId, phases);
  }

  getActiveAnswerPage(promptId: string): AnswerPage | null {
    return this.projections.getActiveAnswerPage(promptId);
  }

  listRecoverablePrimaryAnswerPromptIds(limit: number): readonly string[] {
    return this.projections.listRecoverablePrimaryAnswerPromptIds(limit);
  }

  listRecoverablePrimaryAnswerPromptIdsForBinding(bindingId: string, limit: number): readonly string[] {
    return this.projections.listRecoverablePrimaryAnswerPromptIdsForBinding(bindingId, limit);
  }

  getAnswerPage(promptId: string, pageIndex: number): AnswerPage | null {
    return this.projections.getAnswerPage(promptId, pageIndex);
  }

  getAnswerPageDeliveryFacts(promptId: string, pageIndex: number): AnswerPageDeliveryFacts {
    return this.projections.getAnswerPageDeliveryFacts(promptId, pageIndex);
  }

  getAnswerTimelinePage(promptId: string, pageIndex: number): AnswerTimelinePageCheckpoint { return this.projections.getAnswerTimelinePage(promptId, pageIndex); }
  listFrozenAnswerTimelineItems(promptId: string, beforePageIndex: number) { return this.projections.listFrozenAnswerTimelineItems(promptId, beforePageIndex); }
  reserveAnswerTimelineCard(input: { promptId: string; pageIndex: number; messageId: string; card: object; cursor: AnswerTimelineCursor | null; items: readonly AnswerTimelineItem[]; source?: string; workClass?: OutboundWorkClass }): AnswerPageReservationOutcome { return this.projections.reserveAnswerTimelineCard(input); }

  reserveAnswerContent(input: { promptId: string; pageIndex: number; cardId: string; elementId: string; content: string }): AnswerPageReservationOutcome {
    return this.projections.reserveAnswerContent(input);
  }

  reserveAnswerFinish(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object }): AnswerPageReservationOutcome {
    return this.projections.reserveAnswerFinish(input);
  }

  preparePrimaryCompletionActionSet(input: { promptId: string; pageIndex: number; cardId: string; messageId: string }) {
    return this.projections.preparePrimaryCompletionActionSet(input);
  }

  reserveAnswerContinuation(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; summary: string; finalizedCard: object; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object; timelineStartCursor?: AnswerTimelineCursor; timelineEndCursor?: AnswerTimelineCursor | null; timelineItems?: readonly AnswerTimelineItem[] }): AnswerPageReservationOutcome {
    return this.projections.reserveAnswerContinuation(input);
  }

  reserveAnswerRebuild(input: { promptId: string; pageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.projections.reserveAnswerRebuild(input);
  }

  reserveFinalAnswerCardUpdate(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; card: object; source?: string }): AnswerPageReservationOutcome {
    return this.projections.reserveFinalAnswerCardUpdate(input);
  }

  reserveClosedAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; source?: string }): AnswerPageReservationOutcome {
    return this.projections.reserveClosedAnswerCardUpdate(input);
  }

  reserveStaticAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; source?: string }): AnswerPageReservationOutcome {
    return this.projections.reserveStaticAnswerCardUpdate(input);
  }

  reserveStaticAnswerReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.projections.reserveStaticAnswerReplacement(input);
  }

  hasPendingExpiredAnswerTarget(promptId: string, pageIndex: number): boolean {
    return this.projections.hasPendingExpiredAnswerTarget(promptId, pageIndex);
  }

  reserveClosedAnswerStreamReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; source?: string; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.projections.reserveClosedAnswerStreamReplacement(input);
  }

  listAnswerPages(promptId: string): AnswerPage[] {
    return this.projections.listAnswerPages(promptId);
  }

  getPrompt(id: string): PromptJob | null {
    return this.promptDispatch.getPrompt(id);
  }

  getModelPreference(bindingId: string): ModelPreference | null {
    return this.prompts.getModelPreference(bindingId);
  }

  acceptModelPreference(input: { bindingId: string; bindingGeneration: number; model: string }): { outcome: "accepted" | "busy" | "stale"; preference: ModelPreference | null } {
    return this.prompts.acceptModelPreference(input);
  }

}

function now(): string { return new Date().toISOString(); }
