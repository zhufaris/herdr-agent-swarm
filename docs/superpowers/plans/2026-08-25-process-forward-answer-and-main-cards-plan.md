# Process-forward answer and main cards: implementation plan

> **Execution rule:** do not include the unrelated current worktree edits in
> this feature's commits. Validate every step against the project build rules.

## Scope and invariants

Implement the approved design in
`docs/superpowers/specs/2026-08-25-process-forward-answer-and-main-cards-design.md`.

The work is presentation and projection behavior only. It must preserve:

- one prompt at a time per binding and ordinary-prompt FIFO behavior;
- never replaying an uncertain or potentially submitted prompt;
- durable SQLite outbox intent before Lark delivery;
- ordered CardKit stream sequences and immutable frozen answer pages;
- local-only Herdr approval and stop controls.

## 1. Add a pure progress-timeline renderer

**Files:**

- Add `src/cards/progress-timeline.ts`
- Add `tests/progress-timeline.test.ts`

**Implementation:**

1. Define a narrow CardKit-element return type or use the existing object style
   consistently with `run-card.ts`.
2. Accept `RunProgressEvent[]`, a phase/context, and optional concise heading
   context. Do not accept stores, adapters, answer text, or side-effecting
   callbacks.
3. Normalize every label to one bounded line and map event kinds to the
   approved icons. Render a compact status marker for pending, active, done,
   and failed events.
4. Return no elements for an empty event list. Otherwise, render a process
   panel with the newest three rows visible and all earlier rows in a collapsed
   nested `collapsible_panel` labelled `查看完整过程（N）`.
5. Produce heading text based on phase and aggregate step count; make running
   and attention-required states visually distinct without inventing state.

**Tests:** empty history; 1/3/4+ event splits; correct ordering; kind/state
icons; newline and overlong label bounding; no mutation of input; heading text
for running, completed, blocked, and failed.

## 2. Preserve full current-turn progress in the topic projection

**Files:**

- Modify `src/domain/topic-view.ts`
- Extend `tests/run-card-view.test.ts` and/or add focused topic-view coverage

**Implementation:**

1. Remove the fixed eight-event truncation in `TurnOutputObserved` snapshots
   and incremental `mergeProgress`.
2. Continue replacing events by stable key on incremental observations and
   retain supplied snapshot ordering.
3. Retain reset-on-new-turn behavior so the main card remains about the active
   or latest projected prompt, not the complete lifetime of a binding.
4. Keep `mirrorRunCardToTopic` aligned with the complete run-card sequence.

**Tests:** more than eight events survive a snapshot/reduction; duplicate-key
updates replace rather than duplicate; a new `TurnStarted` clears old-turn
timeline; no unrelated topic state changes.

## 3. Refactor the answer-card layout around the timeline

**Files:**

- Modify `src/cards/run-card.ts`
- Extend `tests/run-card.test.ts`

**Implementation:**

1. Import the shared renderer and insert its elements before the answer stream
   body. Preserve the stable `answerElementId` markdown element.
2. Move blocked/failed notices to independent callout panels before the stream
   body. Do not append notices into streamed answer content.
3. Render phase-specific empty body copy: queued/running placeholders and the
   explicit completed no-result fallback.
4. Add a footer with pane, duration, and continuation-page orientation. Keep
   completion visually quieter than running while retaining the full timeline.
5. Change continuation headers to `✨ TraeX 继续回复 · 第 N 页`.
6. Preserve Markdown normalization and native TraeX/subagent-status filtering
   before answers are rendered.

**Tests:** running timeline plus draft; completed answer/body hierarchy;
blocked/failed notice separated from stable answer element; completed no-result
copy; page 1 and continuation title/footer; native status exclusion.

## 4. Rebuild the main project-entry card as a session dashboard

**Files:**

- Modify `src/cards/run-card.ts`
- Extend `tests/run-card.test.ts`

**Implementation:**

1. Keep SPACE/PANE/QUEUE metrics at the top.
2. Add an explicit current-work or queued-work summary driven only by
   `TopicViewState.phase`, `activePromptId`, and `queueDepth`.
3. Use the shared timeline renderer with full `recentProgress`.
4. Keep the existing bounded, terminal-status-filtered answer tail as a small
   latest-result preview; never copy full answer content into this card.
5. Place blocked/error/orphaned/draining/archived action notices above the
   preview, retaining only local-Herdr/recovery guidance.
6. Remove or replace the old ad hoc "最近动态" rendering so there is one
   timeline presentation rule.

**Tests:** running current work and queue; queue-only state; 4+ activity
events with nested history; result-tail bound/filtering; actionable-state
precedence; no answer duplication.

## 5. Align continuation delivery text and active-page semantics

**Files:**

- Modify `src/events/conversation-view-projector.ts`
- Extend `tests/event-card-integration.test.ts`

**Implementation:**

1. Change only the stream-finish continuation label from `Continued on part N`
   to `回答将在第 N 页继续`.
2. When a continuation card is created, continue calling the answer renderer
   with the current run-card view so that card receives the current timeline
   snapshot.
3. Do not alter `answerPageIndex`, `answerPageStart`, element ID generation,
   sequence increments, idempotency keys, or frozen-page behavior.

**Tests:** continuation label is Chinese and page-aware; new card includes the
current timeline snapshot; prior page receives no additional stream content
after rollover; normal sequencing/idempotency tests remain green.

## 6. Verify the whole change

Run, in order:

1. `npx vitest run tests/progress-timeline.test.ts tests/run-card.test.ts tests/run-card-view.test.ts tests/event-card-integration.test.ts`
2. `npm run typecheck`
3. `npm run build`
4. `npm test`

Inspect `git diff --check` and the targeted card JSON assertions before staging.
Stage only the timeline, card, projection, tests, and design/plan files that
belong to this feature; do not mix the existing Herdr adapter/parser work.
