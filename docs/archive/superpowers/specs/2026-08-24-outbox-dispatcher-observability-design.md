# Outbox Lane and Dispatcher Observability

## Status

Approved for implementation. This is a diagnostic-only follow-up to outbound
intent and delivery separation.

## Problem

`/status` currently reports only the number of pending and blocked outbox lane
heads plus the oldest head timestamp. An operator cannot distinguish ordinary
retry backoff from a stale lane, a dispatcher that is no longer scanning, or a
recent delivery failure. The durable store and process-local dispatcher each
hold part of that answer, but neither exposes a complete safe diagnostic view.

## Decision

Expose two complementary, sanitized views through `/status`:

- SQLite `outboxLanes` describes durable lane-head state. It adds
  `eligible`, `nextAttemptAt`, and `oldestHeadAgeSeconds` to the existing
  `pending`, `blocked`, and `oldestHeadAt` fields. Ages are calculated when the
  summary is read, rounded down to non-negative whole seconds.
- `outboxDispatcher` describes this process's delivery worker. It contains
  `state`, `activeDeliveries`, `scanPending`, `lastScanAt`, `lastScanOutcome`,
  `lastDeliveryAt`, and `lastDeliveryFailureAt`.

No lane key, message identifier, prompt identifier, payload, error text, or
credential is exposed by either view. Existing structured failure logs remain
the place to correlate a specific failed delivery.

## Durable lane semantics

The lane summary considers only the first pending row in each lane because
strict in-lane ordering prevents later rows from being actionable. At the time
of the query:

- `pending` is the number of lane heads.
- `eligible` is the number whose `next_attempt_at` is due.
- `blocked` is the number with a prior error or a future retry time. This keeps
  the established meaning and may overlap with `eligible` after a retry becomes
  due.
- `nextAttemptAt` is the earliest future retry time among lane heads, or null.
- `oldestHeadAt` is the oldest lane-head creation time, or null.
- `oldestHeadAgeSeconds` is null when there are no heads.

The summary is observational only. It does not claim rows, modify retry timing,
or influence dispatcher scheduling.

## Dispatcher snapshot semantics

`LarkOutboxDispatcher.snapshot()` returns a copy of bounded process-local state:

```ts
interface OutboxDispatcherDiagnostics {
  state: "idle" | "running" | "stopping";
  activeDeliveries: number;
  scanPending: boolean;
  lastScanAt: string | null;
  lastScanOutcome: "idle" | "delivered" | "failed" | null;
  lastDeliveryAt: string | null;
  lastDeliveryFailureAt: string | null;
}
```

`running` means a scan loop is executing; it does not imply an active network
call. `lastScanAt` records completion of a durable scan pass. A pass is
`delivered` if at least one row was delivered, `failed` if at least one delivery
failed, and otherwise `idle`; failure takes precedence when a pass contains both
outcomes. Delivery timestamps change only after the corresponding durable store
transition succeeds. A scan-level store exception records a failed scan before
the existing rejection propagates to the dispatcher's caller/logging path.

The snapshot is not persisted and resets on process restart. SQLite remains the
authority for queued and failed work.

## Health integration and failure isolation

The composition root passes the dispatcher diagnostics capability to the health
server. `/status` adds `outboxDispatcher`; `/health` and `/ready` are unchanged.
If obtaining the dispatcher snapshot unexpectedly throws, `/status` returns a
bounded `{ error }` object for that diagnostic section and marks its top-level
status degraded. This does not alter readiness or stop workflow processing.

## Non-goals

- Changing retry, ordering, dead-letter, or Answer Card gate behavior.
- Adding Prometheus metrics, a history table, or per-lane identifiers.
- Persisting dispatcher process state.
- Treating diagnostic timestamps as workflow authority.
- Restarting or deploying the managed service.

## Verification

Tests cover empty, eligible, retry-blocked, and failed lane heads; dispatcher
idle, active, delivered, failed, and stopping snapshots; `/status` sanitization
and diagnostic failure isolation; and the invariant that `/ready` is unchanged.
The full suite, typecheck, build, and diff check follow focused tests.
