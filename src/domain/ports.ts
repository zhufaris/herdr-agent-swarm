import type { AgentState, Binding, HerdrPane, IncomingLarkCardAction, IncomingLarkMessage, OperationalSummary, OutboundReply, ProjectSelection, ProjectSelectionClaim, PromptJob } from "./types.js";
import type { TopicViewState } from "./topic-view.js";
import type { RunCardView } from "./run-card-view.js";

export interface LarkPort {
  start(onMessage: (message: IncomingLarkMessage) => Promise<void>, onCardAction?: (action: IncomingLarkCardAction) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  createTopic(card: object): Promise<{ topicId: string; rootMessageId: string }>;
  replyText(rootMessageId: string, text: string): Promise<{ messageId: string }>;
  replyCard(rootMessageId: string, card: object): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
}

export interface HerdrPort {
  assertWorkspace(workspaceId: string): Promise<void>;
  listPanes(workspaceId: string): Promise<HerdrPane[]>;
  getPane(paneId: string): Promise<HerdrPane | null>;
  createPane(workspaceId: string, cwd: string): Promise<HerdrPane>;
  startTraex(paneId: string, executable: string): Promise<void>;
  runPrompt(
    paneId: string,
    text: string,
    timeoutMs: number,
    onObservation?: (observation: { state: AgentState; output: string }) => void | Promise<void>
  ): Promise<AgentState>;
  steerPrompt?(paneId: string, text: string): Promise<"injected" | "not_working">;
  readOutput(paneId: string, lines: number): Promise<string>;
  renamePane(paneId: string, title: string): Promise<void>;
}

export interface BindingStorePort {
  close(): void;
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
  completeProjectSelection(id: string, bindingId: string): ProjectSelection;
  failProjectSelection(id: string, error: string): ProjectSelection;
  updateBinding(id: string, patch: Partial<Binding>): Binding;
  findBindingByTopic(topicId: string): Binding | null;
  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null;
  findBindingByPane(paneId: string): Binding | null;
  listBindings(): Binding[];
  countPendingPrompts(bindingId: string): number;
  listQueuedTurnPromptIds(bindingId: string): string[];
  recoverRunningPrompts(): number;
  enqueuePrompt(input: Omit<PromptJob, "state" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId">>): { prompt: PromptJob; inserted: boolean };
  acceptPrompt(input: { prompt: Omit<PromptJob, "state" | "attemptCount" | "error" | "createdAt" | "updatedAt" | "dispatchKind" | "parentPromptId"> & Partial<Pick<PromptJob, "dispatchKind" | "parentPromptId">>; view: RunCardView; rootMessageId: string; taskCard: object; answerCard: object }): { prompt: PromptJob; view: RunCardView; inserted: boolean };
  ensureAnswerCard(promptId: string, rootMessageId: string, card: object): void;
  claimNextPrompt(bindingId: string): PromptJob | null;
  claimNextReadyPrompt(bindingId: string): PromptJob | null;
  claimNextReadySteering(bindingId: string, parentPromptId: string): PromptJob | null;
  requeueSteeringAsTurn(promptId: string): void;
  requeueQueuedSteering(bindingId: string, parentPromptId: string): number;
  updatePrompt(id: string, state: PromptJob["state"], error?: string | null): void;
  enqueueOutboundReply(input: Omit<OutboundReply, "promptId" | "viewVersion" | "selectionId" | "cardRole" | "state" | "attemptCount" | "error" | "deliveredMessageId" | "nextAttemptAt" | "createdAt" | "updatedAt"> & { promptId?: string | null; viewVersion?: number | null; selectionId?: string | null; cardRole?: OutboundReply["cardRole"] }): OutboundReply;
  listPendingOutboundReplies(): OutboundReply[];
  listDueOutboundReplies(): OutboundReply[];
  markOutboundReplyDelivered(id: string, messageId: string): void;
  markOutboundReplyFailed(id: string, error: string): OutboundReply | null;
  getOperationalSummary(): OperationalSummary;
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  saveTopicView(view: TopicViewState): void;
  loadTopicView(bindingId: string): TopicViewState | null;
  saveRunCard(view: RunCardView): RunCardView;
  loadRunCard(promptId: string): RunCardView | null;
  listRunCards(bindingId: string): RunCardView[];
}
