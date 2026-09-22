# SQLite Outbox Generation and Retention Optimization

## Goal

Reduce SQLite CPU and allocation cost on outbound Answer updates and retention
without changing durable intent identity, lane ordering, recovery evidence, or
claim fencing.

## Design

`SqliteOutboxQueueStore` continues to own lane-key construction. Its private
enqueue input accepts an optional `bindingGeneration` hint. Projection callers
that already hold an authoritative `RunCardView` pass its generation, avoiding
a second run-card read. When no hint is available, the queue store reads only
`binding_generation` from `run_cards`; it must not materialize `run_cards_view`
just to construct a lane key. Binding-only and Worker-only paths retain their
existing lookup behavior.

`SqliteOutboxRetentionStore.pruneDelivered` replaces the recovery predicate
containing an `OR` with two independent anti-joins: one for
`failed_reply_id`, which is the recovery primary key, and one for
`replacement_reply_id`, constrained to active recovery states. The selected
and deleted reply set remains identical. This slice adds no schema migration;
index work remains a separately measurable follow-up.

## Invariants

- The hint is internal to the SQLite adapter and is not added to the domain
  `OutboxStore` contract.
- A supplied generation comes from the same transaction-local Run Card used to
  reserve the outbound intent.
- Missing hints use a scalar durable lookup; they never infer generation from
  memory or Lark state.
- Lane keys, reply IDs, idempotency keys, snapshot revisions, payloads, and
  transaction boundaries do not change.
- Retention continues to preserve every reply referenced as either side of an
  unresolved or replacement-pending recovery.
- No pending, claimed, dead-letter, or otherwise ineligible reply becomes
  prunable.

## Testing

- Prove a supplied generation hint and scalar fallback produce the same lane.
- Prove prompt enqueue no longer needs the full Run Card view for generation.
- Prove retention preserves active failed and replacement replies while pruning
  otherwise eligible history.
- Characterize the split anti-join query plan so the failed-reply lookup uses
  its primary key and the replacement branch remains independently optimizable.
- Run focused SQLite tests, the full Vitest suite, typecheck, build, architecture
  check, documentation audit, public audit, and `git diff --check`.

## Non-goals

- No in-place mutation of revisioned outbox rows.
- No new SQLite index or migration in this slice.
- No cache of SQLite workflow state.
- No installation, restart, or push.
