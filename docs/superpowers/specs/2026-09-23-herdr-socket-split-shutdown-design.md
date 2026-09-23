# Herdr Socket Split Shutdown Lifecycle

## Goal

Separate Herdr socket ingress closure from write-capable event draining so the
runtime expresses the two shutdown responsibilities explicitly while preserving
SQLite ownership until every admitted event callback has settled.

## Current behavior

`HerdrSocketSubscriber.stop()` currently performs two different operations:

1. synchronously gates new work, clears timers and waiters, and destroys sockets;
2. waits for the coalesced `hintDrain`, whose callback can reconcile SQLite.

The runtime safely classifies this combined operation as a writer, but the
lifecycle ledger cannot distinguish stopping an external ingress source from
draining already admitted durable work. Failure diagnostics therefore identify
only the combined subscriber, and the interface hides the quiescence boundary.

## Considered approaches

### A. Keep the combined writer cleanup

The current implementation is safe and minimal. It does not expose whether a
shutdown delay came from closing ingress or draining an admitted callback, and
it keeps two lifecycle responsibilities behind one opaque stop operation.

### B. Split ingress closure and event drain

Add explicit `stopIngress()` and `drainEvents()` operations while keeping
`stop()` as their compatibility composition. Register the two operations as
separate lifecycle entries. This is the chosen approach because it makes the
admission gate and ownership-critical drain independently testable and
diagnosable without changing event semantics.

### C. Run the drain concurrently with dependent shutdown stages

Starting all writer cleanup concurrently could reduce shutdown latency, but a
Herdr event callback invokes binding and instance reconciliation, Primary and
Worker observation, and retired-Pane cleanup. Stopping those dependencies while
the callback runs would introduce a new race. This design deliberately retains
sequential dependency ordering.

## Subscriber interface

`HerdrSocketSubscriber` gains these public lifecycle operations:

- `stopIngress(): void` atomically marks the subscriber stopped, clears all
  reconnect/subscription timers, rejects pending RPC requests, resolves Pane
  waiters, clears subscription state, and destroys event and request sockets. It
  does not wait for socket close events or event callbacks. Once it returns,
  `receive()` and `emit()` reject new event work through the existing stopped
  gate. Repeated calls are harmless.
- `drainEvents(): Promise<void>` waits for the currently admitted coalescing
  drain. It does not admit, cancel, or replay callbacks. Repeated and concurrent
  calls wait on the same active work.
- `stop(): Promise<void>` remains available for adapter callers and tests. It
  calls `stopIngress()` and then `drainEvents()`, preserving the existing full
  shutdown contract.

Queued hints admitted before the ingress gate remain part of the active drain
and are processed before `drainEvents()` settles. Hints received after the gate
are ignored, as today.

## Managed lifecycle ordering

The managed runtime registers two ingress-stage cleanups:

- `herdrSocketIngress`, a non-writer cleanup calling `stopIngress()`;
- `herdrSocketEventDrain`, a writer cleanup calling `drainEvents()`.

The lifecycle ledger executes entries within a stage in reverse registration
order. The runtime therefore registers the drain first and ingress second,
which produces the required shutdown order:

1. close socket ingress synchronously;
2. wait for the admitted event drain;
3. stop observers, workers, projections, and health;
4. release the write fence, lease, and store only after every writer is safe.

The drain remains sequentially before its callback dependencies. This change
does not introduce concurrent component shutdown.

## Failure handling

`stopIngress()` is synchronous and establishes its stopped gate before cleanup
that could throw. Its implementation uses non-throwing timer, waiter, and socket
cleanup operations; the lifecycle wrapper retains best-effort handling for an
unexpected failure.

If `drainEvents()` fails or remains unsettled after the shared deadline and final
settlement allowance, shutdown reports `herdrSocketEventDrain` in
`unsettledWriters` and returns `ownership_retained`. It must not deactivate the
write fence, release the lease, or close SQLite. Later cleanup stages are still
attempted within the shared deadline.

## Behavioral boundaries

This change does not:

- cancel an in-flight reconciliation or add an abort signal to event callbacks;
- process socket events after the ingress gate;
- alter hint coalescing or the authoritative-snapshot convergence model;
- change SQLite schema or persisted state;
- change prompt dispatch, detached observation, no-replay, outbox, or CardKit
  behavior;
- parallelize shutdown of callback dependencies.

## Testing

At the subscriber seam, tests prove that `stopIngress()` returns while a callback
is blocked, rejects post-gate hints, and `drainEvents()` waits until all admitted
hints finish. Existing `stop()` behavior remains covered.

At the managed-runtime seam, tests prove ingress closes before drain begins, the
drain finishes before dependent components stop, and a failed or stuck drain
retains SQLite ownership under the new component name. Shutdown unit fixtures
model the same two entries and preserve normal release behavior.

The change must pass focused subscriber and shutdown tests, typecheck, build,
architecture and documentation checks, public audit, and the full Vitest suite.
