# Graceful shutdown design

## Goal

The bridge must stop without allowing asynchronous event handlers, card
projection, or Lark outbox delivery to access SQLite after it has closed. A
normal PM2 restart must not log `database is not open`, and accepted outbox work
must either finish before shutdown completes or remain durably pending.

## Current failure

The process currently unsubscribes the card projector and channel publisher,
closes the health server, waits for the coordinator, and then closes SQLite.
Removing an EventEmitter listener prevents future events, but it does not cancel
an asynchronous listener that has already started.

During the observed PM2 restart, an in-flight card projection continued into the
Lark publisher after `store.close()`. Its failure handler then called
`markOutboundReplyFailed()` against the closed database and emitted
`ERR_INVALID_STATE: database is not open`.

## Design

### Lifecycle ownership

`CardProjector` and `LarkChannelPublisher` become explicitly stoppable
components. Each component tracks asynchronous work that entered through its
public event subscription. Its `stop()` method:

1. marks the component as stopping;
2. removes its event-bus subscription so no new event work can start;
3. waits for all already-started handlers to settle; and
4. for the publisher, waits for the active outbox drain to settle.

Stopping is idempotent. Calling `stop()` more than once returns the same safe
result and does not re-enable subscriptions or duplicate delivery.

The components continue to expose their direct enqueue/drain methods while the
bridge is running. After stopping begins, bus-originated events are ignored.
Already persisted outbox rows remain durable if their next retry is not due or a
delivery attempt fails normally. Shutdown does not force future retries early.

### Shutdown sequence

The application shuts down in this order:

1. mark application shutdown as started, making repeated signals no-ops;
2. stop the coordinator, which clears reconciliation, stops Lark ingress, removes
   the inbound subscription, and waits for active prompt workers;
3. stop the card projector and wait for in-flight projections;
4. stop the channel publisher and wait for in-flight event handlers and the
   current outbox drain;
5. close the HTTP health server; and
6. close SQLite last.

The projector is stopped before the publisher because a projection can enqueue a
card update. The publisher must remain available until all projectors have
settled. SQLite remains open throughout both drains.

### Error handling

Shutdown uses `try/finally` boundaries so later resources are still released if
an earlier component reports an error. Errors are logged with the component that
failed. The database is closed only after all known database-writing components
have been awaited.

The process does not suppress `ERR_INVALID_STATE`. Such an error after this
change remains actionable evidence of an untracked writer.

Startup failure uses the same shutdown sequence. A component that was created but
not fully started must still be safe to stop.

## Tests and acceptance criteria

Automated coverage must demonstrate:

1. A channel-publisher `stop()` waits for an in-flight Lark delivery and its final
   store update.
2. A card-projector `stop()` waits for an in-flight projection that enqueues a
   card update.
3. Application shutdown does not close the store while either operation is
   pending.
4. Repeated shutdown calls are idempotent.
5. Existing outbox retry, event projection, coordinator, and permission lifecycle
   tests retain their behavior.

Live validation must rebuild the application, restart only the PM2-managed
`herdr-lark-bridge`, and confirm:

- the old process logs no new `database is not open` error during shutdown;
- the replacement process is online with zero unstable restarts;
- `/health` returns `ok`;
- `/ready` returns `ready`; and
- the outbox contains no dead-letter rows.
