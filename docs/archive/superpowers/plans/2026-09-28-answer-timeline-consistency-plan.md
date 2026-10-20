# Answer Timeline Consistency Implementation Plan

**Goal:** Repair structured rich-text continuation and align Assistant, final-answer, Skill, and Tool-preview presentation across Primary and Worker Answer surfaces.

**Design authority:** `docs/superpowers/specs/2026-09-28-answer-timeline-consistency-design.md`.

## Invariants

- Preserve structured timeline order, stable item IDs, durable cursor checkpoints, outbox idempotency, frozen pages, and the no-prompt-replay guarantee.
- Keep private reasoning excluded. Public Assistant commentary remains visible and compact.
- Keep Tool details collapsed and first-three/last-three except Skill, whose result body is never displayed.
- Keep `pageStart` for compatibility without inventing a new integer encoding.
- Do not modify unrelated dirty-worktree files or the pre-existing native Herdr event-reader work.

## Task 1: Define and test cursor progress

Add a small domain helper that compares `AnswerTimelineCursor` values by item, section, and effective offset, including legacy cursors without section fields. Add focused unit coverage for item progress, message offsets, command-to-result progress, equality, and regression.

Extend Primary and Worker rich-text continuation tests with the real failure shape: two adjacent pages may have the same compatibility `pageStart`, while their structured cursors move from Tool command to Tool result. Verify reservation accepts strict cursor progress and rejects equal/regressing cursors. Verify outbound target validation accepts only a continuation backed by the matching durable next-page checkpoint.

## Task 2: Carry the cursor fence through reservation and delivery

Update the Primary and Worker rich-text continuation reservation inputs and reply payloads to carry the next-page start cursor. In the same SQLite transaction, compare it against the active page checkpoint before reserving the frozen update and next reply.

Update rich-text create target validation to use the durable current/next checkpoints and the shared comparison helper. Initial page creation remains unchanged. Historical payloads without a cursor retain the old integer rule; new structured continuations may repeat `pageStart` only when cursor progress is proven.

## Task 3: Make fallback Assistant projection phase-aware

Extend the Assistant message schema to accept `phase`. Emit `agent_message` for commentary/unknown public messages and `final_answer` for `phase: final_answer`. Track whether the exact turn emitted an explicit final item. On `task_complete`, use `last_agent_message` only if no explicit final was emitted. Reset this state at a new turn.

Add projector tests for commentary, explicit final plus prefix completion fallback, fallback-only completion, and private reasoning exclusion.

## Task 4: Preserve and render Skill semantics

Add `skill` to the timeline Tool category and map the existing trusted structural `Skill` descriptor to it. Add its icon/label to CardKit and rich-post renderers. Suppress Skill result bodies in both renderers for every state while retaining title and status.

Add projector and renderer tests showing the Skill name is present, its output is absent, and ordinary Tool output behavior is unchanged.

## Task 5: Correct commentary labels and Tool whitespace

Rename the public Assistant preview wrapper from `💭 思考` to `💬 进展` in the shared presentation transform so CardKit and rich-post agree. Preserve the three-line preview and exact omitted count.

After line-ending normalization and recognized wrapper removal, strip only leading and trailing blank Tool-result lines before first-three/last-three selection. Preserve interior blank lines and compute omission counts from the cleaned result. Add wrapped, unwrapped, CRLF, interior-blank, and empty-output regressions.

## Task 6: Validate, commit, install, and restart

Run the focused cursor, workflow, outbox, projector, CardKit, rich-text, and SQLite tests. Then run the full Vitest suite, `npm run typecheck`, and `npm run build`. Review the exact owned diff and commit only the plan, implementation, and affected tests with hooks disabled; verify the final commit body contains no `Trae CLI co-author attribution`.

Run `./install.sh`, then `npm run swarm:restart -- --force` as already requested. Verify systemd state, `/ready`, expected versus observed build identity, SQLite/outbox health, and a fresh real Answer projection where practical. Do not push.
