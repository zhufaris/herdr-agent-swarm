import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class SqliteContext {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  transaction<T>(operation: () => T): T {
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      if (ownsTransaction) this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
