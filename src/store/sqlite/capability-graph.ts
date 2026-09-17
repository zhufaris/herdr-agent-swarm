import { DatabaseSync } from "node:sqlite";
import { SqliteApprovalStore } from "./approval-store.js";
import { SqliteBindingLifecycleStore } from "./binding-store.js";
import { SqliteBindingThreadAliasStore } from "./binding-thread-alias-store.js";
import { SqliteBindingProjectionStore } from "./binding-projection-store.js";
import { SqliteBindingSessionCapabilityStore } from "./binding-session-capability-store.js";
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
import { SqliteOperationsQueryCapabilityStore } from "./operations-query-capability-store.js";
import { SqliteOutboxCapabilityStore } from "./outbox-capability-store.js";
import { SqliteOutboxStore } from "./outbox-store.js";
import { SqlitePaneOperationStore } from "./pane-operation-store.js";
import { SqliteProjectionStore } from "./projection-store.js";
import { SqlitePromptStore } from "./prompt-store.js";
import { SqlitePromptRecoveryStore } from "./prompt-recovery-store.js";
import { SqlitePromptAcceptanceStore } from "./prompt-acceptance-store.js";
import { SqliteExternalTurnAdoptionStore } from "./external-turn-adoption-store.js";
import { SqlitePromptDispatchStore } from "./prompt-dispatch-store.js";
import { SqlitePromptAcceptanceCapabilityStore, SqlitePromptDispatchCapabilityStore, SqlitePromptRecoveryCapabilityStore, SqlitePromptSessionCapabilityStore } from "./prompt-capability-store.js";
import { SqliteHealthStoreAdapter, SqliteRetentionStoreAdapter, SqliteStoreLifecycleAdapter } from "./runtime-stores.js";
import { SqliteSessionOperationStore } from "./session-operation-store.js";
import { SqliteTurnControlStore } from "./turn-control-store.js";
import { SqliteWorkerCardDisplayStore } from "./worker-card-display-store.js";
import { SqliteWorkerTurnStore } from "./worker-turn-store.js";
import { SqliteWorkerSessionThreadStore } from "./worker-session-thread-store.js";
import { SqliteCommandIntentStoreAdapter, SqliteSessionOperationStoreAdapter } from "./workflow-stores.js";
import { SqlitePaneControlCapabilityStore, SqliteTurnControlCapabilityStore } from "./control-capability-store.js";
import { SqliteDeliveryRecoveryCapabilityStore, SqliteExternalTurnCapabilityStore, SqliteInboundRoutingCapabilityStore, SqliteStartupRecoveryCapabilityStore, SqliteStartupViewCapabilityStore } from "./recovery-capability-store.js";

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
  readonly promptRecovery: SqlitePromptRecoveryStore;
  readonly promptAcceptance: SqlitePromptAcceptanceStore;
  readonly externalTurnAdoption: SqliteExternalTurnAdoptionStore;
  readonly promptDispatch: SqlitePromptDispatchStore;
  readonly outbox: SqliteOutboxStore;
  readonly instances: SqliteInstanceStore;
  readonly cardContexts: SqliteCardContextStore;
  readonly inboundProjects: SqliteInboundProjectStore;
  readonly paneOperations: SqlitePaneOperationStore;
  readonly bindings: SqliteBindingLifecycleStore;
  readonly threadAliases: SqliteBindingThreadAliasStore;
  readonly bindingProjections: SqliteBindingProjectionStore;
  readonly instanceOperations: SqliteInstanceOperationStore;
  readonly turnControls: SqliteTurnControlStore;
  readonly workerCardDisplays: SqliteWorkerCardDisplayStore;
  readonly workerThreads: SqliteWorkerSessionThreadStore;

  constructor(pathOrContext: string | SqliteContext, leaseStore?: SqliteLeaseStore) {
    this.context = typeof pathOrContext === "string" ? new SqliteContext(pathOrContext) : pathOrContext;
    this.database = this.context.database;
    this.leases = leaseStore ?? new SqliteLeaseStore(this.context);
    this.migrations = new SqliteMigrations(this.context);
    this.migrations.run();
    this.bindings = new SqliteBindingLifecycleStore(this.context, (bindingId, reason) => this.cardContexts.invalidateBindingWorkerContexts(bindingId, reason));
    this.threadAliases = new SqliteBindingThreadAliasStore(this.context);
    this.workerThreads = new SqliteWorkerSessionThreadStore(this.context);
    this.operations = new SqliteOperationsStore(this.context);
    this.commandIntents = new SqliteCommandIntentStore(this.context);
    this.sessionOperations = new SqliteSessionOperationStore(this.context, (id) => this.bindings.getBinding(id));
    this.projections = new SqliteProjectionStore(this.context, {
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input),
      hasPendingAnswerContinuation: (promptId, pageIndex) => this.outbox.hasPendingAnswerContinuation(promptId, pageIndex),
      getBinding: (id) => this.bindings.getBinding(id),
      getModelPreference: (bindingId) => this.prompts.getModelPreference(bindingId),
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
    }, this.threadAliases, this.workerThreads);
    this.bindingProjections = new SqliteBindingProjectionStore(this.context, this.bindings, this.projections, {
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input),
      listRunCardsByPhases: (bindingId, phases) => this.projections.listRunCardsByPhases(bindingId, phases)
    });
    this.prompts = new SqlitePromptStore(this.context, this.projections, {
      listBindings: () => this.bindings.listBindings(),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input)
    });
    this.promptDispatch = new SqlitePromptDispatchStore(this.context, this.projections, {
      persistBindingPatch: (id, patch) => this.bindings.persistBindingPatch(id, patch),
      transitionBinding: (id, transition) => this.bindings.transitionBinding(id, transition),
      loadCardContextInvalidation: (target) => this.cardContexts.loadCardContextInvalidation(target),
      loadPrimaryWorkerActivity: (promptId, bindingGeneration) => this.cardContexts.loadPrimaryWorkerActivity(promptId, bindingGeneration)
    });
    this.promptRecovery = new SqlitePromptRecoveryStore(this.context, this.projections, {
      persistBindingPatch: (id, patch) => this.bindings.persistBindingPatch(id, patch),
      transitionBinding: (id, transition) => this.bindings.transitionBinding(id, transition),
      loadCardContextInvalidation: (target) => this.cardContexts.loadCardContextInvalidation(target),
      loadPrimaryWorkerActivity: (promptId, bindingGeneration) => this.cardContexts.loadPrimaryWorkerActivity(promptId, bindingGeneration),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input)
    });
    this.promptAcceptance = new SqlitePromptAcceptanceStore(this.context, this.projections, {
      getBinding: (id) => this.bindings.getBinding(id),
      countPendingPrompts: (id) => this.prompts.countPendingPrompts(id)
    });
    this.externalTurnAdoption = new SqliteExternalTurnAdoptionStore(this.context, this.projections, (id) => this.promptDispatch.getPrompt(id));
    this.workerTurns = new SqliteWorkerTurnStore(this.context, {
      getAgentInstance: (id) => this.instances.getAgentInstance(id),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input),
      invalidateWorkerCardContexts: (view, reason) => this.cardContexts.invalidateWorkerCardContexts(view, reason),
      hasPendingOutboundReplyForWorkerTurn: (turnId) => this.outbox.hasPendingOutboundReplyForWorkerTurn(turnId)
    });
    this.instances = new SqliteInstanceStore(this.context, {
      invalidateWorkerInstanceContexts: (instance, reason) => this.cardContexts.invalidateWorkerInstanceContexts(instance, reason),
      retireWorkerSession: (workerId, generation, occurredAt) => this.workerThreads.retireSession(workerId, generation, occurredAt)
    });
    this.instanceOperations = new SqliteInstanceOperationStore(this.context, (id) => this.instances.getAgentInstance(id));
    this.cardContexts = new SqliteCardContextStore(this.context, {
      getAgentInstance: (id) => this.instances.getAgentInstance(id),
      getWorkspaceLease: (id) => this.instances.getWorkspaceLease(id),
      getBinding: (id) => this.bindings.getBinding(id),
      loadWorkerTurnCard: (id) => this.workerTurns.loadWorkerTurnCard(id),
      saveWorkerTurnCard: (view) => this.workerTurns.saveWorkerTurnCard(view),
      loadTopicView: (id) => this.projections.loadTopicView(id),
      saveTopicView: (view) => this.projections.saveTopicView(view),
      loadRunCard: (id) => this.projections.loadRunCard(id),
      saveRunCard: (view) => this.projections.saveRunCard(view),
      reserveMainCard: (view, rootMessageId, card, paneEntryCard) => this.projections.reserveMainCardIntent(view, rootMessageId, card, undefined, paneEntryCard),
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input),
      reserveWorkerMainPlacement: (view, card) => this.workerThreads.reserveCanonicalMain(view, card)
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
      getPrompt: (id) => this.promptDispatch.getPrompt(id)
    });
    this.inboundProjects = new SqliteInboundProjectStore(this.context);
    this.paneOperations = new SqlitePaneOperationStore(this.context, {
      enqueueOutboundReply: (input) => this.outbox.enqueueOutboundReply(input)
    });
    this.approvals = new SqliteApprovalStore(this.context);
  }

  capabilityModules() {
    const promptAcceptance = new SqlitePromptAcceptanceCapabilityStore(this.promptAcceptance, this.prompts, this.operations);
    const promptDispatch = new SqlitePromptDispatchCapabilityStore(this.promptDispatch, this.promptRecovery, this.prompts, this.bindings, this.projections);
    const promptRecovery = new SqlitePromptRecoveryCapabilityStore(this.promptRecovery, this.promptDispatch, this.prompts, this.bindings);
    const promptSession = new SqlitePromptSessionCapabilityStore(this.bindings, this.bindingProjections, this.projections);
    const bindingSession = new SqliteBindingSessionCapabilityStore(this.bindings, this.bindingProjections, this.prompts, this.projections, this.inboundProjects, this.paneOperations, this.operations);
    const routing = new SqliteInboundRoutingCapabilityStore(this.bindings, this.threadAliases, this.inboundProjects);
    const paneControl = new SqlitePaneControlCapabilityStore(this.paneOperations, this.bindings, this.prompts, this.promptAcceptance, this.promptDispatch, this.projections, this.sessionOperations, this.operations, this.instances, this.workerTurns);
    return {
      lifecycle: new SqliteStoreLifecycleAdapter(this.context, this.leases),
      approvals: this.approvals,
      cardContext: this.cardContexts,
      lease: this.leases,
      health: new SqliteHealthStoreAdapter(this.operations, this.bindings),
      integrity: this.operations,
      inboundDispatch: this.inboundProjects,
      operationsQuery: new SqliteOperationsQueryCapabilityStore(this.bindings, this.projections, this.instances),
      retention: new SqliteRetentionStoreAdapter(this.outbox, this.inboundProjects, this.sessionOperations),
      workerCardDisplay: this.workerCardDisplays,
      workerSessionThreads: this.workerThreads,
      commandIntents: new SqliteCommandIntentStoreAdapter(this.commandIntents, {
        audit: (input) => this.operations.audit(input),
        getBinding: (id) => this.bindings.getBinding(id)
      }),
      sessionOperations: new SqliteSessionOperationStoreAdapter(this.sessionOperations, (id) => this.bindings.getBinding(id)),
      projection: this.projections,
      mainCards: this.projections,
      answerPages: this.projections,
      queueFeedback: this.prompts,
      promptAcceptance,
      promptDispatch,
      promptRecovery,
      promptSession,
      bindingProvisioning: bindingSession,
      runtimeReconciliation: bindingSession,
      retiredPaneCleanup: bindingSession,
      sessionAdministration: bindingSession,
      paneRetention: bindingSession,
      turnControl: new SqliteTurnControlCapabilityStore(this.turnControls, this.bindings, this.prompts, this.promptAcceptance, this.promptDispatch, this.instances, this.workerTurns),
      paneControl,
      paneClose: paneControl,
      modelSelection: paneControl,
      cardInteraction: paneControl,
      inboundRouting: routing,
      startupRecovery: new SqliteStartupRecoveryCapabilityStore(routing, this.operations, (timestamp) => this.migrations.canonicalizeLegacyAnswerTargets(timestamp)),
      startupViews: new SqliteStartupViewCapabilityStore(this.bindings, this.prompts, this.projections, this.outbox),
      deliveryRecovery: new SqliteDeliveryRecoveryCapabilityStore(this.outbox, this.bindings, this.projections, this.operations, this.workerThreads),
      externalTurns: new SqliteExternalTurnCapabilityStore(this.prompts, this.promptDispatch, this.externalTurnAdoption, this.bindings),
      instance: new SqliteInstanceCapabilityStore(this.bindings, this.instances, this.workerTurns, this.cardContexts, this.projections, this.promptDispatch, this.instanceOperations),
      outbox: new SqliteOutboxCapabilityStore(this.outbox, this.bindings, this.threadAliases, this.projections, this.promptDispatch, this.inboundProjects, this.workerTurns, this.cardContexts),
      outboxAdmin: this.outbox
    };
  }
}
