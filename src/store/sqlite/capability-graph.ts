import { DatabaseSync } from "node:sqlite";
import { SqliteApprovalStore } from "./approval-store.js";
import { SqliteBindingLifecycleStore } from "./binding-store.js";
import { SqliteBindingThreadAliasStore } from "./binding-thread-alias-store.js";
import { SqliteBindingProjectionStore } from "./binding-projection-store.js";
import { SqliteBindingSessionCapabilityStore } from "./binding-session-capability-store.js";
import { SqliteRuntimeIdentityClaimStore } from "./runtime-identity-claim-store.js";
import { SqliteCardContextStore } from "./card-context-store.js";
import { SqliteCommandIntentStore } from "./command-intent-store.js";
import { SqliteCardCommandAdmissionStore } from "./card-command-admission-store.js";
import { SqliteNaturalLanguageCommandConfirmationStore } from "./natural-language-command-confirmation-store.js";
import { SqliteControllerInterpretationStore } from "./controller-interpretation-store.js";
import { SqliteContext } from "./context.js";
import { SqliteCoreEventInboxStore } from "./core-event-inbox-store.js";
import { SqliteAuthoritativeTurnSnapshotStore } from "./authoritative-turn-snapshot-store.js";
import { SqliteInboundProjectStore } from "./inbound-project-store.js";
import { SqliteInstanceCapabilityStore } from "./instance-capability-store.js";
import { SqliteInstanceOperationStore } from "./instance-operation-store.js";
import { SqliteInstanceStore } from "./instance-store.js";
import { SqliteLeaseStore } from "./lease-store.js";
import { SqliteMigrations } from "./migrations.js";
import type { ExclusiveMigrationLeaseAuthorization } from "./exclusive-migration-lock.js";
import { SqliteOperationsStore } from "./operations-store.js";
import { SqliteOperationsQueryCapabilityStore } from "./operations-query-capability-store.js";
import { SqliteOrchestratorClearStore } from "./orchestrator-clear-store.js";
import { SqliteOrchestratorIdentityMigrationStore } from "./orchestrator-identity-migration-store.js";
import { SqliteOutboxCapabilityStore } from "./outbox-capability-store.js";
import { SqliteOutboxStore } from "./outbox-store.js";
import { SqlitePaneOperationStore } from "./pane-operation-store.js";
import { SqlitePaneTopologyStore } from "./pane-topology-store.js";
import { SqliteProjectionStore } from "./projection-store.js";
import { SqlitePrimaryCardRedeliveryStore } from "./primary-card-redelivery-store.js";
import { SqliteProjectionGapStore } from "./projection-gap-store.js";
import { SqlitePromptStore } from "./prompt-store.js";
import { SqlitePromptRecoveryStore } from "./prompt-recovery-store.js";
import { SqlitePromptAcceptanceStore } from "./prompt-acceptance-store.js";
import { SqliteExternalTurnAdoptionStore } from "./external-turn-adoption-store.js";
import { SqlitePromptDispatchStore } from "./prompt-dispatch-store.js";
import { SqlitePromptAcceptanceCapabilityStore, SqlitePromptDispatchCapabilityStore, SqlitePromptRecoveryCapabilityStore, SqlitePromptSessionCapabilityStore } from "./prompt-capability-store.js";
import { SqliteHealthStoreAdapter, SqliteRetentionStoreAdapter, SqliteStoreLifecycleAdapter } from "./runtime-stores.js";
import { SqliteSessionOperationStore } from "./session-operation-store.js";
import { SqliteSubmissionIntentStore } from "./submission-intent-store.js";
import { SqliteTurnControlStore } from "./turn-control-store.js";
import { SqliteWorkerCardDisplayStore } from "./worker-card-display-store.js";
import { SqliteWorkerTurnStore } from "./worker-turn-store.js";
import { SqliteWorkerSessionThreadStore } from "./worker-session-thread-store.js";
import { SqliteCommandIntentStoreAdapter, SqliteSessionOperationStoreAdapter } from "./workflow-stores.js";
import { SqlitePaneControlCapabilityStore, SqliteTurnControlCapabilityStore } from "./control-capability-store.js";
import { SqliteDeliveryRecoveryCapabilityStore, SqliteExternalTurnCapabilityStore, SqliteInboundRoutingCapabilityStore, SqliteStartupRecoveryCapabilityStore, SqliteStartupViewCapabilityStore } from "./recovery-capability-store.js";
import { StoreLink } from "./store-link.js";
import { SqliteMainCardStore } from "./main-card-store.js";
import { SqliteConversationSegmentStore } from "./conversation-segment-store.js";
import { SqlitePreparedDeliveryStore } from "./prepared-delivery-store.js";
import { DeliveryLatencyTrace } from "../../domain/delivery-trace.js";
import { SqliteLegacyInputCardRetirementStore } from "./legacy-input-card-retirement-store.js";
import { SqliteCardDismissalStore } from "./card-dismissal-store.js";
import { SqliteSessionActivityStore } from "./session-activity-store.js";
import { SqliteRetentionAuditStore } from "./retention-audit-store.js";
import { SqliteRetentionCompactionStore } from "./retention-compaction-store.js";
import { SqliteCompletionReviewStore } from "./completion-review-store.js";
import { CanonicalEventProjector } from "../../runtime/herdr-events-reader.js";
import { translateMultiAgentToolLifecycle } from "../../runtime/multi-agent-tool-lifecycle.js";
import type { PreparedDeliveryConsumer, PreparedDeliveryReservation } from "../../domain/ports/outbox.js";
import type { SessionActivityInvalidationFence, SessionActivityProjectionContext } from "../../domain/session-activity.js";

type StoreCluster = {
  approvals: SqliteApprovalStore;
  operations: SqliteOperationsStore;
  commandIntents: SqliteCommandIntentStore;
  agentInputs: SqliteSubmissionIntentStore;
  cardCommandAdmissions: SqliteCardCommandAdmissionStore;
  controllerInterpretations: SqliteControllerInterpretationStore;
  inboundProjects: SqliteInboundProjectStore;
  threadAliases: SqliteBindingThreadAliasStore;
  workerThreads: SqliteWorkerSessionThreadStore;
  orchestratorClear: SqliteOrchestratorClearStore;
  orchestratorIdentity: SqliteOrchestratorIdentityMigrationStore;
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
  paneTopology: SqlitePaneTopologyStore;
  bindings: SqliteBindingLifecycleStore;
  runtimeIdentityClaims: SqliteRuntimeIdentityClaimStore;
  bindingProjections: SqliteBindingProjectionStore;
  instanceOperations: SqliteInstanceOperationStore;
  turnControls: SqliteTurnControlStore;
  workerCardDisplays: SqliteWorkerCardDisplayStore;
  primaryCardRedelivery: SqlitePrimaryCardRedeliveryStore;
  conversationSegments: SqliteConversationSegmentStore;
  legacyInputCards: SqliteLegacyInputCardRetirementStore;
  cardDismissals: SqliteCardDismissalStore;
};

function createIndependentStores(context: SqliteContext, enqueueCommandStatus: (input: import("./outbox-queue-store.js").EnqueueOutboundReplyInput) => unknown) {
  return {
    threadAliases: new SqliteBindingThreadAliasStore(context),
    workerThreads: new SqliteWorkerSessionThreadStore(context),
    operations: new SqliteOperationsStore(context),
    commandIntents: new SqliteCommandIntentStore(context, { enqueue: enqueueCommandStatus }),
    agentInputs: new SqliteSubmissionIntentStore(context, { enqueue: enqueueCommandStatus }),
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
  const conversationSegments = new SqliteConversationSegmentStore(context, { enqueueOutboundReply: (input) => outboxLink.get().enqueueOutboundReply(input) });
  const independent = createIndependentStores(context, (input) => outboxLink.get().enqueueOutboundReply(input));
  independent.agentInputs = new SqliteSubmissionIntentStore(context, { enqueue: (input) => outboxLink.get().enqueueOutboundReply(input), conversationSegments });
  const legacyInputCards = new SqliteLegacyInputCardRetirementStore(context, { enqueueOutboundReply: (input) => outboxLink.get().enqueueOutboundReply(input) });
  const cardDismissals = new SqliteCardDismissalStore(context, { enqueueOutboundReply: (input) => outboxLink.get().enqueueOutboundReply(input) });
  const bindings = new SqliteBindingLifecycleStore(context, (bindingId, reason) => cardContextsLink.get().invalidateBindingWorkerContexts(bindingId, reason));
  const runtimeIdentityClaims = new SqliteRuntimeIdentityClaimStore(context, bindings);
  const orchestratorClear = new SqliteOrchestratorClearStore(context, { enqueueOutboundReply: (input) => outboxLink.get().enqueueOutboundReply(input) }, runtimeIdentityClaims);
  const orchestratorIdentity = new SqliteOrchestratorIdentityMigrationStore(context, runtimeIdentityClaims);
  const sessionOperations = new SqliteSessionOperationStore(context);
  const projections = new SqliteProjectionStore(context, {
    enqueueOutboundReply: (input) => outboxLink.get().enqueueOutboundReply(input),
    hasPendingAnswerContinuation: (promptId, pageIndex) => outboxLink.get().hasPendingAnswerContinuation(promptId, pageIndex),
    getBinding: (id) => bindings.getBinding(id),
    getModelPreference: (bindingId) => promptsLink.get().getModelPreference(bindingId)
  });
  const outbox = new SqliteOutboxStore(context, {
    getBinding: (id) => bindings.getBinding(id),
    getAgentInstance: (id) => instancesLink.get().getAgentInstance(id),
    loadRunCard: (promptId) => projections.loadRunCard(promptId),
    getActiveAnswerPage: (promptId) => projections.getActiveAnswerPage(promptId),
    loadWorkerTurnCard: (turnId) => workerTurnsLink.get().loadWorkerTurnCard(turnId),
    listWorkerTurnCardPages: (turnId) => workerTurnsLink.get().listWorkerTurnCardPages(turnId),
    loadWorkerMainView: (workerId, generation) => cardContextsLink.get().loadWorkerMainView(workerId, generation),
    saveRunCard: (view) => projections.saveRunCard(view),
    persistBindingPatch: (id, patch) => bindings.persistBindingPatch(id, patch),
    invalidateCardContexts: (targets) => cardContextsLink.get().invalidateCardContexts(targets),
    settleMessageDeletion: (input) => {
      orchestratorClear.settleAnswerWithdrawal(input);
      legacyInputCards.settle(input);
      cardDismissals.settle(input);
    },
    reserveCardDismissal: (input) => cardDismissals.reserveValidated(input),
    reconcileExpiredMessageDeletion: (outboundReplyId) => legacyInputCards.reconcileExpiredMessageDelete(outboundReplyId),
    rebuildRejectedTurnCardRoot: (failedReplyId, recoveredAt) => conversationSegments.rebuildRejectedRoot(failedReplyId, recoveredAt)
  }, independent.threadAliases, independent.workerThreads);
  outboxLink.connect(outbox);
  const naturalLanguageCommandConfirmations = new SqliteNaturalLanguageCommandConfirmationStore(context, outbox, independent.commandIntents);
  const bindingProjections = new SqliteBindingProjectionStore(context, bindings, projections, {
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
    loadPrimaryWorkerActivity: (promptId, bindingGeneration) => cardContextsLink.get().loadPrimaryWorkerActivity(promptId, bindingGeneration),
    getBinding: (id) => bindings.getBinding(id),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input)
  });
  const cardCommandAdmissions = new SqliteCardCommandAdmissionStore(context, independent.commandIntents, {
    getBinding: (id) => bindings.getBinding(id),
    getActiveOrdinaryPrompt: (bindingId, generation) => promptDispatch.getActiveOrdinaryPrompt(bindingId, generation)
  });
  const promptRecovery = new SqlitePromptRecoveryStore(context, projections, {
    persistBindingPatch: (id, patch) => bindings.persistBindingPatch(id, patch),
    transitionBinding: (id, transition) => bindings.transitionBinding(id, transition),
    loadCardContextInvalidation: (target) => cardContextsLink.get().loadCardContextInvalidation(target),
    loadPrimaryWorkerActivity: (promptId, bindingGeneration) => cardContextsLink.get().loadPrimaryWorkerActivity(promptId, bindingGeneration),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input),
    getBinding: (id) => bindings.getBinding(id)
  });
  const promptAcceptance = new SqlitePromptAcceptanceStore(context, projections, {
    getBinding: (id) => bindings.getBinding(id),
    countPendingPrompts: (id) => prompts.countPendingPrompts(id),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input),
    reserveCardDismissal: (input) => cardDismissals.reserveValidated(input)
  });
  const primaryCardRedelivery = new SqlitePrimaryCardRedeliveryStore(context, {
    getBinding: (id) => bindings.getBinding(id),
    loadTopicView: (bindingId) => projections.loadTopicView(bindingId),
    loadRunCard: (promptId) => projections.loadRunCard(promptId),
    getNativeInputBacklog: (bindingId, generation) => promptAcceptance.getNativeInputBacklog(bindingId, generation),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input)
  });
  const externalTurnAdoption = new SqliteExternalTurnAdoptionStore(context, projections, (id) => promptDispatch.getPrompt(id), (input) => outbox.enqueueOutboundReply(input));
  const workerTurns = new SqliteWorkerTurnStore(context, {
    conversationSegments,
    getAgentInstance: (id) => instancesLink.get().getAgentInstance(id),
    getBinding: (id) => bindings.getBinding(id),
    enqueueOutboundReply: (input) => outbox.enqueueOutboundReply(input),
    invalidateWorkerCardContexts: (view, reason) => cardContextsLink.get().invalidateWorkerCardContexts(view, reason),
    hasPendingOutboundReplyForWorkerTurn: (turnId) => outbox.hasPendingOutboundReplyForWorkerTurn(turnId),
    reserveCardDismissal: (input) => cardDismissals.reserveValidated(input)
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
  const paneTopology = new SqlitePaneTopologyStore(context);
  for (const link of [cardContextsLink, outboxLink, promptsLink, workerTurnsLink, instancesLink]) link.get();
  return {
    ...independent, conversationSegments, cardCommandAdmissions, naturalLanguageCommandConfirmations, sessionOperations, workerTurns, projections, prompts, promptRecovery,
    promptAcceptance, externalTurnAdoption, promptDispatch, outbox, instances, cardContexts, paneOperations, paneTopology, bindings, runtimeIdentityClaims,
    bindingProjections, instanceOperations, turnControls, workerCardDisplays, orchestratorClear, orchestratorIdentity, primaryCardRedelivery, legacyInputCards, cardDismissals
  };
}

export class SqliteCapabilityGraph {
  readonly deliveryTrace = new DeliveryLatencyTrace();
  readonly database: DatabaseSync;
  readonly context: SqliteContext;
  readonly approvals!: SqliteApprovalStore;
  readonly leases: SqliteLeaseStore;
  readonly migrations: SqliteMigrations;
  readonly operations!: SqliteOperationsStore;
  readonly commandIntents!: SqliteCommandIntentStore;
  readonly agentInputs!: SqliteSubmissionIntentStore;
  readonly cardCommandAdmissions!: SqliteCardCommandAdmissionStore;
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
  readonly paneTopology!: SqlitePaneTopologyStore;
  readonly bindings!: SqliteBindingLifecycleStore;
  readonly runtimeIdentityClaims!: SqliteRuntimeIdentityClaimStore;
  readonly threadAliases!: SqliteBindingThreadAliasStore;
  readonly bindingProjections!: SqliteBindingProjectionStore;
  readonly instanceOperations!: SqliteInstanceOperationStore;
  readonly turnControls!: SqliteTurnControlStore;
  readonly workerCardDisplays!: SqliteWorkerCardDisplayStore;
  readonly primaryCardRedelivery!: SqlitePrimaryCardRedeliveryStore;
  readonly conversationSegments!: SqliteConversationSegmentStore;
  readonly sessionActivity: SqliteSessionActivityStore;
  readonly retentionAudit: SqliteRetentionAuditStore;
  readonly retentionCompaction: SqliteRetentionCompactionStore;
  private readonly canonicalProjectors = new Map<string, CanonicalEventProjector>();
  readonly workerThreads!: SqliteWorkerSessionThreadStore;
  readonly coreEvents: SqliteCoreEventInboxStore;
  readonly turnSnapshots: SqliteAuthoritativeTurnSnapshotStore;
  readonly orchestratorClear!: SqliteOrchestratorClearStore;
  readonly orchestratorIdentity!: SqliteOrchestratorIdentityMigrationStore;
  readonly legacyInputCards!: SqliteLegacyInputCardRetirementStore;
  readonly cardDismissals!: SqliteCardDismissalStore;
  readonly preparedDeliveries: SqlitePreparedDeliveryStore;

  constructor(pathOrContext: string | SqliteContext, leaseStore?: SqliteLeaseStore, migrationLeaseAuthorization?: ExclusiveMigrationLeaseAuthorization) {
    this.context = typeof pathOrContext === "string" ? new SqliteContext(pathOrContext) : pathOrContext;
    this.database = this.context.database;
    this.leases = leaseStore ?? new SqliteLeaseStore(this.context);
    this.migrations = new SqliteMigrations(this.context, migrationLeaseAuthorization ? { migrationLeaseAuthorization } : {});
    this.migrations.run();
    Object.assign(this, createStoreCluster(this.context));
    this.sessionActivity = new SqliteSessionActivityStore(this.context);
    this.retentionAudit = new SqliteRetentionAuditStore(this.context);
    this.retentionCompaction = new SqliteRetentionCompactionStore(this.context, this.retentionAudit);
    this.sessionActivity.connectCardProjection(this.projections);
    this.sessionActivity.setRecoveryNotifier((input) => { this.conversationSegments.invalidateCurrentPrimarySessionActivity(input); });
    this.preparedDeliveries = this.outbox.preparedDelivery;
    this.preparedDeliveries.setDeliveryTrace(this.deliveryTrace);
    this.coreEvents = new SqliteCoreEventInboxStore(this.context, {
      deliveryTrace: this.deliveryTrace,
      observeCanonicalHumanMessage: (input) => this.agentInputs.observeCanonicalHumanMessage(input),
      projectCanonicalEvent: (input) => {
        const projector = this.canonicalProjectors.get(input.laneId) ?? new CanonicalEventProjector();
        this.canonicalProjectors.set(input.laneId, projector);
        const snapshot = projector.snapshot();
        this.context.onRollback(() => projector.restore(snapshot));
        const observation = projector.project(input.event);
        const activityFence = input.sessionActivityContext ? sessionActivityInvalidationFence(input.sessionActivityContext, input.observedAt) : null;
        let activityVisibleChanged = false;
        if (input.sessionActivityContext) {
          const agentLifecycleMutations = this.multiAgentLifecycleMutations(input.laneId, input.laneSequence, input.event);
          activityVisibleChanged = this.sessionActivity.projectCanonicalEvent({
            context: input.sessionActivityContext,
            laneId: input.laneId,
            laneSequence: input.laneSequence,
            sourceId: input.sourceId,
            sourceEpoch: input.sourceEpoch ?? input.sourceId,
            event: input.event,
            observedAt: input.observedAt,
            ...(agentLifecycleMutations.length ? { agentLifecycleMutations } : {}),
            ...(observation.model ? { model: observation.model } : {}),
            ...(observation.mainStatus?.planSteps !== undefined ? {
              taskList: observation.mainStatus.planSteps.map(({ key, label, state }) => ({ id: key, label, state }))
            } : {})
          }).visibleChanged;
        }
        const result = !observation.timelineDeltas?.length && (input.event.payload as Record<string, unknown>).type === "tool_result"
          ? this.conversationSegments.recoverToolResult(input)
          : this.conversationSegments.projectCanonicalEvent({
            ...input,
            ...(observation.model ? { model: observation.model } : {}),
            ...(observation.timelineDeltas ? { timelineDeltas: observation.timelineDeltas } : {}),
            ...(observation.goalChanges ? { goalChanges: observation.goalChanges } : {}),
            ...(observation.mainStatus?.planSteps !== undefined ? {
              taskList: observation.mainStatus.planSteps.map(({ key, label, state }) => ({ id: key, label, state }))
            } : {})
          });
        if (activityVisibleChanged && activityFence) this.conversationSegments.invalidateCurrentPrimarySessionActivity(activityFence);
        return result;
      }
    });
    this.turnSnapshots = new SqliteAuthoritativeTurnSnapshotStore(this.context, this.projections, this.outbox);
  }

  private multiAgentLifecycleMutations(laneId: string, laneSequence: number, result: import("../../domain/core-event-inbox.js").CoreEventEnvelope) {
    const payload = result.payload as { type?: unknown; call_id?: unknown };
    if (payload.type !== "tool_result" || typeof payload.call_id !== "string") return [];
    const calls = this.context.database.prepare(`SELECT inbox.event_json FROM core_event_lane_items lane
      JOIN core_event_inbox inbox ON inbox.event_id=lane.event_id
      WHERE lane.lane_id=? AND lane.sequence<? AND lane.state IN ('pending','projected','ignored')
        AND inbox.event_type='tool_call' AND inbox.call_id=? AND inbox.agent_kind=? AND inbox.session_id=?
        AND inbox.payload_compacted_at IS NULL
      ORDER BY lane.sequence`).all(laneId, laneSequence, payload.call_id, result.agentKind, result.sessionId) as Array<{ event_json: string }>;
    if (calls.length !== 1) return [];
    let call: import("../../domain/core-event-inbox.js").CoreEventEnvelope;
    try { call = JSON.parse(calls[0]!.event_json) as import("../../domain/core-event-inbox.js").CoreEventEnvelope; } catch { return []; }
    return translateMultiAgentToolLifecycle(call, result);
  }

  capabilityModules() {
    return publishCapabilities(this);
  }

  connectPreparedDeliveryProducers(reservation: PreparedDeliveryReservation, consumer: PreparedDeliveryConsumer): void {
    this.conversationSegments.setPreparedDeliveryReservation(reservation, consumer);
    this.cardContexts.setPreparedDeliveryReservation(reservation, consumer);
    this.workerThreads.setPreparedDeliveryReservation(reservation, consumer);
    this.workerTurns.setPreparedDeliveryReservation(reservation, consumer);
    this.workerCardDisplays.setPreparedDeliveryReservation(reservation, consumer);
    this.projections.setPreparedMainCardDeliveryReservation(reservation, consumer);
    this.bindingProjections.setPreparedDeliveryReservation(reservation, consumer);
    this.commandIntents.setPreparedDeliveryReservation(reservation, consumer);
    this.inboundProjects.setPreparedDeliveryReservation(reservation, consumer);
    this.agentInputs.setPreparedDeliveryReservation(reservation, consumer);
    this.threadAliases.setPreparedDeliveryReservation(reservation, consumer);
    this.naturalLanguageCommandConfirmations.setPreparedDeliveryReservation(reservation, consumer);
    this.prompts.setPreparedDeliveryReservation(reservation, consumer);
    this.promptRecovery.setPreparedDeliveryReservation(reservation, consumer);
    this.promptAcceptance.setPreparedDeliveryReservation(reservation, consumer);
    this.externalTurnAdoption.setPreparedDeliveryReservation(reservation, consumer);
    this.paneOperations.setPreparedDeliveryReservation(reservation, consumer);
    this.turnControls.setPreparedDeliveryReservation(reservation, consumer);
    this.primaryCardRedelivery.setPreparedDeliveryReservation(reservation, consumer);
    this.orchestratorClear.setPreparedDeliveryReservation(reservation, consumer);
    this.legacyInputCards.setPreparedDeliveryReservation(reservation, consumer);
    this.cardDismissals.setPreparedDeliveryReservation(reservation, consumer);
    this.outbox.setPreparedDeliveryReservation(reservation, consumer);
    this.turnSnapshots.setPreparedDeliveryReservation(reservation, consumer);
  }
}

function sessionActivityInvalidationFence(context: SessionActivityProjectionContext, occurredAt: string): SessionActivityInvalidationFence | null {
  const owner = context.ownerFence;
  const binding = owner.kind === "primary"
    ? { bindingId: owner.id, bindingGeneration: owner.generation, sessionEpoch: owner.sessionGeneration }
    : owner.parent
      ? { bindingId: owner.parent.id, bindingGeneration: owner.parent.generation, sessionEpoch: owner.parent.sessionGeneration }
      : null;
  return binding ? { ...binding, producer: context.producer, occurredAt } : null;
}

function publishCapabilities(graph: SqliteCapabilityGraph) {
  const promptAcceptance = new SqlitePromptAcceptanceCapabilityStore(graph.promptAcceptance, graph.prompts, graph.operations);
  const promptDispatch = new SqlitePromptDispatchCapabilityStore(graph.promptDispatch, graph.promptRecovery, graph.prompts, graph.bindings, graph.projections, graph.bindingProjections);
  const promptRecovery = new SqlitePromptRecoveryCapabilityStore(graph.promptRecovery, graph.promptDispatch, graph.prompts, graph.bindings);
  const promptSession = new SqlitePromptSessionCapabilityStore(graph.bindings, graph.bindingProjections, graph.projections);
  const bindingSession = new SqliteBindingSessionCapabilityStore(graph.bindings, graph.runtimeIdentityClaims, graph.bindingProjections, graph.prompts, graph.projections, graph.inboundProjects, graph.paneOperations, graph.operations);
  const routing = new SqliteInboundRoutingCapabilityStore(graph.bindings, graph.threadAliases, graph.inboundProjects);
  const mainCards = new SqliteMainCardStore(graph.projections, graph.promptAcceptance, graph.sessionActivity);
  const paneControl = new SqlitePaneControlCapabilityStore(graph.paneOperations, graph.bindings, graph.prompts, graph.promptAcceptance, graph.promptDispatch, graph.projections, graph.sessionOperations, graph.operations, graph.instances, graph.workerTurns, graph.conversationSegments);
  return {
    lifecycle: new SqliteStoreLifecycleAdapter(graph.context, graph.leases),
    coreEvents: graph.coreEvents,
    turnSnapshots: graph.turnSnapshots,
    conversationSegments: graph.conversationSegments,
    sessionActivity: graph.sessionActivity,
    approvals: graph.approvals,
    cardContext: graph.cardContexts,
    paneTopology: graph.paneTopology,
    lease: graph.leases,
    health: new SqliteHealthStoreAdapter(graph.operations, graph.bindings),
    integrity: graph.operations,
    inboundDispatch: graph.inboundProjects,
    operationsQuery: new SqliteOperationsQueryCapabilityStore(graph.bindings, graph.projections, graph.instances, graph.workerThreads),
    retention: new SqliteRetentionStoreAdapter(graph.outbox, graph.inboundProjects, graph.sessionOperations, new SqliteProjectionGapStore(graph.context), graph.coreEvents, graph.retentionAudit, graph.retentionCompaction),
    workerCardDisplay: graph.workerCardDisplays,
    workerSessionThreads: graph.workerThreads,
    commandIntents: new SqliteCommandIntentStoreAdapter(graph.commandIntents, graph.cardCommandAdmissions, {
      audit: (input) => graph.operations.audit(input),
      getBinding: (id) => graph.bindings.getBinding(id)
    }),
    agentInputs: graph.agentInputs,
    naturalLanguageCommandConfirmations: graph.naturalLanguageCommandConfirmations,
    controllerInterpretations: graph.controllerInterpretations,
    orchestratorClear: graph.orchestratorClear,
    orchestratorIdentity: graph.orchestratorIdentity,
    legacyInputCards: graph.legacyInputCards,
    cardDismissals: graph.cardDismissals,
    preparedDeliveries: graph.preparedDeliveries,
    deliveryTrace: graph.deliveryTrace,
    preparedDeliveryProducers: graph,
    sessionOperations: new SqliteSessionOperationStoreAdapter(graph.sessionOperations, (id) => graph.bindings.getBinding(id)),
    projection: graph.projections,
    mainCards,
    answerPages: graph.projections,
    primaryCardRedelivery: graph.primaryCardRedelivery,
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
    turnControl: new SqliteTurnControlCapabilityStore(graph.turnControls, graph.bindings, graph.instances, graph.workerTurns),
    paneControl,
    paneClose: paneControl,
    modelSelection: paneControl,
    cardInteraction: paneControl,
    inboundRouting: routing,
    startupRecovery: new SqliteStartupRecoveryCapabilityStore(routing, graph.operations, (timestamp) => graph.migrations.canonicalizeLegacyAnswerTargets(timestamp)),
    startupViews: new SqliteStartupViewCapabilityStore(graph.prompts, graph.projections, graph.outbox, new SqliteCompletionReviewStore(graph.context)),
    deliveryRecovery: new SqliteDeliveryRecoveryCapabilityStore(graph.outbox, graph.bindings, graph.projections, graph.operations, graph.workerThreads),
    externalTurns: new SqliteExternalTurnCapabilityStore(graph.prompts, graph.promptDispatch, graph.externalTurnAdoption, graph.bindings, graph.bindingProjections, graph.turnSnapshots),
    instance: new SqliteInstanceCapabilityStore(graph.bindings, graph.instances, graph.workerTurns, graph.cardContexts, graph.projections, graph.promptDispatch, graph.instanceOperations),
    outbox: new SqliteOutboxCapabilityStore(graph.outbox, graph.bindings, graph.threadAliases, graph.projections, graph.promptDispatch, graph.inboundProjects, graph.workerTurns, graph.cardContexts),
    outboxAdmin: graph.outbox
  };
}
