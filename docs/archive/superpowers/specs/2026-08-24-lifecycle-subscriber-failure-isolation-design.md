# Lifecycle Subscriber Failure Isolation

## Status

Approved for implementation. This is the first runtime-reliability hardening
change after the durable workflow module migration.

## Reader and outcome

This document is for maintainers changing lifecycle notification, projection,
or health reporting. After reading it, they should be able to implement and
verify subscriber failure isolation without changing durable workflow truth,
delivery ordering, or readiness semantics.

## Problem

Lifecycle notifications are process-local projection signals. SQLite already
contains the authoritative workflow state and recovery checkpoints before a
terminal notification is published. However, the current event dispatcher waits
for all subscribers with fail-fast promise aggregation. A projector exception can
therefore escape back into the workflow that has already committed its result.

That coupling can misclassify a projection failure as a TraeX execution or
observation failure. In particular, a completed prompt must not become failed or
detached merely because a process-local subscriber could not update a view.

## Decision

Lifecycle subscriber failures are fully isolated from publishers and exposed as
process-local diagnostics. Publishing still waits until every subscriber has
settled, preserving the existing ordering and backpressure model, but it always
resolves after a valid event has been offered to the current subscribers.

The event dispatcher records a structured, redacted error for each failed
subscriber and updates an in-memory diagnostic snapshot containing:

- cumulative subscriber failure count since process start;
- timestamp of the most recent failure;
- stable name of the most recently failed subscriber.

The status endpoint includes this snapshot. Historical failures do not make the
process unready: SQLite and startup convergence remain responsible for durable
repair, while readiness continues to describe whether the process can currently
serve work. Diagnostics reset when the process restarts.

## Interface

Subscriber registration includes a stable operational name. The interface is
conceptually:

```ts
interface LifecycleEventSubscriber {
  onBridgeEvent(name: string, listener: BridgeEventListener): () => void;
}

interface LifecycleEventDiagnostics {
  snapshot(): {
    subscriberFailures: number;
    lastFailureAt: string | null;
    lastFailedSubscriber: string | null;
  };
}
```

The production conversation projector registers as
`conversation-view-projector`. Tests and future subscribers must also provide a
stable name; function names and generated identifiers are not used for
operational reporting.

The dispatcher receives a logger through construction. This keeps logging and
diagnostic ownership inside the module that performs isolation rather than
requiring every publisher to understand subscriber failures.

## Event flow and failure semantics

For each publication, the dispatcher takes a snapshot of the registered
subscribers, invokes all of them, and waits for all results to settle. For every
rejection it:

1. increments the failure counter;
2. records the current timestamp and subscriber name;
3. logs a redacted structured error with event ID, event type, binding ID, and
   subscriber name;
4. continues processing the remaining results;
5. resolves the publication without throwing to the workflow.

A synchronous throw from a subscriber has the same semantics as a rejected
promise. One subscriber cannot prevent another subscriber from receiving the
same event. Unsubscribing affects later publications, not the subscriber snapshot
already being processed.

This change does not persist or retry the notification itself. If a projection
is missing, normal durable state, startup view convergence, and later lifecycle
activity provide convergence. It also does not turn the event bus into a durable
event store.

## Health and status

The health server receives only the diagnostic snapshot interface. `/status`
adds a `lifecycleEvents` object with the three fields above. `/health` remains a
process-liveness response. `/ready` remains based on current database, project,
Lark, lease, and Herdr availability and is not degraded by historical subscriber
failures.

No event payload, prompt text, stack trace, or credential-bearing error object is
returned by the endpoint. Detailed errors remain in redacted structured logs.

## Non-goals

- Persisting lifecycle subscriber failures in SQLite.
- Replaying process-local lifecycle notifications.
- Introducing Event Sourcing or a durable event broker.
- Changing projection ordering, concurrency, or backpressure.
- Changing durable workflow transitions or outbox delivery behavior.
- Adding a readiness failure threshold or automated restart policy.

## Verification

Focused dispatcher tests must prove that:

- a synchronous subscriber throw does not reject `publish`;
- an asynchronous subscriber rejection does not reject `publish`;
- another subscriber still receives the event;
- each rejected subscriber increments the diagnostic count and updates the last
  failure fields;
- structured logs identify the event and named subscriber without exposing the
  event payload.

Health tests must prove that `/status` includes the bounded diagnostic snapshot
and `/ready` remains unaffected by a historical failure.

An integration regression test must commit a terminal prompt result while the
conversation projector fails, then prove the prompt remains completed and is not
marked detached or failed. The complete suite, TypeScript typecheck, production
build, and diff check remain release gates.

## Delivery

Implement this as one focused code commit after this design commit. Do not restart
or deploy the managed bridge as part of the change.
