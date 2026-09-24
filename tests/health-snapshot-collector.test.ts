import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthSnapshotCollector } from "../src/health/health-snapshot-collector.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

let store: SqliteBindingStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

describe("HealthSnapshotCollector", () => {
  const buildIdentity = { serviceId: "herdr-agent-swarm" as const, version: "0.4.0", buildId: "sha256:test-build", gitCommit: null };
  const project = { id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() };
  const lease = { snapshot: () => ({ held: true, ownerSuffix: "owner", fencingToken: 1, expiresAt: null, lastRenewedAt: null, error: null }) };

  it("fails readiness closed through one coherent provider observation", async () => {
    store = new SqliteBindingStore(":memory:");
    const runtimeSnapshot = vi.fn(() => { throw new Error("runtime unavailable"); });
    const collector = new HealthSnapshotCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never,
      lease, instanceRuntime: { snapshot: runtimeSnapshot }, buildIdentity, readinessTtlMs: 0
    });

    await expect(collector.readiness()).resolves.toMatchObject({
      status: "not_ready", components: { instanceRuntime: { ok: false, error: "runtime unavailable" } }
    });
    expect(runtimeSnapshot).toHaveBeenCalledOnce();
  });

  it("isolates and redacts a diagnostic failure while preserving sibling status", async () => {
    store = new SqliteBindingStore(":memory:");
    const collector = new HealthSnapshotCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { async assertWorkspace() {} } as never, lease,
      workspaceCache: { status() { throw new Error("Bearer collector-secret"); } },
      herdrSocket: { status: () => ({ connected: true }) } as never, buildIdentity
    });

    const status = await collector.status();
    expect(status).toMatchObject({ status: "degraded", workspaceCache: { error: "Bearer [REDACTED]" }, herdrSocket: { connected: true } });
    expect(JSON.stringify(status)).not.toContain("collector-secret");
  });

  it("shares one in-flight workspace probe across concurrent reads", async () => {
    store = new SqliteBindingStore(":memory:");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const assertWorkspace = vi.fn(async () => { await gate; });
    const collector = new HealthSnapshotCollector({
      store, projects: [project], lark: { isReady: () => true }, herdr: { assertWorkspace } as never,
      lease, buildIdentity, readinessTtlMs: 60_000
    });

    const readiness = collector.readiness();
    const status = collector.status();
    await vi.waitFor(() => expect(assertWorkspace).toHaveBeenCalledOnce());
    release();
    await Promise.all([readiness, status]);
    expect(assertWorkspace).toHaveBeenCalledOnce();
  });
});
