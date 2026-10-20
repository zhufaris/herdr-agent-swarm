# Retained Checkpoint and Delivery Budget

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

After startup continuation isolation, production still reads ten retained
Session Activity pages on every restart: 1,169 pairs, 94–99% actionable per
page, and roughly 107–134 ms of synchronous query work per page. Almost all rows
belong to one producer. The retained query excludes only an event whose exact
`source_event_id` is currently stored. When a later wait/close event supersedes
that item, older lifecycle events become eligible again, so every process
restart replays the same history from sequence zero.

The Delivery Ring has a separate boundedness gap. Ordinary outbox failures use
exponential backoff and dead-letter after five attempts, but safe transient Turn
Card failures stay pending forever and normally retry after about one second.
Production history currently peaks at two attempts, so this is a proven policy
gap rather than an active retry storm.

## Solution

Auto-selected under the goal's explicit no-wait authority: reuse existing
authoritative aggregates and one shared retry rule.

Migration 132 extends `session_activity_snapshots` with a retained-recovery lane
ID and lane sequence. The retained query ignores rows at or below the exact
producer/lane checkpoint. Page completion advances each producer checkpoint in
the same transaction as recovered mutations and pruning. A new lane or replaced
runtime fence starts from zero; rollback leaves the checkpoint unchanged.

The checkpoint is an operational projection cursor, not message or effect
evidence. No new table, global ledger, worker, timer, or external replay path is
introduced.

A pure shared delivery retry policy owns attempt limit and retry time. Ordinary
outbox and Turn Card delivery both use a five-attempt budget, exponential floor,
bounded jitter, and bounded provider `Retry-After`. Safe transient Turn Card
failures retry through attempts one to four and become a quarantined dead letter
on attempt five. Permanent or uncertain outcomes remain immediately terminal;
no ambiguous external effect is retried.

Rejected alternatives:

- target-specific JSON SQL could prove staleness without a checkpoint, but it
  would parse wait/close payloads and join items/identities for every historical
  row on every restart;
- a new recovery ledger duplicates the existing Session Activity aggregate;
- an in-memory cursor removes work only until the next process restart;
- leaving Turn Cards unbounded because production currently peaks at two
  attempts preserves a known denial-of-service path.

## User Stories

### SCN-1: Retained history settles once per producer lane

The first recovery after migration may scan historical pages. After the last
page commits, reopening the database returns no already-checkpointed pair for
that producer/lane. A new retained result above the checkpoint remains eligible.

### SCN-2: Recovery checkpoint never outruns applied state

If any mutation, prune, projection, notifier reservation, or checkpoint update
fails, the page transaction rolls back and the same pairs remain eligible.

### SCN-3: Runtime or lane replacement reopens recovery safely

A cursor applies only when binding/session/producer/runtime/native-session
fences and lane ID match. A replacement runtime or new lane ignores the old
cursor and recovers its own evidence from the beginning.

### SCN-4: Safe transient Turn Card retries are bounded

Attempts one through four remain pending with exponential retry times. Attempt
five becomes a dead letter with an active immutable-lane quarantine and no
automatic sixth provider call.

### SCN-5: Provider delay and effect certainty remain authoritative

A bounded provider `Retry-After` can lengthen the exponential delay. Permanent,
unknown, or uncertain-effect failures retain current immediate terminal
behavior; retry policy never converts ambiguity into replay.

## Implementation Decisions

### INV-1: Retained cursor and recovered mutations are one transaction

The cursor advances only after the page's ordered mutations and scope pruning
succeed. It records the maximum processed sequence for each exact producer and
lane represented in that page.

### INV-2: Cursor identity is fully fenced

Query and update require current binding generation, session epoch, producer
generation/session generation, runtime pane, native session, agent kind, and
lane. Stale snapshots cannot suppress new-runtime recovery.

### INV-3: Cursor state is operationally inert

Advancing retained recovery does not bump visible Session Activity revision,
change `updated_at`, reserve a card, or alter presentation fingerprints.

### INV-4: One retry policy owns bounded delivery attempts

The shared pure policy returns next attempt count, terminal decision and retry
time. Both ordinary outbox and conversation-page persistence consume it; they
retain their existing storage/quarantine responsibilities.

### INV-5: No uncertain external effect is replayed

Only `failureClass=transient` with certainty other than `uncertain` can retry.
Attempt-budget exhaustion terminalizes that intent; it never creates another
provider operation or resets attempt identity.

### ARCH-1: Extend existing aggregates and seams only

SQLite schema/migration and `SqliteSessionActivityStore` own retained cursor
state. A small domain retry-policy module owns calculation; existing outbox and
prepared-delivery stores own persistence. No new runtime component or public
external interface is added.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, SCN-4, SCN-5, INV-1, INV-2, INV-3, INV-4, INV-5, ARCH-1

- Recover multiple wait results for one agent, reopen, and prove historical
  pairs are no longer returned; append a higher-sequence result and prove it is
  recovered.
- Inject a prune/checkpoint failure and prove mutations, visible state and cursor
  roll back together.
- Cover migration 132 fresh/prior schema convergence, exact columns/defaults,
  idempotent reopen, and query-plan cursor use.
- Replace the runtime/lane fence and prove the old cursor does not suppress new
  evidence.
- Exercise shared retry calculations deterministically, then fail one real Turn
  Card claim five times and assert attempts 1–4 pending with increasing times,
  attempt 5 dead-letter/quarantine, and permanent/uncertain behavior unchanged.
- Preserve ordinary outbox five-attempt behavior and provider delay bounds.

## Out of Scope

No new recovery table, delivery ledger, SQLite worker migration, retained page
size change, payload compaction rewrite, retrying uncertain effects, provider
call replay, Ring scheduler rewrite, manual production data mutation, or
historical row deletion.

## Further Notes

Workspace `/tmp/herdr-agent-swarm-main-ring-stability-20261012` is the clean
isolated `main` worktree at
`44ee0bb006709a726949692595b6f57ab61db4e6`; the original checkout remains
excluded. Baseline record `e3cd80a004514e789a3d073b576450ce` passed three
files and 162 tests. Its full conservative capture remains conversational;
delivery will run all checks freshly.
