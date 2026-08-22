# High-Reliability Concurrency Design

## Goal

Remove four high-risk concurrency failure modes without reducing concurrency
between independent pane/thread bindings:

- overlapping reconciliation passes;
- out-of-order projection of events for the same binding;
- concurrent inbound queue consumers;
- stale-instance writes after the database lease has been lost.

The existing guarantees remain unchanged: prompts execute one at a time per
binding, `/herdr close` does not terminate Herdr or TraeX, uncertain running
work is not replayed automatically, and shutdown cancellation only stops the
Bridge-side waiter.

## Architecture

### Reconciliation is single-flight

`SyncCoordinator.reconcile()` owns one nullable reconciliation promise. If a
manual call or timer tick arrives while that promise is active, it awaits the
same promise instead of starting another pass. The promise is cleared only by
the owning invocation's `finally` block.

This replaces the current set of independently active reconciliation promises.
The timer remains non-blocking, and shutdown awaits the single active pass. A
slow pass may coalesce multiple ticks into one pass; it must not build an
unbounded backlog of delayed passes.

### Inbound acceptance has one durable consumer

`handleMessage()` continues to persist each Lark event before processing it. It
then invokes a single-flight inbound drain. Concurrent callbacks await the same
drain rather than starting additional claim loops.

The drain claims durable rows in creation order. A failure releases that row
back to `received` and ends the current drain, preserving retry semantics. A
message inserted just as a drain completes must not become stranded: the owner
performs a final durable queue check before relinquishing ownership, or the
next caller becomes the owner.

This design serializes acceptance globally because the bridge serves one
configured Lark chat and command ordering in that chat is observable. Prompt
execution remains concurrent across bindings after acceptance.

### Event projection is ordered per binding

`CardProjector` maintains a promise tail per `bindingId`. Each event appends its
projection work to that binding's tail. Different bindings use independent
tails and can progress concurrently; events for one binding execute in publish
order.

A failed projection must reject the publisher that submitted that event, while
the tail catches the failure internally so later events can still run. Tail
entries are removed only when the same promise remains current, preventing an
older completion from deleting a newer tail. `stop()` unsubscribes first, stops
the update scheduler, and awaits all current tails.

Card delivery remains durable through the existing outbox. The ordering rule
applies to view reduction and outbox enqueueing, not to remote Lark latency.
Existing view versions and stale-pending-update compaction remain the final
delivery-order defense.

### The lease becomes a write fence

The SQLite store gains an optional active write-fence identity consisting of
`ownerId` and `fencingToken`. The runtime activates it immediately after lease
acquisition and before starting publishers, projectors, health checks, or the
coordinator.

Every application-state write path verifies in the same SQLite transaction
that `instance_lease` still contains the active owner and token and that the
lease has not expired. The verification and mutation therefore commit
atomically relative to lease takeover. If validation fails, the mutation is
rolled back and throws a typed stale-lease error.

Lease acquisition, renewal, release, schema migration, and store close are
lease-management operations and are not gated by the application write fence.
Read-only methods remain available so health reporting and shutdown diagnostics
can explain the failure. The fence is deactivated only after application work
has stopped and immediately before normal lease release.

For single-process tests and explicit store-only utilities, fencing is opt-in.
Production wiring always enables it. This keeps the adapter reusable while
making the production invariant explicit and testable.

## Interfaces

The store interface adds two narrow methods:

```ts
activateWriteFence(ownerId: string, fencingToken: number): void
deactivateWriteFence(): void
```

`InstanceLeaseController` exposes the acquired identity only through a method
that fails unless the lease is currently held:

```ts
writeFence(): { ownerId: string; fencingToken: number }
```

Callers do not pass tokens into each repository operation. That would enlarge
the entire store interface and invite missed call sites. The concrete store
owns enforcement once the runtime activates the fence.

## Failure Semantics

- A concurrent reconciliation call joins the active pass. If that pass fails,
  all joiners observe the same failure; the next tick can start a fresh pass.
- An inbound handler failure returns its row to `received`. The single drain
  stops so a later retry does not skip ordering ahead of the failed message.
- A projection failure rejects the associated event publication but does not
  poison the binding's future event tail.
- A fenced write after lease loss throws `StaleInstanceLeaseError`. The runtime's
  existing lease-loss callback initiates shutdown; no application mutation from
  that stale process is allowed to commit.
- Shutdown does not wait for hypothetical queued timer ticks. It waits only for
  the active reconciliation, inbound drain, binding workers, steering workers,
  projector tails, and publisher work already in flight.

## Testing

Add focused regression tests that prove:

1. two concurrent `reconcile()` calls execute one Herdr workspace scan;
2. a timer tick during a slow reconciliation does not create another pass;
3. concurrent `handleMessage()` calls use one consumer and preserve durable
   acceptance order;
4. delayed processing of an older event cannot overwrite a newer same-binding
   projection, while different bindings may still project concurrently;
5. after lease takeover, the old store cannot mutate bindings, prompts, views,
   inbound rows, outbox rows, or audit rows;
6. the new owner can write and the old owner can still close cleanly;
7. normal shutdown deactivates the fence only after application writers stop.

Run the full unit/integration suite, typecheck, build, and `git diff --check`.
Deployment verification must include a bounded PM2 restart, `/ready`, `/status`,
lease ownership, Lark readiness, and confirmation that no running prompt was
silently replayed.

## Scope Boundaries

This change does not redesign cards, alter command syntax, add multi-instance
active/active execution, terminate Herdr panes, or replay uncertain work. It
also does not modify the current live-message-card work in progress or any
runtime data under `var/`.
