# Primary Worker Summary Query Design

## Problem

Primary Main Card convergence calls `loadPrimaryWorkerSummaries()`. It first
loads the Binding and its Worker instances, then invokes the full Worker Main
projection loader for every Worker. That loader performs roughly ten additional
queries per Worker and reads fields needed only by the Worker Main Card, including
full answers, progress, recent history, workspace metadata, and parent state. A
single Primary card invalidation therefore has `O(worker count)` SQLite round
trips and materializes substantially more data than the summary renderer needs.

Primary Answer activity already starts with one SQL statement, but it transfers
every matching task row to JavaScript and groups them there merely to select each
Worker's latest task and count tasks. Its transfer and mapping cost grows with all
historical tasks rather than the eight summaries ultimately displayed.

## Goals

- Make Primary Main Worker-summary loading a constant number of SQLite queries.
- Make Primary Answer activity return one aggregate row per Worker session.
- Preserve exact current-task precedence, queue count, title, state, ordering,
  Worker Session generation, card target identity, and generation/pane fences.
- Keep SQLite as the only projection authority; introduce no mutable cache.
- Retain index-backed access paths and bounded result mapping.

## Non-goals

- Changing Worker Main Card content or its full projection loader.
- Changing Primary card visual layout or the eight-Worker display limit.
- Denormalizing summary state into a new durable table.
- Optimizing `/instances` or Worker detail queries in this slice.

## Considered approaches

### 1. Dedicated set-based summary queries (selected)

Add purpose-built SQL for the two Primary projections. Common table expressions
and window functions select one current/latest task per Worker session while
aggregate expressions compute queue/task counts. Join only the tables and columns
needed by the corresponding summary. This keeps query count constant and avoids
loading large Worker task bodies.

### 2. Batch-load full Worker Main projection sources

A batched version of the existing loader would remove N+1 round trips but still
materialize recent history, answers, progress, workspace metadata, and parent
state that Primary cards discard. It would also couple two presentation models.

### 3. Cache Worker summaries in memory

A cache would reduce reads only after warm-up and would require a new invalidation
protocol across runtime, task, card, and delivery transitions. It conflicts with
SQLite's durable-authority role and creates stale-card failure modes.

## Primary Main query

`loadPrimaryWorkerSummaries(bindingId, bindingGeneration)` first validates the
current Binding generation and attached pane with one narrow query. It then uses
one set-based statement over:

- active Worker `agent_instances` belonging to the exact Binding generation and
  parent pane;
- `worker_turn_cards` restricted to each Worker's current Session generation;
- `worker_main_views` restricted to the same parent identity and Session
  generation.

A window ranking selects one task using the existing precedence:

1. blocked;
2. running;
3. preparing;
4. latest terminal task by updated time;
5. earliest queued task.

Separate window aggregates compute queued count and the earliest creation time.
The output maps directly to `PrimaryWorkerSummary`; current task title uses the
same first-line, 120-character summarizer. An idle Worker with queued work remains
`queued`; all other state mapping is unchanged. Worker Main `message_id` is read
directly, without parsing its `state_json`.

The selected query returns all active Worker candidates because
`selectPrimaryWorkerSummaries()` owns ranking and overflow semantics. It must not
apply the display limit before state sorting.

## Primary Answer query

`loadPrimaryWorkerActivity(promptId, bindingGeneration)` retains the existing
Run Card and Binding identity checks. Its task query uses the indexed Primary
source fields, joins exact Worker parent/Session identity, and computes:

- `COUNT(*) OVER (PARTITION BY worker/session)` as `taskCount`;
- `ROW_NUMBER() OVER (PARTITION BY worker/session ORDER BY updated_at DESC,
  turn_id)` as the latest row.

Only rank one is returned and mapped. This preserves current sorting and the
latest Task Card target while avoiding transfer and construction of historical
cards.

## Indexes and migration

The queries use existing indexes for Primary source tasks and Worker Session
phase scans. Add a focused active-parent Worker index only if `EXPLAIN QUERY PLAN`
shows the existing partial unique parent/name index cannot satisfy the parent
lookup without avoidable scanning. If needed, create it idempotently in the latest
schema and a new migration version; do not rebuild tables.

## Failure and consistency behavior

Both reads execute on the existing shared connection and return no partial result.
Invalid Binding generation, missing parent pane, stale Worker generation, or
cross-Binding/cross-pane records are excluded exactly as before. Mapping accepts
only schema-controlled enum values and uses existing domain selectors for final
ordering and limits.

No answer, prompt text beyond the selected task title, progress event, or history
payload is loaded for Primary Main. No task rows beyond the latest aggregate row
per Worker session are returned for Primary Answer.

## Tests

- Preserve all existing summary and activity assertions.
- Add several Workers with active, queued, terminal, and mixed-generation tasks
  and prove exact state/current-title/queue/message output.
- Count prepared/executed reads or guard the implementation shape to prove the
  Main summary path remains constant as Worker count increases.
- Prove the Answer query returns one row per Worker with correct task counts and
  latest-card identity across many historical tasks.
- Use `EXPLAIN QUERY PLAN` to assert the parent and Primary-source indexes are
  used.
- Run focused SQLite and card-context tests, typecheck, build,
  `git diff --check`, then the full Vitest suite.

## Documentation impact

Update the persistence/projection section of `docs/architecture.md` to state that
Primary Worker summaries are dedicated bounded read models, not projections built
by repeatedly loading full Worker Main state.
