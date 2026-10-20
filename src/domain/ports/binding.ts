import type { Binding, BindingMetadataPatch, BindingTitleProjectionInput, BindingTitleProjectionResult, HerdrPane, OrphanBindingProjectionInput, OrphanBindingProjectionResult, RecoverOrphanBindingProjectionInput, RuntimeDegradationInput, RuntimeDegradationResult, RuntimeIdentityReconciliationApplication, RuntimeIdentityReconciliationPolicy } from "../types.js";
import type { ProjectSelection, ProjectSelectionClaim, RetiredPaneCleanupOperation } from "../types.js";
import type { TopicViewState } from "../topic-view.js";
import type { SessionTransition } from "../pane-thread-lifecycle.js";
import type { AgentKind } from "../agent-instance.js";
import type { NativeRuntimeIdentity, RuntimeIdentityOwner } from "../runtime-identity-claim.js";

export type CurrentRuntimeIdentityClaimOutcome = "claimed" | "unchanged" | "stale" | "conflict";

export interface RuntimeIdentityTransitionFence {
  owner: RuntimeIdentityOwner;
  workspaceId: string;
  paneId: string | null;
  terminalId: string | null;
  attachment: Binding["attachment"];
  nativeIdentity: NativeRuntimeIdentity | null;
}

export type RuntimeIdentityTransitionInput =
  | { kind: "observe_binding_pane"; expected: RuntimeIdentityTransitionFence; pane: HerdrPane; transition: SessionTransition }
  | { kind: "stage_binding_pane"; expected: RuntimeIdentityTransitionFence; pane: HerdrPane; transition: SessionTransition }
  | { kind: "replace_provisioning_pane"; expected: RuntimeIdentityTransitionFence; pane: HerdrPane }
  | { kind: "attach_binding_pane"; expected: RuntimeIdentityTransitionFence; pane: HerdrPane; replacement: boolean }
  | { kind: "cutover_reset_candidate"; cleanupOperationId: string; actorOpenId: string; expectedCwd: string; expectedPrevious: RuntimeIdentityTransitionFence; expectedReplacement: RuntimeIdentityTransitionFence }
  | { kind: "cutover_attached_pane_thread"; actorOpenId: string; expectedPrevious: RuntimeIdentityTransitionFence; expectedReplacement: RuntimeIdentityTransitionFence };

export type RuntimeIdentityTransitionApplication =
  | { outcome: "binding_updated"; binding: Binding }
  | { outcome: "reset_cutover"; previous: Binding; replacement: Binding; cleanup: RetiredPaneCleanupOperation; cancelledPromptIds: string[] }
  | { outcome: "attached_thread_cutover"; previous: Binding; replacement: Binding; cancelledPromptIds: string[] };

export interface RuntimeReconciliationStore {
  hasActiveOrchestratorIdentityMigration(bindingId: string): boolean;
  hasActiveOrchestratorIdentityMigrationForPane(pane: Pick<HerdrPane, "workspaceId" | "paneId" | "terminalId" | "paneToken">): boolean;
  reconcileRuntimeIdentity(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; expectedSessionEpoch: number; pane: HerdrPane; decide: RuntimeIdentityReconciliationPolicy; recovery?: Omit<RecoverOrphanBindingProjectionInput, "bindingId" | "expectedPaneId" | "expectedGeneration" | "pane"> }): RuntimeIdentityReconciliationApplication;
  backfillRunCardPaneToken(input: { bindingId: string; expectedGeneration: number; paneToken: string; occurredAt: string }): string[];
  reconcileBindingTitleWithProjection(input: BindingTitleProjectionInput): BindingTitleProjectionResult;
  degradeBindingWithProjection(input: RuntimeDegradationInput): RuntimeDegradationResult;
  countPendingPrompts(bindingId: string): number;
  findBindingByPane(paneId: string): Binding | null;
  loadTopicView(bindingId: string): TopicViewState | null;
  listBindingsByState(state: Binding["state"]): Binding[];
  orphanBindingWithProjection(input: OrphanBindingProjectionInput): OrphanBindingProjectionResult;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  updateBindingMetadata(id: string, patch: BindingMetadataPatch): Binding;
}

export interface BindingProvisioningStore {
  applyRuntimeIdentityTransition(input: RuntimeIdentityTransitionInput): RuntimeIdentityTransitionApplication;
  adoptBindingReviewOwnerIfEmpty(input: { bindingId: string; expectedGeneration: number; expectedPaneId: string; actorOpenId: string }): Binding | null;
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  claimProjectSelection(input: { selectionId: string; projectId: string; messageId: string; chatId: string; actorOpenId: string; allowedProjectIds: string[] }): ProjectSelectionClaim;
  completeProjectSelection(id: string, bindingId: string): ProjectSelection;
  countPendingPrompts(bindingId: string): number;
  createPendingBinding(input: { id: string; kind?: Binding["kind"]; gatewayId?: string; projectId?: string | null; workspaceId: string; chatId: string; topicId: string | null; rootMessageId: string | null; title: string; agentKind?: AgentKind; creatorOpenId?: string | null }): Binding;
  createOrGetPendingOrchestratorBinding(input: { id: string; gatewayId: string; projectId: string; workspaceId: string; chatId: string; title: string; creatorOpenId: string }): { binding: Binding; created: boolean };
  createAutomaticProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; initialPromptText?: string | null; agentKind?: AgentKind; projectId: string; expiresAt: string }): ProjectSelection;
  createProjectSelection(input: { id: string; commandMessageId: string; chatId: string; topicId: string | null; rootMessageId: string; actorOpenId: string; requestedTitle: string | null; initialPromptText?: string | null; agentKind?: AgentKind; expiresAt: string; card: object }): ProjectSelection;
  failProjectSelection(id: string, error: string): ProjectSelection;
  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null;
  findOrchestratorBinding(gatewayId: string, chatId: string): Binding | null;
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
