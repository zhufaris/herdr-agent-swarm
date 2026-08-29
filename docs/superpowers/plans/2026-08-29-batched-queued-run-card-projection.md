# Batched Queued Run Card Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge every changed queued ordinary Run Card for one binding in one SQLite transaction, with one view-version increment and atomic outbox intent per card.

**Architecture:** `QueueFeedbackProjector` derives exact positions and wait feedback from one ordered durable snapshot, reduces each changed card once, and submits a batch to a compare-and-swap store operation. `PromptRunWorkflow` stops emitting per-card position events, while `ConversationViewProjector` preserves the position assigned during acceptance instead of replacing it with broad pending depth.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, durable Lark outbox

**Spec:** docs/superpowers/specs/2026-08-29-batched-queued-run-card-projection-design.md

## Global Constraints

- SQLite remains the durable authority; lifecycle events and wake calls are hints.
- FIFO order remains `prompt_jobs.created_at, rowid` for queued `dispatch_kind = 'turn'` rows.
- One binding still dispatches at most one ordinary turn at a time.
- Do not alter steering eligibility, runtime fences, claim semantics, or detached no-replay behavior.
- Run Card changes and applicable outbox intents must commit in one transaction.
- Preserve `run-card:update:<promptId>:answer:<viewVersion>` idempotency keys and `answer:<promptId>` lanes.
- Do not use `INDEXED BY` in production SQL for this change.
- Preserve unrelated dirty-worktree changes.
- Archive/reset cancellation batching is a separate follow-up and is not part of this implementation.

---

### Task 1: Specify the batch store contract and atomicity

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: `RunCardView`, existing Run Card persistence, and durable outbox reservation.
- Produces: `QueueFeedbackStore.projectQueuedRunCards(input)` returning projected views, stale prompt IDs, and one aggregate outbox-reserved flag.

- [ ] Add the exact contract below to `QueueFeedbackStore`, replacing `projectQueueFeedback`:

```ts
projectQueuedRunCards(input: {
  bindingId: string;
  projections: Array<{ expectedViewVersion: number; view: RunCardView; card: object | null }>;
}): { projected: RunCardView[]; stalePromptIds: string[]; outboxReserved: boolean };
```

- [ ] Add a store test with three queued ordinary prompts where two supplied views change. Assert one call projects both, each card increments exactly once, unchanged siblings stay unchanged, and two Answer Card outbox rows retain their per-prompt keys and lanes.
- [ ] Add a mixed-CAS test where one expected version is stale. Assert the stale prompt ID is returned while a valid sibling commits and reserves its outbox row.
- [ ] Add a no-message test where a changed queued card has no `answerMessageId`. Assert the Run Card commits and `outboxReserved` is false.
- [ ] Add a rollback test by installing a temporary SQLite trigger that aborts the second matching outbox insert. Assert neither Run Card update nor either outbox row survives. Remove the trigger in `finally`.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts` and confirm the new tests fail because the batch method is absent.

---

### Task 2: Implement one transactional batch projection

**Files:**
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/domain/ports.ts`
- Modify: `tests/sqlite-store.test.ts`

**Interfaces:**
- Consumes: the Task 1 `projectQueuedRunCards` contract and existing `saveRunCard`/`enqueueOutboundReply` transaction-aware helpers.
- Produces: an all-or-nothing SQLite batch with per-item CAS skips.

- [ ] Implement `projectQueuedRunCards` with one `BEGIN IMMEDIATE` and one final `COMMIT`. An empty projection list returns empty arrays and false without writing.
- [ ] For each supplied item, reload the current card and skip it as stale unless binding ID, queued phase, and expected view version all match.
- [ ] Save accepted views in input order. When `answerMessageId` and rendered card exist, enqueue `card_update` with the unchanged idempotency key, view version, card role, root message ID, and per-prompt lane derived by the existing helper.
- [ ] Set `outboxReserved` when at least one insert is reserved. Treat idempotency conflicts according to the existing enqueue behavior; never duplicate an intent.
- [ ] Roll back the entire transaction on any thrown database error. Do not swallow the failing item.
- [ ] Run `npx vitest run tests/sqlite-store.test.ts` and require the new batch, stale, no-message, idempotency, and rollback assertions to pass.
- [ ] Run `git diff --check -- src/domain/ports.ts src/store/sqlite-store.ts tests/sqlite-store.test.ts`.

---

### Task 3: Unify queue position and wait feedback projection

**Files:**
- Modify: `src/events/queue-feedback-projector.ts`
- Modify: `tests/queue-feedback-projector.test.ts`

**Interfaces:**
- Consumes: `loadQueueFeedbackInputs(bindingId)` and `projectQueuedRunCards(input)`.
- Produces: one reduced card per changed queued prompt and one store call per binding refresh.

- [ ] Replace the per-card `projectQueueFeedback` calls in test fakes with one `projectQueuedRunCards` call.
- [ ] Add a test snapshot containing at least three queued cards with stale positions and feedback. Assert desired positions are 1, 2, and 3, feedback uses those same positions, each changed card increments only once, and the store receives one batch.
- [ ] Add an unchanged-snapshot assertion: no batch call and no outbound wake.
- [ ] Add a mixed result assertion: one aggregate batch result with outbox work causes exactly one `outboundWork.wake()`, regardless of projected-card count.
- [ ] In `projectBinding`, reduce queue position before queue feedback for each card, render only the final desired card, and collect only semantic changes.
- [ ] Call `projectQueuedRunCards` once when the collection is non-empty. Log only aggregate counts and wake outbound work once when requested.
- [ ] Preserve the current per-binding serialization, startup convergence, 30-second queued timer, and exclusion of terminal/non-ordinary rows supplied by the store snapshot.
- [ ] Run `npx vitest run tests/queue-feedback-projector.test.ts tests/sqlite-store.test.ts`.

---

### Task 4: Remove per-card queue-position event fan-out and acceptance overwrite

**Files:**
- Modify: `src/coordinator/prompt-run-workflow.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `tests/conversation-view-projector.test.ts`
- Modify: `tests/concurrency-controls.integration.test.ts`
- Modify: `tests/steering-integration.test.ts`

**Interfaces:**
- Consumes: existing prompt lifecycle events and the unified projector from Task 3.
- Produces: lifecycle-driven batch convergence without `refreshQueuePositions`.

- [ ] Add a conversation-projector regression test starting from a card at queue position one and publishing `PromptQueued` with `queueDepth: 2`. Assert the Run Card position remains one.
- [ ] Change `runCardChange` so `PromptQueued` does not produce a queue-position Run Card change. Keep the event available for Topic View and queue projector subscribers.
- [ ] Delete `PromptRunWorkflow.refreshQueuePositions` and its calls after claim, completion, failure, and orphan-steering cleanup. Do not change lifecycle event ordering or worker scheduling.
- [ ] Update focused workflow tests to assert turn claim/completion/failure still publish their lifecycle events and that no per-card `RunQueuePositionChanged` event is required for convergence.
- [ ] Assert steering rows never enter the ordinary queued-card snapshot or position sequence.
- [ ] Run `npx vitest run tests/conversation-view-projector.test.ts tests/queue-feedback-projector.test.ts tests/concurrency-controls.integration.test.ts tests/steering-integration.test.ts`.

---

### Task 5: Verify, review, and commit the implementation

**Files:**
- Modify only the files named in Tasks 1 through 4.

**Interfaces:**
- Consumes: the committed design and completed implementation.
- Produces: one independently reviewable implementation commit.

- [ ] Run `npx vitest run tests/sqlite-store.test.ts tests/queue-feedback-projector.test.ts tests/conversation-view-projector.test.ts tests/concurrency-controls.integration.test.ts tests/steering-integration.test.ts tests/prompt-run-safety-scan.test.ts`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check`.
- [ ] Review the diff for one batch transaction, CAS fences, unchanged idempotency keys/lanes, no production `INDEXED BY`, and absence of unrelated files.
- [ ] Commit only the implementation and focused tests as `perf: batch queued run card projections`.

---

### Task 6: Full verification and safe deployment

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: the committed implementation and standalone service lifecycle.
- Produces: full-suite evidence and a matching deployed identity.

- [ ] Run `npm test` and require every test to pass.
- [ ] Run `npm run build` after the final commit and record the generated build ID.
- [ ] Run `npm run swarm:restart` without `--force`; if a running prompt blocks it, schedule one delayed retry that still uses the normal safety gate.
- [ ] Run `npm run swarm:status` after startup convergence and verify active service, `ready` readiness, matching expected/observed identity, zero new failed prompts, and progressing outbox lanes.
- [ ] Confirm no live Lark validation message was synthesized.
