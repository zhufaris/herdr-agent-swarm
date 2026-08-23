import { describe, expect, it } from "vitest";
import { splitAnswerStreamPage } from "../src/runtime/answer-stream.js";

describe("Answer stream pagination", () => {
  it("keeps short content on one card", () => {
    expect(splitAnswerStreamPage("Working\nDone", 28_000)).toEqual({ page: "Working\nDone", remainder: "" });
  });

  it("splits at the latest newline before the CardKit limit without losing text", () => {
    const content = `${"a".repeat(20_000)}\n${"b".repeat(12_000)}`;
    const result = splitAnswerStreamPage(content, 28_000);
    expect(result.page).toBe("a".repeat(20_000));
    expect(result.remainder).toBe("b".repeat(12_000));
    expect(`${result.page}\n${result.remainder}`).toBe(content);
  });

  it("uses a hard boundary when no newline is available", () => {
    const content = "x".repeat(30_000);
    const result = splitAnswerStreamPage(content, 28_000);
    expect(result.page).toHaveLength(28_000);
    expect(result.remainder).toHaveLength(2_000);
    expect(result.page + result.remainder).toBe(content);
  });
});
