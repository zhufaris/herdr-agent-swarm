import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedBridgeRuntime, type ManagedBridgeRuntimeDependencies } from "../src/composition/managed-bridge-runtime.js";

function fixture(overrides: Partial<ManagedBridgeRuntimeDependencies> = {}) {
  const calls: string[] = [];
  let onLeaseLost: (() => void | Promise<void>) | null = null;
  const mark = (value: string) => { calls.push(value); };
  const dependencies: ManagedBridgeRuntimeDependencies = {
    reconcileIntervalMs: 5_000,
    store: { activateWriteFence() { mark("fence:start"); }, deactivateWriteFence() { mark("fence:stop"); }, close() { mark("store:close"); } },
    lease: { acquire() { mark("lease:acquire"); }, writeFence() { return { ownerId: "owner", fencingToken: 1 }; }, start(callback) { mark("lease:start"); onLeaseLost = callback; }, release() { mark("lease:release"); } },
    primaryToolGateway: { async start() { mark("primary-tools:start"); }, async stop() { mark("primary-tools:stop"); } },
    naturalLanguageCommands: { async start() { mark("natural-language:start"); }, async stop() { mark("natural-language:stop"); }, async interpret() { return { outcome: "unresolved" as const }; } },
    sqliteIntegrity: { start() { mark("integrity:start"); }, async run() { mark("integrity:run"); }, async stop() { mark("integrity:stop"); } },
    instanceRuntime: { async reconcile() { mark("instance-runtime:reconcile"); }, start() { mark("instance-runtime:start"); }, async stop() { mark("instance-runtime:stop"); } },
    instanceTurns: { prepareRecovery() { mark("instance-turns:prepare"); }, async reconcile() { mark("instance-turns:reconcile"); }, start() { mark("instance-turns:start"); }, async stop() { mark("instance-turns:stop"); } },
    instanceWork: { async stop() { mark("instance-work:stop"); } },
    createHealthServer: async () => { mark("health:start"); return { close(callback) { mark("health:stop"); callback(); } }; },
    channelPublisher: { start() { mark("publisher:start"); }, async stop() { mark("publisher:stop"); } },
    outboxRetention: { start() { mark("outbox-retention:start"); }, async stop() { mark("outbox-retention:stop"); } },
    projector: { start() { mark("projector:start"); }, async stop() { mark("projector:stop"); } },
    cardContextRebuilder: { start() { mark("card-context:start"); }, async stop() { mark("card-context:stop"); } },
    queueFeedbackProjector: { start() { mark("queue-feedback:start"); }, async converge() { mark("queue-feedback:converge"); }, async stop() { mark("queue-feedback:stop"); } },
    bus: {},
    coordinator: { async prepareDelivery() { mark("coordinator:prepare-delivery"); }, async start() { mark("coordinator:start"); }, async stop() { mark("coordinator:stop"); } },
    paneRetention: { async scan() { mark("pane-retention:scan"); }, start() { mark("pane-retention:start"); }, async stop() { mark("pane-retention:stop"); } },
    externalTurns: { start() { mark("external-turns:start"); }, async stop() { mark("external-turns:stop"); } },
    herdrSocketSubscriber: { startEvents() { mark("socket:start"); }, async stop() { mark("socket:stop"); } },
    logger: { info() {}, warn() {}, error() {} },
    ...overrides
  };
  return { runtime: new ManagedBridgeRuntime(dependencies), runtimeDependencies: dependencies, calls, loseLease: async () => { await onLeaseLost?.(); } };
}

afterEach(() => vi.useRealTimers());

describe("ManagedBridgeRuntime", () => {
  it("starts the bridge in ownership, recovery, delivery, ingress, and observation order", async () => {
    const { runtime, calls } = fixture();

    await runtime.start();

    expect(calls).toEqual([
      "lease:acquire", "fence:start", "lease:start",
      "instance-turns:prepare", "primary-tools:start", "natural-language:start", "integrity:start", "integrity:run",
      "instance-runtime:reconcile", "instance-turns:reconcile", "health:start",
      "coordinator:prepare-delivery",
      "publisher:start", "outbox-retention:start", "projector:start", "card-context:start",
      "queue-feedback:start", "queue-feedback:converge", "coordinator:start",
      "pane-retention:scan", "pane-retention:start", "external-turns:start",
      "instance-runtime:start", "instance-turns:start", "socket:start"
    ]);
  });

  it("completes durable startup repair before the publisher can claim work", async () => {
    let releaseRepair!: () => void;
    const repair = new Promise<void>((resolve) => { releaseRepair = resolve; });
    const { runtime, calls } = fixture({
      coordinator: {
        async prepareDelivery() { calls.push("coordinator:prepare-delivery"); await repair; },
        async start() { calls.push("coordinator:start"); },
        async stop() { calls.push("coordinator:stop"); }
      }
    });

    const starting = runtime.start();
    await vi.waitFor(() => expect(calls).toContain("coordinator:prepare-delivery"));
    expect(calls).not.toContain("publisher:start");
    releaseRepair();
    await starting;
    expect(calls.indexOf("coordinator:prepare-delivery")).toBeLessThan(calls.indexOf("publisher:start"));
  });

  it("does not reacquire a lease handed off by production bootstrap", async () => {
    const { runtimeDependencies, calls } = fixture();
    const runtime = new ManagedBridgeRuntime(runtimeDependencies, { leaseAlreadyAcquired: true });

    await runtime.start();

    expect(calls).not.toContain("lease:acquire");
    expect(calls.slice(0, 2)).toEqual(["fence:start", "lease:start"]);
    await runtime.stop("SIGTERM");
  });

  it("returns the same start promise without starting components twice", async () => {
    const { runtime, calls } = fixture();

    const first = runtime.start();
    const second = runtime.start();

    expect(second).toBe(first);
    await first;
    expect(calls.filter((call) => call === "coordinator:start")).toHaveLength(1);
    expect(calls.filter((call) => call === "socket:start")).toHaveLength(1);
  });

  it("uses one idempotent shutdown for a signal and lease loss", async () => {
    const onFatalStop = vi.fn();
    const { runtime, calls, loseLease } = fixture({ onFatalStop });
    await runtime.start();
    calls.length = 0;

    const signalStop = runtime.stop("SIGTERM");
    const duplicate = runtime.stop("SIGINT");
    await loseLease();

    expect(duplicate).toBe(signalStop);
    await expect(signalStop).resolves.toEqual({ outcome: "completed", unsettledWriters: [] });
    expect(calls).toEqual([
      "socket:stop", "natural-language:stop", "primary-tools:stop", "external-turns:stop", "pane-retention:stop",
      "instance-turns:stop", "instance-runtime:stop", "instance-work:stop", "coordinator:stop",
      "integrity:stop", "queue-feedback:stop", "card-context:stop", "projector:stop",
      "outbox-retention:stop", "publisher:stop", "health:stop", "fence:stop", "lease:release", "store:close"
    ]);
    expect(onFatalStop).toHaveBeenCalledWith("lease-lost", { outcome: "completed", unsettledWriters: [] });
  });

  it("cleans up only possibly started components when health creation fails", async () => {
    const calls: string[] = [];
    const base = fixture();
    const runtime = new ManagedBridgeRuntime({
      ...base.runtimeDependencies,
      createHealthServer: async () => { calls.push("health:start"); throw new Error("bind failed"); },
      primaryToolGateway: { async start() { calls.push("primary-tools:start"); }, async stop() { calls.push("primary-tools:stop"); } },
      naturalLanguageCommands: { async start() { calls.push("natural-language:start"); }, async stop() { calls.push("natural-language:stop"); }, async interpret() { return { outcome: "unresolved" as const }; } },
      sqliteIntegrity: { start() { calls.push("integrity:start"); }, async run() { calls.push("integrity:run"); }, async stop() { calls.push("integrity:stop"); } },
      instanceRuntime: { async reconcile() { calls.push("instance-runtime:reconcile"); }, start() { calls.push("instance-runtime:start"); }, async stop() { calls.push("instance-runtime:stop"); } },
      instanceTurns: { prepareRecovery() { calls.push("instance-turns:prepare"); }, async reconcile() { calls.push("instance-turns:reconcile"); }, start() { calls.push("instance-turns:start"); }, async stop() { calls.push("instance-turns:stop"); } },
      store: { activateWriteFence() { calls.push("fence:start"); }, deactivateWriteFence() { calls.push("fence:stop"); }, close() { calls.push("store:close"); } },
      lease: { acquire() { calls.push("lease:acquire"); }, writeFence() { return { ownerId: "owner", fencingToken: 1 }; }, start() { calls.push("lease:start"); }, release() { calls.push("lease:release"); } }
    });

    await expect(runtime.start()).rejects.toThrow("bind failed");

    expect(calls).toEqual([
      "lease:acquire", "fence:start", "lease:start", "instance-turns:prepare",
      "primary-tools:start", "natural-language:start", "integrity:start", "integrity:run",
      "instance-runtime:reconcile", "instance-turns:reconcile", "health:start",
      "natural-language:stop", "primary-tools:stop", "integrity:stop", "fence:stop", "lease:release", "store:close"
    ]);
  });

  it("closes the store without releasing an unowned lease when acquisition fails", async () => {
    const calls: string[] = [];
    const base = fixture();
    const runtime = new ManagedBridgeRuntime({
      ...base.runtimeDependencies,
      store: { activateWriteFence() { calls.push("fence:start"); }, deactivateWriteFence() { calls.push("fence:stop"); }, close() { calls.push("store:close"); } },
      lease: { acquire() { calls.push("lease:acquire"); throw new Error("contended"); }, writeFence() { throw new Error("not owned"); }, start() {}, release() { calls.push("lease:release"); } }
    });

    await expect(runtime.start()).rejects.toThrow("contended");

    expect(calls).toEqual(["lease:acquire", "store:close"]);
  });

  it("does not start later phases when shutdown begins during startup", async () => {
    let releaseIntegrity!: () => void;
    const integrityRun = new Promise<void>((resolve) => { releaseIntegrity = resolve; });
    const { runtime, calls } = fixture({
      sqliteIntegrity: { start() { calls.push("integrity:start"); }, async run() { calls.push("integrity:run"); await integrityRun; }, async stop() { calls.push("integrity:stop"); releaseIntegrity(); } }
    });

    const starting = runtime.start();
    await vi.waitFor(() => expect(calls).toContain("integrity:run"));
    const stopping = runtime.stop("SIGTERM");

    await expect(stopping).resolves.toEqual({ outcome: "completed", unsettledWriters: [] });
    await expect(starting).rejects.toThrow("startup interrupted");
    expect(calls).not.toContain("instance-runtime:reconcile");
    expect(calls).not.toContain("health:start");
  });

  it("does not start recovery when lease loss is reported synchronously", async () => {
    const { runtime, calls } = fixture({
      lease: {
        acquire() { calls.push("lease:acquire"); },
        writeFence() { return { ownerId: "owner", fencingToken: 1 }; },
        start(onLost) { calls.push("lease:start"); void onLost(); },
        release() { calls.push("lease:release"); }
      }
    });

    await expect(runtime.start()).rejects.toThrow("startup interrupted");
    await expect(runtime.stop("lease-lost")).resolves.toEqual({ outcome: "completed", unsettledWriters: [] });
    expect(calls).not.toContain("instance-turns:prepare");
    expect(calls).not.toContain("primary-tools:start");
  });

  it.each([
    ["primary tools", { primaryToolGateway: { async start() { throw new Error("primary failed"); }, async stop() {} } }, ["fence:stop", "lease:release", "store:close"]],
    ["integrity audit", { sqliteIntegrity: { start() {}, async run() { throw new Error("integrity failed"); }, async stop() {} } }, ["primary-tools:stop", "fence:stop", "lease:release", "store:close"]],
    ["queue convergence", { queueFeedbackProjector: { start() {}, async converge() { throw new Error("queue failed"); }, async stop() {} } }, ["outbox-retention:stop", "card-context:stop", "projector:stop", "publisher:stop", "health:stop", "fence:stop", "lease:release", "store:close"]],
    ["pane scan", { paneRetention: { async scan() { throw new Error("scan failed"); }, start() {}, async stop() {} } }, ["coordinator:stop", "outbox-retention:stop", "health:stop", "fence:stop", "lease:release", "store:close"]]
  ])("cleans up the started prefix when %s startup fails", async (_phase, overrides, expectedCalls) => {
    const { runtime, calls } = fixture(overrides as Partial<ManagedBridgeRuntimeDependencies>);

    await expect(runtime.start()).rejects.toThrow("failed");

    for (const call of expectedCalls as string[]) expect(calls).toContain(call);
    expect(calls.indexOf("fence:stop")).toBeLessThan(calls.indexOf("lease:release"));
    expect(calls.indexOf("lease:release")).toBeLessThan(calls.indexOf("store:close"));
  });

  it("stops a coordinator whose asynchronous start partially fails", async () => {
    const stop = vi.fn(async () => {});
    const { runtime } = fixture({ coordinator: { async prepareDelivery() {}, async start() { throw new Error("coordinator failed"); }, stop } });

    await expect(runtime.start()).rejects.toThrow("coordinator failed");

    expect(stop).toHaveBeenCalledOnce();
  });

  it("retains ownership and reports the result when lease-loss shutdown cannot settle a writer", async () => {
    vi.useFakeTimers();
    const onFatalStop = vi.fn();
    const { runtime, calls, loseLease } = fixture({
      externalTurns: { start() { calls.push("external-turns:start"); }, async stop() { await new Promise(() => {}); } },
      onFatalStop
    });
    await runtime.start();
    calls.length = 0;

    const losingLease = loseLease();
    await vi.advanceTimersByTimeAsync(31_100);
    await losingLease;

    const result = { outcome: "ownership_retained", unsettledWriters: ["externalTurns"] };
    expect(onFatalStop).toHaveBeenCalledWith("lease-lost", result);
    expect(calls).not.toContain("fence:stop");
    expect(calls).not.toContain("lease:release");
    expect(calls).not.toContain("store:close");
  });

  it("releases ownership when closing the health server fails", async () => {
    const errors: string[] = [];
    const base = fixture();
    const runtime = new ManagedBridgeRuntime({
      ...base.runtimeDependencies,
      createHealthServer: async () => ({ close(callback) { callback(new Error("close failed")); } }),
      logger: { info() {}, error(value) { errors.push(String(value.component)); } }
    });

    await runtime.start();
    await expect(runtime.stop("SIGTERM")).resolves.toEqual({ outcome: "completed", unsettledWriters: [] });

    expect(errors).toContain("healthServer");
    expect(base.calls.slice(-3)).toEqual(["fence:stop", "lease:release", "store:close"]);
  });
});
