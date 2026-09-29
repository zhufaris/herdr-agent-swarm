# Main Card Density and Answer State Implementation Plan

**Goal:** Make the Primary Main Card more action-oriented and compact, and make
rich-text Answer progress easier to scan across active and terminal states.

**Design authority:**
`docs/superpowers/specs/2026-09-27-main-card-density-and-answer-state-design.md`.

## Task 1: Lock down Main Card density

**Files:**

- Modify `tests/run-card.test.ts`
- Modify `src/cards/run-card.ts`

1. Assert that the current Answer action appears before recent conversation and
   uses active or terminal wording.
2. Assert that an empty Worker section is collapsed while active Workers remain
   expanded with their controls.
3. Assert that Runtime is collapsed and keeps the operator identity fields.
4. Add multiline conversation fixtures and verify per-message line bounds plus
   a larger newest-message character budget.
5. Implement the pure CardKit rendering changes without changing Topic state.

## Task 2: Lock down Answer state summaries

**Files:**

- Modify `tests/answer-rich-text.test.ts`
- Modify Primary and Worker rich-text workflow tests
- Modify `src/runtime/answer-rich-text.ts`
- Modify `src/coordinator/answer-page-workflow.ts`
- Modify `src/coordinator/worker-turn-card-workflow.ts`

1. Add tests for running, successful, and failed tool-result line selection.
2. Add tests for long-plan active and failed step selection.
3. Add tests for terminal state and duration in Primary and Worker Answers.
4. Assert that frozen continuation pages remain terminal-summary-free.
5. Change continuation titles to explicit page numbering.
6. Implement bounded, redacted render transforms and pass existing timestamps
   and phases into the shared planner.

## Task 3: Verify and release

1. Run focused Main Card and rich-text Answer tests.
2. Run typecheck, architecture check, documentation audit, build, and the full
   Vitest suite.
3. Commit without an automated co-author trailer.
4. Install an immutable release and inspect the active-work safety gate.
5. Activate under the user's standing authorization and verify exact commit,
   build identity, and readiness.
6. Inspect production payload metadata without exposing user text or secrets.
