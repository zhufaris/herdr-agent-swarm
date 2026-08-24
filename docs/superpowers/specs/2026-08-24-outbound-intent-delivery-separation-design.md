# Outbound Intent and Delivery Separation

## Status

Approved for implementation. This is the second runtime-reliability hardening
change after the durable workflow module migration.

## Reader and outcome

This document is for maintainers changing Lark delivery, workflow publication,
or prompt dispatch gates. After reading it, they should be able to separate
durable outbound intent from network delivery without allowing a prompt to reach
TraeX before its initial Answer Card is visible.

## Problem

The current Lark outbox dispatcher implements both the outbound-intent interface
and the delivery worker. Every `enqueue` operation writes an outbox row and then
waits for a drain. Several workflows also invoke `drain` explicitly. As a result,
Lark network latency and retries leak into ingress, projection, reconciliation,
and workflow interfaces even though SQLite already contains durable delivery
intent.

This coupling makes the outbound module shallow: callers must understand both
durable intent and delivery scheduling. It also makes a slow Lark request delay
the acceptance path unnecessarily.

## Decision

Separate outbound work into two modules behind distinct interfaces:

- `OutboundIntentWriter` implements `OutboundIntentPort`. It validates and
  persists an outbox row, publishes a best-effort outbound-work hint, and returns
  without waiting for Lark.
- `LarkOutboxDispatcher` implements `OutboxDispatcherControl`. It subscribes to
  outbound-work hints, claims eligible durable lane heads, performs bounded Lark
  requests, records delivery checkpoints, schedules retries, and handles
  shutdown.

Both modules use the same SQLite store adapter, but only the dispatcher talks to
the Lark port. The composition root constructs and connects them.

## Interfaces

Outbound intent retains the existing card-oriented methods. Their promise now
means only that durable intent has been recorded:

```ts
interface OutboundIntentPort {
  enqueueCard(...): Promise<void>;
  enqueueCardUpdate(...): Promise<void>;
  enqueueRunCardUpdate(...): Promise<void>;
  enqueueStreamContent(...): Promise<void>;
  enqueueStreamCardCreate(...): Promise<void>;
  enqueueStreamFinish(...): Promise<void>;
}
```

Continuation rendering consumes a delivery checkpoint through a separate narrow
interface owned by the dispatcher:

```ts
interface OutboundCheckpointSubscriber {
  onStreamCardCreated(listener): () => void;
}
```

The conversation projector depends on both `OutboundIntentPort` and
`OutboundCheckpointSubscriber`. Moving continuation state to a separate durable
table is out of scope.

The new best-effort notifier carries no card or prompt content:

```ts
interface OutboundWorkNotifier {
  subscribe(listener: () => void | Promise<void>): () => void;
  wake(): void;
}
```

`OutboxDispatcherControl` remains the operator/runtime interface:

```ts
interface OutboxDispatcherControl {
  start(): () => void;
  stop(): Promise<void>;
  requestScan(force?: boolean): Promise<void>;
}
```

Normal workflows do not receive this control interface. `requestScan` is for
runtime startup and explicit recovery or test control; ordinary work uses the
notifier. Explicit dead-letter retry updates SQLite and invokes an outbound wake
through an operations-specific capability; it does not synchronously drain
delivery work.

## Durable-before-wake flow

Every outbound producer follows this order:

1. Validate the target and serialize the bounded payload.
2. Commit or idempotently confirm the outbox row in SQLite.
3. Publish an `OutboundWorkNotifier` wake-up.
4. Return to the caller without waiting for Lark.

The notifier is not durable and carries no authoritative work description. A
wake may be duplicated, reordered, or lost. The dispatcher always reloads lane
heads from SQLite and the store remains the source of truth.

The dispatcher scans pending work when it starts. It also owns one unreferenced
safety timer that periodically checks for eligible rows even when no wake was
received. Existing per-row retry scheduling remains authoritative for
`next_attempt_at`; the safety scan is only a convergence backstop and does not
bypass retry eligibility.

## Prompt dispatch gate

Initial prompt acceptance atomically writes the prompt, run-card projection, and
Answer Card outbox intent. That transaction does not make the prompt
dispatchable. `claimNextDispatchablePrompt` continues to require the Answer Card
delivery checkpoint.

After the dispatcher delivers the initial Answer Card and commits its message and
CardKit identifiers, it publishes a `PromptWorkScheduler` hint. The prompt worker
then reloads SQLite and atomically claims eligible work. Therefore:

- slow or failed Answer delivery delays TraeX execution without blocking Lark
  ingress;
- a lost prompt wake is repaired by startup or periodic reconciliation;
- duplicate outbound or prompt wakes cannot duplicate the TraeX prompt;
- delivery retries never re-run workflow acceptance.

## Concurrency and delivery ordering

The existing persisted `lane_key`, immutable delivery order, bounded concurrency,
retry timing, CardKit checkpoints, and dead-letter semantics are unchanged. A
single coalesced drain runs at a time. Wake-ups only request another scan and do
not identify or reserve a row.

If work is enqueued while a drain is finishing, the notifier must retain a
pending wake so the dispatcher scans again after the current drain. This avoids a
lost-edge race without turning notifications into a queue.

## Startup and shutdown

At startup, the composition root starts the dispatcher before workflows can
accept new Lark input. `start` performs an initial SQLite scan, so pending work
from a previous process does not require a new notification.

At shutdown, the dispatcher unsubscribes from outbound wakes, cancels retry and
safety timers, rejects no already-persisted intent, and waits for active bounded
delivery calls. Rows not delivered remain pending for the next process.

## Error handling

An enqueue failure is a persistence failure and is returned to the workflow. A
Lark delivery failure occurs after enqueue has returned; the dispatcher records
retry or dead-letter state and emits structured logs. It does not reject the
original workflow call.

Permanent target-validation failures still move directly to dead letter.
Transient transport failures retain exponential backoff and `Retry-After`
handling. No new payload data is added to logs or health output.

## Non-goals

- Introducing Kafka, Redis, or another external queue.
- Changing SQLite as the durable delivery authority.
- Changing outbox lane ordering, retry limits, or CardKit idempotency keys.
- Removing the Answer Card delivery gate before TraeX dispatch.
- Making notification delivery durable.
- Changing Lark commands, cards, or user-visible text.

## Verification

Tests must prove that:

- a blocked Lark request does not block `OutboundIntentPort.enqueue*`;
- a blocked Lark request does not block inbound acceptance or lifecycle
  projection once intent is durable;
- an initial Answer Card must be delivered before its prompt can run;
- the delivery checkpoint wakes prompt work without allowing duplicate dispatch;
- duplicate and missing outbound wakes are safe;
- dispatcher startup drains rows persisted by a previous process;
- a safety scan eventually discovers pending rows after a lost wake;
- shutdown ignores later wake-ups and waits for existing bounded calls;
- explicit dead-letter retry schedules work without synchronously draining it.

Focused outbox, concurrency, projection, operations, and shutdown tests run before
the complete suite, TypeScript typecheck, production build, and diff check.

## Delivery

Implement this as a focused sequence: introduce the notifier and writer, move
delivery ownership into the dispatcher, remove workflow `drain` dependencies,
then add lost-wake and dispatch-gate regression coverage. Do not restart or
deploy the managed bridge as part of this change.
