# SQLite Store Decomposition Design

Status: Proposed; awaiting design review before implementation planning.

## Purpose

`src/store/sqlite-store.ts` currently owns the SQLite connection, schema
migration, lease fencing, and roughly 245 persistence operations across prompts,
Workers, projections, delivery, approvals, and operator workflows. This design
splits that implementation into business-capability modules without changing
runtime behavior, database schema, public store contracts, or transaction
boundaries.

The decomposition must preserve one SQLite connection and one transaction owner.
It is an implementation refactor, not a move to table-oriented repositories or
multiple independently committed stores.

## Non-negotiable invariants

- One process-owned `DatabaseSync` connection remains authoritative for all
  bridge state.
- Write-fence triggers cover the same tables and are activated on that shared
  connection.
- Operations that update several tables remain one `BEGIN IMMEDIATE`
  transaction. In particular, accepting a prompt or Worker turn together with
  its projections and outbox intents may not be split across commits.
- No prompt, Worker turn, or external effect is replayed as part of this
  refactor.
- Existing capability-focused domain ports remain the caller-facing seams. The
  internal module layout must not leak SQLite primitives into coordinators.
- The schema, migration order, idempotency keys, lane ordering, and recovery
  behavior remain unchanged until a separately reviewed behavioral change.

## Chosen approach

Use an incremental facade decomposition. `SqliteBindingStore` remains the
composition and compatibility surface while implementation is moved behind it.
Each extracted module receives the same internal SQLite context. During the
migration, facade methods delegate to capability modules; callers can later be
switched to narrower ports without a flag day.

This approach is preferred over a one-shot store bundle because it allows every
move to be verified independently. It is preferred over table-per-repository
splitting because the important consistency boundaries cross tables.

## Internal SQLite context

Introduce an internal context that owns the connection and transaction state:

```ts
export interface SqliteContext {
  readonly database: DatabaseSync;
  transaction<T>(operation: () => T): T;
  close(): void;
}
```

`transaction()` starts `BEGIN IMMEDIATE` only when the connection is not already
inside a transaction. The outermost owner commits or rolls back. A nested module
participates in the active transaction and never commits it independently. This
preserves existing calls where an aggregate operation invokes outbox or
projection persistence internally.

The context configures WAL, foreign keys, and busy timeout exactly once. It does
not contain business queries. `SqliteBindingStore.database` remains available
during the transition because existing integration and migration tests inspect
the database directly.

## Target modules

The target implementation is organized by capability rather than table:

```text
src/store/sqlite/
  context.ts
  schema.ts
  migrations.ts
  lease-store.ts
  approval-store.ts
  command-store.ts
  operations-query-store.ts
  worker-turn-store.ts
  prompt-store.ts
  projection-store.ts
  outbox-store.ts
```

`sqlite-store.ts` initially constructs these modules and forwards existing
methods. It becomes progressively smaller but retains its current exported class
until production composition and tests no longer require the broad concrete
type.

### Schema and migrations

`schema.ts` owns the latest schema bootstrap. `migrations.ts` owns the ordered,
forward-only migration runner and calls focused migration functions. Existing SQL
is moved without consolidation or renumbering. Table rebuilds, foreign-key mode
changes, indexes, triggers, and legacy data repair remain byte-for-byte or
semantically equivalent.

### Low-coupling stores

The first capability modules are lease/fencing, approvals, command/session
operations, and operational queries. They have limited projection and outbox
coupling and therefore provide the safest proof that the shared context works.

### Worker-turn aggregate

`worker-turn-store.ts` owns transactional operations spanning
`instance_turns`, `worker_turn_cards`, `worker_turn_card_pages`,
`instance_events`, card-context invalidations, and Worker-card outbox intents.
Public operations such as `acceptInstanceTurnWithCard()` and
`transitionInstanceTurnWithProjection()` stay deep: callers provide intent and
receive an outcome without coordinating individual table writes.

### Prompt aggregate

`prompt-store.ts` owns prompt FIFO, claim and recovery state, Run Card
transitions, Answer Card initialization, and their transactional outbox intents.
Prompt and Run Card persistence must not become separate caller-visible steps.

### Projection and outbox stores

`projection-store.ts` owns durable view/page persistence and card-context
projection. `outbox-store.ts` owns lanes, delivery checkpoints, retry,
quarantine, dead-letter recovery, and retention. Both expose internal
transaction-participating operations to the prompt and Worker aggregates, while
coordinators continue to depend on existing narrow domain ports.

## Dependency rules

- Capability modules may depend on `SqliteContext`, row mappers, and pure domain
  reducers.
- Aggregate modules may call transaction-participating projection and outbox
  helpers.
- Outbox and projection modules must not call coordinators or adapters.
- Modules must not instantiate `DatabaseSync`, issue independent commits inside
  an existing transaction, or expose generic SQL execution to application code.
- Cycles between capability modules are prohibited. Shared low-level operations
  move to a small internal helper, not to a new public port.

## Implementation sequence

1. Add `SqliteContext` and route construction, close, and transaction handling
   through it without moving business methods.
2. Extract schema bootstrap and migrations with their ordering unchanged.
3. Extract lease/fencing, approvals, command/session operations, and read-only
   operational queries.
4. Extract the Worker-turn aggregate, including Task Card pages, events,
   invalidations, and transactional outbox creation.
5. Extract the Prompt aggregate and Primary card projections.
6. Extract outbox delivery, quarantine, recovery, and retention.
7. Change the composition root to inject capability ports from a store bundle,
   then remove facade forwarding methods that no caller uses.

Each step is a separate reviewable commit. Mechanical movement and behavioral
changes are not mixed in the same commit.

## Testing strategy

Existing tests remain the behavioral baseline. Tests should exercise the same
capability interfaces before and after extraction. Internal helper tests are
added only for transaction nesting and migration ordering.

Every extraction runs:

```bash
npx vitest run tests/sqlite-store.test.ts
npm run typecheck
npm run build
```

Worker, prompt, projection, or outbox extractions also run their focused
integration suites. Every core-aggregate extraction ends with `npm test`.

Required focused cases include:

- nested module work commits once at the outer transaction;
- an exception rolls back every table changed by an aggregate operation;
- stale write fencing still aborts writes from every extracted module;
- migrations are ordered, idempotent, and preserve foreign-key integrity;
- Worker turn acceptance still atomically writes turn, card, page, event,
  invalidation, and outbox intent;
- prompt completion still atomically updates Prompt, Binding, Run Card, Topic
  View, and delivery intent;
- outbox lane ordering and delivery checkpoints remain unchanged.

## Risks and controls

The main risk is silently weakening a transaction by moving one write behind a
separate commit. The control is a single context, explicit transaction-owned
aggregate methods, and rollback tests that inspect all participating tables.

The second risk is migration drift. Migration extraction is mechanical and must
not combine, renumber, or simplify historical migrations. Tests must initialize
both empty and representative legacy databases.

The third risk is replacing one large class with many shallow wrappers. A module
is extracted only when it owns a coherent capability and hides its SQL,
idempotency, ordering, and transactional rules. Simple one-line forwarding
methods are temporary compatibility code and are deleted as callers move to
narrow ports.

## Completion criteria

- `sqlite-store.ts` no longer contains schema/migration SQL or the extracted
  capability implementations.
- All runtime stores share one SQLite context and one write fence.
- No application workflow depends on raw SQLite access.
- Cross-table aggregate operations retain their original transaction boundaries.
- The full Vitest suite, typecheck, and build pass from a clean checkout.
- Architecture documentation names the module layout and transaction-owner
  rule.
