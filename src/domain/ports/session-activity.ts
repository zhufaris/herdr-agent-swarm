import type { CoreEventEnvelope } from "../core-event-inbox.js";
import type { SessionActivityAgentLifecycleMutation, SessionActivityBindingFence, SessionActivityDiagnostics, SessionActivityProjectionContext, SessionActivityView } from "../session-activity.js";
import type { DeliveryScope } from "../delivery-scope.js";
import type { TopicViewState } from "../topic-view.js";
import type { TurnSessionStateView } from "../turn-session-state.js";

export interface SessionActivityProjectionInput {
  context: SessionActivityProjectionContext;
  laneId: string;
  laneSequence: number;
  sourceId: string;
  sourceEpoch: string;
  event: CoreEventEnvelope;
  observedAt: string;
  model?: string;
  taskList?: readonly { id?: string; label: string; state?: string }[];
  agentLifecycleMutations?: readonly SessionActivityAgentLifecycleMutation[];
}

export interface SessionActivityProjectionResult {
  outcome: "projected" | "duplicate" | "stale" | "ignored";
  visibleChanged: boolean;
}

export interface RetainedMultiAgentActivityRecoveryResult {
  recoveredAgents: number;
  visibleChanged: boolean;
  remaining: boolean;
  nextCursor: string | null;
}

export interface SessionActivityStore {
  projectCanonicalEvent(input: SessionActivityProjectionInput): SessionActivityProjectionResult;
  recoverRetainedMultiAgentActivity(input: { limit: number; observedAt: string; afterCursor?: string | null }): RetainedMultiAgentActivityRecoveryResult;
  diagnostics(): SessionActivityDiagnostics;
  load(scope: Extract<DeliveryScope, { kind: "pane" }>, fence: SessionActivityBindingFence): SessionActivityView | null;
  loadForCurrentPrimarySegment(segmentId: string): SessionActivityView | null;
  loadTurnSessionStateForCurrentSegment(segmentId: string): TurnSessionStateView | null;
  projectTopicViewChange(previous: TopicViewState, next: TopicViewState, occurredAt: string): boolean;
  setCardRenderers?(renderers: { main(view: TopicViewState, activity: SessionActivityView | null): object; pane(view: TopicViewState, activity: SessionActivityView | null): object }): void;
}
