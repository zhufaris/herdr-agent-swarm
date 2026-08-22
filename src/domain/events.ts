import type { AgentState, EventOrigin } from "./types.js";

interface EventBase<T extends string, P> {
  eventId: string;
  bindingId: string;
  type: T;
  origin: EventOrigin;
  occurredAt: string;
  payload: P;
}

export type BridgeEvent =
  | EventBase<"BindingCreated", { title: string; workspaceId: string; paneId: string | null }>
  | EventBase<"BindingActivated", { paneId: string; topicId: string }>
  | EventBase<"BindingRenamed", { title: string }>
  | EventBase<"BindingArchived", { reason: string }>
  | EventBase<"BindingOrphaned", { reason: string }>
  | EventBase<"PromptQueued", { promptId: string; queueDepth: number; actorOpenId: string }>
  | EventBase<"TurnStarted", { promptId: string; queueDepth: number }>
  | EventBase<"AgentStateChanged", { state: AgentState; queueDepth: number }>
  | EventBase<"TurnCompleted", { promptId: string; answer: string; queueDepth: number }>
  | EventBase<"TurnFailed", { promptId: string; error: string; queueDepth: number }>;
