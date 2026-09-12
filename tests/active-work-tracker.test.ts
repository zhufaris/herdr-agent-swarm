import { describe, expect, it } from "vitest";
import { ActiveWorkTracker } from "../src/runtime/active-work-tracker.js";

describe("ActiveWorkTracker", () => {
  it("tracks work through settlement without converting its outcome", async () => {
    const tracker = new ActiveWorkTracker();
    let release!: () => void;
    const pending = tracker.track(new Promise<void>((resolve) => { release = resolve; }));
    const rejected = tracker.track(Promise.reject(new Error("failed")));
    await expect(rejected).rejects.toThrow("failed");
    expect(tracker.size).toBe(1);
    const settled = tracker.settle();
    release();
    await Promise.all([pending, settled]);
    expect(tracker.size).toBe(0);
  });

  it("keeps settling work registered by an already tracked operation", async () => {
    const tracker = new ActiveWorkTracker();
    let releaseChild!: () => void;
    const parent = tracker.track(Promise.resolve().then(() => {
      tracker.track(new Promise<void>((resolve) => { releaseChild = resolve; }));
    }));
    let settled = false;
    const draining = tracker.settle().then(() => { settled = true; });
    await parent;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseChild();
    await draining;
    expect(tracker.size).toBe(0);
  });
});
