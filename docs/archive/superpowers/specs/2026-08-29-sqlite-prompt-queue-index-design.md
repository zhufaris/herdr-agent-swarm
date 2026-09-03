# SQLite Prompt Queue Index Design

## Status

Approved conversational design, ready for implementation planning.

## Problem

The bridge already uses SQLite as the durable prompt queue. Prompt acceptance,
FIFO ordering, dispatch claims, restart recovery, and Lark delivery intent are
persisted, while in-process notifications and a five-second safety scan only
wake workers to reload durable state.

The ordinary-turn hot paths currently use the index
**prompt_jobs_queue(binding_id, state, created_at)**. They also filter on
**dispatch_kind = turn**, but that column is absent from the index. SQLite can
seek to one binding and state, yet it must still inspect queued steering rows
before finding or counting ordinary turns. The durable safety scan has the same
residual filter. This becomes unnecessary work as a binding accumulates mixed
ordinary and steering history.

No prompt-queue hot path currently performs an unindexed full scan of
**prompt_jobs**. This is a targeted query-plan improvement, not a queue rewrite.

## Goals

1. Let ordinary-turn list, claim, and durable-scan queries constrain
   **binding_id**, **state**, and **dispatch_kind** through one index lookup.
2. Preserve exact FIFO behavior and every existing dispatch fence.
3. Add the index idempotently for both new and existing databases.
4. Protect the intended query plans with representative automated tests.
5. Establish evidence for deciding later whether the older queue index can be
   removed.

## Non-goals

- Changing prompt acceptance, claim transactions, or worker concurrency.
- Changing the five-second safety-scan interval.
- Adding INDEXED BY to production queries.
- Removing or replacing **prompt_jobs_queue** in this increment.
- Optimizing the binding-state OR scan or temporary B-trees used by distinct
  safety-scan results.
- Introducing Redis, a message broker, or another process.

## Selected approach

Add one non-unique composite index:

    CREATE INDEX IF NOT EXISTS prompt_jobs_queue_kind
    ON prompt_jobs(binding_id, state, dispatch_kind, created_at);

Keep the existing indexes:

    prompt_jobs_queue(binding_id, state, created_at)
    prompt_jobs_dispatch(binding_id, dispatch_kind, parent_prompt_id, state, created_at)

The new index places the three equality predicates used by ordinary-turn hot
paths before **created_at**. It does not include rowid: SQLite secondary-index
entries already use rowid as their final tie-breaker, matching the current
**ORDER BY created_at, rowid** FIFO contract.

Keeping the older index is intentional. Queries that constrain only binding and
state can continue using its smaller key, while production evidence can reveal
whether the overlap is worth the additional insert/update and storage cost. Any
later index removal is a separate design and migration.

## Affected query paths

The new index should be eligible for:

- listing queued ordinary prompt IDs;
- loading queued ordinary Run Cards;
- selecting the next dispatchable ordinary prompt; and
- discovering bindings with queued ordinary work during the durable safety
  scan.

The steering claim remains served by **prompt_jobs_dispatch**, which matches its
parent-specific predicates. Running-turn and model-control exclusion queries
remain unchanged. Run Card joins continue to use their prompt primary key.

## Migration and compatibility

The canonical schema for a new database and the idempotent query-index repair
path must both create **prompt_jobs_queue_kind** with **IF NOT EXISTS**. This
covers new installations, upgrades, and databases whose index was manually
removed.

Reopening an already migrated database must not change SQLite
**schema_version**. The migration adds no columns, rewrites no rows, and changes
no application-level schema migration version. SQLite builds the index while
the service is starting and before workers accept traffic.

## Correctness invariants

This change must preserve:

- one ordinary running turn per binding;
- FIFO order by **created_at**, then rowid for equal timestamps;
- isolation between ordinary and steering queues;
- the requirement that an Answer Card delivery checkpoint exists before an
  ordinary or steering prompt is dispatchable;
- the running-prompt exclusion fence;
- the pending model-control exclusion fence;
- durable-scan hint kinds, deduplication, and deterministic order; and
- atomic state transition from queued to running.

The index is advisory to SQLite's planner. Correctness must never depend on the
planner selecting it.

## Query-plan verification

Tests will populate a representative mixed workload rather than inspect an
empty database. The fixture will contain multiple bindings and enough queued,
running, delivered, ordinary, and steering prompts for ANALYZE to make the new
index useful.

EXPLAIN QUERY PLAN assertions will verify that the ordinary-turn access paths
mention **prompt_jobs_queue_kind** and constrain the three leading columns. The
test may reproduce the production SQL, but production SQL will not force an
index with INDEXED BY.

Behavior tests remain the primary correctness gate. Query-plan assertions are
a performance-regression gate and must not replace FIFO or fencing tests.

## Operational impact

Expected benefit is less row filtering in frequent queue reads and the
five-second durable scan, especially when one binding has mixed ordinary and
steering jobs. Expected cost is one additional index entry per prompt and index
maintenance when **state** changes.

This increment adds no new status field or runtime log. The implementation will
record before/after EXPLAIN QUERY PLAN evidence in tests and the handoff. A
future cleanup may compare database size and write latency before deciding
whether to remove **prompt_jobs_queue**.

## Testing and acceptance

The implementation is accepted when:

1. a new database contains **prompt_jobs_queue_kind** with the exact column order;
2. an existing database acquires it on reopen;
3. a no-op subsequent reopen leaves **schema_version** unchanged;
4. representative EXPLAIN QUERY PLAN checks select it for ordinary list,
   claim-candidate, and safety-scan access;
5. equal-timestamp FIFO, turn/steering isolation, Answer Card readiness,
   running-turn fencing, model-control fencing, and safety-scan behavior remain
   green;
6. focused SQLite and concurrency suites pass;
7. typecheck, build, and the complete test suite pass; and
8. the design and implementation are separate commits that do not include
   unrelated worktree changes.

## Rollback

The runtime does not require this index for correctness. If write amplification,
database growth, or migration time is unacceptable, a later migration may drop
**prompt_jobs_queue_kind**; existing queries will fall back to the current
indexes and residual filtering without changing queue semantics.
