# Card Update Deduplication Design

## Goal

Reduce redundant run-card state transitions, SQLite writes, and Lark card
patches while preserving useful live progress. Ordinary visible changes may be
delayed by up to two seconds. Blocked, completed, and failed states remain
immediate.

## Current problem

`HerdrCliAdapter` observes the active pane every 250 milliseconds. During a
turn, `SyncCoordinator` currently publishes `AgentStateChanged(working)` for
every observation, even when the state has not changed. The run-card reducer
then treats each repeated `started` transition as a new view, increments
`view_version`, writes SQLite, and schedules another card update. The scheduler
coalesces outbound work, but it acts after these redundant events and writes
have already happened.

In the observed production run, a roughly 70-second request reached view
version 504 and delivered 33 card patches. The visible update scheduler was
working, but upstream semantic deduplication was missing.

## Design

### Producer-side state deduplication

`SyncCoordinator` publishes `AgentStateChanged` from a turn observation only
when the observed state differs from the last state recorded for that pane. It
still updates the binding when the state changes and preserves the existing
final-state comparison after `runPrompt` returns. Output observations remain
independent: new answer text or progress events are published even when agent
state stays `working`.

This removes redundant events at their source and prevents unnecessary event
bus, store, and projector work.

### Reducer-side semantic no-ops

The run-card reducer treats repeated lifecycle transitions as no-ops when they
do not change user-visible state. In particular:

- `started` is a no-op for a card already running with the same lifecycle
  values;
- `blocked` is a no-op when the card is already blocked with the same notice;
- queue-position changes are no-ops when the position is unchanged;
- output changes remain governed by existing answer/progress deduplication.

The reducer returns the original object for a no-op. `CardProjector` already
uses object identity to avoid saving and scheduling unchanged views, so this
layer protects the system from duplicate events produced by any current or
future caller.

### Two-second ordinary update cadence

The per-prompt `CardUpdateScheduler` interval changes from 800 milliseconds to
2,000 milliseconds. Ordinary running-output changes are coalesced to the newest
desired version during that window. Blocked, completed, and failed phases
continue to flush immediately. Only one patch per prompt may be in flight, and
a newer desired version is sent after the current patch settles.

No database schema or configuration change is required. The interval remains an
internal default until there is evidence that operators need to tune it.

## Failure and restart behavior

The durable outbox remains authoritative for delivery and retry. Pending older
card updates are still superseded by newer view versions. Restart recovery still
sends the newest undelivered snapshot. Deduplication never suppresses terminal
or blocked transitions, and it does not alter prompt execution or replay rules.

## Verification

Automated tests will prove that:

1. repeated `working` observations emit one state transition while distinct
   output observations continue to flow;
2. repeated `started`, `blocked`, and unchanged queue-position changes return
   the same run-card object without incrementing `view_version`;
3. ordinary scheduler changes coalesce for 1,999 milliseconds and flush at
   2,000 milliseconds;
4. blocked, completed, and failed updates still flush immediately;
5. changes arriving during an in-flight patch still produce a subsequent newest
   patch;
6. the full test suite, typecheck, and build pass.

After deployment, one real channel request will be inspected without injecting
extra messages. Success means the request enters `running`, output remains live
at the two-second cadence, terminal state is delivered immediately, and view
version growth corresponds to semantic output/state changes rather than every
250-millisecond poll.
