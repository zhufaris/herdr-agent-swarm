import type { BindingProvisioningStore, RetiredPaneCleanupStore, RuntimeReconciliationStore } from "../../domain/ports/binding.js";
import type { PaneRetentionStore, SessionAdministrationStore } from "../../domain/ports/workflow.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteBindingProjectionStore } from "./binding-projection-store.js";
import type { SqliteInboundProjectStore } from "./inbound-project-store.js";
import type { SqliteOperationsStore } from "./operations-store.js";
import type { SqlitePaneOperationStore } from "./pane-operation-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqlitePromptStore } from "./prompt-store.js";

export class SqliteBindingSessionCapabilityStore implements BindingProvisioningStore, RuntimeReconciliationStore, RetiredPaneCleanupStore, SessionAdministrationStore, PaneRetentionStore {
  constructor(
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly bindingProjections: SqliteBindingProjectionStore,
    private readonly prompts: SqlitePromptStore,
    private readonly projections: SqliteProjectionStore,
    private readonly inboundProjects: SqliteInboundProjectStore,
    private readonly paneOperations: SqlitePaneOperationStore,
    private readonly operations: SqliteOperationsStore
  ) {}

  attachBindingPane(...args: Parameters<BindingProvisioningStore["attachBindingPane"]>): ReturnType<BindingProvisioningStore["attachBindingPane"]> { return this.bindings.attachBindingPane(...args); }
  audit(input: Parameters<BindingProvisioningStore["audit"]>[0]): void { this.operations.audit(input); }
  claimProjectSelection(input: Parameters<BindingProvisioningStore["claimProjectSelection"]>[0]): ReturnType<BindingProvisioningStore["claimProjectSelection"]> { return this.inboundProjects.claimProjectSelection(input); }
  completeProjectSelection(...args: Parameters<BindingProvisioningStore["completeProjectSelection"]>): ReturnType<BindingProvisioningStore["completeProjectSelection"]> { return this.inboundProjects.completeProjectSelection(...args); }
  countPendingPrompts(bindingId: string): number { return this.prompts.countPendingPrompts(bindingId); }
  createPendingBinding(input: Parameters<BindingProvisioningStore["createPendingBinding"]>[0]): ReturnType<BindingProvisioningStore["createPendingBinding"]> { return this.bindings.createPendingBinding(input); }
  createProjectSelection(input: Parameters<BindingProvisioningStore["createProjectSelection"]>[0]): ReturnType<BindingProvisioningStore["createProjectSelection"]> { return this.inboundProjects.createProjectSelection(input); }
  failProjectSelection(...args: Parameters<BindingProvisioningStore["failProjectSelection"]>): ReturnType<BindingProvisioningStore["failProjectSelection"]> { return this.inboundProjects.failProjectSelection(...args); }
  findBindingByLarkScope(...args: Parameters<BindingProvisioningStore["findBindingByLarkScope"]>): ReturnType<BindingProvisioningStore["findBindingByLarkScope"]> { return this.bindings.findBindingByLarkScope(...args); }
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
  cutoverResetCandidate(input: Parameters<BindingProvisioningStore["cutoverResetCandidate"]>[0]): ReturnType<BindingProvisioningStore["cutoverResetCandidate"]> { return this.bindings.cutoverResetCandidate(input); }
  replaceProvisioningPane(input: Parameters<BindingProvisioningStore["replaceProvisioningPane"]>[0]): ReturnType<BindingProvisioningStore["replaceProvisioningPane"]> { return this.bindings.replaceProvisioningPane(input); }
  saveTopicView(view: Parameters<BindingProvisioningStore["saveTopicView"]>[0]): void { this.projections.saveTopicView(view); }
  transitionBinding(...args: Parameters<BindingProvisioningStore["transitionBinding"]>): ReturnType<BindingProvisioningStore["transitionBinding"]> { return this.bindings.transitionBinding(...args); }
  updateBindingMetadata(...args: Parameters<BindingProvisioningStore["updateBindingMetadata"]>): ReturnType<BindingProvisioningStore["updateBindingMetadata"]> { return this.bindings.updateBindingMetadata(...args); }

  applyRuntimeObservation(input: Parameters<RuntimeReconciliationStore["applyRuntimeObservation"]>[0]): ReturnType<RuntimeReconciliationStore["applyRuntimeObservation"]> { return this.bindings.applyRuntimeObservation(input); }
  reconcileBindingTitleWithProjection(input: Parameters<RuntimeReconciliationStore["reconcileBindingTitleWithProjection"]>[0]): ReturnType<RuntimeReconciliationStore["reconcileBindingTitleWithProjection"]> { return this.bindingProjections.reconcileBindingTitleWithProjection(input); }
  degradeBindingWithProjection(input: Parameters<RuntimeReconciliationStore["degradeBindingWithProjection"]>[0]): ReturnType<RuntimeReconciliationStore["degradeBindingWithProjection"]> { return this.bindingProjections.degradeBindingWithProjection(input); }
  orphanBindingWithProjection(input: Parameters<RuntimeReconciliationStore["orphanBindingWithProjection"]>[0]): ReturnType<RuntimeReconciliationStore["orphanBindingWithProjection"]> { return this.bindingProjections.orphanBindingWithProjection(input); }
  recoverOrphanBindingWithProjection(input: Parameters<RuntimeReconciliationStore["recoverOrphanBindingWithProjection"]>[0]): ReturnType<RuntimeReconciliationStore["recoverOrphanBindingWithProjection"]> { return this.bindingProjections.recoverOrphanBindingWithProjection(input); }

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
