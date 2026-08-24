# Outbox Lane and Dispatcher Observability Plan

## Goal

Make retry backlog and dispatcher liveness diagnosable from `/status` without
exposing content or changing readiness and delivery behavior.

## Slices

- [x] Extend `OperationalSummary.outboxLanes` and its SQLite query with eligible
  heads, earliest future retry, and oldest-head age; cover the public store seam.
- [x] Add a sanitized `OutboxDispatcherDiagnostics` contract and
  `LarkOutboxDispatcher.snapshot()`; cover scan, delivery, failure, and shutdown.
- [x] Compose dispatcher diagnostics into `/status` with bounded failure
  isolation while proving `/ready` remains unchanged.
- [x] Update current architecture documentation and run focused tests, full
  tests, typecheck, production build, and diff validation.
- [x] Commit the focused change without restarting or deploying the service.

## Failure scenarios

- A future retry makes all durable lane heads temporarily ineligible.
- One failed lane head blocks later rows in that lane.
- The process has durable pending work but has not completed a recent scan.
- A Lark delivery fails after a scan starts.
- Diagnostic collection itself throws while readiness dependencies remain good.

## Test seams

- `SqliteBindingStore.getOperationalSummary()` for durable aggregate truth.
- `LarkOutboxDispatcher.snapshot()` for bounded process-local diagnostics.
- `/status` for composition and sanitization; `/ready` for non-regression.
