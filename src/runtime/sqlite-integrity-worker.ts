import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { SqliteIntegrityInspection } from "../domain/types.js";

interface WorkerInput { databasePath: string; limit: number }

export class WorkerDatabaseIntegrityStore {
  private readonly databasePath: string;

  constructor(databasePath: string) { this.databasePath = databasePath; }

  inspectIntegrity(limit: number, signal?: AbortSignal): Promise<SqliteIntegrityInspection> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError(signal)); return; }
      const worker = new Worker(new URL(import.meta.url), { workerData: { databasePath: this.databasePath, limit } satisfies WorkerInput });
      let settled = false;
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
        void worker.terminate().then(() => reject(abortError(signal!)), reject);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      worker.once("message", (message: { ok: true; inspection: SqliteIntegrityInspection } | { ok: false; error: string }) => {
        if (message.ok) finish(() => resolve(message.inspection));
        else finish(() => reject(new Error(message.error)));
      });
      worker.once("error", (error) => finish(() => reject(error)));
      worker.once("exit", (code) => { if (code !== 0) finish(() => reject(new Error(`SQLite integrity worker exited with code ${code}`))); });
    });
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("SQLite integrity inspection aborted");
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
