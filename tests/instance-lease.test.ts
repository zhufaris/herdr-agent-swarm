import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceLeaseController } from "../src/runtime/instance-lease.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

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

  it("fences every application table after another owner takes over", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-fence-"));
    const path = join(directory, "bridge.db");
    const first = new SqliteBindingStore(path);
    const second = new SqliteBindingStore(path);
    stores.push(first, second);
    const base = Date.now();
    const timestamp = (offset: number) => new Date(base + offset).toISOString();
    const firstLease = first.acquireInstanceLease("owner-a", timestamp(0), timestamp(15_000))!;
    first.activateWriteFence(firstLease.ownerId, firstLease.fencingToken);
    const applicationTables = first.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT IN ('schema_migrations', 'instance_lease', 'sqlite_sequence')").get() as { count: number };
    expect(first.database.prepare("SELECT COUNT(*) AS count FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'bridge_fence_%'").get()).toEqual({ count: applicationTables.count * 3 });
    first.createPendingBinding({ id: "before", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Before" });

    const secondLease = second.acquireInstanceLease("owner-b", timestamp(15_000), timestamp(30_000))!;
    second.activateWriteFence(secondLease.ownerId, secondLease.fencingToken);

    expect(() => first.createPendingBinding({ id: "stale", workspaceId: "w1", chatId: "c1", topicId: "t2", rootMessageId: "m2", title: "Stale" })).toThrow(/stale_instance_lease/);
    expect(() => first.updateBinding("before", { title: "Stale update" })).toThrow(/stale_instance_lease/);
    expect(() => first.recordInboundMessage({ eventId: "e1", messageId: "m3", chatId: "c1", topicId: "t1", rootMessageId: "m1", actorOpenId: "u1", text: "hello", mentionsBot: false, isRootMessage: false })).toThrow(/stale_instance_lease/);
    expect(() => first.enqueueOutboundReply({ id: "o1", idempotencyKey: "stale:o1", bindingId: null, rootMessageId: "m1", kind: "text", payload: "hello" })).toThrow(/stale_instance_lease/);
    expect(() => first.audit({ actorOpenId: "u1", action: "stale", target: "b1", outcome: "rejected" })).toThrow(/stale_instance_lease/);
    expect(() => first.database.prepare("INSERT INTO topic_views(binding_id, state_json, updated_at) VALUES ('before', '{}', 'now')").run()).toThrow(/stale_instance_lease/);
    expect(() => first.database.prepare("INSERT INTO lifecycle_events(event_id, binding_id, event_type, payload_json, occurred_at) VALUES ('le1', 'before', 'test', '{}', 'now')").run()).toThrow(/stale_instance_lease/);
    expect(() => first.createPaneCloseRequest({ id: "close-1", bindingId: "before", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", expiresAt: timestamp(60_000) })).toThrow(/stale_instance_lease/);

    expect(second.createPendingBinding({ id: "current", workspaceId: "w1", chatId: "c1", topicId: "t3", rootMessageId: "m3", title: "Current" })).toMatchObject({ id: "current" });
    first.deactivateWriteFence();
    expect(first.releaseInstanceLease("owner-a", firstLease.fencingToken)).toBe(false);
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
    expect(lease.writeFence()).toMatchObject({ ownerId: "owner-a", fencingToken: 1 });
    lease.start(lost);
    expect(lease.snapshot()).toMatchObject({ held: true, fencingToken: 1, error: null });

    current = 15_000;
    expect(lease.renewNow()).toBe(false);
    await Promise.resolve();
    expect(lease.snapshot()).toMatchObject({ held: false, fencingToken: 1 });
    expect(lost).toHaveBeenCalledOnce();
  });

  it("contains and logs a rejected lease-loss shutdown callback", async () => {
    const store = new SqliteBindingStore(":memory:");
    stores.push(store);
    let current = 0;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const lease = new InstanceLeaseController(store, { ttlMs: 15_000, heartbeatMs: 5_000 }, logger as never, () => current, "owner-a");
    lease.acquire();
    lease.start(async () => { throw new Error("shutdown failed"); });

    current = 15_000;
    expect(lease.renewNow()).toBe(false);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "instance-lease-shutdown-failed", outcome: "failed" }), "bridge shutdown failed after instance lease loss"));
  });
});

function at(offsetMs: number): string { return new Date(Date.UTC(2026, 7, 22) + offsetMs).toISOString(); }
