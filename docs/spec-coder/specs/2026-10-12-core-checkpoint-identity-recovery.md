<!-- spec-coder:artifact-v1 spec -->

# Core Checkpoint Identity Recovery

This is a scoped follow-up to the approved Core session-ring epoch-transition
recovery. It addresses the production case where an expired-cursor rebase loses
its SQLite compare-and-swap fence after another recovery transaction has
already advanced the durable checkpoint.

## Problem Statement

`HerdrEventsReader` currently treats every `stale_rebase` result from an
expired-cursor recovery as an identity failure. A competing reader can already
have committed a compatible checkpoint, so the loser retries indefinitely even
though durable progress exists. The reader must distinguish a compatible
durable winner from a real source/session/epoch identity mismatch without
guessing or overwriting checkpoint state.

## Solution

After an expired-cursor rebase returns either `rebased` or `stale_rebase`, the
reader reloads the durable checkpoint. It validates the checkpoint against the
currently attached ring source, epoch, agent kind, and session. A stale-rebase
loser may continue only when the durable checkpoint is identity-compatible and
its read cursor differs from the expired cursor. The reader resumes from that
durable cursor and never applies the losing response's resume/latest cursor.
Missing, unchanged, or identity-incompatible durable state remains fail-closed
and is retried by the existing supervisor.

## User Stories

### SCN-1: A competing expired-cursor recovery converges

When another transaction has already committed a same-identity rebase, the
losing reader reloads that checkpoint, reads from the winner's durable cursor,
and completes the retained-window ingestion without replaying an input.

References: INV-1, INV-2, ARCH-1

### SCN-2: A stale rebase cannot cross an identity boundary

When the reloaded checkpoint has a different source, epoch, agent, session, or
no checkpoint, the reader fails closed before reading from that state.

References: INV-1, INV-3, ARCH-1

### SCN-3: An unchanged stale rebase cannot loop on the same cursor

When `stale_rebase` is returned but the durable read cursor is still the
expired cursor, the reader fails closed rather than rereading the same expired
position or declaring progress.

References: INV-2, INV-3

### INV-1: Durable checkpoint identity is authoritative

Only a durable checkpoint whose source ID, source epoch, agent kind, and
session ID match the currently attached Core ring may be adopted.

### INV-2: A reader resumes only from committed durable progress

After a rebase race, the reader uses the reloaded durable read cursor and
latest cursor. It never applies a losing response's resume cursor or invents a
cursor locally.

### INV-3: Recovery fails closed on ambiguity

Missing checkpoint, identity mismatch, unchanged read cursor, and a second
expiry in one ingestion attempt remain bounded failures; no Agent Input is
created or resubmitted.

### ARCH-1: The reader owns cross-boundary recovery interpretation

`HerdrEventsReader` already owns both the live ring descriptor and the durable
checkpoint read. The existing domain port and SQLite CAS remain unchanged; the
reader performs only a read-after-CAS classification and delegates durable
mutation to the existing store operation.

## Implementation Decisions

The affected bounded context is Canonical Core Session Ingestion. The durable
checkpoint and Core event ring remain the authorities. No schema, new table,
new result variant, or Herdr Core change is required.

The implementation changes only the expired-cursor branch in
`HerdrEventsReader.ingestCurrentSession`. After the store call it reloads and
validates the checkpoint, sets `afterCursor` from the durable row, and marks
the one-expiry budget consumed. Existing epoch-transition handling and
same-epoch second-expiry failure behavior remain intact.

## Testing Decisions

The public reader seam `HerdrEventsReader.ingestCurrentSession` is the primary
regression seam. Tests will cover a stale-rebase loser that sees an advanced
durable winner, identity mismatch, and unchanged cursor. Existing store tests
remain authoritative for the atomic CAS winner/loser transaction and rollback.

Required checks are the focused Core ingestion/inbox tests, typecheck, build,
architecture/doc checks when applicable, and the full Vitest suite.

## Out of Scope

- Direct production SQLite edits or cursor deletion.
- Replaying Agent Input or reconstructing Core truth from Feishu cards.
- Changes to Herdr Core, the ring protocol, Feishu delivery, cards, outbox, or
  unrelated `Core event identity conflict` payload repairs.
- Treating arbitrary `invalid_cursor` errors as recoverable.
- Installation, restart, deployment, or push in this implementation turn.

## Further Notes

The fresh baseline was observed in `/tmp/herdr-agent-swarm-main-merge-20261012`
at `ba4d7989`: focused Core ingestion/inbox tests 85/85, full suite 301 files /
4,648 tests, typecheck, and build all passed. Production diagnosis identified
the repeated failure on `wV:pN` as a stale expired-cursor rebase fence, not a
database integrity failure.
