# Bounded Detached Prompt Recovery Implementation Plan

> Execute inline. This repository session forbids sub-agent delegation.

**Goal:** Release a binding FIFO after three durable, qualifying recovery
observations prove that an identity-less detached Prompt cannot be associated
with a Core turn, without ever replaying Prompt text.

**Architecture:** The coordinator obtains current Core receipt and Herdr runtime
evidence. A deep Prompt recovery store operation owns durable attempt timing,
fence validation, threshold policy, the terminal Prompt transition, projection
updates, outbox reservation, and audit persistence in one transaction.

**Spec:** `docs/superpowers/specs/2026-09-30-detached-prompt-bounded-recovery-design.md`

## Constraints

- Recovery attempts are read-only observations, never Agent submissions.
- Only `legacy_unavailable` receipts can enter this policy.
- Exact turn ownership, working/blocked/unknown runtime, transient Core errors,
  stale binding identity, or no queued successor must fail closed.
- Prompt state, projections, outbox intent, audit state, and attempt cleanup are
  committed atomically on skip.
- CardKit delivery never gates the next Prompt after that commit.
- Preserve unrelated dirty-worktree changes.

## Task 1: Specify the persistence contract with failing tests

**Files:**

- Modify: `tests/sqlite-store.test.ts`
- Modify: `tests/prompt-run-safety-scan.test.ts`

- [ ] Prove first and second due observations persist without terminalizing.
- [ ] Prove the third due observation atomically skips and reserves delivery.
- [ ] Prove duplicate early observations are deferred without incrementing.
- [ ] Prove attempts survive store reopen.
- [ ] Prove exact identity, changed fences, missing successor, and non-idle
  runtime evidence remain ineligible.
- [ ] Prove coordinator wake behavior occurs only after committed skip.

## Task 2: Add durable attempt storage and migration

**Files:**

- Modify: `src/store/sqlite/schema.ts`
- Modify: `src/store/sqlite/migrations.ts`
- Modify: `src/store/sqlite/lease-store.ts`
- Modify: `src/store/sqlite-integrity.ts` if an orphan check is required
- Modify: `src/store/sqlite-records.ts` only if a shared record type is useful

- [ ] Add `detached_prompt_recovery_attempts` with Prompt ownership and runtime
  fences, attempt count, and first/last/next timestamps.
- [ ] Make migration additive and idempotent for existing databases.
- [ ] Include the table in application-write lease fencing.
- [ ] Cascade or explicitly clean terminal Prompt attempt rows.

## Task 3: Deepen the Prompt recovery store

**Files:**

- Modify: `src/domain/ports/prompt.ts`
- Modify: `src/domain/ports/prompt-run.ts`
- Modify: `src/store/sqlite/prompt-recovery-store.ts`
- Modify: `src/store/sqlite/prompt-capability-store.ts`

- [ ] Replace the time-only `autoSkipDetachedPrompt` interface with one
  intention-revealing operation for a qualifying legacy recovery miss.
- [ ] Recheck FIFO head, successor, generation, Pane, session, Prompt state,
  and absent exact-turn identity inside its transaction.
- [ ] Persist attempts with 30-second then 60-second bounded backoff.
- [ ] On the third attempt or existing maximum-age fallback, reuse one private
  terminalization path for Run/Topic projection, outbox, and audit updates.
- [ ] Return `stale`, `deferred`, `observed`, or `skipped` with only the data the
  coordinator needs.

## Task 4: Wire the coordinator without broadening policy

**Files:**

- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: composition only if the store interface requires it

- [ ] Keep exact-turn and native receipt recovery ahead of bounded skip.
- [ ] Call the store only after a successful `legacy_unavailable` receipt and a
  fresh exact Pane/session `idle` or `done` observation.
- [ ] Log persisted attempt count and next due time without Prompt text.
- [ ] Wake outbound delivery only when an outbox effect was reserved.
- [ ] Wake the binding FIFO only after `skipped` commits.

## Task 5: Document and verify

**Files:**

- Modify: `docs/architecture.md`
- Modify: `config/runtime.example.yaml` only if comments need clarification

- [ ] Document the distinction between dispatch attempts and recovery
  observations.
- [ ] Run focused Prompt recovery and safety-scan tests.
- [ ] Run SQLite migration/store tests.
- [ ] Run `npm run typecheck` and `npm run build`.
- [ ] Run architecture-boundary tests and `git diff --check`.
- [ ] Run the complete Vitest suite.
- [ ] Inspect the final diff for replay paths, raw Prompt logging, and accidental
  unrelated changes before considering installation.
