import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PostCommitReceipt } from "./post-commit-receipt.js";

export class SqliteContext {
  readonly database: DatabaseSync;
  private activeReceipts: PostCommitReceipt<unknown, unknown>[] | null = null;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  transaction<T>(operation: () => T): T {
    const ownsTransaction = !this.database.isTransaction;
    if (ownsTransaction) { this.database.exec("BEGIN IMMEDIATE"); this.activeReceipts = []; }
    try {
      const result = operation();
      if (ownsTransaction) {
        this.database.exec("COMMIT");
        for (const receipt of this.activeReceipts ?? []) receipt.markCommitted();
        this.activeReceipts = null;
      }
      return result;
    } catch (error) {
      if (ownsTransaction && this.database.isTransaction) this.database.exec("ROLLBACK");
      if (ownsTransaction) {
        for (const receipt of this.activeReceipts ?? []) receipt.markRolledBack();
        this.activeReceipts = null;
      }
      throw error;
    }
  }

  receipt<TResult, TEffect>(result: TResult, effects: readonly TEffect[]): PostCommitReceipt<TResult, TEffect> {
    if (!this.database.isTransaction || !this.activeReceipts) throw new Error("Post-commit receipts must be created inside a managed transaction");
    const receipt = new PostCommitReceipt(result, effects);
    this.activeReceipts.push(receipt as PostCommitReceipt<unknown, unknown>);
    return receipt;
  }

  close(): void {
    this.database.close();
  }
}
