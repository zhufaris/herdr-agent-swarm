# Primary Main Card Pane Name Title Correction Plan

**Goal:** Include the stable pane name and native pane token in the Primary Main
Card header title, producing `TraeX · datasage / nxmz · yx0c`.

**Design:** Reuse the already durable `TopicViewState.paneName` and the existing
`displayNamedPaneIdentity` helper. Replace the task-oriented Primary Main Card
header with the agent/space/named-pane identity while retaining the task title
in the card summary and body. Change no Answer Card, Worker Card, operational
card, routing, or identity semantics.

## Task 1: Lock the title contract with focused tests

**Files:**

- Modify `tests/run-card.test.ts`

1. Extend the Primary Main Card assertion to require the named header title.
2. Assert that a missing pane name retains the existing token-or-pane-ID title.
3. Keep existing Answer Card and operational-card expectations unchanged.

## Task 2: Render the named identity in the title

**Files:**

- Modify `src/cards/run-card.ts`

1. Change the Primary Main Card title helper to accept the display inputs needed
   by `displayNamedPaneIdentity`.
2. Render the named identity after the existing `<agent> · <space> /` prefix.
3. Preserve the existing 96-character title bound and all missing-name
   fallbacks.

## Task 3: Verify and deploy safely

1. Run the focused Main Card test.
2. Run `npm run typecheck`, `npm run build`, and `npm test`.
3. Commit only the title correction and its tests.
4. Build and install from the isolated clean clone.
5. Run `npm run swarm:status`; restart without `--force` only when every
   active-work counter is zero.
6. Verify the installed commit, readiness, durable Topic View pane name, and
   delivered Main Card payload title without printing user content.
