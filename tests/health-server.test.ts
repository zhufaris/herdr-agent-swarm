import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHealthServer as startProductionHealthServer } from "../src/health/server.js";
import type { HealthSnapshotOptions } from "../src/health/health-snapshot-collector.js";
import { createShutdownContext } from "../src/runtime/shutdown-context.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

function startHealthServer(options: Omit<HealthSnapshotOptions, "diagnostics"> & { diagnostics?: HealthSnapshotOptions["diagnostics"]; host: string; port: number; store: SqliteBindingStore }) {
  return startProductionHealthServer({ ...options, diagnostics: options.diagnostics ?? diagnosticsFor(options.store) });
}

function diagnosticsFor(store: SqliteBindingStore): HealthSnapshotOptions["diagnostics"] {
  return { async inspectDiagnostics({ includePhysical }) {
    const inspection = store.inspectIntegrity(20);
    return {
      operational: store.getOperationalSummary(),
      semantic: { issues: inspection.issues.filter((issue) => issue.rule !== "sqlite_quick_check" && issue.rule !== "sqlite_foreign_key"), truncated: inspection.truncated },
      physical: includePhysical ? {
        quickCheck: inspection.quickCheck,
        foreignKeyIssues: inspection.issues.filter((issue) => issue.rule === "sqlite_foreign_key").map((issue) => ({ table: issue.table, rowId: issue.rowId ?? null })),
        truncated: inspection.truncated
      } : undefined,
      connection: { queryOnly: true, busyTimeoutMs: 25 }
    };
  } };
}

let server: Awaited<ReturnType<typeof startHealthServer>> | undefined;
let store: SqliteBindingStore | undefined;
afterEach(async () => {
  if (server) { await server.stop(createShutdownContext(1_000).context); server = undefined; }
  store?.close(); store = undefined;
});

describe("health server", () => {
  const buildIdentity = { serviceId: "herdr-agent-swarm" as const, version: "0.2.0", buildId: "sha256:test-build", gitCommit: null };
  const reconciliationSnapshot = { state: "idle" as const, runCount: 3, successCount: 2, failureCount: 1, coalescedRequestCount: 4, lastStartedAt: "2026-08-29T00:00:00.000Z", lastCompletedAt: "2026-08-29T00:00:00.025Z", lastDurationMs: 25, maxDurationMs: 40, lastOutcome: "succeeded" as const };

  it("uses the configured Conversation Gateway status as the readiness authority", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      gateway: { snapshot: () => ({ gatewayId: "feishu:primary", kind: "feishu", profileId: "feishu-cardkit-v1", ingress: { ready: true }, delivery: { ready: true }, degradations: [] }) },
      herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });

    const ready = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ components: { gateway: { ok: true }, lark: { ok: true } } });
  });

  it("redacts credentials from readiness and status collection failures", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never,
      herdr: { async assertWorkspace() { throw new Error("workspace failed Bearer health-secret"); } } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    const ready = await (await fetch(`http://127.0.0.1:${port}/ready`)).json();
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();

    expect(ready).toMatchObject({ components: { herdr: { workspaces: [{ error: "workspace failed Bearer [REDACTED]" }] } } });
    expect(status).toMatchObject({ readiness: { components: { herdr: { workspaces: [{ error: "workspace failed Bearer [REDACTED]" }] } } } });
    expect(JSON.stringify({ ready, status })).not.toContain("health-secret");
  });

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

  it("exposes failed unified recovery diagnostics without changing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      recoverySupervisor: { snapshot: () => ({
        version: 2, state: "idle", lastPassAt: "2026-10-02T05:00:00.000Z", lastPassOutcome: "failed",
        stageCounts: { observing_execution: 1, rebuilding_projection: 0, delivering: 0, awaiting_ack: 0, recovered: 0, needs_human: 0 },
        oldestPendingAt: "2026-10-02T04:59:00.000Z", oldestPendingAgeSeconds: 60, lastFailure: "execution unavailable", items: [],
        historical: { runCount: 3, lastSliceAt: "2026-10-02T04:58:00.000Z", lastResult: {
          projected: 8, retried: 1, quarantined: 0, stale: 1, processed: 10,
          cardsReserved: 2, cardsStale: 0, cardsRemaining: true, remaining: true,
          oldestEligibleAt: "2026-09-30T00:00:00.000Z", durationMs: 432,
          backlog: { eligiblePendingEvents: 120, eligibleLanes: 4, ineligiblePendingEvents: 9, quarantinedEvents: 3, oldestEligibleAt: "2026-09-30T00:00:00.000Z" }
        } }
      }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", readiness: { status: "ready" },
      recovery: {
        version: 2, lastPassOutcome: "failed", stageCounts: { observing_execution: 1 }, lastFailure: "execution unavailable",
        historical: { runCount: 3, lastResult: { projected: 8, cardsReserved: 2, backlog: { eligiblePendingEvents: 120, quarantinedEvents: 3 } } }
      }
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
    expect(body).toMatchObject({ status: "degraded", identity: buildIdentity, readiness: { status: "not_ready" }, operational: { pendingOutbox: 0, deadLetters: 0, deliveryRings: { pending: 0, panePending: 0, globalPending: 0, ready: 0, activeClaims: 0, waitingBehindScope: 0 } }, promptWorker: { state: "running", activeTurnWorkers: 0, lastScanOutcome: "idle", currentSafetyScanDelayMs: 10_000, nextSafetyScanAt: "2026-08-24T00:00:10.000Z" }, herdrSocket: { connected: true, eventsConnected: true, requests: 4, responses: 3, requestFailures: 1, transportFailures: 0, pendingRequests: 0 } });
    expect(body).not.toHaveProperty("outboxDispatcher");
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

  it("degrades status for overdue Prompt recovery without failing dependency readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), coreProjection: {
      lanes: 1, laggingLanes: 1, pendingEvents: 1, quarantinedEvents: 0,
      oldestPendingAt: "2026-10-01T00:00:00.000Z", oldestPendingAgeSeconds: 301
    } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", readiness: { status: "ready" }, operational: { coreProjection: { laggingLanes: 1, oldestPendingAgeSeconds: 301 } }
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

  it("keeps terminal legacy Session operation history readable without degrading health", async () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task", creatorOpenId: "creator" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    store.createCardInteraction({ id: "legacy-interaction", bindingId: "b1", bindingGeneration: 1, actorOpenId: "creator", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
    store.acceptSessionOperation({ id: "legacy-terminal", idempotencyKey: "legacy:terminal", interactionId: "legacy-interaction", actorOpenId: "creator", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "rename", argument: "private legacy title", now: new Date().toISOString() });
    store.claimNextSessionOperation();
    store.finishSessionOperation("legacy-terminal", "succeeded");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      sessionOperationDispatcher: { snapshot: () => ({ state: "idle", activeOperations: 0, drainRequested: false, lastCompletedAt: null, lastFailureAt: null, lastFailure: null }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });

    const body = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status`)).json();
    expect(body).toMatchObject({ status: "ok", operational: { sessionOperations: { states: { succeeded: 1, accepted: 0, running: 0 } } } });
    expect(JSON.stringify(body)).not.toContain("private legacy title");
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

  it("bounds concurrent Herdr workspace readiness probes", async () => {
    store = new SqliteBindingStore(":memory:");
    let active = 0;
    let maximumActive = 0;
    const assertWorkspace = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });
    const projects = Array.from({ length: 9 }, (_, index) => ({
      id: `project-${index}`, displayName: `Project ${index}`, description: `Project ${index}`, workspaceId: `w${index}`, cwd: process.cwd()
    }));
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects,
      lark: { isReady: () => true } as never, herdr: { assertWorkspace } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });

    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ready`);

    expect(response.status).toBe(200);
    expect(assertWorkspace).toHaveBeenCalledTimes(9);
    expect(maximumActive).toBe(4);
  });

  it("coalesces concurrent status collection and reuses the last successful diagnostics snapshot", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    const getOperationalSummary = vi.fn(() => originalSummary());
    store.getOperationalSummary = getOperationalSummary;
    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const assertWorkspace = vi.fn(() => probeGate);
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { assertWorkspace } as never, diagnosticsTtlMs: 60_000,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/status`;

    const first = fetch(url);
    const second = fetch(url);
    await vi.waitFor(() => expect(assertWorkspace).toHaveBeenCalledOnce());
    releaseProbe?.();
    await Promise.all([first, second]);
    expect(getOperationalSummary).toHaveBeenCalledOnce();

    await fetch(url);
    expect(getOperationalSummary).toHaveBeenCalledOnce();
  });

  it("bounds diagnostics failures and retries them after backoff", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    const getOperationalSummary = vi.fn()
      .mockImplementationOnce(() => { throw new Error("summary unavailable"); })
      .mockImplementation(() => originalSummary());
    store.getOperationalSummary = getOperationalSummary;
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      diagnosticsTtlMs: 60_000, retryBackoffMinMs: 1, retryBackoffMaxMs: 1,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/status`;

    const unavailable = await (await fetch(url)).json();
    expect(unavailable).toMatchObject({
      status: "degraded", operational: { error: "SQLite diagnostics unavailable" },
      sqliteDiagnostics: { state: "unavailable", failureClass: "other", retryAt: expect.any(String) }
    });
    expect(JSON.stringify(unavailable)).not.toContain("summary unavailable");
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(await (await fetch(url)).json()).toMatchObject({ status: "ok" });
    expect(getOperationalSummary).toHaveBeenCalledTimes(2);
  });

  it("aborts and settles active diagnostics before the health resource stops", async () => {
    store = new SqliteBindingStore(":memory:");
    let inspectionSignal: AbortSignal | undefined;
    let inspectionSettled = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store,
      projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      diagnostics: { inspectDiagnostics(_input, signal) {
        inspectionSignal = signal; markStarted();
        return new Promise((_resolve, reject) => {
          const fallback = setTimeout(() => {
            inspectionSettled = true;
            reject(Object.assign(new Error("test cleanup timeout"), { failureClass: "timeout" }));
          }, 100);
          signal?.addEventListener("abort", () => {
            clearTimeout(fallback);
            inspectionSettled = true; reject(signal.reason);
          }, { once: true });
        });
      } },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const request = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status`);
    await started;
    const { context } = createShutdownContext(1_000);

    await (server as typeof server & { stop(context: typeof context): Promise<void> }).stop(context);

    expect(inspectionSignal?.aborted).toBe(true);
    expect(inspectionSettled).toBe(true);
    await expect(request).resolves.toMatchObject({ status: 200 });
    server = undefined;
  });

  it("supports HEAD and rejects mutating methods on read endpoints", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) }, buildIdentity
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    for (const path of ["/health", "/ready", "/status"]) {
      const head = await fetch(`${baseUrl}${path}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const post = await fetch(`${baseUrl}${path}`, { method: "POST" });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
      expect(await post.json()).toEqual({ error: "method_not_allowed" });
    }
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

  it("fails readiness for a confirmed SQLite integrity inconsistency", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) },
      sqliteIntegrity: { snapshot: () => ({ state: "degraded", quickCheck: "ok", issues: [{ rule: "outbox_lane_missing_head", table: "outbox_lane_heads", count: 1 }], truncated: false, startedAt: "2026-08-26T00:00:00.000Z", completedAt: "2026-08-26T00:00:00.010Z", durationMs: 10, error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(503);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded",
      readiness: { status: "not_ready", components: { sqliteIntegrity: { ok: false, error: "SQLite integrity check reported 1 issue(s)" } } },
      sqliteIntegrity: { state: "degraded", issues: [{ rule: "outbox_lane_missing_head", count: 1 }] }
    });
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

  it("reports projection delivery recovery backlog without failing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), projectionDeliveryRecovery: {
      backlog: 2,
      eligible: 1,
      awaitingAck: 1,
      recovered: 3,
      exhausted: 0,
      byProjection: { primaryAnswer: 1, workerTask: 1 },
      oldestEligibleAt: "2026-10-02T00:00:00.000Z",
      oldestEligibleAgeSeconds: 60
    } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded",
      readiness: { status: "ready" },
      operational: { projectionDeliveryRecovery: { backlog: 2, eligible: 1, awaitingAck: 1, byProjection: { primaryAnswer: 1, workerTask: 1 } } }
    });
  });

  it("degrades status for an active outbox quarantine without failing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), outboxQuarantines: {
      ...originalSummary().outboxQuarantines, active: 1, current: 1
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

  it("reports historical delivery debt without degrading current operations", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), outboxQuarantines: {
      ...originalSummary().outboxQuarantines, active: 1, current: 0, historical: 1
    }, projectionGaps: {
      ...originalSummary().projectionGaps, open: 2, current: 0, historical: 2
    } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "ok", operational: {
        outboxQuarantines: { active: 1, current: 0, historical: 1 },
        projectionGaps: { open: 2, current: 0, historical: 2 }
      }
    });
  });

  it("degrades status for an open projection gap without failing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), projectionGaps: {
      open: 1, compensated: 2, affectedOwners: 1, oldestOpenAt: "2026-09-30T00:00:00.000Z",
      byStage: { core_projection: 1, answer_delivery: 0, main_delivery: 0, worker_delivery: 0, turn_recovery: 0 }
    } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({ status: "degraded", readiness: { status: "ready" }, operational: { projectionGaps: { open: 1, affectedOwners: 1 } } });
  });

  it("degrades status for durable turn recovery without failing readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), turnRecovery: {
      pending: 1, due: 0, oldestAttemptAt: "2026-09-30T00:00:00.000Z", oldestAgeSeconds: 60,
      byState: { waiting: 0, indexing: 1, not_found: 0, ambiguous: 0, transient: 0 },
      latestFailure: { failureCode: "recovery_indexing", attemptCount: 2, lastAttemptAt: "2026-09-30T00:00:00.000Z", nextAttemptAt: "2026-09-30T00:00:10.000Z" }
    } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({ status: "degraded", readiness: { status: "ready" }, operational: { turnRecovery: { pending: 1, byState: { indexing: 1 } } } });
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

  it("reports durable in-flight Lark work without degrading status or readiness", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), pendingOutbox: 1, deliveryRings: {
      ...originalSummary().deliveryRings, pending: 1, activeClaims: 1
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
      status: "ok", readiness: { status: "ready" }, operational: { pendingOutbox: 1, deliveryRings: {
        pending: 1, activeClaims: 1
      } }
    });
  });

  it("reports isolated Delivery conflicts and pending Human Review as degraded without exposing payload", async () => {
    store = new SqliteBindingStore(":memory:");
    const originalSummary = store.getOperationalSummary.bind(store);
    store.getOperationalSummary = () => ({ ...originalSummary(), deliveryRings: {
      ...originalSummary().deliveryRings,
      isolatedConflicts: 2,
      isolatedUncertain: 1,
      bypassedDeliveries: 3,
      pendingHumanReviews: 1,
      oldestHumanReviewAgeSeconds: 90,
    } });
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });

    const status = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status`)).json();
    expect(status).toMatchObject({
      status: "degraded",
      readiness: { status: "ready" },
      operational: { deliveryRings: {
        isolatedConflicts: 2,
        isolatedUncertain: 1,
        bypassedDeliveries: 3,
        pendingHumanReviews: 1,
        oldestHumanReviewAgeSeconds: 90,
      } }
    });
    expect(JSON.stringify(status)).not.toContain("payload");
  });

  it("reports the Delivery Engine snapshot alongside durable Pane and Global scope counts", async () => {
    store = new SqliteBindingStore(":memory:");
    const deliveryEngine = {
      state: "running" as const, ringCount: 2, runnableRings: 1, activeDeliveries: 0,
      latency: { traces: 3, completed: 2, lastCompletedDurationMs: 48, stageDurationsMs: { ringToGatewayAck: 21 }, metrics: { input_to_settlement: { succeeded: 2 } } },
      cachedItems: 3, cachedBytes: 384, processByteLimit: 1024,
      overflowedScopes: 0, quarantinedScopes: 0,
      oldestReadyAt: "2026-10-06T00:00:00.000Z", oldestLiveReadyAt: "2026-10-06T00:00:00.000Z", oldestHistoryReadyAt: null,
      nextRetryAt: null, lastRefillAt: "2026-10-06T00:00:01.000Z",
      safetyScanRuns: 3, safetyScanDiscoveries: 0, lastSafetyScanAt: "2026-10-06T00:00:01.000Z", lastSafetyScanDiscoveryAt: null,
      lastDeliveryAt: null, lastFailureAt: null, recoveryReady: true
    };
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      deliveryEngine: { snapshot: () => deliveryEngine }, buildIdentity
    });

    const status = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/status`)).json();
    expect(status).toMatchObject({
      deliveryEngine,
      operational: { deliveryRings: { pending: 0, panePending: 0, globalPending: 0, activeClaims: 0 } }
    });
    expect(status.operational.deliveryRings).not.toHaveProperty("legacyDebt");
    expect(status.deliveryEngine.latency).toEqual(deliveryEngine.latency);
    expect(JSON.stringify(status.deliveryEngine.latency)).not.toMatch(/eventId|messageId|submissionId|coreEventId|segmentId|replyId|attemptId|receiptId/);
  });

  it.each([
    ["degraded", { state: "degraded" as const, recoveryReady: true }],
    ["not recovery ready", { state: "running" as const, recoveryReady: false }]
  ])("fails readiness and status when the Delivery Engine is %s", async (_label, engineState) => {
    store = new SqliteBindingStore(":memory:");
    const deliveryEngine = {
      ...engineState, ringCount: 0, runnableRings: 0, activeDeliveries: 0,
      cachedItems: 0, cachedBytes: 0, processByteLimit: 1024,
      overflowedScopes: 0, quarantinedScopes: 0,
      oldestReadyAt: null, oldestLiveReadyAt: null, oldestHistoryReadyAt: null,
      nextRetryAt: null, lastRefillAt: null, lastDeliveryAt: null, lastFailureAt: "2026-10-06T00:00:00.000Z"
    };
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      deliveryEngine: { snapshot: () => deliveryEngine }, buildIdentity, readinessTtlMs: 0, statusTtlMs: 0
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(503);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", readiness: { status: "not_ready", components: { deliveryEngine: { ok: false } } }, deliveryEngine
    });
  });

  it("keeps legacy-only readiness and status compatible without Delivery Engine diagnostics", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({ status: "ok", readiness: { status: "ready" } });
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

  it("fails readiness after the Herdr Core transport failure threshold opens the circuit", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      herdrCircuitBreaker: { status: () => ({ state: "open", failureThreshold: 3, openMs: 15_000, consecutiveFailures: 3, totalTransportFailures: 3, rejectedCalls: 7, successfulProbes: 0, openedAt: "2026-08-26T00:00:00.000Z", nextProbeAt: "2026-08-26T00:00:15.000Z", lastFailureAt: "2026-08-26T00:00:00.000Z", lastFailure: "connect ECONNREFUSED" }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(503);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", readiness: { status: "not_ready", components: { core: { ok: false, error: "connect ECONNREFUSED" } } },
      herdrCircuitBreaker: { state: "open", rejectedCalls: 7, lastFailure: "connect ECONNREFUSED" }
    });
  });

  it("fails new-input readiness explicitly when the required Core v2 capability is absent", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      agentInputCapability: { snapshot: () => ({
        required: true, detected: true, supported: false, ready: false,
        error: "Herdr Core does not advertise agent_input_submission_v3"
      }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(503);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded",
      readiness: { status: "not_ready", components: { agentInput: {
        ok: false,
        required: true,
        supported: false,
        error: "Herdr Core does not advertise agent_input_submission_v3"
      } } }
    });
  });

  it("keeps readiness while a below-threshold Core transport failure degrades status", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      herdrCircuitBreaker: { status: () => ({ state: "closed", failureThreshold: 3, openMs: 15_000, consecutiveFailures: 2, totalTransportFailures: 2, rejectedCalls: 0, successfulProbes: 0, openedAt: null, nextProbeAt: null, lastFailureAt: "2026-08-26T00:00:00.000Z", lastFailure: "connect ECONNRESET" }) },
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) },
      buildIdentity
    });
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${port}/ready`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/status`)).json()).toMatchObject({
      status: "degraded", readiness: { status: "ready", components: { core: { ok: true } } },
      herdrCircuitBreaker: { state: "closed", consecutiveFailures: 2 }
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
