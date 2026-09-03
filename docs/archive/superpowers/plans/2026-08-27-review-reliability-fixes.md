# Review Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix orphaned streaming Answer convergence, final folded-card dead-letter recovery, and unbounded TraeX transcript discovery.

**Architecture:** Keep durable aggregate transitions in `SqliteBindingStore`, then reuse `AnswerPageWorkflow` for post-commit Answer convergence. Reopen the stable final-fold outbox intent in place, and keep transcript path caching and bounded traversal private to `TraexTranscriptReader`.

**Tech Stack:** TypeScript, Node.js 22+, node:sqlite, Vitest, Zod

**Spec:** `docs/superpowers/specs/2026-08-27-review-reliability-fixes-design.md`

## Global Constraints

- Never replay a prompt after it may have reached TraeX.
- Persist workflow state before attempting Lark delivery.
- Preserve per-Answer outbox ordering and canonical Answer source offsets.
- Do not add a schema migration or background worker.

---

### Task 1: Converge orphaned CardKit Answer pages

**Files:**
- Modify: `src/coordinator/herdr-runtime-reconciler.ts`
- Modify: `src/main.ts`
- Test: `tests/herdr-runtime-reconciler.test.ts`

**Interfaces:**
- Consumes: `OrphanBindingProjectionResult.updatedPromptIds` and `AnswerPageWorkflowPort.converge(promptId)`
- Produces: an optional `convergeAnswer(promptId: string): Promise<void>` reconciler dependency

- [x] **Step 1: Write a failing reconciler test**

Create a running prompt whose initial streaming card has been delivered, make its pane disappear, and assert that the injected convergence callback receives the prompt ID after the durable run card becomes `failed`.

- [x] **Step 2: Run the focused test and verify red**

Run: `npx vitest run tests/herdr-runtime-reconciler.test.ts`

Expected: FAIL because orphan reconciliation never invokes Answer convergence.

- [x] **Step 3: Implement post-commit convergence**

Add the optional callback to reconciler options and, after `orphanBindingWithProjection` returns `orphaned`, invoke it once for every `updatedPromptId`. Isolate failures per prompt and log them without undoing the durable orphan transition. Wire the production callback to `answerPages.converge(promptId)` in `src/main.ts`.

- [x] **Step 4: Run the focused test and verify green**

Run: `npx vitest run tests/herdr-runtime-reconciler.test.ts tests/answer-page-workflow.test.ts`

Expected: PASS.

### Task 2: Reopen a dead-lettered final folded-card intent

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Test: `tests/answer-page-workflow.test.ts`
- Test: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: `AnswerPageStore.reserveFinalAnswerCardUpdate(...)`
- Produces: the existing `AnswerPageReservationOutcome`, returning `reserved` when an existing dead-lettered or dismissed row is reopened

- [x] **Step 1: Write a failing recovery test**

Finish a CardKit page, reserve its folded update, force that row to `dead_letter`, reconverge the Answer, and assert that the same row is pending with retry metadata cleared and the latest payload retained.

- [x] **Step 2: Run the focused test and verify red**

Run: `npx vitest run tests/answer-page-workflow.test.ts tests/sqlite-store.test.ts`

Expected: FAIL because any existing idempotency key currently returns `waiting`.

- [x] **Step 3: Implement state-aware reservation**

Read the existing row by idempotency key. Return `waiting` for pending and delivered rows. For dead-lettered or dismissed rows, update the same row to `pending`, reset attempts and failure metadata, replace payload/view version, set `next_attempt_at` to now, refresh its lane head, and return `reserved`. Insert normally when no row exists.

- [x] **Step 4: Run the focused test and verify green**

Run: `npx vitest run tests/answer-page-workflow.test.ts tests/sqlite-store.test.ts tests/lark-outbox-dispatcher.test.ts`

Expected: PASS.

### Task 3: Bound and cache transcript discovery

**Files:**
- Modify: `src/runtime/traex-transcript.ts`
- Test: `tests/traex-transcript.test.ts`

**Interfaces:**
- Consumes: `TraexTranscriptReader.open(session)`
- Produces: the same `TraexTranscriptOpenResult`; lookup-budget exhaustion uses terminal fallback reason `transcript_validation_failed`

- [x] **Step 1: Write failing cache and traversal tests**

Verify a second `open()` succeeds from cache after the unrelated directory tree becomes unreadable, verify removal or identity replacement evicts the cached path, verify discovery stops after the second match, and verify a small configurable entry budget yields terminal fallback.

- [x] **Step 2: Run the focused test and verify red**

Run: `npx vitest run tests/traex-transcript.test.ts`

Expected: FAIL because every lookup recursively scans the full tree and there is no shared budget.

- [x] **Step 3: Implement private cache and bounded traversal**

Add `maxDiscoveryEntries` to `TraexTranscriptReaderOptions` with a conservative default, keep a `Map<string, string>` cache, validate cached paths against the canonical root and matching metadata, and implement traversal with a shared `{ visited, stopped, exhausted }` state that propagates ambiguity and budget exhaustion across recursion.

- [x] **Step 4: Run the focused test and verify green**

Run: `npx vitest run tests/traex-transcript.test.ts`

Expected: PASS.

### Task 4: Final verification

**Files:**
- Verify only

- [x] **Step 1: Run affected tests**

Run: `npx vitest run tests/herdr-runtime-reconciler.test.ts tests/answer-page-workflow.test.ts tests/sqlite-store.test.ts tests/lark-outbox-dispatcher.test.ts tests/traex-transcript.test.ts`

Expected: PASS.

- [x] **Step 2: Run static and production build checks**

Run: `npm run typecheck && npm run build`

Expected: exit code 0 and a generated `dist/build-info.json`.

- [x] **Step 3: Run the complete suite**

Run: `npm test`

Expected: all test files and tests pass.
