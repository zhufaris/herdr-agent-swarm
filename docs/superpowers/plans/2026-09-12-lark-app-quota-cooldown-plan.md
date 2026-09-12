# Lark App Quota Cooldown Implementation Plan

**Goal:** Prevent independent Lark outbox lanes from continuing to call the same
configured Lark app while a durable HTTP 429 cooldown is active.

**Architecture:** Add one SQLite-backed app cooldown module. The claim-fenced
failure transaction records a 429 deadline from the failed row's exact retry
time. Queue selection, direct claim, next-wake calculation, and operational
diagnostics consume that shared state. Dispatcher timing remains an in-memory
wake mechanism, never the source of truth.

## Test seams

- `classifyDeliveryError` for bounded `Retry-After` parsing.
- `SqliteBindingStore` for migration, atomic settlement, selection, claim,
  restart, and operational summary behavior.
- `LarkOutboxDispatcher` with fake Lark and fake time for cross-lane suppression,
  force-scan behavior, and automatic resume.
- `/status` for degraded status with unchanged readiness.

## Task 1: Bound classifier delays

- Add failing table cases for missing, malformed, negative, and over-one-hour
  `Retry-After` values.
- Keep 429 classified as transient and rejected.
- Clamp valid delays to one hour and leave missing/invalid delay undefined so
  the store uses its existing backoff result.

## Task 2: Add durable cooldown schema and module

- Add `lark_delivery_cooldowns` to the latest schema.
- Add idempotent migration 38 for existing databases.
- Introduce a focused SQLite module that reads active state and extends the app
  deadline without shortening it.
- Add migration, reopen, extension, audit-field, and expiry tests.

## Task 3: Settle 429 and cooldown atomically

- Add a store test where an exact claim receives 429 and both the reply retry
  time and app cooldown commit together.
- Add stale-claim and rollback tests proving neither state changes on failure.
- Reuse the exact persisted `nextAttemptAt` as the cooldown candidate; do not
  sample random backoff twice.
- Increment the trigger count only for successfully fenced 429 settlements.

## Task 4: Gate queue selection and claim

- Add tests proving active cooldown suppresses lane listing and direct claim,
  while expired cooldown restores both without row rewrites.
- Make the next-wake query return the later of the earliest lane deadline and
  active app deadline.
- Preserve `force=true` as row-backoff bypass only; the durable claim gate remains
  authoritative.

## Task 5: Integrate dispatcher resume behavior

- Add a fake-time dispatcher test where one 429 prevents another independent
  lane from calling Lark before expiry.
- Prove force scans and a reopened store cannot bypass the cooldown.
- Resume automatically after the durable deadline plus `0..250ms` local jitter.
- Prove multiple in-flight 429 responses can only extend the deadline.

## Task 6: Add diagnostics and health policy

- Extend `OperationalSummary` with bounded app cooldown state.
- Report active, deadline, remaining time, trigger count, and safe status/code.
- Degrade `/status` while active without changing `/ready`.
- Add health tests for active and expired state without exposing reason payloads.

## Task 7: Documentation, validation, and commit

- Update architecture and stability roadmap completion records.
- Run focused classifier, SQLite, dispatcher, and health suites.
- Run `npm run typecheck`, `npm run build`, `npm run architecture:check`,
  `npm test`, and `git diff --check`.
- Review and commit the implementation as one independent slice with the
  required TRAE CLI co-author trailer.
- Do not push, install, restart, deploy, or send real Lark messages.
