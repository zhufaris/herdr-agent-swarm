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

  it("omits Command progress when a wrapped tool call has no extractable target", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("history_mutation", { operation: "append", items: [{
          type: "function_call", id: "opaque-command", call_id: "opaque-command-call", name: "exec",
          arguments: JSON.stringify({ input: "const results = await Promise.all(ids.map(run)); results.forEach(text);" })
        }] }),
        line("history_mutation", { operation: "append", items: [{
          type: "function_call_output", id: "opaque-command-result", call_id: "opaque-command-call", output: "Script completed"
        }] })
      ],
      initialLifecycle: undefined,
      tokenBaseline: null,
      maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.toolActivities).toBeUndefined();
    expect(JSON.stringify(result.observation)).not.toContain("未提供目标");
  });

  it("keeps item deduplication scoped to one turn", () => {
    const projector = new TraexTranscriptProjector();
    const assistant = (text: string) => line("history_mutation", { operation: "append", items: [
      { type: "message", id: "reused-item", role: "assistant", content: [{ type: "output_text", text }] }
    ] });
    const project = (lines: string[], initialLifecycle?: { turnId: string; state: "active"; startedAt: string }) => projector.project({
      lines, initialLifecycle, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    const first = project([
      line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
      assistant("first answer"), assistant("duplicate answer")
    ]);
    const second = project([
      line("event_msg", { type: "task_started", turn_id: "turn-2", started_at: 1_788_035_320 }),
      assistant("second answer")
    ], first.lifecycle as { turnId: string; state: "active"; startedAt: string });

    expect(first.observation.answerDelta).toBe("first answer");
    expect(second.observation.answerDelta).toBe("second answer");
  });
});
