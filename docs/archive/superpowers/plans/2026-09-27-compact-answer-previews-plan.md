# Compact Answer Previews Implementation Plan

**Goal:** Keep Answer cards concise by rendering bounded Tool-result previews and the latest three safe intermediate Agent messages, without truncating canonical persisted timeline data.

**Design authority:** `docs/superpowers/specs/2026-09-27-compact-tool-result-preview-design.md`.

## Invariants

- `AnswerTimelineItem.result` and agent-message Markdown remain unchanged in SQLite.
- Reasoning and private protocol records remain excluded before timeline projection.
- Final answers and oversized commands retain section-aware pagination.
- Frozen pages, cursor compatibility, outbox ordering, and prompt execution do not change.
- CardKit and `rich_post` consume the same prepared presentation items.

## Task 1: Specify the compact presentation transform

Add focused renderer tests for 3-line successful/running Tool results, 10-line failed results, exact omitted-line counts, CRLF and blank lines, long single-line bounds, latest-three intermediate messages, and full final answers. Replace tests that expect Tool results to create continuation pages.

## Task 2: Implement one shared presentation transform

Extend the existing presentation-only `prepareAnswerTimelineItems` transform. Redact and strip ANSI before counting, compact Tool results by state, mark intermediate messages with a thinking/progress emoji, suppress older intermediate messages while retaining their canonical item positions, and leave final answers untouched. Apply a deterministic per-line character bound.

## Task 3: Preserve pagination and recovery behavior

Keep command and final-answer pagination section-aware. Ensure compacted Tool results fit without result continuation pages, legacy `resultPreview` remains readable, cursor movement remains stable, and SQLite reopen tests still prove the canonical result was not rewritten.

## Task 4: Validate and release

Run focused CardKit, rich-text, page-planner, Primary/Worker workflow, and SQLite suites, followed by typecheck, build, architecture check, and the full test suite. Review and commit only owned hunks. Install and force-restart only because the user has already explicitly requested the operational rollout for this change.
