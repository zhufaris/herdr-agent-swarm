import { describe, expect, it } from "vitest";
import { reduceCurrentGoal, type GoalChange } from "../src/domain/current-goal.js";

function change(overrides: Partial<GoalChange> = {}): GoalChange {
  return {
    goalId: "goal-1", objective: "Ship the feature", status: "active", sourceUpdatedAt: 100,
    occurredAt: "2026-09-30T00:00:00.000Z", sourceId: "source-1", sourceSequence: 1,
    sourceEventId: "event-1", nativeSessionId: "session-1", ...overrides
  };
}

describe("CurrentGoal", () => {
  it("creates, updates, and completes one session-owned Goal", () => {
    const active = reduceCurrentGoal(null, change());
    expect(active).toMatchObject({ goalId: "goal-1", status: "active", blockKind: null });
    const blocked = reduceCurrentGoal(active, change({ status: "blocked", sourceSequence: 2, sourceEventId: "event-2" }));
    expect(blocked).toMatchObject({ status: "blocked", blockKind: "explicit" });
    expect(reduceCurrentGoal(blocked, change({ status: "completed", sourceSequence: 3, sourceEventId: "event-3" }))).toBeNull();
  });

  it("maps native limit states to a visible blocked Goal without losing the cause", () => {
    expect(reduceCurrentGoal(null, change({ status: "budget_limited" }))).toMatchObject({ status: "blocked", blockKind: "budget" });
    expect(reduceCurrentGoal(null, change({ status: "usage_limited" }))).toMatchObject({ status: "blocked", blockKind: "usage" });
  });

  it("rejects duplicate, stale, foreign-session, and ambiguous cross-source changes", () => {
    const current = reduceCurrentGoal(null, change())!;
    expect(reduceCurrentGoal(current, change())).toBe(current);
    expect(reduceCurrentGoal(current, change({ sourceSequence: 0, sourceEventId: "older" }))).toBe(current);
    expect(reduceCurrentGoal(current, change({ nativeSessionId: "session-2", sourceSequence: 2 }))).toBe(current);
    expect(reduceCurrentGoal(current, change({ sourceId: "source-2", objective: "conflict", sourceEventId: "conflict" }))).toBe(current);
  });

  it("accepts a newer cross-source snapshot and a replacement Goal", () => {
    const current = reduceCurrentGoal(null, change())!;
    const recovered = reduceCurrentGoal(current, change({ sourceId: "source-2", sourceUpdatedAt: 101, sourceSequence: 1, sourceEventId: "event-2" }));
    expect(recovered).not.toBe(current);
    expect(reduceCurrentGoal(recovered, change({ goalId: "goal-2", sourceId: "source-2", sourceUpdatedAt: 102, sourceSequence: 2, sourceEventId: "event-3" }))).toMatchObject({ goalId: "goal-2" });
  });
});
