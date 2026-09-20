# Herdr Hint Shutdown Design

## Goal

Make `HerdrSocketSubscriber.stop()` wait until every Herdr hint accepted before
shutdown has finished invoking its reconciliation consumer. Socket closure alone
must not allow indirect SQLite writes to outlive ingress shutdown.

## Decision

Replace the boolean-only dispatch marker with an explicit `hintDrain` Promise.
`emit()` synchronously rejects hints after the stop gate, merges admitted hints
into the existing bounded pending slot, and starts at most one drain Promise. The
drain processes every hint admitted before the gate and owns all calls to
`onEvent`.

`stop()` closes admission first, clears reconnect/subscription timers, rejects
native RPC requests and Pane waiters, destroys the event socket, then awaits the
current hint drain. Pending admitted hints remain eligible for processing; frames
or scheduled receives after the gate are ignored.

Handler failures retain the existing containment contract: they are logged and
periodic reconciliation remains the fallback. A failed handler therefore settles
the drain rather than making socket shutdown fail.

## Verification

Tests block `onEvent`, call `stop()`, and assert stop remains pending until the
handler settles. They also enqueue a second hint behind the blocked handler and
verify both admitted hints drain before stop completes, while a post-gate frame
does not invoke the handler. Existing burst coalescing, reconnect, frame bounds,
RPC rejection, and Pane waiter tests remain green.

The final gate is the focused socket/event-router suites, typecheck, build,
architecture checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- Persisting Herdr hints as an event log.
- Cancelling reconciliation that already crossed the callback boundary.
- Changing native RPC request concurrency.
- Installing or restarting the service.
