import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHealthServer } from "../src/health/server.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

let server: Awaited<ReturnType<typeof startHealthServer>> | undefined;
let store: SqliteBindingStore | undefined;
afterEach(async () => {
  if (server) { server.close(); await once(server, "close"); server = undefined; }
  store?.close(); store = undefined;
});

describe("health server", () => {
  const buildIdentity = { serviceId: "herdr-lark-bridge" as const, version: "0.2.0", buildId: "sha256:test-build", gitCommit: null };

  it("reports every readiness component and exposes a safe operational status", async () => {
    store = new SqliteBindingStore(":memory:");
    const projects = [{ id: "missing", displayName: "Missing", description: "Missing", workspaceId: "w1", cwd: "/definitely/missing/project" }];
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects, lark: { isReady: () => false } as never,
      herdr: { async assertWorkspace() { throw new Error("workspace unavailable"); } } as never,
      promptWorker: { snapshot: () => ({ state: "running", activeTurnWorkers: 0, activeSteeringWorkers: 0, lastScanAt: "2026-08-24T00:00:00.000Z", lastScanOutcome: "idle", lastDiscovered: { turns: 0, steering: 0, detached: 0, cancelled: 0 }, lastScanFailureAt: null }) },
      outboxDispatcher: { snapshot: () => ({ state: "idle", activeDeliveries: 0, scanPending: false, lastScanAt: null, lastScanOutcome: null, lastDeliveryAt: null, lastDeliveryFailureAt: null }) },
      herdrSocket: { status: () => ({ connected: true, eventsConnected: true, requests: 4, responses: 3, requestFailures: 1, transportFailures: 0, pendingRequests: 0 }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await health.json()).toEqual({ status: "ok", serviceId: "herdr-lark-bridge", version: "0.2.0", buildId: "sha256:test-build" });

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
    expect(body).toMatchObject({ status: "degraded", identity: buildIdentity, readiness: { status: "not_ready" }, operational: { pendingOutbox: 0, deadLetters: 0, outboxLanes: { pending: 0, eligible: 0, blocked: 0, nextAttemptAt: null, oldestHeadAt: null, oldestHeadAgeSeconds: null } }, outboxDispatcher: { state: "idle", activeDeliveries: 0 }, promptWorker: { state: "running", activeTurnWorkers: 0, lastScanOutcome: "idle" }, herdrSocket: { connected: true, eventsConnected: true, requests: 4, responses: 3, requestFailures: 1, transportFailures: 0, pendingRequests: 0 } });
    expect(body).toHaveProperty("uptimeSeconds");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("lease.ownerSuffix", "owner123");
    expect(JSON.stringify(body)).not.toContain("payload");
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

  it("reports lifecycle subscriber failures without changing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      lifecycleEvents: { snapshot: () => ({ subscriberFailures: 3, lastFailureAt: "2026-08-24T00:00:00.000Z", lastFailedSubscriber: "conversation-view-projector" }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    const ready = await fetch(`http://127.0.0.1:${port}/ready`);
    expect(ready.status).toBe(200);
    const status = await fetch(`http://127.0.0.1:${port}/status`);
    expect(await status.json()).toMatchObject({ status: "ok", lifecycleEvents: {
      subscriberFailures: 3, lastFailureAt: "2026-08-24T00:00:00.000Z", lastFailedSubscriber: "conversation-view-projector"
    } });
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
