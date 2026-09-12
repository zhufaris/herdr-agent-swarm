import type { Binding, BindingMetadataPatch, CardInteraction, CardInteractionActionKind, DeadLetterActionOutcome, ExternalTurnAdoption, ExternalTurnSupersessionFence, FailureSummary, HerdrAgentSession, IncomingLarkMessage, OutboundWorkClass, PaneCloseOperation, PaneControlOperation, PaneControlOperationKind, ProjectSelection, PromptJob, SessionOperation, SessionOperationKind, SessionOperationState, SessionSummary, StaleOutboxQuarantineRecovery } from "../types.js";
import type { TopicViewState } from "../topic-view.js";
import type { SessionTransition } from "../pane-thread-lifecycle.js";
import type { PaneControlOutcome } from "../pane-control-lifecycle.js";
import type { BridgeEvent } from "../events.js";
import type { RunCardView } from "../run-card-view.js";
import type { ModelPreference } from "../model-selection.js";
import type { AcceptPromptInput } from "./prompt.js";

export interface OperationsQueryStore {
  listBindings(): Binding[];
  loadTopicView(bindingId: string): TopicViewState | null;
  listFailures(chatId: string): FailureSummary[];
  listSessions(chatId: string): SessionSummary[];
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
  ensureAnswerCard(promptId: string, rootMessageId: string, card: object, workClass?: OutboundWorkClass): void;
  listBindings(): Binding[];
  listRunCards(bindingId: string): RunCardView[];
  loadTopicView(bindingId: string): TopicViewState | null;
  retireUndeliveredWorkerTaskCardIntents(): number;
  recoverStaleOutboxQuarantines(): StaleOutboxQuarantineRecovery;
  saveRunCard(view: RunCardView): RunCardView;
}

/** Durable inbox operations. Claim/release remains owned by the single SQLite
 * transaction store; this port only defines the dispatcher capability. */
export interface InboundMessageDispatchStore {
  claimNextInboundMessage(): IncomingLarkMessage | null;
  isBridgeMessage(messageId: string): boolean;
  markInboundMessageAccepted(eventId: string): void;
  recordInboundMessage(message: IncomingLarkMessage): boolean;
  recoverProcessingInboundMessages(): number;
  releaseInboundMessage(eventId: string, error: string): void;
}

export interface DeliveryRecoveryStore {
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  dismissDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome;
  getBinding(id: string): Binding | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  listFailures(chatId: string): FailureSummary[];
  reservePaneThreadAlias(input: { publicationKey: string; actionMessageId: string; bindingId: string; bindingGeneration: number; paneId: string; sourceMainMessageId: string; targetChatId: string; card: object }): "reserved" | "duplicate" | "stale";
  retryDeadLetter(id: string, chatId: string, actorOpenId: string): DeadLetterActionOutcome;
}

export interface CardInteractionStore {
  countPendingPrompts(bindingId: string): number;
  createCardInteraction(input: { id: string; bindingId: string; bindingGeneration: number; actorOpenId: string; actionKind: CardInteractionActionKind; parentPromptId: string | null; targetPromptId: string | null; expiresAt: string }): CardInteraction;
  getBinding(id: string): Binding | null;
  getCardInteraction(id: string): CardInteraction | null;
  acceptInterruptedContinuation(input: { interactionId: string; parentPromptId: string; sourceAnswerMessageId: string; expectedBindingGeneration: number; actorOpenId: string; accepted: AcceptPromptInput }): { prompt: PromptJob; view: RunCardView; inserted: boolean };
  getPrompt(id: string): PromptJob | null;
  loadRunCard(promptId: string): RunCardView | null;
  loadTopicView(bindingId: string): TopicViewState | null;
}

export interface AdoptExternalTurnInput {
  bindingId: string; expectedGeneration: number; expectedPaneId: string; expectedSession: HerdrAgentSession;
  turnId: string; startedAt: string; requestText: string; externalPromptId: string; externalMessageId: string;
  supersede?: ExternalTurnSupersessionFence; externalView: RunCardView; answerCardFor(view: RunCardView): object;
}

export interface ExternalTurnObservationStore {
  adoptExternalTurn(input: AdoptExternalTurnInput): ExternalTurnAdoption;
  completeTurn(input: { promptId: string; bindingId: string; answer: string; occurredAt: string; outputFingerprint: string; replaceAnswer?: boolean }): Binding;
  countPendingPrompts(bindingId: string): number;
  failPrompt(input: { promptId: string; error: string; occurredAt: string }): void;
  findBindingByPane(paneId: string): Binding | null;
  getActiveExternalPrompt(bindingId: string, expectedGeneration: number): PromptJob | null;
  getBinding(id: string): Binding | null;
  getPrompt(id: string): PromptJob | null;
  listBindingsByState(state: Binding["state"]): Binding[];
}

export interface SessionOperationStore {
  acceptSessionOperation(input: { id: string; idempotencyKey: string; interactionId: string; actorOpenId: string; bindingId: string; bindingGeneration: number; expectedPaneId: string | null; expectedTerminalId: string | null; kind: SessionOperationKind; argument: string | null; now: string }): { outcome: "accepted" | "duplicate" | "missing" | "unauthorized" | "expired" | "stale"; operation: SessionOperation | null };
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
  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: BridgeEvent; view: TopicViewState; messageId: string; card: object }): Binding;
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
