# Complete Folded Answer Timeline Implementation Plan

**Goal:** Preserve every safe, user-relevant pane output fragment in the durable
Answer timeline and expose it through emoji-labelled, folded Primary and Worker
Answer pages without duplicate wrapper output.

**Design authority:**
`docs/superpowers/specs/2026-09-27-complete-folded-answer-timeline-design.md`.

## Invariants

- Redaction and protocol/reasoning exclusion happen before persistence.
- Stable timeline IDs and canonical sequence remain authoritative.
- Frozen pages are immutable and delivery cursors advance only after delivery.
- Existing checkpoints using `{ itemIndex, markdownOffset }` remain readable.
- The page limit remains 9,000 characters.
- No prompt replay, outbox reordering, or change to `230072` recovery.
- Primary and Worker Answers share the same renderer and page planner.

## Task 1: Lock the durable content and cursor contracts

**Files:**

- Modify `tests/answer-timeline-page.test.ts`
- Modify `tests/answer-timeline-card.test.ts`
- Modify `tests/sqlite-store.test.ts`
- Modify `src/domain/answer-timeline.ts`
- Modify `src/domain/delivery.ts`

Write failing tests for complete tool result content, section-aware continuation,
legacy cursor decoding, emoji headers, expansion defaults, and checkpoint reopen.
Extend tool items with canonical result and optional explicit parent identity.
Extend the timeline cursor with a section and offset while retaining its legacy
fields as a decode-compatible form.

## Task 2: Preserve complete safe output in transcript adapters

**Files:**

- Modify `tests/traex-transcript-projector.test.ts`
- Modify `tests/herdr-events-reader.test.ts`
- Modify `src/runtime/traex-transcript-projector.ts`
- Modify `src/runtime/herdr-events-reader.ts` when that active event-reader work
  is present in the worktree

Write failing tests proving that multi-page stdout/stderr survives projection,
while reasoning, secrets, ANSI, approval protocol, and terminal chrome remain
excluded. Preserve explicit nesting metadata supplied by the event identity or
event contract. Do not infer nesting from command text.

## Task 3: Add presentation-only grouping and summaries

**Files:**

- Modify `tests/answer-timeline-card.test.ts`
- Modify `tests/answer-rich-text.test.ts` or the nearest rich-text renderer suite
- Modify `src/cards/answer-timeline.ts`
- Modify `src/runtime/answer-rich-text.ts`
- Add a focused pure grouping/summary module if keeping this logic in either
  renderer would mix projection and presentation concerns

Render explicit parent-child tools as one group without deleting canonical
rows. Keep distinct parent output visible. Use emoji and deterministic compact
summaries. Expand running and failed items; collapse successful items. Ensure the
active rich-text delivery surface represents the same fold semantics rather than
falling back to flat duplicated lines.

## Task 4: Page commands and results without loss

**Files:**

- Modify `tests/answer-timeline-page.test.ts`
- Modify `tests/answer-page-workflow.test.ts`
- Modify `tests/worker-turn-card-workflow.test.ts`
- Modify `tests/rich-text-answer-workflow.test.ts`
- Modify `src/cards/answer-timeline-page.ts`
- Modify `src/runtime/answer-rich-text.ts`
- Modify Primary and Worker Answer workflows only where required to carry the
  richer cursor unchanged

Split oversized command and result sections at safe boundaries. Repeat the
emoji header with a continuation marker, persist the exact next offset, and
prove reconstruction has neither gaps nor duplicates. Keep late-result handling
and immutable frozen pages intact.

## Task 5: Validate recovery and shared behavior

Run focused suites first:

```bash
npx vitest run \
  tests/answer-timeline-card.test.ts \
  tests/answer-timeline-page.test.ts \
  tests/traex-transcript-projector.test.ts \
  tests/herdr-events-reader.test.ts \
  tests/answer-page-workflow.test.ts \
  tests/worker-turn-card-workflow.test.ts \
  tests/rich-text-answer-workflow.test.ts \
  tests/sqlite-store.test.ts
npm run typecheck -- --pretty false
npm run build
npm run architecture:check
npm test
git diff --check
```

Inspect the final diff against the dirty-worktree baseline and stage only the
feature-owned hunks. Do not install, restart, deploy, or push. A later explicit
operational step should validate the result with one long, nested, tool-heavy
real-user turn.
