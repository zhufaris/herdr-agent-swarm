import { Worker, isMainThread, parentPort, workerData, type WorkerOptions } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { DatabaseDiagnosticsFailureClass, DatabaseDiagnosticsInspection, SqliteIntegrityInspection } from "../domain/types.js";

const DEFAULT_BUSY_TIMEOUT_MS = 250;
const MAX_BUSY_TIMEOUT_MS = 5_000;

type WorkerInput = {
  databasePath: string;
  busyTimeoutMs: number;
} & (
  | { kind: "integrity"; issueLimit: number }
  | { kind: "diagnostics"; issueLimit: number; includePhysical: boolean }
);

type WorkerResponse =
  | { ok: true; result: SqliteIntegrityInspection | DatabaseDiagnosticsInspection }
  | { ok: false; failureClass: Exclude<DatabaseDiagnosticsFailureClass, "timeout"> };

export class DatabaseDiagnosticsError extends Error {
  constructor(readonly failureClass: DatabaseDiagnosticsFailureClass) {
    super(`SQLite diagnostics ${failureClass}`);
    this.name = "DatabaseDiagnosticsError";
  }
}

export class WorkerDatabaseIntegrityStore {
  private readonly databasePath: string;
  private readonly busyTimeoutMs: number;

  constructor(databasePath: string, options: { busyTimeoutMs?: number } = {}) {
    this.databasePath = databasePath;
    this.busyTimeoutMs = boundedBusyTimeout(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);
  }

  inspectIntegrity(limit: number, signal?: AbortSignal): Promise<SqliteIntegrityInspection> {
    return this.run<SqliteIntegrityInspection>({
      kind: "integrity", databasePath: this.databasePath, issueLimit: boundedIssueLimit(limit), busyTimeoutMs: this.busyTimeoutMs
    }, signal);
  }

  inspectDiagnostics(input: { issueLimit: number; includePhysical: boolean }, signal?: AbortSignal): Promise<DatabaseDiagnosticsInspection> {
    return this.run<DatabaseDiagnosticsInspection>({
      kind: "diagnostics", databasePath: this.databasePath, issueLimit: boundedIssueLimit(input.issueLimit),
      includePhysical: input.includePhysical, busyTimeoutMs: this.busyTimeoutMs
    }, signal);
  }

  private run<T>(input: WorkerInput, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError(signal)); return; }
      const worker = new Worker(new URL(import.meta.url), integrityWorkerOptions(input));
      let settled = false;
      let response: WorkerResponse | null = null;
      let workerFailed = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        void worker.terminate().then(() => reject(abortError(signal!)), () => reject(new DatabaseDiagnosticsError("other")));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.once("message", (message: WorkerResponse) => {
        response = message;
      });
      worker.once("error", () => { workerFailed = true; });
      worker.once("exit", (code) => {
        const workerResponse = response;
        if (workerFailed || code !== 0 || !workerResponse) finish(() => reject(new DatabaseDiagnosticsError("other")));
        else if (workerResponse.ok) finish(() => resolve(workerResponse.result as T));
        else finish(() => reject(new DatabaseDiagnosticsError(workerResponse.failureClass)));
      });
    });
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DatabaseDiagnosticsError("other");
}

if (!isMainThread) {
  const input = workerData as WorkerInput;
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  try {
    database.exec(`PRAGMA query_only = ON; PRAGMA busy_timeout = ${input.busyTimeoutMs};`);
    const { inspectSqliteIntegrity } = await import("../store/sqlite-integrity.js") as typeof import("../store/sqlite-integrity.js");
    if (input.kind === "integrity") {
      parentPort!.postMessage({ ok: true, result: inspectSqliteIntegrity(database, input.issueLimit) } satisfies WorkerResponse);
    } else {
      const [{ SqliteOperationsStore }, integrity] = await Promise.all([
        import("../store/sqlite/operations-store.js") as Promise<typeof import("../store/sqlite/operations-store.js")>,
        Promise.resolve(inspectSqliteIntegrity(database, input.issueLimit, { includePhysical: input.includePhysical }))
      ]);
      const operations = new SqliteOperationsStore({
        database,
        transaction() { throw new Error("Read-only diagnostics cannot start a write transaction"); }
      });
      const physicalRules = new Set(["sqlite_quick_check", "sqlite_foreign_key"]);
      const semanticIssues = integrity.issues.filter((issue) => !physicalRules.has(issue.rule));
      const physicalIssues = integrity.issues.filter((issue) => issue.rule === "sqlite_foreign_key");
      const result: DatabaseDiagnosticsInspection = {
        operational: operations.getOperationalSummary(),
        semantic: { issues: semanticIssues, truncated: integrity.truncated },
        physical: input.includePhysical ? {
          quickCheck: integrity.quickCheck,
          foreignKeyIssues: physicalIssues.map((issue) => ({ table: issue.table, rowId: issue.rowId ?? null })),
          truncated: integrity.truncated
        } : undefined,
        connection: { queryOnly: true, busyTimeoutMs: input.busyTimeoutMs }
      };
      parentPort!.postMessage({ ok: true, result } satisfies WorkerResponse);
    }
  } catch (error) {
    parentPort!.postMessage({ ok: false, failureClass: classifyWorkerFailure(error) } satisfies WorkerResponse);
  } finally {
    database.close();
  }
}

function integrityWorkerOptions(workerData: WorkerInput): WorkerOptions {
  const options: WorkerOptions = { workerData };
  if (import.meta.url.endsWith(".ts")) options.execArgv = withTsxLoader(process.execArgv);
  return options;
}

function withTsxLoader(execArgv: readonly string[]): string[] {
  for (let index = 0; index < execArgv.length; index += 1) {
    if (execArgv[index] === "--import" && execArgv[index + 1] === "tsx") return [...execArgv];
    if (execArgv[index]?.startsWith("--import=tsx")) return [...execArgv];
  }
  return ["--import", "tsx", ...execArgv];
}

function boundedBusyTimeout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_BUSY_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_BUSY_TIMEOUT_MS, Math.floor(value)));
}

function boundedIssueLimit(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function classifyWorkerFailure(error: unknown): "busy" | "locked" | "other" {
  if (typeof error !== "object" || error === null) return "other";
  const shape = error as { code?: unknown; errcode?: unknown };
  if (shape.errcode === 5 || shape.code === "SQLITE_BUSY" || shape.code === "ERR_SQLITE_BUSY") return "busy";
  if (shape.errcode === 6 || shape.code === "SQLITE_LOCKED" || shape.code === "ERR_SQLITE_LOCKED") return "locked";
  return "other";
}
