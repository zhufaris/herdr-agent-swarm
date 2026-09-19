import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { HerdrSnapshotCollector } from "../src/coordinator/herdr-snapshot-collector.js";
import type { HerdrPort } from "../src/domain/ports/external.js";

describe("HerdrSnapshotCollector", () => {
  it("bounds workspace discovery fallback concurrency", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const listPanes = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return [];
    });
    const collector = new HerdrSnapshotCollector({ listPanes } as HerdrPort, pino({ enabled: false }));
    const work = collector.collect(["w1", "w2", "w3", "w4", "w5", "w6"]);

    await Promise.resolve();
    expect(active).toBe(4);
    releases.splice(0).forEach((release) => release());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(active).toBe(2);
    releases.splice(0).forEach((release) => release());

    await expect(work).resolves.toMatchObject({ failures: [] });
    expect(maximumActive).toBe(4);
    expect(listPanes).toHaveBeenCalledTimes(6);
  });
});
