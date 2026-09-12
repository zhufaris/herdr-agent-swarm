import { describe, expect, it } from "vitest";
import { classifyDeliveryError } from "../src/events/delivery-error-classifier.js";
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
    [{ response: { status: 400, data: { code: 300309 } } }, { failureClass: "permanent", effectCertainty: "rejected", larkErrorCode: "300309", recoveryKind: "closed_answer_stream" }],
    [{ response: { status: 400, data: { code: 300317 } } }, { failureClass: "permanent", effectCertainty: "rejected", larkErrorCode: "300317", recoveryKind: "stale_main_card" }],
    [{ response: { status: 400, data: { code: 230099 } } }, { failureClass: "unknown", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230099" }]
  ])("classifies structured failures conservatively", (error, expected) => {
    expect(classifyDeliveryError(error)).toMatchObject(expected);
  });

  it("classifies local durable target rejection as permanent", () => {
    expect(classifyDeliveryError(new PermanentDeliveryError("stale target"))).toMatchObject({ failureClass: "permanent", effectCertainty: "rejected" });
  });
});
