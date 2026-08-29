# Reconciliation Diagnostics Design

## Goal

Expose bounded runtime diagnostics for binding and instance reconciliation so an
operator can distinguish a healthy periodic scan from an in-flight, coalesced,
slow, or recently failed scan without reading raw logs.

## Context

The durable `/status.operational` view already reports prompt queue, execution,
delivery latency, dead letters, quarantines, and lane backlog. The remaining
architecture-priority gap is reconciliation duration and process-local scan
health. `HerdrRuntimeReconciler` and `InstanceRuntimeReconciler` perform the
actual work, so they are the authoritative place to measure it.

## Decision

Each reconciler exposes `snapshot(): ReconciliationDiagnostics`. The snapshot is
process-local and contains only low-cardinality metadata:

```ts
interface ReconciliationDiagnostics {
  state: "idle" | "running" | "stopping";
  runCount: number;
  successCount: number;
  failureCount: number;
  coalescedRequestCount: number;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  maxDurationMs: number | null;
  lastOutcome: "succeeded" | "failed" | null;
}
```

`runCount` counts physical reconciliation passes, not callers. A request that
joins an in-flight pass increments `coalescedRequestCount`. For the binding
reconciler, a follow-up pass caused by a request arriving during a scan is a new
physical run. Duration uses a monotonic clock; timestamps use wall-clock ISO
strings. A failure increments `failureCount`, records duration and outcome, and
continues through the existing error path. No error message is returned in this
diagnostic surface because existing structured logs already carry bounded error
context.

The health server publishes the snapshots under
`reconciliation.bindingRuntime` and `reconciliation.instanceRuntime`. Snapshot
exceptions are isolated into a bounded `{ error }` value and make `/status`
degraded. A normal in-flight or historically failed reconciliation does not by
itself degrade status; durable/readiness checks remain authoritative. `/health`
and `/ready` semantics do not change.

## Boundaries

- No SQLite migration or metrics history table.
- No Prometheus dependency or high-cardinality labels.
- No pane, workspace, project, binding, prompt, terminal output, or error text in
  the snapshot.
- No polling, retry, reconciliation, or recovery behavior changes.
- Existing Store latency and outbox lane summaries remain unchanged.

## Failure handling

Instrumentation is synchronous and cannot replace the reconciler's original
exception. Diagnostic state is finalized in `finally`, so success and failure
durations are recorded consistently. Snapshot objects are newly allocated to
prevent callers from mutating internal state.

## Verification

Focused tests cover idle, running, successful, failed, coalesced, and stopping
snapshots for both reconcilers; follow-up-pass counting for binding
reconciliation; `/status` shape and snapshot failure isolation; and unchanged
readiness. Then run the full test suite, typecheck, build, and diff check.
