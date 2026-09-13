# Legacy Worker Queue Convergence Implementation Plan

**Goal:** Terminalize only proven non-executable legacy Worker queued turns at
startup so operational queue counts represent actionable work.

## Task 1: Lock the recovery boundary

- Add store tests with detached legacy, active, terminated, pane-bearing, queued,
  and dispatch-uncertain combinations.
- Assert only exact legacy queued candidates become cancelled.
- Assert events and optional internal Worker Task Card state remain consistent.
- Run the focused test red before implementation.

## Task 2: Implement atomic startup convergence

- Select candidates in `recoverInterruptedInstanceTurns()` using durable Worker
  lifecycle, runtime identity, generation, and turn state.
- Cancel candidates and append `turn.cancelled` events in the existing transaction.
- Update an existing Task Card projection without creating new outbox work.
- Return `cancelledLegacyTurnIds` beside safe requeues and observable turns.

## Task 3: Integrate diagnostics

- Log the terminalized count during supervisor startup recovery.
- Keep `dispatch-uncertain` visible and excluded from replay.
- Verify `queuedTurns` drops only for the cancelled candidates.

## Task 4: Verify and commit

- Run Worker store/supervisor and health tests.
- Run typecheck, build, architecture checks, full tests, and diff checks.
- Run a production read-only candidate count; do not mutate or deploy.
- Commit independently.
