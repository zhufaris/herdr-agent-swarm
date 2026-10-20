import { describe, expect, it } from "vitest";
import { DeliveryReadyScheduler } from "../src/events/delivery-ready-scheduler.js";

describe("DeliveryReadyScheduler", () => {
  it("grants live and history Rings in a 3:1 ratio with round-robin order", () => {
    const scheduler = new DeliveryReadyScheduler(4);
    for (const key of ["live-1", "live-2", "live-3", "live-4"]) scheduler.offer(key, "live", 0);
    for (const key of ["history-1", "history-2"]) scheduler.offer(key, "history", 0);
    expect([scheduler.claim(), scheduler.claim(), scheduler.claim(), scheduler.claim()].map((grant) => grant?.ringKey)).toEqual([
      "live-1", "live-2", "live-3", "history-1"
    ]);
    for (const key of ["live-1", "live-2", "live-3", "history-1"]) scheduler.release(key);
    expect(scheduler.claim()?.ringKey).toBe("live-4");
    scheduler.release("live-4");
    expect(scheduler.claim()?.ringKey).toBe("history-2");
  });

  it("coalesces duplicate ready tokens and enforces the four-permit ceiling", () => {
    const scheduler = new DeliveryReadyScheduler(4);
    for (let index = 0; index < 5; index += 1) scheduler.offer(`ring-${index}`, "live", index);
    scheduler.offer("ring-0", "history", 100);
    const grants = [scheduler.claim(), scheduler.claim(), scheduler.claim(), scheduler.claim()];
    expect(grants.every(Boolean)).toBe(true);
    expect(scheduler.claim()).toBeNull();
    expect(scheduler.snapshot()).toMatchObject({ readyCount: 1, activeCount: 4 });
    scheduler.release(grants[0]!.ringKey);
    expect(scheduler.claim()?.ringKey).toBe("ring-4");
  });

  it("uses the available class when the preferred class is empty", () => {
    const scheduler = new DeliveryReadyScheduler(1);
    for (let round = 0; round < 4; round += 1) {
      scheduler.offer(`history-${round}`, "history", round);
      const grant = scheduler.claim();
      expect(grant?.ringKey).toBe(`history-${round}`);
      scheduler.release(grant!.ringKey);
    }
  });

  it("makes a continuously ready Ring yield behind its class peers", () => {
    const scheduler = new DeliveryReadyScheduler(1);
    scheduler.offer("live-1", "live", 0);
    scheduler.offer("live-2", "live", 0);
    expect(scheduler.claim()?.ringKey).toBe("live-1");
    scheduler.release("live-1");
    scheduler.offer("live-1", "live", 1);
    expect(scheduler.claim()?.ringKey).toBe("live-2");
  });
});
