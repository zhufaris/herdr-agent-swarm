import { describe, expect, it } from "vitest";
import { mergeReconciliationScope, reconciliationCooldownCovers, reconciliationScopeCovers } from "../src/coordinator/reconciliation-scope-policy.js";

describe("reconciliation scope policy", () => {
  it("merges scoped requests and lets a full request absorb the queue", () => {
    expect([...mergeReconciliationScope(undefined, ["w1", "w1"] )!]).toEqual(["w1"]);
    expect([...mergeReconciliationScope(new Set(["w1"]), ["w2", "w1"])!].sort()).toEqual(["w1", "w2"]);
    expect(mergeReconciliationScope(new Set(["w1"]))).toBeNull();
    expect(mergeReconciliationScope(null, ["w1"])).toBeNull();
  });

  it("matches full and scoped coverage without letting a scoped pass cover all workspaces", () => {
    expect(reconciliationScopeCovers(undefined, ["w1"])).toBe(false);
    expect(reconciliationScopeCovers(null)).toBe(true);
    expect(reconciliationScopeCovers(new Set(["w1"]), ["w1"])).toBe(true);
    expect(reconciliationScopeCovers(new Set(["w1"]), ["w1", "w2"])).toBe(false);
    expect(reconciliationScopeCovers(new Set(["w1"]))).toBe(false);
  });

  it("uses successful workspace timestamps inside the cooldown boundary", () => {
    const input = { configuredWorkspaceIds: new Set(["w1", "w2"]), lastReconciledAt: new Map([["w1", 900], ["w2", 901]]), now: 1_000, cooldownMs: 100 };
    expect(reconciliationCooldownCovers({ ...input, requestedWorkspaceIds: ["w1"] })).toBe(true);
    expect(reconciliationCooldownCovers({ ...input })).toBe(true);
    expect(reconciliationCooldownCovers({ ...input, requestedWorkspaceIds: ["w1", "missing"] })).toBe(false);
    expect(reconciliationCooldownCovers({ ...input, requestedWorkspaceIds: [] })).toBe(false);
  });
});
