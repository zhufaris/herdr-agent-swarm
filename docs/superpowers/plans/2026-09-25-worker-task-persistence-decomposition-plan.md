# Worker Task Persistence Decomposition Implementation Plan

## Objective

Implement the approved Worker Task persistence decomposition while preserving
all observable behavior and the existing SQLite schema.

Design authority:
`docs/superpowers/specs/2026-09-25-worker-task-persistence-decomposition-design.md`.

## Non-negotiable invariants

- `SqliteWorkerTurnStore` remains the only published Worker-turn persistence
  facade.
- Acceptance, transition, and recovery each retain one outer
  `SqliteContext.transaction()` boundary.
- FIFO order remains priority first, then `created_at`, then SQLite `rowid`.
- `dispatch-uncertain` work is observable and is never automatically replayed.
- Worker generation, Worker-session generation, parent Binding generation/pane,
  and exact runtime-turn fences remain unchanged.
- A blocked episode and its Human Review delivery intent commit atomically.
- Card payloads, event kinds, idempotency keys, schema, and migrations do not
  change.

## Task 1: Characterize the dispatcher seam

**Files**

- Modify `tests/worker-turn-dispatcher.test.ts`.

Add direct cases for confirmed non-delivery, structured and unstructured
confirmed delivery, stale generation after claim, and shutdown deadline expiry.
Assert transition order, watch lifecycle, FIFO stopping/continuation, abort, and
no replay. Retain the existing exact-turn submission-failure case.

Verify with:

```bash
npx vitest run tests/worker-turn-dispatcher.test.ts
```

## Task 2: Extract records and pure policies

**Files**

- Create `src/store/sqlite/worker-turn/records.ts`.
- Create or extend domain policy modules for Worker admission, exact runtime-turn
  matching, Human Review routing, and deterministic queue positions.
- Create `tests/worker-turn-policies.test.ts`.
- Modify `src/store/sqlite/worker-turn-store.ts`.

Move row decoding without changing defaults or serialized shapes. Pure policies
must accept already-loaded facts and return typed decisions; they must not read
SQLite, render cards, publish events, or enqueue delivery. Preserve existing
error text and null/no-op outcomes.

Verify with:

```bash
npx vitest run tests/worker-turn-policies.test.ts tests/worker-turn-card-view.test.ts
npm run typecheck
```

## Task 3: Extract Worker Task projection persistence

**Files**

- Create `src/store/sqlite/worker-turn/projection.ts`.
- Modify `src/store/sqlite/worker-turn-store.ts`.
- Extend focused cases in `tests/sqlite-store.test.ts` only where coverage is
  missing.

Move card, page, timeline, checkpoint, and reservation implementation behind a
`WorkerTurnProjection` internal module. It receives the shared `SqliteContext`,
outbox enqueue callback, and context-invalidation callback. The facade retains
all public method signatures and delegates to it.

Preserve canonical offsets, frozen pages, sequence increments, delivery
versions, hydration idempotency, and rollback after failed enqueue.

Verify with:

```bash
npx vitest run tests/sqlite-store.test.ts tests/worker-turn-card-workflow.test.ts tests/answer-timeline-page.test.ts
npm run typecheck
```

## Task 4: Extract durable Worker FIFO

**Files**

- Create `src/store/sqlite/worker-turn/queue.ts`.
- Modify `src/store/sqlite/worker-turn-store.ts`.

Move pending counts, active-turn lookup, FIFO claim, and terminal queue-position
repair. The module receives narrow projection/event callbacks and has no
scheduler dependency. Claim plus `turn.claimed`, and terminal transition plus
all queue projection updates, remain inside the caller's transaction.

Verify with:

```bash
npx vitest run tests/sqlite-store.test.ts tests/instance-messaging.integration.test.ts
npm run typecheck
```

## Task 5: Extract Worker Task acceptance

**Files**

- Create `src/store/sqlite/worker-turn/acceptance.ts`.
- Modify `src/store/sqlite/worker-turn-store.ts`.
- Extend acceptance rollback cases in `tests/sqlite-store.test.ts` if needed.

Keep both public acceptance methods on the facade. Within their outer
transaction, preserve this order: load Worker and duplicate, validate, calculate
position, insert Task, reload, save projection, append accepted event, reserve
the active-session create intent, invalidate contexts, reload and return.
Duplicate acceptance must create no additional durable effect.

Verify with:

```bash
npx vitest run tests/sqlite-store.test.ts tests/instance-messaging.integration.test.ts tests/primary-tool-broker.test.ts
npm run typecheck
```

## Task 6: Extract transition and Human Review together

**Files**

- Create `src/store/sqlite/worker-turn/transition.ts`.
- Create `src/store/sqlite/worker-turn/human-review.ts`.
- Modify `src/store/sqlite/worker-turn-store.ts`.
- Extend Human Review route and rollback coverage in `tests/sqlite-store.test.ts`.

Preserve transition order: load Task/projection, fence identity, update state,
insert episode event, reduce/save/invalidate projection, repair terminal queue
positions, reserve Human Review for a new blocked episode, and reload the result.

Keep the Human Review idempotency key exactly:

```text
worker-review:<workerId>:<workerSessionGeneration>:<turnId>:<blockedEventId>
```

Test every route-fence dimension. Stale routing commits blocked state but skips
notification; render or outbox failure rolls back state, event, projection,
queue repairs, invalidations, and intent.

Verify with:

```bash
npx vitest run tests/sqlite-store.test.ts tests/instance-turn-supervisor.test.ts tests/worker-turn-observer.test.ts
npm run typecheck
```

## Task 7: Extract restart recovery

**Files**

- Create `src/store/sqlite/worker-turn/recovery.ts`.
- Modify `src/store/sqlite/worker-turn-store.ts`.
- Extend recovery rollback coverage in `tests/sqlite-store.test.ts` if needed.

Move legacy cancellation, claimed-only requeue, observable-turn queries, and
diagnostics. Recovery remains one transaction. It must not requeue dispatching,
running, blocked, or dispatch-uncertain work.

Verify with:

```bash
npx vitest run tests/sqlite-store.test.ts tests/instance-turn-supervisor.test.ts
npm run typecheck
```

## Task 8: Enforce the module shape

**Files**

- Modify `tests/architecture-boundaries.test.ts`.
- Modify `docs/architecture.md` only to document the resulting implementation
  shape.

Assert that the capability graph publishes only `SqliteWorkerTurnStore`, the
facade alone constructs internal participants with its shared context, internal
files do not import outer layers, and composition cannot access them. Do not
change `InstanceStore`, the capability graph's public shape, schema, or
migrations in this slice.

Verify with:

```bash
npx vitest run tests/architecture-boundaries.test.ts tests/sqlite-capability-graph.test.ts
npm run architecture:check
npm run typecheck
```

## Task 9: Completion audit

Inspect the diff to prove there is no schema, migration, public port, CardKit
payload, event-kind, idempotency-key, or queue-order change. Map every design
requirement to a source or test artifact, then run:

```bash
npm test
npm run typecheck
npm run build
npm run architecture:check
npm run docs:audit
npm run public:audit
git diff --check
```

Commit only after every gate passes. Installation, restart, and push are outside
this refactor unless separately requested.
