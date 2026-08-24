import { describe, expect, it, vi } from "vitest";
import { WorkflowWakeupBus } from "../src/events/workflow-wakeup-bus.js";

describe("WorkflowWakeupBus", () => {
  it("coalesces duplicate wake-ups while preserving independent scopes", async () => {
    const bus = new WorkflowWakeupBus();
    const listener = vi.fn();
    bus.subscribe(listener);

    bus.publish({ kind: "prompt-ready", bindingId: "b1" });
    bus.publish({ kind: "prompt-ready", bindingId: "b1" });
    bus.publish({ kind: "prompt-ready", bindingId: "b2" });
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    expect(listener).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b2" });
  });

  it("stops delivery after unsubscription", async () => {
    const bus = new WorkflowWakeupBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe(listener);
    unsubscribe();

    bus.publish({ kind: "binding-runtime-changed", bindingId: "b1" });
    await Promise.resolve();

    expect(listener).not.toHaveBeenCalled();
  });
});
