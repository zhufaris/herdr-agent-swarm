# Structured Answer Tool Events Implementation Plan

**Goal:** Remove the legacy `◆ Ran` Answer compatibility path so TraeX tool
activity is projected only through stable structured timeline items.

**Design authority:**
`docs/superpowers/specs/2026-09-27-structured-answer-tool-events-design.md`.

## Invariants

- Keep Agent natural-language output in `answerDelta`.
- Keep tool lifecycle updates in `timelineDeltas` with the stable
  `tool:<call_id>` identity.
- Preserve running-to-succeeded and running-to-failed timeline upserts.
- Do not parse or specially render legacy `◆ Ran` Markdown.
- Accept that old text-only transcript snapshots may no longer expose tool
  history.
- Do not rewrite delivered historical cards or replay Agent prompts.
- Do not change Answer pagination, the 9,000-character page limit, outbox
  ordering, or `230072` recovery.

## Task 1: Lock the TraeX projection contract

**Files:**

- Modify `tests/traex-transcript-projector.test.ts`

Add focused expectations proving that tool calls, successful tool results,
failed tool results, and completed command-execution records add no command
Markdown to `answerDelta`. Preserve assertions that assistant prose remains in
the Answer and that the same `tool:<call_id>` timeline item advances from
running to its terminal state.

## Task 2: Remove tool Markdown from Answer projection

**Files:**

- Modify `src/runtime/traex-transcript-projector.ts`

Keep the existing structured timeline projection and stable IDs, but make all
tool-call and tool-result branches contribute no text to `answerDelta`. Remove
helpers that exist only to construct the legacy command Markdown once they are
unused. Leave assistant and final-answer text projection unchanged.

## Task 3: Remove `◆ Ran` rendering compatibility

**Files:**

- Modify `tests/final-answer-content.test.ts`
- Modify `src/cards/final-answer-content.ts`

Replace command-panel compatibility tests with a regression test proving that
literal `◆ **Ran**` content follows ordinary Markdown rendering. Remove the
command heading parser, command-specific folding, truncation, and tool-activity
compaction branches. Preserve ordinary code-block folding and unrelated
activity-row decoration.

## Task 4: Verify architecture and regressions

Run the two focused suites first, then the native Herdr event reader suite to
confirm its already-structured behavior remains unchanged. Run:

```bash
npx vitest run tests/traex-transcript-projector.test.ts tests/final-answer-content.test.ts tests/herdr-events-reader.test.ts
npm run typecheck -- --pretty false
npm run build
npm run architecture:check
npm run docs:audit
npm test
git diff --check
```

Review the final diff against the dirty-worktree baseline and commit only this
plan plus the projector, renderer, and their directly affected tests. Do not
install or restart the live service as part of this implementation.
