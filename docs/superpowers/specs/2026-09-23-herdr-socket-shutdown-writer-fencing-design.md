# Herdr Socket Shutdown Writer Fencing

## Goal

Prevent shutdown from releasing the SQLite write fence, instance lease, or
store while a Herdr socket event callback may still be writing durable state.
The change must preserve the existing ingress-first shutdown order and the
subscriber's event coalescing and reconciliation behavior.

## Current problem

`HerdrSocketSubscriber.stop()` closes socket ingress, rejects pending socket
requests, and then awaits `hintDrain`. The drain runs the configured `onEvent`
callback, which can trigger reconciliation and write SQLite projections. The
managed runtime currently registers this cleanup as a `non-writer`.

`BridgeRuntimeShutdown` retains SQLite ownership only when a cleanup classified
as a `writer` fails or remains unsettled after the shared shutdown deadline and
final settlement allowance. Consequently, a failed or stuck subscriber drain
can be ignored by the ownership safety decision, allowing the runtime to
deactivate the write fence, release the lease, and close the store while the
callback is still live.

## Considered approaches

### A. Classify the existing subscriber cleanup as a writer

Keep the subscriber in the `ingress` stage but register it as a `writer`. Its
existing `stop()` promise then participates in the shutdown writer settlement
check. This is the chosen approach because the current promise already covers
the write-capable drain and the lifecycle framework already implements the
required ownership-retention semantics.

### B. Split ingress closure and event-drain cleanup

Expose separate `stopIngress()` and `drainEvents()` methods and register only the
drain as a writer. This would describe the two responsibilities more precisely,
but it expands the public lifecycle API and introduces ordering states without
improving the safety guarantee needed here.

### C. Make event callbacks abort-aware

Pass the shared shutdown signal into `onEvent` and require reconciliation to
cancel promptly. This could reduce shutdown latency, but cancellation at the
durability boundary requires a separate design for transaction completion and
effect certainty. It is not required to prevent premature ownership release.

## Chosen design

The managed runtime registers `herdrSocketSubscriber` as an ingress-stage
`writer`. The shutdown order remains unchanged: socket ingress stops before
observers, workers, projections, and health.

The subscriber's current `stop()` contract remains authoritative:

1. prevent reconnect and new event processing;
2. clear timers and reject pending socket requests;
3. destroy the active socket;
4. await the current coalesced `hintDrain`.

Because the cleanup is write-capable, `BridgeRuntimeShutdown` tracks that entire
promise. A successful stop permits normal shutdown. A thrown stop or a drain
that remains unsettled after the shared deadline produces
`ownership_retained`; the runtime does not deactivate the write fence, release
the lease, or close the store. The returned `unsettledWriters` list includes
`herdrSocketSubscriber` so operators can identify the unsafe component.

No lifecycle stage, deadline, or shutdown result shape changes. No additional
state is persisted.

## Behavioral boundaries

This change does not:

- abort or replay an in-flight event callback;
- alter event coalescing, socket subscriptions, or reconnect behavior;
- change snapshot reconciliation or make socket events authoritative;
- change prompt dispatch, detached observation, or no-replay semantics;
- change durable outbox delivery or CardKit rendering;
- add configuration or modify the SQLite schema.

If faster cancellation of event reconciliation is later required, it needs a
separate design that proves a callback cannot continue writing after reporting
settlement.

## Failure handling

- A subscriber stop failure is a writer failure. Shutdown continues attempting
  later cleanup stages but retains SQLite ownership at the end.
- A subscriber drain that exceeds the shared deadline receives the same bounded
  final settlement allowance as other writers. If it remains live, shutdown
  returns `ownership_retained`.
- A subscriber that settles during the allowance is safe to release alongside
  the other settled writers.
- Non-writer failures retain their existing best-effort behavior.

## Testing

Update the shutdown fixture to model the production classification and add
focused regression coverage for both unsafe cases:

- a failed subscriber stop returns `ownership_retained` and does not call fence,
  lease, or store cleanup;
- a stuck subscriber drain exceeds the deadline, appears in
  `unsettledWriters`, and retains SQLite ownership;
- a normally settled subscriber still stops first and permits normal ownership
  release.

The implementation must pass the focused shutdown and managed-runtime tests,
TypeScript checking, build, and the full Vitest suite.
