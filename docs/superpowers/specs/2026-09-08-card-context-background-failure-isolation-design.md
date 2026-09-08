# Card Context Background Failure Isolation Design

## Problem

`CardContextRebuilder` exposes `requestScan()` as an awaitable operation, but it
also invokes that operation as background work during startup, on the periodic
timer, and from outbound-work notifications. `scan()` logs projection failures
and rethrows them. The three background call sites do not observe that rejected
promise, so a transient SQLite or rendering failure can become an unhandled
promise rejection even though the durable card-context invalidation remains
available for retry.

The failure should remain visible in logs and to explicit callers without
escaping from lifecycle-owned fire-and-forget work. A failed scan must not leave
the rebuilder stuck or consume its durable invalidation.

## Decision

Add a private `wake()` method as the error boundary for background scans.
Startup, interval, and notifier callbacks call `wake()` instead of invoking
`requestScan()` directly. `wake()` attaches a rejection handler to the returned
promise so no background rejection reaches the process-level unhandled-rejection
handler.

The existing `scan()` method remains responsible for the single structured
failure log. The `wake()` rejection handler intentionally does not emit a second
error record. Public `requestScan()` retains its current rejecting contract so
tests, diagnostics, and future explicit callers can observe projection failure.

This is deliberately narrower than replacing the rebuilder with
`CoalescingDrain`. It preserves the current single-flight behavior and lifecycle
surface while fixing the unsafe fire-and-forget boundary.

## Runtime behavior

The three lifecycle-owned triggers behave identically:

1. startup, the periodic timer, or the outbound notifier calls `wake()`;
2. `wake()` invokes `requestScan()` and handles any rejection;
3. `requestScan()` reuses the active promise when a scan is already running;
4. `scan()` logs a failure with `outcome: "retry"` and rethrows;
5. the existing `finally` clears the active single-flight promise;
6. a later trigger starts a fresh scan against the still-durable invalidation.

The change does not add an immediate retry loop. Retry cadence continues to come
from later durable-work notifications and the periodic scan, avoiding a tight
failure loop. It does not change card rendering, invalidation reservation, or
outbox semantics.

## Shutdown semantics

`stop()` keeps its current explicit observation of an active scan. If shutdown
begins during a failing scan, `stop()` may reject with that scan failure. The
background `wake()` handler prevents an unhandled rejection, while the awaited
shutdown path remains able to report the failure. Once stopping begins, later
`requestScan()` calls resolve without starting work.

## Tests

Add focused lifecycle coverage with a controllable projection store and outbound
notifier:

- a startup-triggered projection failure is logged and does not emit an
  `unhandledRejection`;
- after that failure clears the single-flight state, a later notifier wake runs
  another scan successfully;
- an explicit `requestScan()` still rejects when projection fails.

The timer and notifier share the same private `wake()` boundary, so exercising
startup plus notifier proves both the lifecycle entry point and recovery without
introducing timing-sensitive interval assertions. Run the focused card-context
tests, typecheck, build, and the full test suite because this changes a
lifecycle-owned background loop.

## Success criteria

- Background card-context scan failures cannot produce an unhandled promise
  rejection.
- Every failure retains the existing structured diagnostic record exactly once.
- An explicit scan caller still receives the rejection.
- A later wake can retry after failure; no invalidation is discarded and no
  tight retry loop is introduced.
- Existing single-flight, shutdown, rendering, and durable outbox behavior is
  unchanged.
