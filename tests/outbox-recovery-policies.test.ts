import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { OutboundReply } from "../src/domain/types.js";
import { lightweightAnswerCardPayload, normalizedEffectCertainty, outboundLaneClass, streamContentPageIndex } from "../src/store/sqlite/outbox-recovery/policies.js";
import { parseTurnCardProjectionKey } from "../src/domain/turn-card-projection-key.js";
import { planDeliveryRetry } from "../src/domain/delivery-retry-policy.js";

function reply(patch: Partial<OutboundReply> = {}): OutboundReply {
  return {
    id: "reply-1", gatewayId: "feishu:primary", gatewayProfileId: "feishu-cardkit-v1", gatewayPlanJson: null,
    gatewayPlanHash: null, gatewayCheckpointJson: null, idempotencyKey: "idem-1", bindingId: null, rootMessageId: null,
    promptId: null, workerTurnId: null, workerId: null, workerSessionGeneration: null, viewVersion: null, cardSequence: null,
    selectionId: null, cardRole: null, targetRole: null, threadAliasId: null, workerThreadId: null, targetChatId: null,
    laneKey: "reply:reply-1", workClass: "interactive", kind: "card_reply", payload: "{}", intentKind: null,
    intentJson: null, rendererRevision: null, state: "pending", attemptCount: 0, error: null, deliveredMessageId: null,
    cardIdCheckpoint: null, failureClass: null, effectCertainty: null, httpStatus: null, larkErrorCode: null,
    autoRecoveryCount: 0, deadLetteredAt: null, nextAttemptAt: "2026-09-25T00:00:00.000Z",
    createdAt: "2026-09-25T00:00:00.000Z", updatedAt: "2026-09-25T00:00:00.000Z", ...patch,
  };
}

describe("outbox recovery policies", () => {
  it("normalizes explicit, rejected, retryable, and uncertain effect certainty", () => {
    expect(normalizedEffectCertainty({ failureClass: "unknown", effectCertainty: "rejected", httpStatus: null, larkErrorCode: null })).toBe("rejected");
    expect(normalizedEffectCertainty({ failureClass: "permanent", httpStatus: null, larkErrorCode: null })).toBe("rejected");
    expect(normalizedEffectCertainty({ failureClass: "transient", httpStatus: null, larkErrorCode: null })).toBe("not-started");
    expect(normalizedEffectCertainty({ failureClass: "unknown", httpStatus: null, larkErrorCode: null })).toBe("uncertain");
  });

  it("classifies durable lanes without transport context", () => {
    expect(outboundLaneClass(reply({ cardRole: "answer", promptId: "p1", kind: "stream_content" }))).toBe("answer_stream");
    expect(outboundLaneClass(reply({ targetRole: "session_status", kind: "card_update" }))).toBe("main_card");
    expect(outboundLaneClass(reply({ kind: "card_update" }))).toBe("replaceable_card");
    expect(outboundLaneClass(reply())).toBe("immutable");
  });

  it("decodes only integer stream page indexes", () => {
    expect(streamContentPageIndex('{"pageIndex":2}')).toBe(2);
    expect(streamContentPageIndex('{"pageIndex":2.5}')).toBeNull();
    expect(streamContentPageIndex("invalid")).toBeNull();
  });

  it("rewrites only the selected legacy or Gateway streaming slot", () => {
    const legacy = lightweightAnswerCardPayload(JSON.stringify({ card: { body: { elements: [{ element_id: "answer", content: "secret" }] } }, stream: { elementId: "answer" } }));
    expect(JSON.parse(legacy).card.body.elements[0].content).toBe("正在恢复本页内容…");
    const gateway = lightweightAnswerCardPayload(JSON.stringify({ card: { schemaVersion: 1, nodes: [{ kind: "column", nodes: [{ kind: "markdown", slot: "answer", content: "secret" }] }] }, stream: { elementId: "answer" } }));
    expect(JSON.parse(gateway).card.nodes[0].nodes[0].content).toBe("正在恢复本页内容…");
  });

  it("preserves exact invalid payload errors", () => {
    expect(() => lightweightAnswerCardPayload("{}")).toThrow("Answer continuation metadata missing for lightweight recovery");
    expect(() => lightweightAnswerCardPayload(JSON.stringify({ card: {}, stream: { elementId: "answer" } }))).toThrow("Answer card body missing for lightweight recovery");
    expect(() => lightweightAnswerCardPayload(JSON.stringify({ card: { body: { elements: [] } }, stream: { elementId: "answer" } }))).toThrow("Answer card streaming element missing for lightweight recovery");
  });

  it("accepts only anchored colon-safe Turn Card targets", () => {
    expect(parseTurnCardProjectionKey("turn-card:segment:abc:page:2")).toEqual({ segmentId: "segment:abc", pageIndex: 2 });
    expect(parseTurnCardProjectionKey("prefix-turn-card:segment:abc:page:2")).toBeNull();
    expect(parseTurnCardProjectionKey("turn-card:segment:abc:page:-1")).toBeNull();
    expect(parseTurnCardProjectionKey("turn-card:segment:abc:page:2:extra")).toBeNull();
  });

  it("keeps public recovery transactions attributable by operation", () => {
    const source = readFileSync(new URL("../src/store/sqlite/outbox-recovery-store.ts", import.meta.url), "utf8");
    for (const operation of [
      "failure-transition", "recover-eligible-dead-letters", "retire-undelivered-worker-task-cards",
      "recover-stale-quarantines", "retry-dead-letter", "dismiss-dead-letter"
    ]) expect(source).toContain(`sqlite.outbox-recovery-store.${operation}`);
    expect(source).not.toContain('transaction("sqlite.outbox-recovery-store.write"');
  });

  it("shares a bounded exponential retry decision with provider-delay floors", () => {
    const nowMs = Date.parse("2026-10-13T00:00:00.000Z");
    const decisions = Array.from({ length: 5 }, (_, previousAttemptCount) => planDeliveryRetry({
      previousAttemptCount, explicitDelayMs: 1_000, nowMs, random: () => 0.5
    }));
    expect(decisions.map(({ attemptCount, exhausted, nextAttemptAt }) => ({
      attemptCount, exhausted, delayMs: Date.parse(nextAttemptAt) - nowMs
    }))).toEqual([
      { attemptCount: 1, exhausted: false, delayMs: 1_000 },
      { attemptCount: 2, exhausted: false, delayMs: 2_000 },
      { attemptCount: 3, exhausted: true, delayMs: 4_000 },
      { attemptCount: 4, exhausted: true, delayMs: 8_000 },
      { attemptCount: 5, exhausted: true, delayMs: 16_000 }
    ]);
    expect(planDeliveryRetry({ previousAttemptCount: 0, explicitDelayMs: 7_200_000, nowMs, random: () => 0.5 }).nextAttemptAt)
      .toBe("2026-10-13T01:00:00.000Z");
  });
});
