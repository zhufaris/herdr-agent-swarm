import type { AgentState } from "./types.js";
import type { BridgeEvent } from "./events.js";
import type { RunCardView } from "./run-card-view.js";

export type TopicViewPhase = "provisioning" | "queued" | "running" | "blocked" | "done" | "error" | "archived" | "orphaned";
export interface TopicViewState {
  bindingId: string; title: string; workspaceId: string; spaceName: string; paneId: string | null; phase: TopicViewPhase;
  agentState: AgentState; queueDepth: number; answer: string | null; notice: string | null; lastEventId: string | null; activePromptId: string | null; latestProgress: string | null;
}

export function initialTopicView(bindingId: string): TopicViewState {
  return { bindingId, title: "TraeX task", workspaceId: "unknown", spaceName: "unknown", paneId: null, phase: "provisioning",
    agentState: "unknown", queueDepth: 0, answer: null, notice: null, lastEventId: null, activePromptId: null, latestProgress: null };
}

export function reduceTopicView(state: TopicViewState, event: BridgeEvent): TopicViewState {
  const base = { ...state, lastEventId: event.eventId };
  switch (event.type) {
    case "BindingCreated": return { ...base, title: event.payload.title, workspaceId: event.payload.workspaceId, spaceName: event.payload.spaceName ?? base.spaceName, paneId: event.payload.paneId, phase: "provisioning" };
    case "BindingActivated": return { ...base, paneId: event.payload.paneId, phase: "done", notice: null };
    case "BindingRenamed": return { ...base, title: event.payload.title };
    case "BindingArchived": return { ...base, phase: "archived", notice: event.payload.reason };
    case "BindingOrphaned": return { ...base, phase: "orphaned", notice: event.payload.reason };
    case "PromptQueued": return base.activePromptId
      ? { ...base, queueDepth: event.payload.queueDepth }
      : { ...base, phase: "queued", queueDepth: event.payload.queueDepth, notice: null };
    case "SteeringQueued": return state;
    case "RunQueuePositionChanged": return state;
    case "TurnStarted": return { ...base, phase: "running", agentState: "working", queueDepth: event.payload.queueDepth, answer: null, notice: null, activePromptId: event.payload.promptId, latestProgress: "🧠 正在分析请求" };
    case "SteeringStarted":
    case "SteeringDelivered":
    case "SteeringFailed": return state;
    case "TurnOutputObserved":
      if (base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      return { ...base, activePromptId: event.payload.promptId, answer: (base.answer ?? "") + event.payload.answerDelta, latestProgress: progressSummary(event.payload.progressEvents) ?? base.latestProgress };
    case "AgentStateChanged":
      if (event.payload.promptId && base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      return { ...base, phase: event.payload.state === "blocked" ? "blocked" : event.payload.state === "working" ? "running" : base.phase, agentState: event.payload.state, queueDepth: event.payload.queueDepth, activePromptId: event.payload.promptId ?? base.activePromptId, notice: event.payload.state === "blocked" ? "TraeX 需要人工审批。请查看对应 Herdr panel 并完成所需交互。" : base.notice };
    case "TurnCompleted":
      if (base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      return { ...base, phase: "done", agentState: "done", queueDepth: event.payload.queueDepth, answer: event.payload.answer, notice: null, activePromptId: null };
    case "TurnFailed":
      if (base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      return { ...base, phase: "error", queueDepth: event.payload.queueDepth, notice: event.payload.error, activePromptId: null };
  }
}

export function mirrorRunCardToTopic(state: TopicViewState, run: RunCardView): TopicViewState {
  const phase = { queued: "queued", running: "running", blocked: "blocked", completed: "done", failed: "error" }[run.phase] as TopicViewPhase;
  const latest = run.progressEvents.at(-1);
  return {
    ...state, phase, queueDepth: run.queuePosition, answer: run.answer || null, notice: run.notice,
    activePromptId: run.phase === "running" || run.phase === "blocked" ? run.promptId : null,
    agentState: run.phase === "running" ? "working" : run.phase === "blocked" ? "blocked" : run.phase === "completed" ? "done" : state.agentState,
    latestProgress: latest ? progressSummary([latest]) : run.phase === "running" ? "🧠 正在分析请求" : null
  };
}

function progressSummary(events: Extract<BridgeEvent, { type: "TurnOutputObserved" }>["payload"]["progressEvents"]): string | null {
  const event = events.at(-1);
  if (!event) return null;
  if (event.state === "failed") return `❌ ${event.label}`;
  if (event.kind === "test" && event.state === "done") return `✅ ${event.label}`;
  return `${{ analyze: "🧠", search: "🔍", read: "📖", edit: "✏️", test: "🧪" }[event.kind]} ${event.label}`;
}
