# Abortable Wait Lifecycle Design

## Goal

Ensure repeated polling waits do not retain one abort listener per completed
timer. A long-running turn must keep constant listener and timer ownership while
remaining promptly cancellable.

## Decision

Introduce one runtime `abortableWait(milliseconds, signal)` utility and replace
the duplicate coordinator-local implementations. Each wait owns one timer and
one named abort listener. Both completion paths go through a single idempotent
cleanup function that clears the timer and removes the listener before resolving
or rejecting.

An already-aborted signal rejects before allocating a timer or registering a
listener. Abort rejection uses the existing `Error("aborted")` contract, so
callers that intentionally swallow observer cancellation do not change behavior.

## Resource invariant

For every wait invocation, after resolution or rejection:

- no timer remains live;
- no listener installed by that invocation remains on the signal;
- a later abort cannot invoke an already-completed callback;
- repeated completion signals cannot settle the Promise more than once.

## Verification

Fake-timer tests run hundreds of sequential waits over one `AbortSignal` and
assert `getEventListeners(signal, "abort")` returns zero after every completed
wait. Separate tests cover prompt abort, already-aborted input, and timer cleanup.
Existing transcript observer and prompt workflow suites verify integration.

The final gate is focused utility/coordinator tests, typecheck, build, architecture
checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- Changing polling intervals.
- Changing observer cancellation policy.
- Introducing a general scheduler or timer framework.
- Installing or restarting the service.
