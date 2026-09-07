import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { BridgeRuntimeShutdown, cleanupStartupFailure } from "../src/runtime/shutdown.js";
import type { ShutdownContext } from "../src/runtime/shutdown-context.js";

afterEach(() => vi.useRealTimers());

describe("bridge runtime shutdown", () => {
  it("bounds a hung startup integrity stop before releasing SQLite ownership", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let integrityAborted = false;
    const cleanup = cleanupStartupFailure({
      integrityAuditor: { async stop(context) {
        context?.signal.addEventListener("abort", () => { integrityAborted = true; }, { once: true });
        await new Promise(() => {});
      } },
      primaryToolGateway: { async stop() { calls.push("gateway"); } },
      lease: { release() { calls.push("lease"); } },
      store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } },
      logger: { info() {}, error() {} }, shutdownGraceMs: 50, abortSettlementMs: 10
    });

    await vi.advanceTimersByTimeAsync(70);
    await expect(cleanup).resolves.toEqual({ outcome: "completed", unsettledWriters: [] });
    expect(integrityAborted).toBe(true);
    expect(calls).toEqual(["gateway", "fence", "lease", "store"]);
  });

  it("retains startup SQLite ownership when a write-capable stop remains hung", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const cleanup = cleanupStartupFailure({
      primaryToolGateway: { async stop() { await new Promise(() => {}); } },
      lease: { release() { calls.push("lease"); } },
      store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } },
      logger: { info() {}, error() {} }, shutdownGraceMs: 50, abortSettlementMs: 10
    });

    await vi.advanceTimersByTimeAsync(70);
    await expect(cleanup).resolves.toEqual({ outcome: "ownership_retained", unsettledWriters: ["primaryToolGateway"] });
    expect(calls).toEqual([]);
  });

  it("waits for async components and closes the store last", async () => {
    const calls: string[] = [];
    let releaseProjector!: () => void;
    const projectorBlocked = new Promise<void>((resolve) => { releaseProjector = resolve; });
    const runtime = new BridgeRuntimeShutdown({
      herdrSocketSubscriber: { async stop() { calls.push("subscriber"); } },
      coordinator: { async stop() { calls.push("coordinator"); } },
      queueFeedbackProjector: { async stop() { calls.push("queue-feedback"); } },
      projector: { async stop() { calls.push("projector:start"); await projectorBlocked; calls.push("projector:end"); } },
      publisher: { async stop() { calls.push("publisher"); } },
      healthServer: { close(callback) { calls.push("health"); callback(); } },
      lease: { release() { calls.push("lease"); } },
      store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } },
      logger: { info() {}, error() {} }
    });

    const first = runtime.shutdown("SIGTERM");
    const second = runtime.shutdown("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["subscriber", "coordinator", "queue-feedback", "projector:start"]);

    releaseProjector();
    await Promise.all([first, second]);

    expect(calls).toEqual(["subscriber", "coordinator", "queue-feedback", "projector:start", "projector:end", "publisher", "health", "fence", "lease", "store"]);
  });

  it("stops periodic and external writers before releasing SQLite ownership", async () => {
    const calls: string[] = [];
    const runtime = new BridgeRuntimeShutdown({
      herdrSocketSubscriber: { async stop() { calls.push("subscriber"); } },
      paneRetention: { async stop() { calls.push("pane-retention"); } },
      externalTurns: { async stop() { calls.push("external-turns"); } },
      outboxRetention: { async stop() { calls.push("outbox-retention"); } },
      coordinator: { async stop() { calls.push("coordinator"); } },
      projector: { async stop() { calls.push("projector"); } },
      publisher: { async stop() { calls.push("publisher"); } },
      healthServer: { close(callback) { calls.push("health"); callback(); } },
      lease: { release() { calls.push("lease"); } },
      store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } },
      logger: { info() {}, error() {} }
    });

    await runtime.shutdown("lease-lost");

    expect(calls).toEqual([
      "subscriber", "pane-retention", "external-turns", "coordinator",
      "outbox-retention", "projector", "publisher", "health", "fence", "lease", "store"
    ]);
  });

  it("continues releasing resources when an earlier stop fails", async () => {
    const calls: string[] = [];
    const errors: string[] = [];
    const runtime = new BridgeRuntimeShutdown({
      coordinator: { async stop() { calls.push("coordinator"); throw new Error("coordinator failed"); } },
      projector: { async stop() { calls.push("projector"); } },
      publisher: { async stop() { calls.push("publisher"); } },
      healthServer: { close(callback) { calls.push("health"); callback(); } },
      lease: { release() { calls.push("lease"); } },
      store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } },
      logger: { info() {}, error(value) { errors.push(String(value.component)); } }
    });

    await runtime.shutdown("SIGTERM");

    expect(calls).toEqual(["coordinator", "projector", "publisher", "health", "fence", "lease", "store"]);
    expect(errors).toEqual(["coordinator"]);
  });

  it("still closes later resources after the coordinator performs bounded cancellation", async () => {
    const calls: string[] = [];
    const runtime = new BridgeRuntimeShutdown({
      coordinator: { async stop() { calls.push("coordinator:abort"); } },
      projector: { async stop() { calls.push("projector"); } },
      publisher: { async stop() { calls.push("publisher"); } },
      healthServer: { close(callback) { calls.push("health"); callback(); } },
      lease: { release() { calls.push("lease"); } },
      store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } },
      logger: { info() {}, error() {} }
    });

    await runtime.shutdown("SIGTERM");
    expect(calls).toEqual(["coordinator:abort", "projector", "publisher", "health", "fence", "lease", "store"]);
  });

  it("shares one immutable deadline context across write-capable shutdown components", async () => {
    const contexts: ShutdownContext[] = [];
    const runtime = new BridgeRuntimeShutdown({
      coordinator: { async stop(context) { contexts.push(context!); } },
      projector: { async stop(context) { contexts.push(context!); } },
      publisher: { async stop(context) { contexts.push(context!); } },
      healthServer: { close(callback) { callback(); } },
      lease: { release() {} }, store: { deactivateWriteFence() {}, close() {} },
      logger: { info() {}, error() {} }, shutdownGraceMs: 1_000
    });

    const first = runtime.shutdown("SIGTERM");
    const second = runtime.shutdown("SIGINT");
    expect(first).toBe(second);
    await first;

    expect(contexts).toHaveLength(3);
    expect(contexts[0]).toBe(contexts[1]);
    expect(contexts[1]).toBe(contexts[2]);
    expect(contexts[0]!.remainingMs()).toBeLessThanOrEqual(1_000);
  });

  it("stops the integrity auditor within the shared shutdown context", async () => {
    const contexts: ShutdownContext[] = [];
    const runtime = new BridgeRuntimeShutdown({
      integrityAuditor: { async stop(context) { contexts.push(context!); } },
      coordinator: { async stop(context) { contexts.push(context!); } },
      projector: { async stop() {} }, publisher: { async stop() {} },
      healthServer: { close(callback) { callback(); } },
      lease: { release() {} }, store: { deactivateWriteFence() {}, close() {} },
      logger: { info() {}, error() {} }
    });

    await runtime.shutdown("SIGTERM");
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toBe(contexts[1]);
  });

  it("stops instance reconciliation within the shared shutdown deadline before releasing SQLite", async () => {
    const calls: string[] = [];
    const runtime = new BridgeRuntimeShutdown({
      instanceRuntime: { async stop() { calls.push("instance-runtime"); } },
      coordinator: { async stop() { calls.push("coordinator"); } }, projector: { async stop() { calls.push("projector"); } }, publisher: { async stop() { calls.push("publisher"); } },
      healthServer: { close(callback) { calls.push("health"); callback(); } }, lease: { release() { calls.push("lease"); } }, store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } },
      logger: { info() {}, error() {} }
    });
    await runtime.shutdown("SIGTERM");
    expect(calls.indexOf("instance-runtime")).toBeLessThan(calls.indexOf("fence"));
    expect(calls.slice(-3)).toEqual(["fence", "lease", "store"]);
  });

  it("stops the primary tool gateway before releasing SQLite", async () => {
    const calls: string[] = [];
    const runtime = new BridgeRuntimeShutdown({
      primaryToolGateway: { async stop() { calls.push("primary-tools"); } },
      coordinator: { async stop() {} }, projector: { async stop() {} }, publisher: { async stop() {} }, healthServer: { close(callback) { callback(); } },
      lease: { release() { calls.push("lease"); } }, store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } }, logger: { info() {}, error() {} }
    });
    await runtime.shutdown("SIGTERM");
    expect(calls).toEqual(["primary-tools", "fence", "lease", "store"]);
  });

  it("returns after the final settlement allowance and retains SQLite ownership when a writer is stuck", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let settleWriter!: () => void;
    const writer = new Promise<void>((resolve) => { settleWriter = resolve; });
    let context: ShutdownContext | undefined;
    const runtime = new BridgeRuntimeShutdown({
      coordinator: { async stop(value) { context = value; await writer; calls.push("coordinator:settled"); } },
      projector: { async stop() { calls.push("projector"); } },
      publisher: { async stop() { calls.push("publisher"); } },
      healthServer: { close(callback) { calls.push("health"); callback(); } },
      lease: { release() { calls.push("lease"); } },
      store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } },
      logger: { info() {}, warn() {}, error() {} }, shutdownGraceMs: 50, abortSettlementMs: 10
    });

    const shutdown = runtime.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(70);
    expect(context?.signal.aborted).toBe(true);
    expect(calls).not.toContain("fence");
    expect(calls).not.toContain("lease");
    expect(calls).not.toContain("store");

    await expect(shutdown).resolves.toEqual({ outcome: "ownership_retained", unsettledWriters: ["coordinator"] });
    expect(calls).toEqual(["projector", "publisher", "health"]);
    settleWriter();
    await Promise.resolve();
    vi.useRealTimers();
  });

  it("returns ownership retained when the primary tool gateway does not settle", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let settleGateway!: () => void;
    const gateway = new Promise<void>((resolve) => { settleGateway = resolve; });
    const runtime = new BridgeRuntimeShutdown({
      primaryToolGateway: { async stop() { calls.push("gateway:start"); await gateway; calls.push("gateway:end"); } },
      coordinator: { async stop() { calls.push("coordinator"); } },
      projector: { async stop() { calls.push("projector"); } },
      publisher: { async stop() { calls.push("publisher"); } },
      healthServer: { close(callback) { calls.push("health"); callback(); } },
      lease: { release() { calls.push("lease"); } },
      store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } },
      logger: { info() {}, warn() {}, error() {} }, shutdownGraceMs: 50, abortSettlementMs: 10
    });

    const shutdown = runtime.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(70);
    expect(calls).not.toContain("fence");
    expect(calls).not.toContain("lease");
    expect(calls).not.toContain("store");

    await expect(shutdown).resolves.toEqual({ outcome: "ownership_retained", unsettledWriters: ["primaryToolGateway"] });
    settleGateway();
    await Promise.resolve();
    vi.useRealTimers();
  });

  it("retains SQLite ownership when external turn observation does not settle", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let settleObserver!: () => void;
    const observer = new Promise<void>((resolve) => { settleObserver = resolve; });
    const runtime = new BridgeRuntimeShutdown({
      externalTurns: { async stop() { calls.push("external-turns:start"); await observer; calls.push("external-turns:end"); } },
      coordinator: { async stop() { calls.push("coordinator"); } },
      projector: { async stop() { calls.push("projector"); } },
      publisher: { async stop() { calls.push("publisher"); } },
      healthServer: { close(callback) { calls.push("health"); callback(); } },
      lease: { release() { calls.push("lease"); } },
      store: { deactivateWriteFence() { calls.push("fence"); }, close() { calls.push("store"); } },
      logger: { info() {}, warn() {}, error() {} }, shutdownGraceMs: 50, abortSettlementMs: 10
    });

    const shutdown = runtime.shutdown("lease-lost");
    await vi.advanceTimersByTimeAsync(70);

    await expect(shutdown).resolves.toEqual({ outcome: "ownership_retained", unsettledWriters: ["externalTurns"] });
    expect(calls).not.toContain("fence");
    expect(calls).not.toContain("lease");
    expect(calls).not.toContain("store");
    settleObserver();
    await Promise.resolve();
  });
});
