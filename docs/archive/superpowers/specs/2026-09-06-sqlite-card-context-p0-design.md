# SQLite Card Context P0 Optimization Design

## Goal

Remove two unbounded query paths from Worker and Primary card-context projection
without changing visible card behavior, durable workflow semantics, or SQLite
transaction ownership:

1. Worker Main projection must not load and deserialize an entire Worker session's
   task-card history.
2. Primary-to-Worker task lookup must not scan `instance_turns` and repeatedly
   extract relationship fields from `actor_json`.

This change preserves one `SqliteContext`, one `DatabaseSync` connection, one
write fence, and the existing nested transaction owner. It does not restructure
`SqliteStoreKernel` or batch unrelated outbox transitions.

## Current Problems

`SqliteCardContextStore.loadWorkerMainProjectionSource` currently selects every
`worker_turn_cards` row for a Worker session, maps full views including large
answer/progress fields, and repeatedly filters the resulting array to derive the
active task, queue count, next queued task, recent terminal tasks, and session
creation time. Primary Main projection repeats this work once per Worker. Runtime
cost therefore grows with retained task history rather than the bounded card
content being rendered.

Primary Answer projection and delivery invalidation identify Worker tasks through
`json_extract(instance_turns.actor_json, ...)`. Query-plan inspection shows a full
`instance_turns` scan because these relationship values are not represented by
indexed relational columns.

## Chosen Design

### 1. Bounded Worker Main projection queries

Replace the full-history query with purpose-specific statements over the same
transaction and connection:

- Select the current task with explicit phase precedence: `blocked`, `running`,
  `preparing`, then the oldest queued task.
- Count queued tasks with `COUNT(*)`.
- Select the oldest queued task title with `LIMIT 1`.
- Select at most five most-recent terminal tasks ordered exactly as today.
- Select the earliest task creation timestamp with `MIN(created_at)`.

The statements select only fields needed to construct `WorkerMainProjectionSource`;
they do not deserialize historical answer text, progress JSON, or card page state.
The existing pure selector and rendered view shape remain unchanged.

Add a Worker-session query index beginning with:

```sql
(instance_id, worker_session_generation, phase, created_at, turn_id)
```

Final column order may be adjusted only when `EXPLAIN QUERY PLAN` demonstrates a
better plan for the concrete bounded statements. Latest-schema bootstrap and
compatibility migration must both converge to the same index set.

### 2. Indexed Primary source provenance

Add nullable relationship columns to `instance_turns`:

- `actor_kind`
- `source_binding_id`
- `source_binding_generation`
- `source_parent_prompt_id`

`actor_json` remains the complete canonical audit representation of `ControlActor`.
The additional columns are a relational projection used for joins and filtering.
For a `thread-primary` actor all four columns are populated atomically with the
turn insert. For a human actor, only `actor_kind` is populated and source columns
remain null.

Create a partial index for Primary task lookup:

```sql
CREATE INDEX ... ON instance_turns(
  source_parent_prompt_id,
  source_binding_id,
  source_binding_generation
) WHERE actor_kind = 'thread-primary';
```

Both Primary Worker activity projection and answer-delivery invalidation use these
columns instead of `json_extract`. Authorization continues to use the parsed actor
from `actor_json`; the new fields do not become an authorization source.

### 3. Compatibility migration

The migration adds missing columns idempotently, then backfills existing rows:

- `actor_kind` is populated from `$.kind` when it is a recognized actor kind.
- Source fields are populated only when `$.kind = 'thread-primary'`.
- Invalid or unexpected legacy JSON is left with null projected fields rather than
  aborting startup. Its original JSON remains available for diagnosis.
- The partial index is created after backfill.

The migration records a new schema version only after the column additions,
backfill, and index creation complete in the migration transaction. A new database
created from `schema.ts` must already contain the columns and index, while the
migration remains safe to run against it.

## Data Flow and Atomicity

Worker turn acceptance continues to perform turn insertion, task-card insertion,
event insertion, outbox intent, and invalidation in one outer transaction. Actor
provenance columns are parameters of the existing `instance_turns` insert, not a
follow-up update. Priority conversion uses the same encoding helper, preventing its
insert path from drifting from ordinary Worker acceptance.

Card-context rebuild remains one transaction. Its new bounded reads observe the
same SQLite snapshot and therefore cannot combine queue count or current-task data
from different commits. Delivery checkpoint invalidation remains in the existing
outbox transaction.

## Error Handling and Invariants

- Existing idempotency keys, generation fences, FIFO ordering, phase precedence,
  recent-task ordering, and card view versions are unchanged.
- A duplicate accepted turn is loaded from durable state as before.
- Migration tolerates legacy rows that cannot be projected, but all new writes must
  satisfy an internal consistency check between `ControlActor` and projected
  provenance fields.
- No query derives workflow state from Lark output.
- No prompt or Worker turn is replayed as part of migration or projection rebuild.

## Testing

Focused tests will cover:

1. Mixed Worker phases preserve current-task precedence and queued FIFO semantics.
2. More than five terminal tasks return exactly the same five tasks and ordering as
   the current implementation.
3. Large answer/progress fields in historical cards are not selected by Worker Main
   projection statements.
4. New human and `thread-primary` turns persist correct provenance in ordinary and
   priority-conversion paths.
5. A legacy database is backfilled correctly; malformed legacy actor JSON does not
   prevent startup.
6. Primary Worker activity and answer-delivery invalidation return the same target
   turns before and after migration.
7. `EXPLAIN QUERY PLAN` uses the Worker-session index and Primary provenance index;
   the targeted paths must not report a full `instance_turns` scan.
8. New-database and migrated-database index sets are equivalent.

Validation order:

1. Focused `tests/sqlite-store.test.ts` and card-context/outbox integration tests.
2. `npm run typecheck`.
3. `npm run build`.
4. Full `npm test`, because the change spans schema, persistence, projection, and
   delivery invalidation.

## Rollout and Recovery

This is an additive schema migration. Existing columns and `actor_json` are not
removed. If application rollout must be reverted, the older binary ignores the new
columns and indexes. The migration itself does not delete or rewrite task content.
No service install, restart, or remote push is part of implementation unless
separately requested.

## Out of Scope

- Removing the broad `SqliteStoreKernel` forwarding surface.
- Caching `/status` operational summaries.
- Adding wider Worker queue-position indexes while queue depth remains bounded.
- Rewriting aggregate-safe outbox recovery loops into bulk updates.
