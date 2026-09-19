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
    private readonly outbox: SqliteOutboxStore
  ) {}

  ensureAnswerCard: StartupViewStore["ensureAnswerCard"] = (promptId, rootMessageId, card, workClass) => this.prompts.ensureAnswerCard(promptId, rootMessageId, card, workClass);
  listStartupViewBindings: StartupViewStore["listStartupViewBindings"] = (ids) => this.projections.listStartupViewBindings(ids);
  listActionableStartupRunCards: StartupViewStore["listActionableStartupRunCards"] = (id) => this.projections.listActionableStartupRunCards(id);
  loadStartupMainRunCard: StartupViewStore["loadStartupMainRunCard"] = (id, preferredPromptId) => this.projections.loadStartupMainRunCard(id, preferredPromptId);
  loadTopicView: StartupViewStore["loadTopicView"] = (id) => this.projections.loadTopicView(id);
  retireUndeliveredWorkerTaskCardIntents: StartupViewStore["retireUndeliveredWorkerTaskCardIntents"] = () => this.outbox.retireUndeliveredWorkerTaskCardIntents();
  recoverStaleOutboxQuarantines: StartupViewStore["recoverStaleOutboxQuarantines"] = () => this.outbox.recoverStaleOutboxQuarantines();
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
  dismissDeadLetter: DeliveryRecoveryStore["dismissDeadLetter"] = (id, chatId, actorOpenId) => this.outbox.dismissDeadLetter(id, chatId, actorOpenId);
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
    private readonly bindings: SqliteBindingLifecycleStore
  ) {}

  adoptExternalTurn: ExternalTurnObservationStore["adoptExternalTurn"] = (input) => this.adoption.adoptExternalTurn(input);
  completeTurn: ExternalTurnObservationStore["completeTurn"] = (input) => this.dispatch.completeTurn(input);
  countPendingPrompts: ExternalTurnObservationStore["countPendingPrompts"] = (id) => this.prompts.countPendingPrompts(id);
  failExternalTurnWithoutTerminalEvent: ExternalTurnObservationStore["failExternalTurnWithoutTerminalEvent"] = (input) => this.dispatch.failExternalTurnWithoutTerminalEvent(input);
  failPrompt: ExternalTurnObservationStore["failPrompt"] = (input) => this.dispatch.failPrompt(input);
  findBindingByPane: ExternalTurnObservationStore["findBindingByPane"] = (id) => this.bindings.findBindingByPane(id);
  getActiveExternalPrompt: ExternalTurnObservationStore["getActiveExternalPrompt"] = (id, generation) => this.adoption.getActiveExternalPrompt(id, generation);
  getBinding: ExternalTurnObservationStore["getBinding"] = (id) => this.bindings.getBinding(id);
  getPrompt: ExternalTurnObservationStore["getPrompt"] = (id) => this.dispatch.getPrompt(id);
  listBindingsByState: ExternalTurnObservationStore["listBindingsByState"] = (state) => this.bindings.listBindingsByState(state);
}
