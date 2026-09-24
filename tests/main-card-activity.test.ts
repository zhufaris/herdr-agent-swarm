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
});
