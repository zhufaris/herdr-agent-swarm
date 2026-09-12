import type { HealthStore, LeaseStore } from "../../src/domain/ports/health.js";
import type { InboundMessageDispatchStore } from "../../src/domain/ports/workflow.js";
import type { WorkerCardDisplayStore } from "../../src/domain/ports/worker-card-display.js";
import type { CommandIntentStore } from "../../src/domain/ports/swarm-command.js";
import type { SessionOperationStore } from "../../src/domain/ports/workflow.js";
import type { SqliteRetentionStore, SqliteStoreLifecycle } from "../../src/store/sqlite-store-bundle.js";
import { SqliteStoreKernel } from "./sqlite-store-kernel.js";
import { createOutboxTestDriver } from "./outbox-test-driver.js";

export type SqliteBindingStore = SqliteStoreKernel & SqliteStoreLifecycle & LeaseStore & HealthStore &
  InboundMessageDispatchStore & SqliteRetentionStore & WorkerCardDisplayStore & CommandIntentStore & SessionOperationStore & {
    inspectIntegrity: ReturnType<SqliteStoreKernel["capabilityModules"]>["integrity"]["inspectIntegrity"];
    getSessionOperation: ReturnType<SqliteStoreKernel["capabilityModules"]>["sessionOperations"]["getSessionOperation"];
  } & ReturnType<SqliteStoreKernel["capabilityModules"]>["approvals"] &
  Pick<ReturnType<SqliteStoreKernel["capabilityModules"]>["cardContext"], "listPendingCardContextInvalidations" | "markCardContextProjected" | "projectCardContext">;

type StoreConstructor = new (path: string) => SqliteBindingStore;

/**
 * Legacy broad test harness. It composes production capabilities without making
 * the production kernel inherit test-only convenience methods. New tests should
 * prefer createTestStoreBundle() and pass one named capability at a time.
 */
export const SqliteBindingStore: StoreConstructor = class {
  constructor(path: string) {
    const kernel = new SqliteStoreKernel(path);
    const modules = kernel.capabilityModules();
    return Object.assign(kernel, {
      ...createOutboxTestDriver(modules.outboxAdmin),
      ...bindMethods(modules.outbox, ["enqueueOutboundReply", "getActiveAnswerPage", "getNextOutboundLaneHeadAttemptAt", "getPrompt", "listOutboundLaneHeads", "loadRunCard", "recoverEligibleDeadLetters", "recordBridgeMessage", "dismissSupersededAnswerStream", "loadWorkerTurnCard", "loadWorkerMainView", "listWorkerTurnCardPages"]),
      ...bindMethods(modules.outboxAdmin, ["listPendingOutboundReplies", "hasPendingOutboundReplyForWorkerTurn", "getOutboundReply", "markOutboundReplyFailed", "markOutboundReplyDeadLetter", "reservePaneThreadAlias", "reserveWorkerSessionThread", "loadWorkerSessionThread", "findWorkerSessionThreadByScope", "findWorkerSessionThreadRecordByScope"]),
      ...bindMethods(modules.instance, ["createAgentInstance", "createWorkerAgentInstance", "findAgentInstanceByPane", "listWorkerInstancesByParent", "listAgentInstances", "setPrimaryAgentInstance", "attachAgentInstanceRuntime", "checkpointAgentInstance", "updateAgentInstanceLifecycle", "updateAgentInstanceObservation", "reserveAgentInstanceStop", "finishAgentInstanceStop", "rollbackAgentInstanceStop", "detachAgentInstanceRuntime", "terminateWorkerSession", "getWorkspaceLease", "updateWorkspaceLease", "createInstanceRemovalPlan", "getInstanceRemovalPlan", "consumeInstanceRemovalPlan", "removeAgentInstance", "setBindingPrimaryToolCapability", "verifyBindingPrimaryToolCapability", "hasBindingPrimaryToolCapability", "revokeBindingPrimaryToolCapability", "acceptInstanceOperation", "claimInstanceOperation", "updateInstanceOperation", "getConversationTarget", "setConversationTarget", "projectLegacyBindingAsAgentInstance"]),
      activateWriteFence: modules.lifecycle.activateWriteFence.bind(modules.lifecycle),
      deactivateWriteFence: modules.lifecycle.deactivateWriteFence.bind(modules.lifecycle),
      acquireInstanceLease: modules.lease.acquireInstanceLease.bind(modules.lease),
      renewInstanceLease: modules.lease.renewInstanceLease.bind(modules.lease),
      releaseInstanceLease: modules.lease.releaseInstanceLease.bind(modules.lease),
      getOperationalSummary: modules.health.getOperationalSummary.bind(modules.health),
      inspectIntegrity: modules.integrity.inspectIntegrity.bind(modules.integrity),
      ...bindMethods(modules.approvals, ["createApprovalRequest", "resolveApprovalRequest", "consumeApprovalGrant"]),
      ...bindMethods(modules.cardContext, ["listPendingCardContextInvalidations", "markCardContextProjected", "projectCardContext"]),
      listBindings: modules.health.listBindings.bind(modules.health),
      recordInboundMessage: modules.inboundDispatch.recordInboundMessage.bind(modules.inboundDispatch),
      claimNextInboundMessage: modules.inboundDispatch.claimNextInboundMessage.bind(modules.inboundDispatch),
      markInboundMessageAccepted: modules.inboundDispatch.markInboundMessageAccepted.bind(modules.inboundDispatch),
      releaseInboundMessage: modules.inboundDispatch.releaseInboundMessage.bind(modules.inboundDispatch),
      recoverProcessingInboundMessages: modules.inboundDispatch.recoverProcessingInboundMessages.bind(modules.inboundDispatch),
      isBridgeMessage: modules.inboundDispatch.isBridgeMessage.bind(modules.inboundDispatch),
      recordBridgeMessage: modules.inboundDispatch.recordBridgeMessage.bind(modules.inboundDispatch),
      pruneDeliveredOutboundReplies: modules.retention.pruneDeliveredOutboundReplies.bind(modules.retention),
      pruneAcceptedInboundMessages: modules.retention.pruneAcceptedInboundMessages.bind(modules.retention),
      pruneTerminalSessionOperations: modules.retention.pruneTerminalSessionOperations.bind(modules.retention),
      reserveWorkerCardDisplay: modules.workerCardDisplay.reserveWorkerCardDisplay.bind(modules.workerCardDisplay),
      ...bindMethods(modules.commandIntents, ["acceptCommandIntent", "getCommandIntent", "claimNextCommandIntent", "finishCommandIntent", "listRecoverableCommandIntents", "recoverExecutingCommandIntents"]),
      ...bindMethods(modules.sessionOperations, ["acceptSessionOperation", "claimNextSessionOperation", "finishSessionOperation", "getSessionOperation", "listRecoverableSessionOperations"])
    });
  }
} as StoreConstructor;

function bindMethods<T extends object, K extends keyof T>(target: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, (target[key] as Function).bind(target)])) as Pick<T, K>;
}
