import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstanceLeaseController } from "../src/runtime/instance-lease.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { classifySqliteFailure, SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteLeaseStore } from "../src/store/sqlite/lease-store.js";
import { createInstanceLeaseSchema } from "../src/store/sqlite/schema.js";
import { CURRENT_TABLE_MANIFEST } from "../src/store/sqlite/schema-manifest.js";

let directory: string | undefined;
const stores: SqliteBindingStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("SQLite instance lease", () => {
  it("does not install duplicate heartbeat timers when started twice", async () => {
    vi.useFakeTimers();
    const store = new SqliteBindingStore(":memory:");
    stores.push(store);
    const renew = vi.spyOn(store, "renewInstanceLease");
    const lease = new InstanceLeaseController(store, { ttlMs: 15_000, heartbeatMs: 5_000 }, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, () => 0, "owner");
    lease.acquire();
    lease.start(vi.fn());
    lease.start(vi.fn());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(renew).toHaveBeenCalledOnce();
    lease.release();
    vi.useRealTimers();
  });

  it("recovers prior-owner claims in deterministic bounded pages under an exact fence", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-stale-claims-"));
    const path = join(directory, "bridge.db");
    const store = new SqliteBindingStore(path);
    stores.push(store);
    const first = store.acquireInstanceLease("owner-a", at(0), "2099-01-01T00:00:00.000Z")!;
    store.activateWriteFence(first.ownerId, first.fencingToken);
    for (const id of ["e", "d", "c", "b", "a"]) {
      store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: `root-${id}`, kind: "card_update", payload: "{}" });
      store.database.prepare(`UPDATE outbound_replies SET claim_attempt_id=?,claimed_owner_id=?,claimed_fence=?,
        claimed_at=?,claim_expires_at=?,first_claimed_at=? WHERE id=?`).run(
        `claim-${id}`, first.ownerId, first.fencingToken, at(1), at(10_000), at(1), id
      );
    }
    store.deactivateWriteFence();
    store.database.prepare("UPDATE instance_lease SET expires_at=?,expires_at_ms=?").run("2000-01-01T00:00:00.000Z", Date.UTC(2000, 0, 1));
    const next = store.acquireInstanceLease("owner-b", new Date().toISOString(), "2099-01-01T00:00:00.000Z")!;
    store.activateWriteFence(next.ownerId, next.fencingToken);
    store.database.prepare("UPDATE outbound_replies SET claimed_owner_id=NULL,claimed_fence=NULL WHERE id='e'").run();
    store.enqueueOutboundReply({ id: "z", idempotencyKey: "z", rootMessageId: "root-z", kind: "card_update", payload: "{}" });
    store.database.prepare(`UPDATE outbound_replies SET claim_attempt_id='claim-z',claimed_owner_id=?,claimed_fence=?,
      claimed_at=?,claim_expires_at=?,first_claimed_at=? WHERE id='z'`).run(next.ownerId, next.fencingToken, at(1), at(10_000), at(1));

    const firstPage = store.recoverPriorOwnerClaimsBatch(next.ownerId, next.fencingToken, null, 2, "2026-10-08T00:00:00.000Z");
    expect(firstPage).toEqual({ recoveredCount: 2, next: { afterId: "b", highWaterId: "e" }, hasMore: true });
    const secondPage = store.recoverPriorOwnerClaimsBatch(next.ownerId, next.fencingToken, firstPage.next, 2, "2026-10-08T00:00:01.000Z");
    expect(secondPage).toEqual({ recoveredCount: 2, next: { afterId: "d", highWaterId: "e" }, hasMore: true });
    const finalPage = store.recoverPriorOwnerClaimsBatch(next.ownerId, next.fencingToken, secondPage.next, 2, "2026-10-08T00:00:02.000Z");
    expect(finalPage).toEqual({ recoveredCount: 1, next: { afterId: "e", highWaterId: "e" }, hasMore: false });
    expect(store.database.prepare(`SELECT id,state,claim_attempt_id,claimed_owner_id,claimed_fence,claimed_at,claim_expires_at,effect_certainty
      FROM outbound_replies WHERE id!='z' ORDER BY id`).all()).toEqual(Array.from({ length: 5 }, (_, index) => ({
        id: String.fromCharCode(97 + index), state: "dead_letter", claim_attempt_id: null, claimed_owner_id: null,
        claimed_fence: null, claimed_at: null, claim_expires_at: null, effect_certainty: "uncertain"
      })));
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbox_lane_quarantines WHERE state='active'").get()).toEqual({ count: 5 });
    expect(store.database.prepare("SELECT state,claim_attempt_id FROM outbound_replies WHERE id='z'").get()).toEqual({ state: "pending", claim_attempt_id: "claim-z" });
    expect(() => store.recoverPriorOwnerClaimsBatch("owner-a", first.fencingToken, null, 2)).toThrow(/stale_instance_lease/);
  });

  it("rolls back a failed page and discovers its later claims after reopen", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-stale-claim-rollback-"));
    const path = join(directory, "bridge.db");
    let store = new SqliteBindingStore(path);
    stores.push(store);
    const first = store.acquireInstanceLease("owner-a", at(0), "2099-01-01T00:00:00.000Z")!;
    store.activateWriteFence(first.ownerId, first.fencingToken);
    for (const id of ["a", "b", "c", "d", "e"]) {
      store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: `root-${id}`, kind: "card_update", payload: "{}" });
      store.database.prepare(`UPDATE outbound_replies SET claim_attempt_id=?,claimed_owner_id=?,claimed_fence=?,
        claimed_at=?,claim_expires_at=?,first_claimed_at=? WHERE id=?`).run(`claim-${id}`, first.ownerId, first.fencingToken, at(1), at(10_000), at(1), id);
    }
    store.deactivateWriteFence();
    store.database.prepare("UPDATE instance_lease SET expires_at=?,expires_at_ms=?").run("2000-01-01T00:00:00.000Z", Date.UTC(2000, 0, 1));
    const second = store.acquireInstanceLease("owner-b", new Date().toISOString(), "2099-01-01T00:00:00.000Z")!;
    store.activateWriteFence(second.ownerId, second.fencingToken);
    const committed = store.recoverPriorOwnerClaimsBatch(second.ownerId, second.fencingToken, null, 2);
    store.database.exec(`CREATE TEMP TRIGGER fail_stale_claim_page BEFORE INSERT ON main.outbox_lane_quarantines
      WHEN NEW.failed_reply_id='d' BEGIN SELECT RAISE(ABORT,'injected_stale_claim_failure'); END`);
    expect(() => store.recoverPriorOwnerClaimsBatch(second.ownerId, second.fencingToken, committed.next, 2)).toThrow(/injected_stale_claim_failure/);
    expect(store.database.prepare("SELECT id,state FROM outbound_replies WHERE id IN ('c','d') ORDER BY id").all())
      .toEqual([{ id: "c", state: "pending" }, { id: "d", state: "pending" }]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbox_lane_quarantines WHERE failed_reply_id IN ('c','d')").get()).toEqual({ count: 0 });
    stores.splice(stores.indexOf(store), 1);
    store.close();

    store = new SqliteBindingStore(path);
    stores.push(store);
    store.database.prepare("UPDATE instance_lease SET expires_at=?,expires_at_ms=?").run("2000-01-01T00:00:00.000Z", Date.UTC(2000, 0, 1));
    const third = store.acquireInstanceLease("owner-c", new Date().toISOString(), "2099-01-01T00:00:00.000Z")!;
    store.activateWriteFence(third.ownerId, third.fencingToken);
    const resumed = store.recoverPriorOwnerClaimsBatch(third.ownerId, third.fencingToken, null, 10);
    expect(resumed.recoveredCount).toBe(3);
    expect(store.database.prepare("SELECT id,state FROM outbound_replies ORDER BY id").all())
      .toEqual(["a", "b", "c", "d", "e"].map((id) => ({ id, state: "dead_letter" })));
  });

  it("rejects a second live owner and allows expired takeover with a higher fence", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-"));
    const path = join(directory, "bridge.db");
    const first = new SqliteBindingStore(path);
    const second = new SqliteBindingStore(path);
    stores.push(first, second);

    expect(first.acquireInstanceLease("owner-a", at(0), at(15_000))).toMatchObject({ fencingToken: 1 });
    expect(second.acquireInstanceLease("owner-b", at(14_999), at(29_999))).toBeNull();
    expect(second.acquireInstanceLease("owner-b", at(15_000), at(30_000))).toMatchObject({ ownerId: "owner-b", fencingToken: 2 });
    expect(first.renewInstanceLease("owner-a", 1, 15_000)).toBeNull();
    expect(first.releaseInstanceLease("owner-a", 1)).toBe(false);
    expect(second.releaseInstanceLease("owner-b", 2)).toBe(true);
  });

  it.each([
    "2026-08-22T00:00:15Z",
    "2026-08-22T00:00:15.000+00:00",
    "2026-08-21T20:00:15.000-04:00"
  ])("normalizes a compatible lease expiry to exact millisecond takeover semantics: %s", (storedExpiry) => {
    const context = new SqliteContext(":memory:");
    context.database.exec(`CREATE TABLE instance_lease(
      singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),owner_id TEXT NOT NULL,fencing_token INTEGER NOT NULL,
      expires_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
    const store = new SqliteLeaseStore(context);
    try {
      context.database.prepare(`INSERT INTO instance_lease(singleton_id,owner_id,fencing_token,expires_at,updated_at)
        VALUES (1,'owner-a',1,?,'2026-08-22T00:00:00.000Z')`).run(storedExpiry);
      expect(store.acquireInstanceLease("owner-b", "2026-08-22T00:00:14.999Z", "2026-08-22T00:00:29.999Z")).toBeNull();
      expect(store.acquireInstanceLease("owner-b", "2026-08-22T00:00:15.000Z", "2026-08-22T00:00:30.000Z"))
        .toMatchObject({ ownerId: "owner-b", fencingToken: 2 });
    } finally {
      context.close();
    }
  });

  it("stores the normalized expiry milliseconds alongside the compatible ISO lease value", () => {
    const context = new SqliteContext(":memory:");
    createInstanceLeaseSchema(context);
    const store = new SqliteLeaseStore(context);
    try {
      expect(context.database.prepare("PRAGMA table_info(instance_lease)").all()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "expires_at_ms", notnull: 1 })
      ]));
      store.acquireInstanceLease("owner", "2026-08-22T00:00:00.000Z", "2026-08-22T00:00:15.000+00:00");
      expect(context.database.prepare("SELECT expires_at,expires_at_ms FROM instance_lease").get()).toEqual({
        expires_at: "2026-08-22T00:00:15.000+00:00",
        expires_at_ms: Date.UTC(2026, 7, 22, 0, 0, 15)
      });
      context.database.prepare("UPDATE instance_lease SET expires_at_ms=expires_at_ms+1").run();
      expect(() => store.acquireInstanceLease("owner", "2026-08-22T00:00:01.000Z", "2026-08-22T00:00:16.000Z"))
        .toThrow(/expires_at.*expires_at_ms disagree/i);
    } finally {
      context.close();
    }
  });

  it("uses one post-BEGIN timestamp to renew only a live matching lease", () => {
    const context = new SqliteContext(":memory:");
    createInstanceLeaseSchema(context);
    let current = Date.UTC(2026, 7, 22) + 5_000;
    const store = new SqliteLeaseStore(context, () => current);
    try {
      expect(store.acquireInstanceLease("owner", at(0), at(15_000))).toMatchObject({ fencingToken: 1 });
      expect(store.renewInstanceLease("owner", 1, 15_000)).toMatchObject({ expiresAt: at(20_000), updatedAt: at(5_000) });
      current = Date.UTC(2026, 7, 22) + 20_000;
      expect(store.renewInstanceLease("owner", 1, 15_000)).toBeNull();
      expect(context.database.prepare("SELECT expires_at, updated_at FROM instance_lease").get()).toEqual({ expires_at: at(20_000), updated_at: at(5_000) });
    } finally {
      context.close();
    }
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
    const durableTables = (first.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
    expect(CURRENT_TABLE_MANIFEST.map(({ name }) => name).sort()).toEqual(durableTables);
    expect(CURRENT_TABLE_MANIFEST.filter(({ lease }) => lease.kind === "exempt")).toEqual([
      expect.objectContaining({ name: "instance_lease", lease: expect.objectContaining({ kind: "exempt", reason: expect.any(String) }) }),
      expect.objectContaining({ name: "schema_metadata", lease: expect.objectContaining({ kind: "exempt", reason: expect.any(String) }) }),
      expect.objectContaining({ name: "schema_migrations", lease: expect.objectContaining({ kind: "exempt", reason: expect.any(String) }) })
    ]);
    const expectedTriggers = CURRENT_TABLE_MANIFEST
      .filter(({ lease }) => lease.kind === "fenced")
      .flatMap(({ name }) => ["delete", "insert", "update"].map((operation) => ({
        name: `bridge_fence_${name}_${operation}`,
        tableName: name
      })))
      .sort((left, right) => left.name.localeCompare(right.name));
    const actualTriggers = (first.database.prepare(`SELECT name,tbl_name AS tableName FROM sqlite_temp_master
      WHERE type='trigger' AND name LIKE 'bridge_fence_%' ORDER BY name`).all() as Array<{ name: string; tableName: string }>);
    expect(actualTriggers).toEqual(expectedTriggers);
    first.createPendingBinding({ id: "before", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Before" });

    const secondLease = second.acquireInstanceLease("owner-b", timestamp(15_000), timestamp(30_000))!;
    second.activateWriteFence(secondLease.ownerId, secondLease.fencingToken);

    for (const table of CURRENT_TABLE_MANIFEST.filter(({ lease }) => lease.kind === "fenced")) {
      expect(() => first.database.prepare(`INSERT INTO "${table.name}" DEFAULT VALUES`).run(), table.name).toThrow(/stale_instance_lease/);
    }

    expect(() => first.createPendingBinding({ id: "stale", workspaceId: "w1", chatId: "c1", topicId: "t2", rootMessageId: "m2", title: "Stale" })).toThrow(/stale_instance_lease/);
    expect(() => first.updateBinding("before", { title: "Stale update" })).toThrow(/stale_instance_lease/);
    expect(() => first.recordInboundMessage({ eventId: "e1", messageId: "m3", chatId: "c1", topicId: "t1", rootMessageId: "m1", actorOpenId: "u1", text: "hello", mentionsBot: false, isRootMessage: false })).toThrow(/stale_instance_lease/);
    expect(() => first.enqueueOutboundReply({ id: "o1", idempotencyKey: "stale:o1", bindingId: null, rootMessageId: "m1", kind: "text", payload: "hello" })).toThrow(/stale_instance_lease/);
    expect(() => first.audit({ actorOpenId: "u1", action: "stale", target: "b1", outcome: "rejected" })).toThrow(/stale_instance_lease/);
    expect(() => first.database.prepare("INSERT INTO topic_views(binding_id, state_json, updated_at) VALUES ('before', '{}', 'now')").run()).toThrow(/stale_instance_lease/);
    expect(() => first.database.prepare("INSERT INTO lifecycle_events(event_id, binding_id, event_type, payload_json, occurred_at) VALUES ('le1', 'before', 'test', '{}', 'now')").run()).toThrow(/stale_instance_lease/);
    expect(() => first.database.prepare(`
      INSERT INTO prompt_identity_corrections(
        alias_prompt_id, canonical_prompt_id, binding_id, binding_generation, pane_id, native_session_id, turn_id,
        legacy_started_at, canonical_started_at, reason, created_at
      ) VALUES (
        'alias-before', 'canonical-before', 'before', 1, 'w1:p1', 'session-1', 'turn-1',
        '2026-09-30T00:00:01.000Z', '2026-09-30T00:00:02.000Z', 'canonical_start_correction', '2026-09-30T00:00:03.000Z'
      )
    `).run()).toThrow(/stale_instance_lease/);
    expect(() => first.createPaneCloseRequest({ id: "close-1", bindingId: "before", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", expiresAt: timestamp(60_000) })).toThrow(/stale_instance_lease/);
    expect(second.createPendingBinding({ id: "current", workspaceId: "w1", chatId: "c1", topicId: "t3", rootMessageId: "m3", title: "Current" })).toMatchObject({ id: "current" });
    first.deactivateWriteFence();
    expect(first.releaseInstanceLease("owner-a", firstLease.fencingToken)).toBe(false);
  });

  it("removes partial temporary fence state when a manifested table is unavailable", () => {
    const store = new SqliteBindingStore(":memory:");
    stores.push(store);
    const lease = store.acquireInstanceLease("owner", new Date().toISOString(), "2099-01-01T00:00:00.000Z")!;
    store.database.exec("DROP TABLE audit_log");

    expect(() => store.activateWriteFence(lease.ownerId, lease.fencingToken)).toThrow(/audit_log|no such table/i);
    expect(store.database.prepare(`SELECT name FROM sqlite_temp_master
      WHERE name='bridge_write_fence' OR name LIKE 'bridge_fence_%'`).all()).toEqual([]);
  });

  it("rejects stale lazy delivery-checkpoint bootstrap after lease takeover", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-checkpoint-fence-"));
    const path = join(directory, "bridge.db");
    const first = new SqliteBindingStore(path);
    const second = new SqliteBindingStore(path);
    stores.push(first, second);
    const base = Date.now();
    const timestamp = (offset: number) => new Date(base + offset).toISOString();
    const firstLease = first.acquireInstanceLease("owner-a", timestamp(0), timestamp(15_000))!;
    first.activateWriteFence(firstLease.ownerId, firstLease.fencingToken);
    const secondLease = second.acquireInstanceLease("owner-b", timestamp(15_000), timestamp(30_000))!;
    second.activateWriteFence(secondLease.ownerId, secondLease.fencingToken);

    expect(() => first.preparedDeliveries.loadOrInitializeCheckpoint({
      scope: { kind: "global" }, at: timestamp(15_001)
    })).toThrow(/stale_instance_lease/);
    expect(second.database.prepare("SELECT 1 FROM delivery_ring_checkpoints WHERE scope_key='[\"global\"]'").get()).toBeUndefined();
  });
});

describe("instance lease controller", () => {
  it("retries classified lock contention outside the failed renewal attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00.000Z"));
    try {
      let renewalAttempts = 0;
      const store = {
        acquireInstanceLease(ownerId: string, now: string, expiresAt: string) {
          return { ownerId, fencingToken: 1, expiresAt, updatedAt: now };
        },
        renewInstanceLease(ownerId: string, _fencingToken: number, ttlMs: number) {
          renewalAttempts += 1;
          if (renewalAttempts === 1) throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
          const now = new Date(Date.now()).toISOString();
          return { ownerId, fencingToken: 1, expiresAt: new Date(Date.now() + ttlMs).toISOString(), updatedAt: now };
        },
        releaseInstanceLease() { return true; }
      };
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const lost = vi.fn();
      const lease = new InstanceLeaseController(store, {
        ttlMs: 15_000,
        heartbeatMs: 5_000,
        sqliteBusyTimeoutMs: 10,
        sqliteBusyRetryBudgetMs: 100,
        classifySqliteFailure,
        random: () => 0
      }, logger as never, Date.now, "owner-a");
      lease.acquire();
      lease.start(lost);

      const renewal = lease.renewNow();
      expect(renewalAttempts).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
        event: "instance-lease-renewal-retry-scheduled",
        failureClass: "busy",
        outcome: "retry_scheduled"
      }), "SQLite lock contention delayed the instance lease heartbeat");

      await vi.advanceTimersByTimeAsync(1);
      await expect(renewal).resolves.toBe(true);
      expect(renewalAttempts).toBe(2);
      expect(lease.snapshot()).toMatchObject({ held: true, error: null });
      expect(lost).not.toHaveBeenCalled();
      lease.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks the absolute deadline after a delayed retry timer and returns false without entering SQLite", async () => {
    vi.useFakeTimers();
    try {
      let current = 0;
      let renewalAttempts = 0;
      const store = {
        acquireInstanceLease(ownerId: string, now: string, expiresAt: string) { return { ownerId, fencingToken: 1, expiresAt, updatedAt: now }; },
        renewInstanceLease() {
          renewalAttempts += 1;
          throw Object.assign(new Error("busy"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
        },
        releaseInstanceLease() { return true; }
      };
      const lost = vi.fn();
      const lease = new InstanceLeaseController(store, {
        ttlMs: 15_000, heartbeatMs: 5_000, sqliteBusyTimeoutMs: 10, sqliteBusyRetryBudgetMs: 100,
        classifySqliteFailure, random: () => 0
      }, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, () => current, "owner-a");
      lease.acquire();
      lease.start(lost);
      const renewal = lease.renewNow();
      expect(renewalAttempts).toBe(1);

      current = 101;
      await vi.advanceTimersByTimeAsync(1);

      await expect(renewal).resolves.toBe(false);
      expect(renewalAttempts).toBe(1);
      expect(lease.snapshot()).toMatchObject({ held: false, error: expect.stringMatching(/deadline exhausted/) });
      expect(lost).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries startup renewal contention before an onLost callback is installed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00.000Z"));
    try {
      let renewalAttempts = 0;
      const store = {
        acquireInstanceLease(ownerId: string, now: string, expiresAt: string) { return { ownerId, fencingToken: 1, expiresAt, updatedAt: now }; },
        renewInstanceLease(ownerId: string, _fencingToken: number, ttlMs: number) {
          renewalAttempts += 1;
          if (renewalAttempts === 1) throw Object.assign(new Error("locked"), { code: "ERR_SQLITE_ERROR", errcode: 6 });
          const now = Date.now();
          return { ownerId, fencingToken: 1, expiresAt: new Date(now + ttlMs).toISOString(), updatedAt: new Date(now).toISOString() };
        },
        releaseInstanceLease() { return true; }
      };
      const lease = new InstanceLeaseController(store, {
        ttlMs: 15_000, heartbeatMs: 5_000, sqliteBusyTimeoutMs: 10, sqliteBusyRetryBudgetMs: 100,
        classifySqliteFailure, random: () => 0
      }, { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, Date.now, "owner-a");
      lease.acquire();
      const renewal = lease.renewNow();
      expect(renewalAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(renewal).resolves.toBe(true);
      expect(renewalAttempts).toBe(2);
      expect(lease.snapshot()).toMatchObject({ held: true, error: null });
      lease.release();
    } finally {
      vi.useRealTimers();
    }
  });

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
    await expect(lease.renewNow()).resolves.toBe(false);
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
    await expect(lease.renewNow()).resolves.toBe(false);
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "instance-lease-shutdown-failed", outcome: "failed" }), "bridge shutdown failed after instance lease loss"));
  });
});

function at(offsetMs: number): string { return new Date(Date.UTC(2026, 7, 22) + offsetMs).toISOString(); }
