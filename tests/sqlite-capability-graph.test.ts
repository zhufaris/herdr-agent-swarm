import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectPreparedDeliveryProducers } from "../src/composition/create-outbound-runtime.js";
import type { GatewayDeliveryIntent } from "../src/gateways/contract/plugin.js";
import { createSqliteStoreBundle, createSqliteStoreBundleFromContext } from "../src/store/sqlite-store-bundle.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteLeaseStore } from "../src/store/sqlite/lease-store.js";
import { inspectSqliteIntegrity } from "../src/store/sqlite-integrity.js";

describe("SQLite capability graph", () => {
  it("publishes intentional aliases as the same capability instances", () => {
    const stores = createSqliteStoreBundle(":memory:", { busyTimeoutMs: 250, slowTransactionThresholdMs: 100 });

    expect(stores.instanceLifecycle).toBe(stores.instance);
    expect(stores.instanceTurns).toBe(stores.instance);
    expect(stores.outboundIntent).toBe(stores.outbox);
    expect(stores.answerPages).toBe(stores.projection);
    expect(stores.mainCards).not.toBe(stores.projection);
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

  it("fences answer segment writes behind the active lease owner", () => {
    const context = new SqliteContext(":memory:");
    const lease = new SqliteLeaseStore(context);
    const stores = createSqliteStoreBundleFromContext(context, lease);

    const acquired = stores.lease.acquireInstanceLease("owner", "2026-10-01T00:00:00.000Z", "2099-10-01T00:00:00.000Z")!;
    stores.lifecycle.activateWriteFence(acquired.ownerId, acquired.fencingToken);
    expect(context.database.prepare(`
      INSERT INTO answer_segments(
        aggregate_kind, aggregate_id, segment_index, source_human_item_id, request_text,
        start_after_sequence, end_before_sequence, end_before_item_id, state, created_at, updated_at
      ) VALUES ('primary-run', 'p1', 0, NULL, 'seed', 0, NULL, NULL, 'open', 'now', 'now')
    `).run().changes).toBe(1);

    stores.lease.releaseInstanceLease(acquired.ownerId, acquired.fencingToken);

    expect(() => context.database.prepare(`
      INSERT INTO answer_segments(
        aggregate_kind, aggregate_id, segment_index, source_human_item_id, request_text,
        start_after_sequence, end_before_sequence, end_before_item_id, state, created_at, updated_at
      ) VALUES ('primary-run', 'p2', 0, NULL, 'seed', 0, NULL, NULL, 'open', 'now', 'now')
    `).run()).toThrow("stale_instance_lease");

    stores.lifecycle.close();
  });

  it("reserves one independent shortcut-panel group-card identity", () => {
    const context = new SqliteContext(":memory:");
    const stores = createSqliteStoreBundleFromContext(context, new SqliteLeaseStore(context));
    connectShortcutPanelPreparedDelivery(stores);

    expect(stores.shortcutPanel.reserve("chat", { schema: "2.0" })).toBe("reserved");
    expect(stores.shortcutPanel.reserve("chat", { schema: "2.0" })).toBe("pending");
    expect(inspectSqliteIntegrity(context.database, 20).issues).not.toContainEqual(expect.objectContaining({ rule: "outbound_group_target_invalid" }));

    stores.lifecycle.close();
  });

  it("replaces a shortcut panel only after Lark explicitly rejected its create", () => {
    const context = new SqliteContext(":memory:");
    const stores = createSqliteStoreBundleFromContext(context, new SqliteLeaseStore(context));
    connectShortcutPanelPreparedDelivery(stores);

    expect(stores.shortcutPanel.reserve("chat", { schema: "2.0", body: { elements: [] } })).toBe("reserved");
    const panel = context.database.prepare("SELECT id FROM shortcut_panels WHERE chat_id = ?").get("chat") as { id: string };
    context.database.prepare("UPDATE outbound_replies SET state = 'dead_letter', effect_certainty = 'rejected' WHERE shortcut_panel_id = ?").run(panel.id);
    const rejected = context.database.prepare("SELECT id, lane_key FROM outbound_replies WHERE shortcut_panel_id = ?").get(panel.id) as { id: string; lane_key: string };
    context.database.prepare("INSERT INTO outbox_lane_quarantines(lane_key, failed_reply_id, lane_class, failure_class, state, action, reason, created_at, updated_at) VALUES (?, ?, 'immutable', 'permanent', 'active', 'blocked', 'rejected', '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:00.000Z')").run(rejected.lane_key, rejected.id);

    expect(stores.shortcutPanel.reserve("chat", { schema: "2.0", body: { elements: [{ tag: "markdown", content: "fixed" }] } })).toBe("reserved");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE shortcut_panel_id = ?").get(panel.id)).toEqual({ count: 2 });
    expect(context.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE lane_key = ?").get(rejected.lane_key)).toEqual({ state: "released" });

    stores.lifecycle.close();
  });

  it("releases a stranded shortcut-panel successor only behind an explicitly rejected predecessor", () => {
    const context = new SqliteContext(":memory:");
    const stores = createSqliteStoreBundleFromContext(context, new SqliteLeaseStore(context));
    connectShortcutPanelPreparedDelivery(stores);

    stores.shortcutPanel.reserve("chat", { schema: "2.0" });
    const panel = context.database.prepare("SELECT id FROM shortcut_panels WHERE chat_id = ?").get("chat") as { id: string };
    context.database.prepare("UPDATE outbound_replies SET state = 'dead_letter', effect_certainty = 'rejected' WHERE shortcut_panel_id = ?").run(panel.id);
    const rejected = context.database.prepare("SELECT id, lane_key FROM outbound_replies WHERE shortcut_panel_id = ?").get(panel.id) as { id: string; lane_key: string };
    context.database.prepare("INSERT INTO outbox_lane_quarantines(lane_key, failed_reply_id, lane_class, failure_class, state, action, reason, created_at, updated_at) VALUES (?, ?, 'immutable', 'permanent', 'active', 'blocked', 'rejected', '2026-09-29T00:00:00.000Z', '2026-09-29T00:00:00.000Z')").run(rejected.lane_key, rejected.id);
    context.database.prepare(`INSERT INTO outbound_replies(
      id, gateway_id, gateway_profile_id, idempotency_key, shortcut_panel_id, target_chat_id, work_class,
      root_message_id, kind, payload, lane_key, scope_kind, scope_key, state, attempt_count,
      next_attempt_at, created_at, updated_at
    ) SELECT 'successor', gateway_id, gateway_profile_id, 'successor', shortcut_panel_id, target_chat_id, work_class,
      root_message_id, kind, payload, lane_key, scope_kind, scope_key, 'pending', 0,
      next_attempt_at, '2099-09-29T00:00:01.000Z', '2099-09-29T00:00:01.000Z'
      FROM outbound_replies WHERE id = ?`).run(rejected.id);

    expect(stores.shortcutPanel.reserve("chat", { schema: "2.0" })).toBe("pending");
    expect(context.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE lane_key = ?").get(rejected.lane_key)).toEqual({ state: "released" });

    stores.lifecycle.close();
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
      "cards.ensureRunCardQueueFeedbackColumn", "cards.ensureRunCardRequestText", "cards.ensureRunCardReplyContext", "cards.ensureRunCardSpaceName",
      "cards.ensureRunCardSessionTitle", "cards.ensureRunCardPaneToken", "cards.ensureDualRequestCardColumns", "cards.ensureRunCardAnswerState",
      "cards.ensureRunCardProgressSummary", "cards.ensureRunCardInteractionColumns", "cards.ensureStreamingCardColumns",
      "cards.ensureAnswerPageDeliveryMode", "cards.ensureAnswerPages", "binding.ensureProjectSelectionColumns", "binding.ensureBindingKindColumn",
      "binding.ensurePrimaryAgentKindColumns", "cards.ensureRunCardProjectionContext", "binding.ensureBindingLifecycleColumns", "binding.ensureBindingPaneTokenColumn", "binding.ensureBindingPrimaryToolCapabilities",
      "binding.ensureBindingCreatorColumn", "binding.ensureSessionOperations", "binding.ensureAgentSessionColumns",
      "retired.removeReportedTraexSessionColumns", "binding.ensureBindingResetColumns", "binding.ensureTwoPhaseResetState",
      "binding.ensureSessionQueryIndex", "prompt.ensurePromptCancelledState", "prompt.ensurePromptObservationColumn",
      "prompt.ensurePromptProvenanceColumns", "prompt.ensurePromptTranscriptProvenanceColumns", "prompt.ensurePromptNativeSubmissionColumn", "prompt.ensurePromptTranscriptTurnOwnership", "prompt.ensurePromptIdentityCorrections", "prompt.ensureTurnPriorityColumns",
      "prompt.ensureModelPreferenceSchema", "prompt.ensurePromptExecutionOriginColumn", "prompt.ensurePromptSourceIdentity", "prompt.ensurePromptExecutionLifecycle", "cards.ensureRunCardExecutionPhases", "cards.ensureRunCardTaskListTitle", "cards.ensureRunCardActivityColumn",
      "retired.convergeRetiredPromptSteering", "prompt.ensurePrimaryContinuationLineage", "cards.ensureOutboundDeliveryOrder",
      "cards.ensureOutboundDismissedState", "cards.ensureOutboundDeliveryOrder", "worker.ensureWorkerTurnCards", "worker.ensureWorkerPaneTokenColumn",
      "worker.ensureWorkerTurnCardPageStates", "cards.ensureCardKitAnswerPageModes", "worker.ensureWorkerTurnCardProgress", "worker.ensureWorkerTurnProgressSequence",
      "worker.ensureWorkerTurnTokenCount", "worker.ensureWorkerSourcePrimaryPaneLabel", "worker.ensureWorkerParentIdentity",
      "worker.ensurePrimaryScopedWorkerNames", "worker.ensureCardContextProjectionTables", "worker.ensureCardContextPendingIndex",
      "worker.ensureActiveWorkerScopedNames", "worker.ensureWorkerTurnContextReferences", "worker.ensureInstanceTurnActorProvenance",
      "worker.ensureWorkerOutboxStreamMetadata", "worker.ensureWorkerMainOutboxIdentity", "worker.ensurePrimaryCardContextColumns",
      "worker.ensureCardContextStartupInvalidations", "worker.ensureWorkerPaneCloseSteps", "worker.ensureWorkerPaneCloseRetainedState",
      "cards.ensureOutboundLaneKey", "cards.ensureOutboxLaneQuarantines", "cards.ensureOutboxLaneHeads",
      "cards.ensureIndependentReplyLanes", "cards.ensureCardContextOutboxLanes", "cards.ensureOutboundFailureMetadata",
      "cards.ensureTypedDeliveryIntents", "prompt.ensurePaneCloseOperationState", "prompt.ensurePaneControlOperationState",
      "prompt.ensureTurnControlOperations", "prompt.ensureSwarmCommandIntents", "self.ensureNaturalLanguageCommandConfirmations",
      "prompt.ensureNaturalLanguageCommandFrozenTargets", "self.ensureControllerInterpretationJobs", "worker.ensureWorkerCardDisplayRequests",
      "worker.ensureWorkerSessionThreads", "worker.ensureWorkerThreadEntryRequests", "worker.ensureWorkerThreadEntryInvalidations",
      "cards.recreateRunCardsView", "cards.ensureQueryIndexes", "cards.canonicalizeLegacyAnswerTargets",
      "cards.finishLegacyDeliveredAnswerPages", "cards.dismissStreamsForFinishedAnswerPages", "cards.ensureOutboundWorkClass",
      "gateway.ensureGatewayIdentityAndPlans", "binding.ensureOrchestratorBindingIndex", "cards.ensureOutboundClaims", "cards.ensureOutboundEffectCertainty", "cards.ensureDeliveryRecoveries", "cards.ensureDeliveryRecoverySemanticProof", "cards.backfillLegacyWorkerExpiredTargetSemanticProof",
      "cards.ensureAnswerRecoveryEvidence", "cards.ensureGroupCardCreates", "cards.ensureWorkerThreadTargets",
      "cards.ensureOutboundEffectCertainty", "gateway.ensureGatewayIdentityAndPlans", "cards.ensureShortcutPanelTargets", "cards.ensureLarkDeliveryCooldown", "gateway.ensureGatewayIdentityAndPlans",
      "gateway.ensureGatewayScopedOutboxLanes", "cards.ensureOutboundClaims", "cards.ensureAnswerPageOutboxLanes", "cards.ensureWorkerTurnPageOutboxLanes", "cards.dismissUnclaimedLegacyRichTextIntents", "gateway.convergeLegacyExpiredAnswerTargets"
    ]);
    expect([...orchestration.matchAll(/INSERT INTO schema_migrations\(version\) VALUES \((\d)\)/g)].map((match) => match[1])).toEqual(["2", "3", "4"]);
    expect(orchestration.match(/this\.migrationTransaction\(/g)).toHaveLength(3);
  });
});

function connectShortcutPanelPreparedDelivery(stores: ReturnType<typeof createSqliteStoreBundleFromContext>): void {
  connectPreparedDeliveryProducers(stores.outbox, stores.preparedDeliveryProducers, {
    prepare: (intent: GatewayDeliveryIntent) => ({ protocolVersion: 1, gatewayId: "feishu:primary", profileId: "feishu-cardkit-v1", rendererRevision: 1, operation: intent.kind, intent })
  }, { enqueuePreparedDelivery() {} });
}
