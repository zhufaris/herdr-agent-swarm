import { describe, expect, it } from "vitest";
import { currentMainCardActivity } from "../src/domain/main-card-activity.js";

describe("currentMainCardActivity", () => {
  const events = [
    { key: "plan:one", kind: "step" as const, label: "Plan", state: "active" as const, occurredAt: "1" },
    { key: "tool:read", kind: "read" as const, label: "Read config", state: "active" as const, occurredAt: "2" },
    { key: "tool:test", kind: "test" as const, label: "Run tests", state: "done" as const, occurredAt: "3" }
  ];

  it("prefers the current active activity and excludes plan steps", () => {
    expect(currentMainCardActivity(events, new Set(["plan:one"]))).toEqual([events[1]]);
  });

  it("falls back to the newest activity when none remains active", () => {
    expect(currentMainCardActivity(events.map((event) => ({ ...event, state: "done" as const })), new Set(["plan:one"]))).toEqual([expect.objectContaining({ key: "tool:test" })]);
  });

  it("returns no summary when only plan events exist", () => {
    expect(currentMainCardActivity(events.slice(0, 1), new Set(["plan:one"]))).toEqual([]);
  });

  it("suppresses activity that duplicates the visible status or active plan step", () => {
    const duplicateStatus = { key: "tool:status", kind: "test" as const, label: "Checking deployment state", state: "active" as const, occurredAt: "4" };
    const duplicatePlan = { key: "tool:plan", kind: "command" as const, label: "Run focused tests now", state: "active" as const, occurredAt: "5" };

    expect(currentMainCardActivity([duplicateStatus], new Set(), ["Checking deployment state"])).toEqual([]);
    expect(currentMainCardActivity([duplicatePlan], new Set(), ["Run focused tests"])).toEqual([]);
    expect(currentMainCardActivity([{ ...duplicatePlan, label: "Read package.json" }], new Set(), ["Run focused tests"]))
      .toEqual([expect.objectContaining({ label: "Read package.json" })]);
  });
});
