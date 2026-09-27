# Main Card Focus and Answer Motion Implementation Plan

**Goal:** Remove duplicated live information from the Primary Main Card,
improve task-plan scanning, and make Primary and Worker Answer streaming visibly
progress through content-driven `💭` frames.

**Design authority:**
`docs/superpowers/specs/2026-09-27-main-card-focus-and-answer-motion-design.md`.

## Task 1: Lock down Main Card hierarchy and deduplication

**Files:**

- Modify `tests/run-card.test.ts`
- Modify `tests/main-card-activity.test.ts`
- Modify `tests/topic-view.test.ts`

1. Add fixtures containing a live status title, active plan step, duplicate
   progress activity, distinct tool activity, and recent conversation history.
2. Assert that task status and plan precede conversation history.
3. Assert that plan/status-equivalent activity is absent and distinct tool
   activity remains visible once.
4. Assert that an active Agent draft is excluded from Main Card conversation
   history and that the terminal answer is included.
5. Assert that plans up to five steps remain expanded and longer plans keep the
   current step visible while the full list is collapsed.
6. Run these focused tests against the current implementation and confirm the
   exact regressions fail.

## Task 2: Refine Main Card projection and rendering

**Files:**

- Modify `src/domain/topic-view.ts`
- Modify `src/domain/main-card-activity.ts`
- Modify `src/cards/run-card.ts`
- Modify affected projection/startup tests when required

1. Project the user request immediately, but project the Agent response into
   `recentConversation` only for a terminal Run Card.
2. Keep streaming Agent content in the Answer projection and preserve startup
   backfill from durable Run Cards.
3. Render task metadata compactly and display up to five plan steps inline.
4. For longer plans, render the active step in the visible summary and retain
   the complete list in a collapsed panel.
5. Select only one non-plan activity and suppress it when its normalized label
   duplicates the live status title or active plan step.
6. Preserve recovery-first rendering for actionable states and the existing
   five-message history bound.

## Task 3: Add content-driven Answer motion

**Files:**

- Modify `src/runtime/answer-rich-text.ts`
- Modify `src/coordinator/answer-page-workflow.ts`
- Modify `src/coordinator/worker-turn-card-workflow.ts`
- Modify `tests/answer-rich-text.test.ts`
- Modify Primary and Worker rich-text workflow tests

1. Replace the single active marker with deterministic frames `💭`, `💭·`,
   `💭··`, and `💭···` selected from the durable view version.
2. Pass the current view version from both Primary and Worker workflows into
   the shared renderer.
3. Keep terminal and frozen pages marker-free.
4. Lower the rich-text refresh guard to 750 ms and 16 new characters while
   preserving the newline rule and unchanged-content suppression.
5. Do not add heartbeat timers or timer-only outbox records.

## Task 4: Verify and release

1. Run focused Main Card, Topic View, Answer renderer, Primary Answer, Worker
   Answer, startup convergence, event projection, and SQLite tests.
2. Run `npm run typecheck`, `npm run architecture:check`, `npm run docs:audit`,
   `npm run build`, and the full Vitest suite.
3. Confirm any unrelated full-suite failure against the recorded baseline.
4. Commit without an automated co-author trailer and record the exact commit
   and build ID.
5. Install the immutable release, inspect the active-work safety gate, activate
   only under current authorization, and verify exact runtime identity plus
   `readiness.status=ready`.
6. Inspect durable Main Card and Answer payload metadata without exposing user
   content or secrets.
