# Pane Entry Main Mirroring Implementation Plan

**Goal:** Project each current TopicView to the canonical Main Card and every
active Pane Entry alias through independent durable lanes.

## Task 1: Lock alias projection behavior

- Add a Main Card workflow/store test that activates an alias, advances the
  TopicView, and observes one canonical update plus one Pane Entry update.
- Assert target message, version, payload style, work class, and isolated lane.
- Add same-version idempotency and stale generation/pane fail-closed cases.
- Run the focused tests red before implementation.

## Task 2: Reserve canonical and alias intents atomically

- Extend the Main Card store contract to accept the rendered Pane Entry view.
- Select only exact active aliases for the current Binding generation and pane.
- Reserve one versioned alias update per target through a dedicated lane.
- Return `reserved` when any target needs delivery so the existing wake path is
  sufficient.

## Task 3: Update presentation and startup convergence

- Render the same hydrated TopicView for canonical and alias cards.
- Update the passive footer to say the card follows current Pane state.
- Ensure startup can reserve missing alias versions even when canonical delivery
  is current.

## Task 4: Verify and commit

- Run Main Card, SQLite, alias, startup, and outbox dispatcher tests.
- Run typecheck, build, architecture checks, full tests, and diff checks.
- Commit independently; do not install or restart production in this slice.
