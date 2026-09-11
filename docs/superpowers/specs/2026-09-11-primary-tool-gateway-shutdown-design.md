# Primary Tool Gateway Shutdown Design

## Goal

Make `PrimaryToolGateway.stop()` prove that every accepted tool handler has
settled before the runtime releases its SQLite write fence and instance lease.
Closing the Unix listener or client socket alone is not proof that server-side
workflow code stopped.

## Decision

Add an explicit admission state and an `ActiveWorkTracker` for accepted handler
Promises. `start()` opens admission only after the Unix listener is ready.
`stop()` closes admission first, closes the listener, destroys open sockets, then
awaits the stable set of handlers that were admitted before the gate closed. It
removes the socket path only after both transport and handler work settle.

The socket data callback registers the handler Promise synchronously before it
returns to the event loop. Therefore a request is either rejected/destroyed by
the closed admission gate or fully represented in the tracker. Once admission is
closed, no new tracked handler can appear behind the shutdown snapshot.

No artificial success timeout is added inside the gateway. If an accepted handler
cannot settle, `stop()` remains pending. `BridgeRuntimeShutdown` applies the shared
deadline and final allowance, then returns `ownership_retained`; it does not close
SQLite or release the lease.

## Restart and error behavior

The same gateway object may be started again after a clean stop. Admission resets
on start and the tracker is empty because clean stop awaited it. Handler failures
retain the existing structured warning and error response behavior. Destroyed
client sockets do not cancel an already accepted durable operation.

## Verification

Integration tests block an accepted messaging operation, call `stop()`, and assert
that stop remains pending after the listener and client socket close. Releasing the
operation allows stop to finish and removes the socket path. Another test exercises
runtime shutdown with a stuck handler and verifies ownership is retained. Existing
framing, connection-limit, capability, and restart tests remain green.

The final gate is focused gateway/runtime-shutdown suites, typecheck, build,
architecture checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- Cancelling an Agent operation after it may have reached the runtime.
- Changing Primary tool authorization or framing.
- Adding per-tool deadlines in this slice.
- Installing or restarting the service.
