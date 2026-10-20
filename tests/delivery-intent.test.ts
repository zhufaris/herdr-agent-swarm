import { describe, expect, it } from "vitest";
import { deliveryIntentKind, encodeDeliveryIntent, materializedDeliveryIntent, primaryAnswerCreateIdempotencyKey } from "../src/domain/delivery-intent.js";
import { materializeOutboundReply } from "../src/events/outbound-intent-materializer.js";
import { prepareOutboundGatewayIntent } from "../src/events/outbound-gateway-intent.js";
import type { OutboundReply } from "../src/domain/types.js";

function reply(patch: Partial<OutboundReply> = {}): OutboundReply {
  return { id: "r1", gatewayId: "feishu:primary", gatewayProfileId: "feishu-cardkit-v1", gatewayPlanJson: null, gatewayPlanHash: null, gatewayCheckpointJson: null, idempotencyKey: "k1", bindingId: null, promptId: null, workerTurnId: null, workerId: null, workerSessionGeneration: null, viewVersion: null, cardSequence: null, selectionId: null, cardRole: null, targetRole: null, threadAliasId: null, workerThreadId: null, targetChatId: null, laneKey: "message:m1", conflictKey: "gateway:feishu:primary:message:m1", workClass: "live", rootMessageId: "m1", kind: "card_reply", payload: '{"legacy":true}', intentKind: null, intentJson: null, rendererRevision: null, state: "pending", attemptCount: 0, error: null, deliveredMessageId: null, cardIdCheckpoint: null, failureClass: null, effectCertainty: null, httpStatus: null, larkErrorCode: null, autoRecoveryCount: 0, deadLetteredAt: null, nextAttemptAt: "now", createdAt: "now", updatedAt: "now", ...patch };
}

describe("durable delivery intent", () => {
  it("uses one canonical idempotency identity for the Primary Answer create", () => {
    expect(primaryAnswerCreateIdempotencyKey("prompt-1")).toBe("run-card:create:prompt-1:answer");
  });
  it("keeps legacy payload rows deliverable", () => expect(materializeOutboundReply(reply())).toBe('{"legacy":true}'));
  it.each([
    ["text", "text"],
    ["card_reply", "card"],
    ["card_update", "card"],
    ["group_card_create", "group-card"],
    ["stream_card_create", "stream-card"],
    ["stream_content", "stream-content"],
    ["stream_finish", "stream-finish"],
    ["message_delete", "message-delete"]
  ] as const)("maps %s to the versioned %s intent kind", (replyKind, intentKind) => {
    expect(deliveryIntentKind(replyKind)).toBe(intentKind);
  });
  it("uses the immutable payload pinned in a typed intent", () => {
    const intent = materializedDeliveryIntent("card_update", '{"typed":true}');
    expect(materializeOutboundReply(reply({ intentKind: intent.kind, intentJson: JSON.stringify(intent), rendererRevision: 1 }))).toBe('{"typed":true}');
  });
  it("preserves a CardKit sequence on any surface replacement", () => {
    const prepared = prepareOutboundGatewayIntent({} as never, reply({
      kind: "card_update",
      payload: '{"schema":"2.0"}',
      cardSequence: 7
    }));

    expect(prepared.intent).toMatchObject({
      kind: "surface.replace",
      messageId: "m1",
      sequence: 7
    });
  });
  it("materializes a deletion intent with one exact message target and no content", () => {
    const prepared = prepareOutboundGatewayIntent({} as never, reply({
      kind: "message_delete",
      rootMessageId: "message-to-delete",
      payload: "",
      intentKind: "message-delete",
      intentJson: JSON.stringify({ schemaVersion: 2, kind: "message-delete" }),
      rendererRevision: 1
    }));

    expect(prepared.intent).toEqual({
      kind: "message.delete",
      purpose: "operation-result",
      messageId: "message-to-delete",
      idempotencyKey: "k1"
    });
  });
  it("encodes new intents without duplicating the canonical payload", () => {
    const encoded = encodeDeliveryIntent("card_update", '{"large":"payload"}');
    expect(JSON.parse(encoded.intentJson)).toEqual({ schemaVersion: 2, kind: "card" });
    expect(encoded.intentJson).not.toContain("payload");
  });
  it("materializes a version 2 intent from the canonical row payload", () => {
    expect(materializeOutboundReply(reply({
      payload: '{"canonical":true}', intentKind: "card",
      intentJson: JSON.stringify({ schemaVersion: 2, kind: "card" }), rendererRevision: 1
    }))).toBe('{"canonical":true}');
  });
  it("rejects unsupported renderer revisions", () => {
    const intent = materializedDeliveryIntent("card_update", "{}");
    expect(() => materializeOutboundReply(reply({ intentKind: intent.kind, intentJson: JSON.stringify(intent), rendererRevision: 2 }))).toThrow(/Unsupported durable delivery intent/);
  });
  it.each([
    ["malformed JSON", "{", "card"],
    ["unknown intent kind", JSON.stringify({ schemaVersion: 1, kind: "unknown", materializedPayload: "{}" }), "unknown"],
    ["mismatched intent kind", JSON.stringify({ schemaVersion: 1, kind: "text", materializedPayload: "{}" }), "card"]
  ])("rejects %s instead of silently delivering the legacy payload", (_label, intentJson, intentKind) => {
    expect(() => materializeOutboundReply(reply({ intentJson, intentKind: intentKind as never, rendererRevision: 1 }))).toThrow(/Unsupported durable delivery intent/);
  });
});
