import type { SqliteContext } from "../context.js";

interface ForeignKeyViolation { table: string; rowid: number | null; parent: string; fkid: number }

export function runForeignKeySafeRebuild(context: SqliteContext, label: string, rebuild: () => void): void {
  const { database } = context;
  if (database.isTransaction) throw new Error(`${label} cannot start inside an active transaction`);
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.exec("BEGIN IMMEDIATE");
    rebuild();
    const violation = database.prepare("PRAGMA foreign_key_check").get() as ForeignKeyViolation | undefined;
    if (violation) throw new Error(`${label} produced a foreign-key violation: ${JSON.stringify(violation)}`);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
    const state = database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    if (Number(state.foreign_keys) !== 1) throw new Error(`${label} could not restore foreign-key enforcement`);
  }
}
