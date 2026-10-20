import type { HerdrPane } from "./runtime-observation.js";
import type { DeliveryFailureClass, OutboundReplyKind, OutboundReplyState, OutboxLaneClass } from "./delivery.js";
import type { Binding, BindingState } from "./binding.js";
import type { PromptState } from "./prompt.js";
export type { Binding, BindingKind, BindingMetadataPatch, BindingState } from "./binding.js";
export type { ConflictedRuntimeIdentityClaim, CurrentRuntimeIdentityClaim, NativeRuntimeIdentity, ReleasedRuntimeIdentityClaim, RuntimeIdentityAttachment, RuntimeIdentityAttachmentState, RuntimeIdentityClaim, RuntimeIdentityClaimState, RuntimeIdentityEvidence, RuntimeIdentityOwner, UnclaimedRuntimeIdentityClaim } from "./runtime-identity-claim.js";
export type { DurablePromptWorkScan, ExternalTurnAdoption, ExternalTurnSupersessionFence, PromptIngressSource, PromptJob, PromptObservationState, PromptState, PromptTranscriptTurn, PromptWorkHint, StalePromptClaim, TranscriptTurnAdoptionOutcome, TranscriptTurnClaimOutcome, TurnPriority, UndispatchedPromptClaimFence } from "./prompt.js";
export type { AgentState, HerdrActiveTurn, HerdrAgentSession, HerdrPane, HerdrPaneCreationOptions, RuntimeObservation, RuntimeTurnObservation } from "./runtime-observation.js";
export type { AnswerPage, AnswerPageDeliveryFacts, AnswerPageDeliveryMode, AnswerPageReservationOutcome, AnswerPageState, AnswerTimelineCursor, AnswerTimelineFrozenItem, AnswerTimelinePageCheckpoint, BindingThreadAlias, DeadLetterActionOutcome, DeliveryEffectCertainty, DeliveryFailureClass, DeliveryFailureMetadata, GatewayRecoveryKind, MainCardReservationOutcome, OutboundFailureTransition, OutboundReply, OutboundReplyKind, OutboundReplyState, OutboundTargetRole, OutboundWorkClass, OutboxLaneClass, OutboxQuarantineAction, PreparedDelivery, RequestCardRole, StaleOutboxQuarantineRecovery } from "./delivery.js";
export type { DeliveryOwnerFence, DeliveryScope } from "./delivery-scope.js";
export type { ConsumerCheckpoint, CoreLaneIdentity, DeliveryRingCheckpoint } from "./checkpoint.js";
export type { ProjectSelection, ProjectSelectionClaim, ProjectSelectionState } from "./project-selection.js";
export type { InboundDispatcherDiagnostics, InstanceWorkerDiagnostics, PromptWorkerDiagnostics, ReconciliationDiagnostics, ReconciliationFailure, ReconciliationPassResult, SessionOperationDispatcherDiagnostics, StartupRecoveryDiagnostics } from "./diagnostics.js";
export type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "./inbound.js";
export type { WorkerSessionThread, WorkerSessionThreadMode, WorkerSessionThreadState } from "./worker-session-thread.js";
export type { AcceptOrchestratorClearOperationInput, OrchestratorClearOperation, OrchestratorClearState, SessionRotationReceipt, SessionRotationRequest, SessionRotationResult } from "./orchestrator-clear.js";
export type { AcceptOrchestratorIdentityMigrationInput, OrchestratorIdentityMigration, OrchestratorIdentityMigrationState } from "./orchestrator-identity.js";

export type EventOrigin = "lark" | "herdr" | "bridge";
export type PaneCloseOperationState = "executing" | "uncertain";
export type PaneControlOperationKind = "stop" | "steer" | "model";
export type PaneControlOperationState = "accepted" | "running" | "applied" | "confirmed" | "rejected" | "failed" | "uncertain";
export type RetiredPaneCleanupState = "pending" | "waiting_busy" | "executing" | "succeeded" | "retained";

export interface PaneControlOperation {
  id: string;
  idempotencyKey: string;
  bindingId: string;
  paneId: string;
  terminalId: string | null;
  bindingGeneration: number;
  kind: PaneControlOperationKind;
  payload: string | null;
  parentPromptId: string | null;
  state: PaneControlOperationState;
  attemptCount: number;
  detail: string | null;
  actorOpenId: string;
  sourceMessageId: string;
  createdAt: string;
  updatedAt: string;
}


export interface InstanceLease {
  ownerId: string;
  fencingToken: number;
  expiresAt: string;
  updatedAt: string;
}

export interface InstanceLeaseStatus {
  held: boolean;
  ownerSuffix: string;
  fencingToken: number | null;
  expiresAt: string | null;
  lastRenewedAt: string | null;
  error: string | null;
}

export interface WorkspaceCacheStatus {
  ttlMs: number;
  entries: number;
  hits: number;
  misses: number;
  coalescedRefreshes: number;
  refreshFailures: number;
  oldestSnapshotAgeMs: number | null;
}

export interface HerdrCircuitBreakerStatus {
  state: "closed" | "open" | "half_open";
  failureThreshold: number;
  openMs: number;
  consecutiveFailures: number;
  totalTransportFailures: number;
  rejectedCalls: number;
  successfulProbes: number;
  openedAt: string | null;
  nextProbeAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
}

export interface SessionSummary {
  binding: Binding;
  queueDepth: number;
  spaceName?: string;
}
export interface SessionPage { sessions: SessionSummary[]; nextCursor: string | null; }

export type FailureSummary =
  | { kind: "outbound"; id: string; bindingId: string | null; attemptCount: number; retryAllowed: boolean; updatedAt: string; error: string; spaceName?: string; paneId?: string | null; paneToken?: string | null; title?: string }
  | { kind: "prompt"; id: string; bindingId: string; updatedAt: string; error: string; spaceName?: string; paneId?: string | null; paneToken?: string | null; title?: string }
  | { kind: "session"; id: string; bindingId: string; updatedAt: string; error: string; spaceName?: string; paneId?: string | null; paneToken?: string | null; title?: string };


export interface ProjectConfig {
  id: string;
  displayName: string;
  spaceName?: string | undefined;
  description: string;
  workspaceId: string;
  cwd: string;
  maxInstances?: number;
  orchestrator?: { enabled: boolean; cwd: string } | undefined;
  paneRetention?: { mode: "persistent" | "ephemeral"; idleAfterMs?: number | undefined; graceMs?: number | undefined } | undefined;
}

export type CardInteractionActionKind = "supplement" | "more_actions" | "session_control" | "continuation";
export type CardInteractionState = "active" | "claimed" | "consumed" | "expired";
export interface CardInteraction {
  id: string; bindingId: string; bindingGeneration: number; actorOpenId: string; actionKind: CardInteractionActionKind;
  parentPromptId: string | null; targetPromptId: string | null; state: CardInteractionState; expiresAt: string;
  resultCode: string | null; createdAt: string; claimedAt: string | null; consumedAt: string | null;
}

export type SessionOperationKind = "stop" | "model" | "reset" | "archive" | "resume" | "replace" | "pane_close" | "rename" | "reattach";
export type SessionOperationState = "accepted" | "running" | "succeeded" | "rejected" | "failed" | "uncertain";
export interface SessionOperation {
  id: string; idempotencyKey: string; interactionId: string; bindingId: string; bindingGeneration: number;
  expectedPaneId: string | null; expectedTerminalId: string | null; actorOpenId: string; kind: SessionOperationKind;
  argument: string | null; state: SessionOperationState; attemptCount: number; detail: string | null; createdAt: string; updatedAt: string;
}

export interface PaneCloseOperation {
  id: string;
  bindingId: string;
  paneId: string;
  state: PaneCloseOperationState;
}

export interface RetiredPaneCleanupOperation {
  id: string;
  oldBindingId: string;
  replacementBindingId: string;
  paneId: string;
  expectedWorkspaceId: string;
  expectedProjectId: string;
  expectedCwd: string;
  expectedTerminalId: string;
  actorOpenId: string;
  state: RetiredPaneCleanupState;
  attemptCount: number;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LarkDeliveryCooldownSummary {
  active: boolean; blockedUntil: string | null; remainingMs: number; triggerCount: number;
  lastHttpStatus: number | null; lastLarkErrorCode: string | null; lastReason: string | null;
}

export interface DeliveryRingOperationalSummary {
  pending: number;
  panePending: number;
  globalPending: number;
  durableBytes: number;
  scopes: number;
  primaryPaneScopes: number;
  workerPaneScopes: number;
  legacyWorkerScopeDebt: number;
  ready: number;
  retryWait: number;
  activeClaims: number;
  waitingBehindScope: number;
  oldestPendingAt: string | null;
  oldestPendingAgeSeconds: number | null;
  initializedCheckpointScopes: number;
  lowestBlockingDeliveryOrder: number | null;
  lowestBlockingAgeSeconds: number | null;
  uncertainBlocked: number;
  activeQuarantineBlocked: number;
  graceBlockedScopes: number;
  isolatedConflicts: number;
  isolatedUncertain: number;
  bypassedDeliveries: number;
  pendingHumanReviews: number;
  oldestHumanReviewAgeSeconds: number | null;
}

export interface PaneTopologyOperationalSummary {
  pending: number;
  executing: number;
  uncertain: number;
  recoverable: number;
  oldestOpenAt: string | null;
}

export interface CoreSessionIngestionDiagnostics {
  ready: boolean;
  state: "idle" | "awaiting_session" | "running" | "stopped";
  recoveryState: "idle" | "indexing" | "needs_human";
  runCount: number;
  activeSessions: number;
  awaitingSessions: number;
  laggingSessions: number;
  oldestLagAgeSeconds: number | null;
  requiredFailures: number;
  retryingSessions: number;
  maxRetryAttempt: number;
  nextRetryAt: string | null;
  indexingRecoveries: number;
  needsHumanRecoveries: number;
  fallbackDelayMs: number | null;
  nextFallbackAt: string | null;
  pendingReprojections: number;
  activeIngestionPermits: number;
  pendingReprojectionRuns: number;
  pendingReprojectedEvents: number;
  pendingReprojectionRetries: number;
  pendingReprojectionQuarantined: number;
  pendingReprojectionNoPending: number;
  pendingReprojectionNoCandidate: number;
  pendingReprojectionIdentityMismatch: number;
  pendingReprojectionRouteUnavailable: number;
  multiplexTargets: number;
  multiplexOverflow: number;
  multiplexGeneration: number;
  lastPendingReprojectionSkipReason: "no_pending" | "no_candidate" | "identity_mismatch" | "route_unavailable" | null;
  lastPendingReprojectionAt: string | null;
  lastRunAt: string | null;
  lastSuccessfulIngestAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: "route_unavailable" | "route_resolution_failed" | "cursor_expired" | "unrecoverable_cursor" | "session_ingestion_failed" | "recovery_not_found" | "recovery_ambiguous" | "recovery_unavailable" | null;
  lastFailure: string | null;
}

export interface OperationalSummary {
  semanticDeliveryRollout: SemanticDeliveryRolloutSummary;
  bindings: Record<BindingState, number>;
  submissionIntents: {
    states: Record<import("./submission-intent.js").SubmissionIntentState, number>;
    awaitingReceipt: number;
    receiptKnown: number;
  };
  coreProjection: {
    lanes: number; laggingLanes: number; pendingEvents: number; quarantinedEvents: number;
    oldestPendingAt: string | null; oldestPendingAgeSeconds: number | null;
  };
  retentionCompaction: {
    totalCompacted: number;
    coreEvent?: {
      cursorMode: "audit" | "compact" | null;
      verified: number;
      compacted: number;
      retainedBytes: number;
    };
    sources: Array<{
      source: "core_event" | "conversation_segment_item" | "answer_timeline_item" | "delivery";
      cycleState: "scanning" | "complete";
      highWater: Readonly<Record<string, unknown>>;
      after: Readonly<Record<string, unknown>> | null;
      compacted: number;
      refusals: Readonly<Record<string, number>>;
      updatedAt: string;
    }>;
  };
  inbound: {
    states: Record<"received" | "processing" | "accepted", number>;
    retryable: number;
    oldestPendingAt: string | null;
    oldestPendingAgeSeconds: number | null;
    recentFailure: { eventId: string; updatedAt: string; error: string } | null;
  };
  sessionOperations: {
    states: Record<SessionOperationState, number>;
    oldestAcceptedAt: string | null;
    oldestAcceptedAgeSeconds: number | null;
  };
  workerThreads: Record<import("./worker-session-thread.js").WorkerSessionThreadState, number>;
  completionReviews: {
    legacyInline: number;
    provisional: number;
    presenting: number;
    active: number;
    consumed: number;
    superseded: number;
    unavailable: number;
    deliveredPresentationsAwaitingAdoption: number;
    pendingPresentations: number;
    uncertainPresentations: number;
  };
  outbound: Record<OutboundReplyState, number>;
  pendingOutbox: number;
  deadLetters: number;
  deadLettersByClass: Record<DeliveryFailureClass | "legacy", number>;
  unresolvedDeadLetters: number;
  unresolvedDeadLettersByClass: Record<DeliveryFailureClass | "legacy", number>;
  uncertainDeliveryEffects: number;
  larkDeliveryCooldown: LarkDeliveryCooldownSummary;
  deliveryRings: DeliveryRingOperationalSummary;
  paneTopology: PaneTopologyOperationalSummary;
  eligibleDeadLetterRecoveries: number;
  deliveryRecoveries: Record<"unresolved" | "replacement_pending" | "recovered" | "dismissed", number>;
  projectionDeliveryRecovery: {
    backlog: number; eligible: number; awaitingAck: number; recovered: number; exhausted: number;
    byProjection: { primaryAnswer: number; workerTask: number; turnCard: number };
    oldestEligibleAt: string | null; oldestEligibleAgeSeconds: number | null;
  };
  turnCards: {
    pending: number; working: number; terminal: number; needsHuman: number;
    pagesAwaitingCreate: number; pagesAwaitingUpdate: number; quarantined: number;
  };
  oldestPendingAt: string | null;
  outboxQuarantines: {
    active: number; current?: number; historical?: number; released: number; byLaneClass: Record<OutboxLaneClass, number>; byFailureClass: Record<DeliveryFailureClass, number>;
    latest: { replyId: string; replyKind: OutboundReplyKind; laneClass: OutboxLaneClass; failureClass: DeliveryFailureClass; action: string; reason: string; createdAt: string; releasedAt: string | null } | null;
  };
  projectionGaps: import("./projection-gap.js").ProjectionGapOperationalSummary;
  turnRecovery: {
    pending: number; due: number; oldestAttemptAt: string | null; oldestAgeSeconds: number | null;
    byState: Record<"waiting" | "indexing" | "not_found" | "ambiguous" | "transient", number>;
    latestFailure: { failureCode: string; attemptCount: number; lastAttemptAt: string; nextAttemptAt: string } | null;
  };
  recentDeadLetter: { replyId: string; bindingId: string | null; promptId: string | null; attemptCount: number; updatedAt: string; error: string } | null;
  lifecycle: Record<import("./pane-thread-lifecycle.js").SessionLifecycle, number>;
  attachment: Record<import("./pane-thread-lifecycle.js").AttachmentState, number>;
  recoverableProvisioning: number;
  archivedPanesPresent: number;
  cleanupCandidates: number;
  retiredPaneCleanup: {
    states: Record<RetiredPaneCleanupState, number>;
    oldestActiveAt: string | null;
    oldestActiveAgeSeconds: number | null;
    latestOutcome: { operationId: string; state: RetiredPaneCleanupState; updatedAt: string; detail: string | null } | null;
  };
  oldestInactiveAt: string | null;
}

export type SemanticDeliveryRolloutBlocker =
  | "shadow_evidence_missing"
  | "shadow_mismatch"
  | "ambiguous_actionable_rows"
  | "unsupported_versions"
  | "unresolved_settlement_gaps"
  | "retention_blockers"
  | "backup_restore_rehearsal_missing";

export interface SemanticDeliveryRolloutSummary {
  phase: "expansion" | "shadow" | "cohort" | "contraction_ready";
  cohortEnabled: boolean;
  cutoverAllowed: boolean;
  contractionAllowed: boolean;
  legacyRows: number;
  semanticRows: number;
  shadowMatches: number;
  shadowMismatches: number;
  shadowEpoch: number;
  shadowStartedAt: string | null;
  ambiguousActionableRows: number;
  unsupportedVersions: number;
  unresolvedSettlementGaps: number;
  retentionBlockers: number;
  oldestUnpreparedSemanticAt: string | null;
  oldestUnpreparedSemanticAgeSeconds: number | null;
  preparationCasFailures: number;
  unmetPrerequisiteCount: number;
  oldestUnmetPrerequisiteAt: string | null;
  oldestUnmetPrerequisiteAgeSeconds: number | null;
  checkpointBackwardRebases: number;
  versions: ReadonlyArray<{ snapshotSchemaVersion: number | null; plannerPolicyVersion: number | null; rendererPolicyVersion: number | null; gatewayProfileVersion: number | null; rows: number; supported: boolean }>;
  backupRestoreRehearsedAt: string | null;
  blockers: SemanticDeliveryRolloutBlocker[];
}

export interface SqliteIntegrityIssue {
  rule: string;
  table: string;
  count: number;
  rowId?: number;
}

export interface SqliteIntegrityInspection {
  quickCheck: "ok" | "failed";
  issues: SqliteIntegrityIssue[];
  truncated: boolean;
}

export interface SqliteIntegrityDiagnostics extends SqliteIntegrityInspection {
  state: "idle" | "running" | "healthy" | "degraded";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export type DatabaseDiagnosticsFailureClass = "busy" | "locked" | "timeout" | "other";

export interface DatabaseDiagnosticsInspection {
  operational: OperationalSummary;
  semantic: {
    issues: SqliteIntegrityIssue[];
    truncated: boolean;
  };
  physical: {
    quickCheck: "ok" | "failed";
    foreignKeyIssues: Array<{ table: string; rowId: number | null }>;
    truncated: boolean;
  } | undefined;
  connection: {
    queryOnly: true;
    busyTimeoutMs: number;
  };
}

export interface DatabaseDiagnosticsStatus {
  state: "fresh" | "stale" | "unavailable";
  refreshing: boolean;
  collectedAt: string | null;
  failureClass: DatabaseDiagnosticsFailureClass | null;
  retryAt: string | null;
  physicalState: "unknown" | "healthy" | "failed";
  physicalCheckedAt: string | null;
  semanticIssueCount: number;
  semanticTruncated: boolean;
}

export interface BindingTitleProjectionInput {
  bindingId: string;
  expectedPaneId: string;
  expectedGeneration: number;
  title: string;
  view: import("./topic-view.js").TopicViewState;
  rootMessageId: string | null;
  card: object;
  paneEntryCard: object;
}

export interface BindingTitleProjectionResult {
  outcome: "projected" | "unchanged" | "stale_binding";
  binding: Binding | null;
  outboxReserved: boolean;
}

export interface RuntimeDegradationInput {
  bindingId: string;
  expectedPaneId: string;
  expectedGeneration: number;
  view: import("./topic-view.js").TopicViewState;
  rootMessageId: string | null;
  mainCard: object;
  paneEntryCard: object;
}

export interface RuntimeDegradationResult {
  outcome: "degraded" | "unchanged" | "stale";
  binding: Binding | null;
  view: import("./topic-view.js").TopicViewState | null;
  outboxReserved: boolean;
}

export interface OrphanBindingProjectionInput {
  bindingId: string;
  expectedPaneId: string;
  expectedGeneration: number;
  occurredAt: string;
  reason: string;
  view: import("./topic-view.js").TopicViewState;
  rootMessageId: string | null;
  mainCard: object;
  paneEntryCard: object;
  renderRunCard(view: import("./run-card-view.js").RunCardView): object;
}

export interface OrphanBindingProjectionResult {
  outcome: "orphaned" | "unchanged" | "stale";
  binding: Binding | null;
  view: import("./topic-view.js").TopicViewState | null;
  updatedPromptIds: string[];
  outboxReserved: boolean;
}

export interface RecoverOrphanBindingProjectionInput {
  bindingId: string;
  expectedPaneId: string;
  expectedGeneration: number;
  pane: HerdrPane;
  event: import("./create-bridge-event.js").BridgeEventOf<"BindingActivated">;
  view: import("./topic-view.js").TopicViewState;
  rootMessageId: string | null;
  mainCard: object;
  paneEntryCard: object;
}

export interface RecoverOrphanBindingProjectionResult {
  outcome: "recovered" | "identity_mismatch" | "stale";
  binding: Binding | null;
  view: import("./topic-view.js").TopicViewState | null;
  outboxReserved: boolean;
}

export type RuntimeObservationApplication =
  | { outcome: "applied"; binding: Binding; terminalIdentityRefreshed: boolean; nativeSessionMismatch: boolean }
  | { outcome: "session_rotation_pending"; binding: Binding }
  | { outcome: "terminal_identity_changed"; binding: Binding }
  | { outcome: "stale_binding" };

export type RuntimeIdentityReconciliationApplication =
  | { outcome: "adopted" | "observed" | "terminal_refreshed"; binding: Binding; terminalIdentityRefreshed: boolean; nativeSessionAdopted: boolean }
  | { outcome: "recovered"; binding: Binding; outboxReserved: boolean; event: import("./create-bridge-event.js").BridgeEventOf<"BindingActivated"> }
  | { outcome: "refused"; binding: Binding; reason: string; evidenceFingerprint: string }
  | { outcome: "unchanged_refusal"; binding: Binding; reason: string }
  | { outcome: "session_rotation_pending"; binding: Binding }
  | { outcome: "stale" | "conflict" };

export type RuntimeIdentityReconciliationDecision =
  | { outcome: "adopt" }
  | { outcome: "observed" }
  | { outcome: "observe_unclaimed" }
  | { outcome: "terminal_refresh" }
  | { outcome: "orphan_recovery" }
  | { outcome: "refused"; reason: string; evidenceFingerprint: string }
  | { outcome: "unchanged_refusal"; reason: string }
  | { outcome: "stale" };

export type RuntimeIdentityReconciliationPolicy = (input: {
  binding: Binding;
  claim: import("./runtime-identity-claim.js").RuntimeIdentityClaim | null;
  pane: HerdrPane;
}) => RuntimeIdentityReconciliationDecision;

export type BridgeCommand =
  | { kind: "stop" }
  | { kind: "steer"; text: string }
  | { kind: "model"; name: string | null }
  | { kind: "reset"; title: string | null }
  | { kind: "clear" }
  | { kind: "new"; title: string | null; agentKind: import("./agent-instance.js").AgentKind }
  | { kind: "projects" }
  | { kind: "spaces" }
  | { kind: "panes" }
  | { kind: "sessions"; cursor: string | null }
  | { kind: "failures" }
  | { kind: "status" }
  | { kind: "attach"; spaceName: string | null; paneId: string }
  | { kind: "rename"; title: string }
  | { kind: "close" }
  | { kind: "pane_close_request" }
  | { kind: "pane_close_confirm"; code: string }
  | { kind: "reattach"; paneId: string }
  | { kind: "replace" }
  | { kind: "resume" }
  | { kind: "archive" }
  | { kind: "awake" }
  | { kind: "worker_create"; name: string; agentKind: import("./agent-instance.js").AgentKind; model: string | null; start: boolean }
  | { kind: "help" };

export type InstanceCommand =
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "instances" }
  | { kind: "instance"; name: string }
  | { kind: "to"; name: string; text: string }
  | { kind: "steer_instance"; name: string; text: string }
  | { kind: "stop_instance"; name: string };
