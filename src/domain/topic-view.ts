import type { AgentState } from "./types.js";
import type { BridgeEvent } from "./events.js";
import type { RunCardView, RunProgressEvent } from "./run-card-view.js";

export type TopicViewPhase = "provisioning" | "ready" | "queued" | "running" | "blocked" | "done" | "error" | "draining" | "archived" | "orphaned";
export interface TopicViewState {
  bindingId: string; title: string; workspaceId: string; spaceName: string; tabId: string | null; paneId: string | null; worktreeName: string | null; phase: TopicViewPhase;
  agentState: AgentState; queueDepth: number; answer: string | null; notice: string | null; lastEventId: string | null; activePromptId: string | null; recentProgress: RunProgressEvent[]; model: string | null; context: string | null;
  activityAt: string | null;
  viewVersion: number; deliveredVersion: number;
}

export function initialTopicView(bindingId: string): TopicViewState {
  return { bindingId, title: "TraeX task", workspaceId: "unknown", spaceName: "unknown", tabId: null, paneId: null, worktreeName: null, phase: "provisioning",
    agentState: "unknown", queueDepth: 0, answer: null, notice: null, lastEventId: null, activePromptId: null, recentProgress: [], model: null, context: null, activityAt: null, viewVersion: 0, deliveredVersion: 0 };
}

export function reduceTopicView(state: TopicViewState, event: BridgeEvent): TopicViewState {
  const next = reduceTopicViewSnapshot(state, event);
  const updated = updateTopicView(state, next);
  return updated === state ? state : { ...updated, activityAt: event.occurredAt };
}

export function updateTopicView(state: TopicViewState, patch: Partial<TopicViewState>): TopicViewState {
  const next = { ...state, ...patch };
  return sameTopicPresentation(next, state) ? state : { ...next, viewVersion: state.viewVersion + 1, deliveredVersion: state.deliveredVersion };
}

function reduceTopicViewSnapshot(state: TopicViewState, event: BridgeEvent): TopicViewState {
  const base = { ...state, lastEventId: event.eventId };
  switch (event.type) {
    case "BindingCreated": return { ...base, title: event.payload.title, workspaceId: event.payload.workspaceId, spaceName: event.payload.spaceName ?? base.spaceName, tabId: event.payload.tabId ?? base.tabId, paneId: event.payload.paneId, phase: "provisioning" };
    case "BindingActivated": return { ...base, tabId: event.payload.tabId ?? base.tabId, paneId: event.payload.paneId, phase: "ready", notice: null };
    case "BindingRenamed": return { ...base, title: event.payload.title };
    case "BindingDraining": return { ...base, phase: "draining", notice: event.payload.reason };
    case "BindingArchived": return { ...base, phase: "archived", notice: event.payload.reason };
    case "BindingOrphaned": return { ...base, phase: "orphaned", notice: event.payload.reason };
    case "PromptQueued": return base.activePromptId
      ? { ...base, queueDepth: event.payload.queueDepth }
      : { ...base, phase: "queued", queueDepth: event.payload.queueDepth, notice: null };
    case "PromptCancelled": return state;
    case "SteeringQueued": return state;
    case "RunQueuePositionChanged": return state;
    case "TurnStarted": return { ...base, phase: "running", agentState: "working", queueDepth: event.payload.queueDepth, answer: null, notice: null, activePromptId: event.payload.promptId, recentProgress: [] };
    case "SteeringStarted":
    case "SteeringDelivered":
    case "SteeringFailed": return state;
    case "TurnOutputObserved": {
      if (base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      const answer = keepAnswerTail(event.payload.answerSnapshot);
      const recentProgress = event.payload.hasProgressSnapshot
        ? stampProgress(event.payload.progressEvents, event.occurredAt)
        : mergeProgress(base.recentProgress ?? [], event.payload.progressEvents, event.occurredAt);
      const model = event.payload.model ?? state.model;
      const context = event.payload.context ?? state.context;
      if (answer === (state.answer ?? "") && sameVisibleProgress(recentProgress, state.recentProgress ?? []) && state.activePromptId === event.payload.promptId && model === state.model && context === state.context) return state;
      return { ...base, activePromptId: event.payload.promptId, answer, recentProgress, model, context };
    }
    case "PaneOutputObserved": {
      const answer = event.payload.answer === undefined ? state.answer : keepAnswerTail(event.payload.answer);
      const model = event.payload.model ?? state.model;
      const context = event.payload.context ?? state.context;
      const tabId = event.payload.tabId ?? state.tabId;
      const worktreeName = event.payload.worktreeName ?? state.worktreeName;
      if (answer === state.answer && model === state.model && context === state.context && tabId === state.tabId && worktreeName === state.worktreeName) return state;
      if (event.payload.answer !== undefined && state.activePromptId === null && state.phase !== "running" && state.phase !== "blocked") {
        return { ...base, phase: "done", agentState: "done", answer, model, context, tabId, worktreeName, notice: null };
      }
      return { ...base, answer, model, context, tabId, worktreeName };
    }
    case "AgentStateChanged":
      if (event.payload.promptId && base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      return { ...base, phase: event.payload.state === "blocked" ? "blocked" : event.payload.state === "working" ? "running" : base.phase, agentState: event.payload.state, queueDepth: event.payload.queueDepth, activePromptId: event.payload.promptId ?? base.activePromptId, notice: event.payload.state === "blocked" ? "TraeX 需要人工审批。请查看对应 Herdr panel 并完成所需交互。" : base.notice };
    case "TurnCompleted":
      if (base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      return { ...base, phase: "done", agentState: "done", queueDepth: event.payload.queueDepth, answer: keepAnswerTail(event.payload.answer), notice: null, activePromptId: null };
    case "TurnFailed":
      if (base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      return { ...base, phase: "error", queueDepth: event.payload.queueDepth, notice: event.payload.error, activePromptId: null };
  }
}

export function mirrorRunCardToTopic(state: TopicViewState, run: RunCardView): TopicViewState {
  const phase = { queued: "queued", running: "running", blocked: "blocked", completed: "done", failed: "error" }[run.phase] as TopicViewPhase;
  return updateTopicView(state, {
    ...state, phase, queueDepth: run.queuePosition, answer: run.answer ? keepAnswerTail(run.answer) : null, notice: run.notice,
    activePromptId: run.phase === "running" || run.phase === "blocked" ? run.promptId : null,
    agentState: run.phase === "running" ? "working" : run.phase === "blocked" ? "blocked" : run.phase === "completed" ? "done" : state.agentState,
    recentProgress: run.progressEvents, activityAt: run.updatedAt
  });
}

function mergeProgress(current: RunProgressEvent[], updates: Omit<RunProgressEvent, "occurredAt">[], occurredAt: string): RunProgressEvent[] {
  if (updates.length === 0) return current;
  const result = [...current];
  const positions = new Map(result.map((item, index) => [item.key, index]));
  for (const update of updates) {
    const event = { ...update, occurredAt };
    const position = positions.get(event.key);
    if (position === undefined) {
      positions.set(event.key, result.length);
      result.push(event);
    } else result[position] = event;
  }
  return result;
}

function stampProgress(updates: Omit<RunProgressEvent, "occurredAt">[], occurredAt: string): RunProgressEvent[] {
  return updates.map((update) => ({ ...update, occurredAt }));
}

function sameVisibleProgress(left: RunProgressEvent[], right: RunProgressEvent[]): boolean {
  return left.length === right.length && left.every((event, index) => {
    const other = right[index];
    return other !== undefined && event.key === other.key && event.kind === other.kind && event.label === other.label && event.state === other.state;
  });
}

function sameTopicPresentation(left: TopicViewState, right: TopicViewState): boolean {
  return left.title === right.title && left.workspaceId === right.workspaceId && left.spaceName === right.spaceName
    && left.tabId === right.tabId && left.paneId === right.paneId && left.worktreeName === right.worktreeName
    && left.phase === right.phase && left.agentState === right.agentState && left.queueDepth === right.queueDepth
    && left.answer === right.answer && left.notice === right.notice && left.activePromptId === right.activePromptId
    && left.model === right.model && left.context === right.context
    && sameVisibleProgress(left.recentProgress, right.recentProgress);
}

function keepAnswerTail(answer: string): string { return answer.slice(-2_500); }
