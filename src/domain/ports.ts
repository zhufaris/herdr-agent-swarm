import type { AgentState, Binding, DeadLetterActionOutcome, FailureSummary, HerdrPane, IncomingLarkCardAction, IncomingLarkMessage, InstanceLease, OperationalSummary, OutboundReply, PaneCloseOperation, ProjectSelection, ProjectSelectionClaim, PromptJob, SessionSummary } from "./types.js";
import type { TopicViewState } from "./topic-view.js";
import type { RunCardView } from "./run-card-view.js";
import type { SessionTransition } from "./pane-thread-lifecycle.js";
import type { BridgeEvent } from "./events.js";

export interface LarkPort {
  start(onMessage: (message: IncomingLarkMessage) => Promise<void>, onCardAction?: (action: IncomingLarkCardAction) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  createTopic(card: object, idempotencyKey?: string): Promise<{ topicId: string; rootMessageId: string }>;
  replyText(rootMessageId: string, text: string): Promise<{ messageId: string }>;
  replyCard(rootMessageId: string, card: object): Promise<{ messageId: string }>;
  replyStreamingCard?(rootMessageId: string, card: object): Promise<{ messageId: string; cardId: string }>;
  streamCardContent?(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  finishStreamingCard?(cardId: string, sequence: number, summary: string): Promise<void>;
  shareThread(topicOrRootMessageId: string, chatId: string): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
}

export interface HerdrPort {
  assertWorkspace(workspaceId: string): Promise<void>;
  listAllPanes?(): Promise<HerdrPane[]>;
  listPanes(workspaceId: string, options?: { forceRefresh?: boolean }): Promise<HerdrPane[]>;
  getPane(paneId: string): Promise<HerdrPane | null>;
  observeBoundPane?(paneId: string): Promise<HerdrPane | null>;
  createPane(workspaceId: string, cwd: string, options?: {
    bindingId: string;
    generation: number;
    projectId: string;
    title?: string;
    placement?: "split" | "dedicated-tab";
  }): Promise<HerdrPane>;
  startTraex(paneId: string, executable: string): Promise<void>;
  runPrompt(
    paneId: string,
    text: string,
    timeoutMs: number,
    onObservation?: (observation: { state: AgentState; output: string }) => void | Promise<void>,
    signal?: AbortSignal,
    onDispatched?: () => void | Promise<void>
  ): Promise<AgentState>;
  runPaneCommand?(paneId: string, command: string, timeoutMs: number): Promise<string>;
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
  listBindings(): Binding[];
  listBindingsByState(state: Binding["state"]): Binding[];
  listSessions(chatId: string): SessionSummary[];
  listFailures(chatId: string): FailureSummary[];
  countPendingPrompts(bindingId: string): number;
  listQueuedTurnPromptIds(bindingId: string): string[];
  recoverRunningPrompts(): number;
  listDetachedPrompts(): PromptJob[];
  markPromptObservationDetached(id: string, notice: string): void;
  markPromptDispatched(id: string): void;
  enqueuePrompt(input: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId">>): { prompt: PromptJob; inserted: boolean };
  acceptPrompt(input: { prompt: Omit<PromptJob, "state" | "observationState" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId">>; view: RunCardView; rootMessageId: string; taskCard?: object; answerCard: object }): { prompt: PromptJob; view: RunCardView; inserted: boolean };
  ensureAnswerCard(promptId: string, rootMessageId: string, card: object): void;
  claimNextPrompt(bindingId: string): PromptJob | null;
  claimNextReadyPrompt(bindingId: string): PromptJob | null;
  claimNextReadySteering(bindingId: string, parentPromptId: string): PromptJob | null;
  requeueSteeringAsTurn(promptId: string): void;
  requeueQueuedSteering(bindingId: string, parentPromptId: string): number;
  cancelQueuedPrompts(bindingId: string, reason: string): number;
  updatePrompt(id: string, state: PromptJob["state"], error?: string | null): void;
  enqueueOutboundReply(input: Omit<OutboundReply, "promptId" | "viewVersion" | "selectionId" | "cardRole" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "nextAttemptAt" | "createdAt" | "updatedAt"> & { promptId?: string | null; viewVersion?: number | null; selectionId?: string | null; cardRole?: OutboundReply["cardRole"] }): OutboundReply;
  listPendingOutboundReplies(): OutboundReply[];
  listDueOutboundReplies(): OutboundReply[];
  markOutboundReplyDelivered(id: string, messageId: string, cardId?: string): void;
  markOutboundReplyFailed(id: string, error: string): OutboundReply | null;
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
