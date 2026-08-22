export type BindingState = "pending" | "active" | "archived" | "orphaned" | "failed";
export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";
export type EventOrigin = "lark" | "herdr" | "bridge";
export type PromptState = "queued" | "running" | "delivered" | "failed";

export interface Binding {
  id: string;
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
  state: PromptState;
  attemptCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

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
  | { kind: "new"; title: string }
  | { kind: "status" }
  | { kind: "rename"; title: string }
  | { kind: "close" }
  | { kind: "help" };
