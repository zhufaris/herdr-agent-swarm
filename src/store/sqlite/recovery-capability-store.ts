import type { DeliveryRecoveryStore, ExternalTurnObservationStore, InboundRoutingStore } from "../../domain/ports/workflow.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteInboundProjectStore } from "./inbound-project-store.js";
import type { SqliteOperationsStore } from "./operations-store.js";
import type { SqliteOutboxStore } from "./outbox-store.js";
import { SqlitePromptCapabilityStore } from "./prompt-capability-store.js";
import type { SqlitePromptStore } from "./prompt-store.js";

export class SqliteInboundRoutingCapabilityStore implements InboundRoutingStore {
  constructor(
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly inboundProjects: SqliteInboundProjectStore
  ) {}

  findBindingByLarkScope: InboundRoutingStore["findBindingByLarkScope"] = (topicId, rootMessageId) => this.bindings.findBindingByLarkScope(topicId, rootMessageId);
  getBinding: InboundRoutingStore["getBinding"] = (id) => this.bindings.getBinding(id);
  isBridgeMessage: InboundRoutingStore["isBridgeMessage"] = (id) => this.inboundProjects.isBridgeMessage(id);
  listCompletedProjectSelectionsWithInitialPrompt: InboundRoutingStore["listCompletedProjectSelectionsWithInitialPrompt"] = () => this.inboundProjects.listCompletedProjectSelectionsWithInitialPrompt();
}

/** Transitional aggregate for consumers that still combine routing and prompt
 * acceptance. Slice 6 replaces those intersections with consumer-shaped ports. */
export class SqliteIngressCapabilityStore extends SqlitePromptCapabilityStore implements InboundRoutingStore {
  constructor(
    private readonly routing: SqliteInboundRoutingCapabilityStore,
    ...promptDependencies: ConstructorParameters<typeof SqlitePromptCapabilityStore>
  ) { super(...promptDependencies); }

  findBindingByLarkScope: InboundRoutingStore["findBindingByLarkScope"] = (topicId, rootMessageId) => this.routing.findBindingByLarkScope(topicId, rootMessageId);
  override getBinding: InboundRoutingStore["getBinding"] = (id) => this.routing.getBinding(id);
  isBridgeMessage: InboundRoutingStore["isBridgeMessage"] = (id) => this.routing.isBridgeMessage(id);
  listCompletedProjectSelectionsWithInitialPrompt: InboundRoutingStore["listCompletedProjectSelectionsWithInitialPrompt"] = () => this.routing.listCompletedProjectSelectionsWithInitialPrompt();
}

export class SqliteDeliveryRecoveryCapabilityStore implements DeliveryRecoveryStore {
  constructor(
    private readonly outbox: SqliteOutboxStore,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly operations: SqliteOperationsStore
  ) {}

  audit: DeliveryRecoveryStore["audit"] = (input) => this.operations.audit(input);
  dismissDeadLetter: DeliveryRecoveryStore["dismissDeadLetter"] = (id, chatId, actorOpenId) => this.outbox.dismissDeadLetter(id, chatId, actorOpenId);
  getBinding: DeliveryRecoveryStore["getBinding"] = (id) => this.bindings.getBinding(id);
  listFailures: DeliveryRecoveryStore["listFailures"] = (chatId) => this.bindings.listFailures(chatId);
  retryDeadLetter: DeliveryRecoveryStore["retryDeadLetter"] = (id, chatId, actorOpenId) => this.outbox.retryDeadLetter(id, chatId, actorOpenId);
}

export class SqliteExternalTurnCapabilityStore implements ExternalTurnObservationStore {
  constructor(
    private readonly prompts: SqlitePromptStore,
    private readonly bindings: SqliteBindingLifecycleStore
  ) {}

  adoptExternalTurn: ExternalTurnObservationStore["adoptExternalTurn"] = (input) => this.prompts.adoptExternalTurn(input);
  completeTurn: ExternalTurnObservationStore["completeTurn"] = (input) => this.prompts.completeTurn(input);
  countPendingPrompts: ExternalTurnObservationStore["countPendingPrompts"] = (id) => this.prompts.countPendingPrompts(id);
  failPrompt: ExternalTurnObservationStore["failPrompt"] = (input) => this.prompts.failPrompt(input);
  findBindingByPane: ExternalTurnObservationStore["findBindingByPane"] = (id) => this.bindings.findBindingByPane(id);
  getActiveExternalPrompt: ExternalTurnObservationStore["getActiveExternalPrompt"] = (id, generation) => this.prompts.getActiveExternalPrompt(id, generation);
  getBinding: ExternalTurnObservationStore["getBinding"] = (id) => this.bindings.getBinding(id);
  getPrompt: ExternalTurnObservationStore["getPrompt"] = (id) => this.prompts.getPrompt(id);
  listBindingsByState: ExternalTurnObservationStore["listBindingsByState"] = (state) => this.bindings.listBindingsByState(state);
}
