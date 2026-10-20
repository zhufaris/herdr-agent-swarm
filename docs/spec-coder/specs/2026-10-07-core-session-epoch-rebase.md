# Core Session Ring Epoch-Transition Recovery

## Problem Statement

Swarm continuously ingests canonical Herdr Core session-ring events through a
durable SQLite lane checkpoint. The existing recovery path handles an expired
cursor only when Core returns a typed `cursor_expired` response containing a
safe `resume_cursor` in the same ring epoch. It deliberately rejects malformed,
wrong-ring, and wrong-epoch cursors.

Production currently has a different failure shape. For the active Binding on
Pane `wN:p6G`, SQLite retains the exact checkpoint
`epoch-3:164`, while `ring-open` for the same ring, TraeX session, terminal, and
agent identity returns `epoch-2:0`. Reading the durable cursor against the live
ring returns only `invalid_cursor`, with no resume details. Seventeen sessions
are lagging this way; the current Pane exceeded one hundred retries, Agent Input
readiness is false, and the canonical final event needed for its Feishu card
cannot advance.

Restarting Swarm cannot repair a durable checkpoint. Blindly deleting the row
would discard evidence and could race another owner. The required change is an
identity-fenced, durable epoch-transition rebase that records the missing
boundary before reading the new epoch.

## Solution

When opening a v2 session ring, compare the live ring epoch with the durable
lane checkpoint before issuing `ring-read`. If ring/source, session, and agent
identity still match but the epochs differ, atomically record an epoch-change
projection gap and replace the checkpoint epoch/cursor with the live epoch and
the ring's safe start boundary. Then read and ingest the live retained window
through the ordinary inbox path.

An epoch transition and ordinary retained-window expiry are distinct. One
ingestion attempt may perform at most one epoch-transition rebase and, after
that, at most one same-epoch `cursor_expired` rebase using Core's typed
`resume_cursor`. No response without an identity-proven transition or typed
resume cursor may advance the checkpoint.

This recovery applies to every active Primary or Worker v2 session lane meeting
the exact identity conditions; it is not a one-off mutation for `wN:p6G`.

## User Stories

### SCN-1: Recover an empty replacement epoch

Given a durable checkpoint for the same ring/session/agent in an old epoch and
a live ring opened in a different empty epoch, Swarm atomically records the
epoch transition, starts the live epoch at `start`, reads its empty batch, and
advances to the live latest cursor. The ingestion retry clears and readiness
can recover without replaying Agent Input.

### SCN-2: Ingest retained events from the replacement epoch

Given the same identity-preserving epoch transition and a non-empty live
window, Swarm rebases to `start`, ingests every retained event in Core order,
preserves the existing lane sequence, and projects each canonical event at most
once.

### SCN-3: The replacement epoch has already overflowed

After the epoch-transition rebase, reading `start` may return typed
`cursor_expired` with a live-epoch `resume_cursor`. Swarm performs one existing
same-epoch expiry rebase and ingests the complete retained window. A second
epoch transition or second expiry during the same ingestion attempt fails
closed and retries from freshly opened state.

### SCN-4: Identity or concurrency no longer matches

If source/ring, session, agent kind, expected old epoch, or expected read cursor
does not match the durable row, no transition is applied. A competing store
winner returns `stale_rebase`; the loser does not overwrite it and retries from
a fresh ring-open/checkpoint observation.

### SCN-5: Recovery survives failure and restart

If the transaction fails, neither the projection gap nor checkpoint update is
visible. After commit, restart observes the new epoch checkpoint and does not
create a duplicate gap or replay an already stored canonical event.

### SCN-6: Missing historical evidence remains explicit

The epoch transition records the lost boundary as a durable projection gap.
Existing canonical/exact-turn recovery remains responsible for pending,
uncertain, or active work. Swarm never reconstructs Core truth from Feishu card
content and never resubmits Agent Input that may already have reached Core.

## Implementation Decisions

### Domain Model

The affected bounded context is **Canonical Core Session Ingestion**. Its
durable lane checkpoint remains the authority for how far one stable
ring/session lane has been read; the Core ring remains the authority for its
current epoch and retained window.

An **Epoch Transition Rebase** is a new explicit checkpoint action, not a
variant inferred from arbitrary `invalid_cursor` errors. Its input contains the
stable lane/ring/session/agent identity, exact old epoch/cursor, live new epoch,
and live earliest/latest cursors. Its result is `rebased` or `stale_rebase`.

The enforcing invariants are:

- **INV-1:** Epoch transition is eligible only when lane source/ring, session,
  and agent identity match and only the epoch differs.
- **INV-2:** Gap evidence and checkpoint epoch/cursor replacement commit in one
  SQLite transaction under the exact old checkpoint fence.
- **INV-3:** The transition begins the new epoch at the protocol-defined
  `start` boundary; Swarm does not invent an opaque cursor or reuse the old
  epoch cursor.
- **INV-4:** One ingestion attempt performs at most one epoch transition and
  one subsequent typed same-epoch expiry rebase.
- **INV-5:** Stable canonical event IDs and lane item uniqueness retain
  projection/idempotency authority across restart and replay.
- **INV-6:** Recovery never creates, repeats, or guesses Agent Input and never
  uses Feishu state as canonical evidence.
- **INV-7:** Identity mismatch, transaction failure, lost race, repeated
  transition, and same-epoch untyped `invalid_cursor` fail closed.
- **INV-8:** One broken lane does not prevent independent session lanes or
  ordinary inbound messages from making progress.

No new aggregate or table is introduced. The checkpoint plus durable
projection-gap transaction is the existing consistency boundary.

### Architecture

#### Reader decision

`HerdrEventsReader.ingestCurrentSession` already owns both pieces of evidence:
the v2 `ring-open` descriptor and the durable lane checkpoint. Before its first
read, it compares `checkpoint.sourceEpoch` with the opened `sourceEpoch`.

When they differ, the reader calls a domain-owned `CoreEventInboxStore`
epoch-transition operation with:

- lane ID and stable source/ring ID;
- agent kind and session ID;
- expected old epoch and read cursor;
- live new epoch, earliest cursor, and latest cursor;
- the existing owner identity and observation time.

The reader then reloads the durable checkpoint and reads from `start`. It keeps
separate bounded flags for epoch transition and retained-window expiry so the
new-epoch `start` can still use the existing typed expiry path once.

The reader does not catch or reinterpret a generic Herdr `invalid_cursor` as an
epoch transition. The transition is proven before the read from independent
open/checkpoint evidence.

#### Store transition

`SqliteCoreEventInboxStore` owns the atomic transition. It verifies the full
old row, inserts one deterministic `projection_gaps` item with
`failure_code = cursor_epoch_changed`, and updates:

```text
source_epoch = live epoch
read_cursor  = start
latest_cursor = live latest cursor
```

Gap details contain lane/source/session/agent identity, old epoch/cursor, live
epoch, earliest cursor, and latest cursor. The deterministic identity makes
retry idempotent. The store preserves all existing inbox and lane items.

`stale_rebase` means another transaction changed the checkpoint; the reader
does not continue from its stale in-memory evidence.

#### Dependency direction

The runtime reader depends on the domain-owned inbox interface. SQLite
implements that interface. The Herdr adapter continues only to normalize Core
ring/open/read payloads and structured errors; no SQLite or workflow semantics
enter the adapter. Coordinators continue treating a successful catch-up as
progress and a thrown failure as bounded retry.

### Behavior & Failure Modes

Normal transition:

1. Open v2 ring and load durable checkpoint.
2. Prove stable identity and different epoch.
3. Atomically persist gap plus new-epoch `start` checkpoint.
4. Reload checkpoint and read current epoch.
5. If needed, perform one typed same-epoch expiry rebase.
6. Ingest retained events and advance the checkpoint normally.
7. Supervisor clears the lane's retry/lag state after catch-up.

Failure behavior:

- Source/ring/session/agent mismatch throws the existing identity error.
- A missing live epoch or non-v2 source does not enter this path.
- A store race returns `stale_rebase`; no partial mutation occurs.
- Transaction injection failure rolls back both gap and checkpoint.
- A second epoch mismatch or second expiry within one ingestion attempt throws
  a bounded recovery error instead of looping.
- Same-epoch `invalid_cursor` without typed resume details remains retryable but
  does not mutate durable state.
- Exact-turn recovery and projection-gap diagnostics remain the only paths for
  evidence absent from the current retained window.

### Compatibility & Migration

No SQLite schema migration is required. Existing checkpoints, inbox events,
lane items, and projection gaps remain readable. Same-epoch expiry behavior is
unchanged. Legacy v1 streams do not use epoch-transition recovery.

The change is compatible with the currently installed Herdr behavior that may
return only `invalid_cursor` for a cursor from another epoch because Swarm
detects the transition before calling `ring-read`.

Production activation remains a separate operation after implementation
verification. Installation must stage an immutable release and restart only
after the active-work safety gate. Readiness and the exact affected checkpoint
must be inspected after restart; no direct live-database edit is part of the
rollout.

## Testing Decisions

- Reader integration tests reproduce the production shape
  `epoch-3:164 -> epoch-2:0` and prove empty-ring catch-up.
- A non-empty replacement epoch test proves complete ordered ingestion and no
  duplicate lane items.
- An overflowed replacement epoch test proves one epoch transition followed by
  one typed same-epoch resume rebase.
- Identity mismatch tests cover ring/source, session, and agent kind.
- Store tests verify exact old epoch/cursor fences, one winner across competing
  handles, deterministic gap identity, and atomic rollback under injected
  failure.
- Restart/idempotency tests prove no duplicate gap, event, projection, or Agent
  Input work.
- Supervisor tests prove successful retry clears lag/readiness and one broken
  lane does not block an independent healthy lane.
- Architecture evidence confirms Herdr adapter, runtime reader, domain port,
  and SQLite dependency direction.
- Required verification: focused reader/store/supervisor tests,
  `npm run architecture:check`, `npm run docs:audit`, `npm run typecheck`,
  `npm run build`, and full `npm test`.

## Out of Scope

- Manually deleting or rewriting production checkpoint rows.
- Treating every `invalid_cursor` as recoverable.
- Changing Herdr Core ring protocols or epoch allocation.
- Replaying Agent Input or reconstructing canonical state from Feishu cards.
- Repairing unrelated historical projection gaps, dead letters, or outbox
  backlog.
- Completion Choice, CardKit, callback, or notification behavior changes.
- Production installation, restart, deployment, or push before separate
  rollout authorization.

## Further Notes

- Workspace: isolated Git worktree
  `/tmp/herdr-agent-swarm-core-epoch-rebase`.
- Branch: `fix/core-epoch-rebase`.
- Starting revision: `b14550f3510acc50d837b81d588462dc43a2eb60`.
- Initial changes: none; worktree was clean.
- Dependencies: `npm ci` completed from the lockfile; npm reported seven
  pre-existing high-severity audit findings.
- Fresh baseline: focused reader/inbox tests passed 59/59; architecture check
  passed for 504 source files; typecheck and build passed with build identity
  `sha256:b28eae2990a1bff3e486f82d8579d4ee3adcf8e80c987093a5634f8d12b3dc2b`.
- Production evidence was collected read-only. No live database, service, or
  pane was mutated.
- Gate 1 design approval: approved in conversation on 2026-10-07.
- Gate 2 specification approval: approved in conversation on 2026-10-07.
- Unresolved load-bearing decisions: none.
