<!-- spec-coder:artifact-v1 spec -->

# Core Lane Expiry Bootstrap

This is a follow-up to Core checkpoint identity recovery. It handles a newly
computed session lane that has no checkpoint while the verified live Core ring
has already expired its `start` cursor. Historical lanes are not adopted across
owners merely because their ring and session strings match.

## Problem Statement

After the active session-lane identity changed, `wV:pN` has a current lane with
no checkpoint while a historical lane belongs to a stopped Worker. The live
ring is in a later epoch and no longer retains `start`. The current reader
calls checkpoint rebase without a row, receives `stale_rebase`, and retries
forever. Copying the Worker lane into the current Binding would mix ownership.

## Solution

When a v2 ring has a typed `cursor_expired` response with a `resume_cursor`,
the current lane has no checkpoint, and the ring identity is already verified,
atomically bootstrap the current lane checkpoint at the typed resume cursor and
record the existing `cursor_expired` projection gap. Then continue through the
ordinary inbox path. Historical lanes remain untouched and are never adopted
across owners.

## User Stories

### SCN-1: Bootstrap a new lane after typed expiry

When the current lane has no checkpoint and Core returns a typed expiry with a
resume cursor, one transaction creates the current checkpoint, records the
cursor-expired boundary, and the reader continues from the resume cursor.

References: INV-1, INV-2, ARCH-1

### SCN-2: Preserve historical lanes and ownership boundaries

Historical checkpoints and lane items are not copied into a current lane based
only on ring/session identity. The current lane bootstrap starts a new lane and
does not replay historical Worker-owned events into a Binding-owned projection.

References: INV-2, INV-3, ARCH-1

### SCN-3: Reject races and malformed bootstrap state

If a checkpoint appears while bootstrap is racing, a current lane item already
exists, or the typed resume cursor is absent, bootstrap fails closed and does
not advance a checkpoint or create a duplicate gap.

References: INV-1, INV-3

### INV-1: Bootstrap is identity-fenced

The new checkpoint must use the currently opened ring ID, epoch, agent kind, and
session ID. A concurrent checkpoint winner prevents a second bootstrap.

### INV-2: Only typed Core resume evidence advances a new lane

The current lane advances from `resume_cursor` supplied by Core after a
verified `cursor_expired` response. No opaque or invented cursor is accepted.

### INV-3: Historical ownership is preserved

Bootstrap does not move, copy, or reinterpret historical lane items. Existing
Core events remain durable evidence in their original lane and owner context.

### ARCH-1: SQLite owns the atomic bootstrap

The domain-owned Core inbox port exposes a named bootstrap operation. SQLite
atomically inserts the checkpoint and projection-gap evidence; the reader only
coordinates verified ring evidence and the next read.

## Implementation Decisions

The affected bounded context is Canonical Core Session Ingestion. The operation
adds no table or migration. It uses the current `core_event_lane_checkpoints`
and `projection_gaps` tables and refuses a bootstrap when the current lane is
already represented by checkpoint or lane items.

The reader calls bootstrap only for v2 typed expiry when its initial checkpoint
is absent. Existing epoch-transition, same-epoch expiry, stale-rebase, and
no-replay rules remain unchanged for lanes with durable checkpoints.

## Testing Decisions

Test the public `HerdrEventsReader.ingestCurrentSession` seam with a fresh lane
whose live ring starts after the retained window. Assert checkpoint/gap creation,
resume from Core's cursor, no historical-lane copy, and idempotent race/missing
resume rejection through the Core inbox store seam.

Required checks are focused Core ingestion/inbox tests, architecture/docs audit,
typecheck, build, and the full Vitest suite.

## Out of Scope

- Migrating or deleting historical Worker lanes.
- Cross-owner checkpoint adoption based only on shared ring/session strings.
- Direct production SQLite edits, replaying Agent Input, Feishu/card changes,
  or Herdr Core protocol changes.
- Automatically recovering untyped `invalid_cursor` responses.

## Further Notes

Live evidence for `wV:pN` shows the current computed lane has no checkpoint,
while a historical lane with the same ring/session belongs to stopped Worker
`b9d949b5-55a4-4891-b005-090c950d1a91`. The live ring is stable at epoch 13 with
an earliest cursor around 3617, while the historical checkpoint is epoch 1 at
cursor 684.
