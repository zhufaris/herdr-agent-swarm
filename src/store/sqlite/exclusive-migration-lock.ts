import type { SqliteContext } from "./context.js";

export function runWithExclusiveMigrationLock<T>(context: SqliteContext, operation: () => T): T {
  const database = context.database;
  database.exec("PRAGMA locking_mode = EXCLUSIVE");
  try {
    database.exec("BEGIN IMMEDIATE; COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.exec("PRAGMA locking_mode = NORMAL");
    throw error;
  }
  try {
    return operation();
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.exec("PRAGMA locking_mode = NORMAL; BEGIN; SELECT name FROM sqlite_schema LIMIT 1; COMMIT");
    const mode = database.prepare("PRAGMA locking_mode").get() as { locking_mode: string };
    if (mode.locking_mode.toLowerCase() !== "normal") throw new Error("Failed to restore normal SQLite locking mode after migrations");
  }
}
