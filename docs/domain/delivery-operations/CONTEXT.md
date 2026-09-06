# Delivery and Operations

This context defines durable user-visible delivery and the operational facts needed to run it safely.

## Language

**Delivery Intent**:
An immutable, versioned description of user-visible output reserved by the workflow transition that produced it.
_Avoid_: Card payload, send request

**Delivery Lane**:
The ordering scope within which delivery intents must be published in sequence.
_Avoid_: Queue name

**Outbox Entry**:
A durable delivery attempt record carrying idempotency, retry, and dead-letter state.
_Avoid_: Event, message

**Delivery Checkpoint**:
Durable evidence of progress through a multi-step delivery such as streamed card creation, content updates, and finish.
_Avoid_: Stream status

**Dead Letter**:
A delivery intent quarantined after its retry policy is exhausted or its durable representation is invalid.
_Avoid_: Failed message

**Instance Lease**:
The fenced right of one service process to coordinate the shared durable workflow state.
_Avoid_: Process lock
