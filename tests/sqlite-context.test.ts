import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifySqliteFailure, SqliteContext } from "../src/store/sqlite/context.js";

let context: SqliteContext | undefined;

afterEach(() => {
  context?.close();
  context = undefined;
});

describe("SqliteContext", () => {
  it("classifies SQLite contention by numeric primary error code only", () => {
    expect(classifySqliteFailure({ code: "ERR_SQLITE_ERROR", errcode: 5 })).toBe("busy");
    expect(classifySqliteFailure({ code: "ERR_SQLITE_ERROR", errcode: 6 })).toBe("locked");
    expect(classifySqliteFailure({ code: "ERR_SQLITE_ERROR", message: "database is locked" })).toBe("other");
  });

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

  it("rolls back a nested migration savepoint without aborting its outer transaction", () => {
    context = new SqliteContext(":memory:");
    context.database.exec("CREATE TABLE values_table(value TEXT NOT NULL)");

    context.transaction("test.outer", () => {
      context!.database.prepare("INSERT INTO values_table(value) VALUES (?)").run("outer-before");
      expect(() => context!.migrationTransaction("sqlite.migrations.test-savepoint", () => {
        context!.database.prepare("INSERT INTO values_table(value) VALUES (?)").run("discarded");
        throw new Error("injected savepoint failure");
      })).toThrow("injected savepoint failure");
      context!.database.prepare("INSERT INTO values_table(value) VALUES (?)").run("outer-after");
      expect(context!.database.isTransaction).toBe(true);
    });

    expect(context.database.prepare("SELECT value FROM values_table ORDER BY rowid").all()).toEqual([
      { value: "outer-before" },
      { value: "outer-after" }
    ]);
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

  it("makes nested post-commit receipts consumable only after the outer commit", () => {
    context = new SqliteContext(":memory:");
    let receipt!: ReturnType<SqliteContext["receipt"]>;

    context.transaction(() => {
      context!.transaction(() => { receipt = context!.receipt("durable", [{ kind: "wake" }]); });
      expect(receipt.commitState).toBe("pending");
      expect(() => receipt.consumeEffects()).toThrow("before the outer transaction commits");
    });

    expect(receipt.commitState).toBe("committed");
    expect(receipt.consumeEffects()).toEqual([{ kind: "wake" }]);
    expect(receipt.consumeEffects()).toEqual([]);
  });

  it("discards nested post-commit effects when the outer transaction rolls back", () => {
    context = new SqliteContext(":memory:");
    let receipt!: ReturnType<SqliteContext["receipt"]>;

    expect(() => context!.transaction(() => {
      receipt = context!.transaction(() => context!.receipt("durable", [{ kind: "wake" }]));
      throw new Error("fail outer transaction");
    })).toThrow("fail outer transaction");

    expect(receipt.commitState).toBe("rolled_back");
    expect(receipt.consumeEffects()).toEqual([]);
  });

  it("bounds a contended write and records payload-free busy diagnostics", () => {
    const directory = mkdtempSync(join(tmpdir(), "sqlite-context-busy-"));
    const databasePath = join(directory, "bridge.db");
    const holder = new SqliteContext(databasePath, { busyTimeoutMs: 10, slowTransactionThresholdMs: 0 });
    context = new SqliteContext(databasePath, { busyTimeoutMs: 10, slowTransactionThresholdMs: 0 });
    try {
      holder.database.exec("CREATE TABLE values_table(value TEXT NOT NULL); BEGIN IMMEDIATE");

      expect(() => context!.transaction("test.busy-write", () => {
        context!.database.prepare("INSERT INTO values_table(value) VALUES (?)").run("must-not-leak");
      })).toThrow();

      expect(context.database.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 10 });
      expect(context.runtimeDiagnostics()).toMatchObject({
        transactionCount: 1,
        committedCount: 0,
        failedTransactionCount: 1,
        rolledBackCount: 0,
        rollbackExecutionCount: 0,
        failedBeginCount: 1,
        busyCount: 1,
        lockedCount: 0,
        lastFailure: {
          operation: "test.busy-write",
          outcome: "begin_failed",
          failureClass: "busy",
          failurePhase: "begin",
          rollbackExecuted: false
        }
      });
      expect(JSON.stringify(context.runtimeDiagnostics())).not.toContain("must-not-leak");
    } finally {
      if (holder.database.isTransaction) holder.database.exec("ROLLBACK");
      holder.close();
      context?.close();
      context = undefined;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("observes explicit manual migration transaction groups without claiming rollback evidence", () => {
    context = new SqliteContext(":memory:", { slowTransactionThresholdMs: 0 });

    context.observeManualTransactions("test.manual-migration", () => {
      context!.database.exec("BEGIN IMMEDIATE; COMMIT");
    });

    expect(context.runtimeDiagnostics()).toMatchObject({
      transactionCount: 0,
      rolledBackCount: 0,
      manualTransactionGroupCount: 1,
      manualTransactionGroupFailureCount: 0,
      lastManualTransactionGroup: {
        operation: "test.manual-migration",
        outcome: "manual_completed",
        rollbackExecuted: false
      }
    });
  });
});
