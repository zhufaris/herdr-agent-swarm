import { describe, expect, it } from "vitest";
import { materializedDeliveryIntent } from "../src/domain/delivery-intent.js";
import { materializeOutboundReply } from "../src/events/outbound-intent-materializer.js";
import type { OutboundReply } from "../src/domain/types.js";

function reply(patch: Partial<OutboundReply> = {}): OutboundReply {
  return { id: "r1", idempotencyKey: "k1", bindingId: null, promptId: null, workerTurnId: null, workerId: null, workerSessionGeneration: null, viewVersion: null, cardSequence: null, selectionId: null, cardRole: null, targetRole: null, laneKey: "message:m1", rootMessageId: "m1", kind: "card_reply", payload: '{"legacy":true}', intentKind: null, intentJson: null, rendererRevision: null, state: "pending", attemptCount: 0, error: null, deliveredMessageId: null, cardIdCheckpoint: null, failureClass: null, httpStatus: null, larkErrorCode: null, autoRecoveryCount: 0, deadLetteredAt: null, nextAttemptAt: "now", createdAt: "now", updatedAt: "now", ...patch };
}

describe("durable delivery intent", () => {
  it("keeps legacy payload rows deliverable", () => expect(materializeOutboundReply(reply())).toBe('{"legacy":true}'));
  it("uses the immutable payload pinned in a typed intent", () => {
    const intent = materializedDeliveryIntent("card_update", '{"typed":true}');
    expect(materializeOutboundReply(reply({ intentKind: intent.kind, intentJson: JSON.stringify(intent), rendererRevision: 1 }))).toBe('{"typed":true}');
  });
  it("rejects unsupported renderer revisions", () => {
    const intent = materializedDeliveryIntent("card_update", "{}");
    expect(() => materializeOutboundReply(reply({ intentKind: intent.kind, intentJson: JSON.stringify(intent), rendererRevision: 2 }))).toThrow(/Unsupported durable delivery intent/);
  });
});
