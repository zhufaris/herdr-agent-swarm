import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteLeaseBootstrap } from "../src/store/sqlite-lease-bootstrap.js";
import { SqliteContext } from "../src/store/sqlite/context.js";

let directory: string | undefined;

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("SQLite lease bootstrap", () => {
  it("creates only the lease schema before completing business migrations", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-bootstrap-"));
    const path = join(directory, "bridge.db");
    const bootstrap = openSqliteLeaseBootstrap(path);
    let inspector = new DatabaseSync(path);

    expect(tableNames(inspector)).toEqual(["instance_lease"]);
    inspector.close();

    const lease = bootstrap.lease.acquireInstanceLease("owner", now(), later())!;
    const stores = bootstrap.complete(lease);
    inspector = new DatabaseSync(path);
    expect(tableNames(inspector)).toContain("bindings");
    expect(tableNames(inspector)).toContain("schema_migrations");
    inspector.close();
    stores.lifecycle.close();
  });

  it("does not migrate business schema when a second bootstrap loses lease contention", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-contention-"));
    const path = join(directory, "bridge.db");
    const seed = new DatabaseSync(path);
    seed.exec("CREATE TABLE legacy_business_marker(id TEXT PRIMARY KEY)");
    seed.close();
    const owner = openSqliteLeaseBootstrap(path);
    const contender = openSqliteLeaseBootstrap(path);

    expect(owner.lease.acquireInstanceLease("owner-a", now(), later())).toMatchObject({ fencingToken: 1 });
    expect(contender.lease.acquireInstanceLease("owner-b", now(), later())).toBeNull();
    contender.close();

    const inspector = new DatabaseSync(path);
    expect(tableNames(inspector)).toEqual(["instance_lease", "legacy_business_marker"]);
    expect(inspector.prepare("PRAGMA table_info(legacy_business_marker)").all()).toEqual([expect.objectContaining({ name: "id", type: "TEXT" })]);
    inspector.close();
    expect(owner.lease.releaseInstanceLease("owner-a", 1)).toBe(true);
    owner.close();
  });

  it("transfers the connection exactly once when completion succeeds", () => {
    const bootstrap = openSqliteLeaseBootstrap(":memory:");
    const lease = bootstrap.lease.acquireInstanceLease("owner", now(), later())!;
    const stores = bootstrap.complete(lease);

    expect(() => bootstrap.complete(lease)).toThrow(/already completed/);
    expect(() => bootstrap.close()).toThrow(/already completed/);
    stores.lifecycle.close();
  });

  it("uses the fresh reservation only for fresh bootstrap and no migration writer transaction for current-fast", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-routes-"));
    const path = join(directory, "bridge.db");
    const freshDiagnostics: Array<{ operation: string; outcome: string }> = [];
    const fresh = openSqliteLeaseBootstrap(path, {
      slowTransactionThresholdMs: 0,
      onTransactionDiagnostic(diagnostic) { freshDiagnostics.push(diagnostic); }
    });
    const freshLease = fresh.lease.acquireInstanceLease("fresh-owner", now(), later())!;
    const freshStores = fresh.complete(freshLease);

    expect(freshDiagnostics).toContainEqual(expect.objectContaining({ operation: "sqlite.migrations.fresh-baseline", outcome: "committed" }));
    expect(fresh.lease.releaseInstanceLease(freshLease.ownerId, freshLease.fencingToken)).toBe(true);
    freshStores.lifecycle.close();

    const currentDiagnostics: Array<{ operation: string; outcome: string }> = [];
    const current = openSqliteLeaseBootstrap(path, {
      slowTransactionThresholdMs: 0,
      onTransactionDiagnostic(diagnostic) { currentDiagnostics.push(diagnostic); }
    });
    const currentLease = current.lease.acquireInstanceLease("current-owner", now(), later())!;
    const currentStores = current.complete(currentLease);

    expect(currentDiagnostics.filter((diagnostic) => diagnostic.operation.startsWith("sqlite.migrations."))).toEqual([
      expect.objectContaining({ operation: "sqlite.migrations.bootstrap", outcome: "manual_completed" })
    ]);
    expect(currentDiagnostics.some((diagnostic) => diagnostic.operation === "sqlite.migrations.fresh-baseline")).toBe(false);
    expect(current.lease.releaseInstanceLease(currentLease.ownerId, currentLease.fencingToken)).toBe(true);
    currentStores.lifecycle.close();
  });

  it("acquires through the epoch-5 lease shape before atomically upgrading its live lease to milliseconds", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-epoch5-"));
    const path = join(directory, "bridge.db");
    const seed = openSqliteLeaseBootstrap(path);
    const seedLease = seed.lease.acquireInstanceLease("seed", now(), later())!;
    const seedStores = seed.complete(seedLease);
    expect(seed.lease.releaseInstanceLease(seedLease.ownerId, seedLease.fencingToken)).toBe(true);
    seedStores.lifecycle.close();

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE instance_lease_epoch5(
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),owner_id TEXT NOT NULL,fencing_token INTEGER NOT NULL,
        expires_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      DROP TABLE instance_lease;
      ALTER TABLE instance_lease_epoch5 RENAME TO instance_lease;
      DELETE FROM schema_migrations WHERE version=115;
      UPDATE schema_metadata SET epoch='2026-10-08.5',fingerprint='epoch-5-fixture' WHERE singleton_id=1;
    `);
    legacy.close();

    const bootstrap = openSqliteLeaseBootstrap(path);
    const lease = bootstrap.lease.acquireInstanceLease("upgrade-owner", now(), later())!;
    const stores = bootstrap.complete(lease);
    const inspector = new DatabaseSync(path);
    expect(inspector.prepare("SELECT expires_at,expires_at_ms FROM instance_lease").get()).toEqual({
      expires_at: lease.expiresAt,
      expires_at_ms: Date.parse(lease.expiresAt)
    });
    expect(inspector.prepare("SELECT version FROM schema_migrations WHERE version=115").get()).toEqual({ version: 115 });
    inspector.close();
    expect(bootstrap.lease.releaseInstanceLease(lease.ownerId, lease.fencingToken)).toBe(true);
    stores.lifecycle.close();
  });

  it("completes a historical foreign-key rebuild through bootstrap without a fresh outer transaction", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-historical-rebuild-"));
    const path = join(directory, "bridge.db");
    const seed = openSqliteLeaseBootstrap(path);
    const seedLease = seed.lease.acquireInstanceLease("seed-owner", now(), later())!;
    const seedStores = seed.complete(seedLease);
    expect(seed.lease.releaseInstanceLease(seedLease.ownerId, seedLease.fencingToken)).toBe(true);
    seedStores.lifecycle.close();

    const historical = new DatabaseSync(path);
    historical.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      ALTER TABLE worker_pane_close_steps RENAME TO worker_pane_close_steps_current;
      CREATE TABLE worker_pane_close_steps(
        operation_id TEXT NOT NULL REFERENCES pane_close_requests(id) ON DELETE CASCADE, binding_id TEXT NOT NULL, parent_pane_id TEXT NOT NULL, worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, pane_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('executing','succeeded','uncertain')), detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(operation_id, worker_id, pane_id)
      );
      INSERT INTO worker_pane_close_steps(operation_id, binding_id, parent_pane_id, worker_id, pane_id, state, detail, created_at, updated_at)
      SELECT operation_id, binding_id, parent_pane_id, worker_id, pane_id, state, detail, created_at, updated_at FROM worker_pane_close_steps_current;
      DROP TABLE worker_pane_close_steps_current;
      CREATE INDEX worker_pane_close_steps_unresolved ON worker_pane_close_steps(state, created_at);
      DELETE FROM schema_migrations WHERE version = 45;
      DELETE FROM schema_migrations WHERE version >= 112;
      DELETE FROM schema_metadata;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
    historical.close();

    const diagnostics: Array<{ operation: string; outcome: string }> = [];
    const bootstrap = openSqliteLeaseBootstrap(path, {
      slowTransactionThresholdMs: 0,
      onTransactionDiagnostic(diagnostic) { diagnostics.push(diagnostic); }
    });
    const lease = bootstrap.lease.acquireInstanceLease("historical-owner", now(), later())!;
    const stores = bootstrap.complete(lease);

    expect(diagnostics).toContainEqual(expect.objectContaining({ operation: "sqlite.migrations.foreign-key-rebuild", outcome: "manual_completed" }));
    expect(diagnostics).toContainEqual(expect.objectContaining({ operation: "sqlite.migrations.compatibility-metadata", outcome: "committed" }));
    expect(diagnostics.some((diagnostic) => diagnostic.operation === "sqlite.migrations.fresh-baseline")).toBe(false);
    const inspector = new DatabaseSync(path);
    expect(inspector.prepare("PRAGMA table_info(worker_pane_close_steps)").all()).toContainEqual(expect.objectContaining({ name: "instance_generation" }));
    expect(inspector.prepare("SELECT version FROM schema_migrations WHERE version = 45").get()).toEqual({ version: 45 });
    inspector.close();
    expect(bootstrap.lease.releaseInstanceLease(lease.ownerId, lease.fencingToken)).toBe(true);
    stores.lifecycle.close();
  });

  it("rejects completion and repeated close after the bootstrap is closed", () => {
    const bootstrap = openSqliteLeaseBootstrap(":memory:");
    bootstrap.close();

    expect(() => bootstrap.complete({ ownerId: "owner", fencingToken: 1 })).toThrow(/already closed/);
    expect(() => bootstrap.close()).toThrow(/already closed/);
  });

  it("rejects completion without a live matching lease", () => {
    const bootstrap = openSqliteLeaseBootstrap(":memory:");

    expect(() => bootstrap.complete({ ownerId: "missing", fencingToken: 1 })).toThrow(/live matching instance lease/);
    bootstrap.close();
  });

  it("rejects completion when the bootstrap fencing token no longer matches", () => {
    const bootstrap = openSqliteLeaseBootstrap(":memory:");
    const lease = bootstrap.lease.acquireInstanceLease("owner", now(), later())!;

    expect(() => bootstrap.complete({ ...lease, fencingToken: lease.fencingToken + 1 })).toThrow(/live matching instance lease/);
    bootstrap.close();
  });

  it("reserves the writer during a fresh migration transaction without changing connection locking mode", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-exclusive-"));
    const path = join(directory, "bridge.db");
    const context = new SqliteContext(path);
    context.database.exec("CREATE TABLE marker(id TEXT PRIMARY KEY)");
    const contender = new SqliteContext(path, { busyTimeoutMs: 1 });

    context.migrationTransaction("sqlite.migrations.fresh-baseline", () => {
      expect(contender.database.prepare("SELECT * FROM marker").all()).toEqual([]);
      expect(() => contender.database.exec("BEGIN IMMEDIATE")).toThrow(/busy|locked/i);
      context.database.exec("ALTER TABLE marker ADD COLUMN note TEXT");
    });
    expect(contender.database.prepare("PRAGMA table_info(marker)").all()).toContainEqual(expect.objectContaining({ name: "note" }));
    expect(context.database.prepare("PRAGMA locking_mode").get()).toEqual({ locking_mode: "normal" });
    contender.close();
    context.close();
  });

  it("rolls back a failed fresh migration transaction", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-migration-failure-"));
    const path = join(directory, "bridge.db");
    const context = new SqliteContext(path);
    context.database.exec("CREATE TABLE marker(id TEXT PRIMARY KEY)");
    const contender = new SqliteContext(path, { busyTimeoutMs: 1 });

    expect(() => context.migrationTransaction("sqlite.migrations.fresh-baseline", () => {
      context.database.exec("INSERT INTO marker VALUES ('uncommitted')");
      throw new Error("injected migration failure");
    })).toThrow("injected migration failure");
    expect(context.database.prepare("PRAGMA locking_mode").get()).toEqual({ locking_mode: "normal" });
    expect(contender.database.prepare("SELECT * FROM marker").all()).toEqual([]);

    contender.close();
    context.close();
  });
});

function tableNames(database: DatabaseSync): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
}

function now(): string { return new Date().toISOString(); }
function later(): string { return new Date(Date.now() + 60_000).toISOString(); }
