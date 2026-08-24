import { describe, expect, it, vi } from "vitest";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";

describe("InProcessPromptWorkScheduler", () => {
  it("coalesces duplicate wake-ups while preserving independent scopes", async () => {
    const bus = new InProcessPromptWorkScheduler();
    const listener = vi.fn();
    bus.subscribe(listener);

    bus.wake({ kind: "prompt-ready", bindingId: "b1" });
    bus.wake({ kind: "prompt-ready", bindingId: "b1" });
    bus.wake({ kind: "prompt-ready", bindingId: "b2" });
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    expect(listener).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b2" });
  });

  it("stops delivery after unsubscription", async () => {
    const bus = new InProcessPromptWorkScheduler();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();

    bus.wake({ kind: "binding-runtime-changed", bindingId: "b1" });
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
  });
});
