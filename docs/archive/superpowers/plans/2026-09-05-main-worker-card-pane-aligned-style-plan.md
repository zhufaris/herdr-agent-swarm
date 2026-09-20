# Pane-Aligned Primary and Worker Card Style Implementation Plan

## Goal

Apply the approved semantic emoji vocabulary to the Primary Main, Worker Main,
and Worker Task Card renderers without changing canonical content, persistence,
delivery, navigation, or recovery behavior.

## Implementation

1. Add a small presentation-only helper under `src/cards/` for shared lifecycle
   markers and renderer-owned section labels. Keep domain states and stored text
   unchanged.
2. Update `renderProjectEntryCard` in `src/cards/run-card.ts`:
   - prefix the Primary identity header with `🧭`;
   - label status, recent activity, latest message, Workers, and Runtime sections;
   - retain phase colors, live-status panels, recovery callouts, buttons, and
     payload bounds.
3. Update `renderWorkerMainCard` in `src/cards/worker-main-card.ts`:
   - prefix the Worker identity header with `🤖`;
   - add typed metadata and section labels;
   - apply shared lifecycle markers to current and recent task summaries;
   - preserve task links and the frozen-session note.
4. Update `renderWorkerTurnCard` in `src/cards/worker-turn-card.ts`:
   - prefix the task header and request/progress/parent-task sections;
   - align lifecycle markers with the shared vocabulary;
   - keep Worker output on the shared compact Markdown rendering path,
     preserving fenced code and leaving the canonical Worker result untouched.
5. Extend `tests/run-card.test.ts`, `tests/worker-main-card.test.ts`,
   `tests/instance-cards.test.ts`, and the nearest workflow tests to assert the
   new headings, state markers, activity decoration, unchanged prose/fences,
   actions, and streaming element IDs.

## Verification

Run the focused card and workflow tests, then `npm run typecheck`,
`npm run build`, and `npm test`. Review the final diff for renderer-only scope.
After a clean pass, commit, install the immutable release, restart through the
supported lifecycle command, and verify service identity, readiness, SQLite,
and outbox health with `npm run swarm:status`.
