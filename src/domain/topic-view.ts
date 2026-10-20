import type { AgentState } from "./types.js";
import type { BridgeEvent } from "./events.js";
import { normalizeTurnOutputObservation } from "./events.js";
import { EMPTY_PROGRESS_SUMMARY, mergeRecentProgress, progressSnapshot, type MainCardLiveStatus, type RunCardView, type RunProgressEvent, type RunProgressSummary } from "./run-card-view.js";
import { sameAnswerTimeline, type AnswerTimelineItem } from "./answer-timeline.js";
import type { PrimaryWorkerSummary } from "./card-context-summary.js";
import type { ModelPreferenceSnapshot, ModelPreferenceState } from "./model-selection.js";
import type { AgentKind } from "./agent-instance.js";
import { sameCardTargetRef, type CardTargetRef } from "./card-target-ref.js";
import { reduceCurrentGoal, sameCurrentGoal, type CurrentGoal, type GoalChange } from "./current-goal.js";
import type { NativeInputBacklog } from "./native-input-batch.js";
import { createPaneIdentitySnapshot, samePaneIdentity, type PaneIdentitySnapshot } from "./worker-main-view.js";
import type { Binding } from "./binding.js";
export type { PaneIdentitySnapshot } from "./worker-main-view.js";

const TOPIC_ANSWER_TAIL_LIMIT = 9_000;
const MAX_PENDING_PROMPT_QUEUE_TIMES = 32;

export type TopicViewPhase = "provisioning" | "ready" | "queued" | "running" | "blocked" | "done" | "error" | "degraded" | "draining" | "archived" | "orphaned";
export interface TopicModelPreference { model: string; revision: number; state: ModelPreferenceState; }
export interface ModelUsageSnapshot {
  model: string | null; contextRemainingPercent: number | null; inputTokens: number | null; outputTokens: number | null;
  queuedAt: string | null; firstVisibleAt: string | null; completedAt: string | null; waitMs: number | null; firstVisibleMs: number | null;
}
export interface TopicSessionIdentity {
  bindingGeneration: number; sessionEpoch: number; nativeSessionId: string | null; paneId: string | null; rootMessageId: string | null;
}
export interface TopicViewState {
  bindingId: string; bindingGeneration: number; title: string; agentKind: AgentKind; workspaceId: string; spaceName: string; tabId: string | null; paneId: string | null; paneToken?: string | null; paneName?: string | null; workspace?: string | null; worktreeName: string | null; branch?: string | null; paneIdentity?: PaneIdentitySnapshot; phase: TopicViewPhase;
  agentState: AgentState; queueDepth: number; answer: string | null; notice: string | null; lastEventId: string | null; activePromptId: string | null; recentProgress: RunProgressEvent[]; progressSummary: RunProgressSummary; model: string | null; context: string | null;
  modelUsage: ModelUsageSnapshot;
  pendingPromptQueuedAt: Record<string, string>;
  nativeInputBacklog: NativeInputBacklog;
  timelineItems: AnswerTimelineItem[];
  currentGoal: CurrentGoal | null;
  modelPreference: TopicModelPreference | null;
  liveStatus: MainCardLiveStatus | null;
  currentAnswer: CardTargetRef | null;
  primaryToolsAvailable: boolean | null; primaryToolsNotice: string | null;
  workers: PrimaryWorkerSummary[]; workerOverflowCount: number; workerDependencyRevision: number;
  sessionIdentity: TopicSessionIdentity | null;
  sessionActivityRevision: number;
  activityAt: string | null;
  viewVersion: number; deliveredVersion: number;
}

export function initialTopicView(bindingId: string): TopicViewState {
  const paneIdentity = createPaneIdentitySnapshot();
  return { bindingId, bindingGeneration: 1, title: "Agent task", agentKind: "traex", workspaceId: "unknown", spaceName: "unknown", tabId: null, paneId: null, paneToken: null, paneName: null, workspace: null, worktreeName: null, branch: null, paneIdentity, phase: "provisioning",
    agentState: "unknown", queueDepth: 0, answer: null, notice: null, lastEventId: null, activePromptId: null, recentProgress: [], progressSummary: { ...EMPTY_PROGRESS_SUMMARY }, nativeInputBacklog: { unbatchedInputCount: 0, pendingBatchCount: 0 }, timelineItems: [], currentGoal: null, model: null, context: null, modelUsage: emptyModelUsage(), pendingPromptQueuedAt: {}, modelPreference: null, liveStatus: null, currentAnswer: null, primaryToolsAvailable: null, primaryToolsNotice: null, workers: [], workerOverflowCount: 0, workerDependencyRevision: 0, sessionIdentity: null, sessionActivityRevision: 0, activityAt: null, viewVersion: 0, deliveredVersion: 0 };
}

export function topicSessionIdentityFor(binding: Pick<Binding, "generation" | "sessionEpoch" | "agentSessionKind" | "agentSessionValue" | "paneId" | "rootMessageId">): TopicSessionIdentity {
  return {
    bindingGeneration: binding.generation,
    sessionEpoch: binding.sessionEpoch,
    nativeSessionId: binding.agentSessionKind === "id" ? binding.agentSessionValue ?? null : null,
    paneId: binding.paneId,
    rootMessageId: binding.rootMessageId
  };
}

export function updateTopicSessionIdentity(state: TopicViewState, binding: Pick<Binding, "generation" | "sessionEpoch" | "agentSessionKind" | "agentSessionValue" | "paneId" | "rootMessageId">): TopicViewState {
  const sessionIdentity = topicSessionIdentityFor(binding);
  return sameTopicSessionIdentity(state.sessionIdentity, sessionIdentity) ? state : { ...state, sessionIdentity };
}

export function applyTopicGoalChanges(state: TopicViewState, changes: readonly GoalChange[], expectedNativeSessionId?: string): TopicViewState {
  let currentGoal = state.currentGoal;
  for (const change of changes) {
    if (expectedNativeSessionId && change.nativeSessionId !== expectedNativeSessionId) continue;
    currentGoal = reduceCurrentGoal(currentGoal, change);
  }
  return sameCurrentGoal(currentGoal, state.currentGoal) ? state : updateTopicView(state, { currentGoal });
}

export function updateTopicCurrentAnswer(state: TopicViewState, currentAnswer: CardTargetRef | null): TopicViewState {
  return sameCardTargetRef(state.currentAnswer, currentAnswer) ? state : { ...state, currentAnswer, viewVersion: state.viewVersion + 1 };
}

export function updateTopicModelPreference(state: TopicViewState, snapshot: ModelPreferenceSnapshot): TopicViewState {
  const projected = snapshot.desired ?? (snapshot.state === "effective" ? snapshot.effective : null);
  const modelPreference = projected && snapshot.state !== "none" ? { model: projected.model, revision: projected.revision, state: snapshot.state } : null;
  return updateTopicView(state, { modelPreference });
}

export function updateTopicWorkerContext(state: TopicViewState, workers: PrimaryWorkerSummary[], overflowCount: number, dependencyRevision: number): TopicViewState {
  const same = state.workerOverflowCount === overflowCount && sameWorkerSummaries(state.workers, workers);
  if (same) return state.workerDependencyRevision === dependencyRevision ? state : { ...state, workerDependencyRevision: dependencyRevision };
  return { ...state, workers, workerOverflowCount: overflowCount, workerDependencyRevision: dependencyRevision, viewVersion: state.viewVersion + 1 };
}

export function reduceTopicView(state: TopicViewState, event: BridgeEvent): TopicViewState {
  const next = reduceTopicViewSnapshot(state, event);
  const updated = updateTopicView(state, next);
  return updated === state ? state : { ...updated, activityAt: event.occurredAt };
}

export function updateTopicView(state: TopicViewState, patch: Partial<TopicViewState>): TopicViewState {
  const identityOverride = patch.paneIdentity && identityPatchMatchesFlatFields(patch) ? patch.paneIdentity : undefined;
  const next = withPaneIdentity({ ...state, ...patch }, identityOverride);
  if (sameTopicPresentation(next, state)) return state.paneIdentity ? state : next;
  return { ...next, viewVersion: state.viewVersion + 1, deliveredVersion: state.deliveredVersion };
}

function reduceTopicViewSnapshot(state: TopicViewState, event: BridgeEvent): TopicViewState {
  const base = { ...state, modelUsage: normalizeModelUsage(state.modelUsage), pendingPromptQueuedAt: normalizePendingPromptQueuedAt(state.pendingPromptQueuedAt), lastEventId: event.eventId };
  switch (event.type) {
    case "BindingCreated": return { ...base, title: event.payload.title, agentKind: event.payload.agentKind ?? base.agentKind, workspaceId: event.payload.workspaceId, spaceName: event.payload.spaceName ?? base.spaceName, tabId: event.payload.tabId ?? base.tabId, paneId: event.payload.paneId, paneToken: event.payload.paneToken ?? base.paneToken ?? null, paneName: event.payload.paneName?.trim() || base.paneName || null, phase: "provisioning" };
    case "BindingActivated": return { ...base, tabId: event.payload.tabId ?? base.tabId, paneId: event.payload.paneId, paneToken: event.payload.paneToken ?? base.paneToken ?? null, paneName: event.payload.paneName?.trim() || base.paneName || null, phase: "ready", notice: null };
    case "PrimaryToolAvailabilityChanged": return { ...base, primaryToolsAvailable: event.payload.available, primaryToolsNotice: event.payload.reason };
    case "BindingRenamed": return { ...base, title: event.payload.title };
    case "BindingDraining": return { ...base, phase: "draining", notice: event.payload.reason };
    case "BindingArchived": return { ...base, phase: "archived", notice: event.payload.reason };
    case "BindingDegraded": return { ...base, phase: "degraded", notice: event.payload.reason };
    case "BindingOrphaned": return { ...base, phase: "orphaned", notice: event.payload.reason };
    case "PromptQueued": return base.activePromptId
      ? { ...base, queueDepth: event.payload.queueDepth, pendingPromptQueuedAt: rememberPendingPromptQueuedAt(base.pendingPromptQueuedAt, event.payload.promptId, event.occurredAt) }
      : { ...base, phase: "queued", queueDepth: event.payload.queueDepth, notice: null, pendingPromptQueuedAt: removePendingPromptQueuedAt(base.pendingPromptQueuedAt, event.payload.promptId), modelUsage: { ...emptyModelUsage(base.modelUsage.model ?? base.model), queuedAt: event.occurredAt } };
    case "NativeInputBacklogChanged": return { ...base, nativeInputBacklog: event.payload };
    case "PromptCancelled": return state;
    case "RunQueuePositionChanged": return state;
    case "TurnStarted": {
      const repeatedTurn = base.activePromptId === event.payload.promptId;
      const queuedBeforeStart = base.activePromptId === null && base.phase === "queued";
      const usage = repeatedTurn || queuedBeforeStart ? base.modelUsage : emptyModelUsage(base.modelUsage.model ?? base.model);
      const withQueue = usage.queuedAt ? usage : { ...usage, queuedAt: base.pendingPromptQueuedAt[event.payload.promptId] ?? event.occurredAt };
      const modelUsage = repeatedTurn ? withQueue : usageWithTiming(withQueue, { occurredAt: event.occurredAt, startedAt: event.occurredAt });
      return { ...base, phase: "running", agentState: "working", queueDepth: event.payload.queueDepth, answer: null, notice: null, activePromptId: event.payload.promptId, pendingPromptQueuedAt: removePendingPromptQueuedAt(base.pendingPromptQueuedAt, event.payload.promptId), recentProgress: [], progressSummary: { ...EMPTY_PROGRESS_SUMMARY }, liveStatus: null, modelUsage };
    }
    case "TurnOutputObserved": {
      if (base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      const observation = normalizeTurnOutputObservation(event.payload);
      const answer = keepAnswerTail(observation.answer.snapshot);
      const stamped = stampProgress(observation.answer.toolActivities, event.occurredAt);
      const progress = observation.answer.hasToolActivitySnapshot
        ? progressSnapshot(stamped)
        : mergeRecentProgress(base.recentProgress ?? [], base.progressSummary ?? EMPTY_PROGRESS_SUMMARY, stamped);
      const recentProgress = progress.events;
      const model = observation.main.model ?? state.model;
      const context = observation.main.context ?? state.context;
      const liveStatus = mergeLiveStatus(state.liveStatus, observation.main.status, event.occurredAt);
      if (answer === (state.answer ?? "") && sameVisibleProgress(recentProgress, state.recentProgress ?? []) && sameProgressSummary(progress.summary, state.progressSummary) && sameLiveStatus(liveStatus, state.liveStatus) && state.activePromptId === event.payload.promptId && model === state.model && context === state.context) return state;
      const firstVisibleAt = base.modelUsage.firstVisibleAt ?? (answer ? event.occurredAt : null);
      return { ...base, activePromptId: event.payload.promptId, answer, recentProgress, progressSummary: progress.summary, liveStatus, model, context, modelUsage: usageWithTiming(base.modelUsage, { model, firstVisibleAt, occurredAt: event.occurredAt }) };
    }
    case "PaneOutputObserved": {
      const observation = event.payload.observation;
      const observedAnswer = observation?.answer.snapshot || event.payload.answer;
      const answer = observedAnswer === undefined ? state.answer : keepAnswerTail(observedAnswer);
      const model = observation?.main.model ?? event.payload.model ?? state.model;
      const context = observation?.main.context ?? event.payload.context ?? state.context;
      const tabId = event.payload.tabId ?? state.tabId;
      const paneToken = event.payload.paneToken === undefined ? state.paneToken ?? null : event.payload.paneToken;
      const paneName = event.payload.paneName?.trim() || state.paneName || null;
      const identityPayload = event.payload as typeof event.payload & { workspace?: string | null; branch?: string | null; paneIdentity?: Partial<PaneIdentitySnapshot> };
      const priorIdentity = state.paneIdentity ?? createPaneIdentitySnapshot({ workspace: state.workspace, worktreeName: state.worktreeName, branch: state.branch, paneId: state.paneId, paneToken: state.paneToken });
      const paneIdentity = createPaneIdentitySnapshot({
        ...priorIdentity,
        ...identityPayload.paneIdentity,
        workspace: identityPayload.workspace === undefined ? identityPayload.paneIdentity?.workspace ?? priorIdentity.workspace : identityPayload.workspace,
        worktreeName: event.payload.worktreeName === undefined ? identityPayload.paneIdentity?.worktreeName ?? priorIdentity.worktreeName : event.payload.worktreeName,
        branch: identityPayload.branch === undefined ? identityPayload.paneIdentity?.branch ?? priorIdentity.branch : identityPayload.branch,
        paneId: priorIdentity.paneId,
        paneToken
      });
      const modelUsage = usageWithTiming(state.modelUsage, { model, occurredAt: event.occurredAt });
      if (answer === state.answer && model === state.model && context === state.context && tabId === state.tabId && paneName === state.paneName && samePaneIdentity(priorIdentity, paneIdentity) && sameModelUsage(modelUsage, state.modelUsage)) return state;
      if (observedAnswer !== undefined && state.activePromptId === null && state.phase !== "running" && state.phase !== "blocked") {
        return { ...base, phase: "done", agentState: "done", answer, model, context, modelUsage, tabId, paneToken: paneIdentity.paneToken, paneName, workspace: paneIdentity.workspace, worktreeName: paneIdentity.worktreeName, branch: paneIdentity.branch, paneIdentity, notice: null };
      }
      return { ...base, answer, model, context, modelUsage, tabId, paneToken: paneIdentity.paneToken, paneName, workspace: paneIdentity.workspace, worktreeName: paneIdentity.worktreeName, branch: paneIdentity.branch, paneIdentity };
    }
    case "AgentStateChanged":
      if (event.payload.promptId && base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      return { ...base, phase: event.payload.state === "blocked" ? "blocked" : event.payload.state === "working" ? "running" : base.phase, agentState: event.payload.state, queueDepth: event.payload.queueDepth, activePromptId: event.payload.promptId ?? base.activePromptId, notice: event.payload.state === "blocked" ? "TraeX 需要人工审批。请查看对应 Herdr panel 并完成所需交互。" : base.notice };
    case "TurnCompleted":
      if (base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      return { ...base, phase: "done", agentState: "done", queueDepth: event.payload.queueDepth, answer: keepAnswerTail(event.payload.answer), notice: null, activePromptId: null, modelUsage: usageWithTiming(base.modelUsage, { completedAt: event.occurredAt }) };
    case "TurnFailed":
      if (base.activePromptId && base.activePromptId !== event.payload.promptId) return state;
      return { ...base, phase: "error", queueDepth: event.payload.queueDepth, notice: event.payload.error, activePromptId: null };
  }
}

export function mirrorRunCardToTopic(state: TopicViewState, run: RunCardView): TopicViewState {
  if (run.phase === "submitted") return state;
  if (run.phase === "recovering" || run.phase === "uncertain") {
    if (state.activePromptId !== run.promptId) return state;
    return updateTopicView(state, {
      phase: "ready", agentState: "unknown", activePromptId: null, queueDepth: run.queuePosition,
      notice: run.notice, activityAt: run.updatedAt
    });
  }
  const phase = { queued: "queued", running: "running", blocked: "blocked", completed: "done", failed: "error" }[run.phase] as TopicViewPhase;
  return updateTopicView(state, {
    ...state, phase, queueDepth: run.queuePosition, answer: run.answer ? keepAnswerTail(run.answer) : null, timelineItems: run.timelineItems, notice: run.notice,
    activePromptId: run.phase === "running" || run.phase === "blocked" ? run.promptId : null,
    agentState: run.phase === "running" ? "working" : run.phase === "blocked" ? "blocked" : run.phase === "completed" ? "done" : state.agentState,
    recentProgress: run.progressEvents, progressSummary: run.progressSummary, activityAt: run.updatedAt
  });
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
  return left.bindingGeneration === right.bindingGeneration && left.title === right.title && left.agentKind === right.agentKind && left.workspaceId === right.workspaceId && left.spaceName === right.spaceName
    && left.tabId === right.tabId && left.paneId === right.paneId && left.paneToken === right.paneToken && left.paneName === right.paneName && left.workspace === right.workspace && left.worktreeName === right.worktreeName && left.branch === right.branch
    && left.phase === right.phase && left.agentState === right.agentState && left.queueDepth === right.queueDepth
    && left.nativeInputBacklog.unbatchedInputCount === right.nativeInputBacklog.unbatchedInputCount
    && left.nativeInputBacklog.pendingBatchCount === right.nativeInputBacklog.pendingBatchCount
    && left.answer === right.answer && left.notice === right.notice && left.activePromptId === right.activePromptId
    && sameAnswerTimeline(left.timelineItems, right.timelineItems)
    && sameCurrentGoal(left.currentGoal, right.currentGoal)
    && samePendingPromptQueuedAt(left.pendingPromptQueuedAt, right.pendingPromptQueuedAt)
    && sameCardTargetRef(left.currentAnswer, right.currentAnswer)
    && left.model === right.model && left.context === right.context
    && sameModelUsage(left.modelUsage, right.modelUsage)
    && sameTopicModelPreference(left.modelPreference, right.modelPreference)
    && left.primaryToolsAvailable === right.primaryToolsAvailable && left.primaryToolsNotice === right.primaryToolsNotice
    && left.workerOverflowCount === right.workerOverflowCount && sameWorkerSummaries(left.workers, right.workers)
    && sameTopicSessionIdentity(left.sessionIdentity, right.sessionIdentity)
    && left.sessionActivityRevision === right.sessionActivityRevision
    && sameLiveStatus(left.liveStatus, right.liveStatus)
    && sameVisibleProgress(left.recentProgress, right.recentProgress) && sameProgressSummary(left.progressSummary, right.progressSummary);
}
function sameTopicSessionIdentity(left: TopicSessionIdentity | null, right: TopicSessionIdentity | null): boolean {
  return left === right || Boolean(left && right
    && left.bindingGeneration === right.bindingGeneration && left.sessionEpoch === right.sessionEpoch
    && left.nativeSessionId === right.nativeSessionId && left.paneId === right.paneId && left.rootMessageId === right.rootMessageId);
}
function sameTopicModelPreference(left: TopicModelPreference | null, right: TopicModelPreference | null): boolean {
  return left === right || Boolean(left && right && left.model === right.model && left.revision === right.revision && left.state === right.state);
}
export function emptyModelUsage(model: string | null = null): ModelUsageSnapshot { return { model, contextRemainingPercent: null, inputTokens: null, outputTokens: null, queuedAt: null, firstVisibleAt: null, completedAt: null, waitMs: null, firstVisibleMs: null }; }
export function normalizeModelUsage(value: ModelUsageSnapshot | null | undefined): ModelUsageSnapshot { return value ?? emptyModelUsage(); }
function usageWithTiming(current: ModelUsageSnapshot, patch: Partial<ModelUsageSnapshot> & { occurredAt?: string; startedAt?: string }): ModelUsageSnapshot {
  const { occurredAt: _occurredAt, startedAt: _startedAt, ...usagePatch } = patch;
  const next: ModelUsageSnapshot = { ...normalizeModelUsage(current), ...usagePatch };
  const queued = next.queuedAt ? Date.parse(next.queuedAt) : NaN;
  const started = patch.startedAt ? Date.parse(patch.startedAt) : NaN;
  const visible = next.firstVisibleAt ? Date.parse(next.firstVisibleAt) : NaN;
  return { ...next, waitMs: Number.isFinite(queued) && Number.isFinite(started) ? Math.max(0, started - queued) : next.waitMs, firstVisibleMs: Number.isFinite(queued) && Number.isFinite(visible) ? Math.max(0, visible - queued) : next.firstVisibleMs };
}
function sameModelUsage(left: ModelUsageSnapshot, right: ModelUsageSnapshot): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function normalizePendingPromptQueuedAt(value: Record<string, string> | null | undefined): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([key, timestamp]) => Boolean(key) && typeof timestamp === "string").slice(-MAX_PENDING_PROMPT_QUEUE_TIMES));
}
function rememberPendingPromptQueuedAt(value: Record<string, string>, promptId: string, occurredAt: string): Record<string, string> {
  return normalizePendingPromptQueuedAt({ ...value, [promptId]: occurredAt });
}
function removePendingPromptQueuedAt(value: Record<string, string>, promptId: string): Record<string, string> {
  if (!(promptId in value)) return value;
  const next = { ...value };
  delete next[promptId];
  return next;
}
function samePendingPromptQueuedAt(left: Record<string, string> | undefined, right: Record<string, string> | undefined): boolean { return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {}); }
function sameWorkerSummaries(left: readonly PrimaryWorkerSummary[], right: readonly PrimaryWorkerSummary[]): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function sameProgressSummary(left: RunProgressSummary, right: RunProgressSummary): boolean { return left.total === right.total && left.stepTotal === right.stepTotal && left.stepDone === right.stepDone; }

function mergeLiveStatus(current: MainCardLiveStatus | null, update: Extract<BridgeEvent, { type: "TurnOutputObserved" }>["payload"]["observation"]["main"]["status"], occurredAt: string): MainCardLiveStatus | null {
  if (!update) return current;
  return {
    statusTitle: update.statusTitle === undefined ? current?.statusTitle ?? null : update.statusTitle,
    planSteps: update.planSteps === undefined ? current?.planSteps ?? [] : stampProgress(update.planSteps, occurredAt),
    elapsedSeconds: update.elapsedSeconds === undefined ? current?.elapsedSeconds ?? null : update.elapsedSeconds,
    tokenCount: update.tokenCount === undefined ? current?.tokenCount ?? null : update.tokenCount
  };
}

function sameLiveStatus(left: MainCardLiveStatus | null, right: MainCardLiveStatus | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.statusTitle === right.statusTitle && left.elapsedSeconds === right.elapsedSeconds && left.tokenCount === right.tokenCount
    && sameVisibleProgress(left.planSteps, right.planSteps);
}

function keepAnswerTail(answer: string): string { return answer.slice(-TOPIC_ANSWER_TAIL_LIMIT); }

function withPaneIdentity(state: TopicViewState, override?: PaneIdentitySnapshot): TopicViewState {
  const prior = state.paneIdentity;
  const paneIdentity = createPaneIdentitySnapshot({
    ...prior,
    ...override,
    workspace: override ? override.workspace : (state.workspace === undefined ? prior?.workspace : state.workspace),
    worktreeName: override ? override.worktreeName : (state.worktreeName === undefined ? prior?.worktreeName : state.worktreeName),
    branch: override ? override.branch : (state.branch === undefined ? prior?.branch : state.branch),
    paneId: override ? override.paneId : state.paneId,
    paneToken: override ? override.paneToken : state.paneToken
  });
  return { ...state, paneIdentity, workspace: paneIdentity.workspace, worktreeName: paneIdentity.worktreeName, branch: paneIdentity.branch, paneId: paneIdentity.paneId, paneToken: paneIdentity.paneToken };
}

function identityPatchMatchesFlatFields(patch: Partial<TopicViewState> & { paneIdentity?: PaneIdentitySnapshot }): boolean {
  const identity = patch.paneIdentity;
  if (!identity) return false;
  return (patch.workspace === undefined || patch.workspace === identity.workspace)
    && (patch.worktreeName === undefined || patch.worktreeName === identity.worktreeName)
    && (patch.branch === undefined || patch.branch === identity.branch)
    && (patch.paneId === undefined || patch.paneId === identity.paneId)
    && (patch.paneToken === undefined || patch.paneToken === identity.paneToken);
}
