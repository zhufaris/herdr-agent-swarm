# SQLite Store Decomposition Implementation Plan

**Goal:** Replace the monolithic SQLite implementation with capability-focused
modules while preserving one connection, one transaction owner, all durable
state transitions, and the existing domain-port behavior.

**Spec:** `docs/superpowers/specs/2026-09-06-sqlite-store-decomposition-design.md`

## Invariants

- One `DatabaseSync` connection owns all bridge state in a process.
- Only the outermost `SqliteContext.transaction()` issues `BEGIN IMMEDIATE`,
  `COMMIT`, or `ROLLBACK`; nested capability work joins that transaction.
- Write fencing, schema, migrations, idempotency keys, ordering, and recovery
  behavior do not change during mechanical extraction.
- Worker-turn acceptance and transitions keep turn, card, page, event,
  invalidation, and outbox writes atomic.
- Prompt acceptance and settlement keep prompt, binding, Run Card, Answer Card,
  Topic View, and outbox writes atomic.
- Coordinators continue to consume domain ports and never receive raw SQLite.
- Behavioral fixes discovered during the refactor are tracked separately and
  are not folded into mechanical extraction commits.

## Batch 1: Connection and transaction context

1. Add `src/store/sqlite/context.ts` as the sole connection owner.
2. Configure the database directory, WAL, foreign keys, and busy timeout there.
3. Implement nested transaction participation with outermost commit/rollback.
4. Construct the context in `SqliteBindingStore`, retain the temporary public
   `database` getter for migration/integration tests, and delegate `close()`.
5. Migrate transaction-owning methods to the context in bounded capability
   batches; do not perform an unsafe global textual rewrite.
6. Add focused tests for one outer commit, nested participation, rollback, and
   context reuse after a failed transaction.

Verification: `npx vitest run tests/sqlite-context.test.ts tests/sqlite-store.test.ts`,
`npm run typecheck`, and `npm run build`.

## Batch 2: Schema and migrations

1. Move latest-schema bootstrap into `src/store/sqlite/schema.ts`.
2. Move the ordered compatibility steps into
   `src/store/sqlite/migrations.ts` without renumbering, combining, or
   simplifying historical migrations.
3. Keep foreign-key toggles and table rebuilds in their original order.
4. Keep row-repair helpers private to the migration module.
5. Cover empty-database initialization, representative legacy upgrades,
   repeated startup, indexes, triggers, and foreign-key integrity.

Verification: `npx vitest run tests/sqlite-store.test.ts`, `npm run typecheck`,
and `npm run build`.

## Batch 3: Low-coupling capability stores

Extract these modules over the shared context, one coherent capability at a
time:

- `lease-store.ts`: instance lease plus write-fence lifecycle;
- `approval-store.ts`: approval requests and grants;
- `command-store.ts`: card interactions, session operations, command intents,
  pane/turn control persistence, and project selections;
- `operations-query-store.ts`: integrity inspection, operational summaries,
  audit writes, and bounded retention queries.

The compatibility facade forwards existing methods while callers remain
unchanged. Each module has focused store tests plus the full SQLite store suite.

## Batch 4: Worker-turn aggregate

1. Extract Agent instance/workspace persistence needed by Worker lifecycle.
2. Extract instance-turn FIFO, claim, recovery, transcript identity, events,
   and diagnostics.
3. Move Worker Task Card views/pages and Worker Main projections with the turn
   operations that atomically mutate them.
4. Inject transaction-participating projection/outbox helpers; never expose
   table-level writes to coordinators.
5. Add rollback tests that inspect every table in Worker-turn acceptance and
   terminal transition.

Verification includes SQLite, concurrency-control, steering, Worker-card, and
turn-supervisor suites, followed by `npm test`.

## Batch 5: Prompt aggregate and projections

1. Extract binding and prompt FIFO/claim/recovery persistence.
2. Extract Prompt/Run Card/Answer Page/Topic View aggregate operations.
3. Preserve external-turn adoption, detached observation, model selection,
   reset/orphan recovery, and exact runtime identity fencing.
4. Keep acceptance, dispatch, settlement, card projection, and outbox intent
   atomic at their current boundaries.
5. Add aggregate rollback coverage for acceptance, completion, failure, reset,
   and card continuation.

Verification includes prompt, Answer Card, reconciliation, steering, and
concurrency suites, followed by `npm test`.

## Batch 6: Durable outbox

1. Extract enqueue, lane-head maintenance, delivery checkpoints, retry,
   quarantine, dead-letter recovery, renderer convergence, and retention.
2. Keep internal enqueue helpers transaction-participating so aggregate stores
   can persist intent before delivery without opening a second transaction.
3. Preserve lane keys, ordering, idempotency, failure classification metadata,
   and recovery cutoffs.
4. Add rollback and lane-order coverage across Primary, Worker, stream, and
   control-result lanes.

Verification includes publisher, stream, card, recovery, and SQLite suites,
followed by `npm test`.

## Batch 7: Capability bundle and facade retirement

1. Add a store bundle that constructs every capability with one context.
2. Update `create-bridge-runtime.ts` to inject the narrow port required by each
   workflow.
3. Remove facade forwarding methods once no production caller or test requires
   the broad concrete type.
4. Retain only an intentional test/compatibility export if migration fixtures
   still require direct database inspection; document that exception.
5. Update `docs/architecture.md` with the final module graph and transaction
   ownership rule.

## Commit and validation policy

Each batch is a thematic, independently reviewable commit. Before each commit:

```text
git diff --check
npx vitest run <affected-tests>
npm run typecheck
npm run build
```

Run `npm test` for every aggregate/shared-runtime batch and at final completion.
Do not stage generated `dist/`, runtime databases, logs, credentials, or other
unrelated worktree changes.

## Completion audit

1. Map every design invariant and implementation batch to concrete files and
   tests.
2. Confirm only one `new DatabaseSync` remains in production store code.
3. Confirm transaction control is owned by `SqliteContext`, with no capability
   module issuing independent `BEGIN`, `COMMIT`, or `ROLLBACK`.
4. Confirm `sqlite-store.ts` contains no schema/migration SQL and no extracted
   capability implementation.
5. Confirm the composition root injects capability ports from one shared bundle.
6. Run `git diff --check`, focused suites, `npm run typecheck`, `npm run build`,
   and `npm test`; inspect failures for actual objective coverage.
7. Inspect the complete commit range and worktree status, then report commit IDs
   and exact test results. Do not install, restart, or push without a separate
   request.
