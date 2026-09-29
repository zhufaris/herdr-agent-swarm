# Rich-text Answer Adaptive Refresh Implementation Plan

**Goal:** Make active rich-text Answer updates feel smoother while retaining
content-driven delivery, Markdown safety, and per-page outbox ordering.

**Design authority:**
`docs/superpowers/specs/2026-09-27-rich-text-answer-adaptive-refresh-design.md`.

## Task 1: Specify the adaptive refresh policy

**Files:**

- Modify `tests/answer-rich-text.test.ts`
- Modify `src/runtime/answer-rich-text.ts`

1. Replace fixed-threshold assertions with a 500 millisecond hard floor.
2. Add cases for eight-character deltas, sentence boundaries, line boundaries,
   and the 1,200 millisecond maximum wait for non-empty deltas.
3. Add cases proving cursor-only changes and unchanged documents do not
   refresh.
4. Add a non-append mutation case representing a tool or task state change.
5. Implement the deterministic policy in `shouldRefreshRichText` without a
   timer or persistence change.

## Task 2: Verify projection boundaries

**Files:**

- Modify Primary or Worker projection tests only if existing coverage does not
  exercise the shared policy sufficiently.

1. Confirm Primary and Worker projections continue to call the shared refresh
   policy.
2. Preserve incomplete-Markdown filtering, terminal updates, frozen pages,
   continuation behavior, and lane ordering.
3. Run focused rich-text, projection, and outbox tests.

## Task 3: Verify and release

1. Run typecheck, architecture check, documentation audit, the full Vitest
   suite, and build.
2. Commit without an automated co-author trailer.
3. Install an immutable release.
4. Inspect the active-work safety gate and activate under the user's standing
   authorization.
5. Verify exact commit, build identity, readiness, and production Answer update
   progression without exposing message bodies or secrets.
