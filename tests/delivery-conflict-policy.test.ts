import { describe, expect, it } from "vitest";
import { deliveryConflictKey, deliveryDegradationBudget } from "../src/domain/delivery-conflict.js";

describe("Delivery conflict identity", () => {
  it("uses one page identity across create and update lanes", () => {
    const create = deliveryConflictKey({
      gatewayId: "feishu:primary", laneKey: "gateway:feishu:primary:group-create:r1",
      projectionKey: "answer:prompt-1:page:2", bindingId: "binding", bindingGeneration: 3,
      promptId: "prompt-1", workerTurnId: null, workerId: null, workerSessionGeneration: null,
      streamPageIndex: 2, targetRole: null, kind: "stream_card_create", rootMessageId: null
    });
    const update = deliveryConflictKey({
      gatewayId: "feishu:primary", laneKey: "gateway:feishu:primary:answer:prompt-1:2",
      projectionKey: "answer:prompt-1:page:2", bindingId: "binding", bindingGeneration: 3,
      promptId: "prompt-1", workerTurnId: null, workerId: null, workerSessionGeneration: null,
      streamPageIndex: 2, targetRole: null, kind: "card_update", rootMessageId: "message-2"
    });

    expect(create).toBe("gateway:feishu:primary:answer-page:prompt-1:2");
    expect(update).toBe(create);
  });

  it("keeps Worker Task pages distinct and rejects empty fallback identity", () => {
    const base = {
      gatewayId: "feishu:primary", projectionKey: null, bindingId: "binding", bindingGeneration: 1,
      promptId: null, workerTurnId: "turn-1", workerId: "worker-1", workerSessionGeneration: 4,
      targetRole: null, kind: "stream_content" as const, rootMessageId: "message"
    };
    expect(deliveryConflictKey({ ...base, laneKey: "gateway:feishu:primary:worker-turn:turn-1:0", streamPageIndex: 0 }))
      .toBe("gateway:feishu:primary:worker-task:turn-1:0");
    expect(deliveryConflictKey({ ...base, laneKey: "gateway:feishu:primary:worker-turn:turn-1:1", streamPageIndex: 1 }))
      .toBe("gateway:feishu:primary:worker-task:turn-1:1");
    expect(() => deliveryConflictKey({ ...base, workerTurnId: null, laneKey: "", streamPageIndex: null }))
      .toThrow("delivery_conflict_identity_required");
  });
});

describe("Delivery degradation budget", () => {
  it("gives uncertain effects zero retries and one restart-stable 60 second deadline", () => {
    expect(deliveryDegradationBudget({
      failureClass: "unknown",
      effectCertainty: "uncertain",
      firstFailedAt: "2026-10-09T00:00:00.000Z"
    })).toEqual({
      attemptLimit: 0,
      durationMs: 60_000,
      deadlineAt: "2026-10-09T00:01:00.000Z"
    });
  });

  it("caps confirmed transient non-application at five attempts or 120 seconds", () => {
    expect(deliveryDegradationBudget({
      failureClass: "transient",
      effectCertainty: "rejected",
      firstFailedAt: "2026-10-09T00:00:00.000Z"
    })).toEqual({
      attemptLimit: 5,
      durationMs: 120_000,
      deadlineAt: "2026-10-09T00:02:00.000Z"
    });
  });
});
