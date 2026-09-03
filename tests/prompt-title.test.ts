import { describe, expect, it } from "vitest";
import { formatPromptTitle } from "../src/domain/prompt-title.js";

describe("prompt title", () => {
  it("normalizes whitespace and provides an empty fallback", () => {
    expect(formatPromptTitle("  inspect\n  queue \t state  " )).toBe("inspect queue state");
    expect(formatPromptTitle(" \n\t " )).toBe("TraeX request");
  });

  it("preserves an exact-length title and truncates longer input with an ellipsis", () => {
    const exact = "a".repeat(64);
    const longer = "b".repeat(65);
    expect(formatPromptTitle(exact)).toBe(exact);
    expect(formatPromptTitle(longer)).toBe("b".repeat(63) + "…");
  });
});
