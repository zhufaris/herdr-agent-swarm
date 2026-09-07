import type { SqliteStoreBundle } from "../../src/store/sqlite-store-bundle.js";
import { SqliteStoreKernel } from "../../src/store/sqlite-store-kernel.js";

export interface TestStoreBundle extends SqliteStoreBundle {
  /** Test setup/inspection driver. Workflows should receive a named capability above. */
  readonly driver: SqliteStoreKernel;
}

export function createTestStoreBundle(path = ":memory:"): TestStoreBundle {
  const driver = new SqliteStoreKernel(path);
  const modules = driver.capabilityModules();
  Object.assign(driver,
    bindMethods(modules.outbox, ["checkpointOutboundReplyCard", "enqueueOutboundReply", "getActiveAnswerPage", "getNextOutboundLaneHeadAttemptAt", "getPrompt", "listOutboundLaneHeads", "loadRunCard", "markOutboundReplyDelivered", "markOutboundReplyFailedWithQuarantine", "recoverEligibleDeadLetters", "recordBridgeMessage", "dismissSupersededAnswerStream", "loadWorkerTurnCard", "loadWorkerMainView", "listWorkerTurnCardPages"]),
    bindMethods(modules.outboxAdmin, ["listPendingOutboundReplies", "hasPendingOutboundReplyForWorkerTurn", "getOutboundReply", "markOutboundReplyFailed", "markOutboundReplyDeadLetter"])
  );
  return {
    ...createCapabilities(driver, modules),
    driver
  };
}

function createCapabilities(store: SqliteStoreKernel, modules = store.capabilityModules()): SqliteStoreBundle {
  return {
    lifecycle: modules.lifecycle, lease: modules.lease, health: modules.health, instance: modules.instance, instanceLifecycle: modules.instance, instanceTurns: modules.instance, turnControl: store,
    promptAcceptance: store, promptRun: store, outboundIntent: modules.outbox, outbox: modules.outbox,
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

function bindMethods<T extends object, K extends keyof T>(target: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, (target[key] as Function).bind(target)])) as Pick<T, K>;
}
