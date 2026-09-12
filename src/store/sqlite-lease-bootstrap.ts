import { SqliteContext } from "./sqlite/context.js";
import { runWithExclusiveMigrationLock } from "./sqlite/exclusive-migration-lock.js";
import { SqliteLeaseStore } from "./sqlite/lease-store.js";
import { createInstanceLeaseSchema } from "./sqlite/schema.js";
import { createSqliteStoreBundleFromContext, type SqliteStoreBundle } from "./sqlite-store-bundle.js";

type BootstrapState = "open" | "completed" | "closed";

export interface SqliteLeaseBootstrap {
  readonly lease: SqliteLeaseStore;
  complete(owner: { ownerId: string; fencingToken: number }): SqliteStoreBundle;
  close(): void;
}

export function openSqliteLeaseBootstrap(path: string): SqliteLeaseBootstrap {
  const context = new SqliteContext(path);
  try {
    createInstanceLeaseSchema(context);
  } catch (error) {
    context.close();
    throw error;
  }
  const lease = new SqliteLeaseStore(context);
  let state: BootstrapState = "open";
  return {
    lease,
    complete(owner) {
      assertOpen(state, "complete");
      assertLeaseOwner(context, owner);
      const stores = runWithExclusiveMigrationLock(context, () => {
        assertLeaseOwner(context, owner);
        const completed = createSqliteStoreBundleFromContext(context, lease);
        assertLeaseOwner(context, owner);
        return completed;
      });
      state = "completed";
      return stores;
    },
    close() {
      assertOpen(state, "close");
      context.close();
      state = "closed";
    }
  };
}

function assertLeaseOwner(context: SqliteContext, owner: { ownerId: string; fencingToken: number }): void {
  const held = context.database.prepare(`
    SELECT 1 FROM instance_lease
    WHERE singleton_id = 1 AND owner_id = ? AND fencing_token = ?
      AND julianday(expires_at) > julianday('now')
  `).get(owner.ownerId, owner.fencingToken);
  if (!held) throw new Error("Cannot complete SQLite bootstrap without a live matching instance lease");
}

function assertOpen(state: BootstrapState, operation: string): asserts state is "open" {
  if (state === "completed") throw new Error(`Cannot ${operation} SQLite lease bootstrap: already completed`);
  if (state === "closed") throw new Error(`Cannot ${operation} SQLite lease bootstrap: already closed`);
}
