# Core Ingestion and Shutdown Stability

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

The deployed bridge is ready and `/status` no longer blocks on an expired Herdr
readiness snapshot, but event-loop tail latency remains coupled to synchronous
SQLite writes. Since build `61f204d7` started, transaction diagnostics recorded
269 `sqlite.core-event-inbox-store.write` transactions with median 275 ms, P95
299 ms, and maximum 334 ms. Live read-only inspection proved that caught-up Core
session checkpoints repeatedly kept identical source, epoch, read cursor, and
latest cursor while only `updated_at` changed every polling pass. The database
contains 298 lanes, and the supervisor polls 13 active sessions every two
seconds, so an observational no-op creates durable write and fsync pressure.

Two independent stability gaps amplify failure bursts. Core socket notifications
use unbounded `Promise.all` across owners even though periodic ingestion already
uses concurrency four. Ring shutdown awaits refill promises with fail-fast
`Promise.all`; a refill rejection can overwrite `stopping` with `degraded` and
return before active delivery cleanup, cache release, and the terminal stopped
state.

## Solution

The selected design makes three local changes at existing ownership boundaries:

1. `SqliteCoreEventInboxStore` recognizes only an exact, empty, caught-up batch
   whose durable checkpoint already matches source, epoch, identity, read cursor,
   and latest cursor. It returns `accepted` without opening a write transaction.
   The cached checkpoint statement gains `latest_cursor` and is reused by
   `getCheckpoint()`. Any missing or different field follows the existing
   transactional identity-fenced path.
2. `CoreSessionIngestionSupervisor.notifySources()` reuses
   `mapWithConcurrency(..., 4, ...)`, matching periodic reconciliation. Existing
   latest-cursor deduplication and per-identity tails remain the authority; no
   notification queue or retry state is added.
3. `RingDeliveryEngine.stop()` settles refill and delivery promises, always
   performs cache/scheduler cleanup, and reaches `stopped` before reporting a
   captured failure. Refill failure handling never changes `stopping` or
   `stopped` back to `degraded`.

This was uniquely recommended over two alternatives. Globally changing SQLite
to `synchronous=NORMAL` could reduce fsync latency but weakens all durable
outbox/receipt semantics, not only rediscoverable Core events. Moving SQLite to
a new Worker or adding another queue would duplicate scheduling and recovery
state. Increasing poll intervals would hide load while delaying convergence.
The local design removes effects that are provably redundant and preserves the
current durability model.

The design is auto-selected under the active goal's existing no-wait/default
execution authority. It adds no table, migration, worker, queue, timer, replay,
or external effect.

## User Stories

### SCN-1: A caught-up Core poll performs no durable write

Given a durable checkpoint and an empty Core batch whose source, epoch, agent,
session, read cursor, and latest cursor exactly match that checkpoint, ingestion
returns `accepted`, does not start a SQLite transaction, and leaves checkpoint
data including `updated_at` unchanged. A changed epoch, latest cursor, identity,
or missing checkpoint still uses the existing transaction and updates or rejects
under the current fence.

### SCN-2: Core notifications cannot create an ingestion burst

A notification batch for many distinct known owners starts at most four owner
ingestions concurrently. Every owner is still awaited, duplicate source/cursor
notifications remain coalesced, unknown sources still request full
reconciliation, and per-owner ordering remains serialized by the existing tail.

### SCN-3: Ring shutdown cleans up after refill failure

If an active refill rejects while shutdown is waiting, shutdown does not revert
to `degraded` or skip active-delivery settlement. It clears scheduler/rings,
oversized and refill state, resets cached bytes, reaches `stopped`, and only then
reports the captured failure to its caller.

## Implementation Decisions

### INV-1: Only exact no-effect evidence may bypass SQLite

The fast path is read-only and requires an existing checkpoint equal on every
identity and cursor field. It never advances a cursor, refreshes an epoch,
projects an event, or repairs stale replay. Concurrent advancement after the
read is harmless because the fast path writes nothing and cannot move authority
backward.

### INV-2: Notifications are hints, durable cursors remain authority

Concurrency limiting changes admission timing only. It does not discard a
distinct owner, alter the latest-cursor dedup key, or create a second queue.
Periodic reconciliation and durable lane checkpoints remain the convergence
path after missed or reordered hints.

### INV-3: Shutdown state is monotonic and cleanup-first

Once stopping begins, refill completion cannot publish `running` or `degraded`.
All tracked promises are settled, in-memory delivery references are released,
and `stopped` is published before a shutdown error escapes. External effects
retain their existing certainty and idempotency rules.

### ARCH-1: Existing owners remain deep and sufficient

No public port changes. No schema or configuration changes. The inbox store owns
checkpoint no-effect detection, the ingestion supervisor owns owner concurrency,
and the Ring engine owns its shutdown lifecycle.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1

- Add a transaction-diagnostic test proving an exact empty caught-up batch does
  not increment transaction count or change the checkpoint timestamp, while a
  latest-cursor or epoch change still enters the transaction.
- Add a blocked-ingestor test with more than four notified owners proving max
  concurrency four and eventual processing of every owner.
- Add a refill-rejection shutdown test proving cleanup and terminal state occur
  before the rejection is observed.
- Run affected store/supervisor/Ring suites, typecheck, build, architecture and
  docs checks, then the full Vitest suite and immutable deployment.

## Out of Scope

No SQLite synchronous-mode change, WAL/checkpoint redesign, schema/index
migration, Core page-size change, Ring idle eviction, Markdown parser change,
status-query redesign, historical replay, production-data mutation, or broader
recovery refactor is included.

## Further Notes

Workspace `/tmp/herdr-agent-swarm-main-ring-stability-20261012` is an existing
isolated clean `main` worktree at
`61f204d79a9a0b311231d9a1e18037539eca35a6`; the user's original checkout is
excluded. Dependencies were confirmed by `npm ls --depth=0`. Fresh baseline
record `5f099dd03ee74cc1a529d4b8034cbcdd` ran the three affected suites: 3 files and
136 tests passed.

```spec-coder-verification
{"record_id":"5f099dd03ee74cc1a529d4b8034cbcdd","command":["/usr/bin/npx","vitest","run","tests/core-event-inbox-store.test.ts","tests/core-session-ingestion.test.ts","tests/ring-delivery-recovery.test.ts"],"exit_code":0,"status":"captured","observed_at":"2026-10-13T00:22:00.899793+00:00","result":"3 files and 136 tests passed"}
```
