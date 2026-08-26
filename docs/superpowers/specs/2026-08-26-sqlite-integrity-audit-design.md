# SQLite Integrity Audit Design

## Goal

Detect corruption and durable-state contradictions before they silently destabilize prompt processing or Lark card delivery. The audit is read-only, bounded, observable, and independent from readiness.

## Chosen design

`SqliteBindingStore.inspectIntegrity()` is the narrow database seam. It runs SQLite's `quick_check` and `foreign_key_check`, then checks bridge invariants that SQLite foreign keys do not fully express. A separate `SqliteIntegrityAuditor` runs that seam once at startup and every 15 minutes, coalesces overlapping runs, catches failures, and caches a safe status snapshot. `/status` reads only that cache.

This is preferable to running checks on every `/status` request because integrity checks can scan data and must not increase health endpoint latency. It is preferable to an external script because the bridge's business invariants and lane derivation rules belong with the store contract.

## Public contracts

`DatabaseIntegrityStore.inspectIntegrity(limit)` returns `{ quickCheck, issues, truncated }`. Each issue contains only a stable rule name, table name, count, and optional numeric row identifier. It never includes prompt bodies, outbound payloads, terminal output, message IDs, binding IDs, or card IDs.

`SqliteIntegrityAuditor` exposes:

- `start()` to run immediately and schedule later checks;
- `run()` to trigger or join the current check;
- `stop()` to cancel the timer;
- `snapshot()` to return the last bounded diagnostic result.

The cached diagnostic state is `idle`, `running`, `healthy`, or `degraded`. A thrown inspection error becomes a bounded degraded snapshot rather than crashing the service.

## Checks

The store performs these read-only checks with a shared maximum of 20 reported issues:

1. `PRAGMA quick_check` must return only `ok`.
2. Every `PRAGMA foreign_key_check` row is reported.
3. `outbound_replies.prompt_id`, when set, must reference `prompt_jobs.id`.
4. `outbound_replies.selection_id`, when set, must reference `project_selections.id`.
5. `prompt_jobs.parent_prompt_id`, when set, must reference `prompt_jobs.id`.
6. A binding can have at most one running ordinary turn.
7. Every `outbox_lane_heads` row must reference the earliest pending reply in that lane and copy its order/timing fields.
8. Every pending, non-quarantined lane must have exactly one matching lane head.
9. An actively quarantined lane must not have a lane head.

Counts describe total matching rows even when the issue list is capped. `truncated` signals that more findings exist. The audit does not repair or mutate any row.

## Runtime and health behavior

The auditor starts after the instance lease and write fence are acquired and before normal workflow startup. Inspection failures do not block ingress or readiness. `/status.sqliteIntegrity` exposes the cached snapshot and changes the top-level status to `degraded` whenever the audit is running after a previous failure, has degraded, or has never completed after startup. `/ready` continues to test database availability and lease ownership only.

The timer is stopped before shutdown closes SQLite. The interval is configured by `SQLITE_INTEGRITY_AUDIT_INTERVAL_MS`, defaults to `900000`, and is constrained to at least `60000`.

## Logging and security

Successful checks emit a compact completion record. Failed or degraded checks emit an error record with counts and rule names only. The audit never logs database contents or identifiers. Error strings use the existing bounded-error path.

## Testing

Store tests corrupt data through the existing public test database handle and verify detection via `inspectIntegrity()` without querying audit internals. Auditor tests cover immediate execution, coalescing, exception capture, bounded errors, and timer shutdown. Health tests prove degraded status with readiness still ready. Configuration tests prove default and validation behavior. Full tests, typecheck, build, and production status verify integration.
