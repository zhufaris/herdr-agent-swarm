# Lease-Before-Migration Startup Design

## Problem

The production SQLite capability graph currently runs every schema migration in
its constructor. `ManagedBridgeRuntime.start()` acquires the durable instance
lease later. A second process can therefore mutate the live database before it
discovers that another bridge instance owns it. SQLite serializes individual
writes, but that does not authorize the contender to change the schema or keep a
multi-step compatibility migration isolated from the active owner.

Startup must establish durable ownership before any business-schema inspection
or migration. A brand-new database still needs one minimal schema object in
order to acquire that ownership.

## Goals

- Permit only the process holding `instance_lease` to run business migrations.
- Keep SQLite as the single durable ownership authority.
- Use the same SQLite connection for lease bootstrap, migration, capability
  construction, write fencing, and runtime work.
- Release ownership and close the connection in the right order after any
  startup failure.
- Preserve direct capability-graph construction as a test-fixture convenience,
  while preventing production composition from bypassing the leased path.

## Non-goals

- Replacing the SQLite lease with a filesystem or systemd lock.
- Making all historical migrations one global transaction.
- Changing lease TTL, fencing-token, heartbeat, or takeover semantics.
- Installing, restarting, or otherwise changing the live service.

## Considered approaches

### 1. Staged SQLite lease bootstrap (selected)

Open `SqliteContext`, create only the idempotent `instance_lease` table, expose
the lease capability, and pause. Production composition acquires the lease and
then asks the bootstrap to run migrations and construct the store bundle over
that same context. This introduces one explicit lifecycle seam and retains one
ownership protocol.

### 2. One transaction around all migrations

Acquiring ownership and running all migrations in one SQLite transaction would
give strong serialization, but current migrations intentionally contain their
own transactions and foreign-key-disabled rebuild boundaries. Converting every
migration into one nestable protocol is substantially broader than the startup
ordering defect and would make a long-lived write transaction part of normal
startup.

### 3. An operating-system file lock

An advisory `flock` would be released automatically on process death, but it
would introduce a second ownership mechanism, an external command/runtime
dependency, and lock-order questions between the file lock and SQLite lease. It
would also weaken the existing rule that SQLite is authoritative for instance
ownership.

## Architecture

### Minimal schema boundary

Extract `createInstanceLeaseSchema(context)` from `createLatestSchema`. It may
execute only the idempotent `CREATE TABLE IF NOT EXISTS instance_lease`
statement. `createLatestSchema` calls the same helper, so the canonical latest
schema remains unchanged and there is no duplicate table definition.

Add `openSqliteLeaseBootstrap(path)`. The returned object owns one
`SqliteContext` and exposes three operations:

- `lease`: the `LeaseStore` backed by that context;
- `complete()`: run `SqliteMigrations`, construct the capability graph over the
  existing context, and return `SqliteStoreBundle`;
- `close()`: close the context if completion did not transfer ownership to the
  returned bundle.

`complete()` is one-shot. Calling it twice or completing after close is rejected.
The bootstrap must not construct business stores or inspect business tables
before completion.

`SqliteCapabilityGraph` accepts either its existing path-based construction for
tests or an already-open `SqliteContext` for the production bootstrap. In both
cases it runs migrations before constructing capability modules. Production
code reaches it only through `openSqliteLeaseBootstrap(...).complete()`.

### Production startup sequence

`createManagedBridgeRuntime` performs the following ordered sequence after
read-only agent availability detection:

1. Open the lease bootstrap.
2. Construct `InstanceLeaseController` over `bootstrap.lease`.
3. Acquire the instance lease.
4. Complete migrations and build `SqliteStoreBundle` over the same context.
5. Construct application workflows and `ManagedBridgeRuntime`.
6. Mark the managed runtime dependency as already owning the lease.

`ManagedBridgeRuntime.start()` skips acquisition only for that explicit
production handoff, activates the write fence from the held token, and starts
the heartbeat before long recovery and integrity work. Direct unit fixtures keep
the existing acquire-on-start default.

There is no `await` or unrelated external work between acquisition and migration
completion. Existing migration operations are synchronous and bounded by the
same SQLite connection and busy-timeout assumptions already used by runtime
writes. After migration, the heartbeat starts at the existing lifecycle point.
This change closes the concrete defect in which a known live owner is ignored;
it does not introduce a second special migration TTL.

## Failure handling

- If lease bootstrap creation fails, close any opened context and propagate the
  startup error.
- If lease acquisition is contended, close the bootstrap without running
  `complete()` and do not call lease release because ownership was never held.
- If migration, capability construction, or application composition fails after
  acquisition, release the held lease before closing the shared context.
- If `ManagedBridgeRuntime.start()` fails after the handoff, its existing
  shutdown path deactivates the write fence, releases the lease, and closes the
  store.
- A contender may execute the minimal idempotent lease-table statement. It may
  not inspect, create, alter, rebuild, or drop any business table.

## Tests

Add focused tests using a real temporary SQLite database and two connections:

1. Opening a bootstrap creates only `instance_lease`; the selected legacy
   business schema remains unmigrated until `complete()`.
2. After the first bootstrap acquires the lease, a second bootstrap cannot
   acquire it and closing the contender leaves the legacy business schema
   unchanged.
3. The owner can complete migration on the same connection, activate its write
   fence, and use the resulting bundle.
4. Bootstrap completion and close are one-shot and reject invalid lifecycle
   calls.
5. Managed runtime tests prove a pre-acquired production lease is not acquired
   again, while ordinary fixtures retain acquire-on-start behavior.
6. Architecture tests enforce `acquire()` before `complete()` in production and
   prevent the production composition root from calling the eager unleased
   bundle factory.

Run the focused bootstrap, lease, migration, managed-runtime, and architecture
tests first. Then run typecheck, build, `git diff --check`, and the full Vitest
suite.

## Documentation impact

Update `docs/architecture.md` so the persistence section describes the two-stage
production construction: minimal lease bootstrap, ownership acquisition, then
business migrations and capability construction. The test-only eager graph path
must not be described as the production lifecycle.
