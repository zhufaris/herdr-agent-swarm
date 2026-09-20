# Main Card Latest Snapshot Design

## Goal

Keep a Primary Main Card within three to five seconds of meaningful activity
observed from its exact TraeX JSONL turn, even while startup recovery is
rebuilding older Answer Card projections.

The Main Card remains a compact status surface. It shows phase, progress, latest
activity, model/context/queue telemetry, and pane/worktree identity. Complete
answer content remains on the Answer Card.

## Authority and data flow

JSONL is a low-latency observation source, not a presentation authority. The
existing exact-turn transcript observer parses, bounds, redacts, and attributes
records before emitting a Bridge event. The event reducer persists the latest
Main Card projection in SQLite. After the existing 2.5-second debounce, the Main
Card workflow atomically reserves durable Gateway delivery for that projection.

```text
owned JSONL record -> safe Bridge event -> SQLite TopicView
  -> 2.5 s debounce -> latest-snapshot outbox reservation
  -> Feishu Gateway -> Main Card
```

Herdr remains authoritative for runtime identity, SQLite for the projection and
delivery intent, and the Gateway for visible delivery. Direct JSONL-to-Feishu
updates are forbidden.

## Latest-snapshot reservation

Primary Main Card `card_update` rows are replaceable snapshots. Before inserting
a newer snapshot, delete every older row in the same Gateway-scoped Main Card
lane that has never been claimed and has no attempt, provider checkpoint, or
projection key. This applies equally to `history` and `live` rows. The latest
snapshot therefore replaces a startup-recovery head instead of waiting behind
it.

If a row is currently claimed or has ever crossed the external-effect boundary,
it is immutable. Keep that row and retain at most one latest unclaimed successor.
After the claimed row settles, the successor delivers the newest state and all
intermediate snapshots remain coalesced.

The replacement reuses the earliest deleted CardKit sequence. If there is no
replaceable row, allocate one after the greatest delivered or protected pending
sequence. This preserves contiguous ordering even when many view versions are
collapsed. The outbox lane-head trigger recalculates the head within the same
SQLite transaction.

## Failure and recovery

- A transaction failure rolls back both projection and outbox replacement.
- A claimed or previously attempted delivery is never mutated or deleted.
- An uncertain delivery remains quarantined under existing recovery rules.
- A stale or locked Main Card continues through the existing rebuild path.
- Startup convergence may request a history snapshot, but a newer live snapshot
  replaces it before claim.
- Reconciliation can regenerate the latest projection after lost process-local
  events; no JSONL prompt or delivery is replayed.

## Testing

- Multiple unclaimed history/live Main Card snapshots collapse to the newest
  payload, version, work class, and one contiguous CardKit sequence.
- A claimed head remains immutable while multiple successors collapse to one.
- A previously attempted, checkpointed, or projection-keyed row is not deleted.
- Startup history followed by a live JSONL-derived event leaves no history head
  blocking the live snapshot.
- Existing strict lane ordering, claim fencing, Main Card rebuild, and Answer
  Card behavior remain unchanged.

## Scope

This change does not make JSONL a source of truth, mirror full answers into the
Main Card, weaken exact-turn ownership, reorder immutable effects, or alter
Answer Card lanes.
