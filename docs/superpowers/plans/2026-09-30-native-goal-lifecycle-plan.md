# Native Goal Lifecycle Implementation Plan

> Execute inline. This repository session forbids sub-agent delegation.

**Goal:** Show the current Primary Session Goal in mutable Answer Cards while
keeping Goal lifecycle and turn-scoped Task List as separate domain concepts.

**Architecture:** TraeX 0.207.1 emits typed `thread_goal_updated` events. Herdr
Core normalizes them into additive `GoalChanged` Agent Events. Swarm validates
that contract, reduces it into the durable Primary Session `TopicView`, mirrors
the current snapshot into active Run Cards, and renders Goal immediately before
the final Task List. Generic exec input/output is never parsed.

**Spec:** `docs/superpowers/specs/2026-09-29-native-goal-lifecycle-design.md`

## Constraints

- Preserve the existing Agent Events schema version and add one payload variant.
- Do not parse `create_goal`, `update_goal`, JavaScript, or generic tool output.
- Goal is Primary Session state; Run Card contains only a render snapshot.
- `complete` clears CurrentGoal. `active`, `paused`, and `blocked` remain visible.
- Reject stale binding generation, native session, and source-order updates.
- Do not modify frozen Answer pages.
- Task List remains native `planSteps` and the final Answer Card section.
- Preserve all unrelated dirty-worktree changes.

## Task 1: Normalize TraeX Goal events in Herdr Core

**Repository:** `herdr-core`, isolated task worktree.

**Files:**

- Modify: `src/api/schema/agent_events.rs`
- Modify: `src/agent_events/codec.rs`
- Modify generated next API schema through the repository generator
- Test: adjacent codec/schema tests

- [ ] Add `GoalStatus` and `ReplyPayload::GoalChanged` with bounded objective,
  deterministic Goal ID, native update time, and exact status mapping.
- [ ] Decode only `event_msg.payload.type == "thread_goal_updated"`.
- [ ] Derive Goal ID from `threadId + createdAt`; map `updatedAt` to
  `source_updated_at`; retain the existing event envelope session/turn identity.
- [ ] Prove malformed Goal snapshots fail closed and generic exec calls never
  become Goal events.
- [ ] Run focused Rust tests, API schema checks, and `just check`.

## Task 2: Carry Goal changes through the Swarm transcript boundary

**Files:**

- Create: `src/domain/current-goal.ts`
- Modify: `src/domain/ports/external.ts`
- Modify: `src/runtime/herdr-events-reader.ts`
- Modify: `src/runtime/exact-turn-observer.ts`
- Modify: `src/coordinator/transcript-observer.ts`
- Modify: `src/coordinator/owned-transcript-output-projector.ts`
- Modify: `src/coordinator/external-turn-observer.ts`
- Modify: `src/domain/events.ts`
- Test: `tests/herdr-events-reader.test.ts`
- Test: focused observer/projector tests

- [ ] Define provider-neutral `GoalChange` and visible `CurrentGoal` values.
- [ ] Extend the Agent Event Zod union with `goal_changed`.
- [ ] Emit Goal changes independently of answer/tool deltas so a Goal-only batch
  is not discarded.
- [ ] Preserve source ID, source cursor, event ID, native session, occurrence
  time, and update time required for idempotent ordering.
- [ ] Carry Goal changes through owned and externally adopted Primary turns.

## Task 3: Make Primary Session own CurrentGoal

**Files:**

- Modify: `src/domain/topic-view.ts`
- Modify: `src/domain/run-card-view.ts`
- Modify: `src/events/conversation-view-projector.ts`
- Modify: `src/store/sqlite/projection-store.ts`
- Modify: SQLite migration/integrity files only if JSON hydration is insufficient
- Test: `tests/topic-view.test.ts`
- Test: `tests/run-card-view.test.ts`
- Test: `tests/sqlite-store.test.ts`
- Test: `tests/event-card-integration.test.ts`

- [ ] Add a pure CurrentGoal reducer with explicit create/replace/update/complete,
  duplicate, stale, and ambiguous-transition outcomes.
- [ ] Persist CurrentGoal in `TopicViewState`, whose binding/generation key is
  the existing durable Primary Session projection boundary.
- [ ] Mirror only the CurrentGoal snapshot into active/queued Run Cards; the Run
  Card reducer must not decide Goal lifecycle.
- [ ] On Goal changes, increment affected mutable views and schedule Answer/Main
  convergence through existing durable projection paths.
- [ ] Hydrate older JSON views with `currentGoal: null` without rewriting them.

## Task 4: Render Goal before the final Task List

**Files:**

- Modify: `src/cards/run-card.ts`
- Modify: `src/cards/answer-timeline-page.ts` if pagination composition requires it
- Test: `tests/run-card.test.ts`
- Test: `tests/answer-timeline-page.test.ts`
- Test: `tests/answer-page-recovery.integration.test.ts`

- [ ] Render `🎯 Goal` only for a non-null CurrentGoal.
- [ ] Render state as In progress, Paused, or Blocked without duplicating the
  objective in title, Reply-to metadata, timeline, or Task List.
- [ ] Place Goal immediately before Task List; Task List remains last.
- [ ] Prove mutable pages update and frozen pages retain their original payload.

## Task 5: Documentation and verification

**Files:**

- Modify: `docs/architecture.md`
- Modify: `docs/domain/primary-session/CONTEXT.md`
- Modify: `docs/domain/conversation-projection/CONTEXT.md`

- [ ] Document Goal authority, ordering, recovery, and Task List separation.
- [ ] Run focused Core and Swarm tests.
- [ ] Run Core `just check`.
- [ ] Run Swarm `npm run typecheck`, `npm run build`, and `npm test`.
- [ ] Verify `git diff --check` in both repositories.
- [ ] Do not install or restart until both immutable builds are available and the
  active-work safety gate is explicitly evaluated.
