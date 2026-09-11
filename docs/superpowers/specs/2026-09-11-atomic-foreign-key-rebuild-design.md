# Atomic Foreign-Key Rebuild Migration Design

## Goal

Make every legacy SQLite table rebuild fail atomically. Invalid copied data or a
mid-migration exception must leave the original schema and rows intact, and
foreign-key enforcement must be restored before control returns to startup.

## Decision

Introduce one migration helper that owns the complete protocol:

1. require that no transaction is already active;
2. disable foreign-key enforcement before opening the transaction;
3. begin an immediate transaction;
4. execute the caller's synchronous rebuild callback;
5. run `PRAGMA foreign_key_check` before commit;
6. throw on the first bounded violation so the rebuild rolls back;
7. commit only after the check is clean;
8. in `finally`, roll back any active transaction, restore
   `PRAGMA foreign_keys = ON`, and verify that enforcement is enabled.

The helper reports the migration label and the first violation's table, row,
parent, and foreign-key index. It never logs or includes row payloads.

All production migrations that currently execute `PRAGMA foreign_keys = OFF`
move to this helper. Individual migration classes continue to own their schema
SQL and version decisions; the helper owns only transactional safety and pragma
restoration.

## Failure semantics

If the rebuild callback or pre-commit integrity check fails, the original table
rename/drop/copy operations are rolled back together. If foreign-key enforcement
cannot be restored, that restoration failure is surfaced because continuing with
an unprotected connection is unsafe. No schema migration version is recorded for
the failed rebuild.

## Verification

Focused helper tests cover successful commit, injected callback failure, an
orphaned reference detected before commit, original schema/data preservation, and
foreign-key enforcement after every path. Migration integration tests retain old
schema fixtures, successful reopen/idempotency, and final `foreign_key_check`. A
source assertion prevents new production rebuilds from embedding raw
`foreign_keys = OFF` outside the helper.

The final gate is focused migration and SQLite-store tests, typecheck, build,
architecture checks, full Vitest, and `git diff --check`.

## Non-goals

- Repairing pre-existing corrupt data automatically.
- Running migrations before acquiring the service instance lease; that is a
  separate high-priority lifecycle change.
- Changing current schema shapes.
- Migrating or restarting the live service.
