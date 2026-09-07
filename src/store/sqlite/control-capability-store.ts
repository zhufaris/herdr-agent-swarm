import type { PaneCloseStore, PaneControlStore } from "../../domain/ports/pane-operations.js";
import type { TurnControlStore, TurnControlWorkflowStore } from "../../domain/ports/turn-control.js";
import type { CardInteractionStore, ModelSelectionStore } from "../../domain/ports/workflow.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteInstanceStore } from "./instance-store.js";
import type { SqliteOperationsStore } from "./operations-store.js";
import type { SqlitePaneOperationStore } from "./pane-operation-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqlitePromptStore } from "./prompt-store.js";
import type { SqliteSessionOperationStore } from "./session-operation-store.js";
import type { SqliteTurnControlStore } from "./turn-control-store.js";
import type { SqliteWorkerTurnStore } from "./worker-turn-store.js";

export class SqliteTurnControlCapabilityStore implements TurnControlWorkflowStore {
  constructor(
    private readonly controls: SqliteTurnControlStore,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly prompts: SqlitePromptStore,
    private readonly instances: SqliteInstanceStore,
    private readonly workerTurns: SqliteWorkerTurnStore
  ) {}

  getPrioritySteer: TurnControlStore["getPrioritySteer"] = (owner, key) => this.controls.getPrioritySteer(owner, key);
  acceptTurnControlOperation: TurnControlStore["acceptTurnControlOperation"] = (input) => this.controls.accept(input);
  getTurnControlOperation: TurnControlStore["getTurnControlOperation"] = (id) => this.controls.get(id);
  getTurnControlOperationByIdempotencyKey: TurnControlStore["getTurnControlOperationByIdempotencyKey"] = (key) => this.controls.getByIdempotencyKey(key);
  claimTurnControlOperation: TurnControlStore["claimTurnControlOperation"] = (id) => this.controls.claim(id);
  rejectAcceptedTurnControlOperation: TurnControlStore["rejectAcceptedTurnControlOperation"] = (input) => this.controls.rejectAccepted(input);
  finishTurnControlOperation: TurnControlStore["finishTurnControlOperation"] = (input) => this.controls.finish(input);
  convertTurnControlToPrimaryPriority: TurnControlStore["convertTurnControlToPrimaryPriority"] = (input) => this.controls.convertToPrimaryPriority(input);
  convertTurnControlToWorkerPriority: TurnControlStore["convertTurnControlToWorkerPriority"] = (input) => this.controls.convertToWorkerPriority(input);
  recoverTurnControlOperations: TurnControlStore["recoverTurnControlOperations"] = (render) => this.controls.recover(render);
  getBinding: TurnControlWorkflowStore["getBinding"] = (id) => this.bindings.getBinding(id);
  getActiveOrdinaryPrompt: TurnControlWorkflowStore["getActiveOrdinaryPrompt"] = (id, generation) => this.prompts.getActiveOrdinaryPrompt(id, generation);
  getAgentInstance: TurnControlWorkflowStore["getAgentInstance"] = (id) => this.instances.getAgentInstance(id);
  getActiveInstanceTurn: TurnControlWorkflowStore["getActiveInstanceTurn"] = (id, generation) => this.workerTurns.getActiveInstanceTurn(id, generation);
  acceptInstanceTurn: TurnControlWorkflowStore["acceptInstanceTurn"] = (input) => this.workerTurns.acceptInstanceTurn(input);
  acceptInstanceTurnWithCard: TurnControlWorkflowStore["acceptInstanceTurnWithCard"] = (input) => this.workerTurns.acceptInstanceTurnWithCard(input);
  countPendingInstanceTurns: TurnControlWorkflowStore["countPendingInstanceTurns"] = (id, generation) => this.workerTurns.countPendingInstanceTurns(id, generation);
  acceptPrompt: TurnControlWorkflowStore["acceptPrompt"] = (input) => this.prompts.acceptPrompt(input);
  countPendingPrompts: TurnControlWorkflowStore["countPendingPrompts"] = (id) => this.prompts.countPendingPrompts(id);
}

export class SqlitePaneControlCapabilityStore implements PaneControlStore, PaneCloseStore, ModelSelectionStore, CardInteractionStore {
  constructor(
    private readonly paneOperations: SqlitePaneOperationStore,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly prompts: SqlitePromptStore,
    private readonly projections: SqliteProjectionStore,
    private readonly sessionOperations: SqliteSessionOperationStore,
    private readonly operations: SqliteOperationsStore
  ) {}

  audit: PaneControlStore["audit"] = (input) => this.operations.audit(input);
  getBinding: PaneControlStore["getBinding"] = (id) => this.bindings.getBinding(id);
  listBindings: PaneControlStore["listBindings"] = () => this.bindings.listBindings();
  acceptPaneControlOperation: PaneControlStore["acceptPaneControlOperation"] = (input) => this.paneOperations.acceptPaneControlOperation(input);
  claimNextPaneControlOperation: PaneControlStore["claimNextPaneControlOperation"] = (bindingId) => this.paneOperations.claimNextPaneControlOperation(bindingId);
  claimPaneControlOperation: PaneControlStore["claimPaneControlOperation"] = (id) => this.paneOperations.claimPaneControlOperation(id);
  finishPaneControlOperation: PaneControlStore["finishPaneControlOperation"] = (id, state, detail) => this.paneOperations.finishPaneControlOperation(id, state, detail);
  getPaneControlOperation: PaneControlStore["getPaneControlOperation"] = (id) => this.paneOperations.getPaneControlOperation(id);
  listRecoverablePaneControlOperations: PaneControlStore["listRecoverablePaneControlOperations"] = () => this.paneOperations.listRecoverablePaneControlOperations();
  consumePaneCloseRequest: PaneCloseStore["consumePaneCloseRequest"] = (input) => this.paneOperations.consumePaneCloseRequest(input);
  countPendingPrompts: PaneCloseStore["countPendingPrompts"] = (id) => this.prompts.countPendingPrompts(id);
  createPaneCloseRequest: PaneCloseStore["createPaneCloseRequest"] = (input) => this.paneOperations.createPaneCloseRequest(input);
  createAutomaticPaneCloseOperation: PaneCloseStore["createAutomaticPaneCloseOperation"] = (input) => this.paneOperations.createAutomaticPaneCloseOperation(input);
  finishPaneCloseRequest: PaneCloseStore["finishPaneCloseRequest"] = (id, state, detail) => this.paneOperations.finishPaneCloseRequest(id, state, detail);
  beginWorkerPaneCloseCascade: PaneCloseStore["beginWorkerPaneCloseCascade"] = (input) => this.paneOperations.beginWorkerPaneCloseCascade(input);
  listUnresolvedWorkerPaneCloseSteps: PaneCloseStore["listUnresolvedWorkerPaneCloseSteps"] = () => this.paneOperations.listUnresolvedWorkerPaneCloseSteps();
  finishWorkerPaneCloseStep: PaneCloseStore["finishWorkerPaneCloseStep"] = (input) => this.paneOperations.finishWorkerPaneCloseStep(input);
  listUnresolvedPaneCloseOperations: PaneCloseStore["listUnresolvedPaneCloseOperations"] = () => this.paneOperations.listUnresolvedPaneCloseOperations();
  transitionBinding: PaneCloseStore["transitionBinding"] = (id, transition) => this.bindings.transitionBinding(id, transition);
  acceptModelPreference: ModelSelectionStore["acceptModelPreference"] = (input) => this.prompts.acceptModelPreference(input);
  getModelPreference: ModelSelectionStore["getModelPreference"] = (id) => this.prompts.getModelPreference(id);
  rejectAppliedPaneControlOperation: ModelSelectionStore["rejectAppliedPaneControlOperation"] = (id, detail) => this.paneOperations.rejectAppliedPaneControlOperation(id, detail);
  createCardInteraction: CardInteractionStore["createCardInteraction"] = (input) => this.sessionOperations.createInteraction(input);
  getCardInteraction: CardInteractionStore["getCardInteraction"] = (id) => this.sessionOperations.getInteraction(id);
  getPrompt: CardInteractionStore["getPrompt"] = (id) => this.prompts.getPrompt(id);
  loadRunCard: CardInteractionStore["loadRunCard"] = (id) => this.projections.loadRunCard(id);
  loadTopicView: CardInteractionStore["loadTopicView"] = (id) => this.projections.loadTopicView(id);
}
