import { SqliteContext, type SqliteContextOptions } from "./sqlite/context.js";
import { runWithExclusiveMigrationLock } from "./sqlite/exclusive-migration-lock.js";
import { SqliteLeaseStore } from "./sqlite/lease-store.js";
import { createInstanceLeaseSchema } from "./sqlite/schema.js";
import { createSqliteStoreBundleFromContext, type SqliteStoreBundle } from "./sqlite-store-bundle.js";
import { hasLeaseExpiryMilliseconds, leaseExpiryMs } from "./sqlite/lease-time.js";

type BootstrapState = "open" | "completed" | "closed";

export interface SqliteLeaseBootstrap {
  readonly lease: SqliteLeaseStore;
  complete(owner: { ownerId: string; fencingToken: number }): SqliteStoreBundle;
  close(): void;
}

export function openSqliteLeaseBootstrap(path: string, options: SqliteContextOptions = {}): SqliteLeaseBootstrap {
  const context = new SqliteContext(path, options);
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
      const stores = runWithExclusiveMigrationLock(context, owner, (migrationLeaseAuthorization) => {
        assertLeaseOwner(context, owner);
        const completed = createSqliteStoreBundleFromContext(context, lease, migrationLeaseAuthorization);
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
  const hasExpiryMs = hasLeaseExpiryMilliseconds(context.database);
  const held = context.database.prepare(`SELECT expires_at${hasExpiryMs ? ",expires_at_ms" : ""} FROM instance_lease
    WHERE singleton_id=1 AND owner_id=? AND fencing_token=?`).get(owner.ownerId, owner.fencingToken) as {
      expires_at: string; expires_at_ms?: number;
    } | undefined;
  if (!held || leaseExpiryMs(held) <= Date.now()) throw new Error("Cannot complete SQLite bootstrap without a live matching instance lease");
}

function assertOpen(state: BootstrapState, operation: string): asserts state is "open" {
  if (state === "completed") throw new Error(`Cannot ${operation} SQLite lease bootstrap: already completed`);
  if (state === "closed") throw new Error(`Cannot ${operation} SQLite lease bootstrap: already closed`);
}
