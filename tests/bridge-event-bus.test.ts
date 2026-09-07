import { describe, expect, it, vi } from "vitest";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";

const event = {
  eventId: "event-1", bindingId: "binding-1", type: "TurnCompleted", origin: "herdr",
  occurredAt: "2026-08-24T00:00:00.000Z", payload: { promptId: "prompt-1", answer: "secret answer", queueDepth: 0 }
} as const;

describe("BridgeEventBus", () => {
  it("isolates synchronous and asynchronous subscriber failures while continuing fan-out", async () => {
    const error = vi.fn();
    const received: string[] = [];
    const bus = new BridgeEventBus({ error });
    bus.onBridgeEvent("sync-projector", () => { throw new Error("sync failure"); });
    bus.onBridgeEvent("healthy-projector", async (published) => { received.push(published.eventId); });
    bus.onBridgeEvent("async-projector", async () => { throw new Error("async failure"); });

    await expect(bus.publish(event)).resolves.toBeUndefined();

    expect(received).toEqual(["event-1"]);
    expect(bus.snapshot()).toMatchObject({
      listenerCount: 3,
      publicationCount: 1,
      subscriberFailures: 2,
      failuresBySubscriber: { "sync-projector": 1, "async-projector": 1 },
      lastFailedSubscriber: "async-projector"
    });
    expect(bus.snapshot().lastFailureAt).toEqual(expect.any(String));
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      event: "lifecycle-subscriber-failed", eventId: "event-1", bindingId: "binding-1",
      bridgeEventType: "TurnCompleted", subscriber: "sync-projector", outcome: "isolated"
    }), "lifecycle event subscriber failed; workflow outcome remains authoritative");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret answer");
  });

  it("uses the subscriber snapshot captured at publication time", async () => {
    const received: string[] = [];
    const bus = new BridgeEventBus();
    let unsubscribe = () => {};
    bus.onBridgeEvent("first", () => { received.push("first"); unsubscribe(); });
    unsubscribe = bus.onBridgeEvent("second", () => { received.push("second"); });

    await bus.publish(event);
    await bus.publish({ ...event, eventId: "event-2" });

    expect(received).toEqual(["first", "second", "first"]);
    expect(bus.snapshot()).toMatchObject({ listenerCount: 1, publicationCount: 2, subscriberFailures: 0, failuresBySubscriber: {} });
  });

  it("rejects duplicate subscriber names and permits reuse after unsubscribe", () => {
    const bus = new BridgeEventBus();
    const unsubscribe = bus.onBridgeEvent("projector", () => {});

    expect(() => bus.onBridgeEvent("projector", () => {})).toThrow("Lifecycle event subscriber already registered: projector");
    unsubscribe();
    expect(() => bus.onBridgeEvent("projector", () => {})).not.toThrow();
  });
});
