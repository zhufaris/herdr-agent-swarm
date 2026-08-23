# Store Query and Reconciliation Snapshot Design

## Goal

Reduce avoidable SQLite reads, row mapping, and JSON parsing in reconciliation
and card projection without changing observable bridge behavior. This is a
targeted performance and interface-depth change; coordinator decomposition is
explicitly deferred.

## Current problem

`SyncCoordinator` and `CardProjector` use `listBindings().find(...)` when they
need one binding. A reconciliation pass also reloads all bindings at several
points. When a Pane is missing, it calls `listRunCards(bindingId)` twice and
parses every historical run card both times, once for running or blocked cards
and once for queued cards.

These operations are correct at the current scale, but their cost grows with
history rather than with the active work being reconciled. They also expose a
wide collection interface where callers require narrower domain queries.

## Store interface

Add these public queries to `BindingStorePort` and `SqliteBindingStore`:

- `getBinding(id: string): Binding | null` reads one binding by primary key.
- `listBindingsByState(state: Binding["state"]): Binding[]` reads bindings in
  deterministic creation order.
- `listRunCardsByPhases(bindingId: string, phases: readonly
  RunCardView["phase"][]): RunCardView[]` reads only cards in the requested
  phases, in the same deterministic order as `listRunCards`. An empty phase
  list returns an empty array without issuing a malformed SQL statement.

Existing list methods remain available for administrative views and callers
that genuinely need complete collections. The private throwing binding lookup
used by mutations is renamed to avoid colliding with the nullable public
query.

## Reconciliation snapshot

At the beginning of the binding portion of one `reconcileOnce()` pass, load
active bindings exactly once with `listBindingsByState("active")`. Build two
maps from that result:

- binding ID to binding, for interrupted-provisioning and identity checks;
- Pane ID to binding, for matching discovered Panes.

The maps are a pass-local observation snapshot, not a cache across passes. They
must not replace fresh results returned by mutations. If reconciliation creates
a binding for a newly discovered Pane, update the pass-local maps immediately
so another Pane in the same pass cannot claim the same binding. Final worker
scheduling uses a fresh `listBindingsByState("active")` query because earlier
steps may have created or transitioned bindings.

Interrupted provisioning bindings are not active and therefore are loaded once
separately, only when reconciliation needs to match an unbound Pane. This keeps
the common active-Pane path narrow while preserving the existing recovery
semantics.

## Missing-Pane run cards

For a confirmed missing Pane, query run cards once for `running`, `blocked`, and
`queued` phases. Partition that result in memory:

- running and blocked cards transition to failed;
- queued cards transition to blocked.

Ordering, notices, view versions, and legacy non-streaming card updates remain
unchanged. No completed or failed historical cards are loaded.

## Card projection

`CardProjector` uses `getBinding(bindingId)` for topic-card projection and when
creating continuation pages for streaming answers. It must no longer depend on
`listBindings()` for point lookup. Missing bindings or bindings without a root
message retain the current no-op behavior.

## SQLite indexes

Add idempotent indexes only for query shapes introduced or already present on
hot paths:

- `bindings(state, created_at)` for active reconciliation;
- `bindings(pane_id, created_at DESC)` for Pane ownership lookup;
- `bindings(topic_id, created_at DESC)` and
  `bindings(root_message_id, created_at DESC)` for Lark routing;
- `run_cards(binding_id, phase, created_at, prompt_id)` for phase-filtered card
  loading.

Indexes are created during the existing migration flow with `IF NOT EXISTS`.
They do not change uniqueness or lifecycle rules. The existing
`run_cards(binding_id)` index may remain; removing a redundant index is outside
this change unless query-plan evidence proves it unnecessary and migration-safe.

## Consistency and failure behavior

This design does not introduce a long-lived cache. Each reconciliation pass
observes a bounded snapshot, while all writes still go through the existing
lease write fence and transactional store methods. A failed query aborts the
same reconciliation pass and is reported through existing logging. No prompt is
replayed, no Pane is closed, and no binding lifecycle transition changes.

## Verification

Tests must prove:

1. Each new store query returns only matching rows in deterministic order and
   handles an empty phase list.
2. A normal reconciliation pass loads active bindings once for observation and
   does not use complete-list point lookups.
3. A missing Pane performs one phase-filtered run-card query and preserves the
   current failed/blocked transitions.
4. `CardProjector` performs point binding lookup for normal projection and
   streaming continuation pages.
5. Existing concurrency, lifecycle, streaming, command, and persistence tests
   remain green, followed by typecheck, build, and `git diff --check`.

Production deployment remains gated on zero running prompts and zero pending
outbox messages. Historical queued prompts and dead letters are not replayed or
modified by this optimization.

## Deferred work

After these query boundaries are stable, split `SyncCoordinator` into dedicated
reconciliation, command-handling, and prompt-execution modules. That refactor is
not combined with this performance change so behavioral and structural risk can
be reviewed independently.
