import type { AttachmentState, ProvisioningCheckpoint, SessionLifecycle } from "./pane-thread-lifecycle.js";

export type BindingState = "pending" | "active" | "archived" | "orphaned" | "failed";
export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";
export interface HerdrAgentSession { source: string; agent: string; kind: "id" | "path"; value: string }
export type EventOrigin = "lark" | "herdr" | "bridge";
export type PromptState = "queued" | "running" | "delivered" | "failed" | "cancelled";
export type PromptDispatchKind = "turn" | "steering";
export type PromptObservationState = "not_started" | "attached" | "detached" | "completed";
export type SteeringOrigin = "explicit" | "automatic" | "converted";
export type OutboundReplyState = "pending" | "delivered" | "dead_letter" | "dismissed";
export type DeliveryFailureClass = "transient" | "permanent" | "unknown";
export interface DeliveryFailureMetadata { failureClass: DeliveryFailureClass; httpStatus: number | null; larkErrorCode: string | null }
export type OutboxLaneClass = "answer_stream" | "main_card" | "replaceable_card" | "immutable";
export type OutboxQuarantineAction = "retry" | "blocked" | "rebuild_answer" | "rebuild_main" | "released_newer_snapshot" | "startup_rebuild" | "startup_rollback" | "startup_dismiss" | "startup_terminalized";
export interface OutboundFailureTransition { state: OutboundReplyState; action: OutboxQuarantineAction; laneClass: OutboxLaneClass; promptId: string | null; reply: OutboundReply }
export interface StaleOutboxQuarantineRecovery { retriedAnswerPromptIds: string[]; rolledBackAnswerPromptIds: string[]; dismissedNotices: number; terminalizedQuarantines: number }
export type OutboundReplyKind = "text" | "card_reply" | "card_update" | "stream_card_create" | "stream_content" | "stream_finish";
export type RequestCardRole = "task" | "answer";
export type OutboundTargetRole = "session_status" | "operation_result";
export type AnswerPageState = "creating" | "active" | "frozen" | "finished";
export type AnswerPageDeliveryMode = "streaming" | "static";
export type MainCardReservationOutcome = "reserved" | "waiting" | "current";
export type ProjectSelectionState = "pending" | "processing" | "completed" | "failed" | "expired";
export type PaneCloseOperationState = "executing" | "uncertain";
export type PaneControlOperationKind = "stop" | "steer" | "model";
export type PaneControlOperationState = "accepted" | "running" | "applied" | "confirmed" | "rejected" | "failed" | "uncertain";
export type RetiredPaneCleanupState = "pending" | "waiting_busy" | "executing" | "succeeded" | "retained";
export type PromptWorkHint =
  | { kind: "prompt-ready"; bindingId: string }
  | { kind: "control-ready"; bindingId: string }
  | { kind: "steering-ready"; bindingId: string; parentPromptId: string }
  | { kind: "detached-observer-ready"; bindingId: string; promptId: string }
  | { kind: "binding-runtime-changed"; bindingId: string };

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

export interface DurablePromptWorkScan {
  cancelled: number;
  failedDetached: number;
  hints: PromptWorkHint[];
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

export type DeadLetterActionOutcome = "retried" | "dismissed" | "missing" | "unauthorized" | "stale";

export interface ProjectConfig {
  id: string;
  displayName: string;
  spaceName?: string | undefined;
  description: string;
  workspaceId: string;
  cwd: string;
  maxInstances?: number;
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

export interface Binding {
  id: string;
  creatorOpenId: string | null;
  projectId: string | null;
  workspaceId: string;
  chatId: string;
  topicId: string | null;
  rootMessageId: string | null;
  retiredTopicId: string | null;
  retiredRootMessageId: string | null;
  replacesBindingId: string | null;
  reservedTopicId: string | null;
  reservedRootMessageId: string | null;
  resetMessageId: string | null;
  paneId: string | null;
  traexSessionId: string | null;
  agentSessionSource?: string | null;
  agentSessionAgent?: string | null;
  agentSessionKind?: "id" | "path" | null;
  agentSessionValue?: string | null;
  title: string;
  runtime: "traex";
  state: BindingState;
  statusMessageId: string | null;
  statusCardSequence: number;
  lastAgentState: AgentState;
  lastOutputFingerprint: string | null;
  lifecycle: SessionLifecycle;
  attachment: AttachmentState;
  generation: number;
  provisioningCheckpoint: ProvisioningCheckpoint;
  degradationCount: number;
  hasCompletedTurn: boolean;
  lastObservedAt: string | null;
  archivedAt: string | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
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

export type BindingMetadataPatch = Partial<Pick<Binding,
  | "projectId" | "topicId" | "rootMessageId" | "retiredTopicId" | "retiredRootMessageId"
  | "reservedTopicId" | "reservedRootMessageId" | "resetMessageId" | "paneId" | "traexSessionId"
  | "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue"
  | "title" | "statusMessageId" | "lastOutputFingerprint" | "lastActivityAt"
>>;

export interface PromptJob {
  id: string;
  bindingId: string;
  larkMessageId: string;
  actorOpenId: string;
  body: string;
  executionOrigin: "bridge" | "herdr";
  dispatchKind: PromptDispatchKind;
  parentPromptId: string | null;
  steeringOrigin: SteeringOrigin | null;
  sourcePromptId: string | null;
  wasDetached: boolean;
  dispatchedAt: string | null;
  transcriptTurnId: string | null;
  transcriptTurnStartedAt: string | null;
  observationState: PromptObservationState;
  state: PromptState;
  attemptCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalTurnAdoption {
  outcome: "adopted_queued" | "created_external" | "already_owned" | "stale_binding" | "conflict";
  prompt: PromptJob | null;
  supersededPromptIds: string[];
  outboxReserved: boolean;
}

export interface ExternalTurnSupersessionFence {
  promptId: string;
  turnId: string;
  startedAt: string;
}

export type TranscriptTurnClaimOutcome =
  | { state: "claimed"; prompt: PromptJob }
  | { state: "matched"; prompt: PromptJob }
  | { state: "conflict"; prompt: PromptJob }
  | { state: "ineligible"; prompt: PromptJob | null };

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

export interface OutboundReply {
  id: string;
  idempotencyKey: string;
  bindingId: string | null;
  promptId: string | null;
  workerTurnId: string | null;
  viewVersion: number | null;
  cardSequence: number | null;
  selectionId: string | null;
  cardRole: RequestCardRole | null;
  targetRole: OutboundTargetRole | null;
  rootMessageId: string;
  kind: OutboundReplyKind;
  payload: string;
  state: OutboundReplyState;
  attemptCount: number;
  error: string | null;
  deliveredMessageId: string | null;
  cardIdCheckpoint: string | null;
  failureClass: DeliveryFailureClass | null;
  httpStatus: number | null;
  larkErrorCode: string | null;
  autoRecoveryCount: number;
  deadLetteredAt: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerPage {
  promptId: string;
  pageIndex: number;
  messageId: string | null;
  cardId: string | null;
  elementId: string;
  sourceStart: number;
  sequence: number;
  state: AnswerPageState;
  deliveryMode: AnswerPageDeliveryMode;
  createdAt: string;
  updatedAt: string;
}

export interface AnswerPageDeliveryFacts {
  latestContent: { content: string; sequence: number; state: OutboundReplyState; sourceEnd?: number | null } | null;
  finishPending: boolean;
  continuationPending: boolean;
}

export type AnswerPageReservationOutcome = "reserved" | "waiting" | "stale";

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
  lastDiscovered: { turns: number; steering: number; detached: number; cancelled: number; failedDetached: number };
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

export interface ProjectSelection {
  id: string;
  commandMessageId: string;
  selectorMessageId: string | null;
  chatId: string;
  topicId: string | null;
  rootMessageId: string;
  actorOpenId: string;
  requestedTitle: string | null;
  initialPromptText: string | null;
  selectedProjectId: string | null;
  bindingId: string | null;
  state: ProjectSelectionState;
  error: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export type ProjectSelectionClaim =
  | { outcome: "claimed" | "processing" | "completed"; selection: ProjectSelection }
  | { outcome: "missing" | "invalid" | "unauthorized" | "expired"; selection: ProjectSelection | null };

export interface HerdrPane {
  paneId: string;
  tabId?: string | null;
  terminalId?: string | null;
  agentSession?: HerdrAgentSession | null;
  agentKind?: string | null;
  outputRevision?: number | null;
  stateChangeSeq?: number | null;
  workspaceId: string;
  cwd: string | null;
  foregroundCwd?: string | null;
  label: string | null;
  agentState: AgentState;
  foregroundExecutables: string[];
}

export interface RuntimeObservation {
  pane: HerdrPane | null;
  traexProcess: boolean;
  composerReady: boolean;
  evidenceSource: "structured" | "process" | "none";
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

export interface RuntimeTurnObservation {
  state: AgentState;
  stateSource: "structured" | "unknown";
}

export interface HerdrPaneCreationOptions {
  bindingId: string;
  generation: number;
  projectId: string;
  placement?: "split" | "dedicated-tab";
  title?: string;
  environment?: Record<string, string>;
}

export interface IncomingLarkMessage {
  eventId: string;
  messageId: string;
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
  | { kind: "help" };

export type InstanceCommand =
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "instances" }
  | { kind: "instance"; name: string }
  | { kind: "to"; name: string; text: string }
  | { kind: "steer_instance"; name: string; text: string }
  | { kind: "interrupt_instance"; name: string };
