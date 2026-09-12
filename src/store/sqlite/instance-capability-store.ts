import type { InstanceStore } from "../../domain/ports/instance.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteCardContextStore } from "./card-context-store.js";
import type { SqliteInstanceOperationStore } from "./instance-operation-store.js";
import type { SqliteInstanceStore } from "./instance-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqlitePromptStore } from "./prompt-store.js";
import type { SqliteWorkerTurnStore } from "./worker-turn-store.js";

export class SqliteInstanceCapabilityStore implements InstanceStore {
  constructor(
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly instances: SqliteInstanceStore,
    private readonly turns: SqliteWorkerTurnStore,
    private readonly cardContexts: SqliteCardContextStore,
    private readonly projections: SqliteProjectionStore,
    private readonly prompts: SqlitePromptStore,
    private readonly operations: SqliteInstanceOperationStore
  ) {}

  findBindingByLarkScope: InstanceStore["findBindingByLarkScope"] = (topicId, rootMessageId) => this.bindings.findBindingByLarkScope(topicId, rootMessageId);
  getBinding: InstanceStore["getBinding"] = (id) => this.bindings.getBinding(id);
  createAgentInstance: InstanceStore["createAgentInstance"] = (input) => this.instances.createAgentInstance(input);
  createWorkerAgentInstance: InstanceStore["createWorkerAgentInstance"] = (input, maxWorkers) => this.instances.createWorkerAgentInstance(input, maxWorkers);
  getAgentInstance: InstanceStore["getAgentInstance"] = (id) => this.instances.getAgentInstance(id);
  findAgentInstanceByPane: InstanceStore["findAgentInstanceByPane"] = (paneId) => this.instances.findAgentInstanceByPane(paneId);
  listWorkerInstancesByParent: InstanceStore["listWorkerInstancesByParent"] = (input) => this.instances.listWorkerInstancesByParent(input);
  listAgentInstances: InstanceStore["listAgentInstances"] = (projectId) => this.instances.listAgentInstances(projectId);
  setPrimaryAgentInstance: InstanceStore["setPrimaryAgentInstance"] = (projectId, instanceId) => this.instances.setPrimaryAgentInstance(projectId, instanceId);
  attachAgentInstanceRuntime: InstanceStore["attachAgentInstanceRuntime"] = (input) => this.instances.attachAgentInstanceRuntime(input);
  checkpointAgentInstance: InstanceStore["checkpointAgentInstance"] = (input) => this.instances.checkpointAgentInstance(input);
  updateAgentInstanceLifecycle: InstanceStore["updateAgentInstanceLifecycle"] = (input) => this.instances.updateAgentInstanceLifecycle(input);
  updateAgentInstanceObservation: InstanceStore["updateAgentInstanceObservation"] = (input) => this.instances.updateAgentInstanceObservation(input);
  reserveAgentInstanceStop: InstanceStore["reserveAgentInstanceStop"] = (instanceId, generation) => this.instances.reserveAgentInstanceStop(instanceId, generation);
  finishAgentInstanceStop: InstanceStore["finishAgentInstanceStop"] = (instanceId, generation) => this.instances.finishAgentInstanceStop(instanceId, generation);
  rollbackAgentInstanceStop: InstanceStore["rollbackAgentInstanceStop"] = (instanceId, generation, error) => this.instances.rollbackAgentInstanceStop(instanceId, generation, error);
  detachAgentInstanceRuntime: InstanceStore["detachAgentInstanceRuntime"] = (input) => this.instances.detachAgentInstanceRuntime(input);
  terminateWorkerSession: InstanceStore["terminateWorkerSession"] = (input) => this.instances.terminateWorkerSession(input);
  getWorkspaceLease: InstanceStore["getWorkspaceLease"] = (id) => this.instances.getWorkspaceLease(id);
  updateWorkspaceLease: InstanceStore["updateWorkspaceLease"] = (input) => this.instances.updateWorkspaceLease(input);
  createInstanceRemovalPlan: InstanceStore["createInstanceRemovalPlan"] = (plan) => this.instances.createInstanceRemovalPlan(plan);
  getInstanceRemovalPlan: InstanceStore["getInstanceRemovalPlan"] = (id) => this.instances.getInstanceRemovalPlan(id);
  consumeInstanceRemovalPlan: InstanceStore["consumeInstanceRemovalPlan"] = (input) => this.instances.consumeInstanceRemovalPlan(input);
  removeAgentInstance: InstanceStore["removeAgentInstance"] = (input) => this.instances.removeAgentInstance(input);

  acceptInstanceTurn: InstanceStore["acceptInstanceTurn"] = (input) => this.turns.acceptInstanceTurn(input);
  acceptInstanceTurnWithCard: InstanceStore["acceptInstanceTurnWithCard"] = (input) => this.turns.acceptInstanceTurnWithCard(input);
  getInstanceTurn: InstanceStore["getInstanceTurn"] = (id) => this.turns.getInstanceTurn(id);
  claimInstanceTurnTranscript: InstanceStore["claimInstanceTurnTranscript"] = (input) => this.turns.claimInstanceTurnTranscript(input);
  loadWorkerTurnCard: InstanceStore["loadWorkerTurnCard"] = (turnId) => this.turns.loadWorkerTurnCard(turnId);
  findWorkerTurnByCardMessage: InstanceStore["findWorkerTurnByCardMessage"] = (messageId) => this.turns.findWorkerTurnByCardMessage(messageId);
  listWorkerTurnCardPages: InstanceStore["listWorkerTurnCardPages"] = (turnId) => this.turns.listWorkerTurnCardPages(turnId);
  getWorkerTurnCardDeliveryFacts: InstanceStore["getWorkerTurnCardDeliveryFacts"] = (turnId, pageIndex) => this.turns.getWorkerTurnCardDeliveryFacts(turnId, pageIndex);
  reserveWorkerTurnContent: InstanceStore["reserveWorkerTurnContent"] = (input) => this.turns.reserveWorkerTurnContent(input);
  reserveWorkerTurnProgress: InstanceStore["reserveWorkerTurnProgress"] = (input) => this.turns.reserveWorkerTurnProgress(input);
  reserveWorkerTurnFinish: InstanceStore["reserveWorkerTurnFinish"] = (input) => this.turns.reserveWorkerTurnFinish(input);
  reserveWorkerTurnCardHydration: InstanceStore["reserveWorkerTurnCardHydration"] = (input) => this.turns.reserveWorkerTurnCardHydration(input);
  reserveWorkerTurnContinuation: InstanceStore["reserveWorkerTurnContinuation"] = (input) => this.turns.reserveWorkerTurnContinuation(input);
  applyInstanceTurnProjection: InstanceStore["applyInstanceTurnProjection"] = (input) => this.turns.applyInstanceTurnProjection(input);
  transitionInstanceTurnWithProjection: InstanceStore["transitionInstanceTurnWithProjection"] = (input) => this.turns.transitionInstanceTurnWithProjection(input);
  listInstanceTurns: InstanceStore["listInstanceTurns"] = (instanceId, options) => this.turns.listInstanceTurns(instanceId, options);
  listRecentInstanceTurnSummaries: InstanceStore["listRecentInstanceTurnSummaries"] = (instanceId, limit) => this.turns.listRecentInstanceTurnSummaries(instanceId, limit);
  getActiveInstanceTurn: InstanceStore["getActiveInstanceTurn"] = (instanceId, generation) => this.turns.getActiveInstanceTurn(instanceId, generation);
  claimNextInstanceTurn: InstanceStore["claimNextInstanceTurn"] = (instanceId, generation) => this.turns.claimNextInstanceTurn(instanceId, generation);
  recoverInterruptedInstanceTurns: InstanceStore["recoverInterruptedInstanceTurns"] = () => this.turns.recoverInterruptedInstanceTurns();
  listObservableInstanceTurns: InstanceStore["listObservableInstanceTurns"] = () => this.turns.listObservableInstanceTurns();
  listObservableInstanceTurnsByPaneIds: InstanceStore["listObservableInstanceTurnsByPaneIds"] = (paneIds) => this.turns.listObservableInstanceTurnsByPaneIds(paneIds);
  getInstanceTurnDiagnostics: InstanceStore["getInstanceTurnDiagnostics"] = () => this.turns.getInstanceTurnDiagnostics();
  updateInstanceTurn: InstanceStore["updateInstanceTurn"] = (input) => this.turns.updateInstanceTurn(input);
  completeInstanceTurn: InstanceStore["completeInstanceTurn"] = (input) => this.turns.completeInstanceTurn(input);
  listInstanceEvents: InstanceStore["listInstanceEvents"] = (instanceId, afterId) => this.turns.listInstanceEvents(instanceId, afterId);
  countPendingInstanceTurns: InstanceStore["countPendingInstanceTurns"] = (instanceId, generation) => this.turns.countPendingInstanceTurns(instanceId, generation);

  loadWorkerMainView: InstanceStore["loadWorkerMainView"] = (workerId, generation) => this.cardContexts.loadWorkerMainView(workerId, generation);
  saveWorkerMainView: InstanceStore["saveWorkerMainView"] = (view) => this.cardContexts.saveWorkerMainView(view);
  reserveWorkerMainCard: InstanceStore["reserveWorkerMainCard"] = (view, rootMessageId, card) => this.cardContexts.reserveWorkerMainCard(view, rootMessageId, card);
  invalidateCardContexts: InstanceStore["invalidateCardContexts"] = (targets) => this.cardContexts.invalidateCardContexts(targets);
  loadWorkerMainProjectionSource: InstanceStore["loadWorkerMainProjectionSource"] = (workerId, generation) => this.cardContexts.loadWorkerMainProjectionSource(workerId, generation);
  loadPrimaryWorkerSummaries: InstanceStore["loadPrimaryWorkerSummaries"] = (bindingId, generation) => this.cardContexts.loadPrimaryWorkerSummaries(bindingId, generation);
  loadPrimaryWorkerActivity: InstanceStore["loadPrimaryWorkerActivity"] = (promptId, generation) => this.cardContexts.loadPrimaryWorkerActivity(promptId, generation);
  loadTopicView: InstanceStore["loadTopicView"] = (bindingId) => this.projections.loadTopicView(bindingId);
  loadRunCard: InstanceStore["loadRunCard"] = (promptId) => this.projections.loadRunCard(promptId);

  setBindingPrimaryToolCapability: InstanceStore["setBindingPrimaryToolCapability"] = (input) => this.bindings.setPrimaryToolCapability(input);
  verifyBindingPrimaryToolCapability: InstanceStore["verifyBindingPrimaryToolCapability"] = (input) => this.bindings.verifyPrimaryToolCapability(input);
  hasBindingPrimaryToolCapability: InstanceStore["hasBindingPrimaryToolCapability"] = (bindingId, generation) => this.bindings.hasPrimaryToolCapability(bindingId, generation);
  revokeBindingPrimaryToolCapability: InstanceStore["revokeBindingPrimaryToolCapability"] = (bindingId, generation) => this.bindings.revokePrimaryToolCapability(bindingId, generation);
  getActiveOrdinaryPrompt: InstanceStore["getActiveOrdinaryPrompt"] = (bindingId, generation) => this.prompts.getActiveOrdinaryPrompt(bindingId, generation);

  acceptInstanceOperation: InstanceStore["acceptInstanceOperation"] = (input) => this.operations.acceptInstanceOperation(input);
  claimInstanceOperation: InstanceStore["claimInstanceOperation"] = (id, generation) => this.operations.claimInstanceOperation(id, generation);
  updateInstanceOperation: InstanceStore["updateInstanceOperation"] = (input) => this.operations.updateInstanceOperation(input);
  getConversationTarget: InstanceStore["getConversationTarget"] = (chatId) => this.operations.getConversationTarget(chatId);
  setConversationTarget: InstanceStore["setConversationTarget"] = (input) => this.operations.setConversationTarget(input);

  projectLegacyBindingAsAgentInstance: InstanceStore["projectLegacyBindingAsAgentInstance"] = (bindingId) => {
    const binding = this.bindings.getBinding(bindingId);
    if (!binding?.projectId) return null;
    return {
      id: `legacy:${binding.id}`, projectId: binding.projectId, name: binding.title, role: "worker", agentKind: "traex", model: null, sourcePrimaryPaneLabel: null,
      parent: null, workerSessionLifecycle: "legacy", workerSessionGeneration: 1,
      desiredState: binding.state === "archived" ? "stopped" : "running",
      observedState: binding.state === "failed" ? "failed" : binding.state === "archived" ? "stopped" : binding.lastAgentState === "done" ? "idle" : binding.lastAgentState === "unknown" ? "detached" : binding.lastAgentState,
      workspaceLeaseId: `legacy:${binding.id}:workspace`, generation: binding.generation,
      runtimeRef: binding.paneId ? { herdrWorkspaceId: binding.workspaceId, paneId: binding.paneId, nativeSessionId: binding.traexSessionId, generation: binding.generation } : null,
      pendingRuntimeRef: null, provisioningCheckpoint: "verified", lastError: null
    };
  };
}
