import type { AttachmentState, ProvisioningCheckpoint, SessionLifecycle } from "./pane-thread-lifecycle.js";

export type BindingState = "pending" | "active" | "archived" | "orphaned" | "failed";
export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";
export interface HerdrAgentSession { source: string; agent: string; kind: "id" | "path"; value: string }
export type EventOrigin = "lark" | "herdr" | "bridge";
export type PromptState = "queued" | "running" | "delivered" | "failed" | "cancelled";
export type PromptDispatchKind = "turn" | "steering";
export type PromptObservationState = "not_started" | "attached" | "detached" | "completed";
export type OutboundReplyState = "pending" | "delivered" | "dead_letter" | "dismissed";
export type DeliveryFailureClass = "transient" | "permanent" | "unknown";
export interface DeliveryFailureMetadata { failureClass: DeliveryFailureClass; httpStatus: number | null; larkErrorCode: string | null }
export type OutboundReplyKind = "text" | "card_reply" | "card_update" | "stream_card_create" | "stream_content" | "stream_finish";
export type RequestCardRole = "task" | "answer";
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
}

export interface IncomingLarkCardAction {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  value: unknown;
  option?: string | null;
}

export interface Binding {
  id: string;
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

export interface PromptJob {
  id: string;
  bindingId: string;
  larkMessageId: string;
  actorOpenId: string;
  body: string;
  dispatchKind: PromptDispatchKind;
  parentPromptId: string | null;
  observationState: PromptObservationState;
  state: PromptState;
  attemptCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface OutboundReply {
  id: string;
  idempotencyKey: string;
  bindingId: string | null;
  promptId: string | null;
  viewVersion: number | null;
  selectionId: string | null;
  cardRole: RequestCardRole | null;
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

export interface OperationalSummary {
  bindings: Record<BindingState, number>;
  prompts: Record<PromptState, number>;
  promptDispatch: Record<PromptDispatchKind, number>;
  outbound: Record<OutboundReplyState, number>;
  pendingOutbox: number;
  deadLetters: number;
  deadLettersByClass: Record<DeliveryFailureClass | "legacy", number>;
  eligibleDeadLetterRecoveries: number;
  oldestPendingAt: string | null;
  outboxLanes: {
    pending: number; eligible: number; blocked: number; nextAttemptAt: string | null;
    oldestHeadAt: string | null; oldestHeadAgeSeconds: number | null;
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

export interface OutboxDispatcherDiagnostics {
  state: "idle" | "running" | "stopping";
  activeDeliveries: number;
  scanPending: boolean;
  lastScanAt: string | null;
  lastScanOutcome: "idle" | "delivered" | "failed" | null;
  lastDeliveryAt: string | null;
  lastDeliveryFailureAt: string | null;
}

export interface PromptWorkerDiagnostics {
  state: "idle" | "running" | "stopping";
  activeTurnWorkers: number;
  activeSteeringWorkers: number;
  lastScanAt: string | null;
  lastScanOutcome: "idle" | "work_found" | "failed" | null;
  lastDiscovered: { turns: number; steering: number; detached: number; cancelled: number };
  lastScanFailureAt: string | null;
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
  evidenceSource: "structured" | "recent" | "visible" | "process" | "none";
}

export interface RuntimeTurnObservation {
  state: AgentState;
  stateSource: "structured" | "terminal" | "unknown";
  output: string;
}

export interface HerdrPaneCreationOptions {
  bindingId: string;
  generation: number;
  projectId: string;
  placement?: "split" | "dedicated-tab";
  title?: string;
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
  | { kind: "help" };
