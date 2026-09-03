# Reconciler Observation State Pruning Design

## Context

`HerdrRuntimeReconciler` retains process-local observations keyed by pane ID:
terminal output, monotonic agent state, tab ID, and worktree name. These values
prevent duplicate projections and reject stale state sequences while a pane is
live. They are never removed after a pane disappears. Long-running bridges with
pane churn therefore retain stale strings and metadata indefinitely. If Herdr
later reuses a pane ID with the same terminal identity and a lower state
sequence, the stale observation can also overwrite the new pane's reported
agent state.

The separate `observedOutputRevisions` map is written but never read. Terminal
content fingerprinting is already the authoritative deduplication boundary.

## Decision

After a successful full reconciliation pass, prune every pane-keyed observation
map to the pane IDs present in the complete current snapshot. This includes
terminal output, monotonic agent state, tab ID, and worktree name. Remove the
unused output-revision map and its writes.

A pass is safe to prune only when both conditions hold:

1. it was requested as a full reconciliation rather than a workspace-scoped
   event hint; and
2. every configured workspace produced a pane list, either from the native
   all-pane snapshot or from a successful per-workspace fallback.

If any configured workspace is unavailable, the pass still performs existing
degradation/orphan accounting but does not prune observation state. A scoped
pass never prunes, because panes outside the requested workspace were
intentionally not observed.

Pruning runs after pane processing so live entries written during the pass are
retained. It uses the already-built pane ID sets and introduces no additional
Herdr calls, timers, or persisted state.

## Alternatives

1. Bound each map with LRU. This controls memory but may evict observations for
   live panes and cause duplicate projections, while still retaining stale pane
   IDs until capacity pressure occurs.
2. Delete observations immediately when a binding is orphaned. This misses
   unbound and skipped panes and can delete state after a non-authoritative
   workspace failure.
3. Clear all maps before every pass. This defeats deduplication and monotonic
   state protection, especially for frequent event-driven reconciliation.

Snapshot-based pruning is selected because pane existence is authoritative only
when the reconciler has a complete successful view.

## Invariants

- A partial or failed observation must never be interpreted as pane absence.
- A live pane retains its terminal baseline and monotonic state across passes.
- A disappeared pane ID starts with no process-local observation if it is later
  reused.
- No SQLite workflow facts, replay decisions, or Lark delivery intent are
  inferred from these process-local maps.

## Test Strategy

Use `HerdrRuntimeReconciler.reconcile()` and durable binding observations as the
public seam. First observe a bound pane at a high state sequence, then return a
successful empty full snapshot so the pane is orphaned. Attach a new binding to
the reused pane ID and report a lower sequence with a different state. The new
state must be accepted, proving the old monotonic observation was removed.

Retain existing coverage that unavailable snapshots degrade rather than infer
absence, and run the focused reconciler suite, TypeScript checking, the full
Vitest suite, and the production build before committing.
