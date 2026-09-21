import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSqliteStoreBundle, createSqliteStoreBundleFromContext } from "../src/store/sqlite-store-bundle.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteLeaseStore } from "../src/store/sqlite/lease-store.js";

describe("SQLite capability graph", () => {
  it("publishes intentional aliases as the same capability instances", () => {
    const stores = createSqliteStoreBundle(":memory:");

    expect(stores.instanceLifecycle).toBe(stores.instance);
    expect(stores.instanceTurns).toBe(stores.instance);
    expect(stores.outboundIntent).toBe(stores.outbox);
    expect(stores.answerPages).toBe(stores.projection);
    expect(stores.mainCards).toBe(stores.projection);
    expect(stores.bindingProvisioning).toBe(stores.runtimeReconciliation);
    expect(stores.runtimeReconciliation).toBe(stores.retiredPaneCleanup);
    expect(stores.retiredPaneCleanup).toBe(stores.sessionAdministration);
    expect(stores.sessionAdministration).toBe(stores.paneRetention);
    expect(stores.paneControl).toBe(stores.paneClose);
    expect(stores.paneClose).toBe(stores.modelSelection);
    expect(stores.modelSelection).toBe(stores.cardInteraction);

    stores.lifecycle.close();
  });

  it("shares the supplied lease, write fence, and context lifecycle", () => {
    const context = new SqliteContext(":memory:");
    const lease = new SqliteLeaseStore(context);
    const stores = createSqliteStoreBundleFromContext(context, lease);

    expect(stores.lease).toBe(lease);
    const acquired = stores.lease.acquireInstanceLease("owner", "2026-09-21T00:00:00.000Z", "2099-09-21T00:00:00.000Z")!;
    stores.lifecycle.activateWriteFence(acquired.ownerId, acquired.fencingToken);
    expect(context.database.prepare("SELECT owner_id, fencing_token FROM temp.bridge_write_fence").get()).toEqual({ owner_id: "owner", fencing_token: 1 });

    stores.lifecycle.close();
    expect(() => context.database.prepare("SELECT 1")).toThrow();
  });

  it("preserves the fixed migration call sequence and historical transactions", () => {
    const source = readFileSync(new URL("../src/store/sqlite/migrations.ts", import.meta.url), "utf8");
    const orchestration = source.slice(source.indexOf("  private prepareRunCardView"), source.indexOf("  canonicalizeLegacyAnswerTargets"));
    const calls = [...orchestration.matchAll(/this\.(?:(binding|prompt|cards|worker|retired|gateway)\.([A-Za-z0-9_]+)|(ensureNaturalLanguageCommandConfirmations|ensureControllerInterpretationJobs))\(/g)]
      .map((match) => match[1] ? `${match[1]}.${match[2]}` : `self.${match[3]}`);

    expect(calls).toEqual([
      "cards.runCardViewNeedsRebuild", "cards.ensureOutboundReplyColumns", "cards.ensureMainCardSequences",
      "worker.ensureAgentInstanceLifecycleColumns", "binding.ensureInboundMessageIdempotency", "binding.ensureInboundMessageScopes",
      "cards.ensureOutboundCardCheckpoint", "cards.ensureRequestCardOutboxColumns", "cards.ensureOutboundTargetRole",
      "cards.ensureRunCardQueueFeedbackColumn", "cards.ensureRunCardRequestText", "cards.ensureRunCardSpaceName",
      "cards.ensureRunCardSessionTitle", "cards.ensureDualRequestCardColumns", "cards.ensureRunCardAnswerState",
      "cards.ensureRunCardProgressSummary", "cards.ensureRunCardInteractionColumns", "cards.ensureStreamingCardColumns",
      "cards.ensureAnswerPageDeliveryMode", "cards.ensureAnswerPages", "binding.ensureProjectSelectionColumns",
      "binding.ensurePrimaryAgentKindColumns", "binding.ensureBindingLifecycleColumns", "binding.ensureBindingPrimaryToolCapabilities",
      "binding.ensureBindingCreatorColumn", "binding.ensureSessionOperations", "binding.ensureAgentSessionColumns",
      "retired.removeReportedTraexSessionColumns", "binding.ensureBindingResetColumns", "binding.ensureTwoPhaseResetState",
      "binding.ensureSessionQueryIndex", "prompt.ensurePromptCancelledState", "prompt.ensurePromptObservationColumn",
      "prompt.ensurePromptProvenanceColumns", "prompt.ensurePromptTranscriptProvenanceColumns", "prompt.ensureTurnPriorityColumns",
      "prompt.ensureModelPreferenceSchema", "prompt.ensurePromptExecutionOriginColumn", "cards.ensureRunCardActivityColumn",
      "retired.convergeRetiredPromptSteering", "prompt.ensurePrimaryContinuationLineage", "cards.ensureOutboundDeliveryOrder",
      "cards.ensureOutboundDismissedState", "cards.ensureOutboundDeliveryOrder", "worker.ensureWorkerTurnCards",
      "worker.ensureWorkerTurnCardPageStates", "worker.ensureWorkerTurnCardProgress", "worker.ensureWorkerTurnProgressSequence",
      "worker.ensureWorkerTurnTokenCount", "worker.ensureWorkerSourcePrimaryPaneLabel", "worker.ensureWorkerParentIdentity",
      "worker.ensurePrimaryScopedWorkerNames", "worker.ensureCardContextProjectionTables", "worker.ensureCardContextPendingIndex",
      "worker.ensureActiveWorkerScopedNames", "worker.ensureWorkerTurnContextReferences", "worker.ensureInstanceTurnActorProvenance",
      "worker.ensureWorkerOutboxStreamMetadata", "worker.ensureWorkerMainOutboxIdentity", "worker.ensurePrimaryCardContextColumns",
      "worker.ensureCardContextStartupInvalidations", "worker.ensureWorkerPaneCloseSteps", "worker.ensureWorkerPaneCloseRetainedState",
      "cards.ensureOutboundLaneKey", "cards.ensureOutboxLaneQuarantines", "cards.ensureOutboxLaneHeads",
      "cards.ensureIndependentReplyLanes", "cards.ensureCardContextOutboxLanes", "cards.ensureOutboundFailureMetadata",
      "cards.ensureTypedDeliveryIntents", "prompt.ensurePaneCloseOperationState", "prompt.ensurePaneControlOperationState",
      "prompt.ensureTurnControlOperations", "prompt.ensureSwarmCommandIntents", "self.ensureNaturalLanguageCommandConfirmations",
      "self.ensureControllerInterpretationJobs", "worker.ensureWorkerCardDisplayRequests",
      "worker.ensureWorkerSessionThreads", "worker.ensureWorkerThreadEntryRequests", "worker.ensureWorkerThreadEntryInvalidations",
      "cards.recreateRunCardsView", "cards.ensureQueryIndexes", "cards.canonicalizeLegacyAnswerTargets",
      "cards.finishLegacyDeliveredAnswerPages", "cards.dismissStreamsForFinishedAnswerPages", "cards.ensureOutboundWorkClass",
      "gateway.ensureGatewayIdentityAndPlans", "cards.ensureOutboundClaims", "cards.ensureDeliveryRecoveries",
      "cards.ensureAnswerRecoveryEvidence", "cards.ensureGroupCardCreates", "cards.ensureWorkerThreadTargets",
      "cards.ensureOutboundEffectCertainty", "cards.ensureLarkDeliveryCooldown", "gateway.ensureGatewayIdentityAndPlans",
      "gateway.ensureGatewayScopedOutboxLanes", "cards.ensureOutboundClaims", "gateway.convergeLegacyExpiredAnswerTargets"
    ]);
    expect([...orchestration.matchAll(/INSERT INTO schema_migrations\(version\) VALUES \((\d)\)/g)].map((match) => match[1])).toEqual(["2", "3", "4"]);
    expect(orchestration.match(/BEGIN IMMEDIATE/g)).toHaveLength(3);
    expect(orchestration.match(/COMMIT/g)).toHaveLength(3);
    expect(orchestration.match(/ROLLBACK/g)).toHaveLength(3);
  });
});
