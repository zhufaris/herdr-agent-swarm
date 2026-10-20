export interface PanePresentation {
  paneCloseConfirmation(input: { spaceName: string; paneId: string; paneToken?: string | null; agentState: string; workerPaneCount: number; code: string; expiresAt: string }): object;
  paneCloseResult(input: { paneId: string; paneToken?: string | null; workerPaneCount?: number; workerPaneSucceededCount?: number; workerPaneRetainedCount?: number; workerPaneUncertainCount?: number }): object;
  paneRetentionWarning(input: { paneId: string; paneToken?: string | null; warningAt: string; closeAt: string }): object;
  requestRejected(message: string): object;
}

import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { PaneIdentitySnapshot } from "../worker-main-view.js";
import type { WorkerTurnCardPage, WorkerTurnCardView } from "../worker-turn-card-view.js";
import type { TurnControlOperation } from "../turn-control.js";
import type { AgentInstance, InstanceRemovalPlan, InstanceTarget, WorkspaceLease } from "../agent-instance.js";
import type { AgentCapabilities } from "../agent-runtime.js";
import type { ModelPreferenceSnapshot, TraexModelSummary } from "../model-selection.js";
import type { WorkerMainView } from "../worker-main-view.js";
import type { AnswerTimelineCursor, Binding, FailureSummary, ProjectConfig, SessionPage } from "../types.js";
import type { PresentationSnapshot } from "../delivery.js";
import type { InstanceTurnSummary } from "../instance-turn.js";
import type { WorkerHumanReviewNotificationInput } from "../worker-human-review.js";
import type { PrimaryHumanReviewNotificationInput } from "../human-review.js";
import type { CompletionActionSetRenderState, CompletionReviewCardInput } from "../completion-action-set.js";
import type { RecoveryBindingResult } from "../recovery.js";
import type { NaturalLanguageCommandConfirmation } from "../natural-language-command-confirmation.js";
import type { OrchestratorClearOperation } from "../orchestrator-clear.js";
import type { CommandStatusView } from "../command-status-view.js";
import type { AnswerTimelineItem } from "../answer-timeline.js";
import type { AnswerSegment } from "../answer-segment.js";
import type { InputCardView } from "../input-card-view.js";
import type { SessionActivityView } from "../session-activity.js";
import type { TurnSessionStateView } from "../turn-session-state.js";
import type { ConversationSegmentCardView } from "./conversation-segment.js";
import type { DeliveryQuarantineReviewInput } from "../delivery-quarantine-review.js";
import type { ConversationPagePlan, ConversationPagePresentationBudget, ConversationPagePresentationMeasure } from "../conversation-segment.js";
export interface ConversationSegmentCardPage { pageIndex: number; elementId?: string; startCursor?: AnswerTimelineCursor | null; cursor?: AnswerTimelineCursor | null; }
export interface TurnCardRenderOptions { timelineItems?: readonly AnswerTimelineItem[]; continuation?: boolean; completionActions?: CompletionActionSetRenderState | null; completionActionsBudget?: CompletionActionSetRenderState | null; completionNotice?: { mentionOpenId: string; reason: import("./conversation-segment.js").SegmentCompletionReason } | null; completionNoticeBudget?: { mentionOpenId: string; reason: import("./conversation-segment.js").SegmentCompletionReason } | null; sessionActivity?: SessionActivityView | null; sessionState?: TurnSessionStateView | null; runtimeIdentity?: { branch: string | null; gitCommit: string | null } | null; }
export interface TurnCardPagePlan { card: object; items: readonly AnswerTimelineItem[]; nextCursor: AnswerTimelineCursor | null; }
export interface PresentationParityBounds { encodedBytes: number; elementCount: number; actionCount: number; }
export interface PresentationParityDescriptor {
  visibleStructureFingerprint: string;
  deliveryTarget: { kind: string; identityFingerprint: string };
  scopeOrder: { scopeFingerprint: string; ownerFingerprint: string; orderingIdentityFingerprint: string };
  idempotencyFingerprint: string;
  canonicalPageInterval: { pageIndex: number; startCursor: AnswerTimelineCursor | null; endCursor: AnswerTimelineCursor | null; hasContinuation: boolean };
  committedBounds: PresentationParityBounds;
  recomputedBounds: PresentationParityBounds;
}
export interface PresentationParityComparison {
  legacy: PresentationParityDescriptor;
  semantic: PresentationParityDescriptor;
  matched: boolean;
  mismatches: readonly string[];
}
export interface ConversationPagePresentationPolicy<TSnapshot, TView> {
  readonly plannerPolicyVersion: number;
  readonly rendererPolicyVersion: number;
  plan(view: ConversationSegmentCardView, page: ConversationSegmentCardPage, options: TurnCardRenderOptions, budget: ConversationPagePresentationBudget): { pagePlan: ConversationPagePlan; snapshot: TSnapshot };
  measure(snapshot: TSnapshot): ConversationPagePresentationMeasure;
  render(snapshot: TSnapshot): TView;
  compareLegacyPresentation(input: {
    legacyView: object;
    semanticSnapshot: TSnapshot;
    legacyDelivery: Omit<PresentationParityDescriptor, "visibleStructureFingerprint" | "committedBounds" | "recomputedBounds">;
    semanticDelivery: Omit<PresentationParityDescriptor, "visibleStructureFingerprint" | "committedBounds" | "recomputedBounds">;
  }): PresentationParityComparison;
}

export interface PrimaryPresentation {
  mainCard(view: TopicViewState, options?: { gapWarning?: string | null; sessionActivity?: SessionActivityView | null }): object;
  paneEntryCard(view: TopicViewState, options?: { gapWarning?: string | null; sessionActivity?: SessionActivityView | null }): object;
  answerCard(view: RunCardView, options?: { pageNumber?: number; initialContent?: string; streaming?: boolean; timelineItems?: readonly AnswerTimelineItem[]; gapWarning?: string | null; segment?: AnswerSegment }): object;
  disconnectedTopic(reason: "archived" | "unbound"): object;
  requestRejected(message: string): object;
  finalAnswer(view: RunCardView, options: { pageNumber?: number; initialContent: string; answerElementId?: string; timelineItems?: readonly AnswerTimelineItem[]; gapWarning?: string | null; segment?: AnswerSegment; completionActions?: CompletionActionSetRenderState | null }): object | null;
  answerStreamContent(view: RunCardView): string;
  answerStreamPage(content: string, pageStart: number, limit?: number): { page: string; nextPageStart: number | null };
  finalAnswerPage(content: string, pageStart: number, pageEnd?: number): { page: string; nextPageStart: number | null };
  answerTimelinePage(items: readonly AnswerTimelineItem[], cursor: AnswerTimelineCursor | null, limit: number, prefixItems?: readonly AnswerTimelineItem[]): { items: AnswerTimelineItem[]; nextCursor: AnswerTimelineCursor | null };
  primaryHumanReviewNotification(input: PrimaryHumanReviewNotificationInput): object;
}

export interface WorkerPresentation {
  workerTurn(view: WorkerTurnCardView, page?: WorkerTurnCardPage, options?: { snapshot?: boolean; initialContent?: string; timelineItems?: readonly AnswerTimelineItem[]; gapWarning?: string | null; segment?: AnswerSegment; completionActions?: CompletionActionSetRenderState | null }): object;
  workerHumanReviewNotification(input: WorkerHumanReviewNotificationInput): object;
  workerTurnProgress(view: WorkerTurnCardView): string;
  turnControlResult(operation: TurnControlOperation): object;
  workerTurnPage(view: WorkerTurnCardView, pageStart: number, limit: number): { page: string; nextPageStart: number | null; sourceLength: number };
  safeWorkerOutput(value: string): string;
  answerTimelinePage(items: readonly AnswerTimelineItem[], cursor: AnswerTimelineCursor | null, limit: number, prefixItems?: readonly AnswerTimelineItem[]): { items: AnswerTimelineItem[]; nextCursor: AnswerTimelineCursor | null };
}

export interface SpaceDirectoryPane {
  paneId: string; paneToken?: string | null; name: string; agentState: import("../types.js").AgentState; foregroundExecutables: string[]; bindingId?: string; claimProjectId?: string;
}
export interface SpaceDirectoryGroup { spaceName: string; workspaceId: string; directories: string[]; panes: SpaceDirectoryPane[]; error?: string; unregistered?: boolean; }
export interface TopicPaneDirectoryWorker { workerId: string; runtimeGeneration: number; workerSessionGeneration: number; workerName: string; paneId: string | null; paneToken?: string | null; paneIdentity?: PaneIdentitySnapshot; threadId?: string | null; state: import("../agent-instance.js").ObservedInstanceState; }
export interface TopicPaneDirectoryEntry { bindingId: string; bindingGeneration: number; paneId: string; paneToken?: string | null; paneIdentity?: PaneIdentitySnapshot; sourceMainMessageId: string; chatId: string; threadId?: string | null; title: string; spaceName: string; agentState: import("../runtime-observation.js").AgentState; activityAt?: string | null; taskSummary?: string | null; workers: TopicPaneDirectoryWorker[]; }
export interface InstanceDirectoryEntry { instance: AgentInstance; workspace: WorkspaceLease; capabilities: AgentCapabilities; queueDepth: number; approvalCount?: number; }
export interface ThreadPrimaryView { bindingId: string; generation: number; paneId: string | null; state: Binding["state"]; }
export type InteractionToast = { toast: { type: "success" | "warning" | "error"; content: string } };

export interface ApplicationPresentation extends PrimaryPresentation, WorkerPresentation {
  turnCardSemanticPolicy: ConversationPagePresentationPolicy<PresentationSnapshot, unknown>;
  deliveryQuarantineReview(input: DeliveryQuarantineReviewInput): object;
  inputCard(view: InputCardView): object;
  turnCard(view: ConversationSegmentCardView | InputCardView, page?: ConversationSegmentCardPage, options?: TurnCardRenderOptions): object;
  turnCardPage(view: ConversationSegmentCardView, page: ConversationSegmentCardPage, options?: TurnCardRenderOptions, payloadLimit?: number): TurnCardPagePlan;
  completionReview(input: CompletionReviewCardInput): object;
  commandStatus(view: CommandStatusView): object;
  naturalLanguageCommandConfirmation(input: NaturalLanguageCommandConfirmation): object;
  orchestratorClearResult(input: OrchestratorClearOperation): object;
  naturalLanguageCommandGuidance(input: { title: string; message: string; examples: readonly string[]; warning?: boolean }): object;
  commandResult(input: { title: string; text: string }): object;
  projectDirectory(input: { projects: readonly ProjectConfig[]; selectedProjectId?: string }): object;
  projectSelector(input: { selectionId: string; projects: ProjectConfig[] }): object;
  projectSelectionStatus(input: { status: "processing" | "recoverable" | "completed" | "failed" | "expired" | "unauthorized"; projectName?: string; spaceName?: string; paneId?: string; paneToken?: string | null; bindingId?: string; message?: string }): object;
  attachStatus(input: { spaceName: string; paneId: string; paneToken?: string | null; bindingId?: string; alreadyAttached?: boolean; resumeRequired?: boolean }): object;
  help(): object;
  awakeStatus(result: RecoveryBindingResult): object;
  modelSelection(input: { bindingId: string; spaceName: string; paneId: string; paneToken?: string | null; models: readonly TraexModelSummary[]; snapshot: ModelPreferenceSnapshot; notice?: string }): object;
  modelResult(input: { bindingId: string; spaceName: string; paneId: string; paneToken?: string | null; output: string; switched: boolean }): object;
  sessions(page: SessionPage): object[];
  failures(failures: FailureSummary[], notice?: string): object[];
  spaces(groups: SpaceDirectoryGroup[]): object[];
  topicPanes(entries: TopicPaneDirectoryEntry[]): object;
  interactionToast(type: "success" | "warning" | "error", content: string): InteractionToast;
  interactionGuidance(input: { kind: "recovery" | "new_task"; message?: string | null }): object;
  moreActions(input: { bindingId: string; bindingGeneration: number; interactionId?: string; creator: boolean; lifecycle: string; attachment: string }): object;
  renameInput(input: { interactionId: string; bindingId: string; bindingGeneration: number }): object;
  reattachInput(input: { interactionId: string; bindingId: string; bindingGeneration: number }): object;
  primaryContinuationInput(input: { interactionId: string; bindingId: string; bindingGeneration: number; parentPromptId: string; sourceAnswerMessageId: string; requestedBy: string }): object;
  queueSummary(input: { queued: number }): object;
  instanceDirectory(input: { project: ProjectConfig; entries: InstanceDirectoryEntry[]; target: InstanceTarget; primary: ThreadPrimaryView | null; conversationKey?: string }): object;
  instanceDetail(input: { instance: AgentInstance; workspace: WorkspaceLease; capabilities: AgentCapabilities; turns: InstanceTurnSummary[]; activeTurnId?: string | null; queueDepth: number; conversationKey?: string; bindingId?: string; bindingGeneration?: number }): object;
  instanceCreate(input: { projectId: string; requestedBy: string; conversationKey?: string; bindingId?: string; bindingGeneration?: number }): object;
  instanceSteer(input: { instance: AgentInstance; requestedBy: string; conversationKey?: string; bindingId?: string; bindingGeneration?: number }): object;
  instanceRemovalPlan(input: { instance: AgentInstance; workspace: WorkspaceLease; plan: InstanceRemovalPlan; requestedBy: string; conversationKey?: string; bindingId?: string; bindingGeneration?: number }): object;
  workerTaskInstruction(input: { workerName: string; turnId: string; intent: "steer" | "followup"; interactionId: string; requestedBy: string; sourceCardMessageId: string; instanceId: string; generation: number; workerSessionGeneration: number }): object;
  workerNewTask(input: { workerName: string; interactionId: string; requestedBy: string; sourceCardMessageId: string; instanceId: string; generation: number; workerSessionGeneration: number }): object;
  workerMain(view: WorkerMainView): object;
  workerStatusSnapshot(view: WorkerMainView, generatedAt: string): object;
  workerThreadEntry(view: WorkerMainView, generatedAt: string): object;
  workerThreadEntryReady(input: { workerName: string; workerId: string; workerSessionGeneration: number; messageId: string }): object;
}
