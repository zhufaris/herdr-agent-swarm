# Pane-Aligned Answer Card Rendering Implementation Plan

**Goal:** Render Primary Answer tool calls as compact Herdr-like rows while streaming and as ordered collapsed command-detail panels when each page is finalized.

**Architecture:** Keep canonical transcript Markdown and source offsets unchanged. Introduce one pure parser/render model for the exact command block grammar, use its compact projection in source-aware streaming, and use its structured projection in final CardKit cards. Extend Answer-page finalization so rollover pages reserve and deliver their structured update before the continuation card is activated.

## Constraints

- Preserve the structured transcript as the only Answer source.
- Preserve the 9,000-character page limit, canonical `source_start`, redaction, and no-replay behavior.
- Do not change Worker task cards or Main Cards.
- Do not overwrite unrelated worktree changes.

## Tasks

### 1. Pure Answer content render model

Files: `src/cards/final-answer-content.ts`, focused tests.

- Add exact parsing for canonical `◆ **Ran**` command blocks.
- Produce compact Markdown for live streaming and ordered CardKit elements for finalized pages.
- Keep malformed/lookalike content as Markdown.
- Reuse existing output folding and payload bounds.

### 2. Compact source-aware streaming

Files: `src/runtime/lark-markdown.ts`, `src/runtime/answer-stream.ts`, focused tests.

- Collapse recognized command blocks to one-line rows in the render copy.
- Continue choosing page boundaries against the safe detailed representation.
- Preserve monotonic canonical offsets and continuation warnings.

### 3. Final card integration

Files: `src/cards/run-card.ts`, focused tests.

- Render recognized commands as collapsed panels in document order.
- Preserve large ordinary code-block folding.
- Fall back to compact Markdown if adding a panel exceeds the serialized card budget.

### 4. Durable rollover finalization

Files: Answer page domain/store/workflow/outbox tests and implementation.

- Add an explicit finalizing page state or equivalent durable checkpoint.
- Reserve `stream_finish`, structured `card_update`, and continuation creation in one transaction and one Answer lane.
- Activate the continuation only after the preceding structured update is delivered.
- Rebuild incomplete finalization safely on startup and reject writes to immutable pages.

### 5. Verification

- Run focused renderer, Answer workflow, outbox, and SQLite tests.
- Run `npm run typecheck`.
- Run `npm run build`.
- Run `npm test`.
- Inspect the final diff for unrelated changes and invariant regressions.

### 6. Typed activity emoji

Files: `src/cards/final-answer-content.ts`, projector/render tests.

- Keep canonical tool activity text unchanged and add emoji only to the render copy.
- Map recognized `Read`, `Search`, `Edit`, `Skill`, `Wait`, `Agent`, `Tool`, and `Ran` rows through one pure presentation helper.
- Use the same command emoji in compact rows and final collapsed-panel titles.
- Preserve ordinary assistant prose and malformed/lookalike activity text verbatim.
