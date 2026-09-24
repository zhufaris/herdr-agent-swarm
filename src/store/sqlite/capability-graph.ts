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
import { StoreLink } from "./store-link.js";

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

function createIndependentStores(context: SqliteContext, enqueueCommandStatus: (input: import("./outbox-queue-store.js").EnqueueOutboundReplyInput) => unknown) {
  return {
    threadAliases: new SqliteBindingThreadAliasStore(context),
    workerThreads: new SqliteWorkerSessionThreadStore(context),
    operations: new SqliteOperationsStore(context),
    commandIntents: new SqliteCommandIntentStore(context, { enqueue: enqueueCommandStatus }),
    controllerInterpretations: new SqliteControllerInterpretationStore(context),
    inboundProjects: new SqliteInboundProjectStore(context),
    approvals: new SqliteApprovalStore(context)
  };
}

function createStoreCluster(context: SqliteContext): StoreCluster {
  const cardContextsLink = new StoreLink<SqliteCardContextStore>("card contexts");
  const outboxLink = new StoreLink<SqliteOutboxStore>("outbox");
  const promptsLink = new StoreLink<SqlitePromptStore>("prompts");
  const workerTurnsLink = new StoreLink<SqliteWorkerTurnStore>("worker turns");
  const instancesLink = new StoreLink<SqliteInstanceStore>("instances");
  const independent = createIndependentStores(context, (input) => outboxLink.get().enqueueOutboundReply(input));

  const bindings = new SqliteBindingLifecycleStore(context, (bindingId, reason) => cardContextsLink.get().invalidateBindingWorkerContexts(bindingId, reason));
  const sessionOperations = new SqliteSessionOperationStore(context, (id) => bindings.getBinding(id));
  const projections = new SqliteProjectionStore(context, {
    enqueueOutboundReply: (input) => outboxLink.get().enqueueOutboundReply(input),
    hasPendingAnswerContinuation: (promptId, pageIndex) => outboxLink.get().hasPendingAnswerContinuation(promptId, pageIndex),
    getBinding: (id) => bindings.getBinding(id),
    getModelPreference: (bindingId) => promptsLink.get().getModelPreference(bindingId),
    refreshOutboxLaneHead: (laneKey) => outboxLink.get().refreshOutboxLaneHead(laneKey)
  });
  const outbox = new SqliteOutboxStore(context, {
    getBinding: (id) => bindings.getBinding(id),
    loadRunCard: (promptId) => projections.loadRunCard(promptId),
    getActiveAnswerPage: (promptId) => projections.getActiveAnswerPage(promptId),
    loadWorkerTurnCard: (turnId) => workerTurnsLink.get().loadWorkerTurnCard(turnId),
    listWorkerTurnCardPages: (turnId) => workerTurnsLink.get().listWorkerTurnCardPages(turnId),
    loadWorkerMainView: (workerId, generation) => cardContextsLink.get().loadWorkerMainView(workerId, generation),
    saveRunCard: (view) => projections.saveRunCard(view),
    persistBindingPatch: (id, patch) => bindings.persistBindingPatch(id, patch),
    invalidateCardContexts: (targets) => cardContextsLink.get().invalidateCardContexts(targets)
  }, independent.threadAliases, independent.workerThreads);
  outboxLink.connect(outbox);
  const naturalLanguageCommandConfirmations = new SqliteNaturalLanguageCommandConfirmationStore(context, outbox, independent.commandIntents);
  const bindingProjections = new SqliteBindingProjectionStore(context, bindings, projections, {
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input),
    listRunCardsByPhases: (bindingId, phases) => projections.listRunCardsByPhases(bindingId, phases)
  });
  const prompts = new SqlitePromptStore(context, projections, {
    listBindings: () => bindings.listBindings(),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input)
  });
  promptsLink.connect(prompts);
  const promptDispatch = new SqlitePromptDispatchStore(context, projections, {
    persistBindingPatch: (id, patch) => bindings.persistBindingPatch(id, patch),
    transitionBinding: (id, transition) => bindings.transitionBinding(id, transition),
    loadCardContextInvalidation: (target) => cardContextsLink.get().loadCardContextInvalidation(target),
    loadPrimaryWorkerActivity: (promptId, bindingGeneration) => cardContextsLink.get().loadPrimaryWorkerActivity(promptId, bindingGeneration)
  });
  const promptRecovery = new SqlitePromptRecoveryStore(context, projections, {
    persistBindingPatch: (id, patch) => bindings.persistBindingPatch(id, patch),
    transitionBinding: (id, transition) => bindings.transitionBinding(id, transition),
    loadCardContextInvalidation: (target) => cardContextsLink.get().loadCardContextInvalidation(target),
    loadPrimaryWorkerActivity: (promptId, bindingGeneration) => cardContextsLink.get().loadPrimaryWorkerActivity(promptId, bindingGeneration),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input)
  });
  const promptAcceptance = new SqlitePromptAcceptanceStore(context, projections, {
    getBinding: (id) => bindings.getBinding(id),
    countPendingPrompts: (id) => prompts.countPendingPrompts(id)
  });
  const externalTurnAdoption = new SqliteExternalTurnAdoptionStore(context, projections, (id) => promptDispatch.getPrompt(id));
  const workerTurns = new SqliteWorkerTurnStore(context, {
    getAgentInstance: (id) => instancesLink.get().getAgentInstance(id),
    getBinding: (id) => bindings.getBinding(id),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input),
    invalidateWorkerCardContexts: (view, reason) => cardContextsLink.get().invalidateWorkerCardContexts(view, reason),
    hasPendingOutboundReplyForWorkerTurn: (turnId) => outbox.hasPendingOutboundReplyForWorkerTurn(turnId)
  });
  workerTurnsLink.connect(workerTurns);
  const instances = new SqliteInstanceStore(context, {
    invalidateWorkerInstanceContexts: (instance, reason) => cardContextsLink.get().invalidateWorkerInstanceContexts(instance, reason),
    retireWorkerSession: (workerId, generation, occurredAt) => independent.workerThreads.retireSession(workerId, generation, occurredAt)
  });
  instancesLink.connect(instances);
  const instanceOperations = new SqliteInstanceOperationStore(context, (id) => instances.getAgentInstance(id));
  const cardContexts = new SqliteCardContextStore(context, {
    getAgentInstance: (id) => instances.getAgentInstance(id),
    getWorkspaceLease: (id) => instances.getWorkspaceLease(id),
    getBinding: (id) => bindings.getBinding(id),
    loadWorkerTurnCard: (id) => workerTurns.loadWorkerTurnCard(id),
    saveWorkerTurnCard: (view) => workerTurns.saveWorkerTurnCard(view),
    loadTopicView: (id) => projections.loadTopicView(id),
    saveTopicView: (view) => projections.saveTopicView(view),
    loadRunCard: (id) => projections.loadRunCard(id),
    saveRunCard: (view) => projections.saveRunCard(view),
    reserveMainCard: (view, rootMessageId, card, paneEntryCard) => projections.reserveMainCardIntent(view, rootMessageId, card, undefined, paneEntryCard),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input),
    reserveWorkerMainPlacement: (view, card) => independent.workerThreads.reserveCanonicalMain(view, card)
  });
  cardContextsLink.connect(cardContexts);
  const workerCardDisplays = new SqliteWorkerCardDisplayStore(context, {
    loadWorkerMainProjectionSource: (workerId, generation) => cardContexts.loadWorkerMainProjectionSource(workerId, generation),
    loadWorkerMainView: (workerId, generation) => cardContexts.loadWorkerMainView(workerId, generation),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input)
  });
  const turnControls = new SqliteTurnControlStore(context, {
    getBinding: (id) => bindings.getBinding(id),
    getAgentInstance: (id) => instances.getAgentInstance(id),
    countPendingPrompts: (id) => prompts.countPendingPrompts(id),
    countPendingInstanceTurns: (id, generation) => workerTurns.countPendingInstanceTurns(id, generation),
    insertRunCard: (view) => projections.insertRunCard(view),
    saveWorkerTurnCard: (view) => workerTurns.saveWorkerTurnCard(view),
    invalidateWorkerCardContexts: (view, reason) => cardContexts.invalidateWorkerCardContexts(view, reason),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input),
    getPrompt: (id) => promptDispatch.getPrompt(id)
  });
  const paneOperations = new SqlitePaneOperationStore(context, {
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input)
  });
  for (const link of [cardContextsLink, outboxLink, promptsLink, workerTurnsLink, instancesLink]) link.get();
  return {
    ...independent, naturalLanguageCommandConfirmations, sessionOperations, workerTurns, projections, prompts, promptRecovery,
    promptAcceptance, externalTurnAdoption, promptDispatch, outbox, instances, cardContexts, paneOperations, bindings,
    bindingProjections, instanceOperations, turnControls, workerCardDisplays
  };
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
    Object.assign(this, createStoreCluster(this.context));
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
