import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PostCommitReceipt } from "./post-commit-receipt.js";
import { registerPromptIdentitySqlFunctions } from "./prompt-identity-corrections.js";
import { hasLeaseExpiryMilliseconds, leaseExpiryMs } from "./lease-time.js";

export type SqliteFailureClass = "busy" | "locked" | "other";

/** A callback failure whose SQLite savepoint rollback and release both succeeded. */
export class SqliteSavepointOperationError extends Error {
  constructor(readonly operationError: unknown) {
    super("SQLite savepoint operation failed");
    this.name = "SqliteSavepointOperationError";
  }
}

export interface SqliteContextOptions {
  busyTimeoutMs?: number;
  slowTransactionThresholdMs?: number;
  onTransactionDiagnostic?(diagnostic: SqliteTransactionDiagnostic): void;
}

export interface SqliteTransactionDiagnostic {
  operation: string;
  transactionCount: number;
  durationMs: number;
  outcome: "committed" | "begin_failed" | "rolled_back" | "rollback_failed" | "manual_completed" | "manual_failed";
  failureClass: SqliteFailureClass | null;
  failurePhase: "begin" | "operation_or_commit" | "manual" | null;
  rollbackExecuted: boolean;
  slow: boolean;
}

export interface SqliteRuntimeDiagnostics {
  transactionCount: number;
  committedCount: number;
  failedTransactionCount: number;
  /** Managed transactions for which this context successfully executed ROLLBACK. */
  rolledBackCount: number;
  /** Failures for which this context actually executed ROLLBACK. */
  rollbackExecutionCount: number;
  failedBeginCount: number;
  busyCount: number;
  lockedCount: number;
  slowTransactionCount: number;
  manualTransactionGroupCount: number;
  manualTransactionGroupFailureCount: number;
  lastTransaction: SqliteTransactionDiagnostic | null;
  lastManualTransactionGroup: SqliteTransactionDiagnostic | null;
  lastFailure: SqliteTransactionDiagnostic | null;
}

interface MigrationLeaseGuard {
  ownerId: string;
  fencingToken: number;
  expiresAtMs: number;
}

interface SqliteErrorShape {
  code?: unknown;
  errcode?: unknown;
}

const DEFAULT_OPERATION = "sqlite.transaction";
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_SLOW_TRANSACTION_THRESHOLD_MS = 100;

export class SqliteContext {
  readonly database: DatabaseSync;
  private activeReceipts: PostCommitReceipt<unknown, unknown>[] | null = null;
  private rollbackCompensations: Array<() => void> | null = null;
  private managedSavepointSequence = 0;
  private migrationSavepointSequence = 0;
  private migrationLeaseGuard: MigrationLeaseGuard | null = null;
  private readonly slowTransactionThresholdMs: number;
  private readonly onTransactionDiagnostic: SqliteContextOptions["onTransactionDiagnostic"];
  private diagnostics: SqliteRuntimeDiagnostics = {
    transactionCount: 0,
    committedCount: 0,
    failedTransactionCount: 0,
    rolledBackCount: 0,
    rollbackExecutionCount: 0,
    failedBeginCount: 0,
    busyCount: 0,
    lockedCount: 0,
    slowTransactionCount: 0,
    manualTransactionGroupCount: 0,
    manualTransactionGroupFailureCount: 0,
    lastTransaction: null,
    lastManualTransactionGroup: null,
    lastFailure: null
  };

  constructor(path: string, options: SqliteContextOptions = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.slowTransactionThresholdMs = options.slowTransactionThresholdMs ?? DEFAULT_SLOW_TRANSACTION_THRESHOLD_MS;
    this.onTransactionDiagnostic = options.onTransactionDiagnostic;
    assertNonNegativeInteger("busyTimeoutMs", busyTimeoutMs);
    assertNonNegativeInteger("slowTransactionThresholdMs", this.slowTransactionThresholdMs);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs};`);
    registerPromptIdentitySqlFunctions(this.database);
  }

  transaction<T>(operation: () => T): T;
  transaction<T>(label: string, operation: () => T): T;
  transaction<T>(labelOrOperation: string | (() => T), labeledOperation?: () => T): T {
    const operation = typeof labelOrOperation === "function" ? labelOrOperation : labeledOperation;
    if (!operation) throw new Error("SQLite transaction callback is required");
    const ownsTransaction = !this.database.isTransaction;
    if (!ownsTransaction) return operation();

    const label = typeof labelOrOperation === "string" ? normalizeOperationLabel(labelOrOperation) : DEFAULT_OPERATION;
    const startedAt = performance.now();
    this.diagnostics.transactionCount += 1;
    let began = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      began = true;
      this.activeReceipts = [];
      this.rollbackCompensations = [];
      this.assertMigrationLeaseGuard();
      const result = operation();
      this.database.exec("COMMIT");
      for (const receipt of this.activeReceipts ?? []) receipt.markCommitted();
      this.activeReceipts = null;
      this.rollbackCompensations = null;
      this.recordTransaction(label, startedAt, "committed", null, null, false);
      return result;
    } catch (error) {
      let rollbackExecuted = false;
      if (this.database.isTransaction) {
        try { this.database.exec("ROLLBACK"); rollbackExecuted = true; } catch {}
      }
      this.runRollbackCompensations(this.rollbackCompensations ?? []);
      for (const receipt of this.activeReceipts ?? []) receipt.markRolledBack();
      this.activeReceipts = null;
      this.rollbackCompensations = null;
      const outcome: SqliteTransactionDiagnostic["outcome"] = !began ? "begin_failed" : rollbackExecuted ? "rolled_back" : "rollback_failed";
      this.recordTransaction(label, startedAt, outcome, classifySqliteFailure(error), began ? "operation_or_commit" : "begin", rollbackExecuted);
      throw error;
    }
  }

  /**
   * Migration-only transaction boundary. Unlike transaction(), nested calls
   * retain their own rollback boundary so current-schema construction can run
   * under one outer BEGIN IMMEDIATE without issuing a nested BEGIN.
   */
  migrationTransaction<T>(label: string, operation: () => T): T {
    const normalizedLabel = normalizeOperationLabel(label);
    if (!this.database.isTransaction) return this.transaction(normalizedLabel, operation);

    const savepoint = `sqlite_migration_${++this.migrationSavepointSequence}`;
    this.database.exec(`SAVEPOINT ${savepoint}`);
    try {
      this.assertMigrationLeaseGuard();
      const result = operation();
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      } finally {
        this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    }
  }

  /**
   * Creates a rollback boundary within the current managed transaction without
   * changing transaction()'s nested-call semantics. Receipts created inside a
   * failed savepoint are rolled back and removed before the outer COMMIT.
   */
  savepoint<T>(label: string, operation: () => T): T {
    normalizeOperationLabel(label);
    const activeReceipts = this.activeReceipts;
    const rollbackCompensations = this.rollbackCompensations;
    if (!this.database.isTransaction || !activeReceipts || !rollbackCompensations) {
      throw new Error("SQLite savepoints must be created inside a managed transaction");
    }

    const savepoint = `sqlite_savepoint_${++this.managedSavepointSequence}`;
    const receiptBoundary = activeReceipts.length;
    const compensationBoundary = rollbackCompensations.length;
    this.database.exec(`SAVEPOINT ${savepoint}`);
    let result: T;
    try {
      result = operation();
    } catch (operationError) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      this.runRollbackCompensations(rollbackCompensations.splice(compensationBoundary));
      for (const receipt of activeReceipts.splice(receiptBoundary)) receipt.markRolledBack();
      throw new SqliteSavepointOperationError(operationError);
    }
    this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  }

  /** Registers in-memory work to undo if the current managed transaction rolls back. */
  onRollback(compensation: () => void): void {
    if (!this.database.isTransaction || !this.rollbackCompensations) {
      throw new Error("SQLite rollback compensations must be registered inside a managed transaction");
    }
    this.rollbackCompensations.push(compensation);
  }

  runtimeDiagnostics(): SqliteRuntimeDiagnostics {
    return {
      ...this.diagnostics,
      lastTransaction: this.diagnostics.lastTransaction ? { ...this.diagnostics.lastTransaction } : null,
      lastManualTransactionGroup: this.diagnostics.lastManualTransactionGroup ? { ...this.diagnostics.lastManualTransactionGroup } : null,
      lastFailure: this.diagnostics.lastFailure ? { ...this.diagnostics.lastFailure } : null
    };
  }

  observeManualTransactions<T>(label: string, operation: () => T): T {
    const normalizedLabel = normalizeOperationLabel(label);
    const startedAt = performance.now();
    this.diagnostics.manualTransactionGroupCount += 1;
    try {
      this.assertMigrationLeaseGuard();
      const result = operation();
      this.recordManualTransactionGroup(normalizedLabel, startedAt, "manual_completed", null);
      return result;
    } catch (error) {
      this.recordManualTransactionGroup(normalizedLabel, startedAt, "manual_failed", classifySqliteFailure(error));
      throw error;
    }
  }

  withMigrationLeaseGuard<T>(owner: { ownerId: string; fencingToken: number }, operation: () => T): T {
    if (this.migrationLeaseGuard) throw new Error("SQLite migration lease guard is already active");
    const hasExpiryMs = hasLeaseExpiryMilliseconds(this.database);
    const row = this.database.prepare(`SELECT owner_id,fencing_token,expires_at${hasExpiryMs ? ",expires_at_ms" : ""} FROM instance_lease
      WHERE singleton_id=1 AND owner_id=? AND fencing_token=?`).get(owner.ownerId, owner.fencingToken) as {
        owner_id: string; fencing_token: number; expires_at: string; expires_at_ms?: number;
      } | undefined;
    if (!row || leaseExpiryMs(row) <= Date.now()) {
      throw new Error("SQLite bootstrap lease changed or no longer has a live matching owner, fencing token, and expiry");
    }
    this.migrationLeaseGuard = { ownerId: row.owner_id, fencingToken: Number(row.fencing_token), expiresAtMs: leaseExpiryMs(row) };
    try {
      this.assertMigrationLeaseGuard();
      return operation();
    } finally {
      this.migrationLeaseGuard = null;
    }
  }

  assertMigrationLeaseGuard(): void {
    const guard = this.migrationLeaseGuard;
    if (!guard) return;
    const hasExpiryMs = hasLeaseExpiryMilliseconds(this.database);
    const held = this.database.prepare(`SELECT owner_id,fencing_token,expires_at${hasExpiryMs ? ",expires_at_ms" : ""} FROM instance_lease
      WHERE singleton_id=1 AND owner_id=? AND fencing_token=?`).get(guard.ownerId, guard.fencingToken) as {
        owner_id: string; fencing_token: number; expires_at: string; expires_at_ms?: number;
      } | undefined;
    if (!held || leaseExpiryMs(held) !== guard.expiresAtMs || guard.expiresAtMs <= Date.now()) {
      throw new Error("SQLite bootstrap lease changed or no longer has a live matching owner, fencing token, and expiry");
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

  private recordTransaction(
    operation: string,
    startedAt: number,
    outcome: SqliteTransactionDiagnostic["outcome"],
    failureClass: SqliteFailureClass | null,
    failurePhase: SqliteTransactionDiagnostic["failurePhase"],
    rollbackExecuted: boolean
  ): void {
    const durationMs = Math.max(0, performance.now() - startedAt);
    const slow = durationMs >= this.slowTransactionThresholdMs;
    const diagnostic: SqliteTransactionDiagnostic = {
      operation,
      transactionCount: this.diagnostics.transactionCount,
      durationMs,
      outcome,
      failureClass,
      failurePhase,
      rollbackExecuted,
      slow
    };
    if (outcome === "committed") this.diagnostics.committedCount += 1;
    else this.diagnostics.failedTransactionCount += 1;
    if (outcome === "rolled_back") this.diagnostics.rolledBackCount += 1;
    if (rollbackExecuted) this.diagnostics.rollbackExecutionCount += 1;
    if (failurePhase === "begin") this.diagnostics.failedBeginCount += 1;
    if (failureClass === "busy") this.diagnostics.busyCount += 1;
    if (failureClass === "locked") this.diagnostics.lockedCount += 1;
    if (slow) this.diagnostics.slowTransactionCount += 1;
    this.diagnostics.lastTransaction = diagnostic;
    if (outcome !== "committed") this.diagnostics.lastFailure = diagnostic;
    if ((slow || outcome !== "committed") && this.onTransactionDiagnostic) {
      try { this.onTransactionDiagnostic({ ...diagnostic }); } catch {}
    }
  }

  private runRollbackCompensations(compensations: readonly (() => void)[]): void {
    for (let index = compensations.length - 1; index >= 0; index -= 1) {
      try { compensations[index]!(); } catch {}
    }
  }

  private recordManualTransactionGroup(
    operation: string,
    startedAt: number,
    outcome: Extract<SqliteTransactionDiagnostic["outcome"], "manual_completed" | "manual_failed">,
    failureClass: SqliteFailureClass | null
  ): void {
    const durationMs = Math.max(0, performance.now() - startedAt);
    const slow = durationMs >= this.slowTransactionThresholdMs;
    const diagnostic: SqliteTransactionDiagnostic = {
      operation,
      transactionCount: this.diagnostics.transactionCount,
      durationMs,
      outcome,
      failureClass,
      failurePhase: outcome === "manual_failed" ? "manual" : null,
      rollbackExecuted: false,
      slow
    };
    if (outcome === "manual_failed") {
      this.diagnostics.manualTransactionGroupFailureCount += 1;
      this.diagnostics.lastFailure = diagnostic;
    }
    if (slow) this.diagnostics.slowTransactionCount += 1;
    this.diagnostics.lastManualTransactionGroup = diagnostic;
    if ((slow || outcome === "manual_failed") && this.onTransactionDiagnostic) {
      try { this.onTransactionDiagnostic({ ...diagnostic }); } catch {}
    }
  }
}

export function classifySqliteFailure(error: unknown): SqliteFailureClass {
  if (!error || typeof error !== "object") return "other";
  const sqliteError = error as SqliteErrorShape;
  if (sqliteError.code !== "ERR_SQLITE_ERROR" || typeof sqliteError.errcode !== "number") return "other";
  const primaryCode = sqliteError.errcode & 0xff;
  if (primaryCode === 5) return "busy";
  if (primaryCode === 6) return "locked";
  return "other";
}

export function isRetryableSqliteFailure(error: unknown): boolean {
  const failureClass = classifySqliteFailure(error);
  return failureClass === "busy" || failureClass === "locked";
}

function normalizeOperationLabel(label: string): string {
  if (!/^[a-z][a-z0-9.-]{0,79}$/.test(label)) {
    throw new Error("SQLite transaction operation labels must be fixed lowercase identifiers");
  }
  return label;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`SQLite ${name} must be a non-negative integer`);
}
