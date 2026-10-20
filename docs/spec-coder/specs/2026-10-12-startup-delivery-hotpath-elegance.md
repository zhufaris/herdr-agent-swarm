# Startup and Delivery Hot-Path Elegance

<!-- spec-coder:artifact-v1 spec -->

## Problem Statement

Production startup recovery currently completes in roughly 34 seconds, but
`swarm:start` waits only 15 seconds by default. The last verified deployment
therefore printed a lifecycle failure while the canonical unit remained active
and became ready normally. `swarm:restart` already uses a 90-second budget, so
the two operator commands disagree about the same startup contract.

Delivery claim also evaluates `currentRecoveryReplacementSql` on Primary and
Worker hot paths. The predicate looks up
`delivery_recoveries.replacement_reply_id`, but the production table has 1,321
rows and no index on that column. `EXPLAIN QUERY PLAN` reports `SCAN TABLE
delivery_recoveries`; recovery history is retained, so claim cost grows with
service lifetime.

Finally, `DeliveryLatencyTrace` already keeps bounded `staleAttempts` and
`maintenanceYields` counters in `/status`, while the logging adapter emits one
high-cardinality info record for every occurrence. The latest startup produced
44 diagnostic info records. Exact reply/attempt correlation is useful on
demand but does not belong in the normal info stream.

## Solution

Use one 90-second default startup-completion budget for both start and restart,
while preserving the existing explicit environment overrides and every build,
startup-state, readiness, and listener-ownership fence.

Add one ordered, lease-fenced SQLite migration that creates a partial index on
`delivery_recoveries(replacement_reply_id)` where the value is non-null. Bump
the canonical schema epoch, support one-step upgrade from the deployed epoch,
and keep fresh-baseline and upgraded catalogs fingerprint-equivalent.

Keep delivery diagnostics and `/status` counters unchanged, but log individual
diagnostic correlation at debug. Metrics remain info, so successful bounded
latency measurements stay visible without retry/yield log amplification.

The design was auto-selected under the active goal's autonomous/default
authority. It changes three existing constants/boundaries and introduces no
new queue, cache, timer, worker, table, retry path, or runtime state.

## User Stories

### SCN-1: Start waits for the service's real startup contract

With default configuration, `swarm:start` waits up to 90 seconds for two
healthy identity/ownership samples and readiness, matching restart. An explicit
`SWARM_SERVICE_START_TIMEOUT_MS` still shortens or extends only that invocation.

### SCN-2: Replacement recovery lookup is indexed after every schema route

A fresh database and a database at the deployed prior epoch both end with the
partial replacement index, ordered migration marker, current metadata epoch,
and a query plan that searches the index rather than scanning the recovery
table. Reopening the current schema remains a zero-step fast path.

### SCN-3: Diagnostic details are opt-in while counters stay operational

Every stale attempt and maintenance yield still increments the bounded trace
snapshot. A debug logger receives exact safe correlation; an info logger does
not emit per-occurrence diagnostic records. Latency metrics remain info.

## Implementation Decisions

### INV-1: Timeout changes only observation budget

The longer default does not weaken identity, startup-completion, readiness, or
listener-PID verification and does not restart or kill a process after a probe
timeout. Explicit positive-millisecond overrides preserve current semantics.

### INV-2: Schema performance changes are ordered and fingerprinted

The index is declared once in the ordered migration registry under a new marker.
Migration runs under the existing exclusive lease fence. Canonical metadata is
recorded only after index creation and schema validation; no recovery row is
rewritten or backfilled.

### INV-3: Observability level does not change diagnostic state

`DeliveryLatencyTrace` remains the sole owner of counters and correlation
sanitization. The logger adapter changes only severity. No sampling state,
aggregation timer, or duplicate counter is added.

### ARCH-1: Existing owners retain their deep interfaces

Lifecycle CLI owns operator wait budgets; the migration registry owns physical
schema evolution; the service logger owns presentation severity. Domain,
Gateway, Delivery Ring, and persistence semantics remain unchanged.

## Testing Decisions

References: SCN-1, SCN-2, SCN-3, INV-1, INV-2, INV-3, ARCH-1

- Add a pure lifecycle contract assertion that the default start and restart
  budgets are both 90 seconds, while existing integration tests continue to
  prove explicit short overrides and safety fences.
- Add fresh and prior-epoch migration tests for marker/index installation,
  idempotent fast reopen, canonical fingerprint parity, and indexed query plan.
- Add service-logger tests proving diagnostic records are debug, metrics remain
  info, safe correlations remain bounded, and trace snapshot counters still
  advance.
- Run affected tests, typecheck, build, architecture/docs checks, the full
  Vitest suite, artifact validation, immutable install, and online comparison.

## Out of Scope

No `/status` stale-while-revalidate redesign, readiness semantics change,
systemd timeout change, query rewrite, recovery retention cleanup, ANALYZE,
additional index, log aggregation timer, slow-transaction suppression, empty
Ring eviction, dependency upgrade, or production SQLite hand edit is included.

## Further Notes

Workspace mode is in-place inside the existing isolated clean worktree
`/tmp/herdr-agent-swarm-main-ring-stability-20261012`, branch `main`, starting
revision `b791a361c262e51618ff0807b9a120e5165d9dba`. The original checkout remains
untouched. The deployed build at baseline is
`sha256:be8a0deec294c031827a37658c7035b832de14820b23d28eca94f278d2d48c23`
and `/ready` is ready.

```spec-coder-verification
{"record_id":"273594fe84e54378879a84509c16b969","command":["/usr/bin/npx","vitest","run","tests/service-lifecycle.test.ts","tests/service-logger.test.ts","tests/sqlite-migrations.test.ts"],"exit_code":0,"status":"captured","observed_at":"2026-10-12T22:36:53.382395+00:00","result":"3 files and 195 tests passed"}
```
