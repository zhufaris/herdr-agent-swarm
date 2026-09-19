export interface PanePresentation {
  paneCloseConfirmation(input: { spaceName: string; paneId: string; agentState: string; workerPaneCount: number; code: string; expiresAt: string }): object;
  paneCloseResult(input: { paneId: string; workerPaneCount?: number; workerPaneSucceededCount?: number; workerPaneRetainedCount?: number; workerPaneUncertainCount?: number }): object;
  paneRetentionWarning(input: { paneId: string; warningAt: string; closeAt: string }): object;
  requestRejected(message: string): object;
}

import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { WorkerTurnCardPage, WorkerTurnCardView } from "../worker-turn-card-view.js";
import type { TurnControlOperation } from "../turn-control.js";
import type { AgentInstance, InstanceRemovalPlan, InstanceTarget, WorkspaceLease } from "../agent-instance.js";
import type { AgentCapabilities } from "../agent-runtime.js";
import type { ModelPreference, TraexModelSummary } from "../model-selection.js";
import type { WorkerMainView } from "../worker-main-view.js";
import type { Binding, FailureSummary, ProjectConfig, SessionPage } from "../types.js";
import type { InstanceTurnSummary } from "../instance-turn.js";
import type { WorkerHumanReviewNotificationInput } from "../worker-human-review.js";
import type { NaturalLanguageCommandConfirmation } from "../natural-language-command-confirmation.js";

export interface PrimaryPresentation {
  mainCard(view: TopicViewState): object;
  paneEntryCard(view: TopicViewState): object;
  answerCard(view: RunCardView, options?: { pageNumber?: number; initialContent?: string; streaming?: boolean }): object;
  disconnectedTopic(reason: "archived" | "unbound"): object;
  requestRejected(message: string): object;
  finalAnswer(view: RunCardView, options: { pageNumber?: number; initialContent: string; answerElementId?: string }): object | null;
  answerStreamContent(view: RunCardView): string;
  answerStreamPage(content: string, pageStart: number, limit?: number): { page: string; nextPageStart: number | null };
  finalAnswerPage(content: string, pageStart: number, pageEnd?: number): { page: string; nextPageStart: number | null };
}

export interface WorkerPresentation {
  workerTurn(view: WorkerTurnCardView, page?: WorkerTurnCardPage): object;
  workerHumanReviewNotification(input: WorkerHumanReviewNotificationInput): object;
  workerTurnProgress(view: WorkerTurnCardView): string;
  turnControlResult(operation: TurnControlOperation): object;
  workerTurnPage(view: WorkerTurnCardView, pageStart: number, limit: number): { page: string; nextPageStart: number | null; sourceLength: number };
  safeWorkerOutput(value: string): string;
}

export interface SpaceDirectoryPane {
  paneId: string; name: string; agentState: import("../types.js").AgentState; foregroundExecutables: string[]; bindingId?: string; claimProjectId?: string;
}
export interface SpaceDirectoryGroup { spaceName: string; workspaceId: string; directories: string[]; panes: SpaceDirectoryPane[]; error?: string; unregistered?: boolean; }
export interface TopicPaneDirectoryWorker { workerId: string; runtimeGeneration: number; workerSessionGeneration: number; workerName: string; paneId: string | null; state: import("../agent-instance.js").ObservedInstanceState; }
export interface TopicPaneDirectoryEntry { bindingId: string; bindingGeneration: number; paneId: string; sourceMainMessageId: string; title: string; spaceName: string; agentState: import("../runtime-observation.js").AgentState; workers: TopicPaneDirectoryWorker[]; }
export interface InstanceDirectoryEntry { instance: AgentInstance; workspace: WorkspaceLease; capabilities: AgentCapabilities; queueDepth: number; approvalCount?: number; }
export interface ThreadPrimaryView { bindingId: string; generation: number; paneId: string | null; state: Binding["state"]; }
export type InteractionToast = { toast: { type: "success" | "warning" | "error"; content: string } };

export interface ApplicationPresentation extends PrimaryPresentation, WorkerPresentation {
  naturalLanguageCommandConfirmation(input: NaturalLanguageCommandConfirmation): object;
  naturalLanguageCommandGuidance(input: { title: string; message: string; examples: readonly string[]; warning?: boolean }): object;
  commandResult(input: { title: string; text: string }): object;
  projectDirectory(input: { projects: readonly ProjectConfig[]; selectedProjectId?: string }): object;
  projectSelector(input: { selectionId: string; projects: ProjectConfig[] }): object;
  projectSelectionStatus(input: { status: "processing" | "recoverable" | "completed" | "failed" | "expired" | "unauthorized"; projectName?: string; spaceName?: string; paneId?: string; bindingId?: string; message?: string }): object;
  attachStatus(input: { spaceName: string; paneId: string; bindingId?: string; alreadyAttached?: boolean; resumeRequired?: boolean }): object;
  help(): object;
  awakeStatus(message: string, recovered?: boolean): object;
  skipStatus(message: string, outcome: "skipped" | "none" | "stale"): object;
  modelSelection(input: { bindingId: string; spaceName: string; paneId: string; models: readonly TraexModelSummary[]; preference: ModelPreference | null; notice?: string }): object;
  modelResult(input: { bindingId: string; spaceName: string; paneId: string; output: string; switched: boolean }): object;
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
  workerThreadAccepted(input: { workerName: string; queuePosition: number; duplicate: boolean }): object;
}
