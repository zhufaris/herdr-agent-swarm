# Herdr Runtime Reconciliation Design

## Goal

Deepen Primary Binding runtime reconciliation without changing Herdr authority,
SQLite transitions, scope priority, cooldown, discovery, projection, event, or
no-replay behavior. A fresh Herdr observation remains the only runtime truth.

## Current problem

`HerdrRuntimeReconciler` currently combines two state machines. It owns the public
lifecycle and priority runner, but also implements the complete targeted and
workspace/full reconciliation pass. The latter includes snapshot collection,
scope planning, missing-Pane handling, existing-Binding enrichment, discovery,
pass-local identity exclusion, observation-cache pruning, diagnostics, and
per-item failure isolation. This makes lifecycle changes depend on pass internals
and leaves the authoritative convergence algorithm difficult to exercise through
one focused interface.

The existing `BindingRuntimeConverger` is already the correct deep module for one
known Binding and one Pane observation. Its generation-fenced SQLite transitions,
projection effects, exact external-turn observation, and scheduler wake decisions
must remain together.

## Considered approaches

### A. Extract one authoritative reconciliation-pass module (chosen)

Keep `HerdrRuntimeReconciler` as the lifecycle facade for public requests,
cooldown admission, priority coalescing, periodic execution, diagnostics snapshots,
and shutdown. Add `BindingReconciliationPass` with a small `captureBaselines()` and
`execute(scope)` interface. The pass owns targeted observation and full/workspace
snapshot classification through discovery and pruning.

This creates one seam around the behavior that must remain ordered while retaining
`BindingRuntimeConverger` as the nested per-Binding seam.

### B. Create separate targeted, existing-Binding, and discovery modules

This produces more files but forces the caller to coordinate shared snapshot maps,
pass-local Binding ownership, skipped-Pane warning state, and pruning eligibility.
Those shallow interfaces expose the algorithm instead of hiding it.

### C. Extract only pure scope planning

This removes little orchestration from the facade. Herdr reads, concurrency,
failure isolation, discovery, and convergence order would remain mixed with
lifecycle policy, so the seam would not be meaningfully deeper.

## Modules and interfaces

`HerdrRuntimeReconciler` retains the existing public interface:

`captureBaselines`, `reconcile`, `requestReconciliation`,
`requestPaneReconciliation`, `snapshot`, `start`, and `stop`. It owns:

- `PriorityReconciliationRunner` and request-scope admission;
- the one-second event cooldown and last-reconciled workspace timestamps;
- periodic lifecycle, shutdown, and the public diagnostic snapshot;
- copying pass-result phase metrics into lifecycle diagnostics.

`BindingReconciliationPass` owns:

- baseline capture through `HerdrSnapshotCollector`;
- batched targeted Pane observation and active/orphaned Binding lookup;
- full/workspace scope expansion from configured and durably owned workspaces;
- one authoritative snapshot, wrong-workspace rejection, and Pane classification;
- missing-Pane degradation/orphan decisions;
- bounded existing-Binding enrichment and convergence;
- safe project matching, interrupted-provisioning exclusion, and Pane discovery;
- skipped-Pane warning deduplication and full-pass observation-cache pruning;
- per-item failure isolation and phase timing/count results.

Its external interface is:

```ts
interface BindingReconciliationPassPort {
  captureBaselines(): Promise<void>;
  execute(scope: PriorityReconciliationScope): Promise<BindingReconciliationPassResult | void>;
}
```

The result extends the existing reconciled-workspace/failure result with phase
diagnostics. Pane-targeted execution returns no workspace completion claim, exactly
as today. The facade does not inspect Pane or Binding collections.

## Authority and invariants

- Herdr snapshot or targeted runtime observation is authoritative for live Pane
  identity and Agent state.
- SQLite remains authoritative for Binding ownership, generation, lifecycle,
  provisioning checkpoints, projections, and queued work.
- `BindingRuntimeConverger` retains every generation/session-fenced state
  transition and all downstream projection/event/wake ordering.
- Targeted Pane requests stay ahead of workspace and full requests through the
  existing priority runner. A late hint is not treated as covered by an older pass.
- Full-pass pruning runs only when every reconciliation workspace returned a
  snapshot. Partial and workspace-scoped passes never erase observation baselines.
- Process-local cooldowns, warning signatures, and caches are latency/logging aids,
  never durable authority. Lost hints converge through periodic scans.
- Reconciliation never replays an Agent prompt. Exact external-turn observation
  remains downstream of a successfully fenced Binding convergence.

## Failure and shutdown behavior

Snapshot failures retain the existing all-workspace fallback and per-workspace
failure reporting. One Pane or Binding failure is logged through the existing
deduplicating failure gate and does not abort sibling convergence. A pass-level
exception still reaches the runner and its diagnostics.

Stopping rejects new periodic work through the runner and waits for the active pass.
No new independent worker, timer, queue, or durable state is introduced.

## Verification

Add an interface-level tracer test for one pass that proves a full snapshot
classifies an existing Binding and a discoverable Pane while preserving the
pass-local ownership map. Keep the existing reconciler integration suite as the
behavioral regression surface for targeted batching, cooldown, missing workspaces,
discovery ambiguity, concurrency, recovery, observation, and shutdown. Add
architecture guards that keep snapshot/classification/discovery details out of the
facade and runner/lifecycle details out of the pass.

Then run focused reconciliation and architecture tests, typecheck, build,
architecture check, docs audit, the full suite, and `git diff --check`.

## Non-goals

- No change to SQLite schema or `RuntimeReconciliationStore` operations.
- No change to Herdr adapter calls, snapshot cache policy, concurrency constants,
  cooldown, logging text, lifecycle events, cards, or scheduler wakes.
- No refactor of Worker instance reconciliation, command/control, runtime health,
  or service lifecycle in this pass.
- No generic reconciliation framework and no process-local durable queue.
