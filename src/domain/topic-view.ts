import type { AgentState } from "./types.js";
import type { BridgeEvent } from "./events.js";

export type TopicViewPhase = "provisioning" | "queued" | "running" | "blocked" | "done" | "error" | "archived" | "orphaned";
export interface TopicViewState {
  bindingId: string; title: string; workspaceId: string; spaceName: string; paneId: string | null; phase: TopicViewPhase;
  agentState: AgentState; queueDepth: number; answer: string | null; notice: string | null; lastEventId: string | null;
}

export function initialTopicView(bindingId: string): TopicViewState {
  return { bindingId, title: "TraeX task", workspaceId: "unknown", spaceName: "unknown", paneId: null, phase: "provisioning",
    agentState: "unknown", queueDepth: 0, answer: null, notice: null, lastEventId: null };
}

export function reduceTopicView(state: TopicViewState, event: BridgeEvent): TopicViewState {
  const base = { ...state, lastEventId: event.eventId };
  switch (event.type) {
    case "BindingCreated": return { ...base, title: event.payload.title, workspaceId: event.payload.workspaceId, spaceName: event.payload.spaceName ?? base.spaceName, paneId: event.payload.paneId, phase: "provisioning" };
    case "BindingActivated": return { ...base, paneId: event.payload.paneId, phase: "done", notice: null };
    case "BindingRenamed": return { ...base, title: event.payload.title };
    case "BindingArchived": return { ...base, phase: "archived", notice: event.payload.reason };
    case "BindingOrphaned": return { ...base, phase: "orphaned", notice: event.payload.reason };
    case "PromptQueued": return { ...base, phase: "queued", queueDepth: event.payload.queueDepth, notice: null };
    case "SteeringQueued": return state;
    case "RunQueuePositionChanged": return state;
    case "TurnStarted": return { ...base, phase: "running", agentState: "working", queueDepth: event.payload.queueDepth, answer: null, notice: null };
    case "SteeringStarted":
    case "SteeringDelivered":
    case "SteeringFailed": return state;
    case "TurnOutputObserved": return state;
    case "AgentStateChanged": return { ...base, phase: event.payload.state === "blocked" ? "blocked" : event.payload.state === "working" ? "running" : base.phase, agentState: event.payload.state, queueDepth: event.payload.queueDepth };
    case "TurnCompleted": return { ...base, phase: "done", agentState: "done", queueDepth: event.payload.queueDepth, answer: event.payload.answer, notice: null };
    case "TurnFailed": return { ...base, phase: "error", queueDepth: event.payload.queueDepth, notice: event.payload.error };
  }
}
