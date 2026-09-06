# Transactional Worker Queue Positions

## Goal

Worker Task Cards must receive their queue position from the same SQLite
transaction that accepts the turn, creates its card projection, and records the
CardKit outbox intent. Concurrent callers must not be able to persist duplicate
positions from stale workflow-side counts.

## Semantics

- Queue capacity continues to count every live turn because each consumes Worker
  capacity.
- The user-facing `queuePosition` counts only earlier normal-priority turns in
  `queued` state for the same instance generation. An executing turn is not a
  queue member.
- Priority turns retain queue position `0`.
- An idempotent retry returns the originally persisted card and position.
- Historical generations and other Workers do not affect the position.

## Transaction boundary

`InstanceMessagingWorkflow` constructs a card seed containing trusted routing
and identity fields, but no authoritative queue position.
`acceptInstanceTurnWithCard()` then performs, under one `BEGIN IMMEDIATE`:

1. generation and idempotency checks;
2. capacity and follow-up-parent validation;
3. queue-position calculation;
4. final card-view construction and rendering;
5. turn, card, initial page, event, and outbox persistence.

The renderer is a pure callback supplied through the port. This keeps CardKit
presentation outside the SQLite adapter while ensuring the outbox payload is
rendered from the exact view persisted by the transaction.

## Verification

Tests exercise the public workflow/store seams and cover sequential acceptance,
an executing predecessor, idempotent retries, queue limits, separate Workers,
and generation isolation. The affected integration tests, typecheck, build, and
full Vitest suite must pass before deployment.
