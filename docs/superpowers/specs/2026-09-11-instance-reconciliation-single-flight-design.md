# Instance Reconciliation Single-Flight Design

## Goal

Guarantee that `InstanceRuntimeReconciler` has at most one physical reconciliation
pass at a time. Concurrent pane-, workspace-, periodic-, and startup-triggered
requests must not race durable lifecycle transitions or escape shutdown tracking.

## Decision

Replace the await-then-restart pattern with one owner-controlled serialized drain.
The reconciler maintains three states: active scope, pending merged scope, and the
single drain promise. Callers may add work to the pending scope, but only the drain
loop can start a physical pass or replace the active scope.

The internal scope supports independent pane and workspace sets. Pending requests
union their sets; a full reconciliation is represented by a sentinel and absorbs
all narrower work. A request already covered by the active pass shares the current
drain without adding redundant pending work.

One pass may contain both pane and workspace scope. It snapshots targeted panes
once, reconciles their attached instances, then reconciles requested workspaces
while skipping any instance already handled by the pane portion. Full scope retains
the existing project-wide behavior.

## Shutdown and diagnostics

`stop()` closes admission, cancels the periodic timer, discards work that has not
started, and awaits the sole active drain. Because no caller can create another
pass outside that drain, successful stop proves that no reconciliation writer is
still running.

`ReconciliationRunMetrics` counts physical passes, not callers. Coalesced requests
increment the coalescing counter. Readiness becomes true after the first successful
physical pass and retains the existing last-error semantics.

## Verification

Tests block one full pass, enqueue two different pane scopes, release it, and assert
that peak reconciliation concurrency is one and both panes are covered by one
follow-up snapshot. A shutdown test queues scoped work behind a blocked pass and
asserts no pending pass starts after stop, no write occurs after stop resolves, and
the only active pass is awaited. Existing periodic, targeted, bulk-snapshot, and
readiness tests remain green.

The final gate is the focused instance-runtime and scope-policy suites, typecheck,
build, architecture checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- Parallelizing per-instance durable mutations.
- Changing Herdr snapshot freshness policy.
- Adding cooldown suppression to Worker reconciliation.
- Installing or restarting the service.
