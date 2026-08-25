import type { AgentState, Binding, DeadLetterActionOutcome, DeliveryFailureMetadata, DurablePromptWorkScan, FailureSummary, HerdrPane, HerdrPaneCreationOptions, IncomingLarkCardAction, IncomingLarkMessage, InstanceLease, OperationalSummary, OutboundReply, OutboxDispatcherDiagnostics, PaneCloseOperation, PaneControlOperation, PaneControlOperationKind, ProjectSelection, ProjectSelectionClaim, PromptJob, RetiredPaneCleanupOperation, RuntimeObservation, RuntimeTurnObservation, SessionSummary } from "./types.js";
import type { TopicViewState } from "./topic-view.js";
import type { RunCardView } from "./run-card-view.js";
import type { SessionTransition } from "./pane-thread-lifecycle.js";
import type { BridgeEvent } from "./events.js";

export interface LarkPort {
  start(onMessage: (message: IncomingLarkMessage) => Promise<void>, onCardAction?: (action: IncomingLarkCardAction) => Promise<void>): Promise<void>;
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
  startTraex(paneId: string, executable: string): Promise<void>;
  runPrompt(
    paneId: string,
    text: string,
    timeoutMs: number,
    onObservation?: (observation: RuntimeTurnObservation) => void | Promise<void>,
    signal?: AbortSignal,
    onDispatched?: () => void | Promise<void>
  ): Promise<AgentState>;
  runPaneCommand?(paneId: string, command: string, timeoutMs: number): Promise<string>;
  beginPaneModelSelection?(paneId: string, model: string, timeoutMs: number): Promise<{ kind: "mode_required"; modes: string[] } | { kind: "composer_ready" }>;
  completePaneModelMode?(paneId: string, mode: string, timeoutMs: number): Promise<void>;
  sendEscape?(paneId: string): Promise<void>;
  steerPrompt?(paneId: string, text: string): Promise<"injected" | "not_working">;
  readOutput(paneId: string, lines: number): Promise<string>;
  renamePane(paneId: string, title: string, options?: { tabTitle?: string }): Promise<void>;
  closePane(paneId: string): Promise<void>;
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
  }): Binding;
  createResetCandidate(input: { oldBindingId: string; newBindingId: string; title: string; actorOpenId: string; resetMessageId: string }): { previous: Binding; replacement: Binding; created: boolean };
  cutoverResetCandidate(input: { oldBindingId: string; newBindingId: string; cleanupOperationId: string; actorOpenId: string; expectedCwd: string }): { previous: Binding; replacement: Binding; cleanup: RetiredPaneCleanupOperation; cancelledPromptIds: string[] };
  listRetiredPaneCleanupOperations(states?: readonly RetiredPaneCleanupOperation["state"][]): RetiredPaneCleanupOperation[];
  claimRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null;
  updateRetiredPaneCleanup(id: string, state: RetiredPaneCleanupOperation["state"], detail?: string | null): RetiredPaneCleanupOperation | null;
  completeRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null;
  createProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; expiresAt: string; card: object }): ProjectSelection;
  getProjectSelection(id: string): ProjectSelection | null;
  claimProjectSelection(input: { selectionId: string; projectId: string; messageId: string; chatId: string; actorOpenId: string; allowedProjectIds: string[] }): ProjectSelectionClaim;
  recoverProcessingProjectSelections(): number;
  listProcessingProjectSelections(): ProjectSelection[];
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
  transitionBinding(id: string, transition: SessionTransition): Binding;
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
  acceptPaneControlOperation(input: { id: string; idempotencyKey: string; bindingId: string; paneId: string; terminalId: string | null; bindingGeneration: number; kind: PaneControlOperationKind; payload?: string | null; parentPromptId?: string | null; actorOpenId: string; sourceMessageId: string }): { operation: PaneControlOperation; inserted: boolean };
  claimNextPaneControlOperation(bindingId?: string): PaneControlOperation | null;
  claimPaneControlOperation(id: string): PaneControlOperation | null;
  claimAppliedPaneControlOperation(id: string): PaneControlOperation | null;
  rejectAppliedPaneControlOperation(id: string, detail: string): PaneControlOperation | null;
  getPaneControlOperation(id: string): PaneControlOperation | null;
  listRecoverablePaneControlOperations(): PaneControlOperation[];
  finishPaneControlOperation(id: string, state: Extract<PaneControlOperation["state"], "applied" | "confirmed" | "rejected" | "failed" | "uncertain">, detail?: string | null): void;
  recoverRunningPrompts(): number;
  scanDurablePromptWork(): DurablePromptWorkScan;
  listDetachedPrompts(): PromptJob[];
  markPromptObservationDetached(id: string, notice: string): void;
  markPromptDispatched(id: string): void;
  recoverLegacyElementIdDeadLetters(): number;
  enqueuePrompt(input: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId">>): { prompt: PromptJob; inserted: boolean };
  acceptPrompt(input: { prompt: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId">>; view: RunCardView; rootMessageId: string; taskCard?: object; answerCard: object }): { prompt: PromptJob; view: RunCardView; inserted: boolean };
  ensureAnswerCard(promptId: string, rootMessageId: string, card: object): void;
  claimNextDispatchablePrompt(bindingId: string): { binding: Binding; prompt: PromptJob } | null;
  claimNextReadySteering(bindingId: string, parentPromptId: string): PromptJob | null;
  failQueuedSteering(bindingId: string, parentPromptId: string, notice: string): string[];
  cancelQueuedPrompts(bindingId: string, reason: string): number;
  updatePrompt(id: string, state: PromptJob["state"], error?: string | null): void;
  completeTurn(input: { promptId: string; bindingId: string; answer: string; occurredAt: string; outputFingerprint: string }): Binding;
  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void;
  completeSteering(input: { promptId: string; notice: string; occurredAt: string }): void;
  enqueueOutboundReply(input: Omit<OutboundReply, "promptId" | "viewVersion" | "selectionId" | "cardRole" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "cardIdCheckpoint" | "failureClass" | "httpStatus" | "larkErrorCode" | "autoRecoveryCount" | "deadLetteredAt" | "nextAttemptAt" | "createdAt" | "updatedAt"> & { promptId?: string | null; viewVersion?: number | null; selectionId?: string | null; cardRole?: OutboundReply["cardRole"] }): OutboundReply;
  listPendingOutboundReplies(): OutboundReply[];
  listOutboundLaneHeads(limit: number, dueAt: string | null, excludedLaneKeys?: readonly string[]): OutboundReply[];
  getNextOutboundLaneHeadAttemptAt(): string | null;
  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string): void;
  checkpointOutboundReplyCard(id: string, cardId: string): OutboundReply | null;
  markOutboundReplyFailed(id: string, error: string, retryDelayMs?: number, metadata?: DeliveryFailureMetadata): OutboundReply | null;
  markOutboundReplyDeadLetter(id: string, error: string, metadata?: DeliveryFailureMetadata): OutboundReply | null;
  recoverEligibleDeadLetters(cutoff: string, limit: number): OutboundReply[];
  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome;
  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome;
  getOperationalSummary(): OperationalSummary;
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  saveTopicView(view: TopicViewState): void;
  loadTopicView(bindingId: string): TopicViewState | null;
  saveRunCard(view: RunCardView): RunCardView;
  loadRunCard(promptId: string): RunCardView | null;
  listRunCards(bindingId: string): RunCardView[];
  listRunCardsByPhases(bindingId: string, phases: readonly RunCardView["phase"][]): RunCardView[];
}

export type InboundStore = Pick<BindingStorePort,
  | "claimNextInboundMessage" | "findBindingByLarkScope" | "isBridgeMessage" | "markInboundMessageAccepted"
  | "recordInboundMessage" | "recoverProcessingInboundMessages" | "releaseInboundMessage"
>;

export type LeaseStore = Pick<BindingStorePort,
  | "acquireInstanceLease" | "renewInstanceLease" | "releaseInstanceLease"
>;

export type HealthStore = Pick<BindingStorePort, "getOperationalSummary" | "listBindings">;

export type PromptAcceptanceStore = Pick<BindingStorePort,
  | "acceptPrompt" | "audit" | "countPendingPrompts" | "ensureAnswerCard" | "getOperationalSummary"
  | "listBindings" | "listRunCards" | "loadTopicView" | "recoverLegacyElementIdDeadLetters" | "saveRunCard" | "saveTopicView"
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
  | "updateBinding"
  | "transitionBinding"
  | "countPendingPrompts"
  | "listQueuedTurnPromptIds"
  | "listRunCards"
  | "loadRunCard"
  | "loadTopicView"
  | "transitionBindingWithOutbox"
>;

export type RuntimeReconciliationStore = Pick<BindingStorePort,
  | "countPendingPrompts"
  | "findBindingByPane"
  | "listBindingsByState"
  | "listRunCardsByPhases"
  | "saveRunCard"
  | "transitionBinding"
  | "updateBinding"
>;

export type BindingProvisioningStore = Pick<BindingStorePort,
  | "attachBindingPane" | "audit" | "claimProjectSelection" | "completeProjectSelection"
  | "countPendingPrompts" | "createPendingBinding" | "createProjectSelection" | "failProjectSelection" | "findBindingByLarkScope"
  | "findBindingByPane" | "getBinding" | "linkProjectSelectionBinding" | "listBindings"
  | "listProcessingProjectSelections" | "loadTopicView" | "pauseProjectSelection" | "recordBridgeMessage"
  | "createResetCandidate" | "cutoverResetCandidate" | "saveTopicView" | "transitionBinding" | "updateBinding"
>;

export type RetiredPaneCleanupStore = Pick<BindingStorePort,
  | "claimRetiredPaneCleanup" | "completeRetiredPaneCleanup" | "countPendingPrompts" | "getBinding"
  | "listRetiredPaneCleanupOperations" | "updateRetiredPaneCleanup"
>;

export type OperationsStore = Pick<BindingStorePort,
  | "audit" | "cancelQueuedPrompts" | "consumePaneCloseRequest" | "countPendingPrompts" | "createPaneCloseRequest"
  | "acceptPaneControlOperation" | "claimNextPaneControlOperation" | "claimPaneControlOperation" | "finishPaneControlOperation" | "getPaneControlOperation" | "listRecoverablePaneControlOperations"
  | "claimAppliedPaneControlOperation" | "rejectAppliedPaneControlOperation"
  | "dismissDeadLetter" | "findBindingByPane" | "finishPaneCloseRequest" | "getBinding" | "listBindings"
  | "listFailures" | "listRunCards" | "listSessions" | "listUnresolvedPaneCloseOperations" | "loadTopicView"
  | "retryDeadLetter" | "transitionBinding" | "transitionBindingWithOutbox" | "updateBinding"
>;

export type ProjectionStore = Pick<BindingStorePort, "getBinding" | "loadRunCard" | "loadTopicView" | "saveRunCard" | "saveTopicView">;

export type OutboxStore = Pick<BindingStorePort,
  | "checkpointOutboundReplyCard" | "enqueueOutboundReply" | "getBinding" | "getNextOutboundLaneHeadAttemptAt" | "getPrompt"
  | "listOutboundLaneHeads" | "loadRunCard" | "markOutboundReplyDeadLetter" | "markOutboundReplyDelivered"
  | "markOutboundReplyFailed" | "recoverEligibleDeadLetters" | "recordBridgeMessage" | "updateBinding"
>;
export type OutboundIntentStore = Pick<BindingStorePort, "enqueueOutboundReply" | "getBinding" | "loadRunCard">;

export interface OutboundIntentPort {
  enqueueCard(rootMessageId: string, idempotencyKey: string, card: object, bindingId?: string | null): Promise<void>;
  enqueueCardUpdate(bindingId: string | null, messageId: string, eventId: string, card: object): Promise<void>;
  enqueueRunCardUpdate(bindingId: string, promptId: string, messageId: string, viewVersion: number, cardRole: "task" | "answer", card: object): Promise<void>;
  enqueueStreamContent(bindingId: string, promptId: string, cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  enqueueStreamCardCreate(input: { bindingId: string; promptId: string; rootMessageId: string; card: object; pageIndex: number; pageStart: number; elementId: string; viewVersion: number }): Promise<void>;
  enqueueStreamFinish(bindingId: string, promptId: string, cardId: string, summary: string, sequence: number): Promise<void>;
}

export interface OutboundCheckpointSubscriber {
  onStreamCardCreated(listener: (promptId: string, viewVersion: number) => void): () => void;
}

export interface OutboxDispatcherControl {
  start(): () => void;
  stop(): Promise<void>;
  requestScan(force?: boolean): Promise<void>;
  snapshot(): OutboxDispatcherDiagnostics;
}
