# Worker Card Single-Snapshot Design

## Goal

Make `show_worker_cards` accurately communicate its read-only behavior. Each
request returns one consolidated Worker status snapshot instead of separate Main
and Task cards that look like continuously updated canonical cards.

The canonical Worker Main Card remains the only continuously updated visible
Worker projection. This change does not restore per-turn Task Card delivery or
introduce snapshot subscriptions.

## Current Problem

`show_worker_cards` currently renders a Worker Main snapshot and a latest Task
snapshot as two ordinary `card_reply` messages. Neither reply is bound back to
`worker_main_views` or `worker_turn_cards`, so later lifecycle transitions cannot
patch them. Their visual similarity to canonical cards makes a settled snapshot
look like a stalled live card.

## User Experience

One request produces one card with the title `Worker 状态快照 · <workerName>`.
The first body section states that the card is a point-in-time, read-only snapshot
and will not update automatically. It includes the snapshot generation time and
directs the reader to the canonical Worker Main Card for live status.

The remaining body reuses the bounded Worker Main presentation: owner, Primary
pane, Worker session and runtime generations, runtime status, workspace, branch,
model, current or latest task details, progress, notice, bounded output, queue,
and recent task history. Snapshot rendering contains no task, steer, interrupt,
or new-task actions. If a canonical Worker Main message exists, the snapshot may
include the existing identity-fenced `card_target_open` action to open it.

Workers without task history still use the same single card and show `No task
history`; no second empty Task card is emitted.

## Architecture and Data Flow

```text
show_worker_cards
    -> authorize exact Primary-owned Worker name
    -> load WorkerMainProjectionSource + latest canonical WorkerMainView
    -> select a point-in-time WorkerMainView
    -> render one consolidated snapshot card
    -> enqueue one card_reply on worker-display:<requestId>
    -> Lark delivery

Worker lifecycle changes
    -> worker-session invalidation
    -> canonical Worker Main projection
    -> worker-main:<workerId>:<sessionGeneration> update
    -> does not patch the snapshot reply
```

`WorkerCardDisplayWorkflow` owns the explicit snapshot presentation.
`SqliteWorkerCardDisplayStore` continues to own authorization, idempotency, and
atomic display-request/outbox reservation. It no longer queries or renders a
separate latest `WorkerTurnCardView`.

The receipt reports one `worker-snapshot` card and retains `taskTurnId` only if
it remains useful to callers as metadata; it is not a visible-card identity. If
there is no current task, it is `null`. Existing persisted display receipts need
no migration because they are immutable audit records and are decoded as their
stored historical shape.

## Rendering Boundary

Add an explicit snapshot renderer or snapshot-specific options around the Worker
Main renderer. The snapshot banner, generated timestamp, title, subtitle, and
optional canonical-card link belong to presentation code, not the SQLite store.
The store passes the selected view and a single rendered object to the outbox.

The generated timestamp is captured once for the display reservation so retries
materialize the same payload. Lark retry behavior therefore remains idempotent
and does not make the snapshot appear newer than it is.

## Durability and Failure Behavior

The display request row and its single outbox intent are committed in the same
SQLite transaction. The existing idempotency key continues to deduplicate repeat
tool calls. A Lark retry repeats only the same snapshot delivery and never prompts
TraeX or mutates Worker state.

Failure to load an authorized Worker projection keeps the existing explicit
error. Rendering failure rolls back both the request and outbox reservation. No
canonical Worker card fields, delivery checkpoints, or invalidations are changed.

## Compatibility and Scope

This change intentionally modifies the tool receipt from two cards to one. The
MCP tool description and Feishu usage documentation must call the result a
read-only snapshot rather than imply live Worker Task Card delivery.

Legacy `renderWorkerTurnCard`, `worker_turn_cards.message_id/card_id`, page state,
and legacy outbox recovery remain untouched in this change. They support existing
historical data and can be removed only in a separate migration-backed cleanup.
No service installation, restart, deployment, or remote push is part of this
implementation.

## Verification

Focused tests must prove that:

- one display request reserves exactly one `card_reply`;
- duplicate idempotency keys reserve no additional reply;
- the card explicitly says it is a non-updating snapshot and includes one stable
  generated timestamp;
- current task details and no-task state render in the same card shape;
- snapshot cards contain no mutation actions;
- an available canonical Worker Main target is identity-fenced correctly;
- render failure rolls back the display request and outbox intent; and
- ordinary Worker acceptance still creates no per-turn visible card.

After focused tests, run `npm run typecheck`, `npm run build`, and `npm test`
because the receipt contract, store boundary, presentation, and documentation are
shared surfaces.
