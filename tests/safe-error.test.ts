import { describe, expect, it } from "vitest";
import { safeLogError } from "../src/runtime/safe-error.js";

describe("safeLogError", () => {
  it("keeps bounded diagnostic fields and drops Axios request and response data", () => {
    const error = Object.assign(new Error("Request failed with status code 400"), {
      code: "ERR_BAD_REQUEST",
      config: { headers: { Authorization: "Bearer top-secret" }, data: "private card payload" },
      request: { _header: "Authorization: Bearer top-secret" },
      response: {
        status: 400,
        headers: { "set-cookie": "private-cookie" },
        data: { code: 230099, msg: "card action is lock", error: { log_id: "lark-request-1" }, private: "response body" }
      }
    });

    const safe = safeLogError(error);

    expect(safe).toEqual({
      name: "Error", message: "Request failed with status code 400", code: "ERR_BAD_REQUEST",
      status: 400, larkCode: 230099, requestId: "lark-request-1"
    });
    expect(JSON.stringify(safe)).not.toMatch(/top-secret|private card payload|private-cookie|response body|Authorization/);
  });

  it("redacts credentials embedded in a bounded error message", () => {
    const safe = safeLogError(new Error("failed Bearer token-value at /x?access_token=query-secret&next=1"));
    expect(safe.message).toBe("failed Bearer [REDACTED] at /x?access_token=[REDACTED]&next=1");
  });

  it.each([
    ["Authorization Basic", "Authorization: Basic dXNlcjpwYXNz", "Authorization: Basic [REDACTED]"],
    ["assignment API key", "API_KEY=super-secret", "API_KEY=[REDACTED]"],
    ["assignment password", "password='hunter2'", "password=[REDACTED]"],
    ["JSON secret", '{"client_secret":"json-secret"}', '{"client_secret":"[REDACTED]"}'],
    ["header API key", "X-API-Key: header-secret", "X-API-Key: [REDACTED]"],
    ["private key", ["-----BEGIN", " PRIVATE KEY-----", "\nsecret-material\n-----END", " PRIVATE KEY-----"].join(""), "[REDACTED PRIVATE KEY]"]
  ])("redacts %s", (_label, source, expected) => {
    const safe = safeLogError(new Error(source));
    expect(safe.message).toContain(expected);
    expect(safe.message).not.toMatch(/dXNlcjpwYXNz|super-secret|hunter2|json-secret|header-secret|secret-material/);
  });

  it("preserves the safe shape when a logger serializer applies it again", () => {
    const safe = { name: "Error", message: "request failed", code: "ERR_BAD_REQUEST", status: 400, larkCode: 230099, requestId: "request-1" };
    expect(safeLogError(safe)).toEqual(safe);
  });
});
