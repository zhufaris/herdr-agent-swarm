import type { AgentState, AnswerPage, AnswerPageDeliveryFacts, AnswerPageReservationOutcome, Binding, BindingMetadataPatch, BindingTitleProjectionInput, BindingTitleProjectionResult, CardInteraction, CardInteractionActionKind, DeadLetterActionOutcome, DeliveryFailureMetadata, DurablePromptWorkScan, FailureSummary, HerdrAgentSession, HerdrPane, HerdrPaneCreationOptions, IncomingLarkCardAction, IncomingLarkMessage, InstanceLease, LarkCardActionResult, MainCardReservationOutcome, OperationalSummary, OrphanBindingProjectionInput, OrphanBindingProjectionResult, OutboundFailureTransition, OutboundReply, OutboxDispatcherDiagnostics, PaneCloseOperation, PaneControlOperation, PaneControlOperationKind, ProjectSelection, ProjectSelectionClaim, PromptJob, RetiredPaneCleanupOperation, RuntimeDegradationInput, RuntimeDegradationResult, RuntimeObservation, RuntimeObservationApplication, RuntimeTurnObservation, SessionSummary, SqliteIntegrityInspection, StaleOutboxQuarantineRecovery } from "./types.js";
import type { TopicViewState } from "./topic-view.js";
import type { RunCardView } from "./run-card-view.js";
import type { SessionTransition } from "./pane-thread-lifecycle.js";
import type { BridgeEvent } from "./events.js";
import type { PaneControlOutcome } from "./pane-control-lifecycle.js";
import type { AgentInstance, CreateAgentInstanceInput, InstanceProvisioningCheckpoint, InstanceRemovalPlan, WorkspaceLease, WorkspaceLeaseState } from "./agent-instance.js";
import type { ControlActor } from "./commands.js";
import type { InstanceEvent, InstanceOperation, InstanceTurn, InstanceTurnState } from "./instance-turn.js";
import type { ApprovalGrant, ApprovalIdentity, ApprovalRequest } from "./approval-policy.js";

export interface ClassifiedPromptInput {
  prompt: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached">;
  ordinaryView: RunCardView;
  steeringView: RunCardView;
  rootMessageId: string;
  maxQueueDepth: number;
  expectedBindingGeneration: number;
  candidateParentPromptId: string | null;
  activeAfter: string;
  acceptedAt: string;
  answerCardFor(view: RunCardView): object;
}

type ClassifiedPromptFallbackReason = "no_candidate" | "binding_changed" | "parent_inactive" | "parent_detached" | "parent_state" | "parent_stale" | null;

export type ClassifiedPromptAcceptance = {
  prompt: PromptJob;
  view: RunCardView;
  inserted: boolean;
  decision: "automatic_steering" | "ordinary";
  fallbackReason: ClassifiedPromptFallbackReason;
} | {
  inserted: false;
  decision: "queue_full";
  fallbackReason: ClassifiedPromptFallbackReason;
};

export interface InstanceStore {
  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null;
  getBinding(id: string): Binding | null;
  createApprovalRequest(input: ApprovalIdentity & { id: string; expiresAt: string }): ApprovalRequest;
  resolveApprovalRequest(input: { requestId: string; actorId: string; approved: boolean; now: string; grantId: string }): { outcome: "approved" | "rejected" | "missing" | "unauthorized" | "expired" | "duplicate"; request: ApprovalRequest | null; grant: ApprovalGrant | null };
  consumeApprovalGrant(input: ApprovalIdentity & { grantId: string; now: string }): "consumed" | "missing" | "expired" | "used" | "mismatch";
  createAgentInstance(input: CreateAgentInstanceInput): AgentInstance;
  getAgentInstance(id: string): AgentInstance | null;
  listAgentInstances(projectId: string): AgentInstance[];
  setPrimaryAgentInstance(projectId: string, instanceId: string): AgentInstance;
  attachAgentInstanceRuntime(input: { instanceId: string; expectedGeneration: number; herdrWorkspaceId: string; paneId: string; nativeSessionId: string | null }): AgentInstance | null;
  checkpointAgentInstance(input: { instanceId: string; expectedGeneration: number; checkpoint: InstanceProvisioningCheckpoint; observedState?: AgentInstance["observedState"]; pendingPaneId?: string | null; pendingWorkspaceId?: string | null; lastError?: string | null }): AgentInstance | null;
  updateAgentInstanceLifecycle(input: { instanceId: string; expectedGeneration: number; desiredState: AgentInstance["desiredState"]; observedState: AgentInstance["observedState"]; clearRuntime?: boolean; lastError?: string | null }): AgentInstance | null;
  updateAgentInstanceObservation(input: { instanceId: string; expectedGeneration: number; observedState: AgentInstance["observedState"]; lastError?: string | null }): AgentInstance | null;
  reserveAgentInstanceStop(instanceId: string, expectedGeneration: number): { outcome: "reserved"; instance: AgentInstance } | { outcome: "busy" | "stale" };
  finishAgentInstanceStop(instanceId: string, expectedGeneration: number): AgentInstance | null;
  rollbackAgentInstanceStop(instanceId: string, expectedGeneration: number, error: string): AgentInstance | null;
  detachAgentInstanceRuntime(input: { instanceId: string; expectedGeneration: number; reason: string }): AgentInstance | null;
  getWorkspaceLease(id: string): WorkspaceLease | null;
  updateWorkspaceLease(input: { id: string; expectedGeneration: number; state: WorkspaceLeaseState; cwd?: string; branch?: string | null; baseCommit?: string }): WorkspaceLease | null;
  createInstanceRemovalPlan(plan: InstanceRemovalPlan): InstanceRemovalPlan;
  getInstanceRemovalPlan(id: string): InstanceRemovalPlan | null;
  consumeInstanceRemovalPlan(input: { id: string; instanceId: string; instanceGeneration: number; workspaceGeneration: number; worktreeFingerprint: string | null }): InstanceRemovalPlan | null;
  removeAgentInstance(input: { instanceId: string; expectedGeneration: number; expectedWorkspaceGeneration: number }): boolean;
  acceptInstanceTurn(input: { id: string; idempotencyKey: string; actor: ControlActor; projectId: string; instanceId: string; instanceGeneration: number; kind: InstanceTurn["kind"]; text: string }): { turn: InstanceTurn; inserted: boolean };
  getInstanceTurn(id: string): InstanceTurn | null;
  listInstanceTurns(instanceId: string): InstanceTurn[];
  getActiveInstanceTurn(instanceId: string, expectedGeneration: number): InstanceTurn | null;
  setPrimaryToolCapability(input: { instanceId: string; expectedGeneration: number; credentialGeneration: number; capabilityHash: string }): boolean;
  verifyPrimaryToolCapability(input: { instanceId: string; expectedGeneration: number; capabilityHash: string }): boolean;
  claimNextInstanceTurn(instanceId: string, expectedGeneration: number): InstanceTurn | null;
  recoverInterruptedInstanceTurns(): { requeuedTurnIds: string[]; observableTurns: InstanceTurn[] };
  listObservableInstanceTurns(): InstanceTurn[];
  getInstanceTurnDiagnostics(): { queuedTurns: number; activeTurns: number; uncertainTurns: number };
  updateInstanceTurn(input: { turnId: string; expectedGeneration: number; state: InstanceTurnState; result?: string | null; error?: string | null; eventKind: string }): InstanceTurn | null;
  completeInstanceTurn(input: { turnId: string; expectedGeneration: number; result: string }): InstanceTurn | null;
  listInstanceEvents(instanceId: string, afterId?: number): InstanceEvent[];
  countPendingInstanceTurns(instanceId: string, expectedGeneration?: number): number;
  acceptInstanceOperation(input: { id: string; idempotencyKey: string; actor: ControlActor; projectId: string; instanceId: string; instanceGeneration: number; kind: InstanceOperation["kind"]; payload: string | null }): { operation: InstanceOperation; inserted: boolean };
  claimInstanceOperation(id: string, expectedGeneration: number): InstanceOperation | null;
  updateInstanceOperation(input: { id: string; expectedGeneration: number; state: InstanceOperation["state"]; result: string }): InstanceOperation | null;
  getConversationTarget(chatId: string): { projectId: string; target: import("./agent-instance.js").InstanceTarget } | null;
  setConversationTarget(input: { chatId: string; projectId: string; target: import("./agent-instance.js").InstanceTarget }): void;
  projectLegacyBindingAsAgentInstance(bindingId: string): AgentInstance | null;
}

export interface LarkPort {
  start(onMessage: (message: IncomingLarkMessage) => Promise<void>, onCardAction?: (action: IncomingLarkCardAction) => Promise<LarkCardActionResult | void>): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  createTopic(card: object, idempotencyKey?: string): Promise<{ topicId: string; rootMessageId: string }>;
  replyText(rootMessageId: string, text: string, idempotencyKey?: string): Promise<{ messageId: string }>;
  replyCard(rootMessageId: string, card: object, idempotencyKey?: string): Promise<{ messageId: string }>;
  replyStreamingCard?(rootMessageId: string, card: object): Promise<{ messageId: string; cardId: string }>;
  createStreamingCard?(card: object): Promise<{ cardId: string }>;
  replyStreamingCardReference?(rootMessageId: string, cardId: string, idempotencyKey: string): Promise<{ messageId: string }>;
  streamCardContent?(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  finishStreamingCard?(cardId: string, sequence: number, summary: string): Promise<void>;
  shareThread(topicOrRootMessageId: string, target: { messageId: string; chatId: string }): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
}

export interface HerdrPort {
  assertWorkspace(workspaceId: string): Promise<void>;
  listAllPanes?(): Promise<HerdrPane[]>;
  listPanes(workspaceId: string, options?: { forceRefresh?: boolean }): Promise<HerdrPane[]>;
  getPane(paneId: string): Promise<HerdrPane | null>;
  observeRuntime(paneId: string): Promise<RuntimeObservation>;
  waitForRuntimeChange?(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<void>;
  createPane(workspaceId: string, cwd: string, options?: HerdrPaneCreationOptions): Promise<HerdrPane>;
  startTraex(paneId: string, executable: string, args?: string[]): Promise<void>;
  startAgent?(paneId: string, input: { name: string; kind: "pi" | "claude" | "codex" | "traex"; executable: string; args?: string[] }): Promise<void>;
  runPrompt(
    paneId: string,
    text: string,
    timeoutMs: number,
    onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>,
    signal?: AbortSignal,
    onDispatched?: () => void | Promise<void>
  ): Promise<AgentState>;
  sendEscape?(paneId: string): Promise<void>;
  renamePane(paneId: string, title: string, options?: { tabTitle?: string }): Promise<void>;
  closePane(paneId: string): Promise<void>;
}

export interface TraexTranscriptCursorPort {
  readDelta(): Promise<string>;
  readObservation?(): Promise<TraexTranscriptObservation>;
}

export interface TraexTranscriptPlanStep {
  key: string;
  label: string;
  state: "pending" | "active" | "done";
}

export interface TraexTranscriptMainStatus {
  statusTitle?: string;
  planSteps?: TraexTranscriptPlanStep[];
  tokenCount?: number;
}

export interface TraexTranscriptObservation {
  answerDelta: string;
  mainStatus?: TraexTranscriptMainStatus;
}

export type TraexTranscriptUnavailableReason =
  | "missing_session_identity"
  | "unsupported_session_identity"
  | "transcript_not_found"
  | "ambiguous_transcript"
  | "transcript_validation_failed";

export type TraexTranscriptOpenResult =
  | { mode: "typed"; cursor: TraexTranscriptCursorPort }
  | { mode: "unavailable"; reason: TraexTranscriptUnavailableReason };

export interface TraexTranscriptReaderPort {
  open(session: HerdrAgentSession | null | undefined): Promise<TraexTranscriptOpenResult>;
}

export interface BindingStorePort {
  close(): void;
  activateWriteFence(ownerId: string, fencingToken: number): void;
  deactivateWriteFence(): void;
  acquireInstanceLease(ownerId: string, now: string, expiresAt: string): InstanceLease | null;
  renewInstanceLease(ownerId: string, fencingToken: number, now: string, expiresAt: string): InstanceLease | null;
  releaseInstanceLease(ownerId: string, fencingToken: number): boolean;
  recordInboundMessage(message: IncomingLarkMessage): boolean;
  claimNextInboundMessage(): IncomingLarkMessage | null;
  markInboundMessageAccepted(eventId: string): void;
  releaseInboundMessage(eventId: string, error: string): void;
  recoverProcessingInboundMessages(): number;
  isBridgeMessage(messageId: string): boolean;
  recordBridgeMessage(messageId: string): void;
  createPendingBinding(input: {
    id: string;
    projectId?: string | null;
    workspaceId: string;
    chatId: string;
    topicId: string | null;
    rootMessageId: string | null;
    title: string;
    creatorOpenId?: string | null;
  }): Binding;
  createCardInteraction(input: { id: string; bindingId: string; bindingGeneration: number; actorOpenId: string; actionKind: CardInteractionActionKind; parentPromptId: string | null; targetPromptId: string | null; expiresAt: string }): CardInteraction;
  getCardInteraction(id: string): CardInteraction | null;
  consumeCardInteraction(input: { id: string; actorOpenId: string; bindingId: string; bindingGeneration: number; now: string; resultCode: string }): { outcome: "consumed" | "duplicate" | "missing" | "unauthorized" | "expired" | "stale"; interaction: CardInteraction | null };
  convertQueuedPromptToSteering(input: { interactionId: string; actorOpenId: string; bindingId: string; bindingGeneration: number; parentPromptId: string; targetPromptId: string; now: string }): { outcome: "converted" | "duplicate" | "missing" | "unauthorized" | "expired" | "stale"; interaction: CardInteraction | null };
  convertFailedSteeringToTurn(input: { interactionId: string; actorOpenId: string; bindingId: string; bindingGeneration: number; sourcePromptId: string; newPromptId: string; newLarkMessageId: string; now: string; view: RunCardView; rootMessageId: string; answerCardFor(view: RunCardView): object }): { outcome: "converted" | "duplicate" | "missing" | "unauthorized" | "stale"; prompt: PromptJob | null };
  createResetCandidate(input: { oldBindingId: string; newBindingId: string; title: string; actorOpenId: string; resetMessageId: string }): { previous: Binding; replacement: Binding; created: boolean };
  cutoverResetCandidate(input: { oldBindingId: string; newBindingId: string; cleanupOperationId: string; actorOpenId: string; expectedCwd: string }): { previous: Binding; replacement: Binding; cleanup: RetiredPaneCleanupOperation; cancelledPromptIds: string[] };
  listRetiredPaneCleanupOperations(states?: readonly RetiredPaneCleanupOperation["state"][]): RetiredPaneCleanupOperation[];
  claimRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null;
  updateRetiredPaneCleanup(id: string, state: RetiredPaneCleanupOperation["state"], detail?: string | null): RetiredPaneCleanupOperation | null;
  completeRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null;
  createProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; initialPromptText?: string | null; expiresAt: string; card: object }): ProjectSelection;
  getProjectSelection(id: string): ProjectSelection | null;
  claimProjectSelection(input: { selectionId: string; projectId: string; messageId: string; chatId: string; actorOpenId: string; allowedProjectIds: string[] }): ProjectSelectionClaim;
  recoverProcessingProjectSelections(): number;
  listProcessingProjectSelections(): ProjectSelection[];
  listCompletedProjectSelectionsWithInitialPrompt(): ProjectSelection[];
  linkProjectSelectionBinding(id: string, bindingId: string): ProjectSelection;
  pauseProjectSelection(id: string, error: string): ProjectSelection;
  completeProjectSelection(id: string, bindingId: string): ProjectSelection;
  failProjectSelection(id: string, error: string): ProjectSelection;
  createPaneCloseRequest(input: { id: string; bindingId: string; paneId: string; actorOpenId: string; codeHash: string; expiresAt: string }): void;
  consumePaneCloseRequest(input: { bindingId: string; paneId: string; actorOpenId: string; codeHash: string; now: string }):
    | { outcome: "consumed"; operationId: string; paneId: string }
    | { outcome: "invalid" | "unauthorized" | "expired" | "stale" };
  finishPaneCloseRequest(operationId: string, state: "succeeded" | "rejected" | "uncertain", detail?: string): void;
  listUnresolvedPaneCloseOperations(): PaneCloseOperation[];
  updateBinding(id: string, patch: Partial<Binding>): Binding;
  updateBindingMetadata(id: string, patch: BindingMetadataPatch): Binding;
  replaceProvisioningPane(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: HerdrPane }): Binding;
  recordReportedTraexSession(input: { bindingId: string; paneId: string; generation: number; sessionId: string; reportedAt: string }): "recorded" | "duplicate" | "rejected";
  transitionBinding(id: string, transition: SessionTransition): Binding;
  applyRuntimeObservation(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: HerdrPane }): RuntimeObservationApplication;
  reconcileBindingTitleWithProjection(input: BindingTitleProjectionInput): BindingTitleProjectionResult;
  degradeBindingWithProjection(input: RuntimeDegradationInput): RuntimeDegradationResult;
  orphanBindingWithProjection(input: OrphanBindingProjectionInput): OrphanBindingProjectionResult;
  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: BridgeEvent; view: TopicViewState; messageId: string; card: object }): Binding;
  attachBindingPane(id: string, pane: HerdrPane, replacement: boolean): Binding;
  findBindingByTopic(topicId: string): Binding | null;
  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null;
  findBindingByPane(paneId: string): Binding | null;
  getBinding(id: string): Binding | null;
  getPrompt(id: string): PromptJob | null;
  listBindings(): Binding[];
  listBindingsByState(state: Binding["state"]): Binding[];
  listSessions(chatId: string): SessionSummary[];
  listFailures(chatId: string): FailureSummary[];
  countPendingPrompts(bindingId: string): number;
  listQueuedTurnPromptIds(bindingId: string): string[];
  listQueuedTurnRunCards(bindingId: string): RunCardView[];
  listCompletedOrdinaryTurnDurations(bindingId: string, limit: number): number[];
  loadQueueFeedbackInputs(bindingId: string): { activeStartedAt: string | null; queued: RunCardView[]; durationsMs: number[] };
  projectQueuedRunCards(input: {
    bindingId: string;
    projections: Array<{ expectedViewVersion: number; view: RunCardView; card: object | null }>;
  }): { projected: RunCardView[]; stalePromptIds: string[]; outboxReserved: boolean };
  acceptPaneControlOperation(input: { id: string; idempotencyKey: string; bindingId: string; paneId: string; terminalId: string | null; bindingGeneration: number; kind: PaneControlOperationKind; payload?: string | null; parentPromptId?: string | null; actorOpenId: string; sourceMessageId: string }): { operation: PaneControlOperation; inserted: boolean };
  claimNextPaneControlOperation(bindingId?: string): PaneControlOperation | null;
  claimPaneControlOperation(id: string): PaneControlOperation | null;
  claimAppliedPaneControlOperation(id: string): PaneControlOperation | null;
  rejectAppliedPaneControlOperation(id: string, detail: string): PaneControlOperation | null;
  getPaneControlOperation(id: string): PaneControlOperation | null;
  listRecoverablePaneControlOperations(): PaneControlOperation[];
  finishPaneControlOperation(id: string, state: PaneControlOutcome, detail?: string | null): boolean;
  finishPaneControlWithResult(input: {
    operationId: string;
    state: PaneControlOutcome;
    detail?: string | null;
    result: { kind: "card_reply" | "card_update"; targetMessageId: string; idempotencyKey: string; targetRole?: OutboundReply["targetRole"]; card: object };
  }): boolean;
  recoverRunningPrompts(): number;
  scanDurablePromptWork(): DurablePromptWorkScan;
  listDetachedPrompts(): PromptJob[];
  markPromptObservationDetached(id: string, notice: string): void;
  markPromptDispatched(id: string): void;
  recoverLegacyElementIdDeadLetters(): number;
  enqueuePrompt(input: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached">>): { prompt: PromptJob; inserted: boolean };
  acceptPrompt(input: { prompt: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId" | "steeringOrigin" | "sourcePromptId" | "wasDetached">>; view: RunCardView; rootMessageId: string; taskCard?: object; answerCard: object }): { prompt: PromptJob; view: RunCardView; inserted: boolean };
  acceptClassifiedPrompt(input: ClassifiedPromptInput): ClassifiedPromptAcceptance;
  ensureAnswerCard(promptId: string, rootMessageId: string, card: object): void;
  getActiveAnswerPage(promptId: string): AnswerPage | null;
  listAnswerPages(promptId: string): AnswerPage[];
  getAnswerPageDeliveryFacts(promptId: string, pageIndex: number): AnswerPageDeliveryFacts;
  reserveAnswerContent(input: { promptId: string; pageIndex: number; cardId: string; elementId: string; content: string }): AnswerPageReservationOutcome;
  reserveAnswerFinish(input: { promptId: string; pageIndex: number; cardId: string; summary: string }): AnswerPageReservationOutcome;
  reserveAnswerContinuation(input: { promptId: string; pageIndex: number; cardId: string; summary: string; nextPageIndex: number; nextPageStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome;
  reserveAnswerRebuild(input: { promptId: string; pageIndex: number; nextPageIndex: number; sourceStart: number; nextElementId: string; rootMessageId: string; viewVersion: number; card: object }): AnswerPageReservationOutcome;
  reserveFinalAnswerCardUpdate(input: { promptId: string; pageIndex: number; cardId: string; messageId: string; card: object }): AnswerPageReservationOutcome;
  claimNextDispatchablePrompt(bindingId: string): { binding: Binding; prompt: PromptJob } | null;
  claimNextReadySteering(bindingId: string, parentPromptId: string): PromptJob | null;
  failQueuedSteering(bindingId: string, parentPromptId: string, notice: string): string[];
  cancelQueuedPromptsWithProjection(input: {
    bindingId: string;
    reason: string;
    occurredAt: string;
    rootMessageId: string | null;
    renderRunCard(view: RunCardView): object;
  }): { cancelledPromptIds: string[]; outboxReserved: boolean };
  updatePrompt(id: string, state: PromptJob["state"], error?: string | null): void;
  completeTurn(input: { promptId: string; bindingId: string; answer: string; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): Binding;
  failPrompt(input: { promptId: string; error: string; occurredAt: string; steeringFailureKind?: "rejected" | "uncertain" }): void;
  completeSteering(input: { promptId: string; notice: string; occurredAt: string }): void;
  enqueueOutboundReply(input: Omit<OutboundReply, "promptId" | "viewVersion" | "selectionId" | "cardRole" | "targetRole" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "cardIdCheckpoint" | "failureClass" | "httpStatus" | "larkErrorCode" | "autoRecoveryCount" | "deadLetteredAt" | "nextAttemptAt" | "createdAt" | "updatedAt"> & { promptId?: string | null; viewVersion?: number | null; selectionId?: string | null; cardRole?: OutboundReply["cardRole"]; targetRole?: OutboundReply["targetRole"] }): OutboundReply;
  hasPendingAnswerContinuation(promptId: string, pageIndex: number): boolean;
  dismissSupersededAnswerStream(replyId: string): boolean;
  listPendingOutboundReplies(): OutboundReply[];
  listOutboundLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys?: readonly string[]): OutboundReply[];
  getNextOutboundLaneHeadAttemptAt(): string | null;
  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string): void;
  checkpointOutboundReplyCard(id: string, cardId: string): OutboundReply | null;
  markOutboundReplyFailed(id: string, error: string, retryDelayMs?: number, metadata?: DeliveryFailureMetadata): OutboundReply | null;
  markOutboundReplyDeadLetter(id: string, error: string, metadata?: DeliveryFailureMetadata): OutboundReply | null;
  markOutboundReplyFailedWithQuarantine(id: string, error: string, metadata: DeliveryFailureMetadata, retryDelayMs?: number): OutboundFailureTransition | null;
  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[];
  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery;
  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome;
  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome;
  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number;
  getOperationalSummary(): OperationalSummary;
  inspectIntegrity(limit: number, signal?: AbortSignal): SqliteIntegrityInspection;
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  saveTopicView(view: TopicViewState): void;
  loadTopicView(bindingId: string): TopicViewState | null;
  reserveMainCard(view: TopicViewState, rootMessageId: string, card: object): MainCardReservationOutcome;
  saveRunCard(view: RunCardView): RunCardView;
  loadRunCard(promptId: string): RunCardView | null;
  listRunCards(bindingId: string): RunCardView[];
  listRunCardsByPhases(bindingId: string, phases: readonly RunCardView["phase"][]): RunCardView[];
}

export type InboundStore = Pick<BindingStorePort,
  | "claimNextInboundMessage" | "findBindingByLarkScope" | "isBridgeMessage" | "markInboundMessageAccepted"
  | "recordInboundMessage" | "recoverProcessingInboundMessages" | "releaseInboundMessage" | "listCompletedProjectSelectionsWithInitialPrompt" | "getBinding"
>;

export type LeaseStore = Pick<BindingStorePort,
  | "acquireInstanceLease" | "renewInstanceLease" | "releaseInstanceLease"
>;

export type HealthStore = Pick<BindingStorePort, "getOperationalSummary" | "listBindings">;
export interface DatabaseIntegrityStore { inspectIntegrity(limit: number, signal?: AbortSignal): SqliteIntegrityInspection | Promise<SqliteIntegrityInspection> }

export type PromptAcceptanceStore = Pick<BindingStorePort,
  | "acceptPrompt" | "acceptClassifiedPrompt" | "audit" | "countPendingPrompts" | "ensureAnswerCard" | "getOperationalSummary" | "hasPendingAnswerContinuation"
  | "listBindings" | "listRunCards" | "loadTopicView" | "recoverLegacyElementIdDeadLetters" | "recoverStaleOutboxQuarantines" | "reserveMainCard" | "saveRunCard" | "saveTopicView"
>;

export type PromptRunStore = Pick<BindingStorePort,
  | "recoverRunningPrompts"
  | "scanDurablePromptWork"
  | "getBinding"
  | "getPrompt"
  | "claimNextDispatchablePrompt"
  | "claimNextReadySteering"
  | "markPromptDispatched"
  | "markPromptObservationDetached"
  | "failQueuedSteering"
  | "updatePrompt"
  | "completeTurn"
  | "failPrompt"
  | "completeSteering"
  | "updateBindingMetadata"
  | "transitionBinding"
  | "countPendingPrompts"
  | "listQueuedTurnRunCards"
  | "loadRunCard"
  | "loadTopicView"
  | "transitionBindingWithOutbox"
>;

export type RuntimeReconciliationStore = Pick<BindingStorePort,
  | "applyRuntimeObservation"
  | "reconcileBindingTitleWithProjection"
  | "degradeBindingWithProjection"
  | "countPendingPrompts"
  | "findBindingByPane"
  | "loadTopicView"
  | "listBindingsByState"
  | "orphanBindingWithProjection"
  | "transitionBinding"
  | "updateBindingMetadata"
>;

export type BindingProvisioningStore = Pick<BindingStorePort,
  | "attachBindingPane" | "audit" | "claimProjectSelection" | "completeProjectSelection"
  | "countPendingPrompts" | "createPendingBinding" | "createProjectSelection" | "failProjectSelection" | "findBindingByLarkScope"
  | "findBindingByPane" | "getBinding" | "linkProjectSelectionBinding" | "listBindingsByState"
  | "listProcessingProjectSelections" | "loadTopicView" | "pauseProjectSelection" | "recordBridgeMessage"
  | "createResetCandidate" | "cutoverResetCandidate" | "replaceProvisioningPane" | "saveTopicView" | "transitionBinding" | "updateBindingMetadata"
>;

export type RetiredPaneCleanupStore = Pick<BindingStorePort,
  | "claimRetiredPaneCleanup" | "completeRetiredPaneCleanup" | "countPendingPrompts" | "getBinding"
  | "listRetiredPaneCleanupOperations" | "updateRetiredPaneCleanup"
>;

export type OperationsStore = Pick<BindingStorePort,
  | "audit" | "cancelQueuedPromptsWithProjection" | "consumePaneCloseRequest" | "countPendingPrompts" | "createPaneCloseRequest"
  | "acceptPaneControlOperation" | "claimNextPaneControlOperation" | "claimPaneControlOperation" | "finishPaneControlOperation" | "finishPaneControlWithResult" | "getPaneControlOperation" | "listRecoverablePaneControlOperations"
  | "claimAppliedPaneControlOperation" | "rejectAppliedPaneControlOperation"
  | "dismissDeadLetter" | "findBindingByPane" | "finishPaneCloseRequest" | "getBinding" | "listBindings"
  | "listFailures" | "listRunCardsByPhases" | "listSessions" | "listUnresolvedPaneCloseOperations" | "loadTopicView"
  | "retryDeadLetter" | "transitionBinding" | "transitionBindingWithOutbox" | "updateBindingMetadata"
>;

export type AnswerPageStore = Pick<BindingStorePort, "getActiveAnswerPage" | "getAnswerPageDeliveryFacts" | "getBinding" | "listAnswerPages" | "loadRunCard" | "reserveAnswerContent" | "reserveAnswerContinuation" | "reserveAnswerFinish" | "reserveAnswerRebuild" | "reserveFinalAnswerCardUpdate">;
export type MainCardStore = Pick<BindingStorePort, "getBinding" | "loadTopicView" | "reserveMainCard" | "saveTopicView">;

export type ProjectionStore = Pick<BindingStorePort, "getBinding" | "loadRunCard" | "loadTopicView" | "saveRunCard" | "saveTopicView">;
export type QueueFeedbackStore = Pick<BindingStorePort, "listBindings" | "loadQueueFeedbackInputs" | "projectQueuedRunCards">;

export type OutboxStore = Pick<BindingStorePort,
  | "checkpointOutboundReplyCard" | "enqueueOutboundReply" | "getActiveAnswerPage" | "getBinding" | "getNextOutboundLaneHeadAttemptAt" | "getPrompt"
  | "listOutboundLaneHeads" | "loadRunCard" | "markOutboundReplyDelivered" | "markOutboundReplyFailedWithQuarantine"
  | "recoverEligibleDeadLetters" | "recordBridgeMessage" | "dismissSupersededAnswerStream"
>;
export type OutboundIntentStore = Pick<BindingStorePort, "enqueueOutboundReply" | "getActiveAnswerPage" | "getBinding" | "loadRunCard">;

export interface OutboundIntentPort {
  enqueueCard(rootMessageId: string, idempotencyKey: string, card: object, bindingId?: string | null, targetRole?: OutboundReply["targetRole"]): Promise<void>;
  enqueueCardUpdate(bindingId: string | null, messageId: string, eventId: string, card: object): Promise<void>;
  enqueueRunCardUpdate(bindingId: string, promptId: string, messageId: string, viewVersion: number, cardRole: "task" | "answer", card: object): Promise<void>;
  enqueueStreamContent(bindingId: string, promptId: string, cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  enqueueStreamCardCreate(input: { bindingId: string; promptId: string; rootMessageId: string; card: object; pageIndex: number; pageStart: number; elementId: string; viewVersion: number }): Promise<void>;
  enqueueStreamFinish(bindingId: string, promptId: string, cardId: string, summary: string, sequence: number): Promise<void>;
}

export interface OutboundCheckpointSubscriber {
  onAnswerCheckpoint(listener: (promptId: string, viewVersion: number) => void): () => void;
  onMainCardCheckpoint(listener: (bindingId: string, viewVersion: number) => void): () => void;
  requestScan(force?: boolean): Promise<void>;
}

export interface ImmediateOutboundDispatcher {
  requestScan(force?: boolean): Promise<void>;
}

export interface OutboxDispatcherControl {
  start(): () => void;
  stop(): Promise<void>;
  requestScan(force?: boolean): Promise<void>;
  snapshot(): OutboxDispatcherDiagnostics;
}
