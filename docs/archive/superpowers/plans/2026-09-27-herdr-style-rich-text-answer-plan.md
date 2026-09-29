# Herdr-Style Rich-Text Answer Implementation Plan

**Goal:** Give Primary and Worker rich-text Answer posts a compact Herdr-inspired visual hierarchy with category emoji and a live task-list footer.

**Design:** Keep `AnswerTimelineItem` and `progressEvents` canonical. Add a pure rich-text timeline formatter, reserve footer space during page planning, and pass the current task-list snapshot from both Answer workflows. Do not change the Feishu transport or durable outbox contracts.

## Task 1: Lock the rich-text presentation contract

**Files:**

- Modify `tests/answer-rich-text.test.ts`

1. Add exact assertions for Read, Search, Edit, Ran, Test, Step, and status rows.
2. Cover command deduplication, bounded multiline previews, ANSI removal, and secret redaction.
3. Cover task-list progress, visible-step limits, terminal retention, and cursor placement.

## Task 2: Implement the shared formatter

**Files:**

- Modify `src/runtime/answer-rich-text.ts`
- Modify `src/cards/answer-timeline.ts`

1. Add a pure renderer from structured timeline items to compact Markdown.
2. Use category-specific emoji and concise state markers.
3. Render a bounded quoted result preview without repeating command blocks.
4. Render the current task list as a single replaceable footer.
5. Reserve footer and cursor space before planning the transcript page.

## Task 3: Wire Primary and Worker task state

**Files:**

- Modify `src/coordinator/answer-page-workflow.ts`
- Modify `src/coordinator/worker-turn-card-workflow.ts`
- Modify focused workflow tests as needed

1. Pass each view's current `progressEvents` into rich-text page planning.
2. Preserve identical formatting for Primary and Worker Answers.
3. Keep continuation, frozen-page, and terminal semantics unchanged.

## Task 4: Verify, commit, and deploy

1. Run focused rich-text, workflow, pagination, and recovery tests.
2. Run `npm run typecheck`, `npm run build`, and `npm test`.
3. Commit only presentation changes and tests; preserve unrelated dirty files.
4. Install from a clean detached worktree, restart the service, and verify the exact build identity.
5. Confirm live Answer deliveries use `rich-text-reply` / `rich-text-update` and that no new `primary-answer` CardKit intents are created.
