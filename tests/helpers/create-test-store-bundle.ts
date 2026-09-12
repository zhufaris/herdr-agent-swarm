import type { SqliteStoreBundle } from "../../src/store/sqlite-store-bundle.js";
import { SqliteStoreKernel } from "./sqlite-store-kernel.js";
import { createOutboxTestDriver } from "./outbox-test-driver.js";

export interface TestStoreBundle extends SqliteStoreBundle {
  /** Test setup/inspection driver. Workflows should receive a named capability above. */
  readonly driver: SqliteStoreKernel;
}

export function createTestStoreBundle(path = ":memory:"): TestStoreBundle {
  const driver = new SqliteStoreKernel(path);
  const modules = driver.capabilityModules();
  Object.assign(driver,
    createOutboxTestDriver(modules.outboxAdmin),
    bindMethods(modules.outbox, ["enqueueOutboundReply", "prepareOutboundGatewayPlan", "getActiveAnswerPage", "getLarkDeliveryCooldown", "getNextOutboundLaneHeadAttemptAt", "getPrompt", "listOutboundLaneHeads", "loadRunCard", "recoverEligibleDeadLetters", "recordBridgeMessage", "dismissSupersededAnswerStream", "loadWorkerTurnCard", "loadWorkerMainView", "listWorkerTurnCardPages"]),
    bindMethods(modules.outboxAdmin, ["listPendingOutboundReplies", "hasPendingOutboundReplyForWorkerTurn", "getOutboundReply", "markOutboundReplyFailed", "markOutboundReplyDeadLetter", "reservePaneThreadAlias"])
  );
  return {
    ...createCapabilities(driver, modules),
    driver
  };
}

function createCapabilities(store: SqliteStoreKernel, modules = store.capabilityModules()): SqliteStoreBundle {
  return {
    lifecycle: modules.lifecycle, lease: modules.lease, health: modules.health, instance: modules.instance, instanceLifecycle: modules.instance, instanceTurns: modules.instance, turnControl: store,
    promptAcceptance: store, promptDispatch: store, promptRecovery: store, promptSession: store, outboundIntent: modules.outbox, outbox: modules.outbox,
    answerPages: store, mainCards: store, projection: store,
    queueFeedback: store, cardContext: modules.cardContext, bindingProvisioning: store,
    runtimeReconciliation: store, retiredPaneCleanup: store, paneControl: store,
    paneClose: store, inboundRouting: store, inboundDispatch: modules.inboundDispatch, operationsQuery: modules.operationsQuery,
    deliveryRecovery: store, cardInteraction: store, externalTurns: store,
    sessionOperations: modules.sessionOperations, modelSelection: store, sessionAdministration: store,
    paneRetention: store, commandIntents: modules.commandIntents,
    startupRecovery: store, startupViews: store, retention: modules.retention, workerCardDisplay: modules.workerCardDisplay, workerSessionThreads: modules.workerSessionThreads
  };
}

function bindMethods<T extends object, K extends keyof T>(target: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, (target[key] as Function).bind(target)])) as Pick<T, K>;
}
