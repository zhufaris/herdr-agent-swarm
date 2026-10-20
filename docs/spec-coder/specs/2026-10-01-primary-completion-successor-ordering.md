# Primary Completion Successor Ordering

## Problem Statement

Primary completion notifications are released only after the final Answer view
has been delivered. Before release, the persistence policy checks whether the
same Binding already has accepted nonterminal work. The current query treats
every other `queued`, `submitted`, `running`, `recovering`, or `uncertain`
Prompt as a successor, regardless of FIFO position.

In the live `datasage_semantic_knowledge / x264` Binding, six historical
`uncertain` Prompts created before the newly completed Prompt satisfied that
query. The final Answer was delivered successfully, but the notification
obligation became `suppressed` and no mention-card outbox row was created.

## Solution

Define a Primary successor as a Prompt in the same Binding and Binding
generation that is both nonterminal and strictly later than the completed
Prompt in canonical FIFO order `(created_at, rowid)`. Keep the successor check
inside the existing completion-notification transaction.

This change does not alter public interfaces, states, schemas, idempotency keys,
Answer delivery gates, mention-target selection, or outbox behavior. It does not
rewrite historical Prompt state or retroactively send previously suppressed
notifications.

## User Stories

### SCN-1: Historical uncertainty does not hide a new completion

When a Primary Prompt completes and its final Answer is delivered, an older
same-generation `uncertain` Prompt does not suppress the completion mention.
The notification is reserved once through the existing durable outbox path.

### SCN-2: Accepted successor work suppresses stale notification

When a nonterminal same-generation Prompt is later than the completing Prompt
in FIFO order, the completion obligation becomes `suppressed` and no mention
notification is reserved.

### SCN-3: Equal timestamps preserve deterministic FIFO

When two Prompts have equal `created_at` values, SQLite `rowid` determines their
relative FIFO position. An earlier row is a predecessor; a later row is a
successor.

## Implementation Decisions

### Domain Model

The affected bounded context is Primary Prompt execution and completion
notification. `PrimaryNextInputNotification` owns the decision to release or
suppress a durable completion-notification obligation. Prompt FIFO order is the
existing authoritative order `(created_at, rowid)` used by the SQLite Prompt
stores.

- **INV-1:** A predecessor never suppresses a later Prompt's completion
  notification, including when the predecessor remains `uncertain`.
- **INV-2:** A later same-generation nonterminal Prompt suppresses the older
  completion notification.
- **INV-3:** A Prompt from another Binding generation cannot affect the
  obligation.
- **INV-4:** At most one notification is reserved for an obligation.

No new entity, value object, aggregate, domain service, or glossary term is
needed. The change sharpens the existing meaning of `successor` rather than
introducing a new concept.

### Architecture

The rule remains local to the SQLite completion-notification module. The
existing `releasePrimary(promptId, render)` interface and its callers remain
unchanged. A correlated SQLite query compares candidate Prompt order against
the current Prompt and keeps the decision within the existing transaction.

No adapter, composition, dependency direction, or public contract changes.

### Behavior & Failure Modes

The release transaction first retains all existing completion checks: delivered
Prompt state, completed Run Card, final Answer version, finished final page,
closed projection/delivery gaps, active route, and matching generation/pane.
It then suppresses only for a strictly later accepted nonterminal Prompt.

SQLite transaction ordering remains authoritative for the input/release race:
later input committed before release suppresses; release committed first
reserves one immutable, idempotent card. Historical `uncertain` work remains
untouched and recoverable but does not claim that newer work is still pending.

### Compatibility & Migration

No database migration or data repair is required. Existing obligation and
Prompt states remain valid. Previously suppressed notification obligations are
not reopened or replayed.

## Testing Decisions

Use the existing `SqliteBindingStore` integration seam in
`tests/sqlite-store.test.ts`.

- Add a Red test for SCN-1 with an older `uncertain` predecessor; final Answer
  delivery must reserve exactly one Primary notification containing the actor
  mention.
- Cover SCN-3 by assigning the predecessor and current Prompt the same
  `created_at`; insertion order/`rowid` must keep the predecessor from
  suppressing.
- Preserve the existing parameterized successor-state test for SCN-2, which
  proves each supported later nonterminal state still suppresses.
- Run the focused SQLite suite, TypeScript typecheck, build, and full Vitest
  suite before delivery.

## Out of Scope

- Resolving or deleting historical `uncertain` Prompts.
- Reissuing completion notifications already marked `suppressed`.
- Changing Worker completion-notification ordering.
- Changing Answer delivery, projection-gap, mention-target, or outbox policy.
- Deploying or restarting the live service.

## Further Notes

- Workspace mode: in place.
- Reason: tracked files were clean and the task has narrow, non-overlapping
  ownership; unrelated untracked files are preserved.
- Branch: `main`.
- Starting revision: `9aaeca511ad81e8eacf9279096a223ec26f86e12`.
- Initial unrelated untracked paths: `.tmp-core-build/`,
  `.tmp-core-worktrees/`, `.trae/`,
  `docs/spec-coder/specs/2026-10-01-core-projection-gap-reconciliation.md`, and
  `handoff.md`.
- Fresh baseline:
  - `npx vitest run tests/sqlite-store.test.ts`: 437 passed.
  - `npm run typecheck`: passed.
  - `npm run build`: passed.
- No unresolved design decisions or implementation blockers.
