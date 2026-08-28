import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import { BridgeRuntimeShutdown } from "../src/runtime/shutdown.js";
import type { ShutdownContext } from "../src/runtime/shutdown-context.js";

describe("bridge runtime shutdown", () => {
  it("waits for async components and closes the store last", async () => {
    const calls: string[] = [];
    let releaseProjector!: () => void;
    const projectorBlocked = new Promise<void>((resolve) => { releaseProjector = resolve; });
    const runtime = new BridgeRuntimeShutdown({
      herdrEventInbox: { async stop() { calls.push("inbox"); } },
      herdrSocketSubscriber: { async stop() { calls.push("subscriber"); } },
      coordinator: { async stop() { calls.push("coordinator"); } },
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
    expect(calls).toEqual(["inbox", "subscriber", "coordinator", "projector:start"]);

    releaseProjector();
    await Promise.all([first, second]);

    expect(calls).toEqual(["inbox", "subscriber", "coordinator", "projector:start", "projector:end", "publisher", "health", "fence", "lease", "store"]);
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

  it("aborts the shared context once at the global deadline and retains SQLite until a writer settles", async () => {
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
    await vi.advanceTimersByTimeAsync(60);
    expect(context?.signal.aborted).toBe(true);
    expect(calls).not.toContain("fence");
    expect(calls).not.toContain("lease");
    expect(calls).not.toContain("store");

    settleWriter();
    await shutdown;
    expect(calls).toEqual(["projector", "publisher", "health", "coordinator:settled", "fence", "lease", "store"]);
    vi.useRealTimers();
  });

  it("retains SQLite ownership until the session reporter settles", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let settleReporter!: () => void;
    const reporter = new Promise<void>((resolve) => { settleReporter = resolve; });
    const runtime = new BridgeRuntimeShutdown({
      traexSessionReporter: { async stop() { calls.push("reporter:start"); await reporter; calls.push("reporter:end"); } },
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

    settleReporter();
    await shutdown;
    expect(calls.slice(-4)).toEqual(["reporter:end", "fence", "lease", "store"]);
    vi.useRealTimers();
  });
});
