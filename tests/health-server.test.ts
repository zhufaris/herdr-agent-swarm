import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHealthServer } from "../src/health/server.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

let server: Awaited<ReturnType<typeof startHealthServer>> | undefined;
let store: SqliteBindingStore | undefined;
afterEach(async () => {
  if (server) { server.close(); await once(server, "close"); server = undefined; }
  store?.close(); store = undefined;
});

describe("health server", () => {
  const buildIdentity = { serviceId: "herdr-agent-swarm" as const, version: "0.2.0", buildId: "sha256:test-build", gitCommit: null };
  const reconciliationSnapshot = { state: "idle" as const, runCount: 3, successCount: 2, failureCount: 1, coalescedRequestCount: 4, lastStartedAt: "2026-08-29T00:00:00.000Z", lastCompletedAt: "2026-08-29T00:00:00.025Z", lastDurationMs: 25, maxDurationMs: 40, lastOutcome: "succeeded" as const };

  it("reports card convergence scheduler diagnostics without changing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const cardConvergence = { pending: 2, pendingByFamily: { answer: 1, main: 1, unknown: 0 }, inFlight: 1, coalesced: 7, failures: 1, oldestPendingAgeMs: 850, lastSuccessfulFlushAt: "2026-08-30T00:00:00.000Z" };
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never, cardConvergence: { snapshot: () => cardConvergence },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({ status: "ok", cardConvergence });
  });

  it("reports both reconciliation snapshots without changing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      bindingRuntime: { snapshot: () => reconciliationSnapshot },
      instanceRuntime: { snapshot: () => ({ ...reconciliationSnapshot, ready: true, lastError: null }) }, readinessTtlMs: 0,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "ok", readiness: { status: "ready" }, reconciliation: { bindingRuntime: reconciliationSnapshot, instanceRuntime: reconciliationSnapshot }
    });
  });

  it("isolates reconciliation snapshot failures and degrades only status", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      bindingRuntime: { snapshot: () => { throw new Error("x".repeat(600)); } },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    const body = await (await fetch(`http://127.0.0.1:${port}/status`)).json() as { status: string; reconciliation: { bindingRuntime: { error: string } } };
    expect(body.status).toBe("degraded");
    expect(body.reconciliation.bindingRuntime.error).toHaveLength(500);
  });

  it("degrades status for a failed Binding reconciliation pass without changing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      bindingRuntime: { snapshot: () => ({ ...reconciliationSnapshot, lastOutcome: "failed" as const, lastFailures: [{ workspaceId: "w1", message: "discovery unavailable" }] }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", readiness: { status: "ready" }, reconciliation: { bindingRuntime: { lastOutcome: "failed", lastFailures: [{ workspaceId: "w1" }] } }
    });
  });

  it("reports every readiness component and exposes a safe operational status", async () => {
    store = new SqliteBindingStore(":memory:");
    const projects = [{ id: "missing", displayName: "Missing", description: "Missing", workspaceId: "w1", cwd: "/definitely/missing/project" }];
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects, lark: { isReady: () => false } as never,
      herdr: { async assertWorkspace() { throw new Error("workspace unavailable"); } } as never,
      promptWorker: { snapshot: () => ({ state: "running", activeTurnWorkers: 0, lastScanAt: "2026-08-24T00:00:00.000Z", lastScanOutcome: "idle", lastDiscovered: { turns: 0, detached: 0, recoveredClaims: 0, cancelled: 0, failedDetached: 0 }, lastScanFailureAt: null, currentSafetyScanDelayMs: 10_000, nextSafetyScanAt: "2026-08-24T00:00:10.000Z" }) },
      outboxDispatcher: { snapshot: () => ({ state: "idle", activeDeliveries: 0, scanPending: false, lastScanAt: null, lastScanOutcome: null, lastDeliveryAt: null, lastDeliveryFailureAt: null }) },
      herdrSocket: { status: () => ({ connected: true, eventsConnected: true, requests: 4, responses: 3, requestFailures: 1, transportFailures: 0, pendingRequests: 0 }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await health.json()).toEqual({ status: "ok", serviceId: "herdr-agent-swarm", version: "0.2.0", buildId: "sha256:test-build" });

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: "not_ready", components: {
      database: { ok: true }, projects: { ok: false }, lark: { ok: false },
      herdr: { ok: false, workspaces: [{ workspaceId: "w1", ok: false }] },
      lease: { ok: true, held: true, fencingToken: 4 }
    } });

    const status = await fetch(`http://127.0.0.1:${port}/status`);
    expect(status.status).toBe(200);
    const body = await status.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: "degraded", identity: buildIdentity, readiness: { status: "not_ready" }, operational: { pendingOutbox: 0, deadLetters: 0, queueFeedback: { withEstimate: 0, withoutEstimate: 0 }, promptLatency: { windowSize: 100, sampleCount: 0, queue: { averageMs: null }, execution: { averageMs: null }, delivery: { averageMs: null } }, outboxLanes: { pending: 0, eligible: 0, blocked: 0, nextAttemptAt: null, oldestHeadAt: null, oldestHeadAgeSeconds: null } }, outboxDispatcher: { state: "idle", activeDeliveries: 0 }, promptWorker: { state: "running", activeTurnWorkers: 0, lastScanOutcome: "idle", currentSafetyScanDelayMs: 10_000, nextSafetyScanAt: "2026-08-24T00:00:10.000Z" }, herdrSocket: { connected: true, eventsConnected: true, requests: 4, responses: 3, requestFailures: 1, transportFailures: 0, pendingRequests: 0 } });
    expect(body).toHaveProperty("uptimeSeconds");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("lease.ownerSuffix", "owner123");
    expect(JSON.stringify(body)).not.toContain("payload");
  });

  it("reports the inbound dispatcher and degrades for a stale durable backlog", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), inbound: {
      states: { received: 2, processing: 0, accepted: 4 }, retryable: 1, oldestPendingAt: "2026-08-31T12:00:00.000Z", oldestPendingAgeSeconds: 600,
      recentFailure: { eventId: "event-1", updatedAt: "2026-08-31T12:09:00.000Z", error: "temporary failure" }
    } });
    const inboundDispatcher = { snapshot: () => ({ state: "retry_wait" as const, drainRequested: false, retryAttempt: 3, nextRetryAt: "2026-08-31T12:10:02.000Z", lastAcceptedAt: null, lastFailureAt: "2026-08-31T12:10:00.000Z", lastFailure: "temporary failure" }) };
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never, inboundDispatcher,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });

    expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status`)).json()).toMatchObject({
      status: "degraded", operational: { inbound: { states: { received: 2 }, oldestPendingAgeSeconds: 600 } },
      inboundDispatcher: { state: "retry_wait", retryAttempt: 3, lastFailure: "temporary failure" }
    });
  });

  it("reports Session operation dispatcher diagnostics without exposing operation arguments", async () => {
    store = new SqliteBindingStore(":memory:");
    const snapshot = { state: "running" as const, activeOperations: 1, drainRequested: true, lastCompletedAt: null, lastFailureAt: null, lastFailure: null };
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never, sessionOperationDispatcher: { snapshot: () => snapshot },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });

    const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status`)).json();
    expect(body).toMatchObject({ status: "ok", sessionOperationDispatcher: snapshot, operational: { sessionOperations: { states: { accepted: 0, running: 0, uncertain: 0 } } } });
    expect(JSON.stringify(body)).not.toContain("argument");
  });

  it("reports and degrades active or uncertain instance work", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      instanceWorker: { snapshot: () => ({ state: "running", activeDispatchWorkers: 1, activeObservers: 1, queuedTurns: 2, activeTurns: 1, uncertainTurns: 1, lastScanAt: "2026-08-29T00:00:00.000Z", lastFailureAt: null, lastFailure: null }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status`)).json();
    expect(body).toMatchObject({ status: "degraded", instanceWorker: { activeDispatchWorkers: 1, activeObservers: 1, activeTurns: 1, uncertainTurns: 1 } });
  });

  it("shares one short-lived readiness probe across concurrent ready and status requests", async () => {
    store = new SqliteBindingStore(":memory:");
    const assertWorkspace = vi.fn(async () => undefined);
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { assertWorkspace } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;
    await Promise.all([fetch(`http://127.0.0.1:${port}/ready`), fetch(`http://127.0.0.1:${port}/status`)]);
    expect(assertWorkspace).toHaveBeenCalledOnce();
  });

  it("refreshes volatile readiness state while reusing the workspace probe", async () => {
    store = new SqliteBindingStore(":memory:");
    const assertWorkspace = vi.fn(async () => undefined);
    let larkReady = true;
    let leaseHeld = true;
    let runtimeReady = true;
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => larkReady } as never, herdr: { assertWorkspace } as never, readinessTtlMs: 60_000,
      lease: { snapshot: () => ({ held: leaseHeld, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: leaseHeld ? null : "lease lost" }) },
      instanceRuntime: { snapshot: () => ({ ready: runtimeReady, lastError: runtimeReady ? null : "runtime stale" }) }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    larkReady = false; leaseHeld = false; runtimeReady = false;
    const response = await fetch(`http://127.0.0.1:${port}/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready", components: { lark: { ok: false }, lease: { ok: false }, instanceRuntime: { ok: false } } });
    expect(assertWorkspace).toHaveBeenCalledOnce();
  });

  it("degrades status for SQLite inconsistencies without failing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) },
      sqliteIntegrity: { snapshot: () => ({ state: "degraded", quickCheck: "ok", issues: [{ rule: "outbox_lane_missing_head", table: "outbox_lane_heads", count: 1 }], truncated: false, startedAt: "2026-08-26T00:00:00.000Z", completedAt: "2026-08-26T00:00:00.010Z", durationMs: 10, error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({ status: "degraded", readiness: { status: "ready" }, sqliteIntegrity: { state: "degraded", issues: [{ rule: "outbox_lane_missing_head", count: 1 }] } });
  });

  it("keeps status degraded while rechecking a previously failed SQLite audit", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) },
      sqliteIntegrity: { snapshot: () => ({ state: "running", quickCheck: "ok", issues: [{ rule: "sqlite_foreign_key", table: "run_cards", count: 1 }], truncated: false, startedAt: "2026-08-26T00:15:00.000Z", completedAt: "2026-08-26T00:00:00.010Z", durationMs: 10, error: null }) },
      buildIdentity
    });

    expect(await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status`)).json()).toMatchObject({ status: "degraded", sqliteIntegrity: { state: "running" } });
  });

  it("becomes not ready when lease ownership is lost", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: false, ownerSuffix: "owner123", fencingToken: 4, expiresAt: null, lastRenewedAt: null, error: "fence changed" }) },
      buildIdentity
    });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready", components: { lease: { ok: false, held: false, error: "fence changed" } } });
  });

  it("fails readiness closed when lease diagnostics throw and reads the lease once per request", async () => {
    store = new SqliteBindingStore(":memory:");
    const snapshot = vi.fn(() => { throw new Error("lease diagnostics failed"); });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: "not_ready", components: { lease: { ok: false, held: false, fencingToken: null, error: "lease diagnostics failed" } } });
    expect(snapshot).toHaveBeenCalledTimes(1);

    const status = await fetch(`http://127.0.0.1:${port}/status`);
    expect(status.status).toBe(200);
    const statusBody = await status.json() as { status: string; readiness: { status: string; components: { lease: object } }; lease: object };
    expect(statusBody).toMatchObject({ status: "degraded", readiness: { status: "not_ready", components: { lease: { ok: false, held: false, error: "lease diagnostics failed" } } }, lease: { held: false, error: "lease diagnostics failed" } });
    expect(statusBody.lease).not.toHaveProperty("ok");
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("fails readiness closed for runtime and Lark diagnostic exceptions without double-reading runtime", async () => {
    store = new SqliteBindingStore(":memory:");
    const runtimeSnapshot = vi.fn(() => { throw new Error("runtime diagnostics failed"); });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady() { throw new Error("Lark readiness failed"); } } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) },
      instanceRuntime: { snapshot: runtimeSnapshot }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ status: "not_ready", components: { lark: { ok: false, error: "Lark readiness failed" }, instanceRuntime: { ok: false, error: "runtime diagnostics failed" } } });
    expect(runtimeSnapshot).toHaveBeenCalledTimes(1);

    const status = await fetch(`http://127.0.0.1:${port}/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "degraded", reconciliation: { instanceRuntime: { error: "runtime diagnostics failed" } } });
    expect(runtimeSnapshot).toHaveBeenCalledTimes(2);
  });

  it("stays not ready until instance runtime reconciliation completes", async () => {
    store = new SqliteBindingStore(":memory:");
    const runtime = { snapshot: vi.fn(() => ({ ready: false, lastError: "startup snapshot pending" })) };
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never, instanceRuntime: runtime, readinessTtlMs: 0,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/ready`)).json()).toMatchObject({ status: "not_ready", components: { instanceRuntime: { ok: false, error: "startup snapshot pending" } } });
    runtime.snapshot.mockReturnValue({ ready: true, lastError: null });
    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
  });

  it("degrades status for a long-lived cleanup without failing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), retiredPaneCleanup: {
      states: { pending: 0, waiting_busy: 1, executing: 0, succeeded: 0, retained: 0 },
      oldestActiveAt: "2026-08-24T00:00:00.000Z", oldestActiveAgeSeconds: 600, latestOutcome: null
    } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({ status: "degraded", readiness: { status: "ready" }, operational: { retiredPaneCleanup: { oldestActiveAgeSeconds: 600 } } });
  });

  it("degrades status for eligible transient dead-letter recovery without failing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), eligibleDeadLetterRecoveries: 1, deadLettersByClass: { transient: 1, permanent: 0, unknown: 0, legacy: 0 } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({ status: "degraded", readiness: { status: "ready" }, operational: { eligibleDeadLetterRecoveries: 1, deadLettersByClass: { transient: 1 } } });
  });

  it("degrades status for an active outbox quarantine without failing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), outboxQuarantines: {
      ...originalSummary().outboxQuarantines, active: 1
    } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({ status: "degraded", readiness: { status: "ready" }, operational: { outboxQuarantines: { active: 1 } } });
  });

  it("degrades status for an active Lark cooldown without failing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), larkDeliveryCooldown: {
      active: true, blockedUntil: "2099-01-01T00:00:07.000Z", remainingMs: 7_000,
      triggerCount: 2, lastHttpStatus: 429, lastLarkErrorCode: "99991400", lastReason: "rate limited"
    } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch("http://127.0.0.1:" + port + "/ready")).status).toBe(200);
    expect(await (await fetch("http://127.0.0.1:" + port + "/status")).json()).toMatchObject({
      status: "degraded", readiness: { status: "ready" }, operational: { larkDeliveryCooldown: {
        active: true, blockedUntil: "2099-01-01T00:00:07.000Z", remainingMs: 7_000,
        triggerCount: 2, lastHttpStatus: 429, lastLarkErrorCode: "99991400", lastReason: "rate limited"
      } }
    });
  });

  it("keeps status healthy when delivery failures are historical rather than current work", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), deadLetters: 2, unresolvedDeadLetters: 2, deadLettersByClass: { transient: 0, permanent: 2, unknown: 0, legacy: 0 }, unresolvedDeadLettersByClass: { transient: 0, permanent: 2, unknown: 0, legacy: 0 } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({ status: "ok", operational: { deadLetters: 2, unresolvedDeadLetters: 2 } });
  });

  it("reports lifecycle subscriber failures without changing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      lifecycleEvents: { snapshot: () => ({ listenerCount: 2, publicationCount: 9, subscriberFailures: 3, failuresBySubscriber: { "conversation-view-projector": 3 }, lastFailureAt: "2026-08-24T00:00:00.000Z", lastFailedSubscriber: "conversation-view-projector" }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(200);
    const status = await fetch(`http://127.0.0.1:${port}/status`);
    expect(await status.json()).toMatchObject({ status: "ok", lifecycleEvents: {
      listenerCount: 2, publicationCount: 9, subscriberFailures: 3, failuresBySubscriber: { "conversation-view-projector": 3 }, lastFailureAt: "2026-08-24T00:00:00.000Z", lastFailedSubscriber: "conversation-view-projector"
    } });
  });

  it("isolates lifecycle diagnostics failure from status and readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) },
      lifecycleEvents: { snapshot() { throw new Error("x".repeat(600)); } }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; lifecycleEvents: { error: string } };
    expect(body.status).toBe("degraded");
    expect(body.lifecycleEvents.error).toHaveLength(500);
  });

  it("reports multiple diagnostics collection failures without short-circuiting status", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) },
      workspaceCache: { status() { throw new Error("workspace diagnostics failed"); } },
      herdrSocket: { status() { throw new Error("socket diagnostics failed"); } },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "degraded", readiness: { status: "ready" },
      workspaceCache: { error: "workspace diagnostics failed" },
      herdrSocket: { error: "socket diagnostics failed" }
    });
  });

  it("degrades status while the Herdr transport circuit is open", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      herdrCircuitBreaker: { status: () => ({ state: "open", failureThreshold: 3, openMs: 15_000, consecutiveFailures: 3, totalTransportFailures: 3, rejectedCalls: 7, successfulProbes: 0, openedAt: "2026-08-26T00:00:00.000Z", nextProbeAt: "2026-08-26T00:00:15.000Z", lastFailureAt: "2026-08-26T00:00:00.000Z", lastFailure: "connect ECONNREFUSED" }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", herdrCircuitBreaker: { state: "open", rejectedCalls: 7, lastFailure: "connect ECONNREFUSED" }
    });
  });

  it("reports and degrades an isolated startup recovery failure", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      startupRecovery: { snapshot: () => ({ state: "degraded", startedAt: "2026-08-26T00:00:00.000Z", completedAt: "2026-08-26T00:00:01.000Z", stages: [{ name: "view-convergence", state: "failed", durationMs: 4, error: "bad view" }] }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", startupRecovery: { state: "degraded", stages: [{ name: "view-convergence", state: "failed", error: "bad view" }] }
    });
  });

  it("isolates dispatcher diagnostic failure from readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      outboxDispatcher: { snapshot() { throw new Error("diagnostic failed"); } }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    const status = await fetch(`http://127.0.0.1:${port}/status`);
    expect(await status.json()).toMatchObject({
      status: "degraded", readiness: { status: "ready" },
      outboxDispatcher: { error: "diagnostic failed" }
    });
  });

  it("isolates inbound dispatcher diagnostic failure from readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      inboundDispatcher: { snapshot() { throw new Error("inbound diagnostics failed"); } }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", readiness: { status: "ready" }, inboundDispatcher: { error: "inbound diagnostics failed" }
    });
  });

  it("degrades status while the latest outbox scan is failed without failing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) },
      outboxDispatcher: { snapshot: () => ({ state: "idle" as const, activeDeliveries: 0, scanPending: false, lastScanAt: "2026-08-29T00:00:00.000Z", lastScanOutcome: "failed" as const, lastDeliveryAt: null, lastDeliveryFailureAt: null, lastSuccessfulScanAt: null, lastScanFailureAt: "2026-08-29T00:00:00.000Z", consecutiveScanFailures: 1 }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", readiness: { status: "ready" }, outboxDispatcher: { lastScanOutcome: "failed", consecutiveScanFailures: 1 }
    });
  });

  it("isolates prompt worker diagnostic failure from readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      promptWorker: { snapshot() { throw new Error("prompt diagnostics failed"); } }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", readiness: { status: "ready" }, promptWorker: { error: "prompt diagnostics failed" }
    });
  });
});
