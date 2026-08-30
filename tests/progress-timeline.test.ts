import { describe, expect, it } from "vitest";
import { renderProgressTimeline } from "../src/cards/progress-timeline.js";
import type { RunProgressEvent } from "../src/domain/run-card-view.js";

function event(index: number): RunProgressEvent {
  return { key: `step:${index}`, kind: index % 2 ? "test" : "edit", label: `step ${index}`, state: index === 4 ? "active" : "done", occurredAt: "now" };
}

describe("progress timeline", () => {
  it("renders nothing for empty history", () => {
    expect(renderProgressTimeline([], "running")).toEqual([]);
  });

  it("keeps the newest three visible and summarizes older entries without serializing them", () => {
    const events = [1, 2, 3, 4].map(event);
    const timeline = renderProgressTimeline(events, "running") as Array<{ header: { title: { content: string } }; elements: Array<{ content?: string; header?: { title: { content: string } } }> }> ;

    expect(timeline[0]!.header.title.content).toBe("过程轨迹 · 进行中 · 4 项");
    expect(timeline[0]!.elements[0]!.content).not.toContain("step 1");
    expect(timeline[0]!.elements[0]!.content).toContain("step 2");
    expect(timeline[0]!.elements[1]!.content).toContain("更早 1 项已省略");
    expect(JSON.stringify(timeline)).not.toContain("step 1");
  });

  it("keeps serialized history bounded while preserving the caller's durable events", () => {
    const events = Array.from({ length: 1_000 }, (_, index) => event(index));
    const serialized = JSON.stringify(renderProgressTimeline(events, "running"));

    expect(serialized.length).toBeLessThan(2_000);
    expect(serialized).toContain("更早 997 项已省略");
    expect(serialized).toContain("step 999");
    expect(events).toHaveLength(1_000);
  });

  it("bounds and normalizes labels without mutating input", () => {
    const events = [{ ...event(1), label: `first\n  second ${"x".repeat(240)}` }];
    const original = events[0]!.label;
    const serialized = JSON.stringify(renderProgressTimeline(events, "completed"));

    expect(serialized).toContain("first second");
    expect(serialized).toContain("…");
    expect(events[0]!.label).toBe(original);
  });
});
