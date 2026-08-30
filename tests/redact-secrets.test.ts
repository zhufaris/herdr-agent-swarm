import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/runtime/redact-secrets.js";

describe("redactSecrets", () => {
  it.each([
    ["TOKEN: token-value", "TOKEN: [REDACTED]"],
    ["password: password-value", "password: [REDACTED]"],
    ["api_key: api-value", "api_key: [REDACTED]"],
    ["client_secret: client-value", "client_secret: [REDACTED]"],
    ["TOKEN=token-value", "TOKEN=[REDACTED]"],
    ["Authorization=Basic basic-value", "Authorization=Basic [REDACTED]"],
    ["Authorization=Bearer bearer-value", "Authorization=Bearer [REDACTED]"]
  ])("redacts generic assignment %s", (source, expected) => {
    expect(redactSecrets(source)).toBe(expected);
  });

  it("retains JSON, header, and query delimiters while redacting values", () => {
    const source = '{"client_secret":"json-value"}\nX-API-Key: header-value\n/path?token=query-value&next=1';
    expect(redactSecrets(source)).toBe('{"client_secret":"[REDACTED]"}\nX-API-Key: [REDACTED]\n/path?token=[REDACTED]&next=1');
  });
});
