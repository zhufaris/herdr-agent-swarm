import { randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { RETENTION_COMPACTION_PAGE_LIMIT, type CompactRetentionPageInput } from "../domain/ports/retention-compaction.js";
import { inspectSqliteIntegrity } from "./sqlite-integrity.js";
import { SqliteContext } from "./sqlite/context.js";
import { SqliteLeaseStore } from "./sqlite/lease-store.js";
import { SqliteRetentionAuditStore } from "./sqlite/retention-audit-store.js";
import { SqliteRetentionCompactionStore } from "./sqlite/retention-compaction-store.js";
import { readSchemaMetadata, validateCurrentSchema } from "./sqlite/schema-manifest.js";

export interface SqliteMaintenanceValidationEvidence {
  path: string;
  quickCheck: "ok" | "failed";
  foreignKeyIssues: number;
  semanticIssues: number;
  schemaValid: boolean;
}

export async function backupSqliteDatabase(source: string, destination: string): Promise<void> {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, destination);
  } finally {
    database.close();
  }
}

export async function vacuumSqliteDatabase(source: string, destination: string): Promise<void> {
  const database = new DatabaseSync(source, { readOnly: true });
  try {
    database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }
}

export function validateSqliteMaintenanceDatabase(path: string): SqliteMaintenanceValidationEvidence {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON");
    const inspection = inspectSqliteIntegrity(database, 100, { includePhysical: true });
    const foreignKeyIssues = inspection.issues
      .filter(({ rule }) => rule === "sqlite_foreign_key")
      .reduce((total, issue) => total + issue.count, 0);
    const semanticIssues = inspection.issues
      .filter(({ rule }) => rule !== "sqlite_quick_check" && rule !== "sqlite_foreign_key")
      .reduce((total, issue) => total + issue.count, 0);
    let schemaValid = true;
    try {
      validateCurrentSchema(database, readSchemaMetadata(database));
    } catch {
      schemaValid = false;
    }
    return { path, quickCheck: inspection.quickCheck, foreignKeyIssues, semanticIssues, schemaValid };
  } catch {
    return { path, quickCheck: "failed", foreignKeyIssues: 0, semanticIssues: 0, schemaValid: false };
  } finally {
    database?.close();
  }
}

export function proveSqliteLeaseReleased(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const lease = database.prepare("SELECT owner_id,fencing_token,expires_at FROM instance_lease WHERE singleton_id=1").get();
    if (lease) throw new Error("SQLite service lease has not been released");
  } finally {
    database.close();
  }
}

export async function drainSqliteRetention(
  path: string,
  deadlineAt: number,
  clock: () => number
): Promise<{ compacted: number; refusals: Record<string, number> }> {
  if (clock() >= deadlineAt) throw new Error("maintenance deadline exhausted before retention drain");
  const context = new SqliteContext(path);
  const leaseStore = new SqliteLeaseStore(context, clock);
  const ownerId = `sqlite-maintenance-${randomUUID()}`;
  const acquiredAt = new Date(clock()).toISOString();
  const lease = leaseStore.acquireInstanceLease(ownerId, acquiredAt, new Date(deadlineAt).toISOString());
  if (!lease) {
    context.close();
    throw new Error("SQLite maintenance lease could not be acquired");
  }
  let primaryError: unknown;
  try {
    leaseStore.activateWriteFence(ownerId, lease.fencingToken);
    const compaction = new SqliteRetentionCompactionStore(context, new SqliteRetentionAuditStore(context));
    const sourceKinds: readonly CompactRetentionPageInput["kind"][] = ["delivery", "core_event", "answer_timeline_item", "conversation_segment_item"];
    const completed = new Set((context.database.prepare(`SELECT source_kind AS sourceKind
      FROM retention_compaction_cursors WHERE cycle_state='complete'`).all() as Array<{ sourceKind: CompactRetentionPageInput["kind"] }>)
      .map(({ sourceKind }) => sourceKind));
    const pending = new Set(sourceKinds.filter((kind) => !completed.has(kind)));
    let compacted = 0;
    const refusals: Record<string, number> = {};
    while (pending.size > 0) {
      for (const kind of [...pending]) {
        if (clock() >= deadlineAt) throw new Error("maintenance deadline exhausted during retention drain");
        const result = compaction.compactPage({ kind, evaluatedAt: new Date(clock()).toISOString(), limit: RETENTION_COMPACTION_PAGE_LIMIT });
        compacted += result.compacted;
        for (const [reason, count] of Object.entries(result.refusals)) refusals[reason] = (refusals[reason] ?? 0) + count;
        if (result.cycleComplete) pending.delete(kind);
        await yieldImmediate();
      }
    }
    return { compacted, refusals };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      leaseStore.deactivateWriteFence();
      if (!leaseStore.releaseInstanceLease(ownerId, lease.fencingToken)) throw new Error("SQLite maintenance lease release failed");
    } catch (releaseError) {
      if (primaryError === undefined) throw releaseError;
    } finally {
      context.close();
    }
  }
}
