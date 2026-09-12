import type { OutboxTestDriver } from "./outbox-test-driver.js";
import { DatabaseSync } from "node:sqlite";
import type { AcceptInstanceTurnWithCardInput } from "../../src/domain/ports.js";
import type { AcceptPromptInput } from "../../src/domain/ports/prompt.js";
import type { AdoptExternalTurnInput } from "../../src/domain/ports/workflow.js";
import type { TurnControlStore } from "../../src/domain/ports/turn-control.js";
import type { AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, Binding, BindingMetadataPatch, BindingTitleProjectionInput, BindingTitleProjectionResult, CardInteraction, CardInteractionActionKind, DeadLetterActionOutcome, DurablePromptWorkScan, ExternalTurnAdoption, FailureSummary, HerdrPane, MainCardReservationOutcome, OrphanBindingProjectionInput, OrphanBindingProjectionResult, OutboundTargetRole, OutboundWorkClass, PaneCloseOperation, PaneControlOperation, PaneControlOperationKind, ProjectSelection, ProjectSelectionClaim, PromptJob, PromptState, RecoverOrphanBindingProjectionInput, RecoverOrphanBindingProjectionResult, RetiredPaneCleanupOperation, RetiredPaneCleanupState, RuntimeDegradationInput, RuntimeDegradationResult, RuntimeObservationApplication, SessionSummary, StalePromptClaim, TranscriptTurnClaimOutcome } from "../../src/domain/types.js";
import type { TopicViewState } from "../../src/domain/topic-view.js";
import type { RunCardView } from "../../src/domain/run-card-view.js";
import type { BridgeEvent } from "../../src/domain/events.js";
import type { SessionTransition } from "../../src/domain/pane-thread-lifecycle.js";
import type { PaneControlOutcome } from "../../src/domain/pane-control-lifecycle.js";
import type { ModelPreference } from "../../src/domain/model-selection.js";
import type { AgentInstance } from "../../src/domain/agent-instance.js";
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
import type { SqliteOutboxStore } from "../../src/store/sqlite/outbox-store.js";
import type { SqliteInstanceStore } from "../../src/store/sqlite/instance-store.js";
import type { SqliteCardContextStore } from "../../src/store/sqlite/card-context-store.js";
import type { SqliteInboundProjectStore } from "../../src/store/sqlite/inbound-project-store.js";
import type { SqlitePaneOperationStore } from "../../src/store/sqlite/pane-operation-store.js";
import type { SqliteBindingLifecycleStore } from "../../src/store/sqlite/binding-store.js";
import type { SqliteBindingProjectionStore } from "../../src/store/sqlite/binding-projection-store.js";
import type { SqliteTurnControlStore } from "../../src/store/sqlite/turn-control-store.js";
export class SqliteStoreKernel implements TurnControlStore {
  readonly database: DatabaseSync;
  private readonly graph: SqliteCapabilityGraph;
  private readonly migrations: SqliteMigrations;
  private readonly operations: SqliteOperationsStore;
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
  private readonly turnControls: SqliteTurnControlStore;

  constructor(path: string) {
    this.graph = new SqliteCapabilityGraph(path);
    this.database = this.graph.database;
    this.migrations = this.graph.migrations;
    this.bindings = this.graph.bindings;
    this.operations = this.graph.operations;
    this.sessionOperations = this.graph.sessionOperations;
    this.projections = this.graph.projections;
    this.outbox = this.graph.outbox;
    this.bindingProjections = this.graph.bindingProjections;
    this.prompts = this.graph.prompts;
    this.workerTurns = this.graph.workerTurns;
    this.instances = this.graph.instances;
    this.cardContexts = this.graph.cardContexts;
    this.turnControls = this.graph.turnControls;
    this.inboundProjects = this.graph.inboundProjects;
    this.paneOperations = this.graph.paneOperations;
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
  hasBindingPrimaryToolCapability(bindingId: string, expectedGeneration: number): boolean {
    return this.bindings.hasPrimaryToolCapability(bindingId, expectedGeneration);
  }
  revokeBindingPrimaryToolCapability(bindingId: string, expectedGeneration: number): boolean {
    return this.bindings.revokePrimaryToolCapability(bindingId, expectedGeneration);
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
  recoverTurnControlOperations(renderResult?: (operation: TurnControlOperation) => object): { accepted: TurnControlOperation[]; uncertain: TurnControlOperation[] } {
    return this.turnControls.recover(renderResult);
  }
  isBridgeMessage(messageId: string): boolean { return this.inboundProjects.isBridgeMessage(messageId); }
  recordBridgeMessage(messageId: string): void { this.inboundProjects.recordBridgeMessage(messageId); }

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

  adoptExternalTurn(input: AdoptExternalTurnInput): ExternalTurnAdoption {
    return this.prompts.adoptExternalTurn(input);
  }

  recoverLegacyElementIdDeadLetters(): number {
    return this.operations.recoverLegacyElementIdDeadLetters((timestamp) => this.migrations.canonicalizeLegacyAnswerTargets(timestamp));
  }

  enqueuePrompt(input: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "priority" | "wasDetached" | "dispatchedAt" | "transcriptTurnId" | "transcriptTurnStartedAt" | "executionOrigin"> & Partial<Pick<PromptJob, "priority" | "wasDetached" | "executionOrigin">>): { prompt: PromptJob; inserted: boolean } {
    return this.prompts.enqueuePrompt(input);
  }

  acceptPrompt(input: AcceptPromptInput): { prompt: PromptJob; view: RunCardView; inserted: boolean } {
    return this.prompts.acceptPrompt(input);
  }

  acceptPromptWithEffects(input: AcceptPromptInput): import("../domain/ports/prompt-acceptance.js").PromptAcceptanceReceipt {
    return this.prompts.acceptPromptWithEffects(input);
  }

  acceptInterruptedContinuation(input: Parameters<SqlitePromptStore["acceptInterruptedContinuation"]>[0]): ReturnType<SqlitePromptStore["acceptInterruptedContinuation"]> {
    return this.prompts.acceptInterruptedContinuation(input);
  }

  ensureAnswerCard(promptId: string, rootMessageId: string, card: object, workClass?: OutboundWorkClass): void {
    this.prompts.ensureAnswerCard(promptId, rootMessageId, card, workClass);
  }

  claimNextDispatchablePrompt(bindingId: string): { binding: Binding; prompt: PromptJob; model: { name: string; revision: number } | null } | null {
    return this.prompts.claimNextDispatchablePrompt(bindingId);
  }

  updatePrompt(id: string, state: PromptState, error: string | null = null): void {
    this.prompts.updatePrompt(id, state, error);
  }

  completeTurn(input: { promptId: string; bindingId: string; answer: string; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): Binding {
    return this.prompts.completeTurn(input);
  }

  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void {
    this.prompts.failPrompt(input);
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

  recoverStaleOutboxQuarantines(): import("../domain/types.js").StaleOutboxQuarantineRecovery {
    return this.outbox.recoverStaleOutboxQuarantines();
  }

  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.outbox.retryDeadLetter(id, chatId, actorOpenId);
  }

  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome {
    return this.outbox.dismissDeadLetter(id, chatId, actorOpenId);
  }

  getOperationalSummary(): import("../domain/types.js").OperationalSummary { return this.operations.getOperationalSummary(); }

  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void { this.operations.audit(input); }

  saveTopicView(view: TopicViewState): void {
    this.projections.saveTopicView(view);
  }

  loadTopicView(bindingId: string): TopicViewState | null {
    return this.projections.loadTopicView(bindingId);
  }

  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object, workClass?: OutboundWorkClass): MainCardReservationOutcome {
    return this.projections.reserveMainCard(view, rootMessageId, card, workClass);
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

  reserveStaticAnswerCardUpdate(input: { promptId: string; pageIndex: number; messageId: string; card: object; source?: string }): AnswerPageReservationOutcome {
    return this.projections.reserveStaticAnswerCardUpdate(input);
  }

  reserveStaticAnswerReplacement(input: { promptId: string; previousPageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome {
    return this.projections.reserveStaticAnswerReplacement(input);
  }

  listAnswerPages(promptId: string): AnswerPage[] {
    return this.projections.listAnswerPages(promptId);
  }

  getPrompt(id: string): PromptJob | null {
    return this.prompts.getPrompt(id);
  }

  getModelPreference(bindingId: string): ModelPreference | null {
    return this.prompts.getModelPreference(bindingId);
  }

  acceptModelPreference(input: { bindingId: string; bindingGeneration: number; model: string }): { outcome: "accepted" | "busy" | "stale"; preference: ModelPreference | null } {
    return this.prompts.acceptModelPreference(input);
  }

}

function now(): string { return new Date().toISOString(); }
