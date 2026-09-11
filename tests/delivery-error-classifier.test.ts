import { describe, expect, it } from "vitest";
import { classifyDeliveryError } from "../src/events/delivery-error-classifier.js";
import { PermanentDeliveryError } from "../src/events/outbound-target-validation.js";

describe("delivery error classifier", () => {
  it.each([
    [{ response: { status: 429, headers: { "retry-after": "7" } } }, { failureClass: "transient", httpStatus: 429, retryDelayMs: 7_000 }],
    [{ response: { status: 503 } }, { failureClass: "transient", httpStatus: 503 }],
    [Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), { failureClass: "transient" }],
    [Object.assign(new Error("request timeout"), { code: "ERR_BAD_REQUEST" }), { failureClass: "transient" }],
    [{ response: { status: 400, data: { code: 200740 } } }, { failureClass: "permanent", httpStatus: 400, larkErrorCode: "200740" }],
    [{ response: { status: 400, data: { code: 300309 } } }, { failureClass: "permanent", larkErrorCode: "300309", recoveryKind: "closed_answer_stream" }],
    [{ response: { status: 400, data: { code: 300317 } } }, { failureClass: "permanent", larkErrorCode: "300317", recoveryKind: "stale_main_card" }],
    [{ response: { status: 400, data: { code: 230099 } } }, { failureClass: "unknown", httpStatus: 400, larkErrorCode: "230099" }]
  ])("classifies structured failures conservatively", (error, expected) => {
    expect(classifyDeliveryError(error)).toMatchObject(expected);
  });

  it("classifies local durable target rejection as permanent", () => {
    expect(classifyDeliveryError(new PermanentDeliveryError("stale target"))).toMatchObject({ failureClass: "permanent" });
  });
});
