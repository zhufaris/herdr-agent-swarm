# Retained Recovery Index and Failure Backoff

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

The deployed `b0908058` build eliminated redundant caught-up Core checkpoint
writes, but restart still runs nine retained multi-agent Session Activity pages.
Read-only production measurements show every 129-row page spends 580–610 ms in
the candidate query, followed by a 747–877 ms synchronous transaction. Changing
the query limit from 129 through 2,049 leaves query time near 600 ms, proving
that repeated sparse-event discovery dominates rather than returned row count.

`EXPLAIN QUERY PLAN` starts from every `tool_result` in each active retained
session, then discovers whether its paired `tool_call` is one of only three
multi-agent operations. A production-shaped 27,488-row lane subset proved that
a partial call index changes the unmodified query plan to start from sparse
multi-agent calls: the original query fell to about 31 ms. An explicit
call-first rewrite reached about 27.5 ms and produced the same 129-row SHA-256,
so duplicating the SQL is not justified. Building the candidate index on a
4.2 GiB maintenance backup took 17.9 seconds.

Two smaller stability/elegance gaps remain. Seven different Core inbox
transactions still share `sqlite.core-event-inbox-store.write`, obscuring the
source of the remaining 250–320 ms real-event writes. Also, after the first cold
workspace-readiness observation fails, `/status` has a real failed value and a
retry deadline but re-probes on every request because no successful value is
cached; strict `/ready` should remain able to probe immediately, while status
should honor the existing backoff.

## Solution

Add one partial expression index over the three supported multi-agent tool-call
names through ordered migration 129 for fresh and upgraded databases. Keep the existing
retained-recovery SQL unchanged and let SQLite select the new sparse access path.
The migration remains lease-fenced and idempotent; it adds no data rewrite.

Replace the generic Core inbox transaction label with stable method-specific
labels for ingest, lane bootstrap/rebase/transition, invalid-cursor gap,
canonical snapshot evidence, and acknowledgement. Labels contain no pane,
session, event, or user identity and therefore keep bounded log cardinality.

When `SnapshotCache` has no successful value but does have a real failed value
whose retry deadline is still in the future, stale-while-refresh status reads
return that failed observation without starting another refresh. At or after the
deadline, exactly one status refresh starts. Strict reads ignore this status
backoff and continue to probe or coalesce with an active probe.

This design is auto-selected under the active goal's existing no-wait/default
authority. A call-first SQL copy was rejected because the index supplies almost
all measured benefit without a second query definition. A persistent legacy
recovery checkpoint was rejected because it adds durable lifecycle state and
producer-set invalidation rules. Larger pages were rejected because they reduce
query count by increasing synchronous mutation/commit duration.

## User Stories

### SCN-1: Retained recovery starts from sparse multi-agent calls

Fresh and upgraded databases contain `core_event_inbox_multi_agent_call`.
Queries that constrain agent/session and the exact three call names use an
indexed search rather than scanning all result events. Existing retained
recovery ordering, cursor, exclusions, and returned rows remain unchanged.

### SCN-2: Slow Core transactions identify their actual operation

Every Core inbox mutation records one bounded operation label identifying the
store method. No label embeds runtime identity. Nested projection transactions
retain the outer Core operation as today, so logs can distinguish ingestion,
snapshot recovery, cursor repair, and acknowledgement.

### SCN-3: Cold status failure respects its retry deadline

After a cold status probe returns a failed workspace observation, another status
request before `retryAt` returns that same real not-ready observation and does
not call Herdr. At the deadline, concurrent status requests start one coalesced
refresh. An expired strict readiness request may bypass the status deadline.

## Implementation Decisions

### INV-1: The index is an acceleration, not new authority

The index predicate uses only already-authoritative normalized event fields and
the exact JSON tool name checked by the existing query. It does not alter rows,
recovery cursors, reducer revision, projection eligibility, or conflict fences.
Dropping the index changes performance only.

### INV-2: Diagnostic labels are bounded and non-sensitive

Labels are source constants and normalize through the existing transaction
diagnostic path. They identify methods, never owners, arguments, payloads, IDs,
or errors. Failure and rollback semantics remain unchanged.

### INV-3: Backoff reuses observed failure, never synthetic readiness

`lastFailedValue` is the exact bounded/redacted Herdr observation produced by a
completed probe. Status may reuse it only before `retryAt`. Strict readiness and
cold status without any observation still fail closed and perform a real probe.

### ARCH-1: Existing owners remain sufficient

Migration/schema own the physical index, `SqliteCoreEventInboxStore` owns
transaction labels, and the private `SnapshotCache` owns refresh/backoff state.
No public port, endpoint, worker, queue, timer, or table is added.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1

- Add migration coverage for fresh and marker-128 databases, idempotent marker
  129, and a query plan that searches `core_event_inbox_multi_agent_call`.
- Assert representative Core inbox methods publish distinct exact operation
  labels without changing transaction counts or results.
- Add a controllable-clock cold-failure test proving repeated status requests
  before the deadline do not probe, deadline requests coalesce, and strict
  readiness bypasses the deadline.
- Run migration/session-activity/Core inbox/health affected suites, typecheck,
  build, architecture/docs checks, full Vitest, and delivery artifact checking.

## Out of Scope

No retained-recovery SQL rewrite, page-size change, durable recovery checkpoint,
payload compaction, SQLite synchronous/WAL change, broad event index, worker
thread, status schema change, historical replay, or production-data mutation.

## Further Notes

Workspace `/tmp/herdr-agent-swarm-main-ring-stability-20261012` is the existing
isolated clean `main` worktree at
`b0908058f50b3ec9e14ed8fafa6b14904f1c6c01`; the original checkout remains
excluded. Benchmark databases were temporary copies and were removed. Fresh
baseline record `38211c64af254d19853054d2162d9807` passed five files and
245 tests.

```spec-coder-verification
{"record_id":"38211c64af254d19853054d2162d9807","command":["/usr/bin/npx","vitest","run","tests/sqlite-migrations.test.ts","tests/session-activity-store.test.ts","tests/core-event-inbox-store.test.ts","tests/health-snapshot-collector.test.ts","tests/health-server.test.ts"],"exit_code":0,"status":"captured","observed_at":"2026-10-13T01:30:59.015019+00:00","result":"5 files and 245 tests passed"}
```
