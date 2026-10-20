import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthStore } from "../src/domain/ports/health.js";
import type { OperationalSummary, SqliteIntegrityDiagnostics } from "../src/domain/types.js";
import { HealthSnapshotCollector, type HealthSnapshotOptions } from "../src/health/health-snapshot-collector.js";
import { WorkerDatabaseIntegrityStore } from "../src/runtime/sqlite-integrity-worker.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

type FailureClass = "busy" | "locked" | "timeout" | "other";
interface DatabaseDiagnosticsInspection {
  operational: OperationalSummary;
  semantic: { issues: Array<{ rule: string; table: string; count: number }>; truncated: boolean };
  physical?: { quickCheck: "ok" | "failed"; foreignKeyIssues: Array<{ table: string; rowId: number | null }>; truncated: boolean };
  connection: { queryOnly: true; busyTimeoutMs: number };
}
interface DatabaseDiagnosticsStore {
  inspectDiagnostics(input: { issueLimit: number; includePhysical: boolean }, signal?: AbortSignal): Promise<DatabaseDiagnosticsInspection>;
}
type T2HealthStore = HealthStore & { probeReadiness(): void };

const buildIdentity = { serviceId: "herdr-agent-swarm" as const, version: "0.4.0", buildId: "sha256:test-build", gitCommit: null };
const project = { id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() };
const lease = { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) };

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe("T2 SQLite readiness and diagnostics contract", () => {
  it("uses a constant-time HealthStore probe for readiness and never scans bindings", async () => {
    store = new SqliteBindingStore(":memory:");
    const probeReadiness = vi.fn();
    const listBindings = vi.fn(() => { throw new Error("readiness must not enumerate bindings"); });
    const collector = collectorFor(Object.assign(store, { probeReadiness, listBindings }) as T2HealthStore, unusedDiagnostics(store));

    await expect(collector.readiness()).resolves.toMatchObject({ status: "ready", components: { database: { ok: true } } });
    expect(probeReadiness).toHaveBeenCalledOnce();
    expect(listBindings).not.toHaveBeenCalled();
  });

  it("establishes the operational last-good without waiting for the independent physical audit", async () => {
    store = new SqliteBindingStore(":memory:");
    const operational = store.getOperationalSummary();
    const inspectDiagnostics = vi.fn(async ({ includePhysical }: { includePhysical: boolean }) => {
      if (includePhysical) throw Object.assign(new Error("physical audit exceeded its deadline"), { failureClass: "timeout" });
      return inspection(operational, undefined);
    });
    const collector = collectorFor(probingStore(store), { inspectDiagnostics }, () => 500, {
      sqliteIntegrity: { snapshot: () => ({
        state: "running", quickCheck: "ok", issues: [], truncated: false,
        startedAt: new Date(400).toISOString(), completedAt: null, durationMs: null, error: null
      }) } as never
    });

    await expect(collector.status()).resolves.toMatchObject({
      operational,
      sqliteDiagnostics: { state: "fresh", physicalState: "unknown", physicalCheckedAt: null }
    });
    expect(inspectDiagnostics).toHaveBeenCalledWith({ issueLimit: 20, includePhysical: false }, expect.any(AbortSignal));
  });

  it("serves an expired last-good status immediately while concurrent callers share one Worker refresh", async () => {
    store = new SqliteBindingStore(":memory:");
    let now = 1_000;
    const first = inspection(store.getOperationalSummary());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const diagnostics: DatabaseDiagnosticsStore = {
      inspectDiagnostics: vi.fn()
        .mockResolvedValueOnce(first)
        .mockImplementationOnce(async () => { await gate; return first; })
    };
    const collector = collectorFor(probingStore(store), diagnostics, () => now, { diagnosticsTtlMs: 100 });

    await expect(collector.status()).resolves.toMatchObject({ sqliteDiagnostics: { state: "fresh", refreshing: false, physicalState: "healthy" } });
    now += 101;
    const [left, right] = await Promise.all([collector.status(), collector.status()]);

    expect(left).toMatchObject({ sqliteDiagnostics: { state: "stale", refreshing: true, collectedAt: new Date(1_000).toISOString() } });
    expect(right).toEqual(left);
    expect(diagnostics.inspectDiagnostics).toHaveBeenCalledTimes(2);
    expect(vi.mocked(diagnostics.inspectDiagnostics).mock.calls.at(-1)?.[0]).toMatchObject({ includePhysical: false });
    release();
  });

  it("keeps last-good data stale after a typed busy refresh failure and schedules bounded retry without claiming corruption", async () => {
    store = new SqliteBindingStore(":memory:");
    let now = 5_000;
    const first = inspection(store.getOperationalSummary());
    const busy = Object.assign(new Error("database busy"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    const diagnostics: DatabaseDiagnosticsStore = {
      inspectDiagnostics: vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(busy)
    };
    const collector = collectorFor(probingStore(store), diagnostics, () => now, { diagnosticsTtlMs: 0, retryBackoffMinMs: 50, retryBackoffMaxMs: 100 });

    await collector.status();
    now += 1;
    await collector.status();
    await Promise.resolve();
    const stale = await collector.status() as { operational: OperationalSummary; sqliteDiagnostics: { state: string; physicalState: string; failureClass: FailureClass | null; retryAt: string | null } };

    expect(stale.operational).toEqual(first.operational);
    expect(stale.sqliteDiagnostics).toMatchObject({ state: "stale", physicalState: "healthy", failureClass: "busy" });
    expect(Date.parse(stale.sqliteDiagnostics.retryAt!)).toBeGreaterThanOrEqual(now + 50);
    expect(Date.parse(stale.sqliteDiagnostics.retryAt!)).toBeLessThanOrEqual(now + 100);
  });

  it("fails readiness closed for sticky physical failure while keeping transient diagnostics distinct", async () => {
    store = new SqliteBindingStore(":memory:");
    const diagnostics: DatabaseDiagnosticsStore = { inspectDiagnostics: vi.fn().mockResolvedValue(inspection(store.getOperationalSummary(), undefined)) };
    let sqliteIntegrity: SqliteIntegrityDiagnostics = {
      state: "degraded" as const, quickCheck: "failed" as const,
      issues: [{ rule: "sqlite_quick_check", table: "database", count: 1 }], truncated: false,
      startedAt: new Date(9_000).toISOString(), completedAt: new Date(9_500).toISOString(), durationMs: 500, error: null
    };
    const collector = collectorFor(probingStore(store), diagnostics, () => 10_000, {
      diagnosticsTtlMs: 0,
      sqliteIntegrity: { snapshot: () => sqliteIntegrity } as never
    });

    await expect(collector.status()).resolves.toMatchObject({ sqliteDiagnostics: { physicalState: "failed", state: "fresh" } });
    await expect(collector.readiness()).resolves.toMatchObject({ status: "not_ready", components: { sqliteIntegrity: { ok: false } } });
    sqliteIntegrity = {
      state: "healthy", quickCheck: "ok", issues: [], truncated: false,
      startedAt: new Date(10_000).toISOString(), completedAt: new Date(10_500).toISOString(), durationMs: 500, error: null
    };
    await expect(collector.status()).resolves.toMatchObject({ sqliteDiagnostics: { physicalState: "healthy", physicalCheckedAt: new Date(10_500).toISOString() } });
    await expect(collector.readiness()).resolves.toMatchObject({ status: "ready" });
  });

  it("uses a read-only Worker connection with bounded busy timeout and leaves its writer usable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sqlite-t2-read-only-"));
    const databasePath = join(directory, "bridge.db");
    const writer = new SqliteBindingStore(databasePath);
    const diagnostics = new WorkerDatabaseIntegrityStore(databasePath) as unknown as DatabaseDiagnosticsStore;
    try {
      writer.database.exec("CREATE TABLE t2_writer_probe(id INTEGER PRIMARY KEY)");
      await expect(diagnostics.inspectDiagnostics({ issueLimit: 20, includePhysical: false })).resolves.toMatchObject({
        connection: { queryOnly: true, busyTimeoutMs: expect.any(Number) },
        physical: undefined
      });
      expect(writer.database.prepare("INSERT INTO t2_writer_probe DEFAULT VALUES").run().changes).toBe(1);
    } finally {
      writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps every status refresh semantic-only while the integrity auditor owns physical cadence", async () => {
    store = new SqliteBindingStore(":memory:");
    let now = 20_000;
    const diagnostics: DatabaseDiagnosticsStore = { inspectDiagnostics: vi.fn().mockImplementation(async ({ includePhysical }) => inspection(store!.getOperationalSummary(), includePhysical ? { quickCheck: "ok", foreignKeyIssues: [], truncated: false } : undefined)) };
    const collector = collectorFor(probingStore(store), diagnostics, () => now, { diagnosticsTtlMs: 0 });

    await collector.status();
    now += 1;
    await collector.status();
    now += 1_000;
    await collector.status();

    const calls = vi.mocked(diagnostics.inspectDiagnostics).mock.calls;
    expect(calls[0]?.[0]).toMatchObject({ includePhysical: false });
    expect(calls[1]?.[0]).toMatchObject({ includePhysical: false });
    expect(calls[2]?.[0]).toMatchObject({ includePhysical: false });
  });
});

function probingStore(target: SqliteBindingStore): T2HealthStore {
  return Object.assign(target, { probeReadiness: vi.fn(), listBindings: vi.fn(() => { throw new Error("readiness must not enumerate bindings"); }) }) as T2HealthStore;
}

function unusedDiagnostics(target: SqliteBindingStore): DatabaseDiagnosticsStore {
  return { inspectDiagnostics: vi.fn().mockResolvedValue(inspection(target.getOperationalSummary())) };
}

function inspection(operational: OperationalSummary, physical: DatabaseDiagnosticsInspection["physical"] = { quickCheck: "ok", foreignKeyIssues: [], truncated: false }): DatabaseDiagnosticsInspection {
  return { operational, semantic: { issues: [], truncated: false }, physical, connection: { queryOnly: true, busyTimeoutMs: 25 } };
}

function collectorFor(store: T2HealthStore, diagnostics: DatabaseDiagnosticsStore, clock: () => number = Date.now, settings: Record<string, number> = {}): HealthSnapshotCollector {
  return new HealthSnapshotCollector({
    store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease, buildIdentity,
    diagnostics, clock, diagnosticsTtlMs: 1_000, retryBackoffMinMs: 10, retryBackoffMaxMs: 100,
    sqliteIntegrity: { snapshot: () => ({
      state: "healthy", quickCheck: "ok", issues: [], truncated: false,
      startedAt: new Date(clock()).toISOString(), completedAt: new Date(clock()).toISOString(), durationMs: 0, error: null
    }) },
    ...settings
  } as unknown as HealthSnapshotOptions);
}
