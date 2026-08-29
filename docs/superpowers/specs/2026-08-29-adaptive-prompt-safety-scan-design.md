# Adaptive Prompt Safety Scan Design

## Status

Approved for implementation under the operator's standing instruction to use
the recommended design without another confirmation gate.

## Problem

Prompt workers receive scoped in-process wake hints after durable SQLite state
changes. A periodic durable safety scan recovers work after a lost hint or
restart. Today that scan runs every five seconds even when no queued, steering,
or detached work exists. The fixed interval gives a useful recovery bound but
causes repeated SQLite transactions during long idle periods.

## Goals

1. Reduce idle full-database safety scans.
2. Keep immediate scoped wake behavior unchanged.
3. Bound lost-wake recovery to 30 seconds.
4. Retry scan failures promptly rather than backing away from an unhealthy store.
5. Make the active delay and next scheduled scan observable without exposing prompt content.

## Non-goals

- Changing SQLite queue or claim semantics.
- Replacing durable safety scanning with in-memory notifications.
- Changing prompt acceptance, worker concurrency, or detached no-replay rules.
- Adapting the Lark outbox or instance-worker scan loops.
- Adding random jitter; this service owns one fenced SQLite lease.

## Scheduling model

Replace the repeating interval with one unref'd timeout. Starting the workflow
runs one synchronous safety scan and then arms exactly one timeout.

The configured safety interval remains the base delay. With the production
default of five seconds, consecutive idle outcomes schedule delays of 5, 10,
20, then 30 seconds. Further idle outcomes remain capped at 30 seconds. The cap
is six times the configured base interval, so tests and non-default deployments
retain proportional behavior.

A scan that discovers any hint or cancellation resets the next delay to the
base interval. A failed scan also uses the base interval: database errors must
not increase recovery latency.

## Wake behavior

Every workflow wake continues to run its existing scoped scheduling path
immediately. It does not wait for or invoke a full durable scan. After handling
the hint, the workflow resets the safety timeout to the base interval. This
keeps the cheap scoped fast path and brings the next convergence check close to
new activity in case another hint was lost.

Repeated wakes may replace the pending timeout but never create more than one.
The timeout callback clears its handle before scanning and re-arms only after
the outcome is known.

## Lifecycle and races

JavaScript's single event loop serializes timer and wake callbacks. The
workflow owns one timeout handle and one stopping flag.

- start is idempotent, subscribes before the initial scan, and arms one timeout after that scan.
- requestSafetyScan remains callable for tests and operators. It performs a scan immediately and replaces the pending timeout according to the result.
- wake resets the pending timeout after scoped scheduling.
- stop sets the stopping flag before clearing the timeout and unsubscribing, so no callback can re-arm afterward.

The scan remains synchronous because the SQLite implementation is synchronous.
No external Herdr or Lark operation is added to the scan transaction.

## Diagnostics

Extend prompt-worker diagnostics with currentSafetyScanDelayMs and
nextSafetyScanAt. The latter is an ISO timestamp for the currently armed
timeout, or null while stopped or before start.

These fields expose scheduling state only. Existing last-scan outcome,
discovered counts, and failure timestamps remain unchanged.

## Testing

Fake-timer tests must prove:

1. startup scans immediately and arms one base-delay timeout;
2. consecutive idle scans use base, 2x, 4x, then capped 6x delays;
3. work found resets the next delay to base;
4. failure retries at base and remains redacted;
5. a wake during a long idle delay re-arms the timeout at base while immediately invoking the scoped claim path;
6. repeated starts and wakes never create multiple live timers; and
7. stop clears the timeout and prevents future scans or re-arming.

Existing concurrency, steering, restart recovery, health status, typecheck,
build, and full-suite tests remain required.

## Deployment and rollback

Deploy through the standalone service's normal safe restart without --force.
Readiness semantics do not change. Rollback restores the fixed interval; no
database migration or durable state rollback is required.
