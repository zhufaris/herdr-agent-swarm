import { describe, expect, it } from "vitest";
import { contentIdempotencyKey } from "../src/runtime/idempotency-key.js";

describe("content idempotency keys", () => {
  it("uses fixed-size deterministic material without embedding rendered content", () => {
    const first = contentIdempotencyKey("reply:message", { content: "x".repeat(100_000) });
    expect(first).toHaveLength("reply:message:".length + 64);
    expect(first).toBe(contentIdempotencyKey("reply:message", { content: "x".repeat(100_000) }));
    expect(first).not.toBe(contentIdempotencyKey("reply:message", { content: "changed" }));
    expect(first).not.toContain("xxx");
  });
});
