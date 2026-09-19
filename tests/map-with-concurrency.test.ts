import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/runtime/map-with-concurrency.js";

describe("mapWithConcurrency", () => {
  it("preserves result order while bounding active operations", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const work = mapWithConcurrency([3, 1, 2, 0], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return value * 2;
    });

    await Promise.resolve();
    expect(active).toBe(2);
    releases.splice(0).forEach((release) => release());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(active).toBe(2);
    releases.splice(0).forEach((release) => release());

    await expect(work).resolves.toEqual([6, 2, 4, 0]);
    expect(maximumActive).toBe(2);
  });

  it("rejects invalid concurrency instead of silently dropping work", async () => {
    await expect(mapWithConcurrency([1], 0, async (value) => value)).rejects.toThrow("positive safe integer");
  });
});
