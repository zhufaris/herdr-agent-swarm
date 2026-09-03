import { describe, expect, it } from "vitest";
import { decidePromptSafetyScan, decidePromptSafetyScanFailure } from "../src/coordinator/prompt-safety-scan-policy.js";

describe("prompt safety scan policy", () => {
  it("backs idle scans off exponentially and caps the multiplier at six", () => {
    expect(decidePromptSafetyScan({ cancelled: 0, failedDetached: 0, hints: [] }, 0, 100)).toMatchObject({ outcome: "idle", consecutiveIdleScans: 1, nextDelayMs: 100 });
    expect(decidePromptSafetyScan({ cancelled: 0, failedDetached: 0, hints: [] }, 1, 100)).toMatchObject({ outcome: "idle", consecutiveIdleScans: 2, nextDelayMs: 200 });
    expect(decidePromptSafetyScan({ cancelled: 0, failedDetached: 0, hints: [] }, 20, 100)).toMatchObject({ outcome: "idle", consecutiveIdleScans: 21, nextDelayMs: 600 });
  });

  it("summarizes durable hints without retaining their identities and resets the cadence", () => {
    const result = decidePromptSafetyScan({
      cancelled: 2, failedDetached: 3,
      hints: [
        { kind: "prompt-ready", bindingId: "private-binding" },
        { kind: "steering-ready", bindingId: "private-binding", parentPromptId: "private-parent" },
        { kind: "detached-observer-ready", bindingId: "private-binding", promptId: "private-prompt" }
      ]
    }, 5, 100);

    expect(result).toEqual({
      outcome: "work_found", consecutiveIdleScans: 0, nextDelayMs: 100,
      discovered: { turns: 1, steering: 1, detached: 1, cancelled: 2, failedDetached: 3 }
    });
    expect(JSON.stringify(result.discovered)).not.toContain("private");
  });

  it("treats terminal convergence without hints as work", () => {
    expect(decidePromptSafetyScan({ cancelled: 1, failedDetached: 0, hints: [] }, 5, 100)).toMatchObject({
      outcome: "work_found", consecutiveIdleScans: 0, nextDelayMs: 100,
      discovered: { turns: 0, steering: 0, detached: 0, cancelled: 1, failedDetached: 0 }
    });
  });

  it("resets a failed scan to the base cadence", () => {
    expect(decidePromptSafetyScanFailure(100)).toEqual({ consecutiveIdleScans: 0, nextDelayMs: 100 });
  });
});
