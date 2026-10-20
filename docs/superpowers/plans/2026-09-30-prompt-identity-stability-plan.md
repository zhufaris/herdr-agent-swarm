# Prompt-ID-Only Stability Implementation Plan

> Execute inline. This repository session forbids sub-agent delegation.

**Goal:** Remove receipt-driven Prompt→turn ownership, keep existing native
queue submission ordered and visible in the Agent terminal, bound unverifiable
Prompts without replay, and isolate Answer delivery by page without changing
Herdr Core.

**Architecture:** `prompt_id` is passed unchanged as Core `submission_id` and
is the only managed business identity. Canonical events may carry event-local
turn metadata, but only their `requestSubmissionId` routes lifecycle/output.
SQLite retains one ordered `prompt_jobs` workflow for bridge and Herdr origins.
The existing Core `queuePrompt` path handles non-idle Agent submission. Answer
effects target an exact `answer_pages` row.

**Spec:**
`docs/superpowers/specs/2026-09-30-prompt-identity-stability-design.md`

## Constraints

- Do not modify `/workspace/herdr-core` or its existing
  `/tmp/herdr-core-native-goal-lifecycle` worktree.
- Never infer identity from text, time, queue position, newest turn, or active
  turn.
- Never replay Prompt text after native submission may have occurred.
- Continue using `queuePrompt` while non-idle only when Core advertises native
  queue support and exact session identity is present.
- Keep raw external input separate from managed Prompt identity.
- Preserve unrelated dirty-worktree changes.
- Do not install or restart during source implementation.

## Task 1: Add deterministic Swarm regressions

**Files:**

- Modify: `tests/core-event-recovery.test.ts`
- Modify: `tests/primary-prompt-dispatcher.test.ts`
- Modify: `tests/external-turn-observer.test.ts`
- Modify: `tests/sqlite-store.test.ts`
- Modify: nearest Answer outbox validation/lane tests

- [x] A receipt for Prompt A naming a turn whose canonical event belongs to
  Prompt B must never claim or mutate A.
- [x] Complete receipt turn fields are ignored; receipt lookup never invokes a
  turn claim.
- [x] Repeated equal Prompt text cannot affect routing.
- [x] Matching `requestSubmissionId` updates exactly one Prompt; missing or
  mismatched IDs update none.
- [x] Multiple bridge Prompts are offered to native `queuePrompt` in SQLite
  order while the Agent is working.
- [x] Herdr-origin work is its own `prompt_jobs` entry and cannot consume a
  bridge Prompt by text or position.
- [x] A delayed page-0 update remains valid after page 1 becomes current; a
  wrong page target fails only its page lane.

## Task 2: Remove receipt→turn ownership

**Files:**

- Modify/remove: `src/coordinator/core-event-recovery.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/coordinator/detached-prompt-observer.ts` only where receipt
  recovery currently feeds exact-turn observation
- Modify: `src/domain/ports/prompt-run.ts`
- Modify: Core event runtime adapters only to validate submission IDs already
  present in current contracts

- [x] Replace `recoverDetachedPromptOwnership` with a submission receipt
  classification that validates submission/session fences and ignores all turn
  fields.
- [x] Do not call `claimPromptTranscriptTurn` or `openAtTurn` from receipt
  recovery.
- [x] Let the canonical event pipeline route matching submission events and
  retain same-event turn metadata only as an observation cursor.
- [x] Return explicit pending, cancelled-before-input, unverifiable, mismatch,
  and transient outcomes without Prompt text.
- [x] Keep pre-input cancellation eligible for safe requeue only when current
  durable evidence already proves no terminal write.

## Task 3: Preserve one ordered bridge/external workflow

**Files:**

- Modify: `src/store/sqlite/prompt-dispatch-store.ts` only if current ordering
  tests expose a gap
- Modify: `src/store/sqlite/external-turn-adoption-store.ts`
- Modify: `src/coordinator/primary-prompt-dispatcher.ts`
- Modify: `src/coordinator/external-turn-observer.ts`
- Test: concurrency and SQLite suites

- [x] Keep `execution_origin = 'bridge'` and `'herdr'` in the same Prompt table
  and durable order.
- [x] Submit bridge entries through existing native `queuePrompt` in that order,
  persisting `submissionId = prompt.id` before continuing the drain.
- [x] Reconcile external work before non-native fallback dispatch.
- [x] Require canonical submission ID for managed external adoption.
- [x] Treat no-ID raw external work as a separate unmanaged entry; never match
  queued work by body or position.
- [x] Preserve the one active fallback PTY turn and explicit steering boundary.

## Task 4: Generalize bounded abnormal-Prompt recovery

**Files:**

- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/store/sqlite/prompt-recovery-store.ts`
- Modify: Prompt recovery ports/types and test helpers
- Modify: `docs/superpowers/specs/2026-09-30-detached-prompt-bounded-recovery-design.md`
- Test: safety scan, SQLite, concurrency, and restart suites

- [x] Reuse the durable three-attempt recovery table and backoff.
- [x] Qualify legacy-unavailable, receipt mismatch, observed/terminal without a
  matching canonical event, and persistent prepared state only on a freshly
  idle/done exact runtime.
- [x] Keep transport errors and working/blocked/unknown runtime non-counting.
- [x] Remove the queued-successor prerequisite.
- [x] Atomically terminalize Prompt, Run/Topic projection, page-scoped notice,
  audit, and attempt row on the third qualifying observation.
- [x] Wake the next ordered item only after the transaction; never invoke
  Prompt submission from recovery.
- [x] Ensure detached observation cannot monopolize the process-local binding
  dispatcher.

## Task 5: Fix immutable Answer-page targeting

**Files:**

- Modify: `src/events/outbound-target-validation.ts`
- Modify: delivery intent/types if page identity is not already carried end to
  end
- Modify: `src/domain/ports/outbox.ts`
- Modify: exact-page lookup in `src/store/sqlite/projection-store.ts`
- Modify: outbox composition/test helpers
- Test: Answer page, Lark outbox, lane drain, and SQLite suites

- [x] Require `(promptId, pageIndex, messageId, cardId, elementId)` for existing
  Answer effects.
- [x] Validate against the exact `answer_pages` row, never Run Card current-page
  fields.
- [x] Permit only a previously reserved immutable final revision on a frozen
  older page.
- [x] Quarantine missing/ambiguous/stale targets only in that page lane.
- [x] Prove an old-page failure cannot block a newer page, another Prompt, or
  execution.

## Task 6: Cleanup and documentation

**Files:**

- Modify: `docs/architecture.md`
- Modify: Primary Session and Conversation Projection domain contexts
- Remove: obsolete receipt-only recovery helpers, ports, fixtures, and tests
  after reference checks prove them dead

- [x] Document Prompt-ID-only business identity and same-event runtime metadata.
- [x] Document the existing native queue path for non-idle Agents and one
  bridge/Herdr Prompt workflow.
- [x] Replace receipt→turn and legacy-only skip descriptions.
- [x] Keep exact-turn logic only where raw external observation or legacy audit
  still independently requires it.

## Task 7: Verification and completion audit

- [x] Run focused Core-event recovery, dispatcher, external-turn, SQLite,
  Answer-page, and outbox tests.
- [x] Run TypeScript typecheck and build.
- [x] Run architecture-boundary checks and full Vitest.
- [x] Run `git diff --check` and inspect task-owned hunks within the dirty
  worktree.
- [x] Confirm the Herdr Core worktree has no diff introduced by this task.
- [x] Prove every spec success criterion from current source and test output.
- [x] Do not install or restart until source gates pass and the user separately
  authorizes deployment.

## Task 8: Fence exact-turn observer ownership

**Files:**

- Modify: `src/store/sqlite/prompt-recovery-store.ts`
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: durable Core-event inbox/cursor implementation
- Test: SQLite durable scan, Prompt safety scan, and Core-event cursor suites

- [x] Emit detached-observer hints only for bridge-origin Prompts.
- [x] Defensively ignore a Herdr-origin detached hint at the workflow boundary.
- [x] Accept only identity-compatible already-ingested stale batches and keep
  the durable checkpoint moving forward.
- [x] Rebase a stale in-memory reader to the durable checkpoint after ingestion.
- [x] Re-run full verification after this production-regression follow-up.
