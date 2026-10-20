import type { RunCardView } from "./run-card-view.js";
import type { TopicViewState } from "./topic-view.js";
import type { SessionActivityProjectionContext } from "./session-activity.js";
import type { HistoricalCoreRecoveryCandidate, HistoricalCoreRecoveryResult } from "./historical-recovery.js";

export interface CoreEventEnvelope {
  schemaVersion: 1;
  eventId: string;
  cursor: string;
  sourceId: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  turnId: string | null;
  occurredAt: string;
  payload: unknown;
}

export interface CoreEventInboxBatch {
  laneId: string;
  sourceId: string;
  sourceEpoch?: string;
  sessionActivityContext?: SessionActivityProjectionContext;
  agentKind: "traex" | "pi";
  sessionId: string;
  afterCursor: string;
  nextCursor: string;
  latestCursor: string;
  events: readonly CoreEventEnvelope[];
  ingestedAt: string;
}

export interface CoreEventInboxPendingBatch {
  events: CoreEventEnvelope[];
  eventIds: string[];
}

export interface CoreEventInboxCheckpoint {
  sourceId: string;
  sourceEpoch: string | null;
  agentKind: "traex" | "pi";
  sessionId: string;
  readCursor: string;
  latestCursor: string;
}

export interface CoreEventCheckpointRebase {
  laneId: string;
  sourceId: string;
  sourceEpoch: string;
  expectedSourceEpoch: string | null;
  agentKind: "traex" | "pi";
  sessionId: string;
  expectedReadCursor: string;
  resumeCursor: string;
  earliestCursor: string;
  latestCursor: string;
  owner: { kind: "binding" | "worker_turn"; id: string };
  rebasedAt: string;
}

export interface CoreEventLaneBootstrap {
  laneId: string;
  sourceId: string;
  sourceEpoch: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  resumeCursor: string;
  earliestCursor: string;
  latestCursor: string;
  owner: { kind: "binding" | "worker_turn"; id: string };
  observedAt: string;
}

export interface CoreEventEpochTransitionRebase {
  laneId: string;
  sourceId: string;
  expectedSourceEpoch: string;
  expectedReadCursor: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  sourceEpoch: string;
  earliestCursor: string;
  latestCursor: string;
  owner: { kind: "binding" | "worker_turn"; id: string };
  rebasedAt: string;
}

export interface CoreEventSourceTransition {
  laneId: string;
  expectedSourceId: string;
  expectedSourceEpoch: string;
  expectedReadCursor: string;
  sourceId: string;
  sourceEpoch: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  earliestCursor: string;
  latestCursor: string;
  owner: { kind: "binding" | "worker_turn"; id: string };
  transitionedAt: string;
}

export interface CoreEventInvalidCursorGap {
  laneId: string;
  sourceId: string;
  sourceEpoch: string | null;
  agentKind: "traex" | "pi";
  sessionId: string;
  readCursor: string;
  owner: { kind: "binding" | "worker_turn"; id: string };
  occurredAt: string;
}

export interface AuthoritativeTurnSnapshotIdentity {
  agentKind: "traex" | "pi";
  sessionId: string;
  turnId: string;
  requestedStartedAt: string;
}

export type AuthoritativeTurnSnapshotState = "staging" | "ready" | "indexing" | "not_found" | "ambiguous";

export interface AuthoritativeTurnSnapshot {
  identity: AuthoritativeTurnSnapshotIdentity;
  state: AuthoritativeTurnSnapshotState;
  canonicalStartedAt: string | null;
  nextCursor: string;
  complete: boolean;
  events: CoreEventEnvelope[];
  failureCode: string | null;
  eventCount: number;
  payloadBytes: number;
}

export interface AuthoritativeTurnSnapshotPageInput {
  identity: AuthoritativeTurnSnapshotIdentity;
  owner: { kind: "binding" | "worker_turn"; id: string };
  afterCursor: string;
  batch: {
    outcome: "recovered" | "indexing" | "not_found" | "ambiguous";
    canonicalStartedAt?: string;
    nextCursor: string;
    complete: boolean;
    events: readonly CoreEventEnvelope[];
  };
  observedAt: string;
}

export interface AuthoritativeTurnSnapshotStageResult {
  outcome: "staged" | "duplicate" | "ready" | "indexing" | "not_found" | "ambiguous";
  state: AuthoritativeTurnSnapshotState;
  nextCursor: string;
  complete: boolean;
  canonicalStartedAt: string | null;
  failureCode: string | null;
}

export interface AuthoritativeTurnSnapshotStore {
  loadAuthoritativeTurnSnapshot(identity: AuthoritativeTurnSnapshotIdentity): AuthoritativeTurnSnapshot | null;
  stageAuthoritativeTurnSnapshotPage(input: AuthoritativeTurnSnapshotPageInput): AuthoritativeTurnSnapshotStageResult;
  replaceAuthoritativeTurnSnapshot(input: {
    identity: AuthoritativeTurnSnapshotIdentity;
    bindingId: string;
    expectedGeneration: number;
    expectedPaneId: string;
    projectionId: string;
    origin: "herdr" | "feishu";
    view: RunCardView;
    occurredAt: string;
    answerCardFor(view: RunCardView): object;
    mainCardFor(view: TopicViewState): object;
    paneEntryCardFor(view: TopicViewState): object;
  }): { outcome: "replaced" | "duplicate" | "stale" | "ambiguous"; outboxReserved: boolean };
}

/**
 * Opaque identity for settling one durable Core inbox frame after its view
 * projection commits. Presentation reducers must carry, but never render, it.
 */
export interface CoreEventProjectionSettlement {
  laneId: string;
  eventIds: readonly string[];
  occurredAt: string;
  owner: { kind: "binding" | "worker_turn"; id: string };
}

export interface CoreEventProjectionOwner {
  kind: "prompt" | "worker_turn";
  id: string;
}

export type CoreEventProjectionResult<Result> =
  | { outcome: "projected"; value: Result }
  | { outcome: "current" };

export const CORE_EVENT_REDUCER_REVISION = 1;
export const CORE_EVENT_MAX_PROJECTION_ATTEMPTS = 3;
export type CoreEventIngestResult = "accepted" | "stale_rebase";
export type CoreEventCheckpointRebaseResult = "rebased" | "stale_rebase";
export type CoreEventLaneBootstrapResult = "bootstrapped" | "stale_rebase";
export type CoreEventEpochTransitionRebaseResult = "rebased" | "stale_rebase";
export type CoreEventSourceTransitionResult = "transitioned" | "stale_rebase";
export type CoreEventSettlementResult = "settled" | "retry" | "quarantined";
export interface CoreEventDiscriminatorBackfillResult {
  state: "backfilling" | "complete";
  processed: number;
  remaining: boolean;
}

export interface CoreEventInboxStore {
  onPendingWorkCommitted?(listener: () => void): () => void;
  ingestBatch(batch: CoreEventInboxBatch): CoreEventIngestResult;
  bootstrapExpiredLane(input: CoreEventLaneBootstrap): CoreEventLaneBootstrapResult;
  rebaseExpiredCheckpoint(input: CoreEventCheckpointRebase): CoreEventCheckpointRebaseResult;
  rebaseEpochTransition(input: CoreEventEpochTransitionRebase): CoreEventEpochTransitionRebaseResult;
  transitionSource(input: CoreEventSourceTransition): CoreEventSourceTransitionResult;
  recordInvalidCursorGap(input: CoreEventInvalidCursorGap): void;
  ingestCanonicalSnapshotEvidence(events: readonly CoreEventEnvelope[], ingestedAt: string): number;
  loadPending(laneId: string, limit?: number): CoreEventInboxPendingBatch;
  listHistoricalRecoveryCandidates(input: { limit?: number }): HistoricalCoreRecoveryCandidate[];
  reprojectHistoricalCandidate(candidate: HistoricalCoreRecoveryCandidate, observedAt?: string): HistoricalCoreRecoveryResult;
  loadSettledTurnStart(input: { laneId: string; agentKind: "traex" | "pi"; sessionId: string; turnId: string }): CoreEventEnvelope | null;
  loadProjectedTurnViewEvents(input: { agentKind: "traex" | "pi"; sessionId: string; turnId: string; startedAt: string }): CoreEventEnvelope[];
  getCheckpoint(laneId: string): CoreEventInboxCheckpoint | null;
  countOpenProjectionGaps(owner: { kind: "binding" | "worker_turn"; id: string }): number;
  backfillDiscriminators(limit?: number, occurredAt?: string): CoreEventDiscriminatorBackfillResult;
  acknowledge(laneId: string, eventIds: readonly string[], outcome: "projected" | "ignored" | "quarantined", occurredAt: string, error?: string, owner?: { kind: "binding" | "worker_turn"; id: string }): CoreEventSettlementResult | void;
}
