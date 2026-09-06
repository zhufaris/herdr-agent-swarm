# Worker Outbox Bounded Query Design

## Goal

Bound Worker task-card outbox lookups so convergence cost does not grow with the
complete global pending queue or the retained stream history of a Worker turn.
The change must preserve durable outbox intent, lane ordering, delivery
idempotency, page sequencing, and the existing SQLite transaction owner.

## Current Problems

Worker card convergence currently has two unbounded paths:

1. Before a task card has a Lark message/card identity, convergence calls
   `listPendingOutboundReplies()` and scans fully materialized global replies to
   answer whether one pending intent exists for the current Worker turn.
2. Delivery-fact and progress reservations load all retained outbox rows for a
   Worker turn, parse every JSON payload, and filter page and element metadata in
   TypeScript. Repeated streaming updates therefore make cumulative work grow
   toward quadratic behavior.

The outbox already stores `worker_turn_id` and `selection_id`, but page and
element identity remain embedded in JSON payloads and the relevant Worker queries
have no dedicated indexes.

## Chosen Design

### Typed stream metadata

Add nullable columns to `outbound_replies`:

- `stream_page_index INTEGER`
- `stream_element_id TEXT`

`payload` remains the canonical delivery body. `SqliteOutboxStore` derives the
typed projection once when enqueueing stream content, stream finish, or stream
card creation. Progress intents continue to use
`selection_id = 'worker-progress'`; normal Worker answer content has a null
selection ID. Non-stream replies leave both new columns null.

The enqueue UPSERT updates the typed columns whenever a still-pending payload is
replaced, in the same transaction as the canonical payload update. No caller may
write the projection independently.

### Worker-specific indexes and queries

Add two partial indexes after the columns exist:

```sql
CREATE INDEX outbound_replies_worker_pending
ON outbound_replies(worker_turn_id, state)
WHERE worker_turn_id IS NOT NULL;

CREATE INDEX outbound_replies_worker_stream
ON outbound_replies(
  worker_turn_id, kind, stream_page_index, selection_id, delivery_order DESC
)
WHERE worker_turn_id IS NOT NULL
  AND state IN ('pending','delivered','dead_letter');
```

Exact index shape may change only if `EXPLAIN QUERY PLAN` demonstrates that a
different ordering serves the concrete queries better.

Expose a narrow `hasPendingOutboundReplyForWorkerTurn(turnId)` capability and use
`SELECT 1 ... LIMIT 1`; Worker card convergence no longer loads global pending
payloads.

Replace full-history delivery-fact scans with bounded statements:

- latest non-progress content for the requested page: ordered by delivery order,
  `LIMIT 1`;
- pending finish for the requested page: `EXISTS`;
- pending continuation for the next page: `EXISTS`;
- latest progress for the requested page: filter
  `selection_id = 'worker-progress'`, order by delivery order, `LIMIT 1`.

Only the latest content/progress statement reads a payload. Existence checks do
not deserialize JSON.

## Compatibility Migration

Migration version 28 adds missing columns idempotently, then backfills typed
metadata from valid JSON only. Malformed or unknown legacy payloads remain null
and cannot block startup. The indexes are created only after column addition and
backfill, avoiding the old-database bootstrap ordering problem.

New databases declare the columns in the latest table schema, while migration 28
creates the indexes for both new and upgraded databases. Rebuilt legacy outbox
schemas must continue carrying the new columns once migration 28 has completed;
future table-rebuild migrations must preserve them explicitly.

Rows without recoverable metadata are not guessed. They remain deliverable through
the existing outbox dispatcher, but page-specific historical lookup ignores them.
This is safe because current pending stream intents are generated with valid
payloads, and canonical payload retention is unchanged.

## Atomicity and Failure Semantics

- Worker turn/card/event/outbox/invalidation transitions remain under the same
  outer `SqliteContext.transaction()`.
- No delivery is retried, dismissed, or reordered by the migration.
- Lane keys, delivery order, idempotency keys, page sequences, and state
  transitions are unchanged.
- A duplicate enqueue preserves delivered/dead-letter payload and metadata exactly
  as today; only a pending row may accept replacement projection values.
- The optimization does not infer workflow state from Lark output.

## Testing

Focused tests will prove:

1. Enqueued Worker stream create/content/progress/finish rows store correct page
   and element metadata.
2. Pending existence checks are scoped to one Worker turn and use the Worker
   pending index.
3. Delivery facts preserve latest-content, finish-pending, and
   continuation-pending behavior with unrelated and older history present.
4. Progress reservation selects only the latest progress row for the requested
   page and does not confuse normal content.
5. A legacy database backfills valid payloads, tolerates malformed JSON, and
   creates indexes only after adding columns.
6. `EXPLAIN QUERY PLAN` uses the Worker stream/pending indexes and targeted reads
   include `LIMIT 1` or `EXISTS`.

Validation order is focused SQLite and Worker card workflow tests, TypeScript
typecheck, build, then the full Vitest suite because persistence and delivery
projection are shared runtime boundaries.

## Alternatives Considered

### JSON predicates with only a Worker-turn index

This is smaller but still parses payload JSON inside SQLite for every candidate
row and cannot provide a clean page/element index. It reduces the global scan but
does not bound work sufficiently for long streams.

### Separate Worker stream-intent table

This gives the deepest model but duplicates outbox lifecycle and requires more
cross-table synchronization. Typed nullable columns keep one durable delivery
aggregate and are sufficient for the current query shapes.

## Out of Scope

- Status-summary caching or retention policy changes.
- Answer-stream metadata redesign for Primary run cards.
- Card update debounce or incremental Markdown rendering.
- Background rejection, transcript cache, or other reliability fixes found in the
  broader optimization audit.
- Installation, service restart, deployment, or remote push.
