import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { SqliteIntegrityInspection } from "../domain/types.js";

interface WorkerInput { databasePath: string; limit: number }

export class WorkerDatabaseIntegrityStore {
  private readonly databasePath: string;

  constructor(databasePath: string) { this.databasePath = databasePath; }

  inspectIntegrity(limit: number): Promise<SqliteIntegrityInspection> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { databasePath: this.databasePath, limit } satisfies WorkerInput });
      worker.once("message", (message: { ok: true; inspection: SqliteIntegrityInspection } | { ok: false; error: string }) => {
        if (message.ok) resolve(message.inspection);
        else reject(new Error(message.error));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => { if (code !== 0) reject(new Error(`SQLite integrity worker exited with code ${code}`)); });
    });
  }
}

if (!isMainThread) {
  const input = workerData as WorkerInput;
  const database = new DatabaseSync(input.databasePath, { readOnly: true });
  try {
    const modulePath = import.meta.url.endsWith(".ts") ? "../store/sqlite-integrity" + ".ts" : "../store/sqlite-integrity.js";
    const { inspectSqliteIntegrity } = await import(modulePath) as typeof import("../store/sqlite-integrity.js");
    parentPort!.postMessage({ ok: true, inspection: inspectSqliteIntegrity(database, input.limit) });
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    database.close();
  }
}
