# Evidence-Based Quarantine Convergence Implementation Plan

**Goal:** Close obsolete outbox quarantines only from end-to-end durable evidence
and make the latest current Answer snapshot deliverable after startup.

## Task 1: Lock rejected immutable convergence

- Add a failing store test for a rejected immutable `card_reply` with no pending
  lane work.
- Assert the reply is dismissed, its recovery is dismissed, the quarantine is
  released, and the result reports the transition.
- Add fail-closed cases for `uncertain` certainty and pending successors.

## Task 2: Lock superseded Answer convergence

- Build a failed old-target Answer update, matching current Run Card and Answer
  page, delivered replacement create, and several current-target snapshots.
- Assert the old recovery records the replacement proof, the quarantine is
  released, only the highest revision remains pending, and that row becomes the
  lane head.
- Add fail-closed cases for incomplete/mismatched identity and a claimed pending
  snapshot.
- Run the focused tests red before implementation.

## Task 3: Implement one atomic recovery transition

- Extend the stale-quarantine result with explicit rejected-immutable and
  superseded-Answer counts.
- Add bounded candidate queries and exact durable-evidence predicates inside
  `SqliteOutboxRecoveryStore`.
- Settle recovery, quarantine, and snapshots within the existing transaction.
- Preserve the failed uncertain effect as a dead letter and never enqueue a retry.
- Refresh the lane head only after successful convergence.

## Task 4: Integrate startup observability

- Include the new counts in startup wake-up decisions and structured logs.
- Update exact result fixtures without weakening assertions.

## Task 5: Verify and commit

- Run focused SQLite, startup, Answer, and outbox tests.
- Run `npm run typecheck`, `npm run build`, `npm run architecture:check`, the full
  test suite, and `git diff --check`.
- Commit this vertical slice independently.
- Run a production read-only dry-run of the evidence predicates; do not install,
  restart, or mutate the production database.
