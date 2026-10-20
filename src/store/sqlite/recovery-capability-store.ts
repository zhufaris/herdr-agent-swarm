import type { DeliveryRecoveryStore, ExternalTurnObservationStore, InboundRoutingStore, StartupRecoveryStore, StartupViewStore } from "../../domain/ports/workflow.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteBindingThreadAliasStore } from "./binding-thread-alias-store.js";
import type { SqliteInboundProjectStore } from "./inbound-project-store.js";
import type { SqliteOperationsStore } from "./operations-store.js";
import type { SqliteOutboxStore } from "./outbox-store.js";
import type { SqlitePromptStore } from "./prompt-store.js";
import type { SqliteExternalTurnAdoptionStore } from "./external-turn-adoption-store.js";
import type { SqlitePromptDispatchStore } from "./prompt-dispatch-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqliteWorkerSessionThreadStore } from "./worker-session-thread-store.js";
import type { SqliteBindingProjectionStore } from "./binding-projection-store.js";
import type { SqliteAuthoritativeTurnSnapshotStore } from "./authoritative-turn-snapshot-store.js";
import type { SqliteCompletionReviewStore } from "./completion-review-store.js";

export class SqliteInboundRoutingCapabilityStore implements InboundRoutingStore {
  constructor(
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly aliases: SqliteBindingThreadAliasStore,
    private readonly inboundProjects: SqliteInboundProjectStore
  ) {}

  findBindingByLarkScope: InboundRoutingStore["findBindingByLarkScope"] = (topicId, rootMessageId) => this.bindings.findBindingByLarkScope(topicId, rootMessageId) ?? this.aliases.findBindingByScope(topicId, rootMessageId);
  isBindingThreadAlias: InboundRoutingStore["isBindingThreadAlias"] = (topicId, rootMessageId) => this.aliases.isActiveScope(topicId, rootMessageId);
  getBinding: InboundRoutingStore["getBinding"] = (id) => this.bindings.getBinding(id);
  isBridgeMessage: InboundRoutingStore["isBridgeMessage"] = (id) => this.inboundProjects.isBridgeMessage(id);
  listCompletedProjectSelectionsWithInitialPrompt: InboundRoutingStore["listCompletedProjectSelectionsWithInitialPrompt"] = () => this.inboundProjects.listCompletedProjectSelectionsWithInitialPrompt();
}

export class SqliteStartupRecoveryCapabilityStore implements StartupRecoveryStore {
  constructor(
    private readonly routing: SqliteInboundRoutingCapabilityStore,
    private readonly operations: SqliteOperationsStore,
    private readonly canonicalizeLegacyAnswerTargets: (timestamp: string) => void
  ) {}

  getBinding: StartupRecoveryStore["getBinding"] = (id) => this.routing.getBinding(id);
  listCompletedProjectSelectionsWithInitialPrompt: StartupRecoveryStore["listCompletedProjectSelectionsWithInitialPrompt"] = () => this.routing.listCompletedProjectSelectionsWithInitialPrompt();
  recoverLegacyElementIdDeadLetters(): number { return this.operations.recoverLegacyElementIdDeadLetters(this.canonicalizeLegacyAnswerTargets); }
}

export class SqliteStartupViewCapabilityStore implements StartupViewStore {
  constructor(
    private readonly prompts: SqlitePromptStore,
    private readonly projections: SqliteProjectionStore,
    private readonly outbox: SqliteOutboxStore,
    private readonly completionReviews: SqliteCompletionReviewStore
  ) {}

  getBinding: StartupViewStore["getBinding"] = (id) => this.projections.getBinding(id);
  getPromptProjectionState: StartupViewStore["getPromptProjectionState"] = (id) => this.projections.getPromptProjectionState(id);
  ensureAnswerCard: StartupViewStore["ensureAnswerCard"] = (promptId, rootMessageId, card, workClass) => this.prompts.ensureAnswerCard(promptId, rootMessageId, card, workClass);
  listStartupViewBindings: StartupViewStore["listStartupViewBindings"] = (ids) => this.projections.listStartupViewBindings(ids);
  listActionableStartupRunCards: StartupViewStore["listActionableStartupRunCards"] = (id) => this.projections.listActionableStartupRunCards(id);
  loadStartupMainRunCard: StartupViewStore["loadStartupMainRunCard"] = (id, preferredPromptId) => this.projections.loadStartupMainRunCard(id, preferredPromptId);
  loadTopicView: StartupViewStore["loadTopicView"] = (id) => this.projections.loadTopicView(id);
  listAnswerPages: StartupViewStore["listAnswerPages"] = (id) => this.projections.listAnswerPages(id);
  retireUndeliveredWorkerTaskCardIntents: StartupViewStore["retireUndeliveredWorkerTaskCardIntents"] = () => this.outbox.retireUndeliveredWorkerTaskCardIntents();
  recoverDeliveredCompletionReviews: StartupViewStore["recoverDeliveredCompletionReviews"] = () => this.completionReviews.recoverDeliveredPresentations();
  recoverStaleOutboxQuarantines: StartupViewStore["recoverStaleOutboxQuarantines"] = () => this.outbox.recoverStaleOutboxQuarantines();
  dismissEligibleLegacyCompletionNotifications: StartupViewStore["dismissEligibleLegacyCompletionNotifications"] = (ids) => this.outbox.dismissEligibleLegacyCompletionNotifications(ids);
  saveRunCard: StartupViewStore["saveRunCard"] = (view) => this.projections.saveRunCard(view);
}

export class SqliteDeliveryRecoveryCapabilityStore implements DeliveryRecoveryStore {
  constructor(
    private readonly outbox: SqliteOutboxStore,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly projections: SqliteProjectionStore,
    private readonly operations: SqliteOperationsStore,
    private readonly workerThreads: SqliteWorkerSessionThreadStore
  ) {}

  audit: DeliveryRecoveryStore["audit"] = (input) => this.operations.audit(input);
  dismissDeadLetter: DeliveryRecoveryStore["dismissDeadLetter"] = (id, chatId, actorOpenId, sourceMessageId) => this.outbox.dismissDeadLetter(id, chatId, actorOpenId, sourceMessageId);
  getBinding: DeliveryRecoveryStore["getBinding"] = (id) => this.bindings.getBinding(id);
  loadTopicView: DeliveryRecoveryStore["loadTopicView"] = (id) => this.projections.loadTopicView(id);
  listFailures: DeliveryRecoveryStore["listFailures"] = (chatId) => this.bindings.listFailures(chatId);
  resolveCanonicalWorkerThread: DeliveryRecoveryStore["resolveCanonicalWorkerThread"] = (input) => this.workerThreads.resolveCanonicalDirectoryTarget(input);
  reservePaneThreadAlias: DeliveryRecoveryStore["reservePaneThreadAlias"] = (input) => this.outbox.reservePaneThreadAlias(input);
  retryDeadLetter: DeliveryRecoveryStore["retryDeadLetter"] = (id, chatId, actorOpenId) => this.outbox.retryDeadLetter(id, chatId, actorOpenId);
}

export class SqliteExternalTurnCapabilityStore implements ExternalTurnObservationStore {
  constructor(
    private readonly prompts: SqlitePromptStore,
    private readonly dispatch: SqlitePromptDispatchStore,
    private readonly adoption: SqliteExternalTurnAdoptionStore,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly bindingProjections: SqliteBindingProjectionStore,
    private readonly turnSnapshots: SqliteAuthoritativeTurnSnapshotStore
  ) {}

  loadConversationTurnProjection: ExternalTurnObservationStore["loadConversationTurnProjection"] = (identity) => this.adoption.loadConversationTurnProjection(identity);
  projectConversationTurn: ExternalTurnObservationStore["projectConversationTurn"] = (input) => this.adoption.projectConversationTurn(input);
  replaceAuthoritativeTurnSnapshot: ExternalTurnObservationStore["replaceAuthoritativeTurnSnapshot"] = (input) => this.turnSnapshots.replaceAuthoritativeTurnSnapshot(input);
  adoptExternalTurn: ExternalTurnObservationStore["adoptExternalTurn"] = (input) => this.adoption.adoptExternalTurn(input);
  completeTurn: ExternalTurnObservationStore["completeTurn"] = (input) => this.dispatch.completeTurn(input);
  countPendingPrompts: ExternalTurnObservationStore["countPendingPrompts"] = (id) => this.prompts.countPendingPrompts(id);
  failExternalTurnWithoutTerminalEvent: ExternalTurnObservationStore["failExternalTurnWithoutTerminalEvent"] = (input) => this.dispatch.failExternalTurnWithoutTerminalEvent(input);
  failPrompt: ExternalTurnObservationStore["failPrompt"] = (input) => this.dispatch.failPrompt(input);
  findBindingByPane: ExternalTurnObservationStore["findBindingByPane"] = (id) => this.bindings.findBindingByPane(id);
  getActiveBridgePrompt: ExternalTurnObservationStore["getActiveBridgePrompt"] = (id, generation) => this.dispatch.getActiveBridgePrompt(id, generation);
  getActiveExternalPrompt: ExternalTurnObservationStore["getActiveExternalPrompt"] = (id, generation) => this.adoption.getActiveExternalPrompt(id, generation);
  repairProjectedExternalTurn: NonNullable<ExternalTurnObservationStore["repairProjectedExternalTurn"]> = (input) => this.dispatch.repairProjectedExternalTurn(input);
  isExternalTurnRecoveryDue: NonNullable<ExternalTurnObservationStore["isExternalTurnRecoveryDue"]> = (input) => this.adoption.isExternalTurnRecoveryDue(input);
  deferExternalTurnRecovery: NonNullable<ExternalTurnObservationStore["deferExternalTurnRecovery"]> = (input) => this.adoption.deferExternalTurnRecovery(input);
  correctExternalTurnStartedAt: NonNullable<ExternalTurnObservationStore["correctExternalTurnStartedAt"]> = (input) => this.adoption.correctExternalTurnStartedAt(input);
  clearExternalTurnRecovery: NonNullable<ExternalTurnObservationStore["clearExternalTurnRecovery"]> = (id) => this.adoption.clearExternalTurnRecovery(id);
  getBinding: ExternalTurnObservationStore["getBinding"] = (id) => this.bindings.getBinding(id);
  getPrompt: ExternalTurnObservationStore["getPrompt"] = (id) => this.dispatch.getPrompt(id);
  listBindingsByState: ExternalTurnObservationStore["listBindingsByState"] = (state) => this.bindings.listBindingsByState(state);
  getCurrentGoal: ExternalTurnObservationStore["getCurrentGoal"] = (id) => this.adoption.getCurrentGoal(id);
  observePrimaryPromptState: ExternalTurnObservationStore["observePrimaryPromptState"] = (input) => this.bindingProjections.observePrimaryPromptState(input);
}
