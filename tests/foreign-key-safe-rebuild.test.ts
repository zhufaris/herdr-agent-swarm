import { afterEach, describe, expect, it } from "vitest";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { runForeignKeySafeRebuild } from "../src/store/sqlite/migrations/foreign-key-safe-rebuild.js";

let context: SqliteContext | undefined;
afterEach(() => { context?.close(); context = undefined; });

function setup(): SqliteContext {
  context = new SqliteContext(":memory:");
  context.database.exec("CREATE TABLE parent(id TEXT PRIMARY KEY); CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id)); INSERT INTO parent VALUES ('p1'); INSERT INTO child VALUES ('c1','p1');");
  return context;
}

describe("runForeignKeySafeRebuild", () => {
  it("commits a valid rebuild and restores enforcement", () => {
    const target = setup();
    runForeignKeySafeRebuild(target, "child migration", () => target.database.exec("ALTER TABLE child RENAME TO child_old; CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id), note TEXT); INSERT INTO child SELECT id, parent_id, NULL FROM child_old; DROP TABLE child_old;"));
    expect(target.database.prepare("PRAGMA table_info(child)").all()).toContainEqual(expect.objectContaining({ name: "note" }));
    expect(target.database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("rolls back callback failure and restores the original schema and enforcement", () => {
    const target = setup();
    expect(() => runForeignKeySafeRebuild(target, "child migration", () => { target.database.exec("ALTER TABLE child RENAME TO child_old; CREATE TABLE child(id TEXT PRIMARY KEY);"); throw new Error("injected failure"); })).toThrow("injected failure");
    expect(target.database.prepare("PRAGMA table_info(child)").all()).toContainEqual(expect.objectContaining({ name: "parent_id" }));
    expect(target.database.prepare("SELECT * FROM child").all()).toEqual([{ id: "c1", parent_id: "p1" }]);
    expect(target.database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("detects an orphan before commit and rolls the rebuild back", () => {
    const target = setup();
    expect(() => runForeignKeySafeRebuild(target, "child migration", () => target.database.exec("ALTER TABLE child RENAME TO child_old; CREATE TABLE child(id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id)); INSERT INTO child VALUES ('orphan','missing'); DROP TABLE child_old;"))).toThrow(/foreign-key violation/);
    expect(target.database.prepare("SELECT * FROM child").all()).toEqual([{ id: "c1", parent_id: "p1" }]);
    expect(target.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(target.database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("rejects nested use without changing the active transaction", () => {
    const target = setup();
    target.database.exec("BEGIN IMMEDIATE");
    expect(() => runForeignKeySafeRebuild(target, "nested", () => {})).toThrow(/active transaction/);
    expect(target.database.isTransaction).toBe(true);
    target.database.exec("ROLLBACK");
    expect(target.database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });
});
