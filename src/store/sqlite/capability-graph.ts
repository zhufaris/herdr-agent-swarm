import { DatabaseSync } from "node:sqlite";
import { SqliteApprovalStore } from "./approval-store.js";
import { SqliteBindingLifecycleStore } from "./binding-store.js";
import { SqliteBindingProjectionStore } from "./binding-projection-store.js";
import { SqliteCardContextStore } from "./card-context-store.js";
import { SqliteCommandIntentStore } from "./command-intent-store.js";
import { SqliteContext } from "./context.js";
import { SqliteInboundProjectStore } from "./inbound-project-store.js";
import { SqliteInstanceCapabilityStore } from "./instance-capability-store.js";
import { SqliteInstanceOperationStore } from "./instance-operation-store.js";
import { SqliteInstanceStore } from "./instance-store.js";
import { SqliteLeaseStore } from "./lease-store.js";
import { SqliteMigrations } from "./migrations.js";
import { SqliteOperationsStore } from "./operations-store.js";
import { SqliteOutboxCapabilityStore } from "./outbox-capability-store.js";
import { SqliteOutboxStore } from "./outbox-store.js";
import { SqlitePaneOperationStore } from "./pane-operation-store.js";
import { SqliteProjectionStore } from "./projection-store.js";
import { SqlitePromptStore } from "./prompt-store.js";
import { SqliteHealthStoreAdapter, SqliteRetentionStoreAdapter, SqliteStoreLifecycleAdapter } from "./runtime-stores.js";
import { SqliteSessionOperationStore } from "./session-operation-store.js";
import { SqliteTurnControlStore } from "./turn-control-store.js";
import { SqliteWorkerCardDisplayStore } from "./worker-card-display-store.js";
import { SqliteWorkerTurnStore } from "./worker-turn-store.js";
import { SqliteCommandIntentStoreAdapter, SqliteSessionOperationStoreAdapter } from "./workflow-stores.js";

export class SqliteCapabilityGraph {
  readonly database: DatabaseSync;
  readonly context: SqliteContext;
  readonly approvals: SqliteApprovalStore;
  readonly leases: SqliteLeaseStore;
  readonly migrations: SqliteMigrations;
  readonly operations: SqliteOperationsStore;
  readonly commandIntents: SqliteCommandIntentStore;
  readonly sessionOperations: SqliteSessionOperationStore;
  readonly workerTurns: SqliteWorkerTurnStore;
  readonly projections: SqliteProjectionStore;
  readonly prompts: SqlitePromptStore;
  readonly outbox: SqliteOutboxStore;
  readonly instances: SqliteInstanceStore;
  readonly cardContexts: SqliteCardContextStore;
  readonly inboundProjects: SqliteInboundProjectStore;
  readonly paneOperations: SqlitePaneOperationStore;
  readonly bindings: SqliteBindingLifecycleStore;
  readonly bindingProjections: SqliteBindingProjectionStore;
  readonly instanceOperations: SqliteInstanceOperationStore;
  readonly turnControls: SqliteTurnControlStore;
  readonly workerCardDisplays: SqliteWorkerCardDisplayStore;

  constructor(path: string) {
    this.context = new SqliteContext(path);
    this.database = this.context.database;
    this.migrations = new SqliteMigrations(this.context);
    this.migrations.run();
    this.bindings = new SqliteBindingLifecycleStore(this.context, (bindingId, reason) => this.cardContexts.invalidateBindingWorkerContexts(bindingId, reason));
    this.operations = new SqliteOperationsStore(this.context);
    this.commandIntents = new SqliteCommandIntentStore(this.context);
    this.sessionOperations = new SqliteSessionOperationStore(this.context, (id) => this.bindings.getBinding(id));
    this.projections = new SqliteProjectionStore(this.context, {
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input),
      hasPendingAnswerContinuation: (promptId, pageIndex) => this.outbox.hasPendingAnswerContinuation(promptId, pageIndex),
      getBinding: (id) => this.bindings.getBinding(id),
      refreshOutboxLaneHead: (laneKey) => this.outbox.refreshOutboxLaneHead(laneKey)
    });
    this.outbox = new SqliteOutboxStore(this.context, {
      getBinding: (id) => this.bindings.getBinding(id),
      loadRunCard: (promptId) => this.projections.loadRunCard(promptId),
      getActiveAnswerPage: (promptId) => this.projections.getActiveAnswerPage(promptId),
      loadWorkerTurnCard: (turnId) => this.workerTurns.loadWorkerTurnCard(turnId),
      listWorkerTurnCardPages: (turnId) => this.workerTurns.listWorkerTurnCardPages(turnId),
      loadWorkerMainView: (workerId, generation) => this.cardContexts.loadWorkerMainView(workerId, generation),
      saveRunCard: (view) => this.projections.saveRunCard(view),
      persistBindingPatch: (id, patch) => this.bindings.persistBindingPatch(id, patch),
      invalidateCardContexts: (targets) => this.cardContexts.invalidateCardContexts(targets)
    });
    this.bindingProjections = new SqliteBindingProjectionStore(this.context, this.bindings, this.projections, {
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input),
      listRunCardsByPhases: (bindingId, phases) => this.projections.listRunCardsByPhases(bindingId, phases)
    });
    this.prompts = new SqlitePromptStore(this.context, this.projections, {
      getBinding: (id) => this.bindings.getBinding(id),
      persistBindingPatch: (id, patch) => this.bindings.persistBindingPatch(id, patch),
      transitionBinding: (id, transition) => this.bindings.transitionBinding(id, transition),
      loadCardContextInvalidation: (target) => this.cardContexts.loadCardContextInvalidation(target),
      loadPrimaryWorkerActivity: (promptId, bindingGeneration) => this.cardContexts.loadPrimaryWorkerActivity(promptId, bindingGeneration),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input)
    });
    this.workerTurns = new SqliteWorkerTurnStore(this.context, {
      getAgentInstance: (id) => this.instances.getAgentInstance(id),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input),
      invalidateWorkerCardContexts: (view, reason) => this.cardContexts.invalidateWorkerCardContexts(view, reason)
    });
    this.instances = new SqliteInstanceStore(this.context, {
      invalidateWorkerInstanceContexts: (instance, reason) => this.cardContexts.invalidateWorkerInstanceContexts(instance, reason)
    });
    this.instanceOperations = new SqliteInstanceOperationStore(this.context, (id) => this.instances.getAgentInstance(id));
    this.cardContexts = new SqliteCardContextStore(this.context, {
      getAgentInstance: (id) => this.instances.getAgentInstance(id),
      getWorkspaceLease: (id) => this.instances.getWorkspaceLease(id),
      getBinding: (id) => this.bindings.getBinding(id),
      listWorkerInstancesByParent: (input) => this.instances.listWorkerInstancesByParent(input),
      loadWorkerTurnCard: (id) => this.workerTurns.loadWorkerTurnCard(id),
      saveWorkerTurnCard: (view) => this.workerTurns.saveWorkerTurnCard(view),
      loadTopicView: (id) => this.projections.loadTopicView(id),
      saveTopicView: (view) => this.projections.saveTopicView(view),
      loadRunCard: (id) => this.projections.loadRunCard(id),
      saveRunCard: (view) => this.projections.saveRunCard(view),
      reserveMainCard: (view, rootMessageId, card) => this.projections.reserveMainCardIntent(view, rootMessageId, card),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input)
    });
    this.workerCardDisplays = new SqliteWorkerCardDisplayStore(this.context, {
      loadWorkerMainProjectionSource: (workerId, generation) => this.cardContexts.loadWorkerMainProjectionSource(workerId, generation),
      loadWorkerMainView: (workerId, generation) => this.cardContexts.loadWorkerMainView(workerId, generation),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input)
    });
    this.turnControls = new SqliteTurnControlStore(this.context, {
      getBinding: (id) => this.bindings.getBinding(id),
      getAgentInstance: (id) => this.instances.getAgentInstance(id),
      countPendingPrompts: (id) => this.prompts.countPendingPrompts(id),
      countPendingInstanceTurns: (id, generation) => this.workerTurns.countPendingInstanceTurns(id, generation),
      insertRunCard: (view) => this.projections.insertRunCard(view),
      saveWorkerTurnCard: (view) => this.workerTurns.saveWorkerTurnCard(view),
      invalidateWorkerCardContexts: (view, reason) => this.cardContexts.invalidateWorkerCardContexts(view, reason),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input),
      getPrompt: (id) => this.prompts.getPrompt(id)
    });
    this.inboundProjects = new SqliteInboundProjectStore(this.context);
    this.paneOperations = new SqlitePaneOperationStore(this.context, {
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input)
    });
    this.approvals = new SqliteApprovalStore(this.context);
    this.leases = new SqliteLeaseStore(this.context);
  }

  capabilityModules() {
    return {
      lifecycle: new SqliteStoreLifecycleAdapter(this.context, this.leases),
      approvals: this.approvals,
      cardContext: this.cardContexts,
      lease: this.leases,
      health: new SqliteHealthStoreAdapter(this.operations, this.bindings),
      integrity: this.operations,
      inboundDispatch: this.inboundProjects,
      operationsQuery: this.bindings,
      retention: new SqliteRetentionStoreAdapter(this.outbox, this.inboundProjects, this.sessionOperations),
      workerCardDisplay: this.workerCardDisplays,
      commandIntents: new SqliteCommandIntentStoreAdapter(this.commandIntents, {
        audit: (input) => this.operations.audit(input),
        getBinding: (id) => this.bindings.getBinding(id)
      }),
      sessionOperations: new SqliteSessionOperationStoreAdapter(this.sessionOperations, (id) => this.bindings.getBinding(id)),
      instance: new SqliteInstanceCapabilityStore(this.bindings, this.instances, this.workerTurns, this.cardContexts, this.projections, this.prompts, this.instanceOperations),
      outbox: new SqliteOutboxCapabilityStore(this.outbox, this.bindings, this.projections, this.prompts, this.inboundProjects, this.workerTurns, this.cardContexts),
      outboxAdmin: this.outbox
    };
  }
}
