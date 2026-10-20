# Tool Output Wrapper and Head-Tail Preview Implementation Plan

**Goal:** Remove the standard TraeX execution wrapper from Answer-card Tool details and compact actual command output to its first three and last three lines without mutating canonical timeline data.

**Design authority:** `docs/superpowers/specs/2026-09-27-compact-tool-result-preview-design.md`.

## Invariants

- Parse and validate the structured transcript event before inspecting its Tool-result field.
- Keep the complete redacted and bounded Tool result in the canonical Answer timeline and SQLite.
- Apply wrapper removal and line compaction only to presentation copies shared by CardKit and `rich_post`.
- Preserve Tool state detection, emoji, collapsed panels, frozen-page behavior, cursor identity, and final-answer pagination.
- Preserve an unrecognized or malformed wrapper verbatim.

## Task 1: Lock the presentation contract with tests

Update focused CardKit, rich-text, and page-planner tests to require first-three/last-three output with exact omitted counts for running, successful, and failed tools. Add cases for six-line output without overlap, standard-wrapper removal, malformed-wrapper fallback, empty wrapped output, CRLF normalization, and the existing 500-character line bound.

Add a projector or persistence assertion proving the canonical timeline still receives the complete wrapper-bearing result. This distinguishes presentation normalization from structured-event parsing and durable state.

## Task 2: Implement one narrow presentation transform

In `src/cards/answer-timeline.ts`, add a private wrapper-removal helper used only by `compactToolResult`. Normalize line endings, recognize the anchored three-line wrapper exactly, and return only the content following `Output:`. If the wrapper does not match, return the normalized original result.

Replace prefix-only Tool compaction with a head-and-tail helper that keeps three leading and three trailing logical lines, inserting the exact `… +N lines omitted` marker only when more than six lines exist. Continue applying the 500-character bound independently to every visible line. Leave intermediate Agent-message prefix compaction unchanged.

## Task 3: Verify shared rendering and canonical preservation

Run the focused Answer timeline, pagination, rich-text, projector, and SQLite tests. Then run typecheck, build, architecture checks, and the full Vitest suite because the presentation helper is shared by Primary and Worker Answer flows.

## Task 4: Commit and deploy

Review the exact owned diff and commit only the implementation and affected tests without repository hooks adding attribution trailers. Build and install the immutable release, force-restart the user service as already requested, then verify systemd state, readiness, and installed build identity.
