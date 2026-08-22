import type { AgentState, Binding, HerdrPane, IncomingLarkMessage, PromptJob } from "./types.js";
import type { TopicViewState } from "./topic-view.js";

export interface LarkPort {
  start(onMessage: (message: IncomingLarkMessage) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
  isReady(): boolean;
  createTopic(card: object): Promise<{ topicId: string; rootMessageId: string }>;
  replyCard(rootMessageId: string, card: object): Promise<{ messageId: string }>;
  updateCard(messageId: string, card: object): Promise<void>;
}

export interface HerdrPort {
  assertWorkspace(workspaceId: string): Promise<void>;
  listPanes(workspaceId: string): Promise<HerdrPane[]>;
  getPane(paneId: string): Promise<HerdrPane | null>;
  createPane(workspaceId: string, cwd: string): Promise<HerdrPane>;
  startTraex(paneId: string, executable: string): Promise<void>;
  runPrompt(paneId: string, text: string, timeoutMs: number): Promise<AgentState>;
  readOutput(paneId: string, lines: number): Promise<string>;
  renamePane(paneId: string, title: string): Promise<void>;
}

export interface BindingStorePort {
  close(): void;
  hasProcessedEvent(eventId: string): boolean;
  recordProcessedEvent(eventId: string, messageId: string): void;
  isBridgeMessage(messageId: string): boolean;
  recordBridgeMessage(messageId: string): void;
  createPendingBinding(input: {
    id: string;
    workspaceId: string;
    chatId: string;
    topicId: string | null;
    rootMessageId: string | null;
    title: string;
  }): Binding;
  updateBinding(id: string, patch: Partial<Binding>): Binding;
  findBindingByTopic(topicId: string): Binding | null;
  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null;
  findBindingByPane(paneId: string): Binding | null;
  listBindings(): Binding[];
  countPendingPrompts(bindingId: string): number;
  recoverRunningPrompts(): number;
  enqueuePrompt(input: Omit<PromptJob, "state" | "attemptCount" | "error" | "createdAt" | "updatedAt">): PromptJob;
  claimNextPrompt(bindingId: string): PromptJob | null;
  updatePrompt(id: string, state: PromptJob["state"], error?: string | null): void;
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  saveTopicView(view: TopicViewState): void;
  loadTopicView(bindingId: string): TopicViewState | null;
}
