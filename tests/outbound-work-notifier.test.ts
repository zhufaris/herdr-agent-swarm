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
    expect(listener).toHaveBeenCalledWith({ kind: "recovery" });
  });

  it("coalesces duplicate scope hints without escalating them to recovery", async () => {
    const listener = vi.fn();
    const notifier = new InProcessOutboundWorkNotifier();
    const scope = { kind: "pane" as const, workspaceId: "workspace", paneId: "pane" };
    notifier.subscribe(listener);

    notifier.wake({ kind: "scope", scope });
    notifier.wake({ kind: "scope", scope });
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ kind: "scope", scope });
  });

  it("uses an exact scope hint instead of a coalesced generic recovery wake", async () => {
    const listener = vi.fn();
    const notifier = new InProcessOutboundWorkNotifier();
    const scope = { kind: "pane" as const, workspaceId: "workspace", paneId: "exact" };
    notifier.subscribe(listener);

    notifier.wake();
    notifier.wake({ kind: "scope", scope });
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ kind: "scope", scope });
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
