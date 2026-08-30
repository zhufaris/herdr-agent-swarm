import { describe, expect, it } from "vitest";
import { FailureLogGate } from "../src/runtime/failure-log-gate.js";

describe("FailureLogGate", () => {
  it("emits the first failure, periodic summaries, and one recovery", () => {
    let now = 1_000;
    const gate = new FailureLogGate(100, () => now);
    expect(gate.fail("workspace:w1", "offline")).toMatchObject({ kind: "first", count: 1 });
    expect(gate.fail("workspace:w1", "offline")).toEqual({ kind: "suppressed" });
    now += 100;
    expect(gate.fail("workspace:w1", "offline")).toMatchObject({ kind: "summary", count: 3 });
    expect(gate.recover("workspace:w1")).toMatchObject({ count: 3, durationMs: 100 });
    expect(gate.recover("workspace:w1")).toBeNull();
  });

  it("starts a new outage when the normalized failure changes", () => {
    const gate = new FailureLogGate();
    gate.fail("socket", "refused");
    expect(gate.fail("socket", "permission denied")).toMatchObject({ kind: "first", count: 1 });
  });
});
