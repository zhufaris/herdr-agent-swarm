import { describe, expect, it } from "vitest";
import { MAX_TURN_OUTPUT_CHARS, TURN_OUTPUT_TRUNCATION_MARKER } from "../src/runtime/bounded-turn-output.js";
import { TraexTranscriptProjector } from "../src/runtime/traex-transcript-projector.js";

function line(type: string, payload: unknown): string {
  return JSON.stringify({ type, payload });
}

describe("TraexTranscriptProjector", () => {
  it("projects complete reasoning text under a stable Answer timeline title", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "reasoning", id: "reasoning-1", content: [{ type: "reasoning_text", text: "**Inspecting timeline alignment**\n\nPrivate chain of thought" }] },
          { type: "reasoning", id: "reasoning-2", content: [{ type: "reasoning_text", text: "unstructured private reasoning" }] }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.timelineDeltas).toEqual([
      { kind: "thinking", id: "thinking:reasoning-1", sequence: 1, label: "Inspecting timeline alignment", markdown: "**Inspecting timeline alignment**\n\nPrivate chain of thought" },
      { kind: "thinking", id: "thinking:reasoning-2", sequence: 2, label: "思考", markdown: "unstructured private reasoning" }
    ]);
    expect(JSON.stringify(result.observation)).toContain("Private chain of thought");
    expect(JSON.stringify(result.observation)).toContain("unstructured private reasoning");
  });

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
      { kind: "tool", id: "tool:call-1", sequence: 2, category: "test", label: "Test · project", action: "Test", target: "npm test", command: "npm test", state: "running" },
      { kind: "tool", id: "tool:call-1", sequence: 2, category: "test", label: "Test · project", action: "Test", target: "npm test", command: "npm test", result: expect.stringContaining("2 tests passed"), resultSummary: { outcome: "success", text: expect.stringContaining("2 tests passed") }, state: "succeeded" },
      { kind: "agent_message", id: "message:assistant-after", sequence: 3, markdown: "Tests are green" },
      { kind: "final_answer", id: "final:turn-1", sequence: 4, markdown: "Final answer" }
    ]);
    expect(result.observation.answerDelta).toBe("Inspecting files\n\nTests are green");
    expect(result.observation.answerDelta).not.toContain("◆ **Ran**");
    expect(result.observation.answerDelta).not.toContain("2 tests passed");
  });

  it("keeps a protocol-only same-trace continuation out of Feishu-visible output", () => {
    const protocol = ["```herdr-choice-list", JSON.stringify({ version: 1, default: "one", options: [
      { id: "one", label: "One", message: "default" }, { id: "two", label: "Two", message: "2" }
    ] }), "```"].join("\n");
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-choice", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "message", id: "answer", role: "assistant", content: [{ type: "output_text", text: "Choose one." }] },
          { type: "message", id: "protocol", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: protocol }] }
        ] }),
        line("event_msg", { type: "task_complete", turn_id: "turn-choice", started_at: 1_788_035_304, last_agent_message: protocol })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 10_000
    });

    expect(result.observation.answerDelta).toBe("Choose one.");
    expect(result.observation.timelineDeltas).toEqual([
      { kind: "agent_message", id: "message:answer", sequence: 1, markdown: "Choose one." }
    ]);
    expect(result.lifecycle).toMatchObject({ state: "completed", finalAnswer: protocol });
    expect(JSON.stringify({ answerDelta: result.observation.answerDelta, timelineDeltas: result.observation.timelineDeltas })).not.toContain("herdr-choice-list");
  });

  it("strips invalid and nonterminal reserved regions while preserving ordinary fences", () => {
    const output = [
      "Before",
      "```json\n{\"kept\":true}\n```",
      "```herdr-choice-list\n{bad}\n```",
      "After"
    ].join("\n\n");
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-choice", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "message", id: "answer", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: output }] }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 10_000
    });

    expect(result.observation.answerDelta).toBe("Before\n\n```json\n{\"kept\":true}\n```\n\nAfter");
    expect(JSON.stringify(result.observation)).not.toContain("herdr-choice-list");
  });

  it("projects an apply_patch body as Edit diff detail", () => {
    const input = [
      'const patch = "*** Begin Patch\\n*** Update File: /repo/src/main.ts\\n@@\\n-old\\n+new\\n*** End Patch";',
      "text(await tools.apply_patch(patch));"
    ].join(" ");
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
        { type: "function_call", id: "edit-call", call_id: "edit-1", name: "exec", arguments: JSON.stringify({ input }) },
        { type: "function_call_output", id: "edit-result", call_id: "edit-1", output: "{}" }
        ] })
      ],
      initialLifecycle: undefined,
      tokenBaseline: null,
      maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.timelineDeltas).toEqual([
      expect.objectContaining({
        kind: "tool", id: "tool:edit-1", category: "edit", state: "running",
        diff: "*** Update File: /repo/src/main.ts\n@@\n-old\n+new"
      }),
      expect.objectContaining({
        kind: "tool", id: "tool:edit-1", category: "edit", state: "succeeded",
        diff: "*** Update File: /repo/src/main.ts\n@@\n-old\n+new"
      })
    ]);
  });

  it("renders only subsequent exact-turn human messages, not the initial request", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "message", id: "initial-request", role: "user", content: [{ type: "input_text", text: "Initial Feishu prompt" }] },
          { type: "message", id: "assistant", role: "assistant", content: [{ type: "output_text", text: "Working" }] },
          { type: "message", id: "local-follow-up", role: "user", content: [{ type: "input_text", text: "Continue from the Herdr pane" }] }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.requestText).toBe("Initial Feishu prompt");
    expect(result.observation.timelineDeltas).toEqual([
      { kind: "agent_message", id: "message:assistant", sequence: 1, markdown: "Working" },
      { kind: "human_message", id: "human:local-follow-up", sequence: 2, markdown: "Continue from the Herdr pane" }
    ]);
  });

  it("projects subsequent event-message human follow-ups within an owned turn", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("event_msg", { type: "user_message", message: "Initial Feishu prompt" }),
        line("event_msg", { type: "user_message", message: "Resume the current goal" })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.requestText).toBe("Initial Feishu prompt");
    expect(result.observation.timelineDeltas).toEqual([
      { kind: "human_message", id: "human:event:turn-1:0", sequence: 1, markdown: "Resume the current goal" }
    ]);
  });

  it("keeps a wrapped exec command when its result arrives", () => {
    const input = 'const result = await tools.exec_command({ cmd: "sqlite3 bridge.db SELECT-1" }); text(result.output);';
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "function_call", id: "wrapper", call_id: "wrapper-call", name: "functions.exec", arguments: JSON.stringify({ input }) },
          { type: "function_call_output", id: "wrapper-output", call_id: "wrapper-call", output: JSON.stringify({ exit_code: 0, output: "one row" }) }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "tool", category: "command", command: expect.stringContaining("sqlite3 bridge.db"), state: "running" }),
      expect.objectContaining({ kind: "tool", category: "command", command: expect.stringContaining("sqlite3 bridge.db"), result: "one row", state: "succeeded" })
    ]);
  });

  it("projects internal Wait into status activity and the Answer timeline", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "function_call", id: "wait-call", call_id: "wait-1", name: "write_stdin", arguments: JSON.stringify({ session_id: 42 }) },
          { type: "function_call_output", id: "wait-running", call_id: "wait-1", output: JSON.stringify({ session_id: 42, output: "still running" }) },
          { type: "function_call_output", id: "wait-done", call_id: "wait-1", output: JSON.stringify({ exit_code: 0, output: "complete" }) }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.toolActivities).toEqual([
      { key: "wait:session 42", kind: "tool", label: "Wait · session 42", state: "active" },
      { key: "wait:session 42", kind: "tool", label: "Wait · session 42", state: "active" },
      { key: "wait:session 42", kind: "tool", label: "Wait · session 42", state: "done" }
    ]);
    expect(result.observation.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "tool", id: "tool:wait-1", category: "step", label: "Wait · session 42", sequence: 1, state: "running" }),
      expect.objectContaining({ kind: "tool", id: "tool:wait-1", category: "step", label: "Wait · session 42", sequence: 1, result: "still running", state: "running" }),
      expect.objectContaining({ kind: "tool", id: "tool:wait-1", category: "step", label: "Wait · session 42", sequence: 1, result: "complete", state: "succeeded" })
    ]);
  });

  it("uses the active plan only as context for visible tools", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "function_call", id: "plan", call_id: "plan-1", name: "update_plan", arguments: JSON.stringify({ plan: [
            { step: "Inspect transcript", status: "completed" },
            { step: "Validate rendering", status: "in_progress" }
          ] }) },
          { type: "function_call", id: "command", call_id: "command-1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) },
          { type: "function_call_output", id: "command-result", call_id: "command-1", output: JSON.stringify({ exit_code: 0, output: "passed" }) }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.mainStatus?.planSteps).toEqual([
      { key: "plan:0", label: "Inspect transcript", state: "done" },
      { key: "plan:1", label: "Validate rendering", state: "active" }
    ]);
    expect(result.observation.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "tool", category: "test", context: "Validate rendering", state: "running" }),
      expect.objectContaining({ kind: "tool", category: "test", context: "Validate rendering", result: "passed", state: "succeeded" })
    ]);
    expect(result.observation.toolActivities).toEqual([
      { key: "tool:command-1", kind: "test", label: "Command · npm test", state: "active" },
      { key: "tool:command-1", kind: "test", label: "Command · npm test", state: "done" }
    ]);
    expect(JSON.stringify(result.observation.timelineDeltas)).not.toContain("update_plan");
  });

  it("suppresses empty plan updates instead of projecting a generic Tool", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "function_call", id: "plan", call_id: "plan-1", name: "update_plan", arguments: JSON.stringify({ plan: [] }) },
          { type: "function_call", id: "wrapped-plan", call_id: "plan-2", name: "exec", arguments: JSON.stringify({ input: "await tools.update_plan({ plan: [] });" }) }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.mainStatus).toBeUndefined();
    expect(result.observation.toolActivities).toBeUndefined();
    expect(result.observation.timelineDeltas).toBeUndefined();
  });

  it("keeps a command on a Step fallback without changing its category", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "function_call", id: "call", call_id: "call-1", name: "exec_command", arguments: JSON.stringify({ cmd: "git status --short" }) },
          { type: "function_call_output", id: "result", call_id: "call-1", output: JSON.stringify({ exit_code: 0, output: "clean" }) }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.timelineDeltas).toEqual([
      expect.objectContaining({ kind: "tool", category: "command", command: "git status --short", state: "running" }),
      expect.objectContaining({ kind: "tool", category: "command", command: "git status --short", result: "clean", state: "succeeded" })
    ]);
  });

  it("keeps successful and failed tool results only in stable timeline items", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "function_call", id: "success-call", call_id: "success-1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) },
          { type: "function_call_output", id: "success-result", call_id: "success-1", output: JSON.stringify({ exit_code: 0, output: "all tests passed" }) },
          { type: "function_call", id: "failed-call", call_id: "failed-1", name: "exec_command", arguments: JSON.stringify({ cmd: "npm run build" }) },
          { type: "function_call_output", id: "failed-result", call_id: "failed-1", output: JSON.stringify({ exit_code: 2, output: "compile failed" }) }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.answerDelta).toBe("");
    expect(result.observation.timelineDeltas).toEqual([
      { kind: "tool", id: "tool:success-1", sequence: 1, category: "test", label: "Test · project", action: "Test", target: "npm test", command: "npm test", state: "running" },
      { kind: "tool", id: "tool:success-1", sequence: 1, category: "test", label: "Test · project", action: "Test", target: "npm test", command: "npm test", result: expect.stringContaining("all tests passed"), resultSummary: { outcome: "success", text: expect.stringContaining("all tests passed") }, state: "succeeded" },
      { kind: "tool", id: "tool:failed-1", sequence: 2, category: "command", label: "Build · project", action: "Build", target: "npm run build", command: "npm run build", state: "running" },
      { kind: "tool", id: "tool:failed-1", sequence: 2, category: "command", label: "Build · project", action: "Build", target: "npm run build", command: "npm run build", result: expect.stringContaining("compile failed"), resultSummary: { outcome: "failure", text: expect.stringContaining("compile failed") }, state: "failed" }
    ]);
  });

  it("does not apply the prose render bound to safe Tool result content", () => {
    const output = "safe-output-".repeat(500);
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "function_call", id: "call", call_id: "call-1", name: "exec_command", arguments: JSON.stringify({ cmd: "build" }) },
          { type: "function_call_output", id: "result", call_id: "call-1", output }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 100
    });
    expect(result.observation.timelineDeltas?.at(-1)).toMatchObject({ result: output });
  });

  it("removes the execution wrapper before storing the canonical Tool result", () => {
    const output = "Script completed\nWall time 0.4 seconds\nOutput:\nfirst\nsecond";
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "function_call", id: "call", call_id: "call-1", name: "exec_command", arguments: JSON.stringify({ cmd: "build" }) },
          { type: "function_call_output", id: "result", call_id: "call-1", output }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.timelineDeltas?.at(-1)).toMatchObject({ result: "first\nsecond" });
  });

  it("marks Tool result truncation at the durable safety bound", () => {
    const output = "x".repeat(MAX_TURN_OUTPUT_CHARS + 100);
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "function_call", id: "call", call_id: "call-1", name: "exec_command", arguments: JSON.stringify({ cmd: "build" }) },
          { type: "function_call_output", id: "result", call_id: "call-1", output }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 100
    });
    const projected = result.observation.timelineDeltas?.at(-1);
    expect(projected).toMatchObject({ kind: "tool" });
    if (!projected || projected.kind !== "tool") return;
    expect(projected.result).toHaveLength(MAX_TURN_OUTPUT_CHARS);
    expect(projected.result?.endsWith(TURN_OUTPUT_TRUNCATION_MARKER)).toBe(true);
  });

  it("keeps completed command-execution events out of the Answer", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("event_msg", {
          type: "item_completed", turn_id: "turn-1",
          item: { type: "CommandExecution", id: "command-1", command: ["/bin/bash", "-lc", "npm test"], status: "completed", exit_code: 0 }
        })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.answerDelta).toBe("");
    expect(result.observation.timelineDeltas).toEqual([
      { kind: "tool", id: "tool:command-1", sequence: 1, category: "test", label: "Test · project", action: "Test", target: "npm test", command: "npm test", state: "succeeded" }
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

  it("uses Assistant phases without duplicating an explicit final answer", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "message", id: "commentary", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking the implementation" }] },
          { type: "message", id: "final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Complete answer with citation" }] }
        ] }),
        line("event_msg", { type: "task_complete", turn_id: "turn-1", started_at: 1_788_035_304, last_agent_message: "Complete answer" })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.timelineDeltas).toEqual([
      { kind: "agent_message", id: "message:commentary", sequence: 1, markdown: "Checking the implementation" },
      { kind: "final_answer", id: "message:final", sequence: 2, markdown: "Complete answer with citation" }
    ]);
    expect(result.observation.timelineDeltas?.filter(({ kind }) => kind === "final_answer")).toHaveLength(1);
  });

  it("preserves structurally recognized Skill identity in the timeline", () => {
    const result = new TraexTranscriptProjector().project({
      lines: [
        line("event_msg", { type: "task_started", turn_id: "turn-1", started_at: 1_788_035_304 }),
        line("history_mutation", { operation: "append", items: [
          { type: "function_call", id: "skill-call", call_id: "skill-1", name: "exec_command", arguments: JSON.stringify({ cmd: "sed -n '1,200p' /tmp/data00/" + "home/alice/.trae/skills/herdr/SKILL.md" }) },
          { type: "function_call_output", id: "skill-result", call_id: "skill-1", output: "large private skill instructions" }
        ] })
      ],
      initialLifecycle: undefined, tokenBaseline: null, maxRenderedDeltaChars: 1_000
    });

    expect(result.observation.timelineDeltas).toEqual([
      { kind: "tool", id: "tool:skill-1", sequence: 1, category: "skill", label: "herdr", action: "Skill", target: "herdr", state: "running" },
      { kind: "tool", id: "tool:skill-1", sequence: 1, category: "skill", label: "herdr", action: "Skill", target: "herdr", state: "succeeded" }
    ]);
    expect(JSON.stringify(result.observation.timelineDeltas)).not.toContain("large private skill instructions");
  });
});
