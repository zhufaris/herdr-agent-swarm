# Lark Outbox Work Diagnostics Implementation Plan

**Goal:** Expose an exhaustive, mutually exclusive SQLite-derived breakdown of
pending Lark outbox work without changing delivery or health policy.

**Architecture:** Add one aggregate query to `SqliteOperationsStore` using the
existing pending rows, lane-head table, claim columns, row deadline, and app
cooldown snapshot. Publish counts and the oldest claim time through
`OperationalSummary`; retain all existing compatibility fields.

## Test seams

- `SqliteBindingStore.getOperationalSummary()` for durable partition behavior.
- `/status` for serialized diagnostics and unchanged health semantics.

## Task 1: Define the empty and active-work contract

- Add an empty-store assertion for five zero counts and null oldest fields.
- Add pending rows representing ready, in-flight, retry-wait, and a same-lane
  successor.
- Assert each category and the equality between their sum and `pendingOutbox`.

## Task 2: Add cooldown and transition coverage

- Add a separate active-cooldown fixture whose due heads become
  `cooldownWait` while backed-off heads remain `retryWait`.
- Verify cooldown expiry restores `ready` without updating outbox rows.
- Verify ACK and failure settlement move the claimed row out of `inFlight`.

## Task 3: Implement the aggregate

- Add `OutboxWorkSummary` to the domain output contract.
- Compute the five classes in one aggregate SQL query using one observation
  timestamp and one cooldown read.
- Derive the oldest claim timestamp and non-negative whole-second age.
- Return null age for absent or malformed timestamps.
- Do not add schema, indexes, writes, identifiers, or repair behavior.

## Task 4: Preserve health semantics

- Add a health-server test with nonzero normal `inFlight` and prove `/status`
  and `/ready` remain healthy.
- Confirm active cooldown still degrades status through the existing cooldown
  field rather than the new work counts.
- Keep process-local dispatcher `activeDeliveries` independent.

## Task 5: Documentation, validation, and commit

- Update architecture and stability roadmap completion records.
- Run focused SQLite and health tests.
- Run `npm run typecheck`, `npm run build`, `npm run architecture:check`,
  `npm test`, and `git diff --check`.
- Review and commit the implementation independently.
- Do not push, install, restart, deploy, or send real Lark messages.
