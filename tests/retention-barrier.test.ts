import { describe, expect, it } from "vitest";
import { RETENTION_WINDOW_MS, evaluateRetentionBarrier, type RetentionBarrierFacts } from "../src/domain/retention-barrier.js";

const now = "2026-10-08T00:00:00.000Z";
const eligibleFacts = (): RetentionBarrierFacts => ({
  terminal: true,
  terminalAt: new Date(Date.parse(now) - RETENTION_WINDOW_MS - 1).toISOString(),
  now,
  referenceCount: 0,
  checkpointSettled: true,
  openGapCount: 0,
  effect: "certain",
  activeQuarantineCount: 0,
  unresolvedRecoveryCount: 0,
  pendingPrerequisiteCount: 0,
  replacement: "not-required",
  projectionReconstructible: true
});

describe("Retention Barrier", () => {
  it("accepts only terminal, old, unreferenced, reconstructible evidence", () => {
    expect(evaluateRetentionBarrier(eligibleFacts())).toEqual({ status: "eligible" });
  });

  it.each([
    ["not_terminal", { terminal: false }],
    ["retention_window_open", { terminalAt: new Date(Date.parse(now) - RETENTION_WINDOW_MS).toISOString() }],
    ["referenced", { referenceCount: 1 }],
    ["checkpoint_incomplete", { checkpointSettled: false }],
    ["open_gap", { openGapCount: 1 }],
    ["uncertain_effect", { effect: "uncertain" }],
    ["quarantined", { activeQuarantineCount: 1 }],
    ["unresolved_recovery", { unresolvedRecoveryCount: 1 }],
    ["pending_prerequisite", { pendingPrerequisiteCount: 1 }],
    ["replacement_incomplete", { replacement: "incomplete" }],
    ["projection_not_reconstructible", { projectionReconstructible: false }]
  ] as const)("refuses %s without accepting partial proof", (reason, override) => {
    expect(evaluateRetentionBarrier({ ...eligibleFacts(), ...override })).toEqual({ status: "refused", reason });
  });

  it("fails closed for invalid timestamps and negative evidence counts", () => {
    expect(evaluateRetentionBarrier({ ...eligibleFacts(), terminalAt: "invalid" })).toEqual({ status: "refused", reason: "invalid_evidence" });
    expect(evaluateRetentionBarrier({ ...eligibleFacts(), terminalAt: "2026-02-30T00:00:00.000Z" })).toEqual({ status: "refused", reason: "invalid_evidence" });
    expect(evaluateRetentionBarrier({ ...eligibleFacts(), now: "2026-02-30T00:00:00.000Z" })).toEqual({ status: "refused", reason: "invalid_evidence" });
    expect(evaluateRetentionBarrier({ ...eligibleFacts(), referenceCount: -1 })).toEqual({ status: "refused", reason: "invalid_evidence" });
  });
});
