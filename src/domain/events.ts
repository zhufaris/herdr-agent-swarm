import type { AgentState, EventOrigin, IncomingLarkMessage } from "./types.js";
import type { RunProgressEvent } from "./run-card-view.js";

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
  | EventBase<"RunQueuePositionChanged", { promptId: string; queuePosition: number }>
  | EventBase<"TurnStarted", { promptId: string; queueDepth: number }>
  | EventBase<"AgentStateChanged", { state: AgentState; queueDepth: number; promptId?: string }>
  | EventBase<"TurnOutputObserved", { promptId: string; answerDelta: string; progressEvents: Omit<RunProgressEvent, "occurredAt">[] }>
  | EventBase<"TurnCompleted", { promptId: string; answer: string; queueDepth: number }>
  | EventBase<"TurnFailed", { promptId: string; error: string; queueDepth: number }>;

export interface InboundMessageReceivedEvent {
  eventId: string;
  type: "InboundMessageReceived";
  origin: "lark";
  occurredAt: string;
  payload: IncomingLarkMessage;
}
