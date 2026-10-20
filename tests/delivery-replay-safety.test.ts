import { describe, expect, it } from "vitest";
import { isDirectDeliveryRetryAllowed, isReplaySafeSupersession, type DirectDeliveryRetryFacts, type ReplaySafeSupersessionFacts } from "../src/domain/delivery-replay-safety.js";

const safeFacts: ReplaySafeSupersessionFacts = {
  effectCertainty: "rejected",
  autoRecoveryCount: 0,
  kind: "card_update",
  idempotencyKey: "main-card:update:b1:2",
  projectionKey: "primary-main:b1:1",
  reconstructible: true,
  targetFrozen: false,
  providerOperationSafe: true,
  ownerCurrent: true,
  hasExternalEffectEvidence: false,
};

describe("Delivery replay safety", () => {
  it.each(["rejected", "not-started"] as const)("allows one reconstructible confirmed-non-application %s supersession", (effectCertainty) => {
    expect(isReplaySafeSupersession({ ...safeFacts, effectCertainty })).toBe(true);
  });

  it.each([
    ["uncertain effect", { effectCertainty: "uncertain" }],
    ["used recovery generation", { autoRecoveryCount: 1 }],
    ["unstable identity", { idempotencyKey: "", projectionKey: null }],
    ["non-reconstructible snapshot", { reconstructible: false }],
    ["frozen target", { targetFrozen: true }],
    ["unsafe provider operation", { providerOperationSafe: false }],
    ["stale owner or fence", { ownerCurrent: false }],
    ["existing external-effect evidence", { hasExternalEffectEvidence: true }],
    ["message deletion", { kind: "message_delete" }],
  ] satisfies Array<[string, Partial<ReplaySafeSupersessionFacts>]>)
  ("refuses %s", (_label, patch) => {
    expect(isReplaySafeSupersession({ ...safeFacts, ...patch })).toBe(false);
  });

  const directRetryFacts: DirectDeliveryRetryFacts = {
    effectCertainty: "rejected",
    autoRecoveryCount: 0,
    kind: "card_reply",
    deliveredMessageId: null,
    cardIdCheckpoint: null,
    gatewayCheckpointJson: null,
  };

  it.each(["text", "card_reply", "group_card_create", "stream_card_create"] as const)
  ("allows direct retry for a confirmed-non-application %s", (kind) => {
    expect(isDirectDeliveryRetryAllowed({ ...directRetryFacts, kind })).toBe(true);
  });

  it.each([
    ["uncertain effect", { effectCertainty: "uncertain" }],
    ["used recovery generation", { autoRecoveryCount: 1 }],
    ["existing-card mutation", { kind: "card_update" }],
    ["message deletion", { kind: "message_delete" }],
    ["delivered message evidence", { deliveredMessageId: "message-1" }],
    ["card checkpoint evidence", { cardIdCheckpoint: "card-1" }],
    ["gateway checkpoint evidence", { gatewayCheckpointJson: "{}" }],
  ] satisfies Array<[string, Partial<DirectDeliveryRetryFacts>]>)("refuses direct retry for %s", (_label, patch) => {
    expect(isDirectDeliveryRetryAllowed({ ...directRetryFacts, ...patch })).toBe(false);
  });
});
