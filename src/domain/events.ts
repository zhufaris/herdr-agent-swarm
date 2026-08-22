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
  | EventBase<"BindingCreated", { title: string; workspaceId: string; spaceName?: string; paneId: string | null }>
  | EventBase<"BindingActivated", { paneId: string; topicId: string }>
  | EventBase<"BindingRenamed", { title: string }>
  | EventBase<"BindingDraining", { reason: string }>
  | EventBase<"BindingArchived", { reason: string }>
  | EventBase<"BindingOrphaned", { reason: string }>
  | EventBase<"PromptQueued", { promptId: string; queueDepth: number; actorOpenId: string }>
  | EventBase<"PromptCancelled", { promptId: string; reason: string }>
  | EventBase<"SteeringQueued", { promptId: string; parentPromptId: string; actorOpenId: string }>
  | EventBase<"RunQueuePositionChanged", { promptId: string; queuePosition: number }>
  | EventBase<"TurnStarted", { promptId: string; queueDepth: number }>
  | EventBase<"SteeringStarted", { promptId: string; parentPromptId: string }>
  | EventBase<"SteeringDelivered", { promptId: string; parentPromptId: string }>
  | EventBase<"SteeringFailed", { promptId: string; parentPromptId: string; error: string }>
  | EventBase<"AgentStateChanged", { state: AgentState; queueDepth: number; promptId?: string }>
  | EventBase<"TurnOutputObserved", { promptId: string; answerDelta: string; progressEvents: Omit<RunProgressEvent, "occurredAt">[]; hasProgressSnapshot?: boolean }>
  | EventBase<"TurnCompleted", { promptId: string; answer: string; queueDepth: number }>
  | EventBase<"TurnFailed", { promptId: string; error: string; queueDepth: number }>;

export interface InboundMessageReceivedEvent {
  eventId: string;
  type: "InboundMessageReceived";
  origin: "lark";
  occurredAt: string;
  payload: IncomingLarkMessage;
}
