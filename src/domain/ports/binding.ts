import type { Binding, BindingMetadataPatch, BindingTitleProjectionInput, BindingTitleProjectionResult, HerdrPane, OrphanBindingProjectionInput, OrphanBindingProjectionResult, RecoverOrphanBindingProjectionInput, RecoverOrphanBindingProjectionResult, RuntimeDegradationInput, RuntimeDegradationResult } from "../types.js";
import type { ProjectSelection, ProjectSelectionClaim, RetiredPaneCleanupOperation, RuntimeObservationApplication } from "../types.js";
import type { TopicViewState } from "../topic-view.js";
import type { SessionTransition } from "../pane-thread-lifecycle.js";
import type { AgentKind } from "../agent-instance.js";

export interface RuntimeReconciliationStore {
  applyRuntimeObservation(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: HerdrPane }): RuntimeObservationApplication;
  reconcileBindingTitleWithProjection(input: BindingTitleProjectionInput): BindingTitleProjectionResult;
  degradeBindingWithProjection(input: RuntimeDegradationInput): RuntimeDegradationResult;
  countPendingPrompts(bindingId: string): number;
  findBindingByPane(paneId: string): Binding | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  listBindingsByState(state: Binding["state"]): Binding[];
  orphanBindingWithProjection(input: OrphanBindingProjectionInput): OrphanBindingProjectionResult;
  recoverOrphanBindingWithProjection(input: RecoverOrphanBindingProjectionInput): RecoverOrphanBindingProjectionResult;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  updateBindingMetadata(id: string, patch: BindingMetadataPatch): Binding;
}

export interface BindingProvisioningStore {
  attachBindingPane(id: string, pane: HerdrPane, replacement: boolean): Binding;
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  claimProjectSelection(input: { selectionId: string; projectId: string; messageId: string; chatId: string; actorOpenId: string; allowedProjectIds: string[] }): ProjectSelectionClaim;
  completeProjectSelection(id: string, bindingId: string): ProjectSelection;
  countPendingPrompts(bindingId: string): number;
  createPendingBinding(input: { id: string; gatewayId?: string; projectId?: string | null; workspaceId: string; chatId: string; topicId: string | null; rootMessageId: string | null; title: string; agentKind?: AgentKind; creatorOpenId?: string | null }): Binding;
  createAutomaticProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; initialPromptText?: string | null; agentKind?: AgentKind; projectId: string; expiresAt: string }): ProjectSelection;
  createProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; initialPromptText?: string | null; agentKind?: AgentKind; expiresAt: string; card: object }): ProjectSelection;
  failProjectSelection(id: string, error: string): ProjectSelection;
  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null;
  findBindingByPane(paneId: string): Binding | null;
  getBinding(id: string): Binding | null;
  linkProjectSelectionBinding(id: string, bindingId: string): ProjectSelection;
  listBindingsByState(state: Binding["state"]): Binding[];
  hasBindingPrimaryToolCapability(bindingId: string, expectedGeneration: number): boolean;
  revokeBindingPrimaryToolCapability(bindingId: string, expectedGeneration: number): boolean;
  listProcessingProjectSelections(): ProjectSelection[];
  loadTopicView(bindingId: string): TopicViewState | null;
  pauseProjectSelection(id: string, error: string): ProjectSelection;
  recordBridgeMessage(messageId: string): void;
  createResetCandidate(input: { oldBindingId: string; newBindingId: string; title: string; actorOpenId: string; resetMessageId: string }): { previous: Binding; replacement: Binding; created: boolean };
  cutoverResetCandidate(input: { oldBindingId: string; newBindingId: string; cleanupOperationId: string; actorOpenId: string; expectedCwd: string }): { previous: Binding; replacement: Binding; cleanup: RetiredPaneCleanupOperation; cancelledPromptIds: string[] };
  replaceProvisioningPane(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: HerdrPane }): Binding;
  saveTopicView(view: TopicViewState): void;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  updateBindingMetadata(id: string, patch: BindingMetadataPatch): Binding;
}

export interface RetiredPaneCleanupStore {
  claimRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null;
  completeRetiredPaneCleanup(id: string): RetiredPaneCleanupOperation | null;
  countPendingPrompts(bindingId: string): number;
  getBinding(id: string): Binding | null;
  listRetiredPaneCleanupOperations(states?: readonly RetiredPaneCleanupOperation["state"][]): RetiredPaneCleanupOperation[];
  updateRetiredPaneCleanup(id: string, state: RetiredPaneCleanupOperation["state"], detail?: string | null): RetiredPaneCleanupOperation | null;
}
