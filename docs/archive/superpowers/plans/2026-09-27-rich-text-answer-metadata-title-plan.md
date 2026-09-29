# Rich-Text Answer Metadata Title Implementation Plan

**Goal:** Add a stable native post title containing project, preferred pane token, and optional Worker name to every rich-text Answer page.

**Design:** Keep title composition pure in the rich-text domain contract. Pass validated persisted identity into initial Answer payload creation and into the shared page planner. Primary derives identity from its binding/run view; Worker derives identity from its Agent instance. Preserve all existing body, pagination, cursor, outbox, and recovery behavior.

## Task 1: Lock the title contract

**Files:**

- Modify `tests/answer-rich-text.test.ts`
- Modify `tests/rich-text-answer-workflow.test.ts`
- Modify focused store tests as needed

1. Cover Primary and Worker titles, continuation suffixes, token preference, Pane ID fallback, normalization, redaction, and bounds.
2. Assert initial placeholder replies already contain the title.
3. Assert active, frozen, continuation, and terminal updates retain the same identity.

## Task 2: Implement shared title composition

**Files:**

- Modify `src/domain/rich-text.ts`
- Modify `src/runtime/answer-rich-text.ts`

1. Define a small Answer metadata input contract.
2. Compose the native post title deterministically with bounded safe segments.
3. Use the same title builder for initial payloads and planned page documents.

## Task 3: Wire Primary and Worker metadata

**Files:**

- Modify Primary Answer creation and continuation paths.
- Modify Worker Answer creation and continuation paths.
- Extend the narrow Worker card store port with read-only Agent instance lookup if required.

1. Primary uses binding project ID and the run view's preferred pane token/PID fallback.
2. Worker uses Agent instance project ID, runtime token/PID fallback, and Worker name.
3. Do not infer identity from Lark content or alter frozen Answer bodies.

## Task 4: Verify, commit, and deploy

1. Run focused rich-text, workflow, store, outbox, and architecture tests.
2. Run `npm run typecheck`, `npm run build`, and `npm test`.
3. Commit only title-related source/tests while preserving unrelated dirty files.
4. Install from a clean detached worktree, restart through the active-work gate unless explicitly forced, and verify exact build identity.
5. Confirm live rich-text payload titles prefer pane tokens and no Answer CardKit or `230001` regression appears.
