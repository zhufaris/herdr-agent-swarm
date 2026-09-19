# Startup Runtime Reconciliation Concurrency Design

## Problem

Production startup measurements show that `runtime-reconciliation` dominates the
ready path. The latest activation spent 4,919 ms in that stage and 7,340 ms from
`bridge-startup-started` to `bridge-started`; earlier starts spent roughly
7.1-7.9 seconds in runtime reconciliation. Other startup stages normally finish
in 0-409 ms.

The Herdr all-workspace snapshot is already fetched once and cached. The remaining
hot path is `HerdrRuntimeReconciler.reconcileOnce()`, which walks every returned
pane serially. Existing bindings may perform asynchronous worktree lookup,
external-turn observation, lifecycle publication, and card convergence before the
next independent pane is considered. With about 38 live panes, independent I/O
latency accumulates directly on the ready path.

## Goal and acceptance criteria

- Reduce normal production `runtime-reconciliation` startup duration from about
  4.9 seconds to less than 2 seconds in the current four-workspace environment.
- Measure success from structured startup stage logs; do not redefine readiness or
  defer required recovery merely to report ready earlier.
- Preserve pane identity validation, binding lifecycle transitions, exact
  transcript ownership, durable outbox intent, and the no-Prompt-replay rule.
- Keep one authoritative all-workspace Herdr snapshot per reconciliation pass.
- Bound added concurrency at four operations.
- Isolate a pane failure without cancelling unrelated pane convergence.

## Non-goals

- Changing readiness semantics or allowing ingress before required startup
  recovery finishes.
- Parallelizing discovery or attachment of previously unbound panes.
- Parallelizing lifecycle decisions for the same binding.
- Changing SQLite transaction boundaries, Prompt FIFO, transcript parsing, Lark
  delivery, retry, or dead-letter policy.
- Adding an in-memory payload queue or another workflow authority.
- Optimizing Lark HTTP 400 handling or general code duplication in this slice;
  those are the subsequent B and C stages.

## Considered approaches

### 1. Bounded convergence of existing bindings (selected)

Take the current authoritative snapshot and complete missing-pane decisions first.
Classify snapshot panes without asynchronous mutation. Process panes already bound
to an active or orphaned binding with `mapWithConcurrency(..., 4, ...)`. After that
bounded phase completes, process unbound pane discovery serially in snapshot order.

This attacks the measured serial I/O while retaining deterministic creation and
attachment behavior. Different bindings are independent workflow aggregates; a
single binding still has one ordered convergence operation per pass.

### 2. Mark ready before full reconciliation

This would improve the visible startup number but weakens the meaning of ready:
ingress could begin before missing panes, detached observers, and runtime identity
have converged. It is rejected because it moves work off the metric rather than
removing latency.

### 3. Run all pane work with unbounded `Promise.all`

This is mechanically small but allows pane count to determine Herdr, filesystem,
SQLite, event, and outbox fan-out. It is rejected because larger workspaces could
create a startup burst and reduce stability.

## Reconciliation phases

`reconcileOnce()` keeps one physical pass and one `PriorityReconciliationRunner`
request, but organizes the pane work into explicit phases:

1. Load active and orphaned bindings and collect one Herdr snapshot.
2. Build the pane/workspace indexes and apply missing-pane degradation or orphan
   transitions in the existing deterministic binding order.
3. Classify snapshot panes:
   - invalid workspace results are skipped immediately;
   - panes with an existing binding enter the existing-binding work list;
   - unbound non-TraeX panes are ignored;
   - candidate unbound TraeX panes enter the discovery work list.
4. Converge existing bindings with at most four concurrent operations. Each
   operation owns exactly one pane and catches/logs its own failure. Unknown agent
   state enrichment remains inside that pane operation.
5. Process unbound candidate panes serially in snapshot order, retaining interrupted
   provisioning checks, project matching, discovery, and skip-state logging.
6. Prune observation caches only after all phases settle, then publish the same
   reconciliation result and cooldown timestamps as today.

The design does not allow two operations for the same pane. The durable store's
existing pane uniqueness and binding-generation fences remain the final protection
against stale state. Event-triggered requests continue to coalesce behind the
single reconciliation runner.

## Error handling

`mapWithConcurrency` preserves input ordering in its result, but the pane operations
handle their own errors so one rejected pane does not reject the full bounded batch.
The existing `FailureLogGate` continues suppressing repeated diagnostics by pane and
emitting recovery records. Workspace snapshot failures retain their current fallback
and failure reporting.

Discovery remains serial because it can create bindings, consume interrupted
provisioning candidates, rename panes, and reserve durable card intent. No discovery
failure changes how another existing binding converges.

## Observability

Add structured phase durations to the successful reconciliation diagnostic/log
without pane titles, prompt text, or other sensitive payloads:

- `snapshotDurationMs`
- `missingPaneDurationMs`
- `existingBindingDurationMs`
- `discoveryDurationMs`
- `existingBindingCount`
- `discoveryCandidateCount`

The top-level startup stage duration remains authoritative for the acceptance goal.
Phase fields diagnose residual latency and are not a second health authority.

## Tests

Extend `tests/herdr-runtime-reconciler.test.ts` to prove:

- six independent existing bindings never exceed four concurrent convergence
  operations;
- all six converge and a deliberately failed pane does not cancel the others;
- discovery candidates remain serial and preserve snapshot order;
- an existing binding and an unbound discovery candidate cannot race for the same
  pane;
- missing-pane/orphan processing completes before existing-pane convergence;
- full and workspace-scoped reconciliation preserve current coalescing and failure
  isolation behavior;
- phase diagnostics contain counts and finite non-negative durations.

Run the focused reconciler tests, TypeScript typecheck, build, architecture check,
and the full Vitest suite because the change spans runtime workflow ordering.

## Production validation

After tests pass, build and install an immutable release. Use the normal restart
safety gate; do not force an active workload. From the first completed startup of
the new build, verify:

- expected and observed build identities match;
- ownership matches the user-systemd `MainPID` and listener PID;
- readiness is `ready`;
- SQLite quick check is healthy and the Herdr socket is connected;
- `runtime-reconciliation` is below 2,000 ms in structured logs.

If the timing target is missed, use the phase fields to identify the next bounded
hotspot and continue A. Do not declare A complete from unit tests alone.

## Ordered follow-up

After A passes production validation:

1. B designs and fixes avoidable Lark HTTP 400/dead-letter behavior using provider
   codes, delivery targets, and durable outbox evidence.
2. C removes redundant scan/lifecycle code only after A and B behavior is protected
   by tests.

