# Canonical Recovery Settlement

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Transaction-label deployment isolated the remaining event-loop tail to
`sqlite.core-event-inbox-store.ingest-canonical-snapshot-evidence`: in a
30-second sample it ran 12 times with median 278 ms and P95 296 ms. Live
read-only inspection found exactly three eligible Submission Intents. Each has
a ready, complete authoritative snapshot and no terminal Conversation Segment,
but no durable canonical-recovery outcome row.

The workflow records a successful `recovered` outcome by deleting
`canonical_input_recovery_attempts`. The pending query interprets an absent row
as eligible, so the same three complete snapshots are ingested again every
two-second Core reconciliation pass. This is safe but creates 3 synchronous
durable transactions per pass forever. Separately,
`reconcileCanonicalHumanMessages()` treats every recovery-attempt row as active;
terminal `auto_closed` rows therefore continue to create useless reconciliation
reads even though they are intentionally no longer retried.

## Solution

Extend the existing `canonical_input_recovery_attempts` lifecycle with terminal
state `recovered`. A recovered row has `failure_code=NULL`, `attempt_count=0`,
`next_attempt_at=NULL`, and the successful settlement time. Migration 130
rebuilds the constrained table additively, preserves every existing retry or
terminal failure row, advances the schema epoch, and remains lease-fenced.

After authoritative snapshot evidence ingestion returns `recovered`, the
existing page-completion transaction upserts this terminal success row instead
of deleting the attempt. The pending query already selects only missing rows or
due `retry_wait`, so successful snapshots become ineligible. If the process
crashes after evidence ingestion but before outcome settlement, the missing row
permits the same idempotent snapshot to run again; it never records success
before the durable evidence transaction completed.

Restrict canonical-Human reconciliation to nonterminal recovery states. Rows in
`recovered` and `auto_closed` no longer trigger reconciliation. Due
`retry_wait` and legacy `needs_human` behavior remains unchanged.

This design is auto-selected under the active goal's existing no-wait/default
authority. A separate success ledger was rejected because the existing attempt
aggregate already owns eligibility and outcome. Marking success as
`auto_closed/unavailable` was rejected as semantically false. Excluding ready
snapshots without a settlement row was rejected because a crash could occur
between snapshot staging and Core evidence ingestion.

## User Stories

### SCN-1: Successful snapshot recovery settles once

When canonical recovery returns `recovered`, page completion persists one
terminal recovered row. Subsequent scans and process reopen do not return that
submission, while its intent, receipt, snapshot, Core events, projections, and
outbox evidence remain unchanged.

### SCN-2: A crash before success settlement remains retryable

Snapshot staging or evidence ingestion alone does not create recovered state.
Only the existing complete-page transaction records it after the recover call
returns. A crash before that transaction leaves the row absent and permits one
idempotent retry; no Agent Input or external effect is replayed.

### SCN-3: Terminal outcomes do not drive canonical reconciliation

`reconcileCanonicalHumanMessages()` considers only retryable or human-owned
active recovery rows. Recovered and auto-closed rows remain durable audit facts
but create no periodic reconciliation work.

## Implementation Decisions

### INV-1: Recovery success is a durable terminal outcome

The attempts table remains the sole eligibility/outcome owner. `recovered`
means canonical evidence ingestion returned successfully, not that a remote
effect was retried or a Conversation Segment necessarily exists. The row is
deleted only by existing Submission Intent cascade/retention.

### INV-2: Evidence precedes settlement

The Core snapshot transaction commits before the recovery workflow returns
`recovered`; the page-completion transaction then records the terminal outcome
and advances its cursor atomically. The ordering permits harmless duplicate
local projection after crash but never premature success or external replay.

### INV-3: Terminal rows are operationally inert

Recovered and auto-closed outcomes are excluded from pending recovery and
canonical-human reconciliation, summary failure counts, backoff, and readiness.
Their timestamps remain available for audit.

### ARCH-1: Extend the existing aggregate only

Schema/migration own the valid state, `SqliteSubmissionIntentStore` owns
eligibility and settlement, and `CanonicalInputRecoveryWorkflow` keeps its
current ordering. No new table, worker, queue, timer, replay path, or public API
is added.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1

- Add migration 130 coverage for fresh and prior-epoch databases, preserved
  retry/auto-closed rows, recovered constraints, fingerprint convergence, and
  idempotent reopen.
- Add store/workflow coverage proving recovered outcomes persist with null
  failure/count zero, disappear from pending pages across reopen, and roll back
  with page cursor changes.
- Prove recovered/auto-closed rows no longer drive canonical-Human
  reconciliation while retryable rows still do.
- Preserve exact-turn snapshot ingestion, Segment/outbox idempotency, and all
  existing no-replay tests.

## Out of Scope

No snapshot event SQL batching, authoritative snapshot schema change, Core
event/reducer rewrite, recovery page-size change, deletion of historical
terminal rows, Human Review reintroduction, external replay, or production-data
manual mutation.

## Further Notes

Workspace `/tmp/herdr-agent-swarm-main-ring-stability-20261012` is the existing
isolated clean `main` worktree at
`98ad8660b3b238d01ff724c55e72a76e1a07b4f7`; the original checkout remains
excluded. Fresh baseline record `c0cd511b3daf49529510354ea2f9546d`
passed four files and 144 tests.

```spec-coder-verification
{"record_id":"c0cd511b3daf49529510354ea2f9546d","command":["/usr/bin/npx","vitest","run","tests/submission-intent-store.test.ts","tests/canonical-input-recovery-workflow.test.ts","tests/core-session-ingestion.test.ts","tests/sqlite-migrations.test.ts"],"exit_code":0,"status":"captured","observed_at":"2026-10-13T02:22:24.471004+00:00","result":"4 files and 144 tests passed"}
```
