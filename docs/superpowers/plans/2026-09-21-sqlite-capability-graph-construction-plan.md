# SQLite Capability Graph Construction Implementation Plan

## Objective

Refactor SQLite capability construction and migration orchestration into explicit
fixed phases without changing the production bundle, SQL, schema, migration
order, connection ownership, or transaction semantics.

## Work packages

### 1. Characterize the production seam

- Add focused tests through `createSqliteStoreBundle()` for intentional
  capability aliases and the shared lifecycle/write fence.
- Preserve the existing lease-before-migration and historical upgrade fixtures
  as the authoritative migration-effect tests.
- Record the current migration call sequence from source before moving calls so
  the implementation diff can be checked mechanically.

### 2. Extract capability publication

- Give the internal capability collection a stable private type.
- Move adapter construction and intentional aliases into one private publisher.
- Keep `SqliteStoreBundle` and both production factory signatures unchanged.
- Verify capability identity and architecture-boundary tests before proceeding.

### 3. Extract store-cluster construction

- Separate context/migration setup, low-coupling foundation stores, and the
  transaction-participating store cluster into named internal construction
  functions.
- Keep all concrete stores on the same `SqliteContext`.
- Preserve existing late-bound callbacks and their construction order exactly.
- Retain concrete graph accessors required by the test-only compatibility kernel.

### 4. Extract fixed migration phases

- Replace the long `run()` body with named private phase calls.
- Move existing statements mechanically, preserving their exact absolute order.
- Keep versions 2–4 in their current independent `BEGIN IMMEDIATE` transactions.
- Preserve the repeated Gateway-column and outbox-claim passes after legacy
  rebuilds, along with current view and index placement.
- Compare the before/after migration call sequence and SQL-bearing file diff.

### 5. Synchronize architecture documentation

- Document the three construction phases and fixed migration phases in
  `docs/architecture.md`.
- Keep the test-only broad facade explicitly outside the production surface.
- Move the completed SQLite design and plan to the archive only after the
  implementation and verification are complete.

### 6. Verify and commit

- Run focused capability, architecture, lease-bootstrap, and SQLite migration
  tests after each slice.
- Run `npm run docs:audit`, `npm run architecture:check`, `npm run typecheck`,
  `npm run build`, `npm run public:audit`, and the full test suite.
- Audit the final diff for changes under SQL strings, schema definitions,
  migration version statements, domain ports, and `SqliteStoreBundle`.
- Commit the structural refactor separately from the approved design and prior
  Controller fixes.
