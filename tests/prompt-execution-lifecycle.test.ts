import { describe, expect, it } from "vitest";
import { abortedPromptNotice, decideDetachedTurnTerminalOutcome, decidePromptExecutionFailure, isLaterConflictingTranscriptTurn } from "../src/coordinator/prompt-execution-lifecycle.js";
import type { PromptJob } from "../src/domain/types.js";

const prompt: PromptJob = {
  id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work", executionOrigin: "bridge",
  wasDetached: true,
  dispatchedAt: "2026-09-03T00:00:00.000Z", transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-09-03T00:00:01.000Z",
  observationState: "detached", state: "running", attemptCount: 1, error: null, createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z"
};

describe("prompt execution lifecycle", () => {
  it("detaches uncertain dispatched work instead of authorizing replay", () => {
    expect(decidePromptExecutionFailure({ dispatched: true, stopping: false, observerAborted: false, error: "socket closed" })).toEqual({
      kind: "detach",
      notice: "TraeX 请求已尝试投递，但 Bridge 无法确认最终结果：socket closed；不会自动重发。"
    });
    expect(decidePromptExecutionFailure({ dispatched: false, stopping: false, observerAborted: false, error: "rejected" })).toEqual({ kind: "fail", error: "rejected" });
    expect(decidePromptExecutionFailure({ dispatched: false, stopping: true, observerAborted: true, error: "observer detached" })).toEqual({ kind: "ignore" });
  });

  it("accepts terminal transcript output only at the exact owned boundary", () => {
    const completed = { turnId: "turn-1", answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "completed" as const, startedAt: "2026-09-03T00:00:01.000Z", finalAnswer: "done" } };
    expect(decideDetachedTurnTerminalOutcome(prompt, completed, true)).toEqual({ kind: "completed", finalAnswer: "done" });
    expect(decideDetachedTurnTerminalOutcome(prompt, { ...completed, turnLifecycle: { ...completed.turnLifecycle, startedAt: "2026-09-03T00:00:02.000Z" } }, true)).toEqual({ kind: "pending" });
    expect(decideDetachedTurnTerminalOutcome(prompt, { ...completed, turnLifecycle: { ...completed.turnLifecycle, state: "aborted", reason: "interrupted" } }, true)).toEqual({ kind: "aborted", reason: "interrupted" });
  });

  it("recognizes later conflicting turns without accepting their output", () => {
    expect(isLaterConflictingTranscriptTurn(prompt, { turnId: "turn-2", answerDelta: "", turnLifecycle: { turnId: "turn-2", state: "active", startedAt: "2026-09-03T00:00:02.000Z" } })).toBe(true);
    expect(isLaterConflictingTranscriptTurn(prompt, { turnId: "turn-2", answerDelta: "", turnLifecycle: { turnId: "turn-2", state: "active", startedAt: "2026-09-03T00:00:00.000Z" } })).toBe(false);
    expect(abortedPromptNotice("interrupted")).toContain("human operator");
  });
});
