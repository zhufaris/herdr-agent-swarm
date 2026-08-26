# Durable Outbox Lane Quarantine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Execute this plan task-by-task inline; this repository session forbids subagent delegation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist lane quarantine decisions so failed Answer sequences cannot be bypassed, safe snapshot successors can continue, and operators can diagnose stalled delivery.

**Architecture:** `SqliteBindingStore` owns one atomic dead-letter/quarantine transition and durable diagnostics. `LarkOutboxDispatcher` classifies the delivery error, invokes that transition, and emits an Answer checkpoint only when reconstruction is required. Existing lane-head triggers remain the pending-row index but exclude pending rows in an active quarantine.

**Tech Stack:** TypeScript, Node.js 22+, SQLite WAL/triggers, Vitest, Pino.

**Spec:** `docs/superpowers/specs/2026-08-26-outbox-lane-quarantine-design.md`

## Global Constraints

- Do not alter prompt dispatch, steering, Herdr authority, Answer page size, or CardKit typewriter settings.
- Never include card payload, prompt text, raw Lark response, or credentials in diagnostics.
- Transient pending failures preserve lane order and backoff.
- Answer stream successors never bypass a failed sequence.
- Multi-row dead-letter, quarantine, successor dismissal, and lane-head changes are transactional.

---

### Task 1: Durable quarantine model and migration

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/store/sqlite-records.ts` if row mapping is separated
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Produces: `OutboxLaneClass`, `OutboxQuarantineAction`, `OutboxLaneQuarantine`, and `OutboundFailureTransition`.
- Produces: `OutboxStore.markOutboundReplyFailedWithQuarantine(id, error, metadata, retryDelayMs?)`.

- [ ] Write store tests proving schema creation is idempotent and a permanent Answer stream failure atomically dead-letters the head, creates one active quarantine, dismisses unsafe later content/finish rows, and retains a pending continuation create.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts` and confirm the new assertions fail before implementation.
- [ ] Add the quarantine table, indexes, migration version, domain types, and one transaction-owned failure method. Derive lane class from persisted row facts; do not accept it from callers.
- [ ] Make lane-head trigger selection exclude rows whose lane has an active non-bypassable quarantine. Rebuild lane heads during migration.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts` and confirm the new tests pass.

### Task 2: Lane-specific release policy

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: `OutboundFailureTransition`.
- Produces: atomic actions `blocked`, `released_newer_snapshot`, and `rebuild_answer`.

- [ ] Add failing tests for Main Card newer-version release, coalesced generic card-update release, immutable creation blocking, repeated failure idempotency, and manual retry/dismiss quarantine release.
- [ ] Run the focused store tests and verify failures identify the missing policies.
- [ ] Implement policy using the failed persisted row, successor kind/version, Answer page state, and target role. Never infer safety from an error string.
- [ ] Update `changeDeadLetter` so manual retry restores the failed row as the lane head and manual dismiss applies the same policy atomically.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts`.

### Task 3: Dispatcher integration and Answer reconstruction wake

**Files:**
- Modify: `src/events/lark-outbox-dispatcher.ts`
- Modify: `src/domain/ports.ts`
- Test: `tests/lark-outbox-dispatcher.test.ts`
- Test: `tests/answer-page-recovery.integration.test.ts`

**Interfaces:**
- Consumes: `markOutboundReplyFailedWithQuarantine`.
- Produces: `onAnswerCheckpoint(promptId, version)` when transition action is `rebuild_answer`.

- [ ] Add failing dispatcher tests proving permanent Answer failure emits one reconstruction checkpoint, repeated scans do not deliver later sequences, transient backoff emits no quarantine wake, and unrelated lanes continue concurrently.
- [ ] Run `npx vitest run tests/lark-outbox-dispatcher.test.ts tests/answer-page-recovery.integration.test.ts`.
- [ ] Replace separate permanent/transient store calls with the atomic transition result. Log only IDs, kind, lane class, failure class, action, attempt, and bounded safe error.
- [ ] Emit Answer checkpoint after the transaction commits when requested; retain the per-drain `blockedTargets` guard.
- [ ] Re-run both focused tests.

### Task 4: Bounded operational diagnostics

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/cards/operations-card.ts` if the existing status card exposes lane health
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/health-server.test.ts`
- Test: `tests/operations-card.test.ts` if rendering changes

**Interfaces:**
- Produces: `OperationalSummary.outboxQuarantines` with counts, oldest stalled age, and one sanitized latest record.

- [ ] Add failing tests for active/released counts, lane/failure-class grouping, due-head stalled threshold, bounded reason, and absence of payload/prompt text.
- [ ] Add validated configuration for the stall threshold only if operator tuning is needed; otherwise use one named store constant and document it.
- [ ] Implement aggregate SQL that returns counts and a bounded latest record without payload columns.
- [ ] Update health/status fixtures and operations card only where the new schema requires it.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts tests/health-server.test.ts tests/operations-card.test.ts`.

### Task 5: Documentation, full verification, commit, and rollout

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/specs/2026-08-26-outbox-lane-quarantine-design.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces production evidence and invariant queries.

- [ ] Document lane quarantine authority, Answer ordering, release policy, diagnostics, and operator recovery.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit implementation separately from rollout evidence. Preserve unrelated untracked design files.
- [ ] Build the exact code commit and restart through `herdr plugin action invoke restart --plugin herdr-lark-bridge`.
- [ ] Verify `active=true`, `readiness=ready`, matching expected/observed identity, no duplicate active quarantines, no pending Answer successors bypassing active quarantine, and no stale lane-head rows.
- [ ] Append exact commit/build/test/invariant evidence to the spec, rerun focused tests after the final edit, and commit the evidence.
