# Herdr Pane Hint Freshness Design

## Goal

Ensure a pane-scoped Herdr status event cannot reconcile Worker instances from
a snapshot captured before that event. In particular, an actual busy Worker
must not be persisted as idle and awakened for another queued turn.

## Decision

Add `WorkspaceSnapshotCache.invalidatePanes(paneIds)`. For every pane with a
known pane-to-workspace identity, it invalidates that workspace. If any pane is
unknown to the cache, it invalidates all snapshots because no narrower safe
scope can be proven.

`HerdrEventRouter` invokes this freshness fence for pane-scoped hints before it
starts Binding reconciliation, Worker reconciliation, turn observation, or
retired-pane recovery. The consumers may remain concurrent after invalidation.
Their first snapshot read then coalesces through the cache onto post-event
refresh work instead of reusing a pre-event TTL hit.

Topology-scoped hints retain their workspace invalidation path. Full-scope hints
continue to rely on full reconciliation and periodic convergence.

## Correctness properties

- Invalidation happens synchronously before any pane-hint consumer is invoked.
- An in-flight refresh fenced by invalidation may return to its original caller
  but cannot publish stale data into the cache.
- Known pane identities invalidate only their workspaces.
- Missing pane identity fails conservative by clearing every cached snapshot.
- Cache invalidation remains a hint boundary; fresh Herdr observation is still
  the runtime authority.

## Verification

Tests prime the cache with an idle Worker pane, change the delegate snapshot to
working, route an `agent-status` hint, and assert Worker reconciliation persists
working without waking queued work. Additional tests assert invalidation occurs
before every consumer starts, known panes preserve unrelated workspace cache
entries, unknown panes clear all entries, and an invalidated in-flight refresh
cannot overwrite the post-event snapshot.

The final gate is focused event-router, snapshot-cache, and instance-runtime
tests, followed by typecheck, build, architecture checks, the complete Vitest
suite, and `git diff --check`.

## Non-goals

- Changing Herdr's authoritative event or snapshot protocol.
- Passing one immutable event snapshot through every reconciler interface.
- Redesigning general `forceRefresh` coalescing in this slice.
- Installing or restarting the service.
