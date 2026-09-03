import { describe, expect, it } from "vitest";
import { TraexTranscriptProjector } from "../src/runtime/traex-transcript-projector.js";

function line(type: string, payload: unknown): string {
  return JSON.stringify({ type, payload });
}

describe("TraexTranscriptProjector", () => {
  it("projects only safe assistant output from already bounded JSONL lines", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [line("history_mutation", { operation: "append", items: [
        { type: "message", id: "assistant-1", role: "assistant", content: [{ type: "output_text", text: "Bearer secret-token public result" }] },
        { type: "message", id: "developer-1", role: "developer", content: [{ type: "output_text", text: "private instruction" }] }
      ] })],
      initialLifecycle: undefined,
      tokenBaseline: null,
      maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.answerDelta).toContain("public result");
    expect(result.observation.answerDelta).not.toContain("secret-token");
    expect(result.observation.answerDelta).not.toContain("private instruction");
    expect(result.lifecycle).toBeUndefined();
  });
});
