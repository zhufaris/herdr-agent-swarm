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
  return {
    lifecycle: store, lease: store, health: store, instance: store, turnControl: store,
    promptAcceptance: store, promptRun: store, outboundIntent: store, outbox: store,
    answerPages: store, workerTurnCards: store, mainCards: store, projection: store,
    queueFeedback: store, cardContext: store, bindingProvisioning: store,
    runtimeReconciliation: store, retiredPaneCleanup: store, paneControl: store,
    paneClose: store, inboundRouting: store, inboundDispatch: store, operationsQuery: store,
    deliveryRecovery: store, cardInteraction: store, externalTurns: store,
    sessionOperations: store, modelSelection: store, sessionAdministration: store,
    paneRetention: store, commandIntents: store, inboundMessages: store,
    startupRecovery: store, retention: store, workerCardDisplay: store
  };
}
