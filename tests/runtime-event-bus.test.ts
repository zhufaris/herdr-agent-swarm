import { describe, expect, it, vi } from "vitest";
import { RuntimeEventBus } from "../src/events/runtime-event-bus.js";

describe("RuntimeEventBus", () => {
  it("waits for already-started awaited publications during shutdown", async () => {
    const bus = new RuntimeEventBus();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    bus.subscribe("lifecycle", "slow-projector", async () => gate);
    const publication = bus.publishLifecycle({ eventId: "event-stop", bindingId: "binding-1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-09-24T00:00:00.000Z", payload: { promptId: "prompt-1", answer: "", queueDepth: 0 } });
    const stopped = bus.stop();
    let stopSettled = false; void stopped.then(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    release();
    await expect(Promise.all([publication, stopped])).resolves.toBeDefined();
  });

  it("buffers and coalesces work by durable drain key until sealed", async () => {
    const bus = new RuntimeEventBus();
    const received: string[] = [];
    bus.subscribe("work", "worker", ({ key }) => { received.push(key); });

    bus.publishWork({ kind: "worker-ready", instanceId: "worker-1" });
    bus.publishWork({ kind: "worker-ready", instanceId: "worker-1" });
    bus.publishWork({ kind: "worker-ready", instanceId: "worker-2" });
    expect(received).toEqual([]);

    bus.seal();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(received).toEqual(["worker-ready:worker-1", "worker-ready:worker-2"]);
    expect(bus.snapshot().channels.work).toMatchObject({ published: 3, delivered: 2, coalesced: 1, pending: 0, listenerCount: 1 });
  });

  it("isolates lifecycle subscriber failures without logging payload content", async () => {
    const error = vi.fn();
    const bus = new RuntimeEventBus({ error });
    const received: string[] = [];
    bus.subscribe("lifecycle", "broken", () => { throw new Error("projection failed"); });
    bus.subscribe("lifecycle", "healthy", ({ payload }) => { received.push(payload.eventId); });

    await bus.publishLifecycle({ eventId: "event-1", bindingId: "binding-1", type: "TurnCompleted", origin: "herdr", occurredAt: "2026-09-24T00:00:00.000Z", payload: { promptId: "prompt-1", answer: "secret answer", queueDepth: 0 } });

    expect(received).toEqual(["event-1"]);
    expect(bus.snapshot().channels.lifecycle).toMatchObject({ published: 1, delivered: 1, subscriberFailures: 1, failuresBySubscriber: { broken: 1 } });
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret answer");
  });

  it("propagates inbound failures so the durable inbox can retry", async () => {
    const bus = new RuntimeEventBus();
    bus.subscribe("inbound", "router", () => { throw new Error("retry me"); });
    const event = { eventId: "inbound-1", type: "InboundMessageReceived" as const, origin: "lark" as const, occurredAt: "2026-09-24T00:00:00.000Z", payload: { eventId: "inbound-1" } };
    await expect(bus.publishInbound(event)).rejects.toThrow("retry me");
    expect(JSON.stringify(event)).not.toContain("message text");
  });

  it("rejects duplicate names within a channel but permits the same name across channels", () => {
    const bus = new RuntimeEventBus();
    bus.subscribe("work", "projection", () => {});
    expect(() => bus.subscribe("work", "projection", () => {})).toThrow("work:projection");
    expect(() => bus.subscribe("lifecycle", "projection", () => {})).not.toThrow();
  });
});
