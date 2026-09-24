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

  it("projects Agent and Tool items in canonical terminal order", () => {
    const projector = new TraexTranscriptProjector();
    const result = projector.project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "message", id: "assistant-before", role: "assistant", content: [{ type: "output_text", text: "Inspecting files" }] },
          { type: "function_call", id: "call-item", call_id: "call-1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) },
          { type: "function_call_output", id: "result-item", call_id: "call-1", output: JSON.stringify({ exit_code: 0, output: "2 tests passed" }) },
          { type: "message", id: "assistant-after", role: "assistant", content: [{ type: "output_text", text: "Tests are green" }] }
        ] }),
        line("event_msg", { type: "task_complete", turn_id: "turn-1", started_at: 1_788_035_304, last_agent_message: "Final answer" })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.timelineDeltas).toEqual([
      { kind: "agent_message", id: "message:assistant-before", sequence: 1, markdown: "Inspecting files" },
      { kind: "tool", id: "tool:call-1", sequence: 2, category: "test", label: "npm test", command: "npm test", state: "running" },
      { kind: "tool", id: "tool:call-1", sequence: 2, category: "test", label: "npm test", command: "npm test", resultPreview: expect.stringContaining("2 tests passed"), state: "succeeded" },
      { kind: "agent_message", id: "message:assistant-after", sequence: 3, markdown: "Tests are green" },
      { kind: "final_answer", id: "final:turn-1", sequence: 4, markdown: "Final answer" }
    ]);
  });

  it("keeps timeline identities stable and excludes reasoning, ANSI, and secrets", () => {
    const projector = new TraexTranscriptProjector();
    const project = (lines: string[]) => projector.project({ lines, initialLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-09-24T00:00:00.000Z" }, tokenBaseline: null, maxRenderedDeltaChars: 1_000 });
    const first = project([
      line("event_msg", { type: "agent_reasoning_raw_content", text: "private chain of thought" }),
      line("history_mutation", { operation: "append", items: [
        { type: "message", id: "assistant-safe", role: "assistant", content: [{ type: "output_text", text: "\u001b[31mResult token=secret-value\u001b[0m" }] },
        { type: "function_call", id: "read-item", call_id: "read-1", name: "read_file", arguments: JSON.stringify({ path: "/tmp/data", api_key: "hidden" }) }
      ] })
    ]);
    const duplicate = project([line("history_mutation", { operation: "append", items: [
      { type: "message", id: "assistant-safe", role: "assistant", content: [{ type: "output_text", text: "duplicate" }] },
      { type: "function_call", id: "read-item", call_id: "read-1", name: "read_file", arguments: JSON.stringify({ path: "/tmp/data" }) }
    ] })]);

    expect(JSON.stringify(first.observation.timelineDeltas)).not.toContain("chain of thought");
    expect(JSON.stringify(first.observation.timelineDeltas)).not.toContain("secret-value");
    expect(JSON.stringify(first.observation.timelineDeltas)).not.toContain("\u001b");
    expect(first.observation.timelineDeltas?.map((item) => item.id)).toEqual(["message:assistant-safe", "tool:read-1"]);
    expect(duplicate.observation.timelineDeltas).toBeUndefined();
  });

  it("emits a final answer only from the matching completion event", () => {
    const projector = new TraexTranscriptProjector();
    const completed = projector.project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("event_msg", { type: "task_complete", turn_id: "turn-1", started_at: 1_788_035_304, last_agent_message: "Final answer" })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });
    const laterStatus = projector.project({
      lines: [line("event_msg", { type: "token_count", info: { total_token_usage: { total_tokens: 200 } } })],
      initialLifecycle: completed.lifecycle, tokenBaseline: 100, maxRenderedDeltaChars: 1_000
    });

    expect(completed.observation.timelineDeltas).toEqual([
      { kind: "final_answer", id: "final:turn-1", sequence: 1, markdown: "Final answer" }
    ]);
    expect(laterStatus.observation.timelineDeltas).toBeUndefined();
  });
});
