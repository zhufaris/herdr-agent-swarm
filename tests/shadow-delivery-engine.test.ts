import { describe, expect, it, vi } from "vitest";
import type { DeliveryEngineEvent, DeliveryEngineRefillPort } from "../src/domain/delivery-engine.js";
import type { PreparedDelivery } from "../src/domain/delivery.js";
import { ShadowDeliveryEngine } from "../src/events/shadow-delivery-engine.js";
import { PreparedDeliveryRing } from "../src/events/prepared-delivery-ring.js";

function delivery(id: string, order: number, options: { scope?: PreparedDelivery["scope"]; workClass?: "live" | "history"; bytes?: number } = {}): PreparedDelivery {
  return Object.freeze({
    replyId: id, scope: options.scope ?? { kind: "pane", workspaceId: "workspace", paneId: id }, ownerFence: { kind: "primary", id, generation: 1, sessionGeneration: 1 },
    deliveryOrder: order, workClass: options.workClass ?? "live", idempotencyKey: id, gatewayId: "gateway", gatewayProfileId: "profile",
    preparedPlan: { protocolVersion: 1, gatewayId: "gateway", profileId: "profile", rendererRevision: 1, operation: "message.reply.text", intent: { kind: "message.reply.text", rootMessageId: "root", text: `payload-${id}` } },
    planHash: `hash-${id}`, projectionKey: null, snapshotRevision: 1, rendererRevision: 1, cardSequence: null,
    priorCheckpoints: [], nextAttemptAt: "2026-10-06T00:00:00.000Z", estimatedBytes: options.bytes ?? 10
  });
}

async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

describe("ShadowDeliveryEngine", () => {
  it("checks duplicate membership without copying cached Ring items", async () => {
    const copiedItems = vi.spyOn(PreparedDeliveryRing.prototype, "items");
    const future = { ...delivery("future", 1), nextAttemptAt: "2099-01-01T00:00:00.000Z" };
    const engine = new ShadowDeliveryEngine();
    engine.start();

    engine.enqueue(future);
    engine.enqueue(future);
    await settle();

    expect(copiedItems).not.toHaveBeenCalled();
    copiedItems.mockRestore();
    await engine.stop();
  });

  it("records 3:1 shadow grants without exposing a claim or executor seam", async () => {
    const events: DeliveryEngineEvent[] = [];
    const engine = new ShadowDeliveryEngine({ observer: { record: (event) => events.push(event) }, now: () => Date.parse("2026-10-06T00:00:01.000Z") });
    engine.start();
    for (const item of [
      delivery("live-1", 1), delivery("live-2", 2), delivery("live-3", 3), delivery("history-1", 4, { workClass: "history" })
    ]) engine.enqueue(item);
    await settle();
    expect(events.filter((event) => event.kind === "shadow-grant").map((event) => event.replyId)).toEqual(["live-1", "live-2", "live-3", "history-1"]);
    expect(engine.snapshot()).toMatchObject({ state: "running", ringCount: 4, activeDeliveries: 0, cachedItems: 4, cachedBytes: 40 });
    await engine.stop();
  });

  it("keeps Pane, Global, and process budgets bounded while requesting refill", async () => {
    const events: DeliveryEngineEvent[] = [];
    const global = { kind: "global" } as const;
    const engine = new ShadowDeliveryEngine({
      observer: { record: (event) => events.push(event) }, now: () => Date.parse("2026-10-06T00:00:01.000Z"),
      limits: { paneItems: 2, paneBytes: 20, globalItems: 2, globalBytes: 20, processBytes: 25 }
    });
    engine.start();
    engine.enqueue(delivery("pane-1", 1, { scope: delivery("x", 1).scope, bytes: 10 }));
    engine.enqueue(delivery("pane-2", 2, { scope: delivery("x", 1).scope, bytes: 10 }));
    engine.enqueue(delivery("pane-overflow", 3, { scope: delivery("x", 1).scope, bytes: 10 }));
    engine.enqueue(delivery("global-1", 4, { scope: global, bytes: 5 }));
    engine.enqueue(delivery("global-process-overflow", 5, { scope: global, bytes: 5 }));
    await settle();
    expect(engine.snapshot()).toMatchObject({ cachedItems: 3, cachedBytes: 25, processByteLimit: 25, overflowedScopes: 2 });
    expect(events.filter((event) => event.kind === "refill-requested" && event.reason === "overflow")).toHaveLength(2);
    await engine.stop();
  });

  it("hydrates cold snapshots and evicts an idle empty Ring only after a durable empty check", async () => {
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    let maintenance: (() => void) | null = null;
    const empty = vi.fn(async () => true);
    const refill: DeliveryEngineRefillPort = {
      load: vi.fn(async () => ({ deliveries: [delivery("cold", 1)], nextRetryAt: null })),
      isDurablyEmpty: empty
    };
    const engine = new ShadowDeliveryEngine({
      refill, now: () => now, idleEvictionMs: 100,
      scheduleMaintenance: (callback) => { maintenance = callback; return 1; }, cancelMaintenance: vi.fn()
    });
    engine.start();
    await settle();
    expect(engine.snapshot()).toMatchObject({ ringCount: 1, cachedItems: 1, lastRefillAt: expect.any(String) });

    const oversizedScope = delivery("oversized", 2).scope;
    engine.enqueue(delivery("oversized", 2, { scope: oversizedScope, bytes: 2_000_000 }));
    await settle();
    expect(engine.snapshot().ringCount).toBe(2);
    now += 101;
    maintenance!();
    await settle();
    expect(empty).toHaveBeenCalledWith(oversizedScope, expect.any(String));
    expect(engine.snapshot().ringCount).toBe(1);
    await engine.stop();
  });

  it("never throws or retains new work after stop", async () => {
    const events: DeliveryEngineEvent[] = [];
    const engine = new ShadowDeliveryEngine({ observer: { record: (event) => events.push(event) } });
    engine.start();
    await engine.stop();
    expect(() => engine.enqueue(delivery("late", 1))).not.toThrow();
    expect(engine.snapshot()).toMatchObject({ state: "stopped", cachedItems: 0 });
    expect(events.at(-1)).toMatchObject({ kind: "enqueue-rejected", reason: "stopped" });
  });

  it("reports a future head and makes it ready on bounded maintenance", async () => {
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    let maintenance: (() => void) | null = null;
    const events: DeliveryEngineEvent[] = [];
    const future = { ...delivery("future", 1), nextAttemptAt: "2026-10-06T00:00:10.000Z" };
    const engine = new ShadowDeliveryEngine({
      observer: { record: (event) => events.push(event) }, now: () => now,
      scheduleMaintenance: (callback) => { maintenance = callback; return 1; }
    });
    engine.start();
    engine.enqueue(future);
    await settle();
    expect(events.some((event) => event.kind === "shadow-grant")).toBe(false);
    expect(engine.snapshot().nextRetryAt).toBe("2026-10-06T00:00:10.000Z");
    now = Date.parse("2026-10-06T00:00:10.000Z");
    maintenance!();
    await settle();
    expect(events.filter((event) => event.kind === "shadow-grant")).toHaveLength(1);
    await engine.stop();
  });

  it("does not evict an empty Ring changed during its durable empty check", async () => {
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    let maintenance: (() => void) | null = null;
    let resolveEmpty!: (empty: boolean) => void;
    const empty = new Promise<boolean>((resolve) => { resolveEmpty = resolve; });
    const scope = delivery("scope", 1).scope;
    const refill: DeliveryEngineRefillPort = { load: async () => ({ deliveries: [], nextRetryAt: null }), isDurablyEmpty: async () => empty };
    const engine = new ShadowDeliveryEngine({
      refill, now: () => now, idleEvictionMs: 100, limits: { paneBytes: 5 },
      scheduleMaintenance: (callback) => { maintenance = callback; return 1; }
    });
    engine.start();
    await settle();
    engine.enqueue(delivery("too-large", 1, { scope, bytes: 6 }));
    now += 101;
    maintenance!();
    engine.enqueue(delivery("now-fits", 2, { scope, bytes: 5 }));
    resolveEmpty(true);
    await settle();
    expect(engine.snapshot()).toMatchObject({ ringCount: 1, cachedItems: 1, cachedBytes: 5 });
    await engine.stop();
  });

  it("waits for an active durable refill before stop settles", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const refill: DeliveryEngineRefillPort = {
      load: async () => { await blocked; return { deliveries: [], nextRetryAt: null }; },
      isDurablyEmpty: async () => true
    };
    const engine = new ShadowDeliveryEngine({ refill });
    engine.start();
    let stopped = false;
    const stopping = engine.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(engine.snapshot().state).toBe("stopped");
  });
});
