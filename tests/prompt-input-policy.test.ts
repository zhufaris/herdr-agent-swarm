import { describe, expect, it } from "vitest";
import { assertPromptInputSize, isPromptInputTooLarge, MAX_PROMPT_INPUT_BYTES, MAX_PROMPT_INPUT_CHARS, PromptInputTooLargeError } from "../src/domain/prompt-input-policy.js";

describe("prompt input policy", () => {
  it("accepts the character boundary and rejects the next character", () => {
    expect(isPromptInputTooLarge("x".repeat(MAX_PROMPT_INPUT_CHARS))).toBe(false);
    expect(isPromptInputTooLarge("x".repeat(MAX_PROMPT_INPUT_CHARS + 1))).toBe(true);
  });

  it("enforces the UTF-8 byte boundary independently", () => {
    const within = "界".repeat(Math.floor(MAX_PROMPT_INPUT_BYTES / 3));
    const oversized = "界".repeat(Math.floor(MAX_PROMPT_INPUT_BYTES / 3) + 1);
    expect(within.length).toBeLessThanOrEqual(MAX_PROMPT_INPUT_CHARS);
    expect(oversized.length).toBeLessThanOrEqual(MAX_PROMPT_INPUT_CHARS);
    expect(isPromptInputTooLarge(within)).toBe(false);
    expect(isPromptInputTooLarge(oversized)).toBe(true);
  });

  it("raises a typed policy error with a stable code", () => {
    expect(() => assertPromptInputSize("x".repeat(MAX_PROMPT_INPUT_CHARS + 1))).toThrow(expect.objectContaining({ name: "PromptInputTooLargeError", code: "prompt_input_too_large" }));
    expect(new PromptInputTooLargeError().code).toBe("prompt_input_too_large");
  });
});
