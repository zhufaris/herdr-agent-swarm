# Reconciliation Partial-Failure Observability Design

## Problem

`HerdrSnapshotCollector.collect()` contains an individual workspace discovery
failure so other workspaces can still converge. It currently expresses that
failure only through a warning and omits the workspace from the returned map.
`HerdrRuntimeReconciler` then returns every requested workspace ID, and
`ReconciliationScheduler` records the physical pass as successful and starts the
event cooldown for failed workspaces. `/status` consequently reports successful
reconciliation even though one or more authoritative workspace snapshots were
unavailable.

## Goals

- Preserve partial convergence: one unavailable workspace must not block healthy
  workspaces.
- Record a physical pass as failed when any requested workspace discovery fails.
- Apply event cooldown only to workspaces whose snapshots were obtained and
  processed.
- Expose bounded failure scope and error summaries in reconciliation diagnostics.
- Degrade `/status` while the latest Binding reconciliation pass is failed and
  recover automatically after a fully successful pass.
- Preserve the existing repeated-failure degradation/orphan policy for bindings
  in an unavailable workspace.

## Non-goals

- Making partial workspace failure reject the public reconciliation promise.
- Changing `/ready`, which already performs a short-lived direct Herdr workspace
  probe.
- Treating isolated pane convergence failures as workspace discovery failures.
- Persisting reconciliation diagnostics in SQLite.

## Considered approaches

### 1. Structured partial result (selected)

The collector returns successful snapshots and bounded failure records. The
reconciler continues all safe work, then returns the successful workspace set and
failure summary. The scheduler updates cooldown only for successes and records the
pass outcome explicitly. Public reconciliation still resolves because the failure
was contained and scheduled for retry.

This preserves availability while making metrics and retry behavior truthful.

### 2. Throw an aggregate error after partial convergence

Throwing would make the existing metrics count correctly, but it would also fail
startup recovery and callers that intentionally rely on workspace isolation. It
would turn a contained partial outage into an application-wide failure.

### 3. Add a warning counter only

A counter would improve logs but leave failed workspaces under the success
cooldown and would not give health/status a coherent latest-pass outcome.

## Contracts

`HerdrSnapshotCollector.collect(workspaceIds)` returns:

- `panesByWorkspace`: entries only for successful authoritative or fallback
  workspace snapshots;
- `failures`: one record per failed workspace containing `workspaceId` and a
  bounded, redacted-safe message.

The existing failure log gate remains responsible for warning suppression and
one recovery log. The structured result is independent of whether a repeated log
was suppressed. A failed global `listAllPanes` call followed by successful
per-workspace fallbacks is a successful collection.

`ReconciliationScheduler.execute` returns a `ReconciliationPassResult`:

- `reconciledWorkspaceIds`: only workspaces whose snapshot and reconciliation
  path completed;
- `failures`: bounded workspace failure records.

`ReconciliationRunMetrics.measure()` accepts the explicit pass result. It records
`successCount` only when `failures` is empty; otherwise it records `failureCount`,
`lastOutcome: "failed"`, and the latest bounded failures. Unexpected thrown
errors retain the existing rejected-promise behavior and are represented as a
single non-workspace failure.

`ReconciliationDiagnostics` gains `lastFailures`, an array of at most 20 records
with optional `workspaceId` and a message capped at 500 characters. A successful
pass clears the array. This is runtime diagnostic state only and contains no pane
output, prompts, credentials, or raw command arguments.

## Reconciliation flow

For each physical pass:

1. Collect the authoritative all-workspace snapshot when supported.
2. If it fails, fall back to concurrent per-workspace discovery.
3. Record successful snapshots and failed workspace IDs separately.
4. Apply existing binding degradation/orphan transitions for failed workspaces.
5. Reconcile healthy workspace bindings and panes normally.
6. Run global pane pruning only when every workspace in the full pass succeeded.
7. Return successful workspace IDs and failures to the scheduler.
8. Update cooldown timestamps only for successful workspace IDs.
9. Record the whole pass as failed when the failure array is non-empty.

An event for a failed workspace is therefore eligible for immediate retry. A
successful workspace retains the normal one-second event cooldown. Repeated
periodic failures still advance the binding degradation count and can reach the
existing orphan threshold; the pass remains observably failed throughout.

## Health and logging

Collector warning/recovery logs remain unchanged and continue to be deduplicated.
`/status` includes `lastFailures` under `reconciliation.bindingRuntime` and reports
`status: "degraded"` when its latest outcome is failed. A subsequent complete
pass changes the outcome to succeeded, clears `lastFailures`, and restores status
when no other degradation exists.

`/ready` remains based on the direct cached Herdr workspace probe. This avoids a
stale reconciliation diagnostic becoming a second readiness authority.

## Tests

- Collector tests prove mixed success/failure results and all-succeeded fallback.
- Reconciler tests prove healthy workspaces converge while the physical pass is
  counted failed, failed bindings retain their degradation policy, and the next
  successful pass clears failures.
- Scheduler tests prove only successful workspaces receive cooldown and a failed
  workspace can be retried immediately.
- Metrics tests cover explicit partial failure and unexpected exceptions.
- Health tests prove failed Binding reconciliation degrades `/status`, exposes
  bounded failures, and does not independently alter `/ready`.

Run the focused collector, reconciler, scheduler/metrics, and health tests, then
typecheck, build, `git diff --check`, and the full Vitest suite.
