# Worker Queue Capacity Rejection Design

## Goal

Prevent one Worker-directed message rejected by a full queue from becoming a
poison record at the head of the global durable inbound FIFO. Capacity rejection
must give the user durable feedback and allow later unrelated messages to run.

## Decision

Introduce a domain error for Worker turn capacity exhaustion. The Worker turn
store throws that type when the generation-fenced queue has reached its configured
limit. Routing recognizes the typed error, persists the normal request-rejected
card through the durable outbox, and then raises
`PermanentInboundMessageRejection`.

The inbound dispatcher already treats that marker as a terminally handled
message: it marks the inbound row accepted and continues the FIFO in the same
drain pass. Unknown failures remain retryable and continue to stop the pass.

## Failure ordering

The rejection card must be durably reserved before the inbound message becomes
terminal. If card reservation fails, routing propagates that failure instead of
the permanent marker, so the dispatcher releases the inbound claim for retry.
This prevents silent loss of user feedback while avoiding repeated Worker turn
creation.

The typed capacity error contains no user content or mutable queue count. Its
stable user-facing message is `Target instance queue is full`. Other instance
state and ownership errors retain their current classification.

## Verification

Tests cover a full Worker queue followed by an unrelated durable inbound message.
The capacity-rejected row becomes terminal exactly once, a rejection card is
reserved, and the later message is processed without waiting for retry backoff.
Additional tests prove that rejection-card persistence failure remains retryable
and an unrelated transient exception still blocks the FIFO.

The final gate is focused routing/dispatcher/store tests, typecheck, build,
architecture checks, the complete Vitest suite, and `git diff --check`.

## Non-goals

- Changing the configured queue depth or Worker scheduling order.
- Dropping or reordering unknown transient failures.
- Treating all capacity-like error strings as permanent.
- Installing or restarting the service.
