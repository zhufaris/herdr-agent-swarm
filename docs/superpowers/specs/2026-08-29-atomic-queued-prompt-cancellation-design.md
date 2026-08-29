# Atomic Queued Prompt Cancellation Design

## Status

Approved for implementation under the operator's standing instruction to use
the recommended design without another confirmation gate.

## Problem

Archiving a binding currently lists every queued Run Card, publishes one
`PromptCancelled` event per card, and only afterward calls
`cancelQueuedPrompts`. Each event is awaited and causes the queue-feedback
projector to reload the whole binding queue. For N queued prompts this creates
quadratic read work before the authoritative prompt states change.

The store then updates prompt rows and Run Card rows in one transaction, but it
does not reserve delivery intent for the new terminal cards. A pending initial
`stream_card_create` can therefore retain its earlier queued payload, while an
already-created Answer Card has no atomic terminal `card_update` intent. The
process-local cancellation events may eventually repair delivery, but that is
not a durable crash boundary.

## Goals

1. Cancel all queued prompts for one binding and project their terminal Run
   Cards in one SQLite transaction.
2. Persist the correct Answer Card delivery intent in the same transaction.
3. Remove repeated binding-wide queue scans from per-prompt cancellation events.
4. Preserve individual cancellation events for observers and auditability.
5. Wake outbound delivery once after the batch commits.

## Non-goals

- Changing active or detached turn handling.
- Changing archive authorization, draining behavior, or pane retention.
- Folding the binding lifecycle/Main Card transition into the cancellation
  transaction. That is a separate domain transition with established behavior.
- Changing cancellation presentation from the existing failed Run Card phase.
- Introducing a new batch lifecycle event or database schema.
- Reworking pane-orphan projection, which already performs atomic terminal
  Run Card and outbox convergence.

## Considered approaches

### Recommended: store-owned cancellation projection with post-commit events

Replace the count-only store operation with a method that accepts one timestamp,
reason, root message ID, and pure Run Card renderer. It selects queued prompts
and cards, transitions prompt and card state, and reserves delivery intent in
one transaction. The workflow wakes outbound delivery once, then publishes the
returned prompt IDs as individual `PromptCancelled` events.

This matches the existing pane-orphan durability pattern and leaves event
consumers compatible while making SQLite authoritative before notification.

### Alternative: retain event-first projection and coalesce subscriber work

The queue projector could coalesce repeated events into one microtask. That
reduces scans but still exposes an event-before-state race and does not guarantee
that Run Card state and delivery intent survive a crash together.

### Alternative: add one `PromptsCancelled` batch event

A new event would reduce fan-out, but every subscriber, reducer, diagnostic, and
compatibility surface would need a new payload shape. It does not itself create
the required SQLite transaction, so it adds protocol scope without improving
durability.

## Store contract

Replace `cancelQueuedPrompts(bindingId, reason): number` with a projection-aware
contract conceptually shaped as:

```ts
cancelQueuedPromptsWithProjection(input: {
  bindingId: string;
  reason: string;
  occurredAt: string;
  rootMessageId: string | null;
  renderRunCard(view: RunCardView): object;
}): {
  cancelledPromptIds: string[];
  outboxReserved: boolean;
};
```

The implementation opens one `BEGIN IMMEDIATE` transaction and selects queued
prompts joined to their Run Cards ordered by `prompt_jobs.created_at, rowid`. It
includes ordinary and steering prompts because archive rejects all waiting work.
For every selected prompt it:

1. changes the prompt to `cancelled`, observation state to `completed`, stores
   the reason, and uses the supplied timestamp;
2. reduces the Run Card through the existing failed transition so phase, notice,
   queue position, finish time, activity time, and view version remain canonical;
3. saves the terminal Run Card; and
4. persists the applicable delivery intent described below.

The transaction commits once. Any render, Run Card, or outbox failure rolls back
every prompt, card, and delivery intent. An empty queue returns an empty ID list
and false without creating delivery work.

## Delivery intent rules

The terminal Run Card is rendered only after reduction. Delivery follows the
same durable target states used by pane-orphan projection:

- If `answerMessageId` exists and `answerCardId` is absent, enqueue a versioned
  `card_update` using `run-card:update:<promptId>:answer:<viewVersion>`.
- If neither answer ID exists, the binding has a root message ID, and the pending
  initial `stream_card_create` has no `card_id_checkpoint`, upsert it using the
  existing idempotency key `run-card:create:<promptId>:answer`. The existing
  row's payload and view version become terminal rather than creating a duplicate.
- If that pending create already has a `card_id_checkpoint`, do not modify its
  payload. The external CardKit entity already exists and retry only completes
  its message reference. The create delivery checkpoint then invokes existing
  Answer Page convergence, which reads the durable terminal Run Card and reserves
  the required terminal update once a target message/card is known.
- If an Answer CardKit target already exists, do not manufacture a direct card
  update in this store method. The existing Answer Page workflow owns CardKit
  stream/finalization and converges from the persisted terminal Run Card after
  the cancellation event or delivery checkpoint.
- If a create request was already copied by an in-flight publisher immediately
  before the transaction inspected it, the post-commit cancellation event and
  subsequent create checkpoint still converge the newly created card to the
  persisted terminal state. No prompt is replayed.

All reply lanes remain `answer:<promptId>`. Existing idempotency and stale-update
pruning behavior remains unchanged. The result's aggregate flag is true when at
least one pending outbox row is present or updated by the transaction.

## Workflow and event order

`SessionAdministrationWorkflow.archive` captures one ISO timestamp and calls the
new store method before publishing cancellation events. After commit it wakes
outbound work at most once and publishes one `PromptCancelled` event for each
returned prompt ID, using the same reason and timestamp. It then performs the
existing binding transition to draining or archived, publishes that lifecycle
event, and writes the existing audit record.

`QueueFeedbackProjector` removes `PromptCancelled` from its refresh-event set.
The authoritative cancellation transaction leaves no queued rows to reposition,
so one scan per notification has no useful work. Other lifecycle events and the
periodic convergence timer remain sufficient for normal queue feedback.

`ConversationViewProjector` continues to accept `PromptCancelled`. Because it
loads the already-terminal card and applies the same reason and timestamp, the
reducer returns the current view and schedules terminal delivery convergence
without another Run Card write. Individual events therefore remain useful to
process-local subscribers without owning durability.

## Correctness and recovery

The selection and update are fenced by `binding_id` and `state = 'queued'`. A
prompt claimed before the transaction begins is not cancelled; a prompt cannot
be claimed midway through the immediate transaction. FIFO is relevant only to
the deterministic returned event order and remains `created_at, rowid`.

Steering prompts are cancelled rather than converted or dispatched. Running and
detached prompts are untouched. The existing archive transition decides whether
the binding becomes draining or archived based on the supervised active turn.
No code path resends a TraeX prompt.

A crash before commit changes nothing. A crash after commit retains prompt
terminal state, Run Card terminal state, and delivery intent even if no
process-local event was published. Startup outbox draining and Answer Page
convergence complete visible delivery.

## Testing

Focused tests must prove:

1. ordinary and steering queued prompts cancel in FIFO order while a running
   prompt remains untouched;
2. every cancelled Run Card reaches the canonical failed shape exactly once;
3. delivered message targets receive per-card versioned `card_update` intents;
4. uncheckpointed pending initial create intents are updated in place to terminal
   payload and retain their idempotency key and lane;
5. checkpointed pending creates remain immutable and converge after their target
   reference is checkpointed; existing CardKit targets likewise rely on Answer
   Page convergence without an invalid direct update;
6. an injected outbox failure rolls back all prompt, Run Card, and outbox changes;
7. an empty or repeated batch is idempotent and reserves no new work;
8. archive commits cancellation before observers receive events, publishes one
   event per cancelled prompt in FIFO order, and wakes outbound work once;
9. a cancellation event no longer triggers a queue-feedback binding scan; and
10. active-turn archive remains draining while idle archive remains archived.

Run the affected SQLite, session administration/router, queue projector, Answer
Page, concurrency, and restart tests before typecheck and build. Because the
change crosses workflow, persistence, and outbox behavior, run the full Vitest
suite before deployment.

## Deployment and rollback

Deploy through the normal safe restart without `--force`. Verify matching build
identity, ready readiness, no new failed prompts, and no stalled outbox lanes.
Do not synthesize a live Lark message.

Rollback restores the count-only cancellation method and event-first workflow.
No schema or data migration is involved. Terminal outbox rows produced by the
new method use existing kinds, keys, and lanes and remain valid after rollback.
