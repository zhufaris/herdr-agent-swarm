# P0 Delivery Pressure Reduction Design

## Goal

Reduce Lark CardKit and SQLite write pressure without delaying terminal workflow
states or weakening durable delivery.

## Streaming and primary-card policy

Running Answer Cards emit a full CardKit snapshot when either 1,500 ms have
elapsed since the latest eligible change or the visible Answer content has grown
by at least 400 characters since the previous emitted snapshot. Blocked,
completed, failed, and continuation transitions bypass this delay.

The topic primary card uses an independent per-binding coalescer. Ordinary
running output updates are emitted at most once every 3,000 ms. Binding and
turn state transitions, blocked state, and terminal outcomes bypass the delay.

The durable outbox remains the only delivery authority. Coalescing happens
before an intent is written; its existing pending-row coalescing remains a
second safety layer.

## Outbox retention

At startup and then once per hour, the bridge deletes old `delivered` or
`dismissed` outbound rows in batches. The default is 500 rows per SQLite
transaction and at most 20 batches per maintenance run; full batches yield to
the event loop before the next transaction. It never deletes `pending` or
`dead_letter` rows, never performs VACUUM, and stops before another batch during
shutdown. The current projections preserve the state needed for restart
convergence.

## Verification

Tests cover timer and size-triggered stream emission, immediate terminal/topic
delivery, bounded retention, and preservation of pending and dead-letter rows.
