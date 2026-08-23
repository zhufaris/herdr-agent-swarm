# Terminal Streaming Answer Card Implementation Plan

## Objective

Implement the approved terminal-streaming design in
`docs/superpowers/specs/2026-08-23-terminal-streaming-answer-card-design.md`.
Create only one Answer card per new prompt, preserve sanitized visible Herdr
terminal output, and deliver updates through a fixed CardKit Markdown element.

## Task 1: Make terminal observations safe and append-only

Modify `src/runtime/traex-output-parser.ts` and terminal-output helpers. Add
focused tests proving snapshot overlap removal, terminal redraw normalization,
internal-protocol and reasoning removal, in-place secret redaction, bounded
fragments, and retention of Working/tool/shell/approval/answer text. Return an
append delta plus the normalized snapshot needed for the next observation.

## Task 2: Collapse new prompts to one Answer projection

Stop creating and updating Request cards for new prompts. Remove execution-plan
rendering and progress injection/parsing. Reduce Answer state to a sanitized
cumulative stream containing lifecycle notices and terminal output. Update the
reducer, renderer, coordinator, and integration tests so repeated observations
append exactly once and the final answer is not duplicated.

## Task 3: Add CardKit streaming operations

Extend the Lark port and adapter with CardKit entity creation, sending by card
reference, Markdown-element content updates, and stream finalization. Give each
Answer card a stable element ID. Add adapter tests for the exact CardKit and IM
payloads.

## Task 4: Persist and deliver stream state

Add idempotent SQLite columns for Answer card ID, element ID, sequence, stream
content, and continuation metadata. Add durable outbox kinds for Answer-card
creation and element streaming. Serialize/coalesce updates by stream target,
advance sequence only with durable state, and preserve legacy inline Answer
cards until their current turn terminates. Cover retries and restart behavior
with store and publisher tests.

## Task 5: Wire lifecycle and rollover

Create new Answer cards through CardKit before prompts become runnable. Route
live observations only to element-content updates, flush before finalizing, and
roll over before the configured element limit. Do not issue full-card patches
for live prompt output. Add end-to-end integration coverage proving one card per
request.

## Task 6: Verify

Run focused tests after each task, followed by the full test suite, TypeScript
typecheck, build, and `git diff --check`. Do not modify or stage the existing
untracked `var/` directory.
