import { describe, expect, it } from "vitest";
import { appendTurnOutput, createBoundedTurnOutput, MAX_TURN_OUTPUT_CHARS, TURN_OUTPUT_TRUNCATION_MARKER } from "../src/runtime/bounded-turn-output.js";

describe("bounded turn output", () => {
  it("preserves fragment order and separators below the limit", () => {
    let output = createBoundedTurnOutput();
    output = appendTurnOutput(output, "first");
    output = appendTurnOutput(output, "second");
    output = appendTurnOutput(output, "");
    expect(output).toEqual({ text: "first\n\nsecond", truncated: false });
  });

  it("stays within the aggregate limit and becomes stable after truncation", () => {
    let output = createBoundedTurnOutput();
    for (let index = 0; index < 2_000; index += 1) output = appendTurnOutput(output, "x".repeat(1_024));
    expect(output.text).toHaveLength(MAX_TURN_OUTPUT_CHARS);
    expect(output.text.endsWith(TURN_OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(output.truncated).toBe(true);
    expect(appendTurnOutput(output, "later")).toBe(output);
  });

  it("uses the entire limit without a marker when content fits exactly", () => {
    const output = appendTurnOutput(createBoundedTurnOutput(), "x".repeat(MAX_TURN_OUTPUT_CHARS));
    expect(output).toEqual({ text: "x".repeat(MAX_TURN_OUTPUT_CHARS), truncated: false });
  });

  it("preserves persisted legacy and current truncation fences", () => {
    const legacy = `${"x".repeat(64 * 1024 - TURN_OUTPUT_TRUNCATION_MARKER.length)}${TURN_OUTPUT_TRUNCATION_MARKER}`;
    const current = `${"x".repeat(MAX_TURN_OUTPUT_CHARS - TURN_OUTPUT_TRUNCATION_MARKER.length)}${TURN_OUTPUT_TRUNCATION_MARKER}`;

    expect(createBoundedTurnOutput(legacy)).toEqual({ text: legacy, truncated: true });
    expect(createBoundedTurnOutput(current)).toEqual({ text: current, truncated: true });
  });
});
