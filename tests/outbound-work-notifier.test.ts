import { describe, expect, it, vi } from "vitest";
import { InProcessOutboundWorkNotifier } from "../src/events/outbound-work-notifier.js";

describe("InProcessOutboundWorkNotifier", () => {
  it("coalesces duplicate wake-ups in one microtask", async () => {
    const listener = vi.fn();
    const notifier = new InProcessOutboundWorkNotifier();
    notifier.subscribe(listener);

    notifier.wake();
    notifier.wake();
    notifier.wake();
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("isolates listener failures from producers", async () => {
    const error = vi.fn();
    const healthy = vi.fn();
    const notifier = new InProcessOutboundWorkNotifier({ error });
    notifier.subscribe(() => { throw new Error("delivery worker failed"); });
    notifier.subscribe(healthy);

    expect(() => notifier.wake()).not.toThrow();
    await new Promise((resolve) => queueMicrotask(resolve));
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: "outbound-work-listener-failed", outcome: "deferred_to_safety_scan" }), expect.any(String));
  });
});
