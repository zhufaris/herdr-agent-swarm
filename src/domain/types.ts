import type { AgentState, HerdrPane } from "./runtime-observation.js";
import type { DeliveryFailureClass, OutboundReplyKind, OutboundReplyState, OutboxLaneClass } from "./delivery.js";
import type { Binding, BindingState } from "./binding.js";
import type { PromptDispatchKind, PromptJob, PromptState } from "./prompt.js";
export type { Binding, BindingMetadataPatch, BindingState } from "./binding.js";
export type { DurablePromptWorkScan, ExternalTurnAdoption, ExternalTurnSupersessionFence, PromptDispatchKind, PromptJob, PromptObservationState, PromptState, PromptWorkHint, StalePromptClaim, SteeringOrigin, TranscriptTurnClaimOutcome, TurnPriority } from "./prompt.js";
export type { AgentState, HerdrAgentSession, HerdrPane, HerdrPaneCreationOptions, RuntimeObservation, RuntimeTurnObservation } from "./runtime-observation.js";
export type { AnswerPage, AnswerPageDeliveryFacts, AnswerPageDeliveryMode, AnswerPageReservationOutcome, AnswerPageState, DeadLetterActionOutcome, DeliveryFailureClass, DeliveryFailureMetadata, MainCardReservationOutcome, OutboundFailureTransition, OutboundReply, OutboundReplyKind, OutboundReplyState, OutboundTargetRole, OutboxLaneClass, OutboxQuarantineAction, RequestCardRole, StaleOutboxQuarantineRecovery } from "./delivery.js";
export type { ProjectSelection, ProjectSelectionClaim, ProjectSelectionState } from "./project-selection.js";

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

export interface StartupRecoveryDiagnostics {
  state: "idle" | "running" | "completed" | "degraded";
  startedAt: string | null;
  completedAt: string | null;
  stages: Array<{ name: string; state: "completed" | "failed"; durationMs: number; error?: string }>;
}

export interface InboundDispatcherDiagnostics {
  state: "idle" | "running" | "retry_wait" | "stopping";
  drainRequested: boolean;
  retryAttempt: number;
  nextRetryAt: string | null;
  lastAcceptedAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
}

export interface SessionOperationDispatcherDiagnostics {
  state: "idle" | "running" | "stopping";
  activeOperations: number;
  drainRequested: boolean;
  lastCompletedAt: string | null;
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

export interface IncomingLarkCardAction {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  value: unknown;
  option?: string | null;
  formValues?: Record<string, string>;
}

export interface LarkCardActionResult {
  toast?: { type: "success" | "warning" | "error"; content: string };
  card?: object;
}

export type CardInteractionActionKind = "supplement" | "convert_queued_prompt" | "enqueue_failed_steering" | "more_actions" | "session_control";
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

export interface ReconciliationDiagnostics {
  state: "idle" | "running" | "stopping";
  runCount: number;
  successCount: number;
  failureCount: number;
  coalescedRequestCount: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  maxDurationMs: number | null;
  lastOutcome: "succeeded" | "failed" | null;
}

export interface OperationalSummary {
  bindings: Record<BindingState, number>;
  prompts: Record<PromptState, number>;
  promptDispatch: Record<PromptDispatchKind, number>;
  automaticSteering: { queued: number; delivered: number; failed: number; rejected: number; uncertain: number };
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
  outbound: Record<OutboundReplyState, number>;
  pendingOutbox: number;
  deadLetters: number;
  deadLettersByClass: Record<DeliveryFailureClass | "legacy", number>;
  eligibleDeadLetterRecoveries: number;
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

export interface OutboxDispatcherDiagnostics {
  state: "idle" | "running" | "stopping";
  activeDeliveries: number;
  scanPending: boolean;
  lastScanAt: string | null;
  lastScanOutcome: "idle" | "delivered" | "failed" | null;
  lastSuccessfulScanAt: string | null;
  lastScanFailureAt: string | null;
  consecutiveScanFailures: number;
  lastDeliveryAt: string | null;
  lastDeliveryFailureAt: string | null;
}

export interface PromptWorkerDiagnostics {
  state: "idle" | "running" | "stopping";
  activeTurnWorkers: number;
  activeSteeringWorkers: number;
  currentSafetyScanDelayMs: number | null;
  nextSafetyScanAt: string | null;
  lastScanAt: string | null;
  lastScanOutcome: "idle" | "work_found" | "failed" | null;
  lastDiscovered: { turns: number; steering: number; detached: number; recoveredClaims: number; cancelled: number; failedDetached: number };
  lastScanFailureAt: string | null;
}

export interface InstanceWorkerDiagnostics {
  state: "idle" | "running" | "stopping";
  activeDispatchWorkers: number;
  activeObservers: number;
  queuedTurns: number;
  activeTurns: number;
  uncertainTurns: number;
  lastScanAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
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

export interface IncomingLarkMessage {
  eventId: string;
  messageId: string;
  parentMessageId: string | null;
  chatId: string;
  topicId: string | null;
  rootMessageId: string | null;
  actorOpenId: string;
  text: string;
  mentionsBot: boolean;
  isRootMessage: boolean;
  hasUnsupportedContent?: boolean;
}

export type BridgeCommand =
  | { kind: "stop" }
  | { kind: "steer"; text: string }
  | { kind: "model"; name: string | null }
  | { kind: "reset"; title: string | null }
  | { kind: "new"; title: string | null }
  | { kind: "projects" }
  | { kind: "spaces" }
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
