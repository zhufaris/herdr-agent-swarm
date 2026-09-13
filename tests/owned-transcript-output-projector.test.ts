import { describe, expect, it } from "vitest";
import { projectOwnedTranscriptOutput } from "../src/coordinator/owned-transcript-output-projector.js";
import { MAX_TURN_OUTPUT_CHARS, TURN_OUTPUT_TRUNCATION_MARKER } from "../src/runtime/bounded-turn-output.js";

describe("owned transcript output projector", () => {
  it("accumulates answer output and retains a completed lifecycle", () => {
    const result = projectOwnedTranscriptOutput({
      state: { emitted: false, output: { text: "", truncated: false } }, elapsedSeconds: 12,
      observation: { answerDelta: "answer", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-09-03T00:00:00.000Z" } }
    });

    expect(result).toEqual({
      state: { emitted: true, output: { text: "answer", truncated: false }, terminalLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-09-03T00:00:00.000Z" } },
      observation: { answer: { snapshot: "answer", update: "append", toolActivities: [] }, main: {} }
    });
  });

  it("projects safe tool and main status fields without answer output", () => {
    const result = projectOwnedTranscriptOutput({
      state: { emitted: false, output: { text: "", truncated: false } }, elapsedSeconds: -1,
      observation: { answerDelta: "", toolActivities: [{ key: "tool:1", kind: "test", label: "npm test", state: "done" }], mainStatus: { statusTitle: "Testing", planSteps: [{ key: "step:1", label: "Verify", state: "done" }], tokenCount: 42 } }
    });

    expect(result).toMatchObject({
      state: { emitted: false, output: { text: "", truncated: false } },
      observation: { answer: { snapshot: "", update: "append", toolActivities: [{ key: "tool:1" }] }, main: { status: { statusTitle: "Testing", elapsedSeconds: 0, tokenCount: 42, planSteps: [{ key: "step:1", kind: "step" }] } } }
    });
  });

  it("keeps previous output and emits no event for an empty nonterminal observation", () => {
    expect(projectOwnedTranscriptOutput({ state: { emitted: true, output: { text: "prior", truncated: false } }, observation: { answerDelta: "" } }))
      .toEqual({ state: { emitted: true, output: { text: "prior", truncated: false } } });
  });

  it("retains an aborted lifecycle without manufacturing output", () => {
    expect(projectOwnedTranscriptOutput({
      state: { emitted: false, output: { text: "", truncated: false } },
      observation: { answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "aborted", startedAt: "2026-09-03T00:00:00.000Z", reason: "interrupted" } }
    })).toEqual({
      state: { emitted: false, output: { text: "", truncated: false }, terminalLifecycle: { turnId: "turn-1", state: "aborted", startedAt: "2026-09-03T00:00:00.000Z", reason: "interrupted" } }
    });
  });

  it("publishes one bounded replacement at overflow and suppresses later answer growth", () => {
    const initial = { emitted: true, output: { text: "x".repeat(MAX_TURN_OUTPUT_CHARS - 10), truncated: false } };
    const overflow = projectOwnedTranscriptOutput({ state: initial, observation: { answerDelta: "overflowing delta" } });
    expect(overflow.state.output.text).toHaveLength(MAX_TURN_OUTPUT_CHARS);
    expect(overflow.state.output.text.endsWith(TURN_OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(overflow.observation?.answer).toMatchObject({ snapshot: overflow.state.output.text, update: "replace-all" });

    const later = projectOwnedTranscriptOutput({ state: overflow.state, observation: { answerDelta: "ignored answer", toolActivities: [{ key: "test", kind: "test", label: "tests", state: "done" }] } });
    expect(later.state.output).toBe(overflow.state.output);
    expect(later.observation?.answer).toMatchObject({ snapshot: "", update: "append", toolActivities: [expect.objectContaining({ key: "test" })] });
  });

  it("continues publishing after the legacy 64 KiB boundary", () => {
    const legacyBoundary = 64 * 1024;
    const initial = { emitted: true, output: { text: "x".repeat(legacyBoundary), truncated: false } };

    const result = projectOwnedTranscriptOutput({ state: initial, observation: { answerDelta: "continued output" } });

    expect(result.state.output).toEqual({ text: `${"x".repeat(legacyBoundary)}\n\ncontinued output`, truncated: false });
    expect(result.observation?.answer).toMatchObject({ snapshot: "continued output", update: "append" });
  });
});
