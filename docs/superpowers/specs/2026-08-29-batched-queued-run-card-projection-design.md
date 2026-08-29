# Batched Queued Run Card Projection Design

## Status

Approved for implementation under the operator's standing instruction to use
the recommended design without another confirmation gate.

## Problem

When the head of an ordinary prompt queue changes, `PromptRunWorkflow` scans
every queued Run Card and publishes one `RunQueuePositionChanged` event per
changed card. The conversation projector then loads and saves each card in a
separate SQLite transaction, and schedules each Answer Card for later outbox
convergence. A queue of N prompts therefore performs O(N) event dispatches and
O(N) write transactions for one logical FIFO transition.

The queue-feedback projector already reads the same ordered queued-card snapshot
after prompt lifecycle changes. It computes wait estimates one card at a time
and calls a transactional store method once per changed card. Queue-position and
wait-estimate convergence are consequently two overlapping projection paths.

There is also a correctness symptom on acceptance. SQLite initially assigns an
ordinary prompt the correct position from queued ordinary turns only. The later
`PromptQueued` event carries a broader pending depth that includes the running
turn, and the conversation projector currently writes that value back as the
card position. With one running turn and the first queued turn, the card can
therefore show position two until a later refresh repairs it.

## Goals

1. Converge all changed queued ordinary Run Cards for one binding in one SQLite
   transaction.
2. Compute exact queue position and coarse wait feedback from one consistent
   ordered snapshot.
3. Persist each changed Run Card and its replaceable Answer Card outbox intent
   atomically.
4. Preserve per-card view versions, outbox idempotency keys, and Lark lane order.
5. Remove per-card queue-position lifecycle events from the hot path without
   changing FIFO dispatch or prompt state.

## Non-goals

- Changing prompt claim, dispatch, steering, cancellation, or no-replay rules.
- Combining cards from different bindings in one transaction.
- Sending one Lark request for multiple cards; delivery remains one durable
  outbox item per changed Answer Card.
- Removing `RunQueuePositionChanged` from the public event union in this change.
  Keeping the type avoids an unnecessary compatibility cleanup.
- Adding a new database table or schema migration.
- Reworking archive/reset cancellation into an atomic batch. That path has a
  separate quadratic event-rescan pattern and pending-create delivery concern;
  it will be designed and shipped as the next independent optimization.

## Considered approaches

### Recommended: unify queued-card projection behind one batch store operation

Extend `QueueFeedbackProjector` to derive both `queuePosition` and
`queueFeedback` for every queued ordinary Run Card. Submit all changed cards to
one store method. The store validates expected view versions, updates current
cards, and reserves any applicable outbox rows inside one transaction.

This removes duplicate scans, per-card event fan-out, and per-card transactions
while preserving durable projection semantics. It also gives restart convergence
one canonical path.

### Alternative: publish queue-position events concurrently

Publishing the existing events with `Promise.all` shortens wall-clock latency,
but SQLite remains synchronous and each event still opens a transaction. It also
increases contention and does not combine queue position with wait feedback.

### Alternative: batch only outbox reservation

Deferring several card updates into one outbox call reduces some downstream
wake-ups, but Run Cards would still be written in separate transactions and a
crash could expose newer views without all delivery intents.

## Projection architecture

`QueueFeedbackProjector` remains the only lifecycle-driven queued-card
projector. On `PromptQueued`, `TurnStarted`, `TurnCompleted`, `TurnFailed`, or
`PromptCancelled`, it serializes work per binding and loads one snapshot:

- the attached running ordinary turn's start time, if any;
- queued ordinary Run Cards ordered by prompt `created_at, rowid`; and
- the bounded completed-turn duration sample.

For each queued card at zero-based index I, the desired position is I + 1. The
projector calculates wait feedback using that same position and snapshot. It
reduces the current card first with a queue-position change when needed and then
with a queue-feedback change when needed. Cards with no semantic change are
omitted from the batch.

`PromptRunWorkflow` no longer calls `refreshQueuePositions` when a turn starts,
completes, fails, or rejects orphaned steering. Those lifecycle transitions
already publish an event handled by the projector. The workflow still awaits
event publication, so the durable queued-card convergence remains on the same
ordered control path. Scoped worker wake and claim behavior do not change.

`ConversationViewProjector` stops interpreting `PromptQueued.queueDepth` as a
Run Card queue position. The accepted Run Card already contains the authoritative
SQLite-computed position, and the batch projector converges later changes. The
event's queue depth remains available to topic-level consumers and diagnostics.

## Store contract and transaction

Replace the single-card queue-feedback projection contract with a batch-oriented
contract conceptually shaped as:

```ts
projectQueuedRunCards(input: {
  bindingId: string;
  projections: Array<{
    expectedViewVersion: number;
    view: RunCardView;
    card: object | null;
  }>;
}): {
  projected: RunCardView[];
  stalePromptIds: string[];
  outboxReserved: boolean;
};
```

The SQLite implementation opens one `BEGIN IMMEDIATE` transaction. For every
projection it reloads the current card and accepts the update only when all of
these fences hold:

- the card belongs to `bindingId`;
- the card is still in phase `queued`; and
- its `viewVersion` equals `expectedViewVersion`.

A stale item is skipped without aborting valid siblings. This is necessary
because another lifecycle projection may advance one card while the snapshot is
being reduced. Accepted items are saved in the supplied FIFO order. If an item
has an `answerMessageId` and a rendered card, the same transaction inserts a
`card_update` intent using the existing idempotency key
`run-card:update:<promptId>:answer:<viewVersion>` and lane
`answer:<promptId>`. The transaction commits once after all items. Any database
error rolls back the whole batch.

The method returns whether at least one outbox row was reserved. The projector
wakes outbound work exactly once per batch. It logs one bounded aggregate record
with candidate, projected, stale, and outbox counts; it does not log prompt text
or card payloads.

## Correctness and recovery

SQLite remains the durable authority. Process-local lifecycle events are hints,
and `QueueFeedbackProjector.converge()` plus its timer reconstruct the desired
state after restart or a lost hint. A crash before commit changes neither cards
nor outbox; a crash after commit retains both.

FIFO order still comes from queued ordinary prompt rows ordered by
`created_at, rowid`. Steering prompts are excluded by `dispatch_kind = 'turn'`.
The active turn is excluded because it is no longer queued. Batch projection
does not alter prompt rows, claim locks, binding fences, or agent state.

Per-card view versions remain monotonic because reducers increment each changed
card independently and the store applies a compare-and-swap fence. Per-card
outbox keys and lanes remain unchanged, so retries cannot duplicate a Lark
update or reorder updates for the same card.

## Testing

Focused tests must prove:

1. one lifecycle change with many queued cards calls one batch store operation;
2. exact FIFO positions and wait feedback are derived from the same snapshot;
3. unchanged cards produce no writes or outbox wake;
4. multiple changed cards commit Run Cards and their outbox intents atomically;
5. a stale card is skipped while valid siblings commit;
6. an injected database failure rolls back every card and outbox row;
7. cards without delivered Answer Card IDs update durably without an outbox row;
8. steering and non-queued cards are not projected;
9. startup convergence repairs stale durable positions without prompt replay; and
10. prompt workflow lifecycle tests no longer observe per-card queue-position
    event fan-out; and
11. one running turn plus the first queued ordinary turn remains position one
    after `PromptQueued` projection.

The affected store, projector, concurrency, steering, and restart tests must run
before typecheck and build. Because this spans workflow, persistence, and shared
runtime behavior, the full Vitest suite is required before deployment.

## Deployment and rollback

Deploy through the normal safe restart without `--force`. Verify matching build
identity, ready readiness, zero failed prompts, and normal outbox progress. No
live Lark test message is required.

Rollback restores the former per-card event path and single-card projection
method. There is no schema or durable-data rollback. Existing pending outbox
rows remain valid because their keys, kinds, payloads, and lanes do not change.
