import { describe, expect, it } from "vitest";
import { reconciliationCooldownCovers } from "../src/coordinator/reconciliation-scope-policy.js";

describe("reconciliation scope policy", () => {
  it("uses successful workspace timestamps inside the cooldown boundary", () => {
    const input = { configuredWorkspaceIds: new Set(["w1", "w2"]), lastReconciledAt: new Map([["w1", 900], ["w2", 901]]), now: 1_000, cooldownMs: 100 };
    expect(reconciliationCooldownCovers({ ...input, requestedWorkspaceIds: ["w1"] })).toBe(true);
    expect(reconciliationCooldownCovers({ ...input })).toBe(true);
    expect(reconciliationCooldownCovers({ ...input, requestedWorkspaceIds: ["w1", "missing"] })).toBe(false);
    expect(reconciliationCooldownCovers({ ...input, requestedWorkspaceIds: [] })).toBe(false);
  });
});
