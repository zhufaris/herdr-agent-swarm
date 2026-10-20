# Startup Continuation Isolation

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Production startup on build `34107aef` completed ready, but retained Session
Activity required four bounded continuation passes. Each pass was represented as
a generic full rescan, so the complete `StartupViewConverger` ran five times.
The shared `sqlite.outbox-recovery-store.write` label consequently reported five
slow transactions averaging 242.8 ms even though only retained page recovery
needed continuation.

Separately, `InstanceRuntimeReconciler` processes instances in stable order but
does not isolate `reconcileInstance()` failures. One bad early instance aborts
the pass and can starve every later healthy instance on each retry. This violates
the system constraint that one scope failure must not block unrelated scopes.

## Solution

Auto-selected under the goal's explicit no-wait authority: deepen the existing
recovery modules without introducing a new scheduler.

`StartupViewRecovery` gains a process-local retained-continuation lane that uses
its existing single timer, backoff, active-run fence, and diagnostics. Explicit
full rescans and retained continuations are separate flags; an explicit full
rescan has priority and cannot be consumed by continuation work.
`StartupViewConverger` exposes one narrow internal continuation method that only
drains the next bounded retained pages. Initial and explicit full convergence
still run all view/outbox/card/binding work exactly once.

Outbox recovery transaction labels become method-specific so production logs
identify failure transition, dead-letter recovery, stale quarantine recovery,
worker-card retirement, retry, and dismissal independently.

`InstanceRuntimeReconciler` catches instance-local failures, continues remaining
instances and workspaces, then throws one aggregate failure after the pass. The
runner therefore records a failed/retryable pass while healthy instances still
converge. Workspace snapshot failures are isolated to that workspace and are
included in the same aggregate.

Rejected alternatives:

- synchronously draining every retained page would avoid repeat work but extend
  one event-loop stall without a bound;
- a single cursor/continuation flag inside `StartupViewConverger` cannot
  distinguish a new external full-rescan request and could silently lose it;
- a new worker, queue, timer, or durable cursor duplicates the existing recovery
  runner and adds more state than the problem requires.

## User Stories

### SCN-1: Retained pages continue without repeating full convergence

After initial full convergence returns retained work, later bounded passes call
only retained activity recovery. Outbox quarantine recovery, Turn Card
convergence, binding convergence, and legacy notification cleanup are not
repeated by those continuation passes.

### SCN-2: Explicit full rescans outrank retained continuation

If an external full-rescan request arrives while retained continuation is
pending, the full pass runs first and remains observable. Any retained remainder
is then continued through the existing recovery timer.

### SCN-3: Continuation failures retain exact retry ownership

A failed retained continuation requeues continuation only. A failed full pass
requeues the full pass. Shutdown still waits for at most one active run.

### SCN-4: Outbox slow transactions identify their operation

Every public outbox recovery operation uses a stable method-specific SQLite
transaction label; no behavior, transaction boundary, or retry policy changes.

### SCN-5: One bad instance does not starve healthy instances

Targeted, workspace, and full reconciliation continue past an instance-local
failure. Healthy later instances persist their observations. The overall pass
still rejects with bounded aggregate evidence so the runner retries and readiness
does not falsely report success.

## Implementation Decisions

### INV-1: One runner owns all startup-view retry timing

`StartupViewRecovery` remains the only timer/backoff/active-run owner. Full,
continuation, and targeted work are flags or sets within that module, never
independent loops.

### INV-2: Full work cannot be lost by coalescing

Full rescan has priority over continuation. Requests arriving during an active
run are retained in the appropriate pending flag and scheduled afterward.

### INV-3: Continuation has a narrow interface

The continuation interface returns the existing convergence result shape but
may only drain retained activity pages. It cannot recover outbox work, converge
cards/bindings, or publish unrelated effects.

### INV-4: Failure isolation preserves retry truth

Instance/workspace failures are collected with stable identity context. The pass
continues independent work, then throws when any failure occurred. `completed`,
`ready`, runner success counts, and `lastError` advance only on an entirely clean
pass.

### ARCH-1: Reuse existing recovery and reconciliation modules

Coordination remains in `StartupViewRecovery`, startup projection work remains
in `StartupViewConverger`, outbox transactions remain in
`SqliteOutboxRecoveryStore`, and instance policy remains in
`InstanceRuntimeReconciler`. No domain or adapter depends on a new runtime
component and no public external API changes.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, INV-1, INV-2, INV-3, INV-4, ARCH-1

- Prove initial convergence calls full work once, then multiple continuation
  passes call only retained recovery until complete.
- Queue an explicit full request beside continuation and prove full priority,
  no lost request, one active run, and correct retry flag after injected errors.
- Count outbox method transaction labels without changing recovery outcomes.
- Inject a failure in the first of two instances and prove the second persists,
  the pass rejects with identity context, diagnostics remain failed, and a later
  clean pass succeeds.
- Inject one workspace snapshot failure alongside a healthy workspace and prove
  healthy instances still converge before aggregate rejection.

## Out of Scope

No new worker, queue, timer, table, durable cursor, recovery ledger, startup page
size change, outbox query rewrite, Turn Card retry-budget change, parallel
instance reconciliation, readiness-policy relaxation, or production DB mutation.

## Further Notes

Workspace `/tmp/herdr-agent-swarm-main-ring-stability-20261012` is the clean
isolated `main` worktree at
`34107aefaeaeef07958a7d96b5aeefe7003574fd`; the original checkout remains
excluded. Baseline record `6069fe8d596644e38a0d4e8f5a535e19` passed five
files and 78 tests. Its full conservative capture remains conversational; the
artifact records the observed command/result and delivery will rerun all checks.
