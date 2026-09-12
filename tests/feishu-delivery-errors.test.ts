import { describe, expect, it } from "vitest";
import { classifyFeishuFailure } from "../src/gateways/feishu/errors.js";
import type { GatewayDeliveryIntent } from "../src/gateways/contract/plugin.js";

const viewIntent = (purpose: GatewayDeliveryIntent["purpose"] = "operation-result"): GatewayDeliveryIntent => ({ kind: "message.reply.view", purpose, rootMessageId: "root", view: {}, idempotencyKey: "key" });

describe("Feishu delivery error normalization", () => {
  it.each([
    [{ response: { status: 429, headers: { "retry-after": "7" } } }, { failureClass: "transient", effectCertainty: "rejected", httpStatus: 429, retryAfterMs: 7_000 }],
    [{ response: { status: 503 } }, { failureClass: "transient", effectCertainty: "rejected", httpStatus: 503 }],
    [Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }), { failureClass: "transient", effectCertainty: "not-started" }],
    [Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }), { failureClass: "transient", effectCertainty: "not-started" }],
    [Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }), { failureClass: "transient", effectCertainty: "not-started" }],
    [Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), { failureClass: "unknown", effectCertainty: "uncertain" }],
    [Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" }), { failureClass: "unknown", effectCertainty: "uncertain" }],
    [Object.assign(new Error("headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" }), { failureClass: "unknown", effectCertainty: "uncertain" }],
    [{ response: { status: 400, data: { code: 200740 } } }, { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, providerCode: "200740" }],
    [{ response: { status: 400, data: { code: 230028 } } }, { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, providerCode: "230028" }],
    [{ response: { status: 400, data: { code: 300309 } } }, { failureClass: "permanent", effectCertainty: "rejected", providerCode: "300309" }],
    [{ response: { status: 400, data: { code: 300317 } } }, { failureClass: "permanent", effectCertainty: "rejected", providerCode: "300317" }],
    [{ response: { status: 400, data: { code: 230099 } } }, { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, providerCode: "230099" }]
  ])("classifies structured failures conservatively", (error, expected) => {
    expect(classifyFeishuFailure(error, viewIntent(), "reply_card")).toMatchObject(expected);
  });

  it.each([
    [230099, "update_card", "primary-main", "stale_main_card"],
    [230099, "update_cardkit", "primary-main", "stale_main_card"],
    [300317, "update_cardkit", "primary-main", "stale_main_card"],
    [300309, "stream_card_content", "primary-answer", "closed_answer_stream"]
  ] as const)("derives recovery for Feishu code %s on its exact operation", (providerCode, operation, purpose, recoveryKind) => {
    const error = { response: { status: 400, data: { code: providerCode } } };
    expect(classifyFeishuFailure(error, viewIntent(purpose), operation)).toMatchObject({ failureClass: "permanent", effectCertainty: "rejected", recoveryKind, providerOperation: operation });
  });

  it.each([
    [230099, "reply_card", "primary-main"],
    [230099, "update_card", "worker-main"],
    [300317, "update_card", "primary-main"],
    [300317, "update_cardkit", "primary-answer"],
    [300309, "stream_card_content", "worker-turn"],
    [300309, "finish_streaming_card", "primary-answer"]
  ] as const)("does not derive recovery for Feishu code %s on a different operation or purpose", (providerCode, operation, purpose) => {
    const error = { response: { status: 400, data: { code: providerCode } } };
    const classified = classifyFeishuFailure(error, viewIntent(purpose), operation);
    expect(classified).toMatchObject({ failureClass: "permanent", effectCertainty: "rejected", providerOperation: operation });
    expect(classified.recoveryKind).toBeUndefined();
  });

  it.each([
    ["7200", 3_600_000],
    ["-1", undefined],
    ["not-a-date", undefined]
  ] as const)("bounds HTTP 429 Retry-After %s", (header, retryDelayMs) => {
    const error = { response: { status: 429, headers: { "retry-after": header } } };
    const classified = classifyFeishuFailure(error, viewIntent(), "reply_card", Date.parse("2026-09-12T00:00:00.000Z"));
    expect(classified).toMatchObject({ failureClass: "transient", effectCertainty: "rejected", httpStatus: 429 });
    expect(classified.retryAfterMs).toBe(retryDelayMs);
  });
});
