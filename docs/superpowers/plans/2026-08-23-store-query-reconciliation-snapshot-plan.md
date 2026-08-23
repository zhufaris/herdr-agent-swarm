# Store Query and Reconciliation Snapshot Implementation Plan

## Objective

Implement the approved query and reconciliation design in
`docs/superpowers/specs/2026-08-23-store-query-reconciliation-snapshot-design.md`
without changing bridge-visible behavior or touching historical queue state.

## Task 1: Add focused store query tests

Extend `tests/sqlite-store.test.ts` with failing tests for nullable point binding
lookup, deterministic state-filtered binding lookup, phase-filtered run-card
lookup, and the empty-phase case. Include multiple states, bindings, and phases
so each predicate is exercised rather than inferred.

## Task 2: Implement store queries and indexes

Extend `BindingStorePort` and `SqliteBindingStore` with `getBinding`,
`listBindingsByState`, and `listRunCardsByPhases`. Rename the existing private
throwing binding helper and update mutation callers. Add idempotent indexes for
binding state, Pane, topic, root message, and run-card binding/phase query
shapes. Run the focused store tests and inspect SQLite query plans for the new
queries.

## Task 3: Change CardProjector to point lookups

Replace both `listBindings().find(...)` calls in `CardProjector` with
`getBinding`. Update projector integration fakes and tests so a complete binding
list is unavailable on the tested projection paths. Cover both normal topic
projection and streaming continuation-card creation.

## Task 4: Reuse reconciliation snapshots

Add coordinator integration tests that count store calls. Refactor
`reconcileOnce()` to load active bindings once for observation, construct
pass-local ID and Pane maps, and load interrupted provisioning bindings only for
the unbound-Pane recovery path. Keep final worker scheduling on a fresh active
binding query. Update the local maps after a binding is discovered or created
during the pass.

## Task 5: Narrow missing-Pane run-card loading

Change the missing-Pane branch to issue one
`listRunCardsByPhases(bindingId, ["running", "blocked", "queued"])` query,
then partition the returned cards in memory. Verify that running and blocked
cards still fail, queued cards still block, and completed history is not read or
rewritten.

## Task 6: Verify and deploy safely

Run focused store, projector, discovery, lifecycle, and concurrency tests, then
the full test suite, TypeScript typecheck, build, and `git diff --check`. Commit
only the files belonging to this optimization. Before deployment require zero
running prompts and zero pending outbox replies; do not replay queued prompts or
dead letters. Restart the PM2 service, then verify `/ready`, Lark connectivity,
lease ownership, prompt counts, and outbox counts. Never stage or modify `var/`.
