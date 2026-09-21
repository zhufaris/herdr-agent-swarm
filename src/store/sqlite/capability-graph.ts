import { DatabaseSync } from "node:sqlite";
import { SqliteApprovalStore } from "./approval-store.js";
import { SqliteBindingLifecycleStore } from "./binding-store.js";
import { SqliteBindingThreadAliasStore } from "./binding-thread-alias-store.js";
import { SqliteBindingProjectionStore } from "./binding-projection-store.js";
import { SqliteBindingSessionCapabilityStore } from "./binding-session-capability-store.js";
import { SqliteCardContextStore } from "./card-context-store.js";
import { SqliteCommandIntentStore } from "./command-intent-store.js";
import { SqliteNaturalLanguageCommandConfirmationStore } from "./natural-language-command-confirmation-store.js";
import { SqliteControllerInterpretationStore } from "./controller-interpretation-store.js";
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

type FoundationStoreFactories = {
  approvals: () => SqliteApprovalStore;
  operations: () => SqliteOperationsStore;
  commandIntents: () => SqliteCommandIntentStore;
  controllerInterpretations: () => SqliteControllerInterpretationStore;
  inboundProjects: () => SqliteInboundProjectStore;
  threadAliases: () => SqliteBindingThreadAliasStore;
  workerThreads: () => SqliteWorkerSessionThreadStore;
};

type StoreCluster = {
  approvals: SqliteApprovalStore;
  operations: SqliteOperationsStore;
  commandIntents: SqliteCommandIntentStore;
  controllerInterpretations: SqliteControllerInterpretationStore;
  inboundProjects: SqliteInboundProjectStore;
  threadAliases: SqliteBindingThreadAliasStore;
  workerThreads: SqliteWorkerSessionThreadStore;
  naturalLanguageCommandConfirmations: SqliteNaturalLanguageCommandConfirmationStore;
  sessionOperations: SqliteSessionOperationStore;
  workerTurns: SqliteWorkerTurnStore;
  projections: SqliteProjectionStore;
  prompts: SqlitePromptStore;
  promptRecovery: SqlitePromptRecoveryStore;
  promptAcceptance: SqlitePromptAcceptanceStore;
  externalTurnAdoption: SqliteExternalTurnAdoptionStore;
  promptDispatch: SqlitePromptDispatchStore;
  outbox: SqliteOutboxStore;
  instances: SqliteInstanceStore;
  cardContexts: SqliteCardContextStore;
  paneOperations: SqlitePaneOperationStore;
  bindings: SqliteBindingLifecycleStore;
  bindingProjections: SqliteBindingProjectionStore;
  instanceOperations: SqliteInstanceOperationStore;
  turnControls: SqliteTurnControlStore;
  workerCardDisplays: SqliteWorkerCardDisplayStore;
};

function createFoundationStoreFactories(context: SqliteContext): FoundationStoreFactories {
  return {
    threadAliases: () => new SqliteBindingThreadAliasStore(context),
    workerThreads: () => new SqliteWorkerSessionThreadStore(context),
    operations: () => new SqliteOperationsStore(context),
    commandIntents: () => new SqliteCommandIntentStore(context),
    controllerInterpretations: () => new SqliteControllerInterpretationStore(context),
    inboundProjects: () => new SqliteInboundProjectStore(context),
    approvals: () => new SqliteApprovalStore(context)
  };
}

function createStoreCluster(context: SqliteContext, foundation: FoundationStoreFactories): StoreCluster {
  const cluster = {} as StoreCluster;
  cluster.bindings = new SqliteBindingLifecycleStore(context, (bindingId, reason) => cluster.cardContexts.invalidateBindingWorkerContexts(bindingId, reason));
  cluster.threadAliases = foundation.threadAliases();
  cluster.workerThreads = foundation.workerThreads();
  cluster.operations = foundation.operations();
  cluster.commandIntents = foundation.commandIntents();
  cluster.sessionOperations = new SqliteSessionOperationStore(context, (id) => cluster.bindings.getBinding(id));
  cluster.projections = new SqliteProjectionStore(context, {
    enqueueOutboundReply: (input) => cluster.outbox.enqueueOutboundReply(input),
    hasPendingAnswerContinuation: (promptId, pageIndex) => cluster.outbox.hasPendingAnswerContinuation(promptId, pageIndex),
    getBinding: (id) => cluster.bindings.getBinding(id),
    getModelPreference: (bindingId) => cluster.prompts.getModelPreference(bindingId),
    refreshOutboxLaneHead: (laneKey) => cluster.outbox.refreshOutboxLaneHead(laneKey)
  });
  cluster.outbox = new SqliteOutboxStore(context, {
    getBinding: (id) => cluster.bindings.getBinding(id),
    loadRunCard: (promptId) => cluster.projections.loadRunCard(promptId),
    getActiveAnswerPage: (promptId) => cluster.projections.getActiveAnswerPage(promptId),
    loadWorkerTurnCard: (turnId) => cluster.workerTurns.loadWorkerTurnCard(turnId),
    listWorkerTurnCardPages: (turnId) => cluster.workerTurns.listWorkerTurnCardPages(turnId),
    loadWorkerMainView: (workerId, generation) => cluster.cardContexts.loadWorkerMainView(workerId, generation),
    saveRunCard: (view) => cluster.projections.saveRunCard(view),
    persistBindingPatch: (id, patch) => cluster.bindings.persistBindingPatch(id, patch),
    invalidateCardContexts: (targets) => cluster.cardContexts.invalidateCardContexts(targets)
  }, cluster.threadAliases, cluster.workerThreads);
  cluster.naturalLanguageCommandConfirmations = new SqliteNaturalLanguageCommandConfirmationStore(context, cluster.outbox, cluster.commandIntents);
  cluster.controllerInterpretations = foundation.controllerInterpretations();
  cluster.bindingProjections = new SqliteBindingProjectionStore(context, cluster.bindings, cluster.projections, {
    enqueueOutboundReply: (input) => cluster.outbox.enqueueOutboundReply(input),
    listRunCardsByPhases: (bindingId, phases) => cluster.projections.listRunCardsByPhases(bindingId, phases)
  });
  cluster.prompts = new SqlitePromptStore(context, cluster.projections, {
    listBindings: () => cluster.bindings.listBindings(),
    enqueueOutboundReply: (input) => cluster.outbox.enqueueOutboundReply(input)
  });
  cluster.promptDispatch = new SqlitePromptDispatchStore(context, cluster.projections, {
    persistBindingPatch: (id, patch) => cluster.bindings.persistBindingPatch(id, patch),
    transitionBinding: (id, transition) => cluster.bindings.transitionBinding(id, transition),
    loadCardContextInvalidation: (target) => cluster.cardContexts.loadCardContextInvalidation(target),
    loadPrimaryWorkerActivity: (promptId, bindingGeneration) => cluster.cardContexts.loadPrimaryWorkerActivity(promptId, bindingGeneration)
  });
  cluster.promptRecovery = new SqlitePromptRecoveryStore(context, cluster.projections, {
    persistBindingPatch: (id, patch) => cluster.bindings.persistBindingPatch(id, patch),
    transitionBinding: (id, transition) => cluster.bindings.transitionBinding(id, transition),
    loadCardContextInvalidation: (target) => cluster.cardContexts.loadCardContextInvalidation(target),
    loadPrimaryWorkerActivity: (promptId, bindingGeneration) => cluster.cardContexts.loadPrimaryWorkerActivity(promptId, bindingGeneration),
    enqueueOutboundReply: (input) => cluster.outbox.enqueueOutboundReply(input)
  });
  cluster.promptAcceptance = new SqlitePromptAcceptanceStore(context, cluster.projections, {
    getBinding: (id) => cluster.bindings.getBinding(id),
    countPendingPrompts: (id) => cluster.prompts.countPendingPrompts(id)
  });
  cluster.externalTurnAdoption = new SqliteExternalTurnAdoptionStore(context, cluster.projections, (id) => cluster.promptDispatch.getPrompt(id));
  cluster.workerTurns = new SqliteWorkerTurnStore(context, {
    getAgentInstance: (id) => cluster.instances.getAgentInstance(id),
    getBinding: (id) => cluster.bindings.getBinding(id),
    enqueueOutboundReply: (input) => cluster.outbox.enqueueOutboundReply(input),
    invalidateWorkerCardContexts: (view, reason) => cluster.cardContexts.invalidateWorkerCardContexts(view, reason),
    hasPendingOutboundReplyForWorkerTurn: (turnId) => cluster.outbox.hasPendingOutboundReplyForWorkerTurn(turnId)
  });
  cluster.instances = new SqliteInstanceStore(context, {
    invalidateWorkerInstanceContexts: (instance, reason) => cluster.cardContexts.invalidateWorkerInstanceContexts(instance, reason),
    retireWorkerSession: (workerId, generation, occurredAt) => cluster.workerThreads.retireSession(workerId, generation, occurredAt)
  });
  cluster.instanceOperations = new SqliteInstanceOperationStore(context, (id) => cluster.instances.getAgentInstance(id));
  cluster.cardContexts = new SqliteCardContextStore(context, {
    getAgentInstance: (id) => cluster.instances.getAgentInstance(id),
    getWorkspaceLease: (id) => cluster.instances.getWorkspaceLease(id),
    getBinding: (id) => cluster.bindings.getBinding(id),
    loadWorkerTurnCard: (id) => cluster.workerTurns.loadWorkerTurnCard(id),
    saveWorkerTurnCard: (view) => cluster.workerTurns.saveWorkerTurnCard(view),
    loadTopicView: (id) => cluster.projections.loadTopicView(id),
    saveTopicView: (view) => cluster.projections.saveTopicView(view),
    loadRunCard: (id) => cluster.projections.loadRunCard(id),
    saveRunCard: (view) => cluster.projections.saveRunCard(view),
    reserveMainCard: (view, rootMessageId, card, paneEntryCard) => cluster.projections.reserveMainCardIntent(view, rootMessageId, card, undefined, paneEntryCard),
    enqueueOutboundReply: (input) => cluster.outbox.enqueueOutboundReply(input),
    reserveWorkerMainPlacement: (view, card) => cluster.workerThreads.reserveCanonicalMain(view, card)
  });
  cluster.workerCardDisplays = new SqliteWorkerCardDisplayStore(context, {
    loadWorkerMainProjectionSource: (workerId, generation) => cluster.cardContexts.loadWorkerMainProjectionSource(workerId, generation),
    loadWorkerMainView: (workerId, generation) => cluster.cardContexts.loadWorkerMainView(workerId, generation),
    enqueueOutboundReply: (input) => cluster.outbox.enqueueOutboundReply(input)
  });
  cluster.turnControls = new SqliteTurnControlStore(context, {
    getBinding: (id) => cluster.bindings.getBinding(id),
    getAgentInstance: (id) => cluster.instances.getAgentInstance(id),
    countPendingPrompts: (id) => cluster.prompts.countPendingPrompts(id),
    countPendingInstanceTurns: (id, generation) => cluster.workerTurns.countPendingInstanceTurns(id, generation),
    insertRunCard: (view) => cluster.projections.insertRunCard(view),
    saveWorkerTurnCard: (view) => cluster.workerTurns.saveWorkerTurnCard(view),
    invalidateWorkerCardContexts: (view, reason) => cluster.cardContexts.invalidateWorkerCardContexts(view, reason),
    enqueueOutboundReply: (input) => cluster.outbox.enqueueOutboundReply(input),
    getPrompt: (id) => cluster.promptDispatch.getPrompt(id)
  });
  cluster.inboundProjects = foundation.inboundProjects();
  cluster.paneOperations = new SqlitePaneOperationStore(context, {
    enqueueOutboundReply: (input) => cluster.outbox.enqueueOutboundReply(input)
  });
  cluster.approvals = foundation.approvals();
  return cluster;
}

export class SqliteCapabilityGraph {
  readonly database: DatabaseSync;
  readonly context: SqliteContext;
  readonly approvals!: SqliteApprovalStore;
  readonly leases: SqliteLeaseStore;
  readonly migrations: SqliteMigrations;
  readonly operations!: SqliteOperationsStore;
  readonly commandIntents!: SqliteCommandIntentStore;
  readonly naturalLanguageCommandConfirmations!: SqliteNaturalLanguageCommandConfirmationStore;
  readonly controllerInterpretations!: SqliteControllerInterpretationStore;
  readonly sessionOperations!: SqliteSessionOperationStore;
  readonly workerTurns!: SqliteWorkerTurnStore;
  readonly projections!: SqliteProjectionStore;
  readonly prompts!: SqlitePromptStore;
  readonly promptRecovery!: SqlitePromptRecoveryStore;
  readonly promptAcceptance!: SqlitePromptAcceptanceStore;
  readonly externalTurnAdoption!: SqliteExternalTurnAdoptionStore;
  readonly promptDispatch!: SqlitePromptDispatchStore;
  readonly outbox!: SqliteOutboxStore;
  readonly instances!: SqliteInstanceStore;
  readonly cardContexts!: SqliteCardContextStore;
  readonly inboundProjects!: SqliteInboundProjectStore;
  readonly paneOperations!: SqlitePaneOperationStore;
  readonly bindings!: SqliteBindingLifecycleStore;
  readonly threadAliases!: SqliteBindingThreadAliasStore;
  readonly bindingProjections!: SqliteBindingProjectionStore;
  readonly instanceOperations!: SqliteInstanceOperationStore;
  readonly turnControls!: SqliteTurnControlStore;
  readonly workerCardDisplays!: SqliteWorkerCardDisplayStore;
  readonly workerThreads!: SqliteWorkerSessionThreadStore;

  constructor(pathOrContext: string | SqliteContext, leaseStore?: SqliteLeaseStore) {
    this.context = typeof pathOrContext === "string" ? new SqliteContext(pathOrContext) : pathOrContext;
    this.database = this.context.database;
    this.leases = leaseStore ?? new SqliteLeaseStore(this.context);
    this.migrations = new SqliteMigrations(this.context);
    this.migrations.run();
    const foundation = createFoundationStoreFactories(this.context);
    Object.assign(this, createStoreCluster(this.context, foundation));
  }

  capabilityModules() {
    return publishCapabilities(this);
  }
}

function publishCapabilities(graph: SqliteCapabilityGraph) {
  const promptAcceptance = new SqlitePromptAcceptanceCapabilityStore(graph.promptAcceptance, graph.prompts, graph.operations);
  const promptDispatch = new SqlitePromptDispatchCapabilityStore(graph.promptDispatch, graph.promptRecovery, graph.prompts, graph.bindings, graph.projections);
  const promptRecovery = new SqlitePromptRecoveryCapabilityStore(graph.promptRecovery, graph.promptDispatch, graph.prompts, graph.bindings);
  const promptSession = new SqlitePromptSessionCapabilityStore(graph.bindings, graph.bindingProjections, graph.projections);
  const bindingSession = new SqliteBindingSessionCapabilityStore(graph.bindings, graph.bindingProjections, graph.prompts, graph.projections, graph.inboundProjects, graph.paneOperations, graph.operations);
  const routing = new SqliteInboundRoutingCapabilityStore(graph.bindings, graph.threadAliases, graph.inboundProjects);
  const paneControl = new SqlitePaneControlCapabilityStore(graph.paneOperations, graph.bindings, graph.prompts, graph.promptAcceptance, graph.promptDispatch, graph.projections, graph.sessionOperations, graph.operations, graph.instances, graph.workerTurns);
  return {
    lifecycle: new SqliteStoreLifecycleAdapter(graph.context, graph.leases),
    approvals: graph.approvals,
    cardContext: graph.cardContexts,
    lease: graph.leases,
    health: new SqliteHealthStoreAdapter(graph.operations, graph.bindings),
    integrity: graph.operations,
    inboundDispatch: graph.inboundProjects,
    operationsQuery: new SqliteOperationsQueryCapabilityStore(graph.bindings, graph.projections, graph.instances),
    retention: new SqliteRetentionStoreAdapter(graph.outbox, graph.inboundProjects, graph.sessionOperations),
    workerCardDisplay: graph.workerCardDisplays,
    workerSessionThreads: graph.workerThreads,
    commandIntents: new SqliteCommandIntentStoreAdapter(graph.commandIntents, {
      audit: (input) => graph.operations.audit(input),
      getBinding: (id) => graph.bindings.getBinding(id)
    }),
    naturalLanguageCommandConfirmations: graph.naturalLanguageCommandConfirmations,
    controllerInterpretations: graph.controllerInterpretations,
    sessionOperations: new SqliteSessionOperationStoreAdapter(graph.sessionOperations, (id) => graph.bindings.getBinding(id)),
    projection: graph.projections,
    mainCards: graph.projections,
    answerPages: graph.projections,
    queueFeedback: graph.prompts,
    promptAcceptance,
    promptDispatch,
    promptRecovery,
    promptSession,
    bindingProvisioning: bindingSession,
    runtimeReconciliation: bindingSession,
    retiredPaneCleanup: bindingSession,
    sessionAdministration: bindingSession,
    paneRetention: bindingSession,
    turnControl: new SqliteTurnControlCapabilityStore(graph.turnControls, graph.bindings, graph.prompts, graph.promptAcceptance, graph.promptDispatch, graph.instances, graph.workerTurns),
    paneControl,
    paneClose: paneControl,
    modelSelection: paneControl,
    cardInteraction: paneControl,
    inboundRouting: routing,
    startupRecovery: new SqliteStartupRecoveryCapabilityStore(routing, graph.operations, (timestamp) => graph.migrations.canonicalizeLegacyAnswerTargets(timestamp)),
    startupViews: new SqliteStartupViewCapabilityStore(graph.prompts, graph.projections, graph.outbox),
    deliveryRecovery: new SqliteDeliveryRecoveryCapabilityStore(graph.outbox, graph.bindings, graph.projections, graph.operations, graph.workerThreads),
    externalTurns: new SqliteExternalTurnCapabilityStore(graph.prompts, graph.promptDispatch, graph.externalTurnAdoption, graph.bindings),
    instance: new SqliteInstanceCapabilityStore(graph.bindings, graph.instances, graph.workerTurns, graph.cardContexts, graph.projections, graph.promptDispatch, graph.instanceOperations),
    outbox: new SqliteOutboxCapabilityStore(graph.outbox, graph.bindings, graph.threadAliases, graph.projections, graph.promptDispatch, graph.inboundProjects, graph.workerTurns, graph.cardContexts),
    outboxAdmin: graph.outbox
  };
}
