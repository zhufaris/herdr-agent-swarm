import type { BindingProvisioningStore, RetiredPaneCleanupStore, RuntimeIdentityTransitionApplication, RuntimeReconciliationStore } from "../../domain/ports/binding.js";
import type { Binding, HerdrPane } from "../../domain/types.js";
import type { PaneRetentionStore, SessionAdministrationStore } from "../../domain/ports/workflow.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteBindingProjectionStore } from "./binding-projection-store.js";
import type { SqliteInboundProjectStore } from "./inbound-project-store.js";
import type { SqliteOperationsStore } from "./operations-store.js";
import type { SqlitePaneOperationStore } from "./pane-operation-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqlitePromptStore } from "./prompt-store.js";
import type { SqliteRuntimeIdentityClaimStore } from "./runtime-identity-claim-store.js";

export class SqliteBindingSessionCapabilityStore implements BindingProvisioningStore, RuntimeReconciliationStore, RetiredPaneCleanupStore, SessionAdministrationStore, PaneRetentionStore {
  constructor(
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly runtimeIdentityClaims: SqliteRuntimeIdentityClaimStore,
    private readonly bindingProjections: SqliteBindingProjectionStore,
    private readonly prompts: SqlitePromptStore,
    private readonly projections: SqliteProjectionStore,
    private readonly inboundProjects: SqliteInboundProjectStore,
    private readonly paneOperations: SqlitePaneOperationStore,
    private readonly operations: SqliteOperationsStore
  ) {}

  applyRuntimeIdentityTransition(input: Parameters<BindingProvisioningStore["applyRuntimeIdentityTransition"]>[0]): RuntimeIdentityTransitionApplication {
    if (input.kind === "observe_binding_pane" || input.kind === "stage_binding_pane") {
      const staged = input.kind === "stage_binding_pane";
      return this.runtimeIdentityClaims.applyRuntimeIdentityTransition({ expected: [input.expected], release: [], targetOwner: input.expected.owner, targetBindingId: input.expected.owner.bindingId, claim: staged ? "defer" : "if_complete" }, () => {
        const patch = paneIdentityPatch(input.pane, staged);
        const identified = this.bindings.persistBindingPatch(input.expected.owner.bindingId, patch);
        return { outcome: "binding_updated" as const, binding: this.bindings.transitionBinding(identified.id, input.transition) };
      });
    }
    if (input.kind === "replace_provisioning_pane") {
      const targetOwner = { ...input.expected.owner, bindingGeneration: input.expected.owner.bindingGeneration + 1 };
      return this.runtimeIdentityClaims.applyRuntimeIdentityTransition({ expected: [input.expected], release: [input.expected], targetOwner, targetBindingId: input.expected.owner.bindingId, claim: "if_complete" }, () => ({
        outcome: "binding_updated" as const,
        binding: this.bindings.replaceProvisioningPane({ bindingId: input.expected.owner.bindingId, expectedPaneId: input.expected.paneId ?? "", expectedGeneration: input.expected.owner.bindingGeneration, pane: input.pane })
      }));
    }
    if (input.kind === "attach_binding_pane") {
      const targetOwner = { ...input.expected.owner, bindingGeneration: input.expected.owner.bindingGeneration + (input.replacement ? 1 : 0) };
      return this.runtimeIdentityClaims.applyRuntimeIdentityTransition({ expected: [input.expected], release: input.replacement ? [input.expected] : [], targetOwner, targetBindingId: input.expected.owner.bindingId, claim: "if_complete" }, () => ({
        outcome: "binding_updated" as const,
        binding: this.bindings.attachBindingPane(input.expected.owner.bindingId, input.pane, input.replacement)
      }));
    }
    if (input.kind === "cutover_reset_candidate") {
      return this.runtimeIdentityClaims.applyRuntimeIdentityTransition({ expected: [input.expectedPrevious, input.expectedReplacement], release: [input.expectedPrevious], targetOwner: input.expectedReplacement.owner, targetBindingId: input.expectedReplacement.owner.bindingId, claim: "if_complete" }, () => ({
        outcome: "reset_cutover" as const,
        ...this.bindings.cutoverResetCandidate({
          oldBindingId: input.expectedPrevious.owner.bindingId,
          newBindingId: input.expectedReplacement.owner.bindingId,
          cleanupOperationId: input.cleanupOperationId,
          actorOpenId: input.actorOpenId,
          expectedCwd: input.expectedCwd
        })
      }));
    }
    return this.runtimeIdentityClaims.applyRuntimeIdentityTransition({ expected: [input.expectedPrevious, input.expectedReplacement], release: [input.expectedPrevious], targetOwner: input.expectedReplacement.owner, targetBindingId: input.expectedReplacement.owner.bindingId, claim: "if_complete" }, () => ({
      outcome: "attached_thread_cutover" as const,
      ...this.bindings.cutoverAttachedPaneThread({
        oldBindingId: input.expectedPrevious.owner.bindingId,
        newBindingId: input.expectedReplacement.owner.bindingId,
        actorOpenId: input.actorOpenId
      })
    }));
  }

  adoptBindingReviewOwnerIfEmpty(input: Parameters<BindingProvisioningStore["adoptBindingReviewOwnerIfEmpty"]>[0]): ReturnType<BindingProvisioningStore["adoptBindingReviewOwnerIfEmpty"]> { return this.bindings.adoptBindingReviewOwnerIfEmpty(input); }
  audit(input: Parameters<BindingProvisioningStore["audit"]>[0]): void { this.operations.audit(input); }
  claimProjectSelection(input: Parameters<BindingProvisioningStore["claimProjectSelection"]>[0]): ReturnType<BindingProvisioningStore["claimProjectSelection"]> { return this.inboundProjects.claimProjectSelection(input); }
  completeProjectSelection(...args: Parameters<BindingProvisioningStore["completeProjectSelection"]>): ReturnType<BindingProvisioningStore["completeProjectSelection"]> { return this.inboundProjects.completeProjectSelection(...args); }
  countPendingPrompts(bindingId: string): number { return this.prompts.countPendingPrompts(bindingId); }
  hasActiveOrchestratorIdentityMigration(bindingId: string): boolean { return this.bindings.hasActiveOrchestratorIdentityMigration(bindingId); }
  hasActiveOrchestratorIdentityMigrationForPane(pane: Parameters<RuntimeReconciliationStore["hasActiveOrchestratorIdentityMigrationForPane"]>[0]): boolean { return this.bindings.hasActiveOrchestratorIdentityMigrationForPane(pane); }
  reconcileRuntimeIdentity(input: Parameters<RuntimeReconciliationStore["reconcileRuntimeIdentity"]>[0]): ReturnType<RuntimeReconciliationStore["reconcileRuntimeIdentity"]> {
    if (!input.recovery) return this.runtimeIdentityClaims.reconcileRuntimeIdentity(input);
    return this.runtimeIdentityClaims.reconcileRuntimeIdentity({
      ...input,
      recoverOrphan: (recovery) => this.bindingProjections.recoverOrphanBindingWithProjection({ ...recovery, bindingId: input.bindingId, expectedPaneId: input.expectedPaneId, expectedGeneration: input.expectedGeneration, pane: input.pane })
    });
  }
  createPendingBinding(input: Parameters<BindingProvisioningStore["createPendingBinding"]>[0]): ReturnType<BindingProvisioningStore["createPendingBinding"]> { return this.bindings.createPendingBinding(input); }
  createOrGetPendingOrchestratorBinding(input: Parameters<BindingProvisioningStore["createOrGetPendingOrchestratorBinding"]>[0]): ReturnType<BindingProvisioningStore["createOrGetPendingOrchestratorBinding"]> { return this.bindings.createOrGetPendingOrchestratorBinding(input); }
  createAutomaticProjectSelection(input: Parameters<BindingProvisioningStore["createAutomaticProjectSelection"]>[0]): ReturnType<BindingProvisioningStore["createAutomaticProjectSelection"]> { return this.inboundProjects.createAutomaticProjectSelection(input); }
  createProjectSelection(input: Parameters<BindingProvisioningStore["createProjectSelection"]>[0]): ReturnType<BindingProvisioningStore["createProjectSelection"]> { return this.inboundProjects.createProjectSelection(input); }
  failProjectSelection(...args: Parameters<BindingProvisioningStore["failProjectSelection"]>): ReturnType<BindingProvisioningStore["failProjectSelection"]> { return this.inboundProjects.failProjectSelection(...args); }
  findBindingByLarkScope(...args: Parameters<BindingProvisioningStore["findBindingByLarkScope"]>): ReturnType<BindingProvisioningStore["findBindingByLarkScope"]> { return this.bindings.findBindingByLarkScope(...args); }
  findOrchestratorBinding(...args: Parameters<BindingProvisioningStore["findOrchestratorBinding"]>): ReturnType<BindingProvisioningStore["findOrchestratorBinding"]> { return this.bindings.findOrchestratorBinding(...args); }
  findBindingByPane(paneId: string): ReturnType<BindingProvisioningStore["findBindingByPane"]> { return this.bindings.findBindingByPane(paneId); }
  getBinding(id: string): ReturnType<BindingProvisioningStore["getBinding"]> { return this.bindings.getBinding(id); }
  linkProjectSelectionBinding(...args: Parameters<BindingProvisioningStore["linkProjectSelectionBinding"]>): ReturnType<BindingProvisioningStore["linkProjectSelectionBinding"]> { return this.inboundProjects.linkProjectSelectionBinding(...args); }
  listBindings(): ReturnType<PaneRetentionStore["listBindings"]> { return this.bindings.listBindings(); }
  listBindingsByState(state: Parameters<BindingProvisioningStore["listBindingsByState"]>[0]): ReturnType<BindingProvisioningStore["listBindingsByState"]> { return this.bindings.listBindingsByState(state); }
  hasBindingPrimaryToolCapability(...args: Parameters<BindingProvisioningStore["hasBindingPrimaryToolCapability"]>): boolean { return this.bindings.hasPrimaryToolCapability(...args); }
  revokeBindingPrimaryToolCapability(...args: Parameters<BindingProvisioningStore["revokeBindingPrimaryToolCapability"]>): boolean { return this.bindings.revokePrimaryToolCapability(...args); }
  listProcessingProjectSelections(): ReturnType<BindingProvisioningStore["listProcessingProjectSelections"]> { return this.inboundProjects.listProcessingProjectSelections(); }
  loadTopicView(bindingId: string): ReturnType<BindingProvisioningStore["loadTopicView"]> { return this.projections.loadTopicView(bindingId); }
  pauseProjectSelection(...args: Parameters<BindingProvisioningStore["pauseProjectSelection"]>): ReturnType<BindingProvisioningStore["pauseProjectSelection"]> { return this.inboundProjects.pauseProjectSelection(...args); }
  recordBridgeMessage(messageId: string): void { this.inboundProjects.recordBridgeMessage(messageId); }
  createResetCandidate(input: Parameters<BindingProvisioningStore["createResetCandidate"]>[0]): ReturnType<BindingProvisioningStore["createResetCandidate"]> { return this.bindings.createResetCandidate(input); }
  saveTopicView(view: Parameters<BindingProvisioningStore["saveTopicView"]>[0]): void { this.projections.saveTopicView(view); }
  transitionBinding(...args: Parameters<BindingProvisioningStore["transitionBinding"]>): ReturnType<BindingProvisioningStore["transitionBinding"]> { return this.bindings.transitionBinding(...args); }
  updateBindingMetadata(...args: Parameters<BindingProvisioningStore["updateBindingMetadata"]>): ReturnType<BindingProvisioningStore["updateBindingMetadata"]> { return this.bindings.updateBindingMetadata(...args); }

  backfillRunCardPaneToken(input: Parameters<RuntimeReconciliationStore["backfillRunCardPaneToken"]>[0]): ReturnType<RuntimeReconciliationStore["backfillRunCardPaneToken"]> { return this.bindingProjections.backfillRunCardPaneToken(input); }
  reconcileBindingTitleWithProjection(input: Parameters<RuntimeReconciliationStore["reconcileBindingTitleWithProjection"]>[0]): ReturnType<RuntimeReconciliationStore["reconcileBindingTitleWithProjection"]> { return this.bindingProjections.reconcileBindingTitleWithProjection(input); }
  degradeBindingWithProjection(input: Parameters<RuntimeReconciliationStore["degradeBindingWithProjection"]>[0]): ReturnType<RuntimeReconciliationStore["degradeBindingWithProjection"]> { return this.bindingProjections.degradeBindingWithProjection(input); }
  orphanBindingWithProjection(input: Parameters<RuntimeReconciliationStore["orphanBindingWithProjection"]>[0]): ReturnType<RuntimeReconciliationStore["orphanBindingWithProjection"]> { return this.bindingProjections.orphanBindingWithProjection(input); }
  claimRetiredPaneCleanup(id: string): ReturnType<RetiredPaneCleanupStore["claimRetiredPaneCleanup"]> { return this.bindings.claimRetiredPaneCleanup(id); }
  completeRetiredPaneCleanup(id: string): ReturnType<RetiredPaneCleanupStore["completeRetiredPaneCleanup"]> { return this.bindings.completeRetiredPaneCleanup(id); }
  listRetiredPaneCleanupOperations(states?: Parameters<RetiredPaneCleanupStore["listRetiredPaneCleanupOperations"]>[0]): ReturnType<RetiredPaneCleanupStore["listRetiredPaneCleanupOperations"]> { return this.bindings.listRetiredPaneCleanupOperations(states); }
  updateRetiredPaneCleanup(...args: Parameters<RetiredPaneCleanupStore["updateRetiredPaneCleanup"]>): ReturnType<RetiredPaneCleanupStore["updateRetiredPaneCleanup"]> { return this.bindings.updateRetiredPaneCleanup(...args); }

  cancelQueuedPromptsWithProjection(input: Parameters<SessionAdministrationStore["cancelQueuedPromptsWithProjection"]>[0]): ReturnType<SessionAdministrationStore["cancelQueuedPromptsWithProjection"]> { return this.prompts.cancelQueuedPromptsWithProjection(input); }
  transitionBindingWithOutbox(input: Parameters<SessionAdministrationStore["transitionBindingWithOutbox"]>[0]): ReturnType<SessionAdministrationStore["transitionBindingWithOutbox"]> { return this.bindingProjections.transitionBindingWithOutbox(input); }

  createAutomaticPaneCloseOperation(input: Parameters<PaneRetentionStore["createAutomaticPaneCloseOperation"]>[0]): void { this.paneOperations.createAutomaticPaneCloseOperation(input); }
  finishPaneCloseRequest(...args: Parameters<PaneRetentionStore["finishPaneCloseRequest"]>): void { this.paneOperations.finishPaneCloseRequest(...args); }
  listUnresolvedPaneCloseOperations(): ReturnType<PaneRetentionStore["listUnresolvedPaneCloseOperations"]> { return this.paneOperations.listUnresolvedPaneCloseOperations(); }
}

function paneIdentityPatch(pane: HerdrPane, staged: boolean): Pick<Binding, "workspaceId" | "paneId" | "paneToken" | "traexSessionId" | "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue"> {
  return {
    workspaceId: pane.workspaceId,
    paneId: staged ? null : pane.paneId,
    paneToken: pane.paneToken ?? null,
    traexSessionId: pane.terminalId ?? null,
    agentSessionSource: pane.agentSession?.source ?? null,
    agentSessionAgent: pane.agentSession?.agent ?? null,
    agentSessionKind: pane.agentSession?.kind ?? null,
    agentSessionValue: pane.agentSession?.value ?? null
  };
}
