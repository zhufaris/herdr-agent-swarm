# Main Card Button Removal Design

## Goal

Remove every interactive button from the Lark topic Main Card. The card remains
a durable, read-only projection of binding and prompt state.

## Scope

`renderProjectEntryCard()` in `src/cards/run-card.ts` will stop appending the
state-derived action list. This applies to every `TopicViewState.phase`,
including recovery states such as `blocked`, `error`, `degraded`, `orphaned`,
and `archived`. The Main Card will retain its status summary, live work,
progress timeline, recovery notice, and runtime footer.

## Non-goals

- Do not change prompt acceptance from ordinary Lark messages.
- Do not change Pane, instance, operations, Answer Card, or project-directory
  controls.
- Do not remove CardKit action handlers or interaction persistence; they may be
  used by cards other than the Main Card and removing them would broaden this
  presentation-only request.
- Do not change durable topic-view, outbox, or Lark delivery sequencing.

## Design

The renderer becomes read-only by omitting `mainCardActions(input)` from its
body construction. The now-unused Main Card-only helper and its
`callbackButton` import are removed. No coordinator, reducer, SQLite, or Lark
adapter change is needed, so existing Main Card versioning and delivery remain
unchanged.

## Verification

Update `tests/run-card.test.ts` to assert that a representative active Main
Card has no button nodes while an independently rendered More Actions card
still has its existing callbacks. Replace the action matrix expectations with a
full phase matrix asserting no Main Card callback actions. Recovery-state tests
continue to prove the recovery message is visible but assert no recovery button
is rendered. Run the focused test, typecheck, and build after the final edit.
