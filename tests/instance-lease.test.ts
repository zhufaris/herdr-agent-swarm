import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceLeaseController } from "../src/runtime/instance-lease.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

let directory: string | undefined;
const stores: SqliteBindingStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("SQLite instance lease", () => {
  it("rejects a second live owner and allows expired takeover with a higher fence", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-"));
    const path = join(directory, "bridge.db");
    const first = new SqliteBindingStore(path);
    const second = new SqliteBindingStore(path);
    stores.push(first, second);

    expect(first.acquireInstanceLease("owner-a", at(0), at(15_000))).toMatchObject({ fencingToken: 1 });
    expect(second.acquireInstanceLease("owner-b", at(14_999), at(29_999))).toBeNull();
    expect(second.acquireInstanceLease("owner-b", at(15_000), at(30_000))).toMatchObject({ ownerId: "owner-b", fencingToken: 2 });
    expect(first.renewInstanceLease("owner-a", 1, at(15_001), at(30_001))).toBeNull();
    expect(first.releaseInstanceLease("owner-a", 1)).toBe(false);
    expect(second.releaseInstanceLease("owner-b", 2)).toBe(true);
  });

  it("renews only a live matching lease", () => {
    const store = new SqliteBindingStore(":memory:");
    stores.push(store);
    expect(store.acquireInstanceLease("owner", at(0), at(15_000))).toMatchObject({ fencingToken: 1 });
    expect(store.renewInstanceLease("owner", 1, at(5_000), at(20_000))).toMatchObject({ expiresAt: at(20_000), updatedAt: at(5_000) });
    expect(store.renewInstanceLease("owner", 1, at(20_000), at(35_000))).toBeNull();
  });
});

describe("instance lease controller", () => {
  it("marks itself unhealthy and triggers shutdown when renewal loses fencing", async () => {
    const store = new SqliteBindingStore(":memory:");
    stores.push(store);
    let current = 0;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const lost = vi.fn();
    const lease = new InstanceLeaseController(store, { ttlMs: 15_000, heartbeatMs: 5_000 }, logger as never, () => current, "owner-a");
    lease.acquire();
    lease.start(lost);
    expect(lease.snapshot()).toMatchObject({ held: true, fencingToken: 1, error: null });

    current = 15_000;
    expect(lease.renewNow()).toBe(false);
    await Promise.resolve();
    expect(lease.snapshot()).toMatchObject({ held: false, fencingToken: 1 });
    expect(lost).toHaveBeenCalledOnce();
  });
});

function at(offsetMs: number): string { return new Date(Date.UTC(2026, 7, 22) + offsetMs).toISOString(); }
