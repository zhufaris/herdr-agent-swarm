# Atomic Continuation Queue Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent eligible continuations from exceeding the ordinary prompt queue limit when their steering parent becomes invalid during acceptance.

**Architecture:** Make the SQLite classified-prompt transaction the final authority for both dispatch kind and ordinary queue capacity. Return queue saturation as a discriminated business result that the inbound router converts into user feedback without durable prompt side effects.

**Tech Stack:** TypeScript, SQLite, Vitest

**Spec:** `docs/superpowers/specs/2026-08-29-atomic-continuation-queue-capacity-design.md`

## Global Constraints

- Preserve automatic steering when the ordinary queue is full.
- Preserve duplicate-delivery idempotency before applying the capacity gate.
- Do not insert prompt, Run Card, Answer Card, or outbox rows for `queue_full`.
- Do not wake prompt workers, publish lifecycle events, or record success audit for `queue_full`.
- Keep unrelated dirty Lark and Markdown files out of the commit.
- Do not deploy this batch while unrelated runtime source remains uncommitted.

---

### Task 1: Enforce classified prompt capacity atomically

**Files:**
- Modify: `src/domain/ports.ts`
- Modify: `src/store/sqlite-store.ts`
- Modify: `src/coordinator/inbound-router.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/steering-integration.test.ts`

**Interfaces:**
- Changes: `ClassifiedPromptInput.maxQueueDepth: number`.
- Changes: `ClassifiedPromptAcceptance` becomes an accepted union member with `decision: "automatic_steering" | "ordinary"` or a rejected member with `decision: "queue_full"`, `inserted: false`, and no `prompt` or `view`.
- Consumes: the existing `InboundRouter.reject()` feedback path and `BridgeConfig.maxQueueDepth`.

- [ ] **Step 1: Write the failing store test**

  Add a test that fills the ordinary queue, invalidates the candidate parent, calls `acceptClassifiedPrompt` with `maxQueueDepth: 1`, and expects `{ decision: "queue_full", inserted: false, fallbackReason: "parent_detached" }`. Assert zero rows for the new message in `prompt_jobs`, `run_cards`, and `outbound_replies`.

- [ ] **Step 2: Run the store test to verify red**

  Run: `npx vitest run tests/sqlite-store.test.ts`

  Expected: FAIL because the current transaction inserts the fallback ordinary prompt.

- [ ] **Step 3: Add the classified acceptance union and transactional gate**

  Add `maxQueueDepth` to the input. Preserve the duplicate lookup first. After parent revalidation, count `queued` plus `running` prompts only for an ordinary final decision, matching `countPendingPrompts`. Commit and return `queue_full` before creating durable rows when the limit is reached.

- [ ] **Step 4: Run the store test to verify green**

  Run: `npx vitest run tests/sqlite-store.test.ts`

  Expected: PASS.

- [ ] **Step 5: Write the failing router integration test**

  Reverse the existing parent-invalidation race expectation: assert no continuation prompt, unchanged pending depth, no prompt or steering scheduler wake, no lifecycle event, no success audit, one queue-full feedback reply, and no `lark-message-handling-failed` log. Keep the valid-steering-at-capacity test unchanged.

- [ ] **Step 6: Run the integration test to verify red**

  Run: `npx vitest run tests/steering-integration.test.ts`

  Expected: FAIL until the router handles `queue_full` as normal control flow.

- [ ] **Step 7: Handle `queue_full` in the router**

  Pass `config.maxQueueDepth` into the store call. When the result is `queue_full`, log the classification outcome, send `This topic's prompt queue is full` through the existing rejection path, and return before accessing accepted-only fields or waking workers.

- [ ] **Step 8: Run focused verification**

  Run: `npx vitest run tests/sqlite-store.test.ts tests/steering-integration.test.ts`

  Expected: both files pass.

- [ ] **Step 9: Run repository verification**

  Run: `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check`.

  Expected: all commands exit zero.

- [ ] **Step 10: Commit only this batch**

  Stage the spec/plan and the five implementation/test files only. Commit as `fix: enforce continuation queue capacity`.
