import { describe, expect, it, vi } from "vitest";
import { WorkWakeupHub } from "../src/composition/work-wakeup-hub.js";

type Channels = { outbound: undefined; primary: string; instance: string };

describe("WorkWakeupHub", () => {
  it("coalesces pre-seal hints by their registered work key", () => {
    const primary = vi.fn();
    const hub = new WorkWakeupHub<Channels>(["outbound", "primary", "instance"]);
    hub.register("outbound", vi.fn());
    hub.register("primary", primary, (bindingId) => bindingId);
    hub.register("instance", vi.fn(), (instanceId) => instanceId);

    hub.wake("primary", "b1");
    hub.wake("primary", "b1");
    hub.wake("primary", "b2");
    expect(primary).not.toHaveBeenCalled();

    hub.seal();
    expect(primary.mock.calls).toEqual([["b1"], ["b2"]]);
  });

  it("dispatches immediately after seal", () => {
    const outbound = vi.fn();
    const hub = new WorkWakeupHub<{ outbound: undefined }>(["outbound"]);
    hub.register("outbound", outbound);
    hub.seal();
    hub.wake("outbound", undefined);
    expect(outbound).toHaveBeenCalledOnce();
  });

  it("retains one pre-registration hint for a channel until sealing", () => {
    const primary = vi.fn();
    const hub = new WorkWakeupHub<{ primary: string }>(["primary"]);
    hub.wake("primary", "older");
    hub.wake("primary", "newer");
    hub.register("primary", primary, (bindingId) => bindingId);
    hub.seal();
    expect(primary).toHaveBeenCalledOnce();
    expect(primary).toHaveBeenCalledWith("newer");
  });

  it("rejects duplicate registration and missing required channels", () => {
    const hub = new WorkWakeupHub<Channels>(["outbound", "primary"]);
    hub.register("outbound", vi.fn());
    expect(() => hub.register("outbound", vi.fn())).toThrow(/already registered/);
    expect(() => hub.seal()).toThrow(/primary/);
  });

  it("rejects registration after seal and unknown post-seal wake-ups", () => {
    const hub = new WorkWakeupHub<Channels>(["outbound"]);
    hub.register("outbound", vi.fn());
    hub.seal();
    expect(() => hub.register("primary", vi.fn())).toThrow(/after seal/);
    expect(() => hub.wake("instance", "i1")).toThrow(/not registered/);
  });
});
