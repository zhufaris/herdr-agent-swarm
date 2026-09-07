import type { SqliteStoreBundle } from "../../src/store/sqlite-store-bundle.js";
import { SqliteStoreKernel } from "../../src/store/sqlite-store-kernel.js";

export interface TestStoreBundle extends SqliteStoreBundle {
  /** Test setup/inspection driver. Workflows should receive a named capability above. */
  readonly driver: SqliteStoreKernel;
}

export function createTestStoreBundle(path = ":memory:"): TestStoreBundle {
  const driver = new SqliteStoreKernel(path);
  return {
    ...createCapabilities(driver),
    driver
  };
}

function createCapabilities(store: SqliteStoreKernel): SqliteStoreBundle {
  const modules = store.capabilityModules();
  return {
    lifecycle: modules.lifecycle, lease: modules.lease, health: modules.health, instance: modules.instance, instanceLifecycle: modules.instance, instanceTurns: modules.instance, turnControl: store,
    promptAcceptance: store, promptRun: store, outboundIntent: store, outbox: store,
    answerPages: store, workerTurnCards: store, mainCards: store, projection: store,
    queueFeedback: store, cardContext: modules.cardContext, bindingProvisioning: store,
    runtimeReconciliation: store, retiredPaneCleanup: store, paneControl: store,
    paneClose: store, inboundRouting: store, inboundDispatch: modules.inboundDispatch, operationsQuery: modules.operationsQuery,
    deliveryRecovery: store, cardInteraction: store, externalTurns: store,
    sessionOperations: modules.sessionOperations, modelSelection: store, sessionAdministration: store,
    paneRetention: store, commandIntents: modules.commandIntents, inboundMessages: store,
    startupRecovery: store, retention: modules.retention, workerCardDisplay: modules.workerCardDisplay
  };
}
