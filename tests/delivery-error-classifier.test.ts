import { describe, expect, it } from "vitest";
import { classifyDeliveryError } from "../src/events/delivery-error-classifier.js";
import { DeliveryOperationError } from "../src/events/delivery-operation-error.js";
import { PermanentDeliveryError } from "../src/events/outbound-target-validation.js";

describe("delivery error classifier", () => {
  it.each([
    [{ response: { status: 429, headers: { "retry-after": "7" } } }, { failureClass: "transient", effectCertainty: "rejected", httpStatus: 429, retryDelayMs: 7_000 }],
    [{ response: { status: 503 } }, { failureClass: "transient", effectCertainty: "rejected", httpStatus: 503 }],
    [Object.assign(new Error("DNS lookup failed"), { code: "ENOTFOUND" }), { failureClass: "transient", effectCertainty: "not-started" }],
    [Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }), { failureClass: "transient", effectCertainty: "not-started" }],
    [Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }), { failureClass: "transient", effectCertainty: "not-started" }],
    [Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), { failureClass: "unknown", effectCertainty: "uncertain" }],
    [Object.assign(new Error("request timeout"), { code: "ETIMEDOUT" }), { failureClass: "unknown", effectCertainty: "uncertain" }],
    [Object.assign(new Error("headers timeout"), { code: "UND_ERR_HEADERS_TIMEOUT" }), { failureClass: "unknown", effectCertainty: "uncertain" }],
    [{ response: { status: 400, data: { code: 200740 } } }, { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "200740" }],
    [{ response: { status: 400, data: { code: 230028 } } }, { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230028" }],
    [{ response: { status: 400, data: { code: 300309 } } }, { failureClass: "permanent", effectCertainty: "rejected", larkErrorCode: "300309" }],
    [{ response: { status: 400, data: { code: 300317 } } }, { failureClass: "permanent", effectCertainty: "rejected", larkErrorCode: "300317" }],
    [{ response: { status: 400, data: { code: 230099 } } }, { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230099" }]
  ])("classifies structured failures conservatively", (error, expected) => {
    expect(classifyDeliveryError(error)).toMatchObject(expected);
  });

  it("classifies local durable target rejection as permanent", () => {
    expect(classifyDeliveryError(new PermanentDeliveryError("stale target"))).toMatchObject({ failureClass: "permanent", effectCertainty: "rejected" });
  });

  it.each([
    [230099, { operation: "update_card", target: "primary_main" }, "stale_main_card"],
    [230099, { operation: "update_cardkit", target: "primary_main" }, "stale_main_card"],
    [300317, { operation: "update_cardkit", target: "primary_main" }, "stale_main_card"],
    [300309, { operation: "stream_card_content", target: "primary_answer" }, "closed_answer_stream"]
  ] as const)("derives recovery for Lark code %s on its exact operation", (larkCode, context, recoveryKind) => {
    const error = { response: { status: 400, data: { code: larkCode } } };
    expect(classifyDeliveryError(error, context)).toMatchObject({ failureClass: "permanent", effectCertainty: "rejected", recoveryKind, operationContext: context });
  });

  it.each([
    [230099, { operation: "reply_card", target: "primary_main" }],
    [230099, { operation: "update_card", target: "worker_main" }],
    [300317, { operation: "update_card", target: "primary_main" }],
    [300317, { operation: "update_cardkit", target: "primary_answer" }],
    [300309, { operation: "stream_card_content", target: "worker_turn" }],
    [300309, { operation: "finish_streaming_card", target: "primary_answer" }]
  ] as const)("does not derive recovery for Lark code %s on a different operation or target", (larkCode, context) => {
    const error = { response: { status: 400, data: { code: larkCode } } };
    const classified = classifyDeliveryError(error, context);
    expect(classified).toMatchObject({ failureClass: "permanent", effectCertainty: "rejected", operationContext: context });
    expect(classified.recoveryKind).toBeUndefined();
  });

  it("unwraps an operation error without weakening uncertain transport classification", () => {
    const context = { operation: "reply_streaming_card_reference", target: "primary_answer" } as const;
    const error = new DeliveryOperationError(context, Object.assign(new Error("timeout after acceptance"), { code: "ETIMEDOUT" }));
    expect(classifyDeliveryError(error)).toMatchObject({ failureClass: "unknown", effectCertainty: "uncertain", operationContext: context, message: "timeout after acceptance" });
  });

  it.each([
    ["7200", 3_600_000],
    ["-1", undefined],
    ["not-a-date", undefined]
  ] as const)("bounds HTTP 429 Retry-After %s", (header, retryDelayMs) => {
    const error = { response: { status: 429, headers: { "retry-after": header } } };
    const classified = classifyDeliveryError(error, undefined, Date.parse("2026-09-12T00:00:00.000Z"));
    expect(classified).toMatchObject({ failureClass: "transient", effectCertainty: "rejected", httpStatus: 429 });
    expect(classified.retryDelayMs).toBe(retryDelayMs);
  });
});
