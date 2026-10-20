import type { Binding, BindingMetadataPatch, CardInteraction, CardInteractionActionKind, DeadLetterActionOutcome, ExternalTurnAdoption, ExternalTurnSupersessionFence, FailureSummary, HerdrAgentSession, IncomingLarkMessage, OutboundWorkClass, PaneCloseOperation, PaneControlOperation, PaneControlOperationKind, ProjectSelection, PromptJob, SessionOperation, SessionOperationState, SessionPage, StaleOutboxQuarantineRecovery } from "../types.js";
import type { ConversationTurnIdentity, ConversationTurnProjection } from "../conversation-turn-projection.js";
import type { CoreEventProjectionSettlement } from "../core-event-inbox.js";
import type { RunCardView } from "../run-card-view.js";
import type { AgentInstance, WorkspaceLease } from "../agent-instance.js";
import type { TopicViewState } from "../topic-view.js";
import type { SessionTransition } from "../pane-thread-lifecycle.js";
import type { PaneControlOutcome } from "../pane-control-lifecycle.js";
import type { BridgeEvent } from "../events.js";
import type { ModelPreference } from "../model-selection.js";

export interface OperationsQueryStore {
  listBindings(): Binding[];
  listWorkerInstancesByParent(input: { bindingId: string; paneId: string }): AgentInstance[];
  getWorkspaceLease(id: string): WorkspaceLease | null;
  resolveCanonicalWorkerThreadId(input: { chatId: string; workerId: string; runtimeGeneration: number; workerSessionGeneration: number; parentBindingId: string; parentBindingGeneration: number; parentPaneId: string; sourceMainMessageId: string }): string | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  listFailures(chatId: string): FailureSummary[];
  listSessions(chatId: string, cursor?: string | null): SessionPage;
}

export interface InboundRoutingStore {
  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null;
  isBindingThreadAlias(topicId: string | null, rootMessageId: string | null): boolean;
  getBinding(id: string): Binding | null;
  isBridgeMessage(messageId: string): boolean;
  listCompletedProjectSelectionsWithInitialPrompt(): ProjectSelection[];
}

export interface StartupRecoveryStore {
  getBinding(id: string): Binding | null;
  listCompletedProjectSelectionsWithInitialPrompt(): ProjectSelection[];
  recoverLegacyElementIdDeadLetters(): number;
}

export interface StartupViewStore {
  getBinding(id: string): Binding | null;
  getPromptProjectionState(id: string): Pick<PromptJob, "state" | "error"> | null;
  ensureAnswerCard(promptId: string, rootMessageId: string, card: object, workClass?: OutboundWorkClass): void;
  listStartupViewBindings(bindingIds?: readonly string[]): Binding[];
  listActionableStartupRunCards(bindingId: string): RunCardView[];
  loadStartupMainRunCard(bindingId: string, preferredPromptId: string | null): RunCardView | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  listAnswerPages(promptId: string): import("../types.js").AnswerPage[];
  retireUndeliveredWorkerTaskCardIntents(): number;
  recoverDeliveredCompletionReviews(): { activated: number; alreadyActive: number; alreadyTerminal: number; invalid: number };
  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery;
  dismissEligibleLegacyCompletionNotifications(bindingIds?: readonly string[]): number;
  saveRunCard(view: RunCardView): RunCardView;
}

/** Durable inbox operations. Claim/release remains owned by the single SQLite
 * transaction store; this port only defines the dispatcher capability. */
export interface InboundMessageDispatchStore {
  claimNextInboundMessage(excludedScopeKeys?: readonly string[]): IncomingLarkMessage | null;
  isBridgeMessage(messageId: string): boolean;
  deferInboundMessage(eventId: string): void;
  markInboundMessageAccepted(eventId: string): void;
  recordInboundMessage(message: IncomingLarkMessage): boolean;
  recoverProcessingInboundMessages(): number;
  releaseInboundMessage(eventId: string, error: string): void;
}

export interface DeliveryRecoveryStore {
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  dismissDeadLetter(id: string, chatId: string, actorOpenId: string, sourceMessageId?: string): DeadLetterActionOutcome;
  getBinding(id: string): Binding | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  listFailures(chatId: string): FailureSummary[];
  resolveCanonicalWorkerThread(input: { chatId: string; workerId: string; runtimeGeneration: number; workerSessionGeneration: number; parentBindingId: string; parentBindingGeneration: number; parentPaneId: string; sourceMainMessageId: string }): { conversationId: string; rootMessageId: string } | null;
  reservePaneThreadAlias(input: { publicationKey: string; actionMessageId: string; bindingId: string; bindingGeneration: number; paneId: string; sourceMainMessageId: string; targetChatId: string; viewVersion: number; card: object; recovery?: { kind: "primary-answer"; promptId: string; pageIndex: number } | { kind: "worker-task"; workerTurnId: string; pageIndex: number } }): "reserved" | "duplicate" | "stale";
  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome;
}

export type PrimaryCompletionReviewDecision =
  | ({ ownerKind: "primary-segment" } & import("./conversation-segment.js").PrimarySegmentCompletionReviewDecision)
  | ({ ownerKind: "primary-prompt" } & ({ kind: "ignored"; promptId: string; changed: boolean } | { kind: "submission"; promptId: string; submissionId: string; inserted: boolean }));

export interface CardInteractionStore {
  getCompletionReviewOwnerKind(actionSetId: string): "primary-segment" | "primary-prompt" | "worker-turn" | null;
  decidePrimaryCompletionReview(input: { actionSetId: string; optionId: string; messageId: string; actorOpenId: string; chatId: string; occurredAt: string }): PrimaryCompletionReviewDecision;
  countPendingPrompts(bindingId: string): number;
  createCardInteraction(input: { id: string; bindingId: string; bindingGeneration: number; actorOpenId: string; actionKind: CardInteractionActionKind; parentPromptId: string | null; targetPromptId: string | null; expiresAt: string }): CardInteraction;
  getBinding(id: string): Binding | null;
  getCardInteraction(id: string): CardInteraction | null;
  getPrompt(id: string): PromptJob | null;
  loadRunCard(promptId: string): RunCardView | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  acceptPrimarySegmentCompletionChoice(input: { actionSetId: string; optionId: string; ownerSegmentId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string; chatId: string; occurredAt: string }): import("./conversation-segment.js").PrimarySegmentCompletionChoiceResult;
  ignorePrimarySegmentCompletionChoice(input: { actionSetId: string; ownerSegmentId: string; ownerGeneration: number; cardMessageId: string; actorOpenId: string; chatId: string; occurredAt: string }): import("../completion-action-set.js").CompletionActionIgnoreResult;
}

export interface AdoptExternalTurnInput {
  bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: HerdrAgentSession;
  turnId: string; startedAt: string; requestText: string; requestSubmissionId?: string; externalPromptId: string; externalMessageId: string;
  supersede?: ExternalTurnSupersessionFence; externalView: RunCardView; answerCardFor(view: RunCardView): object;
}

export interface ExternalTurnObservationStore {
  loadConversationTurnProjection(identity: ConversationTurnIdentity): ConversationTurnProjection | null;
  projectConversationTurn(input: {
    identity: ConversationTurnIdentity;
    origin: "herdr" | "feishu";
    bindingId: string;
    expectedGeneration: number;
    expectedPaneId: string;
    supersede?: ExternalTurnSupersessionFence;
    view: RunCardView;
    settlement?: CoreEventProjectionSettlement;
    answerCardFor(view: RunCardView): object;
    mainCardFor(view: import("../topic-view.js").TopicViewState): object;
    paneEntryCardFor(view: import("../topic-view.js").TopicViewState): object;
  }): { outcome: "projected" | "duplicate" | "stale"; projection: ConversationTurnProjection | null; supersededPromptIds: string[]; outboxReserved: boolean };
  replaceAuthoritativeTurnSnapshot(input: Parameters<import("../core-event-inbox.js").AuthoritativeTurnSnapshotStore["replaceAuthoritativeTurnSnapshot"]>[0]): ReturnType<import("../core-event-inbox.js").AuthoritativeTurnSnapshotStore["replaceAuthoritativeTurnSnapshot"]>;
  adoptExternalTurn(input: AdoptExternalTurnInput): ExternalTurnAdoption;
  completeTurn(input: Parameters<import("./prompt-run.js").PromptDispatchStore["completeTurn"]>[0]): import("./prompt-run.js").PrimaryCompletionResult;
  countPendingPrompts(bindingId: string): number;
  failExternalTurnWithoutTerminalEvent(input: { promptId: string; bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: HerdrAgentSession; expectedObservedAt: string; turnId: string; startedAt: string; error: string; occurredAt: string }): boolean;
  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void;
  findBindingByPane(paneId: string): Binding | null;
  getActiveBridgePrompt(bindingId: string, expectedGeneration: number): PromptJob | null;
  getActiveExternalPrompt(bindingId: string, expectedGeneration: number): PromptJob | null;
  repairProjectedExternalTurn(input: { promptId: string; bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: HerdrAgentSession; turnId: string; startedAt: string; occurredAt: string }):
    | { outcome: "repaired"; terminalState: "completed"; answer: string; completionActionEligibility?: import("../completion-action-eligibility.js").CompletionActionEligibilityReservation }
    | { outcome: "repaired"; terminalState: "aborted"; error: string }
    | { outcome: "not_found" | "ambiguous" | "stale" };
  isExternalTurnRecoveryDue(input: { promptId: string; bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: HerdrAgentSession; turnId: string; startedAt: string; now: string }): boolean;
  deferExternalTurnRecovery(input: { promptId: string; bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: HerdrAgentSession; turnId: string; startedAt: string; failureCode: string; occurredAt: string; runtimeObservedAt?: string | null }): { attemptCount: number; nextAttemptAt: string; recoveryState: "waiting" | "indexing" | "not_found" | "ambiguous" | "transient"; runtimeObservationAdvanced: boolean; shouldLog: boolean } | null;
  correctExternalTurnStartedAt(input: { promptId: string; bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: HerdrAgentSession; turnId: string; expectedStartedAt: string; canonicalStartedAt: string; occurredAt: string }): { promptId: string } | null;
  clearExternalTurnRecovery(promptId: string): void;
  getBinding(id: string): Binding | null;
  getPrompt(id: string): PromptJob | null;
  listBindingsByState(state: Binding["state"]): Binding[];
  getCurrentGoal(bindingId: string): import("../current-goal.js").CurrentGoal | null;
  observePrimaryPromptState(input: import("../human-review.js").PrimaryPromptStateObservationInput): import("../human-review.js").PrimaryPromptStateObservationResult;
}

export interface SessionOperationStore {
  claimNextSessionOperation(bindingId?: string): SessionOperation | null;
  finishSessionOperation(id: string, state: Extract<SessionOperationState, "succeeded" | "rejected" | "failed" | "uncertain">, detail?: string | null): SessionOperation | null;
  getBinding(id: string): Binding | null;
  listRecoverableSessionOperations(): SessionOperation[];
}

export interface ModelSelectionStore {
  acceptModelPreference(input: { bindingId: string; bindingGeneration: number; model: string }): { outcome: "accepted" | "busy" | "stale"; preference: ModelPreference | null };
  getModelPreference(bindingId: string): ModelPreference | null;
  acceptPaneControlOperation(input: { id: string; idempotencyKey: string; bindingId: string; paneId: string; terminalId: string | null; bindingGeneration: number; kind: PaneControlOperationKind; payload?: string | null; parentPromptId?: string | null; actorOpenId: string; sourceMessageId: string }): { operation: PaneControlOperation; inserted: boolean };
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  finishPaneControlOperation(id: string, state: PaneControlOutcome, detail?: string | null): boolean;
  getBinding(id: string): Binding | null;
  getPaneControlOperation(id: string): PaneControlOperation | null;
  listRecoverablePaneControlOperations(): PaneControlOperation[];
  rejectAppliedPaneControlOperation(id: string, detail: string): PaneControlOperation | null;
}

export interface SessionAdministrationStore {
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  cancelQueuedPromptsWithProjection(input: { bindingId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): { cancelledPromptIds: string[]; outboxReserved: boolean };
  countPendingPrompts(bindingId: string): number;
  loadTopicView(bindingId: string): TopicViewState | null;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: BridgeEvent; view: TopicViewState; messageId: string; card: object; paneEntryCard: object }): Binding;
  updateBindingMetadata(id: string, patch: BindingMetadataPatch): Binding;
}

export interface PaneRetentionStore {
  countPendingPrompts(bindingId: string): number;
  createAutomaticPaneCloseOperation(input: { id: string; bindingId: string; paneId: string; now: string }): void;
  finishPaneCloseRequest(operationId: string, state: "succeeded" | "rejected" | "uncertain", detail?: string): void;
  getBinding(id: string): Binding | null;
  listBindings(): Binding[];
  listUnresolvedPaneCloseOperations(): PaneCloseOperation[];
  transitionBinding(id: string, transition: SessionTransition): Binding;
}
