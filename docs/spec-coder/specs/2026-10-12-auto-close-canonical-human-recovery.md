# Auto-close Canonical Human Recovery

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Historical Canonical Human Message recovery rows in `needs_human` state make
Core session ingestion readiness remain `not_ready` indefinitely. The service
must not ask an operator to recover these old rows one by one.

## Solution

Add a durable `auto_closed` recovery state. Migration 127 converts existing
`needs_human` rows to `auto_closed` while retaining submission identity,
failure code, attempt count and timestamps. Future `not_found`, `ambiguous` and
`unavailable` recovery outcomes use `auto_closed` directly. Auto-closed rows are
excluded from pending recovery and do not block readiness. No Agent Input is
resubmitted and no durable evidence is deleted.

## User Stories

### SCN-1: Existing recovery debt stops blocking readiness

After migration, existing historical recovery rows remain queryable as
`auto_closed`, while the Core ingestion supervisor reports no Human Recovery
block.

### SCN-2: New ambiguous recovery is bounded

When exact canonical evidence is unavailable, Swarm records the failure and
auto-closes the recovery without retrying forever or replaying the input body.

## Implementation Decisions

### INV-1: Auto-close never replays Agent Input

Auto-closing changes only recovery bookkeeping. It cannot create a submission,
turn, card, Gateway effect or retry work.

### INV-2: Durable evidence is retained

The submission intent and recovery row remain durable with failure code,
attempt count and timestamps.

### INV-3: Readiness is not gated by historical Human Recovery

Canonical recovery `needs_human` counts no longer make Core session ingestion
unready. Transport failures and required live session failures remain visible
and independently handled.

### ARCH-1: Existing recovery table remains the boundary

Migration 127 extends the existing SQLite table state constraint; no new table,
ledger or external protocol is introduced.

## Testing Decisions

Cover fresh schema, migration of an existing `needs_human` row, new ambiguous
and not-found outcomes, retained evidence, no pending recovery work, and
supervisor readiness. Run the focused recovery/migration tests, full Vitest,
typecheck, build, architecture check and docs audit.

## Out of Scope

Core socket timeout policy, Agent Input resubmission, direct production SQLite
edits, and deployment mechanics are separate concerns.

## Further Notes

Implemented on local `main` after the ring/checkpoint stability merge. The
change is intentionally conservative: auto-close is a no-replay terminal
bookkeeping outcome, not a claim that Core evidence was recovered.
