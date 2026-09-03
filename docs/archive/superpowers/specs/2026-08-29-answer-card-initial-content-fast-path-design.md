# Answer Card Initial Content Fast Path Design

## Status

Approved for implementation. The user authorized the recommended approach to proceed without per-batch confirmation.

## Problem

Continuation and rebuild cards call `renderRequestAnswerCard` with already-rendered canonical `initialContent`. The renderer nevertheless rebuilds structured answer text, strips terminal status, normalizes Markdown, and truncates the entire accumulated answer before discarding that work. Long multi-page answers therefore repeat full-answer scans for each new card.

## Selected design

When `options.initialContent` is defined, use it as the card content before evaluating any answer-derived expression. The fallback path remains byte-for-byte equivalent for ordinary initial and update renders. Metadata, progress, actions, streaming configuration, and headers remain shared.

Use `!== undefined` rather than truthiness so an intentionally empty canonical page remains authoritative. A test supplies throwing getters for answer fields and verifies that rendering succeeds with the provided content, proving the expensive path is skipped.

## Alternatives rejected

- Cache normalized answers on the Run Card: adds persistence/state invalidation for a local rendering issue.
- Optimize Markdown parsing first: broader work overlaps current uncommitted `lark-markdown.ts` changes.
- Accept the redundant scan: continuation cost grows with total accumulated answer size and page count.

## Tests and acceptance

- `initialContent` renders without reading answer, answer segments, or answer draft.
- Empty `initialContent` remains authoritative.
- Existing Answer Card rendering tests pass unchanged.
- Focused tests, typecheck, build, and the full suite pass.

## Non-goals

- Changing Markdown normalization or pagination algorithms.
- Changing card appearance, content limits, or durable offsets.
- Deploying while unrelated runtime changes remain uncommitted.
