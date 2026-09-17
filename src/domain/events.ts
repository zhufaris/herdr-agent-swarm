import type { AgentState, EventOrigin, IncomingLarkMessage } from "./types.js";
import type { AgentKind } from "./agent-instance.js";
import type { MainCardLiveStatus, RunProgressEvent } from "./run-card-view.js";

interface EventBase<T extends string, P> {
  eventId: string;
  bindingId: string;
  type: T;
  origin: EventOrigin;
  occurredAt: string;
  payload: P;
}

export interface TurnOutputObservation {
  answer: {
    snapshot: string;
    previousSnapshot?: string;
    update?: "append" | "replace" | "replace-status" | "replace-all";
    toolActivities: Omit<RunProgressEvent, "occurredAt">[];
    hasToolActivitySnapshot?: boolean;
  };
  main: {
    status?: Partial<Omit<MainCardLiveStatus, "planSteps">> & { planSteps?: Omit<RunProgressEvent, "occurredAt">[] };
    model?: string;
    context?: string;
  };
}

export function normalizeTurnOutputObservation(payload: unknown): TurnOutputObservation {
  const value = payload as {
    observation?: TurnOutputObservation; answerSnapshot?: string; previousAnswerSnapshot?: string; answerUpdate?: TurnOutputObservation["answer"]["update"];
    progressEvents?: TurnOutputObservation["answer"]["toolActivities"]; hasProgressSnapshot?: boolean; mainStatus?: TurnOutputObservation["main"]["status"]; model?: string; context?: string;
  };
  if (value.observation) return value.observation;
  return {
    answer: {
      snapshot: value.answerSnapshot ?? "",
      ...(value.previousAnswerSnapshot === undefined ? {} : { previousSnapshot: value.previousAnswerSnapshot }),
      ...(value.answerUpdate === undefined ? {} : { update: value.answerUpdate }),
      toolActivities: value.progressEvents ?? [],
      ...(value.hasProgressSnapshot === undefined ? {} : { hasToolActivitySnapshot: value.hasProgressSnapshot })
    },
    main: {
      ...(value.mainStatus ? { status: value.mainStatus } : {}),
      ...(value.model ? { model: value.model } : {}),
      ...(value.context ? { context: value.context } : {})
    }
  };
}

export type BridgeEvent =
  | EventBase<"BindingCreated", { title: string; workspaceId: string; spaceName?: string; tabId?: string | null; paneId: string | null; agentKind?: AgentKind }>
  | EventBase<"BindingActivated", { paneId: string; tabId?: string | null; topicId: string }>
  | EventBase<"PrimaryToolAvailabilityChanged", { available: boolean; reason: string | null }>
  | EventBase<"BindingRenamed", { title: string }>
  | EventBase<"BindingDraining", { reason: string }>
  | EventBase<"BindingArchived", { reason: string }>
  | EventBase<"BindingDegraded", { reason: string }>
  | EventBase<"BindingOrphaned", { reason: string }>
  | EventBase<"PromptQueued", { promptId: string; queueDepth: number; actorOpenId: string }>
  | EventBase<"PromptCancelled", { promptId: string; reason: string }>
  | EventBase<"RunQueuePositionChanged", { promptId: string; queuePosition: number }>
  | EventBase<"TurnStarted", { promptId: string; queueDepth: number }>
  | EventBase<"AgentStateChanged", { state: AgentState; queueDepth: number; promptId?: string }>
  | EventBase<"TurnOutputObserved", { promptId: string; observation: TurnOutputObservation }>
  | EventBase<"PaneOutputObserved", { observation?: TurnOutputObservation; answer?: string; model?: string; context?: string; tabId?: string | null; worktreeName?: string | null }>
  | EventBase<"TurnCompleted", { promptId: string; answer: string; queueDepth: number }>
  | EventBase<"TurnFailed", { promptId: string; error: string; queueDepth: number }>;

export interface InboundMessageReceivedEvent {
  eventId: string;
  type: "InboundMessageReceived";
  origin: "lark";
  occurredAt: string;
  payload: IncomingLarkMessage;
}
