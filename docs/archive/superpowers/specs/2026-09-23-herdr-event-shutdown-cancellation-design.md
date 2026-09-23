# Herdr Event Shutdown Cancellation

## Goal

Allow the shared shutdown deadline to cooperatively stop Herdr event work that
has not started yet, while continuing to hold SQLite ownership until every
already-started callback and durable operation has actually settled.

## Safety constraint

Cancellation is a request to stop future work, not proof that current work has
stopped. The implementation must never use `Promise.race` or an abort event to
report the event drain as settled while its callback can still access SQLite.
`drainEvents()` continues awaiting the real drain promise.

## Considered approaches

### A. Cancel only queued subscriber hints

The subscriber could discard a coalesced hint after the deadline. This is safe
and small, but it cannot stop later stages inside the active router callback.

### B. Propagate one event-lifecycle signal through subscriber and router

The subscriber owns an `AbortController` for admitted event work. During
shutdown, `drainEvents(context)` links the shared shutdown signal to that
controller. The router checks the signal before starting a route and between
dependent stages. This is the chosen approach: it avoids new work after the
deadline while retaining true settlement semantics.

### C. Thread AbortSignal through every reconciliation adapter and transaction

Passing cancellation through every Herdr command, transcript read, loop, and
SQLite mutation could interrupt more work. It is a cross-cutting contract change
with ambiguous transaction and effect-certainty semantics, so it is outside this
focused change.

## Event cancellation lifecycle

`HerdrSocketSubscriber` creates one private `AbortController` for its event
lifecycle. Every admitted callback receives that controller's signal.

`drainEvents(context?)` behaves as follows:

1. if a shutdown context is supplied, forward its abort reason to the event
   controller;
2. await the real `hintDrain` promise;
3. remove the shutdown-signal listener in `finally`.

If the context is already aborted, the controller is aborted immediately. The
no-context form remains supported for `stop()` and direct adapter use.

The subscriber drain checks the event signal before taking another pending hint.
An aborted drain clears that pending hint and exits. It never interrupts the
currently awaited callback or resolves before that callback settles. Event
handler failures retain their existing warning and periodic-reconciliation
fallback behavior; cooperative cancellation returns normally rather than being
logged as a handler failure.

## Router checkpoints

`RuntimeEventIntegration.handleHerdrHint` and `HerdrEventRouter.handle` accept an
optional `AbortSignal`. Existing callers without a signal preserve current
behavior.

The router returns without invalidation or consumer calls when the signal is
already aborted. Once a route starts, independent consumer promises already
launched remain part of the real callback settlement. The ordered Primary chain
checks the signal after binding reconciliation and skips transcript observation
when shutdown has expired. A coalesced follow-up route checks the signal before
starting and is discarded when aborted.

The router does not pass the signal into existing consumers in this iteration.
This avoids claiming that currently non-cancellable Herdr/SQLite operations have
stopped.

## Managed runtime wiring

The existing split lifecycle remains:

1. `herdrSocketIngress` closes admission;
2. `herdrSocketEventDrain` calls `drainEvents(context)` as a writer;
3. callback dependencies stop only after the drain settles or the shared
   shutdown loop proceeds after its deadline;
4. SQLite ownership is released only if the drain truly settled successfully.

If cancellation helps the callback settle within the final allowance, shutdown
can complete normally. If an already-started operation ignores cancellation and
remains live, shutdown returns `ownership_retained` exactly as before.

## Behavioral boundaries

This change does not:

- cancel or roll back an in-progress SQLite transaction;
- abort Herdr CLI processes or transcript reads;
- replay, retry, or synthesize an event hint;
- make socket events authoritative over fresh Herdr snapshots;
- change prompt, detached-observer, no-replay, outbox, or CardKit semantics;
- change persisted schema or configuration.

## Testing

Tests cover:

- a queued subscriber hint is not started after the event signal aborts;
- the active callback must still settle before `drainEvents()` resolves;
- an already-aborted router signal starts no consumers;
- abort after binding reconciliation skips Primary observation while independent
  work that already started still settles;
- the managed runtime passes the shared shutdown context into the drain;
- an uncooperative callback remains an unsettled writer and retains ownership.

The change must pass focused event, subscriber, shutdown, and managed-runtime
tests plus typecheck, build, architecture, documentation, public audit, and the
full Vitest suite.
