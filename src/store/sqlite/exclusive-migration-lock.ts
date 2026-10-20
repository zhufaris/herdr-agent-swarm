import type { SqliteContext } from "./context.js";

const exclusiveMigrationLease = Symbol("exclusive-migration-lease");

export interface ExclusiveMigrationLeaseAuthorization {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly [exclusiveMigrationLease]: true;
}

export function runWithExclusiveMigrationLock<T>(
  context: SqliteContext,
  owner: { ownerId: string; fencingToken: number },
  operation: (authorization: ExclusiveMigrationLeaseAuthorization) => T
): T {
  // Bootstrap must not own a transaction: route selection happens inside the
  // store bundle, and historical compatibility deliberately retains its
  // independent durable steps (including foreign-key-safe rebuilds). The
  // fresh route opens its own short transaction after selection.
  return context.withMigrationLeaseGuard(owner, () => context.observeManualTransactions("sqlite.migrations.bootstrap", () => operation(Object.freeze({
    ownerId: owner.ownerId,
    fencingToken: owner.fencingToken,
    [exclusiveMigrationLease]: true as const
  }))));
}
