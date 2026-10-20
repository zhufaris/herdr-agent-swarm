import type { HealthStore, LeaseStore } from "../../src/domain/ports/health.js";
import type { InboundMessageDispatchStore } from "../../src/domain/ports/workflow.js";
import type { WorkerCardDisplayStore } from "../../src/domain/ports/worker-card-display.js";
import type { CommandIntentStore } from "../../src/domain/ports/swarm-command.js";
import type { NaturalLanguageCommandConfirmationStore } from "../../src/domain/ports/natural-language-command-confirmation.js";
import type { ControllerInterpretationStore } from "../../src/domain/ports/controller-interpretation.js";
import type { SessionOperationStore } from "../../src/domain/ports/workflow.js";
import type { SqliteStoreLifecycle } from "../../src/store/sqlite-store-bundle.js";
import type { RetentionStore } from "../../src/domain/ports/retention.js";
import { SqliteStoreKernel } from "./sqlite-store-kernel.js";
import { createOutboxTestDriver } from "./outbox-test-driver.js";

export type SqliteBindingStore = SqliteStoreKernel & SqliteStoreLifecycle & LeaseStore & HealthStore &
  InboundMessageDispatchStore & RetentionStore & WorkerCardDisplayStore & CommandIntentStore & NaturalLanguageCommandConfirmationStore & ControllerInterpretationStore & SessionOperationStore & {
    acceptSessionOperation: SqliteStoreKernel["acceptLegacySessionOperationForTest"];
    inspectIntegrity: ReturnType<SqliteStoreKernel["capabilityModules"]>["integrity"]["inspectIntegrity"];
    getSessionOperation: ReturnType<SqliteStoreKernel["capabilityModules"]>["sessionOperations"]["getSessionOperation"];
  } & ReturnType<SqliteStoreKernel["capabilityModules"]>["approvals"] &
  { agentInputs: ReturnType<SqliteStoreKernel["capabilityModules"]>["agentInputs"] } &
  Pick<ReturnType<SqliteStoreKernel["capabilityModules"]>["promptDispatch"], "listPromptTranscriptTurns" | "adoptPromptTranscriptContinuation" | "observePrimaryPromptState"> &
  Pick<ReturnType<SqliteStoreKernel["capabilityModules"]>["cardContext"], "listPendingCardContextInvalidations" | "markCardContextProjected" | "projectCardContext"> & {
    workerSessionThreads: ReturnType<SqliteStoreKernel["capabilityModules"]>["workerSessionThreads"];
    paneTopology: ReturnType<SqliteStoreKernel["capabilityModules"]>["paneTopology"];
  };

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
      ...bindMethods(modules.outbox, ["enqueueOutboundReply", "setGatewayPlanPreparer", "reservePreparedOutboundReply", "reserveSemanticOutboundReply", "previewSemanticOutboundReply", "getReservedDeliveryIdentity", "prepareOutboundGatewayPlan", "getActiveAnswerPage", "getAnswerPage", "isActiveBindingThreadAlias", "getLarkDeliveryCooldown", "getOutboundReply", "getPrompt", "loadRunCard", "recoverEligibleDeadLetters", "recordBridgeMessage", "dismissSupersededAnswerStream", "loadWorkerTurnCard", "loadWorkerMainView", "listWorkerTurnCardPages"]),
      ...bindMethods(modules.bindingProvisioning, ["adoptBindingReviewOwnerIfEmpty"]),
      ...bindMethods(modules.outboxAdmin, ["listPendingOutboundReplies", "hasPendingOutboundReplyForWorkerTurn", "getOutboundReply", "markOutboundReplyFailed", "markOutboundReplyDeadLetter", "reservePaneThreadAlias"]),
      ...bindMethods(modules.promptDispatch, ["listPromptTranscriptTurns", "adoptPromptTranscriptContinuation", "observePrimaryPromptState"]),
      ...bindMethods(modules.runtimeReconciliation, ["hasActiveOrchestratorIdentityMigration", "hasActiveOrchestratorIdentityMigrationForPane"]),
      ...bindMethods(kernel, ["loadRuntimeIdentityClaim", "claimCurrentRuntimeIdentity"]),
      workerSessionThreads: modules.workerSessionThreads,
      paneTopology: modules.paneTopology,
      ...bindMethods(modules.instance, ["createAgentInstance", "createWorkerAgentInstance", "findAgentInstanceByPane", "listWorkerInstancesByParent", "listAgentInstances", "setPrimaryAgentInstance", "attachAgentInstanceRuntime", "refreshAgentInstanceRuntimeSession", "adoptAgentInstanceRuntimeMove", "checkpointAgentInstance", "updateAgentInstanceLifecycle", "updateAgentInstanceObservation", "reserveAgentInstanceStop", "reserveWorkerPaneClose", "finishAgentInstanceStop", "rollbackAgentInstanceStop", "detachAgentInstanceRuntime", "terminateWorkerSession", "getWorkspaceLease", "updateWorkspaceLease", "createInstanceRemovalPlan", "getInstanceRemovalPlan", "consumeInstanceRemovalPlan", "removeAgentInstance", "setBindingPrimaryToolCapability", "verifyBindingPrimaryToolCapability", "hasBindingPrimaryToolCapability", "revokeBindingPrimaryToolCapability", "acceptInstanceOperation", "claimInstanceOperation", "updateInstanceOperation", "getConversationTarget", "setConversationTarget", "projectLegacyBindingAsAgentInstance"]),
      activateWriteFence: modules.lifecycle.activateWriteFence.bind(modules.lifecycle),
      recoverPriorOwnerClaimsBatch: modules.lifecycle.recoverPriorOwnerClaimsBatch.bind(modules.lifecycle),
      deactivateWriteFence: modules.lifecycle.deactivateWriteFence.bind(modules.lifecycle),
      acquireInstanceLease: modules.lease.acquireInstanceLease.bind(modules.lease),
      renewInstanceLease: modules.lease.renewInstanceLease.bind(modules.lease),
      releaseInstanceLease: modules.lease.releaseInstanceLease.bind(modules.lease),
      getOperationalSummary: modules.integrity.getOperationalSummary.bind(modules.integrity),
      probeReadiness: modules.health.probeReadiness.bind(modules.health),
      inspectIntegrity: modules.integrity.inspectIntegrity.bind(modules.integrity),
      ...bindMethods(modules.approvals, ["createApprovalRequest", "resolveApprovalRequest", "consumeApprovalGrant"]),
      agentInputs: modules.agentInputs,
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
      compactDeliveryIntents: modules.retention.compactDeliveryIntents.bind(modules.retention),
      classifyHistoricalDeliveryDebt: modules.retention.classifyHistoricalDeliveryDebt?.bind(modules.retention),
      pruneCompensatedProjectionGaps: modules.retention.pruneCompensatedProjectionGaps?.bind(modules.retention),
      pruneAcceptedInboundMessages: modules.retention.pruneAcceptedInboundMessages.bind(modules.retention),
      pruneTerminalSessionOperations: modules.retention.pruneTerminalSessionOperations.bind(modules.retention),
      reserveWorkerCardDisplay: modules.workerCardDisplay.reserveWorkerCardDisplay.bind(modules.workerCardDisplay),
      ...bindMethods(modules.commandIntents, ["acceptCommandIntent", "getCommandIntent", "getCommandStatusView", "claimNextCommandIntent", "finishCommandIntent", "listRecoverableCommandIntents", "recoverExecutingCommandIntents", "registerWorkerThreadEntry"]),
      ...bindMethods(modules.naturalLanguageCommandConfirmations, ["stageNaturalLanguageCommandConfirmation", "getNaturalLanguageCommandConfirmation", "decideNaturalLanguageCommandConfirmation", "confirmNaturalLanguageSwarmCommand"]),
      ...bindMethods(modules.controllerInterpretations, ["acceptControllerInterpretation", "claimNextControllerInterpretation", "markControllerInterpretationDispatched", "finishControllerInterpretation", "failControllerInterpretation", "getControllerInterpretation", "recoverControllerInterpretations", "getControllerRuntime", "saveControllerRuntime", "markControllerRuntimeStale"]),
      acceptSessionOperation: kernel.acceptLegacySessionOperationForTest.bind(kernel),
      ...bindMethods(modules.sessionOperations, ["claimNextSessionOperation", "finishSessionOperation", "getSessionOperation", "listRecoverableSessionOperations"])
    });
  }
} as StoreConstructor;

function bindMethods<T extends object, K extends keyof T>(target: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.map((key) => [key, (target[key] as Function).bind(target)])) as Pick<T, K>;
}
