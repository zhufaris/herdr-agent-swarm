# Rich-text Answer Single-title and Activity Rendering Implementation Plan

**Goal:** Make new Primary and Worker rich-text Answers use one native Feishu
title, safe highlighted Bash command blocks, and the `💭` active marker.

**Design authority:**
`docs/superpowers/specs/2026-09-27-rich-text-answer-single-title-and-activity-design.md`.

## Task 1: Lock down the regressions

**Files:**

- Modify `tests/feishu-rich-text.test.ts`
- Modify `tests/answer-rich-text.test.ts`
- Modify the nearest Primary and Worker rich-text workflow tests

1. Change Feishu materialization expectations so a document title appears only
   in `zh_cn.title`, never as the first content row.
2. Add command/test fixtures that require fenced Bash blocks, preserved
   multiline commands, safe backtick fences, ANSI removal, and secret redaction.
3. Change active-marker expectations from `▌` to `💭` and retain terminal-page
   no-marker assertions.
4. Run the focused tests against the current baseline and confirm failures for
   both duplicate titles and legacy command/cursor rendering.

## Task 2: Implement the combined renderer

**Files:**

- Modify `src/gateways/feishu/rich-text.ts`
- Modify `src/runtime/answer-rich-text.ts`
- Modify `src/domain/rich-text.ts`

1. Remove the synthetic bold heading from Feishu post content while preserving
   `zh_cn.title`.
2. Render command and test activities with command text as safe Markdown Bash
   fences; retain compact rows for other tools and missing commands.
3. Preserve current fenced-language conversion to Feishu `code_block` elements.
4. Replace the active cursor and initial placeholder marker with `💭`.
5. Do not change canonical timeline items, cursors, page limits, or persistence.

## Task 3: Verify behavior and compatibility

1. Run the focused rich-text, event-card, Primary Answer, Worker Answer, and
   pagination suites.
2. Run typecheck, build, architecture checks, documentation audit, and the full
   Vitest suite.
3. Replay the captured `vdfn` transcript and require one title, tool emoji,
   task-list rendering, highlighted Bash blocks, and correct active/terminal
   markers.
4. Compare any full-suite failure with the known baseline before attributing it
   to this change.

## Task 4: Commit and deploy

1. Commit implementation and tests without an automated co-author trailer.
2. Before installation, record the currently active release and ensure no
   concurrent install has changed it unexpectedly.
3. Install the immutable combined release from this isolated checkout.
4. Restart only under the user's existing deployment authorization and verify
   exact commit, build ID, `readiness.status=ready`, and a newly delivered Answer
   payload. If active work makes a non-forced restart unsafe, report it instead
   of silently changing restart policy.
