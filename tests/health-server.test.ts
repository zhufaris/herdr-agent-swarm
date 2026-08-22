import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startHealthServer } from "../src/health/server.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

let server: Awaited<ReturnType<typeof startHealthServer>> | undefined;
let store: SqliteBindingStore | undefined;
afterEach(async () => {
  if (server) { server.close(); await once(server, "close"); server = undefined; }
  store?.close(); store = undefined;
});

describe("health server", () => {
  it("reports every readiness component and exposes a safe operational status", async () => {
    store = new SqliteBindingStore(":memory:");
    const projects = [{ id: "missing", displayName: "Missing", description: "Missing", workspaceId: "w1", cwd: "/definitely/missing/project" }];
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects, lark: { isReady: () => false } as never,
      herdr: { async assertWorkspace() { throw new Error("workspace unavailable"); } } as never,
      lease: { snapshot: () => ({ held: true, ownerSuffix: "owner123", fencingToken: 4, expiresAt: "2099-01-01T00:00:00.000Z", lastRenewedAt: "2098-12-31T23:59:55.000Z", error: null }) }
    });
    const port = (server.address() as AddressInfo).port;

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
    expect(body).toMatchObject({ status: "degraded", readiness: { status: "not_ready" }, operational: { pendingOutbox: 0, deadLetters: 0 } });
    expect(body).toHaveProperty("uptimeSeconds");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("lease.ownerSuffix", "owner123");
    expect(JSON.stringify(body)).not.toContain("payload");
  });

  it("becomes not ready when lease ownership is lost", async () => {
    store = new SqliteBindingStore(":memory:");
    server = await startHealthServer({
      host: "127.0.0.1", port: 0, store, projects: [{ id: "ok", displayName: "OK", description: "OK", workspaceId: "w1", cwd: process.cwd() }],
      lark: { isReady: () => true } as never, herdr: { async assertWorkspace() {} } as never,
      lease: { snapshot: () => ({ held: false, ownerSuffix: "owner123", fencingToken: 4, expiresAt: null, lastRenewedAt: null, error: "fence changed" }) }
    });
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready", components: { lease: { ok: false, held: false, error: "fence changed" } } });
  });
});
