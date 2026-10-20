import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { createOutboundRuntime } from "../src/composition/create-outbound-runtime.js";
import type { BridgeConfig } from "../src/config.js";
import type { SemanticDeliveryWork } from "../src/domain/delivery.js";
import { encodePresentationSnapshot, presentationSnapshotHash } from "../src/domain/delivery-intent.js";
import type { PreparedDeliveryConsumer } from "../src/domain/ports/outbox.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { feishuGatewayApplicationPresentation, feishuGatewayPrimaryPresentation } from "../src/gateways/feishu/presentation.js";
import { createInMemoryGatewayPlugin, type InMemoryGatewayControl } from "./helpers/in-memory-gateway-plugin.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

describe("outbound runtime composition", () => {
  it("routes semantic Ring work through the configured presentation preparer", async () => {
    const bundle = createTestStoreBundle();
    const modules = bundle.driver.capabilityModules();
    let consumer: PreparedDeliveryConsumer | null = null;
    const control: InMemoryGatewayControl = { delivered: [], async emit() { throw new Error("not started"); } };
    const gateway = createInMemoryGatewayPlugin(control).create({ gatewayId: "memory:composition" }, {});
    const prepare = vi.spyOn(gateway.delivery, "prepare");
    const freezeSemanticDelivery = vi.spyOn(modules.preparedDeliveries, "freezeSemanticDelivery");
    const runtime = createOutboundRuntime({
      runtimeTuning: {
        cards: { payloadLimitChars: 9_000, answerPageLimitChars: 28_000, updateDebounceMs: 1 },
        outboxSafetyScanIntervalMs: 30_000
      },
      outboxRetention: { days: 14, batchSize: 100, maxBatches: 1, timeBudgetMs: 100, payloadCompactionEnabled: false }
    } as BridgeConfig, {
      ...bundle,
      conversationSegments: modules.conversationSegments,
      sessionActivity: modules.sessionActivity,
      preparedDeliveryProducers: {
        connectPreparedDeliveryProducers(_reservation, nextConsumer) { consumer = nextConsumer; }
      }
    }, gateway, new BridgeEventBus(), { wake: vi.fn(), subscribe: () => () => undefined }, pino({ enabled: false }), {
      primary: feishuGatewayPrimaryPresentation,
      application: feishuGatewayApplicationPresentation
    });
    const planned = feishuGatewayApplicationPresentation.turnCardSemanticPolicy.plan({
      segmentId: "segment", ownerKind: "primary", ownerLabel: "Primary", spaceName: "space", projectLabel: "project",
      tabLabel: null, paneToken: null, requestText: "compose", state: "working", timelineItems: [], gapWarning: null, viewVersion: 1
    }, { pageIndex: 0 }, {}, { encodedBytes: 9_000, elementCount: 256, actionCount: 32, profileVersion: gateway.profile.rendererRevision });
    const snapshotHash = presentationSnapshotHash(encodePresentationSnapshot(planned.snapshot));
    const work: SemanticDeliveryWork = {
      replyId: "semantic-composition", scope: { kind: "global" }, ownerFence: null, deliveryOrder: 1, workClass: "live",
      idempotencyKey: "semantic-composition", gatewayId: gateway.gatewayId, gatewayProfileId: gateway.profile.id,
      deliveryKind: "card_reply", rootMessageId: "root", cardSequence: null, conflictKey: "semantic-composition",
      projectionKey: "turn-card:segment:page:0", snapshotRevision: 1, priorCheckpoints: [], nextAttemptAt: new Date(0).toISOString(),
      estimatedBytes: 1_000, preparationState: "reserved",
      input: {
        kind: "semantic-snapshot", subject: { kind: "conversation-page", segmentId: "segment", pageIndex: 0, revision: 1 },
        snapshot: planned.snapshot, snapshotHash,
        plannerPolicyVersion: feishuGatewayApplicationPresentation.turnCardSemanticPolicy.plannerPolicyVersion,
        rendererPolicyVersion: feishuGatewayApplicationPresentation.turnCardSemanticPolicy.rendererPolicyVersion,
        gatewayProfileVersion: gateway.profile.rendererRevision
      }
    };

    runtime.ringDeliveryEngine.start();
    await runtime.ringDeliveryEngine.whenRecoveryReady();
    consumer!.enqueuePreparedDelivery(work);

    await vi.waitFor(() => expect(freezeSemanticDelivery).toHaveBeenCalledOnce());
    expect(prepare).toHaveBeenCalledOnce();
    await runtime.ringDeliveryEngine.stop();
    bundle.driver.close();
  });
});
