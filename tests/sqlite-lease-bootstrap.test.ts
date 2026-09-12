import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteLeaseBootstrap } from "../src/store/sqlite-lease-bootstrap.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { runWithExclusiveMigrationLock } from "../src/store/sqlite/exclusive-migration-lock.js";

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

  it("holds exclusive database access during a migration operation and releases it afterward", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-exclusive-"));
    const path = join(directory, "bridge.db");
    const context = new SqliteContext(path);
    context.database.exec("CREATE TABLE marker(id TEXT PRIMARY KEY)");
    const contender = new DatabaseSync(path);
    contender.exec("PRAGMA busy_timeout = 1");

    runWithExclusiveMigrationLock(context, () => {
      expect(() => contender.prepare("SELECT * FROM marker").all()).toThrow(/locked/);
      context.database.exec("ALTER TABLE marker ADD COLUMN note TEXT");
    });
    expect(contender.prepare("PRAGMA table_info(marker)").all()).toContainEqual(expect.objectContaining({ name: "note" }));
    contender.close();
    context.close();
  });

  it("releases exclusive access when migration fails", () => {
    directory = mkdtempSync(join(tmpdir(), "herdr-lease-migration-failure-"));
    const path = join(directory, "bridge.db");
    const context = new SqliteContext(path);
    context.database.exec("CREATE TABLE marker(id TEXT PRIMARY KEY)");
    const contender = new DatabaseSync(path);
    contender.exec("PRAGMA busy_timeout = 1");

    expect(() => runWithExclusiveMigrationLock(context, () => {
      context.database.exec("BEGIN IMMEDIATE; INSERT INTO marker VALUES ('uncommitted')");
      throw new Error("injected migration failure");
    })).toThrow("injected migration failure");
    expect(context.database.prepare("PRAGMA locking_mode").get()).toEqual({ locking_mode: "normal" });
    expect(contender.prepare("SELECT * FROM marker").all()).toEqual([]);

    contender.close();
    context.close();
  });
});

function tableNames(database: DatabaseSync): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
}

function now(): string { return new Date().toISOString(); }
function later(): string { return new Date(Date.now() + 60_000).toISOString(); }
