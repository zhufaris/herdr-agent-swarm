import type { HerdrPane } from "./runtime-observation.js";
import type { DeliveryFailureClass, OutboundReplyKind, OutboundReplyState, OutboxLaneClass } from "./delivery.js";
import type { Binding, BindingState } from "./binding.js";
import type { PromptState } from "./prompt.js";
export type { Binding, BindingMetadataPatch, BindingState } from "./binding.js";
export type { DurablePromptWorkScan, ExternalTurnAdoption, ExternalTurnSupersessionFence, PromptJob, PromptObservationState, PromptState, PromptWorkHint, StalePromptClaim, TranscriptTurnClaimOutcome, TurnPriority, UndispatchedPromptClaimFence } from "./prompt.js";
export type { AgentState, HerdrAgentSession, HerdrPane, HerdrPaneCreationOptions, RuntimeObservation, RuntimeTurnObservation } from "./runtime-observation.js";
export type { AnswerPage, AnswerPageDeliveryFacts, AnswerPageDeliveryMode, AnswerPageReservationOutcome, AnswerPageState, BindingThreadAlias, DeadLetterActionOutcome, DeliveryEffectCertainty, DeliveryFailureClass, DeliveryFailureMetadata, GatewayRecoveryKind, MainCardReservationOutcome, OutboundFailureTransition, OutboundReply, OutboundReplyKind, OutboundReplyState, OutboundTargetRole, OutboundWorkClass, OutboxLaneClass, OutboxQuarantineAction, RequestCardRole, StaleOutboxQuarantineRecovery } from "./delivery.js";
export type { ProjectSelection, ProjectSelectionClaim, ProjectSelectionState } from "./project-selection.js";
export type { InboundDispatcherDiagnostics, InstanceWorkerDiagnostics, OutboxDispatcherDiagnostics, PromptWorkerDiagnostics, ReconciliationDiagnostics, ReconciliationFailure, ReconciliationPassResult, SessionOperationDispatcherDiagnostics, StartupRecoveryDiagnostics } from "../runtime/diagnostics.js";
export type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "../adapters/lark-ingress.js";
export type { WorkerSessionThread, WorkerSessionThreadMode, WorkerSessionThreadState } from "./worker-session-thread.js";

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

export type FailureSummary =
  | { kind: "outbound"; id: string; bindingId: string | null; attemptCount: number; updatedAt: string; error: string; spaceName?: string; paneId?: string | null; title?: string }
  | { kind: "prompt"; id: string; bindingId: string; updatedAt: string; error: string; spaceName?: string; paneId?: string | null; title?: string }
  | { kind: "session"; id: string; bindingId: string; updatedAt: string; error: string; spaceName?: string; paneId?: string | null; title?: string };


export interface ProjectConfig {
  id: string;
  displayName: string;
  spaceName?: string | undefined;
  description: string;
  workspaceId: string;
  cwd: string;
  maxInstances?: number;
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

export interface PromptLatencyPhaseSummary {
  sampleCount: number;
  averageMs: number | null;
  maxMs: number | null;
}

export interface PromptLatencySummary {
  windowSize: number;
  sampleCount: number;
  queue: PromptLatencyPhaseSummary;
  execution: PromptLatencyPhaseSummary;
  delivery: PromptLatencyPhaseSummary;
}

export interface LarkDeliveryCooldownSummary {
  active: boolean; blockedUntil: string | null; remainingMs: number; triggerCount: number;
  lastHttpStatus: number | null; lastLarkErrorCode: string | null; lastReason: string | null;
}

export interface OutboxWorkSummary {
  ready: number; inFlight: number; retryWait: number; cooldownWait: number; waitingBehindLane: number;
  oldestInFlightAt: string | null; oldestInFlightAgeSeconds: number | null;
}

export interface OperationalSummary {
  bindings: Record<BindingState, number>;
  prompts: Record<PromptState, number>;
  queueFeedback: { withEstimate: number; withoutEstimate: number };
  promptLatency: PromptLatencySummary;
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
  outbound: Record<OutboundReplyState, number>;
  pendingOutbox: number;
  deadLetters: number;
  deadLettersByClass: Record<DeliveryFailureClass | "legacy", number>;
  unresolvedDeadLetters: number;
  unresolvedDeadLettersByClass: Record<DeliveryFailureClass | "legacy", number>;
  uncertainDeliveryEffects: number;
  larkDeliveryCooldown: LarkDeliveryCooldownSummary;
  outboxWork: OutboxWorkSummary;
  eligibleDeadLetterRecoveries: number;
  deliveryRecoveries: Record<"unresolved" | "replacement_pending" | "recovered" | "dismissed", number>;
  oldestPendingAt: string | null;
  outboxLanes: {
    pending: number; eligible: number; blocked: number; nextAttemptAt: string | null;
    oldestHeadAt: string | null; oldestHeadAgeSeconds: number | null; stalled: number; oldestStalledAgeSeconds: number | null;
  };
  outboxQuarantines: {
    active: number; released: number; byLaneClass: Record<OutboxLaneClass, number>; byFailureClass: Record<DeliveryFailureClass, number>;
    latest: { replyId: string; replyKind: OutboundReplyKind; laneClass: OutboxLaneClass; failureClass: DeliveryFailureClass; action: string; reason: string; createdAt: string; releasedAt: string | null } | null;
  };
  recentFailedPrompt: { promptId: string; bindingId: string; updatedAt: string; error: string } | null;
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

export interface BindingTitleProjectionInput {
  bindingId: string;
  expectedPaneId: string;
  expectedGeneration: number;
  title: string;
  view: import("./topic-view.js").TopicViewState;
  rootMessageId: string | null;
  card: object;
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
  view: import("./topic-view.js").TopicViewState;
  rootMessageId: string | null;
  mainCard: object;
}

export interface RecoverOrphanBindingProjectionResult {
  outcome: "recovered" | "identity_mismatch" | "stale";
  binding: Binding | null;
  view: import("./topic-view.js").TopicViewState | null;
  outboxReserved: boolean;
}

export type RuntimeObservationApplication =
  | { outcome: "applied"; binding: Binding; terminalIdentityRefreshed: boolean; nativeSessionMismatch: boolean }
  | { outcome: "terminal_identity_changed"; binding: Binding }
  | { outcome: "stale_binding" };

export type BridgeCommand =
  | { kind: "stop" }
  | { kind: "steer"; text: string }
  | { kind: "model"; name: string | null }
  | { kind: "reset"; title: string | null }
  | { kind: "new"; title: string | null }
  | { kind: "projects" }
  | { kind: "spaces" }
  | { kind: "panes" }
  | { kind: "sessions" }
  | { kind: "failures" }
  | { kind: "status" }
  | { kind: "attach"; spaceName: string; paneId: string }
  | { kind: "rename"; title: string }
  | { kind: "close" }
  | { kind: "pane_close_request" }
  | { kind: "pane_close_confirm"; code: string }
  | { kind: "reattach"; paneId: string }
  | { kind: "replace" }
  | { kind: "resume" }
  | { kind: "awake" }
  | { kind: "skip" }
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
