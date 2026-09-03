import { describe, expect, it } from "vitest";
import { projectOwnedTranscriptOutput } from "../src/coordinator/owned-transcript-output-projector.js";

describe("owned transcript output projector", () => {
  it("accumulates answer output and retains a completed lifecycle", () => {
    const result = projectOwnedTranscriptOutput({
      state: { emitted: false, chunks: [] }, elapsedSeconds: 12,
      observation: { answerDelta: "answer", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-09-03T00:00:00.000Z" } }
    });

    expect(result).toEqual({
      state: { emitted: true, chunks: ["answer"], terminalLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-09-03T00:00:00.000Z" } },
      observation: { answer: { snapshot: "answer", update: "append", toolActivities: [] }, main: {} }
    });
  });

  it("projects safe tool and main status fields without answer output", () => {
    const result = projectOwnedTranscriptOutput({
      state: { emitted: false, chunks: [] }, elapsedSeconds: -1,
      observation: { answerDelta: "", toolActivities: [{ key: "tool:1", kind: "test", label: "npm test", state: "done" }], mainStatus: { statusTitle: "Testing", planSteps: [{ key: "step:1", label: "Verify", state: "done" }], tokenCount: 42 } }
    });

    expect(result).toMatchObject({
      state: { emitted: false, chunks: [] },
      observation: { answer: { snapshot: "", update: "append", toolActivities: [{ key: "tool:1" }] }, main: { status: { statusTitle: "Testing", elapsedSeconds: 0, tokenCount: 42, planSteps: [{ key: "step:1", kind: "step" }] } } }
    });
  });

  it("keeps previous output and emits no event for an empty nonterminal observation", () => {
    expect(projectOwnedTranscriptOutput({ state: { emitted: true, chunks: ["prior"] }, observation: { answerDelta: "" } }))
      .toEqual({ state: { emitted: true, chunks: ["prior"] } });
  });

  it("retains an aborted lifecycle without manufacturing output", () => {
    expect(projectOwnedTranscriptOutput({
      state: { emitted: false, chunks: [] },
      observation: { answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "aborted", startedAt: "2026-09-03T00:00:00.000Z", reason: "interrupted" } }
    })).toEqual({
      state: { emitted: false, chunks: [], terminalLifecycle: { turnId: "turn-1", state: "aborted", startedAt: "2026-09-03T00:00:00.000Z", reason: "interrupted" } }
    });
  });
});
