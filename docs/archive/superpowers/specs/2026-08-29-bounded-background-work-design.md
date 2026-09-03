# Bounded Background Work and Shutdown Design

## Status

Approved for implementation. The user authorized the recommended approach to proceed without per-batch confirmation.

## Problem

The bridge launches several durable background loops with fire-and-forget promises. Store-level failures in the Lark outbox scanner and delivery failures in `CardUpdateScheduler` can escape as unhandled rejections. Separately, the SQLite integrity worker and shutdown writer settlement have no final time bound, so a stuck worker can prevent systemd restart indefinitely.

These are control-plane failures: they must be visible and retried, but they must not duplicate prompts, discard durable outbox intent, or close SQLite while a writer may still be using it.

## Goals

1. Contain all fire-and-forget outbox scans and card-update flushes.
2. Retry transient background failures with bounded backoff and expose failure diagnostics.
3. Mark `/status` degraded while the outbox scan is failing.
4. Allow an in-flight SQLite integrity worker to be aborted at shutdown.
5. Put integrity-auditor shutdown under the same global deadline as other runtime components.
6. Return from shutdown after the final abort-settlement window without releasing SQLite ownership when writers remain unsettled.
7. Preserve durable delivery, CardKit ordering, lease fencing, and no-replay guarantees.

## Selected design

### Background launch containment

`LarkOutboxDispatcher` will own a private launcher for all asynchronous scan entry points. The launcher observes the returned promise and logs a bounded structured failure. `requestScan()` remains awaitable for tests and explicit control, but timer, notifier, startup, retry, and follow-up invocations never expose a rejected promise to Node.

On a scan-level failure, the dispatcher records `lastScanFailureAt`, increments `consecutiveScanFailures`, and schedules the existing retry timer with bounded exponential backoff. A successful scan resets the consecutive count and records `lastSuccessfulScanAt`. Durable rows remain pending; no Lark or TraeX action is replayed by the launcher itself.

`CardUpdateScheduler` will similarly route every fire-and-forget flush through one launcher. A failed delivery keeps the latest desired version pending and schedules a bounded retry. Newer versions continue to supersede older versions. `stop()` cancels timers and suppresses retries. An optional error callback gives the owning projector structured logging without coupling the scheduler to Pino.

### Operational degradation

`OutboxDispatcherDiagnostics` gains recent-success and failure fields. `/status` is degraded when the most recent scan outcome is `failed`; a later successful scan clears the condition. This reports delivery-pipeline stalls without changing `/ready`, which continues to describe dependency readiness.

### Abortable integrity inspection

`DatabaseIntegrityStore.inspectIntegrity` accepts an optional `AbortSignal`. `WorkerDatabaseIntegrityStore` keeps the worker local to the inspection promise, uses one settle/cleanup path, and terminates it when the signal aborts. Worker termination is awaited only as cleanup and cannot settle the inspection twice.

`SqliteIntegrityAuditor.stop(context)` clears the interval, forwards the shared shutdown signal to the active inspection, and waits only within the caller's shutdown budget. Normal explicit `run()` remains coalesced and still converts inspection failures into degraded diagnostics.

### Bounded shutdown ownership

`BridgeRuntimeShutdown` owns the integrity auditor alongside other components. `main.ts` no longer awaits it before starting the shared shutdown deadline.

If write-capable components remain unsettled after the global deadline plus the existing abort-settlement allowance, shutdown returns a result indicating retained ownership. It does not deactivate the write fence, release the lease, or close SQLite. The process entry point sets a non-zero exit code for this result so systemd can replace the stuck process. This preserves the stronger safety property: a possibly active writer never observes a closed database.

Startup-failure cleanup uses independent safe stops and a `finally` ownership release when runtime shutdown has not yet been constructed. A single cleanup rejection cannot skip subsequent cleanup steps.

## Alternatives rejected

- Adding `.catch()` at each call site: contains rejections but duplicates policy and provides no retry diagnostics.
- Closing SQLite at the deadline regardless of writers: bounds shutdown but violates the durable-writer safety invariant.
- A generic process-wide task supervisor: useful at larger scale, but unnecessary for the two concrete schedulers in this increment.

## Tests and acceptance

- Outbox startup/timer scans do not produce unhandled rejection and retry after a store failure.
- Outbox diagnostics reset after recovery; `/status` is degraded only while the latest scan is failed.
- Card update failure invokes the error boundary, retries the latest version, and stops retrying after `stop()`.
- Aborting an integrity inspection rejects/settles and terminates its worker.
- Auditor stop participates in the shared shutdown context.
- Unsettled writers cause bounded shutdown return without fence, lease, or store release.
- Normal shutdown retains existing stop order and releases ownership last.
- Focused tests, full Vitest suite, typecheck, and build pass.

## Non-goals

- Changing outbox idempotency or delivery ordering.
- Retrying individual permanent Lark delivery failures.
- Force-closing SQLite while a writer is active.
- Reworking reconciliation, Answer rendering, or prompt queue capacity in this batch.
