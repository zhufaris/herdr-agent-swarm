export type BindingState = "pending" | "active" | "archived" | "orphaned" | "failed";
export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";
export type EventOrigin = "lark" | "herdr" | "bridge";
export type PromptState = "queued" | "running" | "delivered" | "failed";
export type PromptDispatchKind = "turn" | "steering";
export type OutboundReplyState = "pending" | "delivered" | "dead_letter";
export type OutboundReplyKind = "text" | "card_reply" | "card_update";
export type RequestCardRole = "task" | "answer";
export type ProjectSelectionState = "pending" | "processing" | "completed" | "failed" | "expired";

export interface ProjectConfig {
  id: string;
  displayName: string;
  spaceName?: string | undefined;
  description: string;
  workspaceId: string;
  cwd: string;
}

export interface IncomingLarkCardAction {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  value: unknown;
}

export interface Binding {
  id: string;
  projectId: string | null;
  workspaceId: string;
  chatId: string;
  topicId: string | null;
  rootMessageId: string | null;
  paneId: string | null;
  traexSessionId: string | null;
  title: string;
  runtime: "traex";
  state: BindingState;
  statusMessageId: string | null;
  lastAgentState: AgentState;
  lastOutputFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PromptJob {
  id: string;
  bindingId: string;
  larkMessageId: string;
  actorOpenId: string;
  body: string;
  dispatchKind: PromptDispatchKind;
  parentPromptId: string | null;
  state: PromptState;
  attemptCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboundReply {
  id: string;
  idempotencyKey: string;
  bindingId: string | null;
  promptId: string | null;
  viewVersion: number | null;
  selectionId: string | null;
  cardRole: RequestCardRole | null;
  rootMessageId: string;
  kind: OutboundReplyKind;
  payload: string;
  state: OutboundReplyState;
  attemptCount: number;
  error: string | null;
  deliveredMessageId: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalSummary {
  bindings: Record<BindingState, number>;
  prompts: Record<PromptState, number>;
  promptDispatch: Record<PromptDispatchKind, number>;
  outbound: Record<OutboundReplyState, number>;
  pendingOutbox: number;
  deadLetters: number;
  oldestPendingAt: string | null;
  recentFailedPrompt: { promptId: string; bindingId: string; updatedAt: string; error: string } | null;
  recentDeadLetter: { replyId: string; bindingId: string | null; promptId: string | null; attemptCount: number; updatedAt: string; error: string } | null;
}

export interface ProjectSelection {
  id: string;
  commandMessageId: string;
  selectorMessageId: string | null;
  chatId: string;
  topicId: string | null;
  rootMessageId: string;
  actorOpenId: string;
  requestedTitle: string | null;
  selectedProjectId: string | null;
  bindingId: string | null;
  state: ProjectSelectionState;
  error: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ProjectSelectionClaim =
  | { outcome: "claimed" | "processing" | "completed"; selection: ProjectSelection }
  | { outcome: "missing" | "invalid" | "unauthorized" | "expired"; selection: ProjectSelection | null };

export interface HerdrPane {
  paneId: string;
  workspaceId: string;
  cwd: string | null;
  label: string | null;
  agentState: AgentState;
  foregroundExecutables: string[];
}

export interface IncomingLarkMessage {
  eventId: string;
  messageId: string;
  chatId: string;
  topicId: string | null;
  rootMessageId: string | null;
  actorOpenId: string;
  text: string;
  mentionsBot: boolean;
  isRootMessage: boolean;
}

export type BridgeCommand =
  | { kind: "new"; title: string | null }
  | { kind: "projects" }
  | { kind: "status" }
  | { kind: "rename"; title: string }
  | { kind: "close" }
  | { kind: "help" };
