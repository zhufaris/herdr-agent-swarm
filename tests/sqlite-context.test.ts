import { afterEach, describe, expect, it } from "vitest";
import { SqliteContext } from "../src/store/sqlite/context.js";

let context: SqliteContext | undefined;

afterEach(() => {
  context?.close();
  context = undefined;
});

describe("SqliteContext", () => {
  it("uses one configured connection", () => {
    context = new SqliteContext(":memory:");

    expect(context.database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(context.database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });

  it("commits nested work with its outer transaction", () => {
    context = new SqliteContext(":memory:");
    context.database.exec("CREATE TABLE values_table(value TEXT NOT NULL)");

    context.transaction(() => {
      context!.database.prepare("INSERT INTO values_table(value) VALUES (?)").run("outer");
      context!.transaction(() => {
        context!.database.prepare("INSERT INTO values_table(value) VALUES (?)").run("nested");
      });
      expect(context!.database.isTransaction).toBe(true);
    });

    expect(context.database.isTransaction).toBe(false);
    expect(context.database.prepare("SELECT value FROM values_table ORDER BY rowid").all()).toEqual([
      { value: "outer" },
      { value: "nested" }
    ]);
  });

  it("rolls nested work back when the outer operation fails", () => {
    context = new SqliteContext(":memory:");
    context.database.exec("CREATE TABLE values_table(value TEXT NOT NULL)");

    expect(() => context!.transaction(() => {
      context!.database.prepare("INSERT INTO values_table(value) VALUES (?)").run("outer");
      context!.transaction(() => {
        context!.database.prepare("INSERT INTO values_table(value) VALUES (?)").run("nested");
      });
      throw new Error("fail outer transaction");
    })).toThrow("fail outer transaction");

    expect(context.database.prepare("SELECT value FROM values_table").all()).toEqual([]);
  });

  it("can start a new transaction after rollback", () => {
    context = new SqliteContext(":memory:");
    context.database.exec("CREATE TABLE values_table(value TEXT NOT NULL)");

    expect(() => context!.transaction(() => {
      throw new Error("first transaction failed");
    })).toThrow("first transaction failed");

    context.transaction(() => {
      context!.database.prepare("INSERT INTO values_table(value) VALUES (?)").run("recovered");
    });
    expect(context.database.prepare("SELECT value FROM values_table").all()).toEqual([{ value: "recovered" }]);
  });
});
